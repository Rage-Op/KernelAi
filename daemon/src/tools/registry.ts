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
import { run as runBreaker, canonical, type BreakerDeps, type DryRunPreview } from '../safety/breaker.js';
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
/**
 * The id of the breaker.preview currently surfaced to the Face (the in-flight gated run). The
 * IPC server stamps a fresh id per preview and hands it back here via `setActivePreviewId`; an
 * arriving breaker.cancel frame is only honoured when its `id` matches this active preview, so a
 * stale/duplicate cancel for a prior action cannot abort a different in-flight run.
 */
let activePreviewId: string | null = null;

/**
 * The server-injected push that surfaces the breaker dry-run preview to every connected Face
 * (SAFE-03). Returns the correlation id the matching breaker.cancel frame uses. Null until the
 * IPC server wires it via `setBreakerBroadcast`; when null (or no Face connected) the preview is
 * simply not surfaced and the action stays gated by ceiling+audit (a live cancel is not possible).
 */
let breakerBroadcast: ((preview: DryRunPreview) => string) | null = null;

/** The IPC server injects its broadcast here at startup (avoids a server↔registry import cycle). */
export function setBreakerBroadcast(fn: ((preview: DryRunPreview) => string) | null): void {
  breakerBroadcast = fn;
}

/**
 * Called by the IPC handler when a `breaker.cancel` frame arrives. Only flips the latch when the
 * frame's `id` matches the active preview (or when no id discipline is in force — id omitted).
 */
export function signalBreakerCancel(id?: string): void {
  if (id !== undefined && activePreviewId !== null && id !== activePreviewId) return;
  breakerCancelled = true;
}
/** Reset the cancel latch + active preview before a new gated run (real wiring). */
export function resetBreakerCancel(): void {
  breakerCancelled = false;
  activePreviewId = null;
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
    emitPreview: (preview: DryRunPreview) => {
      // SAFE-03: broadcast the dry-run preview to every connected Face over the live IPC server.
      // The server stamps a correlation id and returns it; we stash it so the matching
      // breaker.cancel frame (carrying the same id) is the one that flips the cancel latch. If the
      // server is not wired (e.g. a --backup short-lived job) or NO Face is connected, the preview
      // simply isn't surfaced: the action stays gated by the ceiling + audit, but a live owner
      // cancel is not possible — per the locked SAFE-03 decision the window then PROCEEDS.
      activePreviewId = breakerBroadcast ? breakerBroadcast(preview) : null;
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
    // The cancel window length. Spec §8 = 10s; owner/test-overridable via env. The window exists
    // for the owner to CANCEL via the Face's breaker.cancel frame; absent a cancel it proceeds.
    windowMs: Number(process.env.KERNEL_BREAKER_WINDOW_MS ?? 10_000),
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

/** The registered tool names (sorted), for the `capabilities` introspection frame. Read-only. */
export function listTools(): string[] {
  return [...registry.keys()].sort();
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
    const result = await runBreaker(call, breakerDeps);
    // SAFE-06: mark a non-success breaker outcome as a Red gate so the obstacle ladder SKIPS its
    // retry rungs (a Red gate belongs to the breaker/Pravin, never the retry loop). A successful
    // breaker proceed (executor ran) is NOT marked — it is a normal success.
    return result.ok ? result : { ...result, gated: true };
  }

  // 6. ASVS V5 — validate args against the tool's zod schema before execute (allow path only).
  const parsed = tool.schema.safeParse(call.args);
  if (!parsed.success) {
    return { ok: false, escalation: { reason: `invalid tool args: ${parsed.error.message}` } };
  }

  // 7. allow reaches execute with validated args.
  return tool.execute((parsed.data as Record<string, unknown>) ?? call.args);
}
