/**
 * safety/flags.ts — the SAFE-07 feature flag that makes the gate's `gated` arm reachable.
 *
 * In Phases 1-4 the Red tier was UNREACHABLE: `gate.authorize` always denied Red. Phase 5
 * introduces the live breaker behind this single flag so the flip-on is behaviour-preserving:
 *   - `breakerEnabled === false` (the default) → Red → deny + escalate, EXACTLY the P1-P4 behaviour.
 *   - `breakerEnabled === true`                → Red (user/self origin) → `{ kind:'gated' }` → breaker.
 *
 * The flag is read ONCE from the environment so production is deterministic, and is also a mutable
 * field so tests can toggle it around a case (always restoring it in a finally). The three hard
 * rules (credential fence, external-Red block) sit ABOVE this flag — they fire regardless of it.
 */
export const FLAGS: { breakerEnabled: boolean } = {
  // Default OFF to preserve P1-P4 behaviour; opt in with KERNEL_BREAKER_ENABLED=true.
  breakerEnabled: process.env.KERNEL_BREAKER_ENABLED === 'true',
};
