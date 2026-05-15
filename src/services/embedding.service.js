/**
 * src/services/embedding.service.js — OpenAI embedding generation
 *
 * Converts text chunks into 1536-dimensional vectors using
 * OpenAI's text-embedding-3-small model. Processes chunks in
 * configurable batches to balance throughput against rate limits,
 * and persists the resulting vectors to MongoDB.
 *
 * KEY COST OPTIMISATION:
 *   Before calling the API, each chunk's SHA-256 hash is checked
 *   against existing Embedding documents. Chunks whose hash already
 *   exists in the DB are skipped entirely — zero API calls.
 */

const openai = require("../config/openai");
const Embedding = require("../models/Embedding.model");
const logger = require("../utils/logger.util");
const { processBatches, retry } = require("../utils/batch.util");
const { estimateTokens } = require("../utils/token.util");
const crypto = require("crypto");

// Batch size for OpenAI Embeddings API calls
const BATCH_SIZE = parseInt(process.env.EMBEDDING_BATCH_SIZE, 10) || 5;
const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";

/**
 * generateAndStoreEmbeddings — embed chunks and persist to MongoDB.
 *
 * Processing flow per chunk:
 *   1. Compute SHA-256 hash of chunkText
 *   2. Skip if a document with that hash already exists (deduplication)
 *   3. Batch remaining chunks → call OpenAI Embeddings API
 *   4. Bulk-insert new Embedding documents
 *
 * @param {Array<Object>} chunks   Produced by chunk.service.js
 * @returns {Promise<{
 *   stored: number,    // New embeddings written to DB
 *   skipped: number,   // Chunks skipped (already embedded)
 *   totalTokens: number
 * }>}
 */
const generateAndStoreEmbeddings = async (chunks) => {
  if (!chunks || chunks.length === 0) {
    logger.warn("generateAndStoreEmbeddings called with empty chunks array");
    return { stored: 0, skipped: 0, totalTokens: 0 };
  }

  logger.info(`Starting embedding generation for ${chunks.length} chunk(s)`);

  // ── 1. Compute hashes and identify already-embedded chunks ───────────────
  const chunksWithHash = chunks.map((c) => ({
    ...c,
    chunkHash: crypto.createHash("sha256").update(c.chunkText).digest("hex"),
  }));

  const allHashes = chunksWithHash.map((c) => c.chunkHash);

  // Single DB query to find all existing hashes
  const existingDocs = await Embedding.find(
    { chunkHash: { $in: allHashes } },
    { chunkHash: 1 }
  ).lean();

  const existingHashes = new Set(existingDocs.map((d) => d.chunkHash));

  const newChunks = chunksWithHash.filter((c) => !existingHashes.has(c.chunkHash));
  const skipped = chunks.length - newChunks.length;

  logger.info(`Embedding: ${newChunks.length} new, ${skipped} skipped (already embedded)`);

  if (newChunks.length === 0) {
    return { stored: 0, skipped, totalTokens: 0 }; 
  }

  // ── 2. Batch-embed new chunks ─────────────────────────────────────────────
  let totalTokens = 0;
  const embeddingDocs = [];

  await processBatches(newChunks, BATCH_SIZE, async (batch) => {
    const texts = batch.map((c) => c.chunkText);

    const response = await retry(() =>
      openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: texts,
        encoding_format: "float", // explicit — avoids base64 overhead
      })
    );

    // Map each API result back to its chunk
    response.data.forEach((item, idx) => {
      const chunk = batch[idx];
      const tokenCount = item.usage?.prompt_tokens
        ? Math.round(item.usage.prompt_tokens / batch.length)
        : estimateTokens(chunk.chunkText);

      totalTokens += tokenCount;

      embeddingDocs.push({
        fileId: chunk.fileId,
        googleFileId: chunk.googleFileId,
        fileName: chunk.fileName,
        pageNumber: chunk.pageNumber,
        chunkIndex: chunk.chunkIndex,
        chunkText: chunk.chunkText,
        embedding: item.embedding,
        tokenCount,
        chunkHash: chunk.chunkHash,
        createdAt: new Date(),
      });
    });

    logger.debug(`Embedded batch of ${batch.length} — cumulative docs: ${embeddingDocs.length}`);
  });

  // ── 3. Bulk-insert all new embedding documents ────────────────────────────
  if (embeddingDocs.length > 0) {
    await Embedding.insertMany(embeddingDocs, { ordered: false });
    logger.info(`Stored ${embeddingDocs.length} new embedding(s) in MongoDB`);
  }

  return { stored: embeddingDocs.length, skipped, totalTokens };
};

/**
 * generateQueryEmbedding — embed a single question string.
 * Used at query time before Atlas Vector Search.
 *
 * @param {string} text
 * @returns {Promise<number[]>}  1536-element float array
 */
const generateQueryEmbedding = async (text) => {
  const response = await retry(() =>
    openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: text,
      encoding_format: "float",
    })
  );
  return response.data[0].embedding;
};

module.exports = { generateAndStoreEmbeddings, generateQueryEmbedding };
