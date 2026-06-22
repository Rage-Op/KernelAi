/**
 * Finance-safe GitHub backup (MAINT-01, Pitfall 3/5 — the finance leak).
 *
 * `runBackup` commits the memory repo and pushes it to the owner's private GitHub remote — but it
 * is built so finance/ bytes can NEVER leave the machine. Four code-level safeguards:
 *
 *   1. EXPLICIT-ADD ONLY. Staging uses `git -C <repo> add <path1> <path2> ...` with an explicit
 *      allowlist of tracked memory paths. The argv NEVER contains `-A`, `-f`, `--all`, `--force`,
 *      or `.` (Pitfall 3 — a greedy add is the existential finance leak). finance/ is never in the
 *      allowlist, and self/spend-ledger.json + self/audit-log are gitignored machine-local state.
 *   2. assertFinanceNotTracked (leakguard.ts ls-files layer d) runs BEFORE the push. If anything
 *      finance-pathed is somehow tracked, it THROWS and no push happens.
 *   3. PRE-PUSH HOOK REQUIRED. The push is refused (THROW, fail loud) unless the shipped pre-push
 *      hook is installed at <repo>/.git/hooks/pre-push (defense-in-depth layer b).
 *   4. REMOTE REQUIRED. The push is refused (THROW) unless a remote is configured. There is no
 *      silent no-op — a misconfigured backup fails loud rather than leaking or pretending success.
 *
 * Git is shelled via `execFileSync` (the leakguard.ts/claude-code.ts convention — zero-dep, NOT
 * simple-git). The git runner + the memory dir are injectable so tests run the WHOLE flow against
 * a temp repo + a temp bare "remote" — never a real GitHub remote, never a real push.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { config } from '../config.js';
import { assertFinanceNotTracked } from '../safety/leakguard.js';
import { logger } from './log.js';

/**
 * The explicit allowlist of repo-relative memory paths the backup is allowed to stage. finance/
 * is deliberately ABSENT. self/spend-ledger.json + self/audit-log are gitignored (never staged).
 * `self/changelog.md` + `self/metrics.md` are staged (MAINT-02 honest record). Paths that do not
 * exist in a given repo are simply skipped (git add of a missing path would error).
 */
export const BACKUP_PATHS: readonly string[] = [
  'IDENTITY.md',
  'working-memory',
  'knowledge',
  'tasks',
  'projects',
  'logs',
  'self/changelog.md',
  'self/metrics.md',
];

/** Tokens that must NEVER appear in a `git add` argv (the greedy-add finance leak). */
const FORBIDDEN_ADD_TOKENS = new Set(['-A', '-f', '--all', '--force', '.']);

/** A git runner: run `git -C <repoDir> <args>` and return stdout. Injectable for tests. */
export type GitRunner = (repoDir: string, args: string[]) => string;

/** The default git runner — shells `git` via execFileSync (the leakguard convention). */
export const defaultGitRunner: GitRunner = (repoDir, args) =>
  execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' });

/** Injectable dependencies for runBackup (defaults wire the real git + a real commit message). */
export interface BackupDeps {
  /** The git runner (default: execFileSync-based). Tests inject a spy to capture every argv. */
  git?: GitRunner;
  /** The commit message (default: a dated backup message). */
  message?: string;
  /** The remote to push to (default: 'origin'). */
  remote?: string;
  /** The branch to push (default: the repo's current branch). */
  branch?: string;
}

/** Outcome of a backup run. */
export interface BackupResult {
  /** Repo-relative paths that were staged (a subset of BACKUP_PATHS that exist). */
  staged: string[];
  /** Whether a commit was created (false if there was nothing to commit). */
  committed: boolean;
  /** Whether the push ran. */
  pushed: boolean;
}

/** Assert a `git add` argv contains ONLY explicit paths — never a greedy/forced add token. */
function assertExplicitAddArgv(args: string[]): void {
  // args is the FULL git argv passed to the runner, e.g. ['add', '--', 'IDENTITY.md', ...].
  for (const tok of args) {
    if (FORBIDDEN_ADD_TOKENS.has(tok)) {
      throw new Error(
        `CRITICAL: backup attempted a greedy/forced git add ('${tok}') — explicit paths ONLY ` +
          `(Pitfall 3, finance leak). argv=${JSON.stringify(args)}`,
      );
    }
  }
}

/**
 * Run the finance-safe backup (MAINT-01).
 *
 * Stages the explicit allowlist, asserts finance is untracked, verifies the pre-push hook AND a
 * remote exist (else THROWS — fail loud), then commits + pushes. Returns the run outcome. Throws
 * on any safety violation rather than risking a leak.
 */
export async function runBackup(
  memoryDir: string = config.memoryDir,
  deps: BackupDeps = {},
): Promise<BackupResult> {
  const git = deps.git ?? defaultGitRunner;
  const remote = deps.remote ?? 'origin';
  const message =
    deps.message ?? `chore(backup): memory snapshot ${new Date().toISOString()}`;

  // (1) FAIL LOUD if the pre-push hook is absent (defense-in-depth layer b).
  const hookPath = path.join(memoryDir, '.git', 'hooks', 'pre-push');
  if (!fs.existsSync(hookPath)) {
    throw new Error(
      `CRITICAL: backup refused — the kernel-memory pre-push hook is not installed at ${hookPath}. ` +
        `Install it (cp daemon/scripts/hooks/kernel-memory-pre-push.sh ${hookPath} && chmod +x) before backing up.`,
    );
  }

  // (2) FAIL LOUD if no remote is configured (no silent no-op).
  let remoteUrl: string;
  try {
    remoteUrl = git(memoryDir, ['remote', 'get-url', remote]).trim();
  } catch {
    remoteUrl = '';
  }
  if (!remoteUrl) {
    throw new Error(
      `CRITICAL: backup refused — no '${remote}' remote is configured on the memory repo. ` +
        `Add it (git -C ${memoryDir} remote add ${remote} <private url>) before backing up.`,
    );
  }

  // (3) EXPLICIT-ADD ONLY. Stage the allowlist that actually exists, never -A/-f/'.'.
  const staged = BACKUP_PATHS.filter((p) => fs.existsSync(path.join(memoryDir, p)));
  if (staged.length > 0) {
    const addArgs = ['add', '--', ...staged];
    assertExplicitAddArgv(addArgs); // the argv guard — never a greedy token
    git(memoryDir, addArgs);
  }

  // (4) FINANCE ASSERTION (leakguard ls-files layer d) — throws if anything finance-pathed is
  //     tracked. Runs AFTER staging and BEFORE the push so a staged fake finance file aborts.
  assertFinanceNotTracked(memoryDir);

  // (5) Commit (tolerate "nothing to commit") then push.
  let committed = false;
  try {
    git(memoryDir, ['commit', '-m', message]);
    committed = true;
  } catch (err) {
    // `git commit` exits non-zero with nothing staged — that is not a backup failure.
    const out = err instanceof Error ? err.message : String(err);
    if (!/nothing to commit|no changes added/i.test(out)) throw err;
    logger.info({ event: 'backup.nothing_to_commit' }, 'backup: nothing new to commit');
  }

  const branch = deps.branch ?? git(memoryDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  git(memoryDir, ['push', remote, branch]);

  logger.info(
    { event: 'backup.run', remote, branch, staged: staged.length, committed },
    'backup pushed',
  );
  return { staged, committed, pushed: true };
}
