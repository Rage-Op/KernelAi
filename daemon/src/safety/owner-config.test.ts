/**
 * owner-config.test.ts (SAFE-08) — the owner-configurable safety posture: persist/restore to a
 * tmp file (never the real Application Support dir), partial one-toggle-at-a-time updates, the
 * getters the breaker/server read, and the CRITICAL sync of the live gate flag (FLAGS.breakerEnabled)
 * the gate consults. FLAGS is a process-shared global, so every test restores it in a finally/after.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  applyOwnerConfig,
  ownerConfig,
  dailySpendCeiling,
  defaultOverrideTtlMs,
  loadPersistedOwnerConfig,
  restoreOwnerConfig,
  __setOwnerConfigPathForTest,
} from './owner-config.js';
import { FLAGS } from './flags.js';

const tmpdirs: string[] = [];
const flagBefore = FLAGS.breakerEnabled;

function tmpConfigFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-ownercfg-'));
  tmpdirs.push(dir);
  return path.join(dir, 'safety-config.json');
}

afterEach(() => {
  __setOwnerConfigPathForTest(null);
  FLAGS.breakerEnabled = flagBefore; // restore the shared gate flag
  // leave the in-memory config in a known baseline for the next test
  applyOwnerConfig({ breakerEnabled: flagBefore, dailySpendCeiling: 0, defaultTtlMs: 600_000 }, false);
  while (tmpdirs.length) {
    const d = tmpdirs.pop()!;
    if (d.startsWith(os.tmpdir())) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('applyOwnerConfig merges fields, syncs FLAGS.breakerEnabled, and persists to disk', () => {
  const file = tmpConfigFile();
  __setOwnerConfigPathForTest(file);

  applyOwnerConfig({ breakerEnabled: true, dailySpendCeiling: 25, defaultTtlMs: 120_000 });

  assert.deepEqual(ownerConfig(), { breakerEnabled: true, dailySpendCeiling: 25, defaultTtlMs: 120_000 });
  assert.equal(FLAGS.breakerEnabled, true, 'the live gate flag is synced ON');
  assert.equal(dailySpendCeiling(), 25);
  assert.equal(defaultOverrideTtlMs(), 120_000);
  assert.ok(fs.existsSync(file), 'the choice is persisted');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    breakerEnabled: true,
    dailySpendCeiling: 25,
    defaultTtlMs: 120_000,
  });
});

test('a partial update changes only the provided field (one toggle at a time)', () => {
  __setOwnerConfigPathForTest(tmpConfigFile());
  applyOwnerConfig({ breakerEnabled: true, dailySpendCeiling: 50, defaultTtlMs: 300_000 });

  applyOwnerConfig({ dailySpendCeiling: 99 }); // change ONLY the ceiling

  assert.equal(ownerConfig().dailySpendCeiling, 99);
  assert.equal(ownerConfig().breakerEnabled, true, 'unrelated fields untouched');
  assert.equal(ownerConfig().defaultTtlMs, 300_000, 'unrelated fields untouched');
});

test('turning the breaker OFF syncs FLAGS.breakerEnabled to false (deny-Red posture restored)', () => {
  __setOwnerConfigPathForTest(tmpConfigFile());
  applyOwnerConfig({ breakerEnabled: true });
  assert.equal(FLAGS.breakerEnabled, true);
  applyOwnerConfig({ breakerEnabled: false });
  assert.equal(FLAGS.breakerEnabled, false, 'flag follows the owner toggle back to OFF');
});

test('negative ceilings are clamped to 0', () => {
  __setOwnerConfigPathForTest(tmpConfigFile());
  applyOwnerConfig({ dailySpendCeiling: -10 });
  assert.equal(dailySpendCeiling(), 0);
});

test('restoreOwnerConfig re-applies a persisted choice and syncs the flag (persisted wins over env)', () => {
  const file = tmpConfigFile();
  __setOwnerConfigPathForTest(file);
  // simulate a prior session having persisted "breaker ON, ceiling 40"
  fs.writeFileSync(file, JSON.stringify({ breakerEnabled: true, dailySpendCeiling: 40, defaultTtlMs: 200_000 }));
  // reset the live state to the safe default, as if freshly booted
  applyOwnerConfig({ breakerEnabled: false, dailySpendCeiling: 0, defaultTtlMs: 600_000 }, false);

  restoreOwnerConfig();

  assert.equal(ownerConfig().breakerEnabled, true);
  assert.equal(ownerConfig().dailySpendCeiling, 40);
  assert.equal(FLAGS.breakerEnabled, true, 'restore syncs the live gate flag');
});

test('loadPersistedOwnerConfig returns null for an absent or corrupt file', () => {
  __setOwnerConfigPathForTest(tmpConfigFile()); // file does not exist yet
  assert.equal(loadPersistedOwnerConfig(), null, 'absent → null');
  const file = tmpConfigFile();
  __setOwnerConfigPathForTest(file);
  fs.writeFileSync(file, 'not json {');
  assert.equal(loadPersistedOwnerConfig(), null, 'corrupt → null');
});

test('restoreOwnerConfig with nothing persisted keeps the live posture and still syncs the flag', () => {
  __setOwnerConfigPathForTest(tmpConfigFile()); // absent file
  applyOwnerConfig({ breakerEnabled: false }, false);
  restoreOwnerConfig(); // no persisted choice → keep current, sync flag
  assert.equal(FLAGS.breakerEnabled, false, 'flag reflects the (default-OFF) live posture');
});
