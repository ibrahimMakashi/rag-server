/**
 * src/config/openai.js — OpenAI client singleton
 *
 * Exports a single, reusable OpenAI client instance configured
 * from environment variables. Using a singleton avoids creating
 * a new HTTP client on every import, which keeps memory low.
 */

const OpenAI = require("openai");

if (!process.env.OPENAI_API_KEY) {
  throw new Error("Missing required env variable: OPENAI_API_KEY");
}

/**
 * Pre-configured OpenAI client.
 * Use `openai.chat.completions.create(...)` for GPT calls and
 * `openai.embeddings.create(...)` for embedding calls.
 */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  // Increase timeout for large embedding batches
  timeout: 60_000,
  maxRetries: 3,
});

module.exports = openai;
