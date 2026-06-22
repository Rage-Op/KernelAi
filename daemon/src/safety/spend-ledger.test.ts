/**
 * spend-ledger.test.ts — the atomic single-writer daily spend ledger (SAFE-04 iii, Pitfall 2).
 *
 * Asserts:
 *   (a) a reserve under the ceiling succeeds and increments the running total;
 *   (b) TWO near-simultaneous reserves CANNOT both pass — the second (which would cross the
 *       ceiling) is rejected (one synchronous critical section, no check-then-act gap → escalate);
 *   (c) release decrements the running total (used on cancel / TOCTOU-abort);
 *   (d) a date change resets the running total to 0 at the local-day boundary (fake clock);
 *   (e) the persisted store holds ONLY { date, totalReserved, ceiling } — NO finance PII.
 *
 * Uses an injected fake clock + a tmpdir JSON path — NO real Date.now, NO real money.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSpendLedger } from './spend-ledger.js';
import { memoryLedger } from './test-helpers.js';

/** A tmpdir JSON path for a file-backed ledger (cleaned up by the OS tmp reaper). */
function tempLedgerPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-ledger-'));
  return path.join(dir, 'spend-ledger.json');
}

/** Fixed clocks for two distinct local days. */
const DAY1 = Date.parse('2026-06-22T12:00:00Z');
const DAY2 = Date.parse('2026-06-23T12:00:00Z');

test('spend-ledger: a reserve under the ceiling succeeds and increments the running total', () => {
  const ledger = createSpendLedger({ now: () => DAY1, filePath: tempLedgerPath(), ceiling: 100 });
  const r = ledger.checkAndReserve(40);
  assert.equal(r.ok, true, 'a reserve under the ceiling succeeds');
  assert.equal(r.reserved, 40);
  assert.equal(r.totalReserved, 40, 'running total incremented by the reserved amount');
});

test('spend-ledger: two near-simultaneous reserves CANNOT both pass (atomic, no race → escalate)', () => {
  const ledger = createSpendLedger({ now: () => DAY1, filePath: tempLedgerPath(), ceiling: 100 });
  // First reserve takes 70 of a 100 ceiling.
  const first = ledger.checkAndReserve(70);
  assert.equal(first.ok, true, 'the first reserve passes');
  // A second reserve of 70 would cross the ceiling (70+70=140 > 100) — it MUST be rejected.
  // If check-then-act raced, both could pass; the single critical section guarantees rejection.
  const second = ledger.checkAndReserve(70);
  assert.equal(second.ok, false, 'the second reserve that would cross the ceiling is rejected');
  assert.equal(second.totalReserved, 70, 'the running total reflects only the first reserve');
});

test('spend-ledger: release decrements the running total (cancel / TOCTOU-abort path)', () => {
  const ledger = createSpendLedger({ now: () => DAY1, filePath: tempLedgerPath(), ceiling: 100 });
  const r = ledger.checkAndReserve(60);
  assert.equal(r.totalReserved, 60);
  ledger.release(r);
  // A fresh reserve of 60 must now succeed because the prior reserve was released.
  const again = ledger.checkAndReserve(60);
  assert.equal(again.ok, true, 'after release, the freed budget is reservable again');
  assert.equal(again.totalReserved, 60, 'released amount did not accumulate');
});

test('spend-ledger: a date change resets the running total to 0 at the local-day boundary', () => {
  const filePath = tempLedgerPath();
  let clock = DAY1;
  const ledger = createSpendLedger({ now: () => clock, filePath, ceiling: 100 });
  ledger.checkAndReserve(90);
  assert.equal(ledger.checkAndReserve(20).ok, false, 'day 1: 90+20 crosses the ceiling');
  // advance the (injected) clock past the day boundary.
  clock = DAY2;
  const nextDay = ledger.checkAndReserve(90);
  assert.equal(nextDay.ok, true, 'day 2: the running total reset to 0 → a 90 reserve fits again');
  assert.equal(nextDay.totalReserved, 90, 'day 2 total starts from 0 + 90');
});

test('spend-ledger: the persisted store holds ONLY { date, totalReserved, ceiling } — no finance PII', () => {
  const filePath = tempLedgerPath();
  const ledger = createSpendLedger({ now: () => DAY1, filePath, ceiling: 100 });
  ledger.checkAndReserve(25);
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepEqual(
    Object.keys(raw).sort(),
    ['ceiling', 'date', 'totalReserved'],
    'persisted shape has EXACTLY these three keys — no memos/transactions/PII',
  );
  // explicit negative assertions for the obvious PII field names.
  for (const forbidden of ['amount', 'memo', 'transactions', 'merchant', 'card', 'account']) {
    assert.equal(forbidden in raw, false, `the store must NOT contain a "${forbidden}" field`);
  }
});

test('spend-ledger: the in-memory test ledger has the same atomic semantics (harness sanity)', () => {
  const mem = memoryLedger(100);
  assert.equal(mem.checkAndReserve(70).ok, true);
  assert.equal(mem.checkAndReserve(70).ok, false, 'second reserve crossing the ceiling is rejected');
  assert.equal(mem.total(), 70, 'only the first reserve is held');
});
