/**
 * The tool router (HANDS-04) and the SINGLE dispatch chokepoint (HANDS-05).
 *
 * A module-level `Map<string, Tool>` holds registered tools. `dispatch(call)` is the ONLY
 * public path to a tool's `execute`, and its order is FIXED and load-bearing:
 *
 *   1. look up the tool by name        → unknown tool ⇒ DEFAULT-DENY (structured escalation, never throw)
 *   2. await tool.surfaceSignals(args) → OPTIONAL read-site signal surfacing for the fence (HANDS-05),
 *                                        BEFORE the gate, never executes the action (e.g. the browser
 *                                        tool reads the target field's DOM type/autocomplete/label so a
 *                                        type=password field is denied before any keystroke)
 *   3. await authorize(call)           → THE single safety chokepoint, BEFORE anything touches the tool
 *   4. verdict.kind === 'deny'         → return the escalation; execute is NEVER reached
 *   5. safeParse(call.args, schema)    → ASVS V5: never trust the brain's arg shape; invalid ⇒ escalation
 *   6. tool.execute(parsed args)       → only allow/gated reach here
 *
 * P2 note: both `allow` and `gated` proceed to execute. Per the LOCKED DECISION (research
 * Open Question 1) the gate emits `deny` (not `gated`) for Red in Phase 2, so in PRACTICE
 * only `allow` reaches execute this phase. The `gated` branch is kept so Phase 5 enables
 * the breaker INSIDE `gate.authorize` without touching this file, the tools, or the loop.
 */
import { authorize } from '../safety/gate.js';
import type { ToolCall } from '../brain/BrainProvider.js';
import type { Tool, ToolResult } from './Tool.js';

/** name → Tool. Module-level by design (one daemon, one registry). */
const registry = new Map<string, Tool>();

/** Register (or replace) a tool by its `name`. The brain references it via ToolCall.tool. */
export function register(tool: Tool): void {
  registry.set(tool.name, tool);
}

/** Test-only: reset the registry to an empty map so tests start from a known state. */
export function clearRegistry(): void {
  registry.clear();
}

/**
 * The ONLY public entry to a tool. Runs `gate.authorize` first, always.
 * Never throws across this boundary — every failure returns a structured escalation.
 */
export async function dispatch(call: ToolCall): Promise<ToolResult> {
  // 1. look up the tool — default-deny an unknown name (never throw, never execute).
  const tool = registry.get(call.tool);
  if (!tool) {
    return { ok: false, escalation: { reason: `unknown tool: ${call.tool}` } };
  }

  // 2. OPTIONAL read-site signal surfacing (HANDS-05) — BEFORE the gate, never executes the
  //    action. Lets a tool populate the credential-fence signals from the live read site (e.g.
  //    the browser tool reads the target field's DOM type/autocomplete/label) so the gate
  //    classifies the live truth. A failure here must never crash dispatch — the gate still runs.
  if (tool.surfaceSignals) {
    try {
      await tool.surfaceSignals(call.args);
    } catch {
      /* best-effort: the gate authorizes on whatever signals are present. */
    }
  }

  // 3. THE single chokepoint — before anything else touches the tool.
  const verdict = await authorize(call);

  // 4. a deny short-circuits dispatch: execute is never reached.
  if (verdict.kind === 'deny') {
    return { ok: false, escalation: verdict.escalation };
  }

  // 5. ASVS V5 — validate args against the tool's zod schema before execute.
  const parsed = tool.schema.safeParse(call.args);
  if (!parsed.success) {
    return { ok: false, escalation: { reason: `invalid tool args: ${parsed.error.message}` } };
  }

  // 6. allow (and, in P5, gated) reach execute with validated args.
  return tool.execute((parsed.data as Record<string, unknown>) ?? call.args);
}
