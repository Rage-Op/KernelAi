/**
 * The tool registry contract (RESEARCH.md Pattern 1).
 *
 * A `Tool` is a self-contained capability: a stable `name` the brain references in
 * `ToolCall.tool`, a zod `schema` validating `ToolCall.args` (ASVS V5 — never trust the
 * brain's output shape), and an async `execute`.
 *
 * ANTI-BYPASS CONTRACT (HANDS-05, RESEARCH.md Anti-Pattern 2): `execute` is NEVER called
 * by anyone but `registry.dispatch`, and only AFTER `gate.authorize` has cleared the call.
 * No tool self-classifies its tier; no path reaches a tool except through the single
 * `dispatch` chokepoint. Importing a tool's `execute` anywhere outside `registry.ts`
 * violates this contract.
 */
import type { ZodType } from 'zod';
import type { ToolCall } from '../brain/BrainProvider.js';

/** Re-export so consumers can type a dispatch call without reaching into brain/. */
export type { ToolCall };

/**
 * The structured result of a tool run. `ok:false` carries a structured `escalation`
 * (permission missing, credential fence, unknown tool, invalid args) the loop surfaces
 * back to the originator — tools never throw across the dispatch boundary.
 */
export interface ToolResult {
  ok: boolean;
  /** Structured output for the loop/log (scraped data, capture path, etc.). */
  data?: unknown;
  /** Set when ok=false: a structured escalation (e.g. permission missing, credential fence). */
  escalation?: { reason: string; recommendation?: string };
}

export interface Tool {
  /** Stable name the brain references in ToolCall.tool. */
  name: string;
  /** zod schema validating ToolCall.args before execute (ASVS V5; focus requirement). */
  schema: ZodType;
  /**
   * OPTIONAL pre-authorize hook (HANDS-05). Runs INSIDE `registry.dispatch` BEFORE `gate.authorize`
   * so a tool can surface LIVE read-site signals the gate's credential fence needs to classify —
   * e.g. the browser tool reads the target field's DOM `type`/`autocomplete`/label and mutates
   * `call.args` so a `type="password"` field is DENIED before `.fill()` ever types. This does NOT
   * bypass the chokepoint: it is a data-surfacing step that runs within dispatch, before the gate,
   * and never executes the action. Tools whose signals already live on `args` (e.g. Peekaboo, whose
   * AX signals are surfaced by the caller) omit this hook.
   */
  surfaceSignals?(args: Record<string, unknown>): Promise<void>;
  /** Run the action. NEVER called by anyone but registry.dispatch (after the gate). */
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}
