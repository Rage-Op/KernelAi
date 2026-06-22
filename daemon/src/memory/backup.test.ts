/**
 * backup.test.ts (MAINT-01, Pitfall 3/5 — the finance leak).
 *
 * EVERY test runs the WHOLE flow against a TEMP git repo + a TEMP bare "remote" (the temp-git-repo
 * factory from safety/leak-test-helpers.ts) — NEVER a real GitHub remote, NEVER a real push. A git
 * runner SPY wraps the real git so the test asserts the exact argv of every git invocation (the
 * explicit-add invariant: the staged argv NEVER contains -A/-f/. ).
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runBackup, defaultGitRunner, BACKUP_PATHS } from './backup.js';
import {
  makeTempGitRepo,
  cleanupTempRepo,
  writeRepoFile,
  git,
} from '../safety/leak-test-helpers.js';

const repos: string[] = [];
afterEach(() => {
  while (repos.length) cleanupTempRepo(repos.pop()!);
});

/** Path to the canonical pre-push hook source the daemon installs into the real kernel-memory repo. */
function hookSource(): string {
  // src/memory/ → repo root is three levels up; the hook script lives under daemon/scripts/hooks.
  const here = path.dirname(new URL(import.meta.url).pathname);
  return path.resolve(here, '..', '..', 'scripts', 'hooks', 'kernel-memory-pre-push.sh');
}

/** Install the project's pre-push hook into a temp repo (copy + chmod +x). */
function installHook(repoDir: string): void {
  const dst = path.join(repoDir, '.git', 'hooks', 'pre-push');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(hookSource(), dst);
  fs.chmodSync(dst, 0o755);
}

/** Create a temp BARE repo to act as the push "remote" (never a real GitHub). Returns its path. */
function makeBareRemote(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-mem-remote-'));
  repos.push(dir);
  git(dir, ['init', '--bare', '-q']);
  return dir;
}

/** A fully-wired memory repo: temp git repo + hook installed + bare remote added + seeded content. */
function makeMemoryRepoWithRemote(): { repo: string; remote: string } {
  const repo = makeTempGitRepo('kernel-mem-backup-');
  repos.push(repo);
  installHook(repo);
  const remote = makeBareRemote();
  git(repo, ['remote', 'add', 'origin', remote]);
  // Seed a couple of allowlist paths so there is something to stage/commit/push.
  fs.writeFileSync(path.join(repo, 'IDENTITY.md'), '# IDENTITY\nI am KERNEL.\n');
  writeRepoFile(repo, 'knowledge/durable.md', '---\nsource: user\n---\nA durable, vetted fact.\n');
  writeRepoFile(repo, 'self/changelog.md', '# Changelog\n\n- **2026-06-22** — backup wired.\n');
  return { repo, remote };
}

/** A spy git runner that records every argv and delegates to the real git. */
function spyGit(): { run: (repoDir: string, args: string[]) => string; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run(repoDir: string, args: string[]): string {
      calls.push(args);
      return defaultGitRunner(repoDir, args);
    },
  };
}

test('CRITICAL INVARIANT: the staged git argv uses explicit paths ONLY (never -A/-f/.) and never finance/', async () => {
  const { repo } = makeMemoryRepoWithRemote();
  const spy = spyGit();

  const result = await runBackup(repo, { git: spy.run });

  // Find the `add` invocation and assert it is explicit-only.
  const addCalls = spy.calls.filter((a) => a[0] === 'add');
  assert.equal(addCalls.length, 1, 'exactly one git add invocation');
  const addArgv = addCalls[0];
  for (const forbidden of ['-A', '-f', '--all', '--force', '.']) {
    assert.ok(!addArgv.includes(forbidden), `git add argv must NOT contain '${forbidden}': ${JSON.stringify(addArgv)}`);
  }
  // The staged paths are a subset of the allowlist; finance is never among them.
  assert.ok(!addArgv.some((p) => /finance/i.test(p)), 'finance/ is never staged');
  for (const p of result.staged) assert.ok(BACKUP_PATHS.includes(p), `${p} must be in the allowlist`);
  assert.ok(result.pushed, 'the push ran against the temp bare remote');
});

test('CRITICAL INVARIANT: a deliberately-staged fake finance/ file aborts the backup (no push)', async () => {
  const { repo } = makeMemoryRepoWithRemote();
  // Sneak a finance-pathed file into the index using a forced add (the very thing backup forbids),
  // simulating an out-of-band leak. The backup must DETECT it via assertFinanceNotTracked and abort.
  writeRepoFile(repo, 'finance/leak.txt', 'balance $1,234.56\n');
  git(repo, ['add', '-f', 'finance/leak.txt']);

  const spy = spyGit();
  await assert.rejects(
    () => runBackup(repo, { git: spy.run }),
    /finance/i,
    'a tracked finance path must abort the backup',
  );
  // The abort happens before push: there is no `push` invocation.
  assert.ok(!spy.calls.some((a) => a[0] === 'push'), 'NO push happens when finance is tracked');
});

test('backup FAILS LOUD when no remote is configured', async () => {
  const repo = makeTempGitRepo('kernel-mem-noremote-');
  repos.push(repo);
  installHook(repo); // hook present, but NO remote
  fs.writeFileSync(path.join(repo, 'IDENTITY.md'), '# IDENTITY\n');

  const spy = spyGit();
  await assert.rejects(
    () => runBackup(repo, { git: spy.run }),
    /no 'origin' remote/i,
    'an absent remote must fail loud',
  );
  assert.ok(!spy.calls.some((a) => a[0] === 'push'), 'NO push without a remote');
});

test('backup FAILS LOUD when the pre-push hook is absent', async () => {
  const repo = makeTempGitRepo('kernel-mem-nohook-');
  repos.push(repo);
  const remote = makeBareRemote();
  git(repo, ['remote', 'add', 'origin', remote]); // remote present, but NO hook installed
  fs.writeFileSync(path.join(repo, 'IDENTITY.md'), '# IDENTITY\n');

  const spy = spyGit();
  await assert.rejects(
    () => runBackup(repo, { git: spy.run }),
    /pre-push hook is not installed/i,
    'an absent pre-push hook must fail loud',
  );
  assert.ok(!spy.calls.some((a) => a[0] === 'push'), 'NO push without the hook');
});

test('backup pushes to the TEMP bare remote and the remote contains the memory paths but NOT finance/', async () => {
  const { repo, remote } = makeMemoryRepoWithRemote();
  await runBackup(repo, {});

  // Inspect the bare remote's tracked tree (HEAD of the pushed branch).
  const branch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const tracked = git(remote, ['ls-tree', '-r', '--name-only', branch]);
  assert.match(tracked, /IDENTITY\.md/);
  assert.match(tracked, /knowledge\/durable\.md/);
  assert.ok(!/finance/i.test(tracked), 'finance/ never reaches the remote');
});
