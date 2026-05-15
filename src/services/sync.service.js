/**
 * src/services/sync.service.js — Google Drive ↔ MongoDB sync orchestrator
 *
 * This is the central "brain" of the ingestion pipeline. It:
 *   1. Fetches the list of PDFs from the Drive folder
 *   2. Compares each file's `modifiedTime` against the DB record
 *   3. Skips files that haven't changed (zero cost)
 *   4. Processes new / updated files end-to-end:
 *        download → extract → chunk → embed → persist
 *   5. Updates the File document status after each operation
 *
 * This service is called by the cron job and also by the manual
 * trigger endpoint (POST /api/rag/sync).
 */

const File = require("../models/File.model");
const Embedding = require("../models/Embedding.model");
const { listPDFsInFolder } = require("./drive.service");
const { extractTextFromPDF } = require("./pdf.service");
const { chunkPages } = require("./chunk.service");
const { generateAndStoreEmbeddings } = require("./embedding.service");
const logger = require("../utils/logger.util");

/**
 * syncDriveFiles — main sync entry point.
 *
 * @returns {Promise<{
 *   total: number,       // Files found in Drive
 *   processed: number,   // Files actually (re)processed
 *   skipped: number,     // Files unchanged since last sync
 *   failed: number,      // Files that threw an error
 *   details: Array       // Per-file summary
 * }>}
 */
const syncDriveFiles = async () => {
  logger.info("=== Drive sync started ===");

  const summary = { total: 0, processed: 0, skipped: 0, failed: 0, details: [] };

  // ── 1. List all PDFs in the Drive folder ─────────────────────────────────
  const driveFiles = await listPDFsInFolder();
  summary.total = driveFiles.length;

  if (driveFiles.length === 0) {
    logger.info("No PDFs found in Drive folder — sync complete");
    return summary;
  }

  // ── 2. Fetch all known file records from DB in one query ─────────────────
  const googleFileIds = driveFiles.map((f) => f.id);
  const existingFiles = await File.find({ googleFileId: { $in: googleFileIds } }).lean();
  const existingMap = new Map(existingFiles.map((f) => [f.googleFileId, f]));

  // ── 3. Process each Drive file sequentially ───────────────────────────────
  // Sequential (not parallel) to avoid overwhelming the OpenAI rate limit
  // and to keep memory usage predictable.
  for (const driveFile of driveFiles) {
    const fileResult = {
      googleFileId: driveFile.id,
      fileName: driveFile.name,
      action: "skipped",
      error: null,
    };

    try {
      const existing = existingMap.get(driveFile.id);

      // ── Change detection ────────────────────────────────────────────────
      if (
        existing &&
        existing.driveModifiedTime === driveFile.modifiedTime &&
        existing.status === "completed"
      ) {
        logger.debug(`Skipping unchanged file: ${driveFile.name}`);
        summary.skipped++;
        fileResult.action = "skipped";
        summary.details.push(fileResult);
        continue;
      }

      // ── Upsert File document (mark as processing) ───────────────────────
      const fileDoc = await File.findOneAndUpdate(
        { googleFileId: driveFile.id },
        {
          $set: {
            googleFileId: driveFile.id,
            fileName: driveFile.name,
            driveModifiedTime: driveFile.modifiedTime,
            mimeType: driveFile.mimeType,
            status: "processing",
            errorMessage: null,
            lastSyncedAt: new Date(),
          },
        },
        { upsert: true, new: true }
      );

      // ── If file was updated, remove stale embeddings ────────────────────
      if (existing && existing.status === "completed") {
        const deleted = await Embedding.deleteMany({ googleFileId: driveFile.id });
        logger.info(`Removed ${deleted.deletedCount} stale embeddings for "${driveFile.name}"`);
      }

      // ── PDF extraction ──────────────────────────────────────────────────
      const { pages, totalPages, checksum } = await extractTextFromPDF(
        driveFile.id,
        driveFile.name
      );

      // ── Chunking ────────────────────────────────────────────────────────
      const chunks = await chunkPages(
        pages,
        fileDoc._id.toString(),
        driveFile.id,
        driveFile.name
      );

      // ── Embedding ───────────────────────────────────────────────────────
      const { stored, skipped: embSkipped, totalTokens } = await generateAndStoreEmbeddings(chunks);

      // ── Mark file as completed ──────────────────────────────────────────
      await File.findByIdAndUpdate(fileDoc._id, {
        $set: {
          status: "completed",
          totalPages,
          totalChunks: chunks.length,
          checksum,
          uploadedAt: fileDoc.uploadedAt || new Date(),
          lastSyncedAt: new Date(),
        },
      });

      summary.processed++;
      fileResult.action = existing ? "updated" : "new";
      fileResult.chunks = chunks.length;
      fileResult.embeddingsStored = stored;
      fileResult.embeddingsSkipped = embSkipped;
      fileResult.totalTokens = totalTokens;

      logger.info(
        `✅ "${driveFile.name}" — ${chunks.length} chunks, ` +
        `${stored} embeddings stored, ${embSkipped} skipped`
      );
    } catch (err) {
      logger.error(`❌ Failed to process "${driveFile.name}"`, { error: err.message });

      // Mark file as failed so the next sync will retry it
      await File.findOneAndUpdate(
        { googleFileId: driveFile.id },
        {
          $set: {
            status: "failed",
            errorMessage: err.message,
            lastSyncedAt: new Date(),
          },
        },
        { upsert: true }
      );

      summary.failed++;
      fileResult.action = "failed";
      fileResult.error = err.message;
    }

    summary.details.push(fileResult);
  }

  logger.info(
    `=== Drive sync complete — ` +
    `total:${summary.total} processed:${summary.processed} ` +
    `skipped:${summary.skipped} failed:${summary.failed} ===`
  );

  return summary;
};

module.exports = { syncDriveFiles };
