/**
 * exec-policy.ts — the policy layer for KERNEL's "hands" (the filesystem `fs` and `shell` tools,
 * HANDS-06). It answers two questions WITHOUT executing anything:
 *
 *   1. classifyCommand(cmd) → which tier is a shell command? (so tiers.ts can route it green/yellow/red)
 *   2. path policy: is a path a SECRET we must never touch, and is a write/delete inside the WORKSPACE?
 *
 * Design fit (important): KERNEL already gates Red actions through the live circuit breaker (dry-run →
 * 10s cancel window → ceiling → TOCTOU → execute). So this module does NOT introduce a parallel
 * hard-deny gate for "dangerous" ops — destructive commands classify RED and flow through that proven
 * breaker (the owner's chosen "graduated" approval). It adds only the two guards the breaker can't:
 *   - a CATASTROPHIC denylist the `shell` tool refuses outright (unrecoverable/system-level: sudo,
 *     `rm -rf /`, disk wipes, fork bombs, piping the network into a shell) — defense in depth, since
 *     even a breaker that times out and proceeds must never run these;
 *   - PATH SCOPING for `fs`: reads are broad but SECRET paths (~/.kernel.env, ~/.ssh, keychains, keys)
 *     are refused; writes/deletes are confined to the workspace root by default.
 *
 * Everything here is pure + synchronous (string/path analysis) so it is fully unit-testable.
 */
import os from 'node:os';
import path from 'node:path';

import type { Tier } from './tiers.js';

// ─── Shell command classification ─────────────────────────────────────────────

/**
 * CATASTROPHIC patterns — the `shell` tool REFUSES these outright (they never run), regardless of
 * tier or breaker outcome. Unrecoverable or system-level: privilege escalation, root/home wipes, disk
 * formatting, fork bombs, and piping remote content straight into a shell.
 */
const CATASTROPHIC: Array<{ re: RegExp; reason: string }> = [
  { re: /\bsudo\b/, reason: 'runs with root privileges (sudo)' },
  { re: /(^|[\s;&|])su\s+-?\b/, reason: 'switches user (su)' },
  // rm -rf (any flag order) whose target is a ROOT, HOME, or WILDCARD — a system-destroying delete.
  // Precise: the target must BE "/", "/*", "~", "~/", "$HOME", or "*" — a deeper path like
  // "/tmp/x" is NOT catastrophic (it routes through the breaker like any other Red delete).
  { re: /\brm\s+-[a-z]*[rf][a-z]*\s+(-[a-z]+\s+)*(\/(\s|$|\*)|~(\/?\s*$|\s)|\$HOME(\/?\s*$|\s)|\*\s*$)/i, reason: 'recursive force-delete of a root/home/wildcard path' },
  { re: /\bmkfs\b|\bdiskutil\s+(erase|partition|reformat)|\bnewfs\b/i, reason: 'formats/erases a disk' },
  { re: /\bdd\b[^\n]*\bof=\/dev\//i, reason: 'writes raw to a device (dd of=/dev/…)' },
  { re: />\s*\/dev\/(sd|disk|rdisk)/i, reason: 'redirects output onto a raw device' },
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'fork bomb' },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: 'powers down / reboots the machine' },
  // curl|wget … | sh/bash — executing arbitrary network content.
  { re: /\b(curl|wget|fetch)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh|python3?|node)\b/i, reason: 'pipes downloaded content into a shell/interpreter' },
  { re: /\bchmod\s+-R\s+0*777\s+\/(?:\s|$)/i, reason: 'world-writable chmod on root' },
];

/** Detect a catastrophic command. The shell tool calls this and refuses with the reason if bad. */
export function isCatastrophic(command: string): { bad: boolean; reason: string } {
  const cmd = command.trim();
  for (const { re, reason } of CATASTROPHIC) {
    if (re.test(cmd)) return { bad: true, reason };
  }
  return { bad: false, reason: '' };
}

/** First-word read-only binaries that never change the world → GREEN (auto-run, no gate prompt). */
const SAFE_BINARIES = new Set<string>([
  'ls', 'pwd', 'echo', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'ag',
  'find', 'fd', 'which', 'type', 'whereis', 'date', 'cal', 'whoami', 'hostname', 'uname',
  'df', 'du', 'ps', 'env', 'printenv', 'file', 'stat', 'tree', 'basename', 'dirname',
  'realpath', 'sort', 'uniq', 'cut', 'awk', 'sed', 'diff', 'cmp', 'man', 'help', 'history',
  'uptime', 'sw_vers', 'arch', 'sleep', 'true', 'false', 'test', 'printf', 'jobs',
]);

/** Destructive first-word binaries → RED (route through the breaker). */
const DESTRUCTIVE_BINARIES = new Set<string>([
  'rm', 'rmdir', 'unlink', 'shred', 'kill', 'killall', 'pkill', 'chmod', 'chown', 'chgrp',
  'truncate', 'mkfs', 'fdisk', 'dd', 'crontab', 'launchctl', 'systemctl', 'defaults',
]);

/** Read-only subcommands for tools that are otherwise mixed (git, npm, brew, docker, …). */
const SAFE_SUBCOMMANDS: Record<string, Set<string>> = {
  git: new Set(['status', 'diff', 'log', 'show', 'branch', 'remote', 'config', 'blame', 'describe', 'rev-parse', 'ls-files', 'stash']),
  npm: new Set(['list', 'ls', 'outdated', 'view', 'config', 'why', 'root', 'bin', 'prefix', 'whoami']),
  pnpm: new Set(['list', 'ls', 'outdated', 'why', 'root', 'config']),
  yarn: new Set(['list', 'why', 'config', 'info']),
  brew: new Set(['list', 'info', 'search', 'config', 'doctor', 'outdated', '--version']),
  docker: new Set(['ps', 'images', 'logs', 'inspect', 'version', 'info']),
  pip: new Set(['list', 'show', 'freeze']),
  pip3: new Set(['list', 'show', 'freeze']),
  cargo: new Set(['--version', 'tree', 'metadata']),
};

/** Destructive subcommands that should be RED even though the binary is otherwise mixed. */
const DESTRUCTIVE_SUBCOMMANDS: Record<string, Set<string>> = {
  git: new Set(['push', 'reset', 'clean', 'rebase', 'filter-branch', 'gc']),
  npm: new Set(['publish', 'unpublish', 'install', 'uninstall', 'update', 'ci']),
  docker: new Set(['rm', 'rmi', 'kill', 'prune', 'system']),
};

/** Split a command into its leading binary + first non-flag subcommand (best-effort, no shell parse). */
function head(command: string): { bin: string; sub: string } {
  const tokens = command.trim().split(/\s+/);
  const bin = (tokens[0] ?? '').toLowerCase();
  const sub = (tokens.slice(1).find((t) => t && !t.startsWith('-')) ?? '').toLowerCase();
  return { bin, sub };
}

/**
 * Classify a shell command into a tier. CONSERVATIVE: a redirect/append, a pipe into a destructive
 * binary, or an unknown binary defaults to YELLOW (proceeds with notify+audit) — never silently green;
 * destructive binaries/subcommands and `--force` are RED (breaker); a read-only allowlisted command is
 * GREEN. Catastrophic commands also land RED here, and are additionally refused by the shell tool.
 */
export function classifyCommand(command: string): Tier {
  const cmd = command.trim();
  if (!cmd) return 'yellow';
  if (isCatastrophic(cmd).bad) return 'red';

  const { bin, sub } = head(cmd);

  // destructive binary, or a destructive subcommand of a mixed tool, or an explicit force flag → red.
  if (DESTRUCTIVE_BINARIES.has(bin)) return 'red';
  if (DESTRUCTIVE_SUBCOMMANDS[bin]?.has(sub)) return 'red';
  if (/\s--force\b|\s-f\b/.test(cmd) && /\b(git|rm|push|cp|mv|ln)\b/.test(cmd)) return 'red';

  // a write/overwrite redirect to a file is at least recoverable (yellow), not a read.
  const hasWriteRedirect = /(^|[^>0-9])>>?(?!\s*\/dev\/null)/.test(cmd);

  // read-only allowlisted binary (and a read-only subcommand if the tool is mixed) with no write → green.
  if (SAFE_BINARIES.has(bin) && !hasWriteRedirect) return 'green';
  if (SAFE_SUBCOMMANDS[bin]) {
    if (SAFE_SUBCOMMANDS[bin].has(sub) && !hasWriteRedirect) return 'green';
    // a mixed tool with an unknown/other subcommand → yellow (recoverable, notify).
    return 'yellow';
  }

  // everything else: a general command (build, run a script, mkdir, etc.) → yellow (proceed+notify).
  return 'yellow';
}

// ─── Filesystem path policy ────────────────────────────────────────────────────

/**
 * SECRET paths the `fs` tool must NEVER read or write — credentials, keys, keychains. Mirrors the
 * credential-fence principle (tiers.ts): KERNEL never touches the owner's secrets, even on a read.
 */
const SECRET_PATH_RE: RegExp[] = [
  /(^|\/)\.kernel\.env$/i,
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)\.aws(\/|$)/i,
  /(^|\/)\.gnupg(\/|$)/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.git-credentials$/i,
  /\/Library\/Keychains(\/|$)/i,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|keystore)$/i,
];

/** True when an ABSOLUTE path is a secret KERNEL must never read or modify. */
export function isSecretPath(absPath: string): boolean {
  const p = absPath;
  return SECRET_PATH_RE.some((re) => re.test(p));
}

/** Expand a leading `~` and resolve to an absolute, normalized path (relative to `cwd`). */
export function resolveUserPath(input: string, cwd: string): string {
  let p = input.trim();
  if (p === '~') p = os.homedir();
  else if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));
  return path.resolve(cwd, p);
}

/** True when `absPath` is inside `root` (the workspace) — used to scope writes/deletes. */
export function isWithin(root: string, absPath: string): boolean {
  const r = path.resolve(root);
  const a = path.resolve(absPath);
  return a === r || a.startsWith(r + path.sep);
}
