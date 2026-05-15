/**
 * src/models/Embedding.model.js — Mongoose schema for chunk embeddings
 *
 * Each document represents one text chunk extracted from a PDF page,
 * together with its OpenAI vector embedding and metadata.
 *
 * The `embedding` field is used by MongoDB Atlas Vector Search.
 * You must create the vector index manually in the Atlas UI (or via
 * the Atlas CLI) — see the README for the exact index definition.
 */

const mongoose = require("mongoose");
const crypto = require("crypto");

const EmbeddingSchema = new mongoose.Schema(
  {
    // ── Parent file references ─────────────────────────────────────────────
    fileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "File",
      required: true,
      index: true,
    },

    googleFileId: {
      type: String,
      required: true,
      index: true,
    },

    fileName: {
      type: String,
      required: true,
    },

    // ── Chunk position ─────────────────────────────────────────────────────
    pageNumber: {
      type: Number,
      required: true,
      min: 1,
    },

    // Zero-based index within the file (across all pages)
    chunkIndex: {
      type: Number,
      required: true,
    },

    // ── Content ───────────────────────────────────────────────────────────
    chunkText: {
      type: String,
      required: true,
    },

    /**
     * The actual vector produced by OpenAI text-embedding-3-small.
     * Dimensions: 1536  — must match the Atlas vector index definition.
     */
    embedding: {
      type: [Number],
      required: true,
      // Do NOT add a standard Mongoose index here; Atlas manages the
      // vector index separately via the search index definition.
    },

    // Approximate token count (used for cost tracking)
    tokenCount: {
      type: Number,
      default: 0,
    },

    // SHA-256 hash of chunkText — lets us skip re-embedding identical chunks
    chunkHash: {
      type: String,
      index: true,
    },

    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    collection: "embeddings",
    // Disable the default Mongoose `updatedAt` — embeddings are immutable
    timestamps: { createdAt: false, updatedAt: false },
  }
);

// ── Compound indexes for query performance ───────────────────────────────────
EmbeddingSchema.index({ fileId: 1, chunkIndex: 1 });
EmbeddingSchema.index({ googleFileId: 1, chunkHash: 1 });

/**
 * Pre-save hook: derive the SHA-256 hash of the chunk text so we can
 * cheaply detect duplicate chunks without comparing full vectors.
 */
EmbeddingSchema.pre("save", function (next) {
  if (this.isModified("chunkText") || !this.chunkHash) {
    this.chunkHash = crypto
      .createHash("sha256")
      .update(this.chunkText)
      .digest("hex");
  }
  next();
});

module.exports = mongoose.model("Embedding", EmbeddingSchema);
