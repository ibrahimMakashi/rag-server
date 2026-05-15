/**
 * src/services/drive.service.js — Google Drive operations
 *
 * Responsible for:
 *  1. Listing all PDF files inside the configured Drive folder
 *  2. Downloading a PDF as a raw Buffer for further processing
 *
 * Uses the pre-authorised Drive client from config/googleDrive.js.
 */

const { Readable } = require("stream");
const drive = require("../config/googleDrive");
const logger = require("../utils/logger.util");
const { retry } = require("../utils/batch.util");

const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

/**
 * listPDFsInFolder — fetch metadata for every PDF in the Drive folder.
 *
 * Returns an array of objects with the fields we need for change detection:
 *   { id, name, modifiedTime, mimeType, size }
 *
 * Handles Drive's 1 000-item page limit by following `nextPageToken`.
 *
 * @returns {Promise<Array<{id, name, modifiedTime, mimeType, size}>>}
 */
const listPDFsInFolder = async () => {
  logger.info(`Listing PDFs in Drive folder: ${FOLDER_ID}`);

  const files = [];
  let pageToken = null;

  do {
    const response = await retry(() =>
      drive.files.list({
        q: `'${FOLDER_ID}' in parents and mimeType='application/pdf' and trashed=false`,
        fields: "nextPageToken, files(id, name, modifiedTime, mimeType, size)",
        pageSize: 100,               // max allowed per request
        pageToken: pageToken || undefined,
        orderBy: "modifiedTime desc",
      })
    );

    const page = response.data.files || [];
    files.push(...page);
    pageToken = response.data.nextPageToken;

    logger.debug(`Fetched ${page.length} file(s) — total so far: ${files.length}`);
  } while (pageToken);

  logger.info(`Total PDFs found in Drive: ${files.length}`);
  return files;
};

/**
 * downloadFileAsBuffer — stream a Drive file into memory as a Buffer.
 *
 * Using `alt: "media"` tells the Drive API to return the raw file bytes
 * rather than the JSON metadata. We pipe the response stream through a
 * collector to produce a single contiguous Buffer.
 *
 * @param {string} fileId   Google Drive file ID
 * @returns {Promise<Buffer>}
 */
const downloadFileAsBuffer = async (fileId) => {
  logger.info(`Downloading Drive file: ${fileId}`);

  const response = await retry(() =>
    drive.files.get(
      { fileId, alt: "media" },
      { responseType: "stream" }
    )
  );

  return new Promise((resolve, reject) => {
    const chunks = [];

    response.data
      .on("data", (chunk) => chunks.push(chunk))
      .on("end", () => {
        const buffer = Buffer.concat(chunks);
        logger.debug(`Downloaded ${buffer.length} bytes for file ${fileId}`);
        resolve(buffer);
      })
      .on("error", (err) => {
        logger.error(`Stream error downloading ${fileId}`, { error: err.message });
        reject(err);
      });
  });
};

/**
 * getFileMetadata — fetch metadata for a single file by ID.
 * Useful for verifying permissions before bulk processing.
 *
 * @param {string} fileId
 * @returns {Promise<Object>}
 */
const getFileMetadata = async (fileId) => {
  const response = await retry(() =>
    drive.files.get({
      fileId,
      fields: "id, name, modifiedTime, mimeType, size",
    })
  );
  return response.data;
};

module.exports = { listPDFsInFolder, downloadFileAsBuffer, getFileMetadata };
