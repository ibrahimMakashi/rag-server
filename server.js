/**
 * server.js — Application entry point
 *
 * Bootstraps the Express app, connects to MongoDB, and starts
 * the HTTP server. Also initialises the cron scheduler for
 * automatic Google Drive synchronisation.
 */

require("dotenv").config();

const http = require("http");
const app = require("./src/app");
const connectDB = require("./src/config/db");
const { startDriveSyncCron } = require("./src/cron/driveSync.cron");
const logger = require("./src/utils/logger.util");

const PORT = process.env.PORT || 5000;

// ── 1. Connect to MongoDB Atlas ──────────────────────────────────────────────
connectDB()
  .then(() => {
    // ── 2. Start HTTP Server ─────────────────────────────────────────────────
    const server = http.createServer(app);

    server.listen(PORT, () => {
      logger.info(`🚀  RAG server running on port ${PORT}`);

      // ── 3. Start cron job for Drive sync ──────────────────────────────────
      startDriveSyncCron();
      logger.info("⏰  Drive sync cron job initialised");
    });

    // ── 4. Graceful shutdown ─────────────────────────────────────────────────
    const shutdown = (signal) => {
      logger.info(`${signal} received — shutting down gracefully`);
      server.close(() => {
        logger.info("HTTP server closed");
        process.exit(0);
      });
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  })
  .catch((err) => {
    logger.error("Failed to connect to MongoDB — aborting", { error: err.message });
    process.exit(1);
  });
