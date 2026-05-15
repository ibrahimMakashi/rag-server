/**
 * src/services/vectorSearch.service.js — MongoDB Atlas Vector Search
 *
 * Executes a cosine-similarity vector search and applies a minimum
 * relevance score threshold to avoid returning loosely related chunks
 * from unrelated documents.
 *
 * Cosine similarity score guide (text-embedding-3-small):
 *   >= 0.82  → highly relevant (same topic, same document)
 *   0.75–0.82 → moderately relevant
 *   0.70–0.75 → loosely related
 *   < 0.70   → likely irrelevant — filtered out
 */

const mongoose = require("mongoose");
const Embedding = require("../models/Embedding.model");
const logger = require("../utils/logger.util");

const VECTOR_INDEX_NAME = "vector_index";
const NUM_CANDIDATES    = 150;   // evaluate more candidates for better accuracy
const TOP_K             = 5;

/**
 * Minimum cosine similarity score a chunk must have to be included.
 * Raise this (e.g. 0.80) to be more strict; lower it (e.g. 0.65) to
 * be more permissive. 0.72 is a solid default for mixed-topic corpora.
 */
const MIN_SCORE = parseFloat(process.env.VECTOR_MIN_SCORE || "0.72");

/**
 * searchSimilarChunks — run Atlas Vector Search + score filtering.
 *
 * @param {number[]} queryEmbedding   1536-element float array
 * @param {number}   [topK=5]         Max results to return (after filtering)
 * @param {Object}   [filter={}]      Optional pre-filter (e.g. { googleFileId })
 *
 * @returns {Promise<Array<{
 *   _id, fileName, pageNumber, chunkIndex, chunkText, googleFileId, score
 * }>>}
 */
const searchSimilarChunks = async (queryEmbedding, topK = TOP_K, filter = {}) => {
  logger.info(
    `Vector search — topK=${topK}, minScore=${MIN_SCORE}, filter=${JSON.stringify(filter)}`
  );

  // ── 1. $vectorSearch stage ────────────────────────────────────────────────
  // Fetch more candidates than topK so the score filter below still has
  // enough results to pick from after pruning low-relevance chunks.
  const vectorSearchStage = {
    $vectorSearch: {
      index: VECTOR_INDEX_NAME,
      path: "embedding",
      queryVector: queryEmbedding,
      numCandidates: Math.max(NUM_CANDIDATES, topK * 20),
      limit: topK * 3, // fetch 3× topK, then filter by score
    },
  };

  if (Object.keys(filter).length > 0) {
    vectorSearchStage.$vectorSearch.filter = filter;
  }

  const pipeline = [
    vectorSearchStage,

    // ── 2. Compute score and project needed fields ─────────────────────────
    {
      $project: {
        _id: 1,
        fileName: 1,
        pageNumber: 1,
        chunkIndex: 1,
        chunkText: 1,
        googleFileId: 1,
        score: { $meta: "vectorSearchScore" },
      },
    },

    // ── 3. Filter out low-relevance chunks ─────────────────────────────────
    // This is what prevents unrelated documents from appearing as sources.
    { $match: { score: { $gte: MIN_SCORE } } },

    // ── 4. Cap at topK after filtering ────────────────────────────────────
    { $limit: topK },
  ];

  try {
    const results = await Embedding.aggregate(pipeline);

    // Log each result so relevance can be tuned if needed
    results.forEach((r) =>
      logger.debug(
        `  chunk score=${r.score.toFixed(4)} file="${r.fileName}" page=${r.pageNumber}`
      )
    );

    logger.info(
      `Vector search: ${results.length} chunk(s) above minScore=${MIN_SCORE}`
    );

    return results;
  } catch (err) {
    logger.error("Vector search failed — check vector_index exists in Atlas", {
      error: err.message,
      code: err.code,
    });
    return [];
  }
};

module.exports = { searchSimilarChunks };
