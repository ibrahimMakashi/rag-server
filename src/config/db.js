/**
 * src/config/db.js — MongoDB Atlas connection
 *
 * Establishes a Mongoose connection with retry logic and
 * connection-pool tuning suitable for a production workload.
 */

const mongoose = require("mongoose");
const logger = require("../utils/logger.util");

// Maximum number of reconnect attempts before giving up
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 3000;

/**
 * connectDB — connect to MongoDB Atlas with exponential back-off.
 * @returns {Promise<void>}
 */
const connectDB = async (attempt = 1) => {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      // Keep the connection pool lean to stay within Atlas free-tier limits
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 8000,
      socketTimeoutMS: 45000,
    });

    logger.info("✅  MongoDB Atlas connected successfully");

    // ── Connection event listeners ───────────────────────────────────────────
    mongoose.connection.on("disconnected", () => {
      logger.warn("MongoDB disconnected — attempting reconnect…");
      connectDB();
    });

    mongoose.connection.on("error", (err) => {
      logger.error("MongoDB connection error", { error: err.message });
    });
  } catch (err) {
    logger.error(`MongoDB connection attempt ${attempt} failed`, {
      error: err.message,
    });

    if (attempt < MAX_RETRIES) {
      const delay = RETRY_DELAY_MS * attempt; // simple linear back-off
      logger.info(`Retrying in ${delay / 1000}s…`);
      await new Promise((r) => setTimeout(r, delay));
      return connectDB(attempt + 1);
    }

    // All retries exhausted — rethrow so server.js can exit cleanly
    throw err;
  }
};

module.exports = connectDB;
