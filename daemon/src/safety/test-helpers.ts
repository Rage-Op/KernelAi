/**
 * safety/test-helpers.ts — the shared Wave-0 safety test harness (RESEARCH Validation Wave-0).
 *
 * EVERY safety test imports these so NO test ever performs a real irreversible action: there is
 * NO real timer (a virtual clock advances on demand), NO real tool executor (a recording mock),
 * NO real spend (an in-memory ledger), NO real audit file (a capturing sink), and a controllable
 * cancel signal. The breaker/ledger/override logic is pure — every side-effecting dependency is
 * injected from here.
 *
 * Lives under src/ (not test/) so both src-tests and test/-tests can import it without crossing
 * the build rootDir; it is test-only and never imported by production code (mirrors
 * safety/leak-test-helpers.ts).
 */
import type { ToolCall } from '../brain/BrainProvider.js';
import type { ToolResult } from '../tools/Tool.js';
import type { SpendLedger, ReserveResult } from './spend-ledger.js';
import type { AuditEntry } from './audit.js';

/**
 * The injectable clock contract the breaker depends on (re-declared here, not imported, so the
 * Wave-0 harness in Task 1 compiles before breaker.ts exists in Task 2). breaker.ts re-exports the
 * SAME shape as `Clock`; `fakeClock()` satisfies both structurally.
 */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/**
 * A fully virtual clock. `now()` reads VIRTUAL time (ms); `sleep(ms)` resolves immediately on the
 * microtask queue but ADVANCES the virtual clock by `ms` — so the breaker's `while (now < deadline)`
 * loop terminates without any real wall-clock wait. `advance(ms)` lets a test jump the clock
 * (e.g. to fire an override expiry) without sleeping.
 */
export function fakeClock(start = 0): Clock & { advance(ms: number): void } {
  let t = start;
  return {
    now(): number {
      return t;
    },
    async sleep(ms: number): Promise<void> {
      t += ms;
      // yield to the microtask queue so awaiting callers interleave deterministically.
      await Promise.resolve();
    },
    advance(ms: number): void {
      t += ms;
    },
  };
}

/**
 * A recording mock executor. `execute` records every ToolCall it is asked to run and returns a
 * benign success result — it NEVER performs a real action. Tests assert `calls.length` is exactly
 * 1 on the proceed path and 0 on every abort path (cancel/ceiling/TOCTOU).
 */
export function recordingExecutor(): {
  execute: (call: ToolCall) => Promise<ToolResult>;
  calls: ToolCall[];
} {
  const calls: ToolCall[] = [];
  return {
    calls,
    async execute(call: ToolCall): Promise<ToolResult> {
      calls.push(call);
      return { ok: true, data: { executed: call.tool } };
    },
  };
}

/**
 * A controllable cancel signal. `cancelled()` returns the current state; `trigger()` flips it on
 * (simulating the owner pressing cancel during the 10s window — the IPC breaker.cancel frame).
 */
export function controllableCancel(): { cancelled: () => boolean; trigger: () => void } {
  let flag = false;
  return {
    cancelled: () => flag,
    trigger: () => {
      flag = true;
    },
  };
}

/**
 * An in-memory SpendLedger for tests. Same atomic single-writer semantics as the real ledger
 * (one synchronous critical section, no check-then-act gap) but backed by a plain number — no fs,
 * no real money. Stores ONLY a running total + ceiling (no finance PII).
 */
export function memoryLedger(ceiling: number): SpendLedger & { total(): number } {
  let totalReserved = 0;
  return {
    checkAndReserve(amount: number): ReserveResult {
      // ONE synchronous critical section — check + reserve with no await in between.
      if (totalReserved + amount > ceiling) {
        return { ok: false, ceiling, totalReserved };
      }
      totalReserved += amount;
      return { ok: true, reserved: amount, ceiling, totalReserved };
    },
    release(reserve: ReserveResult): void {
      if (reserve.ok && typeof reserve.reserved === 'number') {
        totalReserved -= reserve.reserved;
      }
    },
    dayReset(): void {
      totalReserved = 0;
    },
    total: () => totalReserved,
  };
}

/**
 * A capturing audit sink. `audit(entry)` appends to `entries` so a test can assert the exact
 * outcome sequence ('executed' / 'cancelled' / 'ceiling-exceeded' / 'toctou-abort' / 'denied')
 * and that a content hash was recorded on the executed path. NEVER writes a file.
 */
export function captureAudit(): { audit: (entry: AuditEntry) => void; entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    audit(entry: AuditEntry): void {
      entries.push(entry);
    },
  };
}
