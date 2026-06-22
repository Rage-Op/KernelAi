/**
 * metrics.test.ts (MAINT-02). Runs against a throwaway tmpdir memory repo.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeMetrics } from './metrics.js';

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length) {
    const d = tmpdirs.pop()!;
    if (d.startsWith(os.tmpdir())) fs.rmSync(d, { recursive: true, force: true });
  }
});

function makeMemoryDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-metrics-'));
  tmpdirs.push(dir);
  fs.writeFileSync(path.join(dir, 'IDENTITY.md'), '# IDENTITY\n');
  return dir;
}

test('writeMetrics writes self/metrics.md as a current snapshot with the supplied key/values', () => {
  const dir = makeMemoryDir();
  writeMetrics({ logsDistilled: 7, factsPromoted: 3, lastBackup: '2026-06-22T04:00:00Z' }, dir);

  const text = fs.readFileSync(path.join(dir, 'self', 'metrics.md'), 'utf8');
  assert.match(text, /^# Metrics/);
  assert.match(text, /logsDistilled \| 7/);
  assert.match(text, /factsPromoted \| 3/);
  assert.match(text, /lastBackup \| 2026-06-22T04:00:00Z/);
});

test('writeMetrics rewrites (snapshot semantics) — the second write replaces the first', () => {
  const dir = makeMemoryDir();
  writeMetrics({ runs: 1 }, dir);
  writeMetrics({ runs: 2 }, dir);
  const text = fs.readFileSync(path.join(dir, 'self', 'metrics.md'), 'utf8');
  assert.match(text, /runs \| 2/);
  assert.doesNotMatch(text, /runs \| 1/);
});

test('writeMetrics never targets IDENTITY.md', () => {
  const dir = makeMemoryDir();
  const identityBefore = fs.readFileSync(path.join(dir, 'IDENTITY.md'));
  writeMetrics({ ok: true }, dir);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'IDENTITY.md')), identityBefore);
});
