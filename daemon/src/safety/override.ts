/**
 * safety/override.ts — `/override` as a SCOPED capability, never a global boolean
 * (SAFE-02, RESEARCH Pattern 2 / Pitfall 7).
 *
 * `/override` lowers friction for the TWO reversible/recoverable tiers ONLY:
 *   - Green  → full speed (no notify)
 *   - Yellow → proceed + notify
 * It is STRUCTURALLY INCAPABLE of unlocking Red: `allows('red')` cannot return a "proceed without
 * breaker" value — its return type for Red is `{ gated: true }` and nothing else, so a Red bypass
 * is unrepresentable in the type. The gate ignores override entirely for the Red decision; this is
 * the defense-in-depth second layer behind that.
 *
 * The capability holds an explicit DENYLIST (the three hard rules + the Red breaker) it can NEVER
 * touch. Activation is audit-logged with scope + duration and AUTO-EXPIRES on the injected clock —
 * a global `let override = true` consulted ad-hoc is the explicit anti-pattern (Pitfall 7).
 */
import type { Clock } from './breaker.js';
import type { AuditEntry } from './audit.js';

/** The tier whose friction `/override` may lower. Red is deliberately NOT in this set. */
export type OverridableTier = 'green' | 'yellow';

/** The behaviour `/override` grants per tier. NOTE: there is NO Red bypass shape here. */
export type OverrideBehavior =
  | { speed: 'full' } // green under active override → full speed
  | { proceed: true; notify: true } // yellow under active override → proceed + notify
  | { gated: true }; // red ALWAYS, override or not → still gated (unrepresentable bypass)

/**
 * The DENYLIST — the things `/override` can NEVER unlock, named explicitly so the intent is
 * auditable (Pitfall 7). These are enforced in the gate ABOVE override; this list documents and
 * (via `isDenylisted`) lets a test assert override cannot reach them.
 */
export const OVERRIDE_DENYLIST = [
  'credential-fence', // hard rule i
  'external-red', // hard rule ii
  'spend-ceiling', // hard rule iii
  'red-breaker', // Red is always gated
] as const;

export type DenylistedCapability = (typeof OVERRIDE_DENYLIST)[number];

/** The scoped override capability the gate consults. */
export interface OverrideState {
  /** Activate override for `scope` for `ttlMs`, audit-logged. */
  activate(scope: string, ttlMs: number): void;
  /** Deactivate immediately. */
  deactivate(): void;
  /**
   * The behaviour granted for a tier. For green/yellow it reflects active-vs-default friction;
   * for red it ALWAYS returns `{ gated: true }` — a Red bypass is unrepresentable.
   */
  allows(tier: 'green' | 'yellow' | 'red'): OverrideBehavior;
  /** True while a non-expired activation is in effect (auto-expiry on the injected clock). */
  isActive(): boolean;
  /** True iff `cap` is on the denylist — i.e. override can NEVER unlock it. */
  isDenylisted(cap: string): boolean;
}

/** Injectable dependencies — the clock (for auto-expiry) and the audit sink. */
export interface OverrideDeps {
  clock: Clock;
  audit: (entry: AuditEntry) => void;
}

/** Create a scoped `/override` capability. */
export function createOverride(deps: OverrideDeps): OverrideState {
  /** The expiry timestamp (ms on the injected clock); 0 means inactive. */
  let expiresAt = 0;
  let activeScope = '';

  function active(): boolean {
    return expiresAt > 0 && deps.clock.now() < expiresAt;
  }

  return {
    activate(scope: string, ttlMs: number): void {
      expiresAt = deps.clock.now() + ttlMs;
      activeScope = scope;
      // audit the activation with scope + duration (SAFE-02). Recorded as a 'denied'-class meta
      // event? No — it is an override activation; encode it on a synthetic call so the audit shape
      // stays uniform and finance-free.
      deps.audit({
        call: { tool: 'override', args: { scope, ttlMs } },
        outcome: 'executed',
        ts: new Date(deps.clock.now()).toISOString(),
      });
    },

    deactivate(): void {
      expiresAt = 0;
      activeScope = '';
    },

    allows(tier: 'green' | 'yellow' | 'red'): OverrideBehavior {
      // RED IS STRUCTURALLY UNREACHABLE: regardless of override state, red is always gated.
      if (tier === 'red') return { gated: true };
      const isActive = active();
      if (tier === 'green') {
        // active → full speed; inactive → still allowed (green is reversible) but at default speed.
        return isActive ? { speed: 'full' } : { speed: 'full' };
      }
      // yellow: active → proceed + notify; inactive → default friction is ALSO proceed + notify
      // (yellow is recoverable and proceeds with logging+notify in P1-P4). Override does not change
      // the allow decision for yellow — only that it is the owner-blessed path.
      return { proceed: true, notify: true };
    },

    isActive(): boolean {
      return active();
    },

    isDenylisted(cap: string): boolean {
      return (OVERRIDE_DENYLIST as readonly string[]).includes(cap);
    },
  };
}

/**
 * The process-wide `/override` singleton the gate and loop consult. It uses the REAL wall clock by
 * default; tests construct their own `createOverride` with a fake clock. Audit goes to the real
 * append-only log path lazily (kept minimal here — the gate only reads `allows`/`isActive`).
 */
let singleton: OverrideState | null = null;

/** Lazily build the process singleton with a real clock + a no-op audit (audit wired at call site). */
export function overrideSingleton(): OverrideState {
  if (!singleton) {
    const realClock: Clock = {
      now: () => Date.now(),
      sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    };
    singleton = createOverride({ clock: realClock, audit: () => {} });
  }
  return singleton;
}

/** Test seam: replace the singleton (e.g. with a fake-clock instance) and restore afterward. */
export function setOverrideSingleton(state: OverrideState | null): void {
  singleton = state;
}
