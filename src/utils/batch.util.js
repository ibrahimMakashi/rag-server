/**
 * src/utils/batch.util.js — Generic batching helpers
 *
 * Provides utilities for splitting large arrays into fixed-size
 * batches and processing them with concurrency control, which is
 * critical for staying within OpenAI rate limits while maximising
 * throughput.
 */

const logger = require("./logger.util");

/**
 * chunkArray — split an array into fixed-size sub-arrays.
 *
 * @param {Array}  arr       Source array
 * @param {number} size      Maximum items per batch
 * @returns {Array<Array>}   Array of batches
 *
 * @example
 * chunkArray([1,2,3,4,5], 2) // → [[1,2],[3,4],[5]]
 */
const chunkArray = (arr, size) => {
  if (!Array.isArray(arr) || size < 1) return [];
  const batches = [];
  for (let i = 0; i < arr.length; i += size) {
    batches.push(arr.slice(i, i + size));
  }
  return batches;
};

/**
 * processBatches — run an async handler over every batch with a
 * configurable delay between calls to avoid API rate limiting.
 *
 * @param {Array}    items          Full list of items to process
 * @param {number}   batchSize      Items per batch
 * @param {Function} handler        async (batch, batchIndex) => results[]
 * @param {number}   [delayMs=200]  Pause between batches (ms)
 * @returns {Promise<Array>}        Flat array of all results
 */
const processBatches = async (items, batchSize, handler, delayMs = 200) => {
  const batches = chunkArray(items, batchSize);
  const allResults = [];

  for (let i = 0; i < batches.length; i++) {
    logger.debug(`Processing batch ${i + 1}/${batches.length} (${batches[i].length} items)`);
    try {
      const results = await handler(batches[i], i);
      if (Array.isArray(results)) allResults.push(...results);
    } catch (err) {
      logger.error(`Batch ${i + 1} failed`, { error: err.message });
      throw err;
    }

    // Throttle between batches to avoid hitting API rate limits
    if (i < batches.length - 1 && delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  return allResults;
};

/**
 * retry — retry an async function up to `maxAttempts` times with
 * exponential back-off. Useful for transient OpenAI / Drive errors.
 *
 * @param {Function} fn            Async function to retry
 * @param {number}   maxAttempts   Maximum attempts (default 3)
 * @param {number}   baseDelayMs   Initial delay in ms (default 500)
 * @returns {Promise<*>}
 */
const retry = async (fn, maxAttempts = 3, baseDelayMs = 500) => {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        const delay = baseDelayMs * 2 ** (attempt - 1); // exponential back-off
        logger.warn(`Attempt ${attempt}/${maxAttempts} failed — retrying in ${delay}ms`, {
          error: err.message,
        });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
};

module.exports = { chunkArray, processBatches, retry };
