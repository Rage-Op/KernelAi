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
 * PHASE 5: the gate now emits `{ kind:'gated' }` for a flag-enabled Red action, and this file
 * routes that arm to `breaker.run(call, breakerDeps)` — inserted BETWEEN the deny check and the
 * safeParse/execute block so a gated call NEVER falls through to execute. `breakerDeps` is injected
 * via `setBreakerDeps` (tests pass mocks; production uses the real wiring built lazily below).
 * `allow` still safeParses → executes; `deny` still escalates. The dispatch ORDER is unchanged.
 */
import { authorize } from '../safety/gate.js';
import type { ToolCall } from '../brain/BrainProvider.js';
import type { Tool, ToolResult } from './Tool.js';
import { run as runBreaker, canonical, type BreakerDeps } from '../safety/breaker.js';
import { createSpendLedger, defaultLedgerPath } from '../safety/spend-ledger.js';
import { appendAudit, defaultAuditPath, type AuditEntry } from '../safety/audit.js';

/** name → Tool. Module-level by design (one daemon, one registry). */
const registry = new Map<string, Tool>();

/**
 * The breaker dependencies the `gated` arm runs with. Injectable so tests pass mocks (recording
 * executor, fake clock, in-memory ledger, capture audit, controllable cancel). When unset,
 * `defaultBreakerDeps(tool)` builds the REAL wiring lazily (real clock, the real tool's execute,
 * the file-backed ledger at self/spend-ledger.json, the append-only audit at self/audit-log).
 */
let injectedBreakerDeps: BreakerDeps | null = null;

/** Test seam: inject mock breaker deps (and restore with `setBreakerDeps(null)` afterward). */
export function setBreakerDeps(deps: BreakerDeps | null): void {
  injectedBreakerDeps = deps;
}

/** Module-scoped cancel signal the IPC `breaker.cancel` frame flips (real wiring). */
let breakerCancelled = false;
/** Called by the IPC handler when a `breaker.cancel` frame arrives. */
export function signalBreakerCancel(): void {
  breakerCancelled = true;
}
/** Reset the cancel latch before a new gated run (real wiring). */
export function resetBreakerCancel(): void {
  breakerCancelled = false;
}

/** Build the REAL breaker deps for a tool (lazy; uses config at call time, never at import). */
async function defaultBreakerDeps(tool: Tool): Promise<BreakerDeps> {
  const { config } = await import('../config.js');
  const ledger = createSpendLedger({
    now: () => Date.now(),
    filePath: defaultLedgerPath(config.memoryDir),
    // The owner-set daily ceiling. Conservative default; surfaced for owner config in a later plan.
    ceiling: Number(process.env.KERNEL_DAILY_SPEND_CEILING ?? 0),
  });
  resetBreakerCancel();
  return {
    clock: { now: () => Date.now(), sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)) },
    cancelled: () => breakerCancelled,
    emitPreview: () => {
      /* the IPC server pushes a breaker.preview frame; wired at the server in a later plan. */
    },
    ledger,
    audit: (entry: AuditEntry) => appendAudit(entry, defaultAuditPath(config.memoryDir)),
    execute: (call: ToolCall) => {
      const parsed = tool.schema.safeParse(call.args);
      const args = parsed.success ? ((parsed.data as Record<string, unknown>) ?? call.args) : call.args;
      return tool.execute(args);
    },
    // TOCTOU: re-read whatever world state matters for the tool. Default is the canonical call
    // shape (a stable hash for ops whose state is the call itself); a tool may surface more later.
    reReadState: async (call: ToolCall) => canonical(call),
  };
}

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

  // 5. PHASE 5 — a GATED (Red) verdict runs the live breaker INSTEAD of falling through to
  //    execute. Inserted between the deny check and the safeParse/execute block so a gated call
  //    NEVER reaches the plain execute path. The breaker itself safeParses inside its `execute`
  //    dep (real wiring) and gates dry-run → 10s cancel → ceiling → audit → TOCTOU → execute.
  if (verdict.kind === 'gated') {
    const breakerDeps = injectedBreakerDeps ?? (await defaultBreakerDeps(tool));
    return runBreaker(call, breakerDeps);
  }

  // 6. ASVS V5 — validate args against the tool's zod schema before execute (allow path only).
  const parsed = tool.schema.safeParse(call.args);
  if (!parsed.success) {
    return { ok: false, escalation: { reason: `invalid tool args: ${parsed.error.message}` } };
  }

  // 7. allow reaches execute with validated args.
  return tool.execute((parsed.data as Record<string, unknown>) ?? call.args);
}
