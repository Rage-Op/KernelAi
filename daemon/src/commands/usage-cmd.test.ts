/**
 * usage-cmd.test.ts — the cumulative session usage report + accumulator.
 *
 * session-usage is a module-level singleton (one daemon = one session). node --test isolates test
 * files in their own process, so this file owns the singleton; each test resets it first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { recordTurn, resetUsage, snapshot } from './session-usage.js';
import { runUsageReport } from './usage-cmd.js';

test('an empty session reports no measured turns', () => {
  resetUsage();
  const report = runUsageReport();
  assert.match(report, /KERNEL · usage/);
  assert.match(report, /no measured turns/i);
});

test('recorded local turns accumulate tokens, $0 cost, and a cloud-equivalent', () => {
  resetUsage();
  recordTurn({ brain: 'lmstudio', model: 'qwen2.5:7b', promptTokens: 1000, outputTokens: 200, evalMs: 4000 });
  recordTurn({ brain: 'lmstudio', model: 'qwen2.5:7b', promptTokens: 500, outputTokens: 100, evalMs: 2000 });

  const snap = snapshot();
  assert.equal(snap.turns, 2);
  assert.equal(snap.promptTokens, 1500);
  assert.equal(snap.outputTokens, 300);
  assert.equal(snap.totalTokens, 1800);
  // cloud-equivalent = 1500*$5/1M + 300*$25/1M = 0.0075 + 0.0075 = 0.015
  assert.ok(Math.abs(snap.cloudEquivUsd - 0.015) < 1e-9, `cloudEquiv ${snap.cloudEquivUsd}`);
  assert.equal(snap.costUsd, 0); // local is free
  assert.ok(snap.avgTokensPerSec !== null && snap.avgTokensPerSec > 0);

  const report = runUsageReport();
  assert.match(report, /1,800 total/);
  assert.match(report, /lmstudio \(free\)/);
  assert.match(report, /cloud-equivalent/);
});

test('cloud turns report the billed cost', () => {
  resetUsage();
  recordTurn({ brain: 'cloud', model: 'claude-opus-4-8', promptTokens: 1000, outputTokens: 200, estCostUsd: 0.01 });
  const report = runUsageReport();
  assert.match(report, /cloud/);
  assert.match(report, /\$0\.0100 billed/);
});

test('/usage reset clears the accounting window', () => {
  resetUsage();
  recordTurn({ brain: 'lmstudio', promptTokens: 100, outputTokens: 50, evalMs: 1000 });
  assert.equal(snapshot().turns, 1);
  const msg = runUsageReport('reset');
  assert.match(msg, /reset/i);
  assert.equal(snapshot().turns, 0);
  assert.equal(snapshot().totalTokens, 0);
});
