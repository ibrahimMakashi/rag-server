/**
 * src/routes/rag.routes.js — Express router for all RAG endpoints
 *
 * Base path: /api/rag  (mounted in app.js)
 *
 * Endpoint summary:
 *   POST   /ask                         — Ask a question (blocking, full JSON response)
 *   POST   /ask/stream                  — Ask a question (SSE streaming, token-by-token)
 *   POST   /sync                        — Manually trigger Drive sync
 *   GET    /files                       — List all tracked files
 *   GET    /files/:googleFileId/chunks  — View chunks for a file
 *   DELETE /files/:googleFileId         — Remove file + embeddings
 *   GET    /stats                       — System-wide statistics
 */

const { Router } = require("express");
const {
  askQuestion,
  askQuestionStreaming,
  triggerSync,
  listFiles,
  getFileChunks,
  getStats,
  deleteFile,
} = require("../controllers/rag.controller");

const router = Router();

// ── Question answering ─────────────────────────────────────────────────────────────────────────────────
router.post("/ask",        askQuestion);          // blocking — waits for full answer
router.post("/ask/stream", askQuestionStreaming); // SSE — streams tokens in real-time

// ── Drive sync ────────────────────────────────────────────────────────────────
router.post("/sync", triggerSync);

// ── File management ───────────────────────────────────────────────────────────
router.get("/files", listFiles);
router.get("/files/:googleFileId/chunks", getFileChunks);
router.delete("/files/:googleFileId", deleteFile);

// ── Stats ─────────────────────────────────────────────────────────────────────
router.get("/stats", getStats);

module.exports = router;
