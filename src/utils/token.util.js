/**
 * src/utils/token.util.js — Token estimation helpers
 *
 * Provides a cheap, offline approximation of GPT token counts
 * without importing the full `tiktoken` library (which adds ~10 MB
 * and native bindings). The rule of thumb "1 token ≈ 4 characters"
 * is accurate enough for cost-tracking purposes.
 *
 * If you need exact counts, swap `estimateTokens` for a tiktoken call.
 */

/**
 * estimateTokens — rough token count for a string.
 *
 * Based on OpenAI's public guidance:
 *   ~4 characters per token for English text
 *   ~1 token per word on average
 *
 * @param {string} text
 * @returns {number} estimated token count
 */
const estimateTokens = (text) => {
  if (!text || typeof text !== "string") return 0;
  // Use character-based estimate (fast, no dependencies)
  return Math.ceil(text.length / 4);
};

/**
 * estimateCost — rough USD cost for embedding a string.
 *
 * text-embedding-3-small pricing (as of 2024):
 *   $0.00002 per 1 000 tokens
 *
 * @param {number} tokenCount
 * @returns {number} estimated cost in USD
 */
const estimateEmbeddingCost = (tokenCount) => {
  const PRICE_PER_1K = 0.00002;
  return (tokenCount / 1000) * PRICE_PER_1K;
};

/**
 * estimateChatCost — rough USD cost for a GPT-4o-mini completion.
 *
 * gpt-4o-mini pricing (as of 2024):
 *   Input:  $0.00015 per 1 000 tokens
 *   Output: $0.00060 per 1 000 tokens
 *
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @returns {number} estimated cost in USD
 */
const estimateChatCost = (inputTokens, outputTokens) => {
  const INPUT_PRICE = 0.00015;
  const OUTPUT_PRICE = 0.0006;
  return (inputTokens / 1000) * INPUT_PRICE + (outputTokens / 1000) * OUTPUT_PRICE;
};

/**
 * truncateToTokenLimit — trim text to an approximate token limit.
 * Useful for ensuring context windows are not exceeded.
 *
 * @param {string} text
 * @param {number} maxTokens
 * @returns {string}
 */
const truncateToTokenLimit = (text, maxTokens) => {
  const maxChars = maxTokens * 4;
  return text.length > maxChars ? text.slice(0, maxChars) + "…" : text;
};

module.exports = {
  estimateTokens,
  estimateEmbeddingCost,
  estimateChatCost,
  truncateToTokenLimit,
};
