/**
 * finance-leakguard.test.ts (FIN-04b) — the DELIBERATE-ABORT proof of the pre-push hook.
 *
 * Layer (b) of the 4-layer stack: kernel-memory/.git/hooks/pre-push must scan the BYTES being
 * pushed (the commit range git passes on stdin per the pre-push protocol) and ABORT (non-zero
 * exit) if a finance PATH or a finance-shaped VALUE (dollar amounts, account-number-shaped
 * strings) appears — even in a file whose path is NOT under finance/.
 *
 * The test creates a fresh temp git repo (Pitfall 2: NEVER the real kernel-memory/ repo nor the
 * project root), installs the project's hook, COMMITS a fake leak, and invokes the hook exactly
 * the way git invokes pre-push — feeding the proper
 *     <local ref> <local sha> <remote ref> <remote sha>
 * line on stdin so the hook scans the genuine commit range. Asserts NON-ZERO exit + abort
 * message on a leak; ZERO exit on a clean commit. Also asserts the REAL kernel-memory hook is
 * installed + executable.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  makeTempGitRepo,
  cleanupTempRepo,
  writeRepoFile,
  git,
} from './helpers/temp-git-repo.js';
import { config } from '../src/config.js';

const ZERO_SHA = '0000000000000000000000000000000000000000';
const repos: string[] = [];
afterEach(() => {
  while (repos.length) cleanupTempRepo(repos.pop()!);
});

/** Path to the canonical pre-push hook the daemon installs into the real kernel-memory repo. */
function realHookPath(): string {
  return path.join(config.memoryDir, '.git', 'hooks', 'pre-push');
}

/** Install the project's canonical pre-push hook into a temp repo (copy + chmod +x). */
function installHook(repoDir: string): string {
  const src = realHookPath();
  const dst = path.join(repoDir, '.git', 'hooks', 'pre-push');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  fs.chmodSync(dst, 0o755);
  return dst;
}

/**
 * Invoke the hook the way git invokes pre-push: argv = [remoteName, remoteUrl], and on stdin a
 * line "<local ref> <local sha> <remote ref> <remote sha>". The remote sha is ZERO (a brand-new
 * branch on the remote) so the hook scans the full local commit range.
 */
function runPrePush(repoDir: string): { status: number; stdout: string; stderr: string } {
  const hook = path.join(repoDir, '.git', 'hooks', 'pre-push');
  const localSha = git(repoDir, ['rev-parse', 'HEAD']);
  const stdin = `refs/heads/main ${localSha} refs/heads/main ${ZERO_SHA}\n`;
  const r = spawnSync(hook, ['origin', 'git@example.com:kernel/kernel-memory.git'], {
    cwd: repoDir,
    input: stdin,
    encoding: 'utf8',
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

test('the real kernel-memory pre-push hook is installed and executable (layer b in production)', () => {
  // This passes only AFTER Task 3 installs the hook in the real repo.
  const p = realHookPath();
  assert.ok(fs.existsSync(p), `pre-push hook must exist at ${p}`);
  const mode = fs.statSync(p).mode;
  assert.ok((mode & 0o111) !== 0, 'pre-push hook must be executable');
});

test('pre-push DELIBERATE-ABORT: a committed finance-pathed file aborts the push (non-zero)', () => {
  const dir = makeTempGitRepo();
  repos.push(dir);
  installHook(dir);
  // A fake finance leak: a finance/ path containing a dollar amount + an account-number string.
  writeRepoFile(
    dir,
    'finance/leak.txt',
    'statement: balance $1,234.56 on account 4012888888881881\n',
  );
  git(dir, ['add', '-f', 'finance/leak.txt']);
  git(dir, ['commit', '-q', '-m', 'leak']);

  const r = runPrePush(dir);
  assert.notEqual(r.status, 0, 'the hook must EXIT NON-ZERO on a finance-pathed leak');
  assert.match((r.stderr + r.stdout).toLowerCase(), /abort|finance|refus|block/);
});

test('pre-push DELIBERATE-ABORT: a finance-shaped VALUE in a NON-finance path also aborts', () => {
  const dir = makeTempGitRepo();
  repos.push(dir);
  installHook(dir);
  // No finance/ in the path — but the content carries a dollar amount + an account number.
  writeRepoFile(
    dir,
    'notes/budget.md',
    'My checking balance is $4,210.55 and the routing/account 123456789012 is on file.\n',
  );
  git(dir, ['add', 'notes/budget.md']);
  git(dir, ['commit', '-q', '-m', 'budget note']);

  const r = runPrePush(dir);
  assert.notEqual(r.status, 0, 'a finance-shaped value must abort even outside finance/');
  assert.match((r.stderr + r.stdout).toLowerCase(), /abort|finance|refus|block/);
});

test('pre-push CLEAN: an ordinary non-finance commit pushes (zero exit)', () => {
  const dir = makeTempGitRepo();
  repos.push(dir);
  installHook(dir);
  writeRepoFile(dir, 'knowledge/voice-profile.md', '# voice\nfriendly, short sentences, no emoji.\n');
  git(dir, ['add', 'knowledge/voice-profile.md']);
  git(dir, ['commit', '-q', '-m', 'add voice profile']);

  const r = runPrePush(dir);
  assert.equal(r.status, 0, `a clean commit must pass; stderr=${r.stderr}`);
});

test('pre-push hook contains no --no-verify and no blanket git add -A/-f (policy)', () => {
  const src = fs.readFileSync(realHookPath(), 'utf8');
  assert.equal(/--no-verify/.test(src), false, 'the hook must not reference --no-verify');
  assert.equal(/git add\s+(-A|-f|--all|--force)/.test(src), false, 'the hook must not blanket-add');
});
