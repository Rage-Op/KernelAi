/**
 * ClaudeCodeBrain.test.ts — RED until Task 2 creates ClaudeCodeBrain.ts.
 *
 * Covers BRAIN-04: ClaudeCodeBrain spawns `claude -p ... --output-format json` and
 * parses `.result` → Decision.reply; it is ABSENT-TOLERANT — a non-zero exit / spawn
 * ENOENT / garbled stdout returns a typed escalation Decision, never throwing across
 * the loop boundary. Green/Yellow-only is enforced by the CLI flags (asserted via the
 * recorded argv).
 *
 * The CLI runner is mocked via the `__setRunnerForTest` seam — node:child_process is
 * never actually spawned in the unit test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ClaudeCodeBrain, __setRunnerForTest, type ClaudeCodeResult } from './ClaudeCodeBrain.js';

test('ClaudeCodeBrain: clean JSON stdout parses to Decision.reply (Green/Yellow-only flags)', async () => {
  let seenArgs: string[] = [];
  __setRunnerForTest(async (args: string[]): Promise<ClaudeCodeResult> => {
    seenArgs = args;
    return {
      code: 0,
      stdout: JSON.stringify({ result: 'Refactored the parser.', session_id: 'sess_123', total_cost_usd: 0.01 }),
      stderr: '',
    };
  });

  const decision = await new ClaudeCodeBrain().reason('refactor the parser', 'ctx');
  assert.equal(decision.reply, 'Refactored the parser.', 'stdout .result maps to Decision.reply');
  assert.ok(seenArgs.includes('-p'), 'invokes headless print mode');
  assert.ok(seenArgs.includes('--output-format') && seenArgs.includes('json'), 'requests JSON output');
  // Green/Yellow-only fence: a permission restriction flag must be present (BRAIN-04 / T-03-05).
  assert.ok(
    seenArgs.includes('--permission-mode') || seenArgs.includes('--allowedTools'),
    'a read-only permission fence flag is present (Green/Yellow-only this phase)',
  );

  __setRunnerForTest(null);
});

test('ClaudeCodeBrain: a non-zero exit returns a typed escalation, no throw', async () => {
  __setRunnerForTest(async (): Promise<ClaudeCodeResult> => ({ code: 1, stdout: '', stderr: 'auth error' }));

  let decision;
  await assert.doesNotReject(async () => {
    decision = await new ClaudeCodeBrain().reason('x', 'ctx');
  }, 'a non-zero claude exit must NOT throw');
  assert.ok(decision!.reply, 'a failed claude run still yields a surfaceable reply');
  assert.match(decision!.reply!, /claude code|unavailable|failed/i, 'reply names the Claude Code failure');

  __setRunnerForTest(null);
});

test('ClaudeCodeBrain: garbled (non-JSON) stdout returns a typed escalation, no throw', async () => {
  __setRunnerForTest(async (): Promise<ClaudeCodeResult> => ({ code: 0, stdout: 'not json at all <<<', stderr: '' }));

  let decision;
  await assert.doesNotReject(async () => {
    decision = await new ClaudeCodeBrain().reason('x', 'ctx');
  }, 'garbled stdout must NOT throw');
  assert.ok(decision!.reply, 'garbled output still yields a surfaceable reply');

  __setRunnerForTest(null);
});
