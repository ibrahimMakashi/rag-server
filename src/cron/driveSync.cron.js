/**
 * src/cron/driveSync.cron.js — Scheduled Google Drive synchronisation
 *
 * Uses node-cron to run the Drive sync pipeline automatically on the
 * schedule defined by the CRON_SCHEDULE env variable (default: every
 * 10 minutes). A lock flag prevents overlapping runs if a previous
 * sync is still in progress.
 */

const cron = require("node-cron");
const { syncDriveFiles } = require("../services/sync.service");
const logger = require("../utils/logger.util");

// Default: every 10 minutes.  Override via CRON_SCHEDULE in .env.
const SCHEDULE = process.env.CRON_SCHEDULE || "*/10 * * * *";

// Simple in-process lock — prevents concurrent sync runs
let isSyncing = false;

/**
 * runSync — execute the sync with lock protection.
 * Safe to call manually (e.g. from a test or the manual endpoint).
 */
const runSync = async () => {
  if (isSyncing) {
    logger.warn("Drive sync skipped — previous run still in progress");
    return null;
  }

  isSyncing = true;
  logger.info(`[CRON] Drive sync triggered at ${new Date().toISOString()}`);

  try {
    const summary = await syncDriveFiles();
    logger.info("[CRON] Sync summary", { summary });
    return summary;
  } catch (err) {
    logger.error("[CRON] Drive sync failed", { error: err.message });
    return null;
  } finally {
    isSyncing = false;
  }
};

/**
 * startDriveSyncCron — register the cron job and kick off an
 * immediate first run so the DB is populated on startup.
 */
const startDriveSyncCron = () => {
  // Validate schedule string before registering
  if (!cron.validate(SCHEDULE)) {
    logger.error(`Invalid CRON_SCHEDULE: "${SCHEDULE}" — cron not started`);
    return;
  }

  // ── Register the recurring job ───────────────────────────────────────────
  cron.schedule(SCHEDULE, runSync, {
    scheduled: true,
    timezone: "UTC",
  });

  logger.info(`Drive sync cron registered — schedule: "${SCHEDULE}"`);

  // ── Run immediately on startup (don't wait for first cron tick) ──────────
  // Small delay to ensure DB connection is fully established first
  setTimeout(runSync, 5_000);
};

module.exports = { startDriveSyncCron, runSync };
