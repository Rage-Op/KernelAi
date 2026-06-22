/**
 * leakguard.test.ts (FIN-04d) — the startup git ls-files | grep finance assertion.
 *
 * assertFinanceNotTracked(memoryDir) wraps `git -C <dir> ls-files | grep -i finance` and FAILS
 * LOUD (throws) if anything finance-pathed is tracked, so the daemon refuses to start when the
 * existential leak has already happened. This is layer (d) of the 4-layer stack, isolated as a
 * directly-tested reusable module (index.ts delegates to it).
 *
 * Uses a temp git repo fixture so it NEVER mutates the real kernel-memory/ repo.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { assertFinanceNotTracked } from './leakguard.js';
import { makeTempGitRepo, cleanupTempRepo, writeRepoFile, git } from '../../test/helpers/temp-git-repo.js';

const repos: string[] = [];
afterEach(() => {
  while (repos.length) cleanupTempRepo(repos.pop()!);
});

test('leakguard: a clean repo (nothing finance-tracked) passes', () => {
  const dir = makeTempGitRepo();
  repos.push(dir);
  // a normal tracked file, no finance.
  writeRepoFile(dir, 'knowledge/notes.md', 'hello');
  git(dir, ['add', 'knowledge/notes.md']);
  git(dir, ['commit', '-q', '-m', 'add notes']);
  assert.doesNotThrow(() => assertFinanceNotTracked(dir));
});

test('leakguard (FIN-04d): a planted TRACKED finance path makes the assertion throw (fail loud)', () => {
  const dir = makeTempGitRepo();
  repos.push(dir);
  // Force-track a finance file (simulating the leak the gitignore would normally prevent).
  writeRepoFile(dir, 'finance/finance.db', 'fake-ciphertext');
  git(dir, ['add', '-f', 'finance/finance.db']);
  git(dir, ['commit', '-q', '-m', 'OOPS tracked finance']);
  assert.throws(() => assertFinanceNotTracked(dir), /finance|MEM-06|CRITICAL/i);
});

test('leakguard: a non-git directory is tolerated (no throw — greenfield/test)', () => {
  // a path that exists but is not a git repo: tolerated (the assertion only fails on a REAL track).
  assert.doesNotThrow(() => assertFinanceNotTracked('/'));
});
