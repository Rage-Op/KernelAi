/**
 * build-stamp.test.ts (MAINT-04) — the stale-build guard. Pure logic + the dev-safety guarantee:
 * with no stamp file (dev/test) the daemon is NEVER considered stale and never auto-exits.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readStampFrom, stampsDiffer, isStale, exitIfStale } from './build-stamp.js';

test('readStampFrom: an absent or malformed file yields the dev stamp', () => {
  assert.deepEqual(readStampFrom('/no/such/stamp.json'), { builtAt: 'dev', git: 'nogit' });
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kbs-'));
  const bad = path.join(dir, 'bad.json');
  writeFileSync(bad, 'not json{');
  assert.deepEqual(readStampFrom(bad), { builtAt: 'dev', git: 'nogit' });
});

test('readStampFrom: a valid stamp parses', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kbs-'));
  const f = path.join(dir, 's.json');
  writeFileSync(f, JSON.stringify({ builtAt: '2026-06-24T00:00:00.000Z', git: 'abc123' }));
  assert.deepEqual(readStampFrom(f), { builtAt: '2026-06-24T00:00:00.000Z', git: 'abc123' });
});

test('stampsDiffer: compares builtAt and git', () => {
  const a = { builtAt: 't1', git: 'g1' };
  assert.equal(stampsDiffer(a, { builtAt: 't1', git: 'g1' }), false);
  assert.equal(stampsDiffer(a, { builtAt: 't2', git: 'g1' }), true);
  assert.equal(stampsDiffer(a, { builtAt: 't1', git: 'g2' }), true);
});

test('isStale + exitIfStale: in dev/test (no stamp) it is never stale and never exits', () => {
  assert.equal(isStale(), false, 'no build stamp present → never stale');
  let exited = false;
  exitIfStale({ warn: () => {} }, ((): never => {
    exited = true;
    return undefined as never;
  }));
  assert.equal(exited, false, 'a non-stale daemon never exits');
});
