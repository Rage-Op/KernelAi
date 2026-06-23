/**
 * context-cmd.test.ts — the `context` report built from injectReport().
 *
 * Scaffolds a temp memory dir (IDENTITY + current.md + retrievable knowledge) and asserts the
 * report names each segment, shows the assembled total against the cap, and lists an excluded
 * external doc as quarantined (never injected).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runContextReport } from './context-cmd.js';

function makeMemoryDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-ctxcmd-'));
  fs.writeFileSync(path.join(dir, 'IDENTITY.md'), '# IDENTITY\n\nKERNEL is Pravin. Terse.\n', 'utf8');
  fs.mkdirSync(path.join(dir, 'working-memory', 'quarantine'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'working-memory', 'current.md'),
    '# Current\n\nBuilding the meta-command suite for kernel context usage.\n',
    'utf8',
  );
  for (const d of ['knowledge', 'tasks', 'projects', 'logs', 'self']) {
    fs.mkdirSync(path.join(dir, d), { recursive: true });
  }
  // A trusted, matching knowledge doc (should be INCLUDED).
  fs.writeFileSync(
    path.join(dir, 'knowledge', 'kernel-notes.md'),
    '---\nsource: self\n---\nkernel context usage notes that match the query.\n',
    'utf8',
  );
  // An external-sourced doc (should be reported as EXCLUDED / quarantined).
  fs.writeFileSync(
    path.join(dir, 'knowledge', 'external-note.md'),
    '---\nsource: external\norigin: email\n---\nkernel context usage from an untrusted email.\n',
    'utf8',
  );
  return dir;
}

test('context report names each segment and shows the assembled total vs cap', async () => {
  const dir = makeMemoryDir();
  const report = await runContextReport(dir);

  assert.match(report, /KERNEL · context/);
  assert.match(report, /IDENTITY\.md/);
  assert.match(report, /working memory/);
  assert.match(report, /assembled total/);
  assert.match(report, /16,384/); // the cap is shown
  assert.match(report, /tok/); // token estimates present
  assert.match(report, /Model window/);
});

test('an external doc is reported as excluded (quarantined), never injected', async () => {
  const dir = makeMemoryDir();
  const report = await runContextReport(dir);
  // The external note must surface under skipped with the quarantine reason.
  assert.match(report, /external-note\.md/);
  assert.match(report, /quarantined/i);
});
