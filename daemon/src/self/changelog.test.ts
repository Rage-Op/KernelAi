/**
 * changelog.test.ts (MAINT-02). Runs against a throwaway tmpdir memory repo.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { appendChangelog } from './changelog.js';

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length) {
    const d = tmpdirs.pop()!;
    if (d.startsWith(os.tmpdir())) fs.rmSync(d, { recursive: true, force: true });
  }
});

function makeMemoryDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-changelog-'));
  tmpdirs.push(dir);
  fs.writeFileSync(path.join(dir, 'IDENTITY.md'), '# IDENTITY\n');
  return dir;
}

test('appendChangelog seeds a header when the file is absent and appends a dated entry', () => {
  const dir = makeMemoryDir();
  appendChangelog('consolidation promoted 2 facts', dir);

  const text = fs.readFileSync(path.join(dir, 'self', 'changelog.md'), 'utf8');
  assert.match(text, /^# Changelog/);
  assert.match(text, /consolidation promoted 2 facts/);
  const date = new Date().toISOString().slice(0, 10);
  assert.match(text, new RegExp(`\\*\\*${date}\\*\\*`));
});

test('appendChangelog is append-only — a second call adds a new line, prior content intact', () => {
  const dir = makeMemoryDir();
  appendChangelog('first entry', dir);
  const after1 = fs.readFileSync(path.join(dir, 'self', 'changelog.md'), 'utf8');
  appendChangelog('second entry', dir);
  const after2 = fs.readFileSync(path.join(dir, 'self', 'changelog.md'), 'utf8');

  assert.ok(after2.startsWith(after1), 'prior content must be preserved verbatim (append-only)');
  assert.match(after2, /first entry/);
  assert.match(after2, /second entry/);
});

test('appendChangelog never targets IDENTITY.md', () => {
  const dir = makeMemoryDir();
  // The writer targets self/changelog.md; assert the guard makes IDENTITY.md unreachable by
  // confirming IDENTITY.md is unchanged after a write.
  const identityBefore = fs.readFileSync(path.join(dir, 'IDENTITY.md'));
  appendChangelog('a change', dir);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'IDENTITY.md')), identityBefore);
});
