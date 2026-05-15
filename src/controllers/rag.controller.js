/**
 * src/controllers/rag.controller.js — HTTP request handlers
 *
 * Thin controller layer that:
 *   • Validates incoming request data
 *   • Delegates business logic to services
 *   • Formats consistent JSON responses
 *   • Handles and forwards errors to the global error handler
 *
 * All handlers are wrapped in try/catch so unhandled rejections
 * never crash the process.
 */

const { answerQuestion, answerQuestionStream } = require("../services/rag.service");
const { syncDriveFiles } = require("../services/sync.service");
const { runSync } = require("../cron/driveSync.cron");
const File = require("../models/File.model");
const Embedding = require("../models/Embedding.model");
const logger = require("../utils/logger.util");

// ─────────────────────────────────────────────────────────────────────────────
// Helper — send a uniform success envelope
// ─────────────────────────────────────────────────────────────────────────────
const ok = (res, data, status = 200) =>
  res.status(status).json({ success: true, ...data });

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/rag/ask
// Body: { question: string, fileId?: string, topK?: number }
// ─────────────────────────────────────────────────────────────────────────────
const askQuestion = async (req, res, next) => {
  try {
    const { question, fileId, topK } = req.body;

    if (!question || typeof question !== "string" || question.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: "Field `question` is required and must be a non-empty string.",
      });
    }

    if (question.trim().length > 2000) {
      return res.status(400).json({
        success: false,
        message: "Question exceeds the 2 000 character limit.",
      });
    }

    const result = await answerQuestion(question.trim(), {
      fileId: fileId || null,
      topK: topK ? Math.min(parseInt(topK, 10), 10) : 5,
    });

    return ok(res, {
      question: question.trim(),
      answer: result.answer,
      sources: result.sources,
      meta: {
        model: result.model,
        estimatedCostUSD: result.estimatedCostUSD,
        retrievedChunks: result.sources.length,
      },
    });
  } catch (err) {
    logger.error("askQuestion error", { error: err.message });
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/rag/ask/stream
// Server-Sent Events streaming answer
//
// SSE event types emitted to the client:
//   { type: "sources",  sources: [...] }           — fired immediately after retrieval
//   { type: "token",   token:   "..." }            — fired per GPT token
//   { type: "done",    estimatedCostUSD, model }   — fired when stream ends
//   { type: "error",   message: "..." }            — fired on failure
// ─────────────────────────────────────────────────────────────────────────────
const askQuestionStreaming = async (req, res, next) => {
  try {
    const { question, fileId, topK } = req.body;

    if (!question || typeof question !== "string" || question.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: "Field `question` is required and must be a non-empty string.",
      });
    }

    if (question.trim().length > 2000) {
      return res.status(400).json({
        success: false,
        message: "Question exceeds the 2 000 character limit.",
      });
    }

    // ── Set SSE headers ───────────────────────────────────────────────────────
    // Must set CORS here explicitly because flushHeaders() sends before
    // any body-level middleware can add headers to the SSE response.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-store, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // disable Nginx proxy buffering
    res.setHeader("Transfer-Encoding", "chunked");
    res.flushHeaders(); // send headers immediately — opens the stream in the browser

    // ── Helper: write and immediately flush one SSE event ────────────────────
    // Node.js buffers socket writes by default. We force a flush by calling
    // the underlying socket's write directly after res.write().
    const sendEvent = (payload) => {
      if (res.writableEnded) return;
      const line = `data: ${JSON.stringify(payload)}\n\n`;
      res.write(line);
      // Force the OS socket buffer to flush immediately
      if (res.socket && !res.socket.destroyed) {
        res.socket.flush?.(); // available with Node ≥ 18 streams
      }
    };

    // ── Handle client disconnect from the RESPONSE stream ────────────────────
    // IMPORTANT: use res.on("close"), NOT req.on("close").
    // req.close fires as soon as the POST body is read (immediately).
    // res.close fires only when the browser truly closes the SSE connection.
    let clientGone = false;
    res.on("close", () => {
      clientGone = true;
      logger.debug("SSE client closed the response stream");
    });

    // ── Run the streaming RAG pipeline ───────────────────────────────────────
    await answerQuestionStream(question.trim(), {
      fileId:  fileId || null,
      topK:    topK ? Math.min(parseInt(topK, 10), 10) : 5,

      // Called once — sources are available immediately after vector search
      onSources: (sources) => {
        if (!clientGone) sendEvent({ type: "sources", sources });
      },

      // Called for every token that arrives from OpenAI
      onToken: (token) => {
        if (!clientGone) sendEvent({ type: "token", token });
      },

      // Called when the OpenAI stream closes normally
      onDone: ({ estimatedCostUSD, model }) => {
        if (!clientGone) {
          sendEvent({ type: "done", estimatedCostUSD, model });
          res.end();
        }
      },

      // Called on any service-level error
      onError: (err) => {
        logger.error("SSE stream error", { error: err.message });
        if (!clientGone && !res.writableEnded) {
          sendEvent({ type: "error", message: err.message || "Stream error" });
          res.end();
        }
      },
    });

    // Safety net — ensure response is always closed even if onDone never fires
    if (!res.writableEnded) {
      sendEvent({ type: "done" });
      res.end();
    }

  } catch (err) {
    // Headers may already be sent — can't use next(err) for SSE responses
    logger.error("askQuestionStreaming error", { error: err.message });
    if (!res.headersSent) return next(err);
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: "error", message: err.message })}\n\n`);
      res.end();
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/rag/sync
// Manually trigger a Drive → MongoDB sync
// ─────────────────────────────────────────────────────────────────────────────
const triggerSync = async (req, res, next) => {
  try {
    logger.info("Manual sync triggered via API");
    // Use runSync (which has the lock) rather than syncDriveFiles directly
    const summary = await runSync();

    if (!summary) {
      return res.status(409).json({
        success: false,
        message: "A sync is already in progress. Please try again shortly.",
      });
    }

    return ok(res, { message: "Sync completed", summary });
  } catch (err) {
    logger.error("triggerSync error", { error: err.message });
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/rag/files
// List all tracked files and their processing status
// ─────────────────────────────────────────────────────────────────────────────
const listFiles = async (req, res, next) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const query = {};
    if (status) query.status = status;

    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const [files, total] = await Promise.all([
      File.find(query)
        .sort({ lastSyncedAt: -1 })
        .skip(skip)
        .limit(parseInt(limit, 10))
        .select("-__v")
        .lean(),
      File.countDocuments(query),
    ]);

    return ok(res, {
      files,
      pagination: {
        total,
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
        pages: Math.ceil(total / parseInt(limit, 10)),
      },
    });
  } catch (err) {
    logger.error("listFiles error", { error: err.message });
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/rag/files/:googleFileId/chunks
// Fetch stored chunks for a specific file
// ─────────────────────────────────────────────────────────────────────────────
const getFileChunks = async (req, res, next) => {
  try {
    const { googleFileId } = req.params;
    const { page = 1, limit = 50 } = req.query;
    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const [chunks, total] = await Promise.all([
      Embedding.find({ googleFileId })
        .sort({ chunkIndex: 1 })
        .skip(skip)
        .limit(parseInt(limit, 10))
        .select("pageNumber chunkIndex chunkText tokenCount createdAt")
        .lean(),
      Embedding.countDocuments({ googleFileId }),
    ]);

    if (total === 0) {
      return res.status(404).json({
        success: false,
        message: `No chunks found for file ID: ${googleFileId}`,
      });
    }

    return ok(res, {
      googleFileId,
      chunks,
      pagination: {
        total,
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
        pages: Math.ceil(total / parseInt(limit, 10)),
      },
    });
  } catch (err) {
    logger.error("getFileChunks error", { error: err.message });
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/rag/stats
// Overall system statistics
// ─────────────────────────────────────────────────────────────────────────────
const getStats = async (_req, res, next) => {
  try {
    const [
      totalFiles,
      completedFiles,
      failedFiles,
      totalEmbeddings,
      statusCounts,
    ] = await Promise.all([
      File.countDocuments(),
      File.countDocuments({ status: "completed" }),
      File.countDocuments({ status: "failed" }),
      Embedding.countDocuments(),
      File.aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
    ]);

    return ok(res, {
      stats: {
        files: {
          total: totalFiles,
          completed: completedFiles,
          failed: failedFiles,
          byStatus: statusCounts.reduce(
            (acc, s) => ({ ...acc, [s._id]: s.count }),
            {}
          ),
        },
        embeddings: {
          total: totalEmbeddings,
        },
      },
    });
  } catch (err) {
    logger.error("getStats error", { error: err.message });
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/rag/files/:googleFileId
// Remove a file and all its embeddings from the DB
// ─────────────────────────────────────────────────────────────────────────────
const deleteFile = async (req, res, next) => {
  try {
    const { googleFileId } = req.params;

    const [fileResult, embResult] = await Promise.all([
      File.deleteOne({ googleFileId }),
      Embedding.deleteMany({ googleFileId }),
    ]);

    if (fileResult.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: `File not found: ${googleFileId}`,
      });
    }

    return ok(res, {
      message: "File and embeddings deleted",
      deletedEmbeddings: embResult.deletedCount,
    });
  } catch (err) {
    logger.error("deleteFile error", { error: err.message });
    next(err);
  }
};

module.exports = {
  askQuestion,
  askQuestionStreaming,
  triggerSync,
  listFiles,
  getFileChunks,
  getStats,
  deleteFile,
};
