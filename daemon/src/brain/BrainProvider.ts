import { z } from 'zod';
import type { ContextItem } from '../memory/types.js';

/**
 * The brain swap-seam (spec §6). Built FIRST, before any implementation (BRAIN-01).
 * Anything that "thinks" is reached through this interface; in Phase 1 it is
 * satisfied in-process by StubBrain, later by ClaudeBrain / LocalBrain over a boundary.
 */

/** A tool the brain wants to dispatch. No tools exist in Phase 1 → usually absent. */
export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

/** The structured output of a single reasoning pass. */
export interface Decision {
  /** The brain's reasoning (logged, not spoken). */
  thought: string;
  /** A tool to dispatch (Phase 2+). Absent in Phase 1 — no tools exist. */
  action?: ToolCall;
  /** Text to surface to Pravin. */
  reply?: string;
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
 */
export interface BrainProvider {
  reason(prompt: string, context: string): Promise<Decision>;
}

/**
 * Runtime validation of any brain's JSON output — enforced from day one so that
 * even the stub's Decision is checked against the contract (zod).
 */
export const ToolCallSchema = z.object({
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
});

export const DecisionSchema = z.object({
  thought: z.string(),
  action: ToolCallSchema.optional(),
  reply: z.string().optional(),
});
