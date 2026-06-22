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
 *     Decision that surfaces readable text as the reply (clipped to 500 chars).
 *   - when the JSON is valid but NOT a Decision (a small local model often emits a chat
 *     envelope like `{"role":"assistant","content":"…"}` or a bare `{"reply":"…"}` without
 *     the required `thought`), salvage a human-readable string from the common shapes
 *     instead of dumping the raw JSON at the user.
 *   - the schema is reused, NEVER redefined (DecisionSchema is the frozen contract).
 */
import { DecisionSchema, type Decision } from './BrainProvider.js';

/** First non-empty string among common reply-bearing fields on a non-Decision JSON object. */
function salvageReply(obj: unknown): string | null {
  if (typeof obj !== 'object' || obj === null) return null;
  const o = obj as Record<string, unknown>;
  const candidates: unknown[] = [
    o.reply, // a Decision-ish object missing the required `thought`
    o.content, // Ollama chat-message echo: {role, content}
    o.response, // some local models name it `response`
    o.answer,
    o.text,
    (o.message as Record<string, unknown> | undefined)?.content, // nested {message:{content}}
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c.trim();
  }
  return null;
}

/**
 * Parse a brain's JSON text into a validated `Decision`. On a schema match, returns it as-is.
 * Otherwise degrades to a valid Decision whose `reply` is the best readable text we can salvage
 * (a known envelope field, else the raw text clipped) — so the loop always has something usable.
 */
export function parseDecision(raw: string): Decision {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { thought: 'unparseable brain output', reply: raw.slice(0, 500) };
  }
  const parsed = DecisionSchema.safeParse(obj);
  if (parsed.success) return parsed.data;
  const salvaged = salvageReply(obj);
  return {
    thought: 'brain output did not match the Decision schema',
    reply: salvaged ?? raw.slice(0, 500),
  };
}
