/**
 * audit.test.ts — append + readback of the append-only audit log, and the SAFE projection the
 * Activity view receives (tool/outcome/ts ONLY — never the content hash, args, or finance amount, V7).
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { appendAudit, readAudit, type AuditEntry } from './audit.js';

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length) {
    const d = tmpdirs.pop()!;
    if (d.startsWith(os.tmpdir())) fs.rmSync(d, { recursive: true, force: true });
  }
});

function tmpAuditFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-audit-'));
  tmpdirs.push(dir);
  return path.join(dir, 'audit-log');
}

test('readAudit returns the SAFE projection only — never hash/args (V7)', () => {
  const file = tmpAuditFile();
  const entry: AuditEntry = {
    call: { tool: 'shell', args: { command: 'rm -rf /tmp/x', secret: 'tvly-LEAK' } },
    outcome: 'executed',
    hash: 'deadbeefcafe',
    ts: '2026-06-24T10:00:00.000Z',
  };
  appendAudit(entry, file);

  const view = readAudit(file);
  assert.equal(view.length, 1);
  assert.deepEqual(view[0], { tool: 'shell', outcome: 'executed', ts: '2026-06-24T10:00:00.000Z' });
  // the args + hash never appear in the projection
  const serialized = JSON.stringify(view);
  assert.doesNotMatch(serialized, /tvly-LEAK/, 'args never surface');
  assert.doesNotMatch(serialized, /deadbeefcafe/, 'hash never surfaces');
});

test('readAudit is oldest→newest, limit-capped, and skips corrupt lines', () => {
  const file = tmpAuditFile();
  for (let i = 0; i < 5; i++) {
    appendAudit({ call: { tool: `t${i}` }, outcome: 'denied', ts: `2026-06-24T0${i}:00:00.000Z` }, file);
  }
  fs.appendFileSync(file, 'this is not json\n'); // a corrupt line

  const view = readAudit(file, 3);
  assert.equal(view.length, 3, 'capped to the limit');
  assert.deepEqual(view.map((v) => v.tool), ['t2', 't3', 't4'], 'the 3 MOST RECENT, in order');
});

test('readAudit on an absent log returns []', () => {
  assert.deepEqual(readAudit(path.join(os.tmpdir(), 'kernel-no-such-audit-log')), []);
});
