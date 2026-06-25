import { z } from 'zod';
import type { ContextItem, Provenance } from '../memory/types.js';

/**
 * The brain swap-seam (spec §6). Built FIRST, before any implementation (BRAIN-01).
 * Anything that "thinks" is reached through this interface; in Phase 1 it is
 * satisfied in-process by StubBrain, later by ClaudeBrain / LocalBrain over a boundary.
 */

/** A tool the brain wants to dispatch. No tools exist in Phase 1 → usually absent. */
export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
  /**
   * Provenance taint of the INSTRUCTION that produced this action (SAFE-04 ii, Phase 5).
   * Stamped at the brain-decision site: `user`/`self` for a trusted intent, `external` when the
   * driving context traced to a `source:external` item. The gate HARD-BLOCKS `tier==='red' &&
   * origin==='external'` ABOVE /override and the breaker. ADDITIVE + optional — when absent, a Red
   * action is treated as suspect (default-deny posture) and still gated by the breaker; the
   * external block fires ONLY on an explicit `origin==='external'`.
   */
  origin?: Provenance;
}

/**
 * Per-pass usage/telemetry a brain MAY attach (set programmatically by the brain, NOT parsed from
 * the model's JSON). LocalBrain fills it from Ollama's response counters; the IPC server turns it
 * into a `stats` frame so a client can show tokens/sec, context use, latency, and cost. All
 * optional + additive — a brain that doesn't measure simply omits it.
 */
export interface BrainUsage {
  /** The model that produced the reply (e.g. the Ollama tag or the Claude model id). */
  model?: string;
  /** Input/prompt tokens the model evaluated. */
  promptTokens?: number;
  /** Prompt-eval (prefill) duration (ms) — the basis for the prompt-processing progress estimate. */
  promptEvalMs?: number;
  /** Output/generated tokens. */
  outputTokens?: number;
  /** Generation duration (ms) — the basis for tokens/sec (outputTokens / evalMs). */
  evalMs?: number;
  /** Model load duration (ms) — non-zero when the model was (re)loaded into memory this turn. */
  loadMs?: number;
  /** End-to-end duration (ms) the brain measured for the pass. */
  totalMs?: number;
  /** The model's configured context window (tokens) for this pass, when known. */
  contextWindow?: number;
}

/**
 * One prior conversation turn replayed to the model so it remembers the dialogue across consecutive
 * utterances (the short-term memory that was missing — every turn used to be a stateless single-shot).
 * Only `source:'user'` exchanges ever become turns (provenance discipline: external/tool content is
 * DATA in the injected context, never a conversational turn).
 */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** A background tool-use event a brain MAY report as its tool loop runs, so a client can show what
 *  KERNEL is doing live (the daemon turns it into a `tool.activity` frame). `detail` is a short,
 *  non-sensitive label (a query or op), NEVER raw results. */
export interface ToolActivityEvent {
  tool: string;
  op: string;
  status: 'start' | 'ok' | 'error';
  detail?: string;
}

/** The structured output of a single reasoning pass. */
export interface Decision {
  /** The brain's reasoning (logged, not spoken). */
  thought: string;
  /** A tool to dispatch (Phase 2+). Absent in Phase 1 — no tools exist. */
  action?: ToolCall;
  /** Text to surface to Pravin. */
  reply?: string;
  /** Optional per-pass telemetry (tokens, timing, model). Set by the brain, surfaced as `stats`. */
  usage?: BrainUsage;
}

/**
 * Structured context available to the brain. The assembled-string `context`
 * argument of `reason()` is the spec-literal signature; this structured form is
 * available for future dual-LLM splitting and lets a privileged brain see
 * provenance and treat `external` items as data, not instruction.
 */
export interface BrainContext {
  /** IDENTITY.md — always present, never truncated. */
  identity: string;
  /** working-memory/current.md — the rolling scratchpad. */
  current: string;
  /** Reranked retrieved items, each carrying a `source` provenance tag. */
  retrieved: ContextItem[];
}

/**
 * The brain interface. Spec-literal signature: reason(prompt, context: string).
 *
 * `onToken` (ADDITIVE, optional) lets a streaming brain surface output incrementally as it
 * generates — the loop forwards each chunk to the client so the reply renders + speaks in real
 * time instead of appearing all at once. Implementations that don't stream simply ignore it (a
 * 2-arg `reason` still satisfies this interface), and a caller that doesn't care about streaming
 * omits it.
 *
 * `history` (ADDITIVE, optional) is the rolling conversation buffer — the recent prior turns the
 * brain replays so it can follow up across consecutive prompts ("now make it about mountains"). The
 * assembled `context` (IDENTITY + memory) stays the SYSTEM message; `history` is the dialogue turns
 * that precede the current `prompt`. A brain that ignores it (or a 2/3-arg caller) still conforms.
 *
 * `onToolActivity` (ADDITIVE, optional) lets a tool-using brain report each background tool call as
 * it happens (start/ok/error) so the loop can surface it to the client. Brains that don't use tools
 * (or callers that don't care) omit it.
 *
 * `onThinking` (ADDITIVE, optional) streams the model's REASONING (chain-of-thought) as it forms,
 * separately from the spoken `onToken` answer. A deliberate local pass (Ollama `think:true`) emits a
 * `message.thinking` channel that would otherwise be discarded; surfacing it lets the Face show "what
 * KERNEL is thinking" live. `final:true` marks the reasoning complete (the answer is about to begin).
 * QUICK passes never think, so this simply never fires — the owner sees thoughts only when the model
 * actually reasons. Brains that don't reason aloud (or callers that don't care) omit it.
 */
export interface BrainProvider {
  reason(
    prompt: string,
    context: string,
    onToken?: (chunk: string) => void,
    history?: ChatTurn[],
    onToolActivity?: (event: ToolActivityEvent) => void,
    onThinking?: (chunk: string, final: boolean) => void,
  ): Promise<Decision>;
}

/**
 * Runtime validation of any brain's JSON output — enforced from day one so that
 * even the stub's Decision is checked against the contract (zod).
 */
export const ToolCallSchema = z.object({
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  // Phase 5 ADDITIVE: optional provenance taint, validated when present (SAFE-04 ii).
  origin: z.enum(['user', 'self', 'external']).optional(),
});

export const DecisionSchema = z.object({
  thought: z.string(),
  action: ToolCallSchema.optional(),
  reply: z.string().optional(),
});
