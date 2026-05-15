/**
 * src/config/googleDrive.js — Google Drive API client
 *
 * Authenticates using a Service Account (JWT) and exports a
 * pre-authorised `drive` client ready for file-level operations.
 *
 * The private key stored in .env uses literal "\n" sequences;
 * this module converts them to real newlines before use.
 */

const { google } = require("googleapis");

// ── Validate required env variables ─────────────────────────────────────────
const REQUIRED = ["GOOGLE_CLIENT_EMAIL", "GOOGLE_PRIVATE_KEY", "GOOGLE_DRIVE_FOLDER_ID"];
REQUIRED.forEach((key) => {
  if (!process.env[key]) {
    throw new Error(`Missing required env variable: ${key}`);
  }
});

/**
 * Build a JWT auth client from Service Account credentials.
 * The private key may be stored with escaped newlines (\n) in the
 * .env file — replace them with real newline characters.
 */
const auth = new google.auth.JWT({
  email: process.env.GOOGLE_CLIENT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  scopes: ["https://www.googleapis.com/auth/drive.readonly"],
});

/**
 * Authorised Google Drive v3 client.
 * Usage: `drive.files.list(...)`, `drive.files.get(...)`, etc.
 */
const drive = google.drive({ version: "v3", auth });

module.exports = drive;
