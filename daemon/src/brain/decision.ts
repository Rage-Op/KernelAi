/**
 * decision.ts — the shared "brain JSON text → Decision" mapper.
 *
 * LocalBrain (Ollama `format:'json'`) and ClaudeCodeBrain (`--output-format json`)
 * both produce a JSON string that should validate against the EXISTING `DecisionSchema`
 * (BrainProvider.ts). This module is the one place that JSON.parses + safeParses that
 * text so the brains don't each re-implement it.
 *
 * Robustness contract (RESEARCH.md "Decision JSON parse shared by Local/Claude"):
 *   - never throws — a malformed/non-JSON/invalid-shape input degrades to a usable
 *     Decision that surfaces the raw text as the reply (clipped to 500 chars).
 *   - the schema is reused, NEVER redefined (DecisionSchema is the frozen contract).
 */
import { DecisionSchema, type Decision } from './BrainProvider.js';

/**
 * Parse a brain's JSON text into a validated `Decision`. On any failure (not JSON,
 * or JSON that fails `DecisionSchema`) returns a degraded-but-valid Decision whose
 * `reply` is the raw text, clipped — so the loop always has something to surface.
 */
export function parseDecision(raw: string): Decision {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { thought: 'unparseable brain output', reply: raw.slice(0, 500) };
  }
  const parsed = DecisionSchema.safeParse(obj);
  return parsed.success ? parsed.data : { thought: 'unparseable brain output', reply: raw.slice(0, 500) };
}
