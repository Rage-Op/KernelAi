/**
 * prune.test.ts (MEM-07 cleanup).
 *
 * Runs against a throwaway tmpdir memory repo. Proves stale working-memory + old logs are pruned
 * while IDENTITY.md, knowledge/, finance/, and working-memory/current.md are untouched.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCleanup, DEFAULT_RETENTION_DAYS } from './prune.js';

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length) {
    const d = tmpdirs.pop()!;
    if (d.startsWith(os.tmpdir())) fs.rmSync(d, { recursive: true, force: true });
  }
});

/** Set a file's mtime `days` into the past so it reads as stale. */
function ageFile(file: string, days: number): void {
  const when = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  fs.utimesSync(file, when, when);
}

function makeMemoryDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-prune-'));
  tmpdirs.push(dir);
  fs.writeFileSync(path.join(dir, 'IDENTITY.md'), '# IDENTITY\nI am KERNEL.\n');
  for (const sub of [
    'logs',
    'knowledge',
    'finance',
    path.join('working-memory', 'reflections'),
    path.join('working-memory', 'quarantine'),
  ]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, 'working-memory', 'current.md'), '# Current\nlive scratchpad\n');
  return dir;
}

test('cleanup prunes stale working-memory + old logs past the retention window', async () => {
  const dir = makeMemoryDir();

  const stale = [
    path.join(dir, 'logs', '2020-01-01.md'),
    path.join(dir, 'working-memory', 'reflections', '2020-01-02.md'),
    path.join(dir, 'working-memory', 'quarantine', '2020-01-03-deadbeef.md'),
  ];
  for (const f of stale) {
    fs.writeFileSync(f, 'stale content\n');
    ageFile(f, DEFAULT_RETENTION_DAYS + 10);
  }

  // A fresh log inside the window must survive.
  const fresh = path.join(dir, 'logs', '2026-06-22.md');
  fs.writeFileSync(fresh, 'fresh content\n');

  const result = await runCleanup(dir);

  assert.equal(result.pruned, 3, 'all three stale files pruned');
  for (const f of stale) assert.ok(!fs.existsSync(f), `${f} must be pruned`);
  assert.ok(fs.existsSync(fresh), 'a fresh log within the window must survive');
});

test('cleanup leaves IDENTITY.md, knowledge/, finance/, and current.md UNTOUCHED', async () => {
  const dir = makeMemoryDir();

  // Even if these are "old", cleanup must never enumerate or prune them.
  const identity = path.join(dir, 'IDENTITY.md');
  const knowledge = path.join(dir, 'knowledge', 'durable.md');
  const finance = path.join(dir, 'finance', 'finance.db');
  const current = path.join(dir, 'working-memory', 'current.md');
  fs.writeFileSync(knowledge, '---\nsource: user\n---\nA durable fact.\n');
  fs.writeFileSync(finance, 'ENCRYPTED-FINANCE-BYTES');
  for (const f of [identity, knowledge, finance, current]) ageFile(f, DEFAULT_RETENTION_DAYS + 100);

  const identityBefore = fs.readFileSync(identity);
  const knowledgeBefore = fs.readFileSync(knowledge);
  const financeBefore = fs.readFileSync(finance);
  const currentBefore = fs.readFileSync(current);

  await runCleanup(dir);

  assert.deepEqual(fs.readFileSync(identity), identityBefore, 'IDENTITY.md untouched');
  assert.deepEqual(fs.readFileSync(knowledge), knowledgeBefore, 'knowledge/ untouched');
  assert.deepEqual(fs.readFileSync(finance), financeBefore, 'finance/ never even enumerated');
  assert.deepEqual(fs.readFileSync(current), currentBefore, 'working-memory/current.md untouched');
});

test('cleanup preserves .gitkeep so tracked dirs survive', async () => {
  const dir = makeMemoryDir();
  const gitkeep = path.join(dir, 'working-memory', 'reflections', '.gitkeep');
  fs.writeFileSync(gitkeep, '');
  ageFile(gitkeep, DEFAULT_RETENTION_DAYS + 50);

  await runCleanup(dir);
  assert.ok(fs.existsSync(gitkeep), '.gitkeep must be preserved');
});
