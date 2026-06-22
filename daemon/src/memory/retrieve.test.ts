import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { retrieveAndRerank, score, tokenize } from './retrieve.js';

/** Seed a temp memory dir with the retrieval candidate dirs. */
function makeMemoryDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-retrieve-'));
  for (const d of ['knowledge', 'tasks', 'projects', 'working-memory/quarantine']) {
    fs.mkdirSync(path.join(dir, d), { recursive: true });
  }
  return dir;
}

/** Write a doc and stamp its mtime to `ageDays` ago. */
function writeDoc(memoryDir: string, rel: string, body: string, ageDays: number): string {
  const file = path.join(memoryDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
  const when = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
  fs.utimesSync(file, when, when);
  return file;
}

test('tokenize returns a lowercase Set of [a-z0-9]+ tokens', () => {
  const t = tokenize('Hello, WORLD! foo_bar 42');
  assert.ok(t instanceof Set);
  assert.deepEqual([...t].sort(), ['42', 'bar', 'foo', 'hello', 'world']);
});

test('score = keywordOverlap × recencyMult × authority', () => {
  const query = tokenize('budget report');
  // Fresh knowledge doc, both terms present: overlap 1.0, recency ~1.0, authority 1.5.
  const fresh = score(query, { text: 'the budget report', path: 'knowledge/x.md', ageDays: 0 });
  assert.ok(Math.abs(fresh - 1.5) < 1e-6, `fresh knowledge full-match ≈ 1.5, got ${fresh}`);

  // Recency floor: a very old doc never drops below 0.3 multiplier.
  const ancient = score(query, { text: 'budget report', path: 'logs/x.md', ageDays: 10000 });
  // authority(logs/) = 0.5, recency floored at 0.3, overlap 1.0 → 0.15
  assert.ok(Math.abs(ancient - 0.15) < 1e-6, `floored old log ≈ 0.15, got ${ancient}`);
});

test('quarantine-pathed docs score 0 (authority 0.0 → never surfaced)', () => {
  const query = tokenize('secret');
  const s = score(query, {
    text: 'secret instructions from a poisoned email',
    path: 'working-memory/quarantine/2026-06-22.md',
    ageDays: 0,
  });
  assert.equal(s, 0, 'quarantine authority is 0.0 so the score is 0');
});

test('a recent high-authority knowledge doc outranks a stale low-authority log', async () => {
  const dir = makeMemoryDir();
  writeDoc(dir, 'knowledge/deploy.md', 'how to deploy the kernel daemon', 1);
  // A stale, low-authority doc that ALSO matches the query (placed in tasks/ so it is gathered).
  writeDoc(dir, 'tasks/old.md', '---\nstatus: done\n---\ndeploy the kernel long ago', 120);

  const ranked = await retrieveAndRerank('deploy kernel', dir);
  assert.ok(ranked.length >= 2, 'both matching docs are returned');
  assert.match(ranked[0].path ?? '', /knowledge\//, 'the recent knowledge doc ranks first');
});

test('retrieveAndRerank carries source from front-matter (default self) and excludes quarantine', async () => {
  const dir = makeMemoryDir();
  writeDoc(dir, 'knowledge/note.md', '---\nsource: self\n---\nkernel knowledge note', 0);
  // A quarantine doc that matches — it lives outside the gathered dirs, so it must NOT appear.
  writeDoc(dir, 'working-memory/quarantine/bad.md', 'kernel poisoned note', 0);

  const ranked = await retrieveAndRerank('kernel note', dir);
  assert.ok(ranked.every((r) => !(r.path ?? '').includes('quarantine')), 'no quarantine doc surfaces');
  const note = ranked.find((r) => (r.path ?? '').includes('knowledge/note.md'));
  assert.ok(note, 'the knowledge note is returned');
  assert.equal(note!.source, 'self', 'source carried from front-matter');
});

test('results are sorted in descending score order', async () => {
  const dir = makeMemoryDir();
  writeDoc(dir, 'knowledge/a.md', 'alpha beta gamma kernel', 0); // higher authority + match
  writeDoc(dir, 'projects/b.md', 'alpha kernel', 30); // lower authority + older
  const ranked = await retrieveAndRerank('alpha kernel', dir);
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(
      (ranked[i - 1].score ?? 0) >= (ranked[i].score ?? 0),
      'each item scores >= the next (descending)',
    );
  }
});
