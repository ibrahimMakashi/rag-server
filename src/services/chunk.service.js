/**
 * src/services/chunk.service.js — Text chunking
 *
 * Splits extracted PDF page text into overlapping chunks using
 * LangChain's RecursiveCharacterTextSplitter, which respects natural
 * language boundaries (paragraphs → sentences → words → characters)
 * before hard-cutting, producing semantically coherent chunks.
 *
 * Each chunk is annotated with its source page number and a
 * file-level sequential index for downstream processing.
 */

const { RecursiveCharacterTextSplitter } = require("@langchain/textsplitters");
const logger = require("../utils/logger.util");
const { estimateTokens } = require("../utils/token.util");

// ── Chunking config (can be overridden via env) ───────────────────────────────
const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE, 10) || 800;
const CHUNK_OVERLAP = parseInt(process.env.CHUNK_OVERLAP, 10) || 100;

/**
 * chunkPages — split an array of PDF pages into overlapping text chunks.
 *
 * @param {Array<{ pageNumber: number, text: string }>} pages
 *   Per-page objects produced by pdf.service.js
 * @param {string} fileId       MongoDB ObjectId string of the parent File doc
 * @param {string} googleFileId Google Drive file ID
 * @param {string} fileName     Human-readable file name
 *
 * @returns {Promise<Array<{
 *   fileId: string,
 *   googleFileId: string,
 *   fileName: string,
 *   pageNumber: number,
 *   chunkIndex: number,    // zero-based, file-level
 *   chunkText: string,
 *   tokenCount: number
 * }>>}
 */
const chunkPages = async (pages, fileId, googleFileId, fileName) => {
  logger.info(`Chunking "${fileName}" — ${pages.length} page(s), size=${CHUNK_SIZE}, overlap=${CHUNK_OVERLAP}`);

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
    // Natural separators — the splitter will try each in order before
    // falling back to a hard character split.
    separators: ["\n\n", "\n", ". ", "? ", "! ", " ", ""],
  });

  const allChunks = [];
  let globalIndex = 0;

  for (const page of pages) {
    // Skip effectively empty pages
    if (!page.text || page.text.trim().length < 20) continue;

    // Split this page's text into chunks
    const rawChunks = await splitter.splitText(page.text);

    for (const chunkText of rawChunks) {
      const trimmed = chunkText.trim();
      if (trimmed.length < 10) continue; // skip tiny fragments

      allChunks.push({
        fileId,
        googleFileId,
        fileName,
        pageNumber: page.pageNumber,
        chunkIndex: globalIndex++,
        chunkText: trimmed,
        tokenCount: estimateTokens(trimmed),
      });
    }
  }

  logger.info(`Generated ${allChunks.length} chunks for "${fileName}"`);
  return allChunks;
};

/**
 * chunkFullText — convenience wrapper that splits a single text string
 * (no page breakdown) when per-page data is unavailable.
 *
 * @param {string} text
 * @param {Object} meta   { fileId, googleFileId, fileName }
 * @returns {Promise<Array>}
 */
const chunkFullText = async (text, { fileId, googleFileId, fileName }) => {
  const fakePage = [{ pageNumber: 1, text }];
  return chunkPages(fakePage, fileId, googleFileId, fileName);
};

module.exports = { chunkPages, chunkFullText };
