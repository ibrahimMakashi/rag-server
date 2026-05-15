/**
 * src/services/pdf.service.js — PDF text extraction
 *
 * Downloads a PDF from Google Drive and extracts its plain text
 * using the `pdf-parse` library. Returns structured per-page content
 * so that downstream chunking can preserve page-number metadata.
 *
 * NOTE: pdf-parse operates entirely in-memory — no temp files are
 * written to disk, keeping the server stateless and container-friendly.
 */

const pdfParse = require("pdf-parse");
const crypto = require("crypto");
const { downloadFileAsBuffer } = require("./drive.service");
const logger = require("../utils/logger.util");

/**
 * extractTextFromPDF — download and parse a Drive PDF.
 *
 * @param {string} fileId     Google Drive file ID
 * @param {string} fileName   Human-readable name (for logging only)
 * @returns {Promise<{
 *   text: string,           // Full concatenated text
 *   pages: Array<{          // Per-page breakdown
 *     pageNumber: number,
 *     text: string
 *   }>,
 *   totalPages: number,
 *   checksum: string        // MD5 of the raw PDF bytes
 * }>}
 */
const extractTextFromPDF = async (fileId, fileName) => {
  logger.info(`Extracting text from PDF: ${fileName} (${fileId})`);

  // ── 1. Download raw bytes ─────────────────────────────────────────────────
  const pdfBuffer = await downloadFileAsBuffer(fileId);

  // ── 2. Compute checksum for change-detection ──────────────────────────────
  const checksum = crypto.createHash("md5").update(pdfBuffer).digest("hex");
  logger.debug(`PDF checksum: ${checksum}`);

  // ── 3. Parse with pdf-parse ───────────────────────────────────────────────
  // The `pagerender` callback is called once per page, allowing us to
  // collect individual page texts without a second parse pass.
  const pageTexts = [];

  const parseOptions = {
    // Called for every page during parsing
    pagerender: (pageData) => {
      return pageData.getTextContent().then((content) => {
        const pageText = content.items.map((item) => item.str).join(" ");
        pageTexts.push(pageText.trim());
        // Return empty string — pdf-parse will aggregate the full text itself
        return "";
      });
    },
  };

  let parsed;
  try {
    parsed = await pdfParse(pdfBuffer, parseOptions);
  } catch (err) {
    // pdf-parse can throw on encrypted or malformed PDFs
    logger.error(`pdf-parse failed for ${fileName}`, { error: err.message });
    throw new Error(`Failed to parse PDF "${fileName}": ${err.message}`);
  }

  const totalPages = parsed.numpages || pageTexts.length;

  // ── 4. Build per-page objects ─────────────────────────────────────────────
  // If pagerender didn't fire (e.g. image-only PDF), fall back to the
  // full text split naively by form-feed characters.
  let pages;
  if (pageTexts.length > 0) {
    pages = pageTexts.map((text, i) => ({
      pageNumber: i + 1,
      text: cleanText(text),
    }));
  } else {
    // Fallback: treat the entire document as page 1
    logger.warn(`No per-page text for ${fileName} — using full-doc fallback`);
    pages = [{ pageNumber: 1, text: cleanText(parsed.text) }];
  }

  // Filter out effectively empty pages (e.g. cover images)
  const nonEmptyPages = pages.filter((p) => p.text.length > 20);

  logger.info(
    `Extracted ${nonEmptyPages.length} non-empty pages from "${fileName}" ` +
    `(total pages: ${totalPages})`
  );

  return {
    text: nonEmptyPages.map((p) => p.text).join("\n\n"),
    pages: nonEmptyPages,
    totalPages,
    checksum,
  };
};

/**
 * cleanText — normalise whitespace in extracted PDF text.
 * pdf-parse often produces excessive spaces and line breaks.
 *
 * @param {string} raw
 * @returns {string}
 */
const cleanText = (raw) => {
  if (!raw) return "";
  return raw
    .replace(/\r\n/g, "\n")          // normalise line endings
    .replace(/[ \t]+/g, " ")         // collapse horizontal whitespace
    .replace(/\n{3,}/g, "\n\n")      // collapse 3+ blank lines → 2
    .trim();
};

module.exports = { extractTextFromPDF };
