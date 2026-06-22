/**
 * safety/spend-ledger.ts — the atomic single-writer daily spend ledger (SAFE-04 iii, Pitfall 2).
 *
 * The daily-spend hard rule: when a Red action's estimated spend would cross the owner-set ceiling,
 * the breaker MUST escalate rather than proceed. The dangerous bug is a TOCTOU race on the counter
 * (two near-simultaneous reserves each pass the "under ceiling" check before either debits). The
 * fix is `checkAndReserve` as ONE synchronous critical section — check + reserve with NO await in
 * between — so the second reserve sees the first's effect and is rejected.
 *
 * Persistence: `self/spend-ledger.json`, single-writer (the daemon serialises its drain — one
 * intent at a time — so an in-process synchronous section is race-free per RESEARCH Don't-Hand-Roll).
 * The store holds ONLY `{ date, totalReserved, ceiling }` — NO transaction detail, NO memos, NO
 * finance PII (locked decision / Open Q2). `totalReserved` resets to 0 when the injected clock
 * crosses the local-day boundary. The clock/path are injectable so tests never use a real Date or
 * a real file.
 */
import fs from 'node:fs';
import path from 'node:path';

/** The persisted ledger shape. NO finance PII — only the running total, the ceiling, and the date. */
export interface LedgerState {
  /** Local-day key (YYYY-MM-DD) the running total belongs to. */
  date: string;
  /** The amount reserved so far today (a single number — never per-transaction detail). */
  totalReserved: number;
  /** The owner-set daily ceiling. */
  ceiling: number;
}

/** The result of an atomic check+reserve. `ok:false` means the reserve would cross the ceiling. */
export interface ReserveResult {
  ok: boolean;
  /** The amount actually reserved (present only when ok). */
  reserved?: number;
  /** The ceiling that was checked against (for the escalation message). */
  ceiling: number;
  /** The running total AFTER this operation (so the breaker can report it). */
  totalReserved: number;
}

/** The ledger capability the breaker depends on. */
export interface SpendLedger {
  /**
   * Atomically check the running total against the ceiling and, if it fits, reserve `amount`.
   * ONE synchronous critical section: there is NO await between the check and the reserve, so two
   * near-simultaneous reserves CANNOT both pass.
   */
  checkAndReserve(amount: number): ReserveResult;
  /** Release a prior reserve (used on cancel / ceiling-after / TOCTOU-abort). */
  release(reserve: ReserveResult): void;
  /** Reset the running total at the local-day boundary (driven by the injected clock). */
  dayReset(now: number): void;
}

/** Injectable dependencies — a clock (for the day boundary) and the JSON file path. */
export interface SpendLedgerDeps {
  /** Returns the current time in ms (injected; tests use the fake clock). */
  now(): number;
  /** Absolute path of the JSON store (injected; tests use a tmpdir). */
  filePath: string;
  /** The owner-set daily ceiling. */
  ceiling: number;
}

/** Local-day key (YYYY-MM-DD) for a ms timestamp — the day-boundary reset key. */
function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Default ledger location under a memory dir. */
export function defaultLedgerPath(memoryDir: string): string {
  return path.join(memoryDir, 'self', 'spend-ledger.json');
}

/**
 * Create a file-backed atomic single-writer spend ledger. Loads the existing JSON state if present
 * (and same-day), else starts at 0 for the current day. Every mutation persists synchronously.
 */
export function createSpendLedger(deps: SpendLedgerDeps): SpendLedger {
  const today = dayKey(deps.now());

  let state: LedgerState = load();

  // If the persisted state belongs to a previous day, reset the running total for today.
  if (state.date !== today) {
    state = { date: today, totalReserved: 0, ceiling: deps.ceiling };
    persist();
  } else if (state.ceiling !== deps.ceiling) {
    // honour an updated ceiling without losing today's running total.
    state = { ...state, ceiling: deps.ceiling };
    persist();
  }

  function load(): LedgerState {
    try {
      const raw = fs.readFileSync(deps.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<LedgerState>;
      if (
        typeof parsed.date === 'string' &&
        typeof parsed.totalReserved === 'number' &&
        typeof parsed.ceiling === 'number'
      ) {
        return { date: parsed.date, totalReserved: parsed.totalReserved, ceiling: parsed.ceiling };
      }
    } catch {
      /* missing/corrupt → start fresh for today (fail-safe, never throws). */
    }
    return { date: today, totalReserved: 0, ceiling: deps.ceiling };
  }

  function persist(): void {
    fs.mkdirSync(path.dirname(deps.filePath), { recursive: true });
    // Persist ONLY the no-PII shape — date, total, ceiling. Never any transaction detail.
    const out: LedgerState = {
      date: state.date,
      totalReserved: state.totalReserved,
      ceiling: state.ceiling,
    };
    fs.writeFileSync(deps.filePath, JSON.stringify(out) + '\n', 'utf8');
  }

  return {
    checkAndReserve(amount: number): ReserveResult {
      // roll the day FIRST so a reserve on a new day sees a fresh total.
      this.dayReset(deps.now());
      // --- ONE synchronous critical section: check + reserve, NO await in between. ---
      if (state.totalReserved + amount > state.ceiling) {
        return { ok: false, ceiling: state.ceiling, totalReserved: state.totalReserved };
      }
      state.totalReserved += amount;
      persist();
      return {
        ok: true,
        reserved: amount,
        ceiling: state.ceiling,
        totalReserved: state.totalReserved,
      };
      // --- end critical section ---
    },

    release(reserve: ReserveResult): void {
      if (reserve.ok && typeof reserve.reserved === 'number') {
        state.totalReserved = Math.max(0, state.totalReserved - reserve.reserved);
        persist();
      }
    },

    dayReset(now: number): void {
      const key = dayKey(now);
      if (state.date !== key) {
        state = { date: key, totalReserved: 0, ceiling: state.ceiling };
        persist();
      }
    },
  };
}
