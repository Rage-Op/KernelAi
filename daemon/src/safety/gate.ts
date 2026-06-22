/**
 * gate.authorize — the SINGLE chokepoint between decide and act (RESEARCH.md Pattern 2).
 *
 * Phase 5: ACTIVATED. The order is load-bearing and the three hard rules sit ABOVE both
 * `/override` and the breaker:
 *   1. HARD RULE i  — the credential fence (unchanged from P2, overridable=false).
 *   2. HARD RULE ii — `tier==='red' && origin==='external'` → HARD-BLOCK (deny + escalate). A
 *                     poisoned-email ToolCall that classifies Red can NEVER auto-execute, even
 *                     under active `/override` (spec §8; Pitfall 1).
 *   3. classify the tier and record it.
 *   4. Red → SAFE-07 flag gate: flag OFF reproduces the exact P1-P4 deny; flag ON returns
 *      `{ kind:'gated' }` and the live breaker takes over in registry.dispatch. `/override`
 *      NEVER changes the Red decision (defense-in-depth: override.allows('red') is also
 *      structurally `{ gated:true }`).
 *   5. green/yellow → allow. `/override` threads the friction (green full-speed, yellow
 *      proceed+log+notify) but the allow decision itself is unchanged.
 */
import { classifyTier, detectCredentialField } from './tiers.js';
import { logger } from '../memory/log.js';
import type { ToolCall } from '../brain/BrainProvider.js';
import { FLAGS } from './flags.js';
import { overrideSingleton, type OverrideState } from './override.js';

/**
 * The authorization verdict. Phase-5 discriminated union:
 *   - allow  → green/yellow proceed to execute. `speed`/`notify` are ADDITIVE friction hints
 *              threaded from `/override` (green full-speed; yellow proceed+log+notify). Existing
 *              consumers ignore them; the contract is unchanged for callers that don't read them.
 *   - gated  → the LIVE breaker (Phase 5). registry.dispatch routes this to breaker.run.
 *   - deny   → short-circuit; carries a structured escalation for the originator.
 */
export type Verdict =
  | { kind: 'allow'; tier: 'green' | 'yellow'; speed?: 'full'; notify?: boolean }
  | { kind: 'gated'; tier: 'red' }
  | { kind: 'deny'; tier: 'red' | 'yellow'; escalation: { reason: string; recommendation?: string } };

/**
 * Authorize a tool call. Order is load-bearing (see file header). `override` is injectable so a
 * test can pass a fake-clock instance; production uses the process singleton.
 */
export async function authorize(
  call: ToolCall,
  override: OverrideState = overrideSingleton(),
): Promise<Verdict> {
  // 1. HARD RULE i (capability lands in P2): never type into a credential field.
  //    Non-overridable, code-level, BEFORE any keystroke synthesis or tier logic. This fires even
  //    under active /override (overridable=false) — verified by gate.test.
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
  logger.info({ tool: call.tool, tier, origin: call.origin }, 'gate: classified');

  // 3. HARD RULE ii (Phase 5, Pitfall 1): a Red action whose instruction originated in EXTERNAL
  //    content is NEVER auto-executed — quarantine + escalate, ABOVE /override and the breaker.
  //    A test-injection "poisoned email" ToolCall {origin:'external'} that classifies Red is
  //    HARD-BLOCKED even under active /override; the executor is never reached.
  if (tier === 'red' && call.origin === 'external') {
    logger.warn({ tool: call.tool }, 'gate: external-sourced Red — HARD-BLOCKED');
    return {
      kind: 'deny',
      tier,
      escalation: {
        reason:
          'Red action whose instruction originated in external content — never auto-executed (spec §8).',
        recommendation: 'Quarantined; Pravin must initiate this action directly.',
      },
    };
  }

  // 4. Red branch — SAFE-07 flag gate. `/override` NEVER changes this decision (Red is always
  //    gated; override.allows('red') is structurally { gated:true } too — defense in depth).
  if (tier === 'red') {
    if (!FLAGS.breakerEnabled) {
      // FLAG OFF → exact P1-P4 behaviour: Red = deny + escalate (behaviour-preserving).
      return {
        kind: 'deny',
        tier,
        escalation: {
          reason: 'Red-tier action is gated until Phase 5; no Red autonomy yet.',
          recommendation: 'Escalate to Pravin for explicit approval.',
        },
      };
    }
    // FLAG ON → hand off to the live breaker via registry.dispatch. An absent/unknown origin on a
    // Red action is treated as suspect but still gated (default-deny posture) — only the EXPLICIT
    // external block above hard-denies.
    return { kind: 'gated', tier };
  }

  // 5. green/yellow proceed. Thread /override friction onto the allow verdict (additive hints):
  //    green → full-speed; yellow → proceed + log + notify. The allow decision is unchanged.
  const behavior = override.allows(tier);
  if (tier === 'green') {
    return { kind: 'allow', tier, speed: 'speed' in behavior ? behavior.speed : 'full' };
  }
  // yellow: proceed + notify (recoverable). notify=true reflects the proceed+log+notify posture.
  return { kind: 'allow', tier, notify: true };
}
