/**
 * src/models/File.model.js — Mongoose schema for processed PDF files
 *
 * Tracks every PDF that has been fetched from Google Drive.
 * The `driveModifiedTime` field is used to detect whether a
 * file has changed since we last processed it, avoiding
 * redundant embedding regeneration.
 */

const mongoose = require("mongoose");

const FileSchema = new mongoose.Schema(
  {
    // ── Google Drive identity ──────────────────────────────────────────────
    googleFileId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },

    fileName: {
      type: String,
      required: true,
      trim: true,
    },

    // ISO-8601 string returned by the Drive API — used for change detection
    driveModifiedTime: {
      type: String,
      required: true,
    },

    mimeType: {
      type: String,
      default: "application/pdf",
    },

    // ── Processing state ───────────────────────────────────────────────────
    /**
     * status lifecycle:
     *   pending   → file discovered, not yet processed
     *   processing → currently downloading / embedding
     *   completed  → embeddings stored in MongoDB
     *   failed     → processing error (check `errorMessage`)
     */
    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed"],
      default: "pending",
      index: true,
    },

    errorMessage: {
      type: String,
      default: null,
    },

    // ── Document statistics ────────────────────────────────────────────────
    totalPages: {
      type: Number,
      default: 0,
    },

    totalChunks: {
      type: Number,
      default: 0,
    },

    // ── Embedding metadata ─────────────────────────────────────────────────
    embeddingModel: {
      type: String,
      default: process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
    },

    // MD5 checksum of the raw PDF bytes — secondary change-detection guard
    checksum: {
      type: String,
      default: null,
    },

    // ── Timestamps ─────────────────────────────────────────────────────────
    uploadedAt: {
      type: Date,
      default: null,
    },

    lastSyncedAt: {
      type: Date,
      default: null,
    },
  },
  {
    // Adds `createdAt` and `updatedAt` automatically
    timestamps: true,
    collection: "files",
  }
);

// ── Compound index for fast sync-time lookups ────────────────────────────────
FileSchema.index({ googleFileId: 1, driveModifiedTime: 1 });
FileSchema.index({ status: 1, lastSyncedAt: -1 });

module.exports = mongoose.model("File", FileSchema);
