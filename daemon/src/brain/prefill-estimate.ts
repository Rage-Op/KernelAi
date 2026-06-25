/**
 * prefill-estimate.ts — estimates how long PROMPT PROCESSING (prefill) will take for the next turn,
 * so the Face can show a *determinate* LM-Studio-style progress bar.
 *
 * Why an estimate (not a true progress stream): Ollama's HTTP API does NOT expose incremental prefill
 * progress — only the final `prompt_eval_count` / `prompt_eval_duration` on the `done` line (the only
 * local engine that streams real prefill progress is llama.cpp's `llama-server`). So we learn the
 * machine's prefill throughput from each completed turn (an EWMA of tokens/ms) and, before the next
 * turn, estimate `etaMs ≈ estPromptTokens / tokPerMs`. Cold start (no sample yet) → `null`, and the
 * Face falls back to its honest indeterminate sweep so the bar never lies.
 *
 * Pure + module-level (one daemon, one machine). Reset for tests via `__resetPrefillEstimateForTest`.
 */

/** EWMA smoothing factor — favors recent turns while staying stable across a couple of outliers. */
const ALPHA = 0.3;

/** Rough chars-per-token for the assembled prompt (qwen/BPE ≈ 4 chars/token for English). */
export const CHARS_PER_TOKEN = 4;

/** Don't show a determinate bar for a trivially short prefill — it would just flash. */
const MIN_ETA_MS = 250;

/** The running estimate of prefill throughput in tokens/ms (null until the first measured turn). */
let tokensPerMs: number | null = null;

/**
 * Fold a completed turn's measured prefill into the EWMA. Ignores turns without both counters or with
 * a non-positive duration (a cached/zero prefill carries no throughput signal).
 */
export function recordPrefill(promptTokens?: number, promptEvalMs?: number): void {
  if (!promptTokens || !promptEvalMs || promptEvalMs <= 0 || promptTokens <= 0) return;
  const sample = promptTokens / promptEvalMs; // tokens per ms
  tokensPerMs = tokensPerMs == null ? sample : ALPHA * sample + (1 - ALPHA) * tokensPerMs;
}

/**
 * Estimate prefill time (ms) for a prompt of `promptChars` characters, or `null` when there is no
 * throughput sample yet (cold start) or the estimate is below the show-a-bar threshold.
 */
export function estimatePrefillMs(promptChars: number): number | null {
  if (tokensPerMs == null || promptChars <= 0) return null;
  const estTokens = promptChars / CHARS_PER_TOKEN;
  const etaMs = estTokens / tokensPerMs;
  return etaMs >= MIN_ETA_MS ? Math.round(etaMs) : null;
}

/** TEST-ONLY: clear the EWMA so each test starts cold. */
export function __resetPrefillEstimateForTest(): void {
  tokensPerMs = null;
}
