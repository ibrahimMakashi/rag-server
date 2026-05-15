/**
 * src/utils/logger.util.js — Winston logger
 *
 * A structured, levelled logger used across the entire codebase.
 * In production, only `warn` and above are emitted to keep noise low
 * and reduce log-ingestion costs on hosted logging services.
 */

const { createLogger, format, transports } = require("winston");

const { combine, timestamp, printf, colorize, errors } = format;

// ── Custom log format ────────────────────────────────────────────────────────
const logFormat = printf(({ level, message, timestamp: ts, stack, ...meta }) => {
  const base = `${ts} [${level}]: ${stack || message}`;
  const extras = Object.keys(meta).length ? ` | ${JSON.stringify(meta)}` : "";
  return base + extras;
});

const logger = createLogger({
  level: process.env.NODE_ENV === "production" ? "warn" : "debug",
  format: combine(
    errors({ stack: true }), // capture stack traces
    timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    logFormat
  ),
  transports: [
    new transports.Console({
      format: combine(colorize(), timestamp({ format: "HH:mm:ss" }), logFormat),
    }),
  ],
});

// In production also write errors to a persistent file
if (process.env.NODE_ENV === "production") {
  logger.add(
    new transports.File({
      filename: "logs/error.log",
      level: "error",
      maxsize: 5 * 1024 * 1024, // 5 MB
      maxFiles: 5,
    })
  );
  logger.add(
    new transports.File({
      filename: "logs/combined.log",
      maxsize: 10 * 1024 * 1024,
      maxFiles: 10,
    })
  );
}

module.exports = logger;
