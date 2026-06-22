/**
 * planner/ladder.ts — the obstacle planner ladder (SAFE-06, spec §9).
 *
 * When KERNEL hits an obstacle, it does NOT give up with a vague "I'm stuck". It climbs a fixed
 * ladder of recovery rungs, escalating to Pravin ONLY at the top with a SPECIFIC recommendation:
 *
 *   TRY        — dispatch the call once. Clean success → done.
 *   REPLAN     — ask the brain for approach B (a different shape of the same goal) and dispatch it.
 *   DECOMPOSE  — ask the brain to split the goal into sub-steps; dispatch each. All clear → done.
 *   BACKOFF    — retry with EXPONENTIAL backoff on the injected clock, up to maxRetries. The wait
 *                grows (base, base*2, base*4, …) so a transient lock has time to clear.
 *   ESCALATE   — exhausted every rung → ask the brain for a concrete recommendation and return a
 *                SPECIFIC escalation of the shape:
 *                  "`<goal>` blocked by `<reason>`; I recommend `<recommendation>`. Approve?"
 *                — never the vague "I'm stuck".
 *
 * CRITICAL INVARIANT (SAFE-06): if a dispatch result is a RED GATE/DENY verdict (`result.gated`),
 * the ladder SKIPS every rung and escalates IMMEDIATELY. A Red gate belongs to the breaker (05-01)
 * and to Pravin — it is NOT a transient obstacle to retry. Only Red gates skip the ladder.
 *
 * The ladder WRAPS dispatch; it NEVER bypasses the gate (BRAIN-06 invariant preserved). Every impure
 * dependency — dispatch, the brain (replan/decompose/recommend), the clock — is INJECTED, so the
 * whole state machine is unit-testable with a recording dispatch, a mock brain, and a fake clock:
 * NO real cloud call, NO real timer. The brain seam is satisfied in production by the shipped
 * `ClaudeBrain` (versioned model id `claude-opus-4-8`, never `-latest`).
 */
import type { ToolCall } from '../brain/BrainProvider.js';
import type { ToolResult } from '../tools/Tool.js';

/** The injectable clock (same shape the breaker uses; the fake clock from test-helpers satisfies it). */
export interface LadderClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/**
 * The brain seam the ladder reaches for REPLAN / DECOMPOSE / the ESCALATE recommendation. Injected
 * (a mock in tests); in production it is backed by the shipped `ClaudeBrain` (`claude-opus-4-8`).
 */
export interface LadderBrain {
  /** Propose approach B: a different-shaped ToolCall for the same goal. */
  replan(call: ToolCall, reason: string): Promise<ToolCall>;
  /** Split the goal into ordered sub-steps the ladder dispatches in turn. */
  decompose(call: ToolCall, reason: string): Promise<ToolCall[]>;
  /** Produce a SPECIFIC remediation recommendation for the escalation ("I recommend Z"). */
  recommend(call: ToolCall, reason: string): Promise<string>;
}

/** Everything the ladder needs — all impure deps injected (dispatch, brain, clock). */
export interface LadderDeps {
  /** The SINGLE chokepoint (registry.dispatch). The ladder wraps it; NEVER bypasses the gate. */
  dispatch: (call: ToolCall) => Promise<ToolResult>;
  /** The replan/decompose/recommend brain seam (mock in tests; ClaudeBrain in production). */
  brain: LadderBrain;
  /** The clock for exponential backoff (fake in tests — no real timer). */
  clock: LadderClock;
  /** How many backoff RETRY attempts before escalating. */
  maxRetries: number;
  /** The base backoff interval; doubles each retry (base, base*2, base*4, …). */
  backoffBaseMs: number;
}

/** The result of a ladder run: the obstacle either cleared (success) or escalated to Pravin. */
export type LadderOutcome =
  | { kind: 'success'; result: ToolResult }
  | { kind: 'escalate'; escalation: { reason: string; recommendation?: string } };

/** A human-readable reason string from a failed ToolResult (or a generic fallback). */
function reasonOf(result: ToolResult): string {
  return result.escalation?.reason ?? 'the action did not complete';
}

/** A short label for the goal, for the escalation text ("<goal> blocked by …"). */
function goalLabel(call: ToolCall): string {
  const op = call.args?.op;
  return typeof op === 'string' && op.length > 0 ? op : call.tool;
}

/**
 * A Red gate/deny verdict the breaker escalated — these SKIP the ladder and go straight to Pravin.
 * registry.dispatch stamps `gated:true` on a non-success breaker outcome (SAFE-06).
 */
function isRedGate(result: ToolResult): boolean {
  return result.gated === true;
}

/**
 * Run the obstacle ladder for a single ToolCall. Climbs TRY → REPLAN → DECOMPOSE → BACKOFF →
 * ESCALATE on a CLEAN failure; a RED GATE at any dispatch SKIPS straight to escalate.
 */
export async function runLadder(call: ToolCall, deps: LadderDeps): Promise<LadderOutcome> {
  // --- RUNG 1: TRY — dispatch once. ---
  let last = await deps.dispatch(call);
  if (last.ok) return { kind: 'success', result: last };
  // A Red gate is NOT a transient obstacle: escalate immediately, with the breaker's own escalation.
  if (isRedGate(last)) return redEscalation(last);

  // --- RUNG 2: REPLAN — ask the brain for approach B, dispatch it. ---
  const approachB = await deps.brain.replan(call, reasonOf(last));
  last = await deps.dispatch(approachB);
  if (last.ok) return { kind: 'success', result: last };
  if (isRedGate(last)) return redEscalation(last);

  // --- RUNG 3: DECOMPOSE — split into sub-steps, dispatch each in order. ---
  const steps = await deps.brain.decompose(call, reasonOf(last));
  let decomposeFailed = false;
  for (const step of steps) {
    const stepResult = await deps.dispatch(step);
    if (isRedGate(stepResult)) return redEscalation(stepResult);
    if (!stepResult.ok) {
      last = stepResult;
      decomposeFailed = true;
      break;
    }
    last = stepResult;
  }
  // every sub-step cleared → the decomposition succeeded.
  if (!decomposeFailed && last.ok) return { kind: 'success', result: last };

  // --- RUNG 4: RETRY-WITH-BACKOFF — exponential backoff on the injected clock, up to maxRetries. ---
  for (let attempt = 0; attempt < deps.maxRetries; attempt++) {
    const waitMs = deps.backoffBaseMs * Math.pow(2, attempt); // base, base*2, base*4, …
    await deps.clock.sleep(waitMs);
    last = await deps.dispatch(call);
    if (last.ok) return { kind: 'success', result: last };
    if (isRedGate(last)) return redEscalation(last);
  }

  // --- RUNG 5: ESCALATE — exhausted the ladder; build a SPECIFIC recommendation, never "I'm stuck". ---
  const why = reasonOf(last);
  const recommendation = await deps.brain.recommend(call, why);
  return {
    kind: 'escalate',
    escalation: {
      reason: `${goalLabel(call)} blocked by ${why}; I recommend ${recommendation}. Approve?`,
      recommendation,
    },
  };
}

/** A Red gate carries the breaker's OWN escalation up to Pravin unchanged — the ladder is skipped. */
function redEscalation(result: ToolResult): LadderOutcome {
  return {
    kind: 'escalate',
    escalation: result.escalation ?? {
      reason: 'Red action escalated by the breaker — requires Pravin.',
      recommendation: 'Pravin approves the Red action directly.',
    },
  };
}
