/**
 * gate.authorize — the SINGLE chokepoint between decide and act (RESEARCH.md Pattern 2).
 *
 * Phase 2: CLASSIFY-ONLY. It (a) enforces the one hard rule whose physical capability lands
 * this phase — the credential fence — (b) classifies the tier, and (c) records (logs) it. It
 * does NOT run a circuit breaker, `/override`, dry-run preview, the 10s cancel window, or a
 * spend ceiling (all of those are Phase 5 per the owner hard-stop).
 *
 * LOCKED DECISION (research Open Question 1): a Red-tier classification in Phase 2 is
 * `deny + escalate` — there is NO Red autonomy before Phase 5. The `gated` arm of `Verdict`
 * is kept UNUSED here so Phase 5 is a PURE-ADDITIVE change: Phase 5 is the ONLY edit site —
 * it turns the Red branch below into the real breaker (dry-run → cancel → ceiling → audit)
 * by emitting `{ kind: 'gated' }`; the router, the tools, and the loop never change.
 */
import { classifyTier, detectCredentialField } from './tiers.js';
import { logger } from '../memory/log.js';
import type { ToolCall } from '../brain/BrainProvider.js';

/**
 * The authorization verdict. Phase-5-ready discriminated union:
 *   - allow  → green/yellow proceed to execute
 *   - gated  → reserved for Phase 5 (the real breaker). UNUSED in Phase 2.
 *   - deny   → short-circuit; carries a structured escalation for the originator.
 */
export type Verdict =
  | { kind: 'allow'; tier: 'green' | 'yellow' }
  | { kind: 'gated'; tier: 'red' }
  | { kind: 'deny'; tier: 'red' | 'yellow'; escalation: { reason: string; recommendation?: string } };

/**
 * Authorize a tool call. Order is load-bearing:
 *   1. HARD RULE FIRST — the credential fence (fires BEFORE tier classification, non-overridable).
 *   2. classify the tier and log it.
 *   3. LOCKED: Red ⇒ deny + escalate (no Red autonomy pre-Phase-5).
 *   4. otherwise allow (green/yellow).
 */
export async function authorize(call: ToolCall): Promise<Verdict> {
  // 1. HARD RULE (capability lands this phase): never type into a credential field.
  //    Non-overridable, code-level, BEFORE any keystroke synthesis or tier logic.
  const cred = detectCredentialField(call);
  if (cred.isSecret) {
    logger.warn({ tool: call.tool, reason: cred.reason }, 'gate: credential fence — refused');
    return {
      kind: 'deny',
      tier: 'red',
      escalation: {
        reason: `refusing to type into a secure/credential field (${cred.reason})`,
        recommendation: 'Pravin enters this credential manually.',
      },
    };
  }

  // 2. classify centrally and record.
  const tier = classifyTier(call);
  logger.info({ tool: call.tool, tier }, 'gate: classified');

  // 3. LOCKED DECISION: Red = deny + escalate in Phase 2 (NOT gated — no Red autonomy yet).
  //    PHASE 5 ONLY: replace this branch with `return { kind: 'gated', tier };` and hook the
  //    breaker (dry-run → 10s cancel → spend ceiling → audit) inside the gate. Router/tools/loop
  //    are untouched — that is the whole point of the classify-only shape.
  if (tier === 'red') {
    return {
      kind: 'deny',
      tier,
      escalation: {
        reason: 'Red-tier action is gated until Phase 5; no Red autonomy yet.',
        recommendation: 'Escalate to Pravin for explicit approval.',
      },
    };
  }

  // 4. green/yellow proceed.
  return { kind: 'allow', tier };
}
