/**
 * safety/breaker.ts — the Red-tier circuit breaker as a PURE, injectable state machine
 * (SAFE-03, RESEARCH Pattern 1).
 *
 * This is the kernel chokepoint for every Red action: dry-run preview → 10s cancel window →
 * atomic spend-ceiling check → audit → TOCTOU re-verify → execute. EVERY side-effecting
 * dependency is injected (clock, cancel signal, preview emitter, ledger, audit sink, the real
 * executor, the state re-reader), so 100% of the logic is unit-testable with a fake clock and a
 * recording mock executor — NO real timer, NO real `rm`, NO real spend in the logic itself.
 *
 * Order is load-bearing and matches spec §8:
 *   1. dryRun(call)            — describe the action; NO side effects. Capture a state hash.
 *   2. hashAtPreview           — sha256(canonical(call) + preview.stateHash) via node:crypto.
 *   3. emitPreview(preview)    — surface the high-context preview to the Face (breaker.preview).
 *   4. 10s cancel window       — poll deps.cancelled() every 100ms on the injected clock.
 *                                a cancel → audit 'cancelled' + return; executor NEVER called.
 *   5. checkAndReserve(spend)  — atomic single-writer ledger. !ok → audit 'ceiling-exceeded' +
 *                                escalate; executor NEVER called.
 *   6. TOCTOU re-verify        — hashNow = sha256(canonical(call) + reReadState(call)).
 *                                mismatch → release reserve + audit 'toctou-abort' + escalate;
 *                                executor NEVER called.
 *   7. audit 'executed' + hash, then return deps.execute(call).
 *
 * LOCKED DECISION (Open Q1): on cancel-window TIMEOUT (owner did nothing for 10s) the action
 * PROCEEDS — but ONLY after the ceiling check passes and the action is audit-logged. The window
 * exists for the owner to CANCEL a Red action KERNEL itself proposed; absent a cancel it proceeds.
 */
import { createHash } from 'node:crypto';

import type { ToolCall } from '../brain/BrainProvider.js';
import type { ToolResult } from '../tools/Tool.js';
import type { SpendLedger } from './spend-ledger.js';
import type { AuditEntry } from './audit.js';

/** The injectable clock — a fake one in tests advances virtually, never a real timer. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** The high-context dry-run preview surfaced to the owner (NO side effects produced it). */
export interface DryRunPreview {
  /** Human-readable summary: what, how much, to whom, why. */
  summary: string;
  /** The tool name the action would run. */
  tool: string;
  /** Estimated spend (0 for non-financial ops). Surfaced to the Face; NEVER audit-logged (V7). */
  estimatedSpend: number;
  /**
   * A hash of the pre-action world state. Re-read + re-hashed at execute time for the TOCTOU
   * check; a mismatch means the previewed action ≠ what would now run → abort.
   */
  stateHash: string;
}

/** Every side-effecting dependency the breaker needs — the ONLY impure surface. */
export interface BreakerDeps {
  /** Virtual clock for the 10s window (fake in tests). */
  clock: Clock;
  /** Owner cancel signal (the IPC breaker.cancel frame; controllable in tests). */
  cancelled: () => boolean;
  /** Surface the preview to the Face (the breaker.preview frame; captured in tests). */
  emitPreview: (preview: DryRunPreview) => void;
  /** Atomic single-writer spend ledger. */
  ledger: SpendLedger;
  /** Append-only audit sink (captured in tests). */
  audit: (entry: AuditEntry) => void;
  /** The real tool executor (a recording mock in tests). */
  execute: (call: ToolCall) => Promise<ToolResult>;
  /** Re-read the world state NOW (for the TOCTOU hash). Returns a string the breaker hashes. */
  reReadState: (call: ToolCall) => Promise<string>;
  /** Override the 10s window length (tests use a small value via the fake clock; default 10_000). */
  windowMs?: number;
}

/** The cancel-window length per spec §8. */
const DEFAULT_WINDOW_MS = 10_000;
/** Poll cadence inside the window. */
const POLL_MS = 100;

/**
 * Canonical serialisation of a ToolCall — stable key order so the hash is deterministic regardless
 * of property insertion order. Used for the preview hash AND the TOCTOU re-verify hash.
 */
export function canonical(call: ToolCall): string {
  const args = call.args ?? {};
  const sortedArgs: Record<string, unknown> = {};
  for (const key of Object.keys(args).sort()) {
    sortedArgs[key] = args[key];
  }
  return JSON.stringify({ tool: call.tool, args: sortedArgs });
}

/** SHA-256 hex digest (node:crypto only — never a hand-rolled hash; ASVS V6). */
function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Estimate the spend a Red action would incur, derived from `call.args`. Non-financial ops
 * (delete/rm/permission changes) return 0 — they consume no spend budget but still gate. A
 * financial op (purchase/transfer/pay) reads a numeric `amount`/`price`/`total` from args.
 */
export function estimatedSpend(call: ToolCall): number {
  const args = call.args ?? {};
  for (const key of ['amount', 'price', 'total', 'cost']) {
    const v = args[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  }
  return 0;
}

/**
 * A dry-run preview: describe the action; produce NO side effects. `stateAtPreview` is the live
 * world-state string read (via deps.reReadState) at preview time — captured here so the TOCTOU
 * re-read at execute time compares the SAME source and a mismatch means the world changed.
 */
function dryRun(call: ToolCall, stateAtPreview: string): DryRunPreview {
  const spend = estimatedSpend(call);
  const op = typeof call.args?.op === 'string' ? call.args.op : call.tool;
  const summary =
    `Red action: ${call.tool} (${op})` +
    (spend > 0 ? ` — estimated spend ${spend}` : '') +
    ` — 10s to cancel.`;
  return { summary, tool: call.tool, estimatedSpend: spend, stateHash: stateAtPreview };
}

/** Build the cancelled-outcome ToolResult (executor never ran). */
function cancelledResult(): ToolResult {
  return {
    ok: false,
    escalation: {
      reason: 'Red action cancelled by Pravin within the 10s window.',
      recommendation: 'Re-issue the action if it was cancelled in error.',
    },
  };
}

/** Build the ceiling-exceeded escalation (executor never ran; reserve never taken). */
function escalateCeiling(ceiling: number): ToolResult {
  return {
    ok: false,
    escalation: {
      reason: `Red action would cross the daily spend ceiling (${ceiling}) — escalated, not executed.`,
      recommendation: 'Pravin raises the ceiling or initiates this spend directly.',
    },
  };
}

/** Build the TOCTOU-abort escalation (state changed between preview and execute). */
function escalateChanged(): ToolResult {
  return {
    ok: false,
    escalation: {
      reason: 'World state changed between the preview and execution — aborted to avoid acting on stale state (TOCTOU).',
      recommendation: 'Re-evaluate and re-issue the action against the current state.',
    },
  };
}

/**
 * Run the Red breaker flow for a single gated ToolCall. Returns the executor's result on the
 * proceed path, or a structured escalation on cancel / ceiling / TOCTOU. The executor is called
 * AT MOST ONCE and ONLY on the proceed path.
 */
export async function run(call: ToolCall, deps: BreakerDeps): Promise<ToolResult> {
  // 1. read the live world state at preview time (no side effects), build the dry-run preview, and
  //    capture the preview-time content hash over canonical(call) + that state.
  const stateAtPreview = await deps.reReadState(call);
  const preview = dryRun(call, stateAtPreview);
  const hashAtPreview = sha256(canonical(call) + preview.stateHash);

  // 2. surface the high-context preview to the owner.
  deps.emitPreview(preview);

  // 3. the 10s cancel window — poll on the injected clock. A cancel aborts WITHOUT executing.
  const windowMs = deps.windowMs ?? DEFAULT_WINDOW_MS;
  const deadline = deps.clock.now() + windowMs;
  while (deps.clock.now() < deadline) {
    if (deps.cancelled()) {
      deps.audit({ call: { tool: call.tool, args: call.args }, outcome: 'cancelled', ts: nowIso(deps) });
      return cancelledResult();
    }
    await deps.clock.sleep(POLL_MS);
  }
  // one final cancel check at the boundary (a cancel that arrived on the last tick still counts).
  if (deps.cancelled()) {
    deps.audit({ call: { tool: call.tool, args: call.args }, outcome: 'cancelled', ts: nowIso(deps) });
    return cancelledResult();
  }

  // 4. atomic spend-ceiling check + reserve (ONE critical section in the ledger). !ok → escalate.
  const reserve = deps.ledger.checkAndReserve(estimatedSpend(call));
  if (!reserve.ok) {
    deps.audit({ call: { tool: call.tool, args: call.args }, outcome: 'ceiling-exceeded', ts: nowIso(deps) });
    return escalateCeiling(reserve.ceiling);
  }

  // 5. TOCTOU re-verify — re-read the world state, re-hash, abort on mismatch (release the reserve).
  const hashNow = sha256(canonical(call) + (await deps.reReadState(call)));
  if (hashNow !== hashAtPreview) {
    deps.ledger.release(reserve);
    deps.audit({ call: { tool: call.tool, args: call.args }, outcome: 'toctou-abort', ts: nowIso(deps) });
    return escalateChanged();
  }

  // 6. audit 'executed' with the verified hash, then run the real action (the ONLY execute path).
  deps.audit({ call: { tool: call.tool, args: call.args }, outcome: 'executed', hash: hashNow, ts: nowIso(deps) });
  return deps.execute(call);
}

/** ISO timestamp derived from the injected clock (deterministic in tests). */
function nowIso(deps: BreakerDeps): string {
  return new Date(deps.clock.now()).toISOString();
}
