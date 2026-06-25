/**
 * prefill-estimate.test.ts — the learned prompt-processing (prefill) time estimator that drives the
 * Face's determinate progress bar. Cold start → null (Face keeps its indeterminate sweep); after a
 * measured turn → a positive estimate that scales with prompt size.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  estimatePrefillMs,
  recordPrefill,
  __resetPrefillEstimateForTest,
  CHARS_PER_TOKEN,
} from './prefill-estimate.js';

test('estimatePrefillMs: null on a cold start (no measured turn yet)', () => {
  __resetPrefillEstimateForTest();
  assert.equal(estimatePrefillMs(100_000), null, 'no sample → no estimate (Face falls back to sweep)');
});

test('estimatePrefillMs: after a measured turn, estimates scale with prompt size', () => {
  __resetPrefillEstimateForTest();
  // 1000 tokens processed in 1000 ms → 1 token/ms.
  recordPrefill(1000, 1000);
  // A prompt of 8000 chars ≈ 2000 tokens at ~4 chars/token → ≈ 2000 ms at 1 tok/ms.
  const eta = estimatePrefillMs(8000);
  assert.ok(eta != null, 'an estimate exists after a sample');
  const expected = 8000 / CHARS_PER_TOKEN / 1; // tokens / (tokens per ms)
  assert.ok(Math.abs(eta! - expected) < 1, `eta ≈ ${expected}ms (got ${eta})`);
  // Twice the chars → ~twice the eta.
  assert.ok(estimatePrefillMs(16000)! > eta!, 'a bigger prompt estimates longer');
});

test('estimatePrefillMs: a trivially short prefill returns null (no flash-bar)', () => {
  __resetPrefillEstimateForTest();
  recordPrefill(1000, 1000); // 1 tok/ms
  // ~40 chars → ~10 tokens → ~10 ms, below the MIN_ETA threshold → null.
  assert.equal(estimatePrefillMs(40), null, 'sub-threshold prefill shows no determinate bar');
});

test('recordPrefill: ignores invalid/zero samples (no NaN, no division-by-zero)', () => {
  __resetPrefillEstimateForTest();
  recordPrefill(undefined, 1000);
  recordPrefill(1000, 0);
  recordPrefill(0, 1000);
  assert.equal(estimatePrefillMs(8000), null, 'invalid samples leave the estimator cold');
});
