/**
 * src/app.js — Express application factory
 *
 * Configures middleware, mounts route handlers, and provides
 * centralised error handling. Does NOT start the server itself
 * (that responsibility belongs to server.js).
 */

const express = require("express");
const cors = require("cors");
const ragRoutes = require("./routes/rag.routes");
const logger = require("./utils/logger.util");

const app = express(); 

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ── Request logger (development) ─────────────────────────────────────────────
if (process.env.NODE_ENV !== "production") { 
  app.use((req, _res, next) => {
    logger.debug(`${req.method} ${req.originalUrl}`);
    next();
  });
}

app.get("/crash", (req, res) => {
    process.exit(1);
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

// ── API routes ────────────────────────────────────────────────────────────────
app.use("/api/rag", ragRoutes);

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ success: false, message: "Route not found" });
});

// ── Global error handler ─────────────────────────────────────────────────────
// Must have 4 parameters for Express to recognise it as an error handler.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  logger.error("Unhandled error", { message: err.message, stack: err.stack });
  res.status(err.status || 500).json({
    success: false,
    message: err.message || "Internal server error",
  });
});

module.exports = app;
