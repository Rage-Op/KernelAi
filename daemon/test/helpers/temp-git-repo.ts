/**
 * test/helpers/temp-git-repo.ts — a reusable temp git-repo fixture for the finance-leak tests.
 *
 * The leak tests (layers b + d) MUST NOT mutate the real kernel-memory/ repo (Pitfall 2:
 * kernel-memory/ is its OWN git repo). They operate on a throwaway repo created here, exactly
 * mirroring a kernel-memory-style layout (a finance/ dir + the seeded .gitignore + the pre-push
 * hook). Each helper returns absolute paths and never touches anything outside its tmpdir.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Run git in the given repo dir, returning trimmed stdout (throws on non-zero by default). */
export function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

/**
 * Create a fresh, isolated git repo in a tmpdir and return its absolute path. The repo has a
 * deterministic identity + an initial empty commit so HEAD exists for diffs/ranges. NO remote.
 */
export function makeTempGitRepo(prefix = 'kernel-mem-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@kernel.local']);
  git(dir, ['config', 'user.name', 'kernel-test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  // an initial commit so a "previous" ref exists (the pre-push range needs a base sha).
  fs.writeFileSync(path.join(dir, 'README.md'), '# temp kernel-memory style repo\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

/** rm -rf the temp repo dir (best-effort cleanup; safe — only ever a tmpdir we made). */
export function cleanupTempRepo(dir: string): void {
  if (dir && dir.startsWith(os.tmpdir())) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Write a file (creating parent dirs) inside the repo. Path is relative to the repo root. */
export function writeRepoFile(dir: string, relPath: string, contents: string): string {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
  return abs;
}

/** The repo-relative path to the project's pre-push hook source (installed into temp repos). */
export function preprushHookSourcePath(): string {
  // daemon/test/helpers/ → repo root is three levels up; the hook lives in kernel-memory/.git/hooks.
  // For installation into temp repos we read the canonical script from the repo file used to
  // generate the real hook (kept in sync by Task 3). Resolve relative to this file.
  const here = path.dirname(new URL(import.meta.url).pathname);
  return path.resolve(here, '..', '..', '..', 'kernel-memory', '.git', 'hooks', 'pre-push');
}
