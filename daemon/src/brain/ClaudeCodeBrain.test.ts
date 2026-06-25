/**
 * ClaudeCodeBrain.test.ts — the CLAUDE (SUBSCRIPTION) brain.
 *
 * Covers: ClaudeCodeBrain spawns `claude -p … --output-format json` and parses `.result` →
 * Decision.reply; it runs in SUBSCRIPTION mode (NO `--bare`, which would force API-key auth) and
 * injects KERNEL's identity + memory via `--append-system-prompt`; it is read-only fenced; and it is
 * ABSENT-TOLERANT — a non-zero exit / spawn ENOENT / garbled stdout returns a typed escalation
 * Decision, never throwing across the loop boundary.
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

  const decision = await new ClaudeCodeBrain().reason('refactor the parser', 'MEMCTX_MARKER');
  assert.equal(decision.reply, 'Refactored the parser.', 'stdout .result maps to Decision.reply');
  assert.ok(seenArgs.includes('-p'), 'invokes headless print mode');
  assert.ok(seenArgs.includes('--output-format') && seenArgs.includes('json'), 'requests JSON output');
  // PURE REASONER fence: dontAsk + NO allowlisted tools (denies all tool use; no secret-fence bypass).
  const pmIdx = seenArgs.indexOf('--permission-mode');
  assert.ok(pmIdx >= 0 && seenArgs[pmIdx + 1] === 'dontAsk', '--permission-mode dontAsk is set');
  assert.ok(!seenArgs.includes('--allowedTools'), 'no tools are allowlisted (pure text reasoner)');
  // SUBSCRIPTION mode: NO --bare (which would force ANTHROPIC_API_KEY auth and defeat the subscription).
  assert.ok(!seenArgs.includes('--bare'), 'subscription mode runs WITHOUT --bare');
  // KERNEL identity + memory context are injected via an appended system prompt.
  const sysIdx = seenArgs.indexOf('--append-system-prompt');
  assert.ok(sysIdx >= 0, 'injects an appended system prompt');
  const sysPrompt = seenArgs[sysIdx + 1] ?? '';
  assert.ok(/KERNEL/.test(sysPrompt), 'the system prompt carries KERNEL identity');
  assert.ok(sysPrompt.includes('MEMCTX_MARKER'), 'the system prompt carries the assembled memory context');

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
