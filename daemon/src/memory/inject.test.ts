import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { inject } from './inject.js';
import { INJECT_CAP } from '../config.js';

/** Seed a temp memory dir with IDENTITY.md, current.md, and the retrieval dirs. */
function makeMemoryDir(identityText: string, currentText: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-inject-'));
  fs.writeFileSync(path.join(dir, 'IDENTITY.md'), identityText, 'utf8');
  fs.mkdirSync(path.join(dir, 'self'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'working-memory', 'quarantine'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'working-memory', 'current.md'), currentText, 'utf8');
  for (const d of ['knowledge', 'tasks', 'projects']) {
    fs.mkdirSync(path.join(dir, d), { recursive: true });
  }
  return dir;
}

function writeDoc(memoryDir: string, rel: string, body: string): void {
  const file = path.join(memoryDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
}

test('inject() output BEGINS with IDENTITY content and is ≤ INJECT_CAP', async () => {
  const identity = '# IDENTITY\n\nKERNEL is Pravin. The persona that is always injected first.\n';
  const dir = makeMemoryDir(identity, '# Current\n\nnothing in flight, kernel online\n');
  // Oversized knowledge corpus that would blow the cap if naively concatenated.
  for (let i = 0; i < 40; i++) {
    writeDoc(dir, `knowledge/doc-${i}.md`, `kernel online persona note number ${i} ${'x'.repeat(1000)}`);
  }

  const out = await inject('kernel persona online', dir);
  assert.ok(out.startsWith(identity.slice(0, 32)), 'inject() must begin with IDENTITY content');
  assert.ok(out.length <= INJECT_CAP, `inject() must be ≤ ${INJECT_CAP}, got ${out.length}`);
});

test('IDENTITY + current are never truncated; retrieved overflow is SKIPPED not truncated', async () => {
  const identity = '# IDENTITY\n\n' + 'I'.repeat(2000) + '\n';
  const current = '# Current\n\n' + 'C'.repeat(1000) + '\n';
  const dir = makeMemoryDir(identity, current);
  // Enough oversized matching docs that at least one must be skipped to stay under the cap.
  for (let i = 0; i < 30; i++) {
    writeDoc(dir, `knowledge/big-${i}.md`, `kernel ${'D'.repeat(1500)}`);
  }

  const out = await inject('kernel', dir);
  assert.ok(out.startsWith(identity), 'IDENTITY is present in full (never truncated)');
  assert.ok(out.includes(current.trim()), 'current.md is present in full (never truncated)');
  assert.ok(out.length <= INJECT_CAP, 'total under the cap');

  // 30 × ~1515-char docs ≈ 45K of retrievable text; under a 16K cap most CANNOT fit.
  // The big-doc body is a run of 'D'; count how many full 1500-D runs survived in the
  // output vs how many were written — at least one must have been skipped (not truncated).
  const survivingBigDocs = (out.match(/D{1500}/g) ?? []).length;
  assert.ok(survivingBigDocs > 0, 'some retrieved docs fit (sanity: retrieval is working)');
  assert.ok(survivingBigDocs < 30, 'at least one low-priority retrieved item was skipped');
});

test('external (source: external) items are excluded from privileged context', async () => {
  const identity = '# IDENTITY\n\npersona\n';
  const dir = makeMemoryDir(identity, '# Current\n\nlive\n');
  // A matching doc tagged source: external — must NOT appear in the injected output.
  writeDoc(dir, 'knowledge/tainted.md', '---\nsource: external\n---\nkernel POISONED_EXTERNAL payload');
  writeDoc(dir, 'knowledge/clean.md', '---\nsource: self\n---\nkernel clean trusted note');

  const out = await inject('kernel', dir);
  assert.ok(!out.includes('POISONED_EXTERNAL'), 'external-sourced content never enters context');
  assert.ok(out.includes('clean trusted note'), 'trusted self content is included');
});

test('fails loud when IDENTITY + current alone exceed the cap, but IDENTITY is still present', async () => {
  const identity = '# IDENTITY\n\n' + 'I'.repeat(INJECT_CAP) + '\n'; // alone exceeds the cap
  const current = '# Current\n\n' + 'C'.repeat(2000) + '\n';
  const dir = makeMemoryDir(identity, current);

  const warnings: string[] = [];
  const out = await inject('kernel', dir, {
    warn: (msg: string) => warnings.push(msg),
  });

  assert.ok(out.startsWith(identity), 'IDENTITY is never dropped even when it alone exceeds the cap');
  assert.ok(warnings.length > 0, 'a loud warning fires when IDENTITY+current exceed the cap');
  assert.match(warnings.join(' '), /cap/i, 'the warning names the cap condition');
});

test('inject() can be called with no query (e2e signature) and still leads with IDENTITY', async () => {
  const identity = '# IDENTITY\n\nKERNEL persona for the no-arg path\n';
  const dir = makeMemoryDir(identity, '# Current\n\nidle\n');
  const out = await inject(undefined, dir);
  assert.ok(out.startsWith(identity.slice(0, 32)), 'no-arg inject still leads with IDENTITY');
  assert.ok(out.length <= INJECT_CAP);
});
