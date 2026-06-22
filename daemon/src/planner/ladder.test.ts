/**
 * planner/ladder.test.ts — the obstacle planner ladder (SAFE-06).
 *
 * The ladder wraps `dispatch` (it NEVER bypasses the gate — BRAIN-06 invariant). On a clean failure
 * it climbs: TRY → REPLAN (the brain proposes approach B) → DECOMPOSE (split into sub-steps) →
 * RETRY-WITH-BACKOFF (exponential, on the injected clock) → ESCALATE with a SPECIFIC recommendation
 * ("X blocked by Y; I recommend Z. Approve?") — NEVER a vague "I'm stuck".
 *
 * CRITICAL (SAFE-06): a dispatch result that is a Red gate/deny verdict makes the ladder SKIP straight
 * to escalate immediately — Red gates belong to the breaker, not the retry loop.
 *
 * Everything impure is INJECTED: a recording dispatch (returns canned ToolResults), a mock brain
 * (replan/recommend), and the fake clock from safety/test-helpers.ts — so NO real brain call and NO
 * real timer ever run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runLadder, type LadderDeps, type LadderBrain } from './ladder.js';
import { fakeClock } from '../safety/test-helpers.js';
import type { ToolCall } from '../brain/BrainProvider.js';
import type { ToolResult } from '../tools/Tool.js';

const GOAL: ToolCall = { tool: 'shell', args: { op: 'build the widget' }, origin: 'self' };

/** A mock brain that records call counts and returns canned replan/decompose/recommendation outputs. */
interface CountingBrain extends LadderBrain {
  replanCount: number;
  decomposeCount: number;
  recommendCount: number;
}
function mockBrain(over: Partial<LadderBrain> = {}): CountingBrain {
  const brain = {
    replanCount: 0,
    decomposeCount: 0,
    recommendCount: 0,
    async replan(call: ToolCall): Promise<ToolCall> {
      brain.replanCount++;
      // approach B: same tool, a different op.
      return { ...call, args: { ...call.args, op: 'build the widget (approach B)' } };
    },
    async decompose(call: ToolCall): Promise<ToolCall[]> {
      brain.decomposeCount++;
      return [
        { ...call, args: { ...call.args, op: 'step 1' } },
        { ...call, args: { ...call.args, op: 'step 2' } },
      ];
    },
    async recommend(_call: ToolCall, reason: string): Promise<string> {
      brain.recommendCount++;
      return `restart the build daemon and re-run (the lock at ${reason} clears on restart)`;
    },
    ...over,
  };
  return brain as CountingBrain;
}

// --- first-try success short-circuits at TRY ---

test('SAFE-06: a call that succeeds on the first try returns success with NO escalation (short-circuit at TRY)', async () => {
  const calls: ToolCall[] = [];
  const deps: LadderDeps = {
    dispatch: async (c) => {
      calls.push(c);
      return { ok: true, data: { done: true } };
    },
    brain: mockBrain(),
    clock: fakeClock(),
    maxRetries: 3,
    backoffBaseMs: 100,
  };

  const outcome = await runLadder(GOAL, deps);

  assert.equal(outcome.kind, 'success', 'first-try success returns success');
  assert.equal(calls.length, 1, 'dispatch called exactly once — the ladder short-circuits at TRY');
});

// --- the full ladder climbs to a SPECIFIC escalation ---

test('SAFE-06: injected transient failures climb TRY->REPLAN->DECOMPOSE->BACKOFF->ESCALATE with a SPECIFIC recommendation', async () => {
  const clock = fakeClock();
  const slept: number[] = [];
  // record backoff intervals: wrap sleep to capture the ms it advances by.
  const recordingClock = {
    now: () => clock.now(),
    sleep: async (ms: number) => {
      slept.push(ms);
      await clock.sleep(ms);
    },
  };
  const brain = mockBrain();

  // dispatch ALWAYS fails (a clean, non-Red failure) so the ladder exhausts every rung.
  const calls: ToolCall[] = [];
  const deps: LadderDeps = {
    dispatch: async (c) => {
      calls.push(c);
      return { ok: false, escalation: { reason: 'transient: build lock held by pid 4123' } };
    },
    brain,
    clock: recordingClock,
    maxRetries: 3,
    backoffBaseMs: 100,
  };

  const outcome = await runLadder(GOAL, deps);

  // It exhausts the ladder and ESCALATES.
  assert.equal(outcome.kind, 'escalate', 'an unrecoverable obstacle escalates');

  // Every rung was climbed.
  assert.ok(brain.replanCount >= 1, 'REPLAN rung: the brain was asked for approach B');
  assert.ok(brain.decomposeCount >= 1, 'DECOMPOSE rung: the brain split the goal into sub-steps');
  assert.ok(brain.recommendCount >= 1, 'ESCALATE rung: the brain produced a specific recommendation');

  // RETRY-WITH-BACKOFF: backoff intervals grow (exponential on the injected clock).
  assert.ok(slept.length >= 2, 'at least two backoff sleeps occurred');
  for (let i = 1; i < slept.length; i++) {
    assert.ok(slept[i] > slept[i - 1], `backoff interval ${i} (${slept[i]}) grows past ${slept[i - 1]}`);
  }

  // The escalation text is SPECIFIC — shape "X blocked by Y; I recommend Z. Approve?".
  assert.equal(outcome.kind, 'escalate');
  if (outcome.kind === 'escalate') {
    const text = outcome.escalation.reason;
    assert.match(text, /blocked by/i, 'names what blocked it (Y)');
    assert.match(text, /recommend/i, 'carries a specific recommendation (Z)');
    assert.match(text, /approve\??/i, 'asks for approval');
    assert.match(text, /build the widget/i, 'names the goal (X)');
    assert.match(text, /build lock held by pid 4123/i, 'names the concrete blocking reason');
    // NEVER the vague "I'm stuck".
    assert.doesNotMatch(text, /\bI'?m stuck\b/i, 'never the vague "I\'m stuck"');
  }
});

// --- a Red gate SKIPS the ladder ---

test('SAFE-06: a Red gate/deny verdict SKIPS the ladder and escalates immediately (no retry, no backoff)', async () => {
  const clock = fakeClock();
  const slept: number[] = [];
  const recordingClock = {
    now: () => clock.now(),
    sleep: async (ms: number) => {
      slept.push(ms);
      await clock.sleep(ms);
    },
  };
  const brain = mockBrain();

  const calls: ToolCall[] = [];
  // dispatch returns a RED gate verdict (the breaker escalated this Red action up to Pravin).
  const redResult: ToolResult = {
    ok: false,
    gated: true,
    escalation: {
      reason: 'Red action requires Pravin — escalated by the breaker.',
      recommendation: 'Pravin approves the Red action directly.',
    },
  } as ToolResult;
  const deps: LadderDeps = {
    dispatch: async (c) => {
      calls.push(c);
      return redResult;
    },
    brain,
    clock: recordingClock,
    maxRetries: 3,
    backoffBaseMs: 100,
  };

  const outcome = await runLadder(GOAL, deps);

  assert.equal(outcome.kind, 'escalate', 'a Red gate escalates');
  // SKIP: dispatch called exactly once — no retry, no replan, no decompose, no backoff.
  assert.equal(calls.length, 1, 'a Red gate is dispatched exactly once — the ladder is SKIPPED');
  assert.equal(brain.replanCount, 0, 'no REPLAN on a Red gate');
  assert.equal(brain.decomposeCount, 0, 'no DECOMPOSE on a Red gate');
  assert.equal(slept.length, 0, 'no BACKOFF on a Red gate');
  // The escalation carries the breaker's own reason — the ladder did not invent a recommendation.
  if (outcome.kind === 'escalate') {
    assert.match(outcome.escalation.reason, /Red action/i, 'carries the breaker escalation');
  }
});

// --- a recoverable obstacle that clears after a retry succeeds (no escalation) ---

test('SAFE-06: a transient obstacle that clears on a backoff retry returns success (ladder recovers)', async () => {
  const clock = fakeClock();
  const brain = mockBrain();

  let n = 0;
  const calls: ToolCall[] = [];
  const deps: LadderDeps = {
    dispatch: async (c) => {
      calls.push(c);
      n++;
      // fail the first two attempts (TRY + replan), succeed once we reach a retry.
      if (n <= 2) return { ok: false, escalation: { reason: 'transient lock' } };
      return { ok: true, data: { recovered: true } };
    },
    brain,
    clock,
    maxRetries: 3,
    backoffBaseMs: 50,
  };

  const outcome = await runLadder(GOAL, deps);
  assert.equal(outcome.kind, 'success', 'the ladder recovers when a retry clears the obstacle');
  assert.equal(brain.recommendCount, 0, 'recovery never reaches the escalate rung');
});
