/**
 * safety/leak-test-helpers.ts — a reusable temp git-repo fixture for the finance-leak tests.
 *
 * The leak tests (layers b + d) MUST NOT mutate the real kernel-memory/ repo (Pitfall 2:
 * kernel-memory/ is its OWN git repo). They operate on a throwaway repo created here, exactly
 * mirroring a kernel-memory-style layout (a finance/ dir + the pre-push hook). Each helper
 * returns absolute paths and never touches anything outside its tmpdir.
 *
 * Lives under src/ (not test/) so both src-tests and test/-tests can import it without crossing
 * the build rootDir; it is test-only and never imported by production code.
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
 * deterministic identity + an initial commit so HEAD exists for diffs/ranges. NO remote.
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
