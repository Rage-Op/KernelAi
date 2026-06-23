/**
 * inject-report.test.ts — the structured breakdown behind the `context` command.
 *
 * injectReport() shares inject()'s code path, so this asserts the report's numbers are internally
 * consistent (fixed = identity + current + sep; total ≤ cap) and that an external doc is reported
 * as excluded (never injected into privileged context).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { inject, injectReport } from './inject.js';
import { INJECT_CAP } from '../config.js';

function makeMemoryDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-injreport-'));
  fs.writeFileSync(path.join(dir, 'IDENTITY.md'), '# IDENTITY\n\nKERNEL persona online.\n', 'utf8');
  fs.mkdirSync(path.join(dir, 'working-memory', 'quarantine'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'working-memory', 'current.md'), '# Current\n\nkernel persona scratchpad.\n', 'utf8');
  for (const d of ['knowledge', 'tasks', 'projects', 'self']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(path.join(dir, 'knowledge', 'a.md'), '---\nsource: self\n---\nkernel persona durable fact.\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'knowledge', 'ext.md'), '---\nsource: external\n---\nkernel persona from an email.\n', 'utf8');
  return dir;
}

test('injectReport: identity + current + cap are reported and total stays under the cap', async () => {
  const dir = makeMemoryDir();
  const report = await injectReport('kernel persona', dir);

  assert.equal(report.cap, INJECT_CAP);
  assert.ok(report.identityChars > 0, 'identity measured');
  assert.ok(report.currentChars > 0, 'current measured');
  assert.ok(report.totalChars <= INJECT_CAP, 'total under cap');
  assert.ok(report.fixedChars >= report.identityChars + report.currentChars, 'fixed includes both blocks');
  assert.equal(report.overCap, false);
});

test('injectReport totalChars matches inject() output length exactly (shared code path)', async () => {
  const dir = makeMemoryDir();
  const text = await inject('kernel persona', dir);
  const report = await injectReport('kernel persona', dir);
  assert.equal(report.totalChars, text.length, 'report total equals the actual assembled string length');
});

test('injectReport marks an external doc excluded (quarantined), never included', async () => {
  const dir = makeMemoryDir();
  const report = await injectReport('kernel persona', dir);
  const ext = report.retrieved.find((s) => s.path.endsWith('ext.md'));
  assert.ok(ext, 'external doc appears in the candidate list');
  assert.equal(ext?.included, false, 'external is never included');
  assert.match(ext?.reason ?? '', /external/i);
});
