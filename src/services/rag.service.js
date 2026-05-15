/**
 * src/services/rag.service.js — Retrieval-Augmented Generation pipeline
 *
 * Two pipeline variants:
 *   • answerQuestion       — blocking, returns full answer JSON
 *   • answerQuestionStream — streams GPT tokens via callbacks (used for SSE)
 *
 * Cost optimisations:
 *   • Only top-5 chunks sent to LLM
 *   • GPT-4o-mini (cheapest capable model)
 *   • Context truncated to ~5 500 tokens
 *   • max_tokens capped at 1 024
 */

const openai = require("../config/openai");
const { generateQueryEmbedding } = require("./embedding.service");
const { searchSimilarChunks } = require("./vectorSearch.service");
const { estimateChatCost, truncateToTokenLimit } = require("../utils/token.util");
const { retry } = require("../utils/batch.util");
const logger = require("../utils/logger.util");

const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";
const TOP_K = 5;

// ─────────────────────────────────────────────────────────────────────────────
// Shared helper — build prompts + source list from retrieved chunks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * buildPrompts — shared by both pipeline variants.
 *
 * @param {string} question
 * @param {Array}  chunks   — from searchSimilarChunks()
 * @returns {{ systemPrompt, userPrompt, sources }}
 */
const buildPrompts = (question, chunks) => {
  const contextBlocks = chunks.map(
    (c, i) => `[Source ${i + 1}] ${c.fileName} (page ${c.pageNumber}):\n${c.chunkText}`
  );
  const rawContext = contextBlocks.join("\n\n---\n\n");
  // Truncate to ~5 500 tokens (≈ 22 000 chars) to stay well within 128 k window
  const context = truncateToTokenLimit(rawContext, 5_500);

  const systemPrompt =
    "You are a helpful AI assistant. " +
    "Answer ONLY from the provided context. " +
    "If the answer is not found in the context, say: " +
    '"I don\'t have enough information in the provided documents to answer that." ' +
    "Be concise and accurate. Cite the source number when referencing information.";

  const userPrompt = `Context:\n${context}\n\nQuestion:\n${question}`;

  const sources = chunks.map((c) => ({
    fileName: c.fileName,
    googleFileId: c.googleFileId,
    pageNumber: c.pageNumber,
    chunkIndex: c.chunkIndex,
    score: parseFloat((c.score || 0).toFixed(4)),
  }));

  return { systemPrompt, userPrompt, sources };
};

// ─────────────────────────────────────────────────────────────────────────────
// Blocking pipeline — POST /api/rag/ask
// ─────────────────────────────────────────────────────────────────────────────

/**
 * answerQuestion — full RAG pipeline, returns complete answer once done.
 *
 * @param {string} question
 * @param {Object} [options]
 * @param {string} [options.fileId]  Restrict search to one Drive file
 * @param {number} [options.topK=5]  Chunks to retrieve
 * @returns {Promise<{ answer, sources, model, estimatedCostUSD }>}
 */
const answerQuestion = async (question, options = {}) => {
  const { fileId, topK = TOP_K } = options;
  logger.info(`RAG (blocking) — question: "${question.slice(0, 80)}…"`);

  const queryEmbedding = await generateQueryEmbedding(question);
  const filter = fileId ? { googleFileId: fileId } : {};
  const chunks = await searchSimilarChunks(queryEmbedding, topK, filter);

  if (chunks.length === 0) {
    logger.warn("No relevant chunks found");
    return {
      answer: "I could not find any relevant information in the uploaded documents to answer your question.",
      sources: [],
      model: CHAT_MODEL,
      estimatedCostUSD: 0,
    };
  }

  const { systemPrompt, userPrompt, sources } = buildPrompts(question, chunks);

  const completion = await retry(() =>
    openai.chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt   },
      ],
      temperature: 0.2,
      max_tokens: 1024,
      top_p: 0.9,
    })
  );

  const answer = completion.choices[0]?.message?.content?.trim() || "No answer generated.";
  const usage  = completion.usage || {};
  const costUSD = estimateChatCost(usage.prompt_tokens || 0, usage.completion_tokens || 0);

  logger.info(
    `RAG (blocking) done — ${usage.prompt_tokens}+${usage.completion_tokens} tokens, ` +
    `$${costUSD.toFixed(6)}`
  );

  return { answer, sources, model: CHAT_MODEL, estimatedCostUSD: costUSD };
};

// ─────────────────────────────────────────────────────────────────────────────
// Streaming pipeline — POST /api/rag/ask/stream
// ─────────────────────────────────────────────────────────────────────────────

/**
 * answerQuestionStream — RAG pipeline with real-time SSE token delivery.
 *
 * Timeline:
 *   ~200-400 ms  → embed + vector search complete
 *                → onSources() fired immediately (frontend renders citations)
 *   per token    → onToken(tokenString) called for every GPT token fragment
 *   after last   → onDone({ estimatedCostUSD, model }) signals completion
 *
 * @param {string}   question
 * @param {Object}   options
 * @param {string}   [options.fileId]     Restrict search scope
 * @param {number}   [options.topK=5]     Chunks to retrieve
 * @param {Function} options.onSources    Called once with sources[] before streaming
 * @param {Function} options.onToken      Called for every token string fragment
 * @param {Function} options.onDone       Called when stream ends with cost metadata
 * @param {Function} [options.onError]    Called on any error
 * @returns {Promise<void>}
 */
const answerQuestionStream = async (question, options = {}) => {
  const { fileId, topK = TOP_K, onSources, onToken, onDone, onError } = options;

  logger.info(`RAG (stream) — question: "${question.slice(0, 80)}…"`);

  try {
    // ── 1. Embed + vector search (fast, completes before first token) ─────────
    const queryEmbedding = await generateQueryEmbedding(question);
    const filter = fileId ? { googleFileId: fileId } : {};
    const chunks = await searchSimilarChunks(queryEmbedding, topK, filter);

    // ── 2. No results fallback ────────────────────────────────────────────────
    if (chunks.length === 0) {
      logger.warn("No relevant chunks — stream fallback message");
      if (onSources) onSources([]);
      if (onToken)   onToken("I could not find any relevant information in the uploaded documents to answer your question.");
      if (onDone)    onDone({ estimatedCostUSD: 0, model: CHAT_MODEL });
      return;
    }

    const { systemPrompt, userPrompt, sources } = buildPrompts(question, chunks);

    // ── 3. Fire sources BEFORE the stream opens so frontend renders them now ──
    if (onSources) onSources(sources);

    // ── 4. Open OpenAI streaming completion ───────────────────────────────────
    const stream = await openai.chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt   },
      ],
      temperature: 0.2,
      max_tokens: 1024,
      top_p: 0.9,
      stream: true,         // ← enables token-by-token delivery from OpenAI
    });

    // ── 5. Forward every token to the controller as it arrives ────────────────
    let completionTokens = 0;

    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content;

      if (token) {
        completionTokens++;
        if (onToken) onToken(token);
      }

      // finish_reason=stop signals the model has finished
      if (chunk.choices[0]?.finish_reason === "stop") break;
    }

    // ── 6. Estimate cost (stream mode doesn't return usage by default) ────────
    const promptTokens = Math.ceil((systemPrompt.length + userPrompt.length) / 4);
    const costUSD = estimateChatCost(promptTokens, completionTokens);

    logger.info(
      `RAG (stream) done — ~${promptTokens}+${completionTokens} tokens, $${costUSD.toFixed(6)}`
    );

    if (onDone) onDone({ estimatedCostUSD: costUSD, model: CHAT_MODEL });

  } catch (err) {
    logger.error("RAG stream error", { error: err.message });
    if (onError) onError(err);
    else throw err;
  }
};

module.exports = { answerQuestion, answerQuestionStream };
