/**
 * exec-policy.ts — the policy layer for KERNEL's "hands" (the `fs` and `shell` tools, HANDS-06),
 * HARDENED after a 24-finding adversarial audit. It answers, WITHOUT executing anything:
 *
 *   1. classifyCommand(cmd) → tier of a shell command (so tiers.ts routes it green/yellow/red).
 *   2. isCatastrophic(cmd)  → commands the shell tool refuses outright (unrecoverable/system-level).
 *   3. path policy: isSecretPath / canonicalize / isWithin — for the fs + shell fences.
 *   4. env + output hardening: safeChildEnv (allowlist) + redactSecrets (scrub command output).
 *
 * Key hardening lessons baked in (audit IDs in comments):
 *   - classify EVERY segment of a chained/sub-shelled command and take the MAX tier — a destructive
 *     op can never hide behind a safe head like `ls && rm -rf x` (#4/#16/#17).
 *   - see through wrappers (`env -i`, `timeout`, `nice`, `xargs`, …) and interpreters
 *     (`bash -c`, `python3 -c`, `node -e`, …) — re-classify the REAL command/payload (#2/#13).
 *   - canonicalize paths with realpath + case-insensitive compare so symlinks, `..`, `/private`
 *     aliasing and case tricks can't slip the secret-fence or workspace scope (#7/#8/#11/#20).
 *   - a comprehensive secret denylist (ssh, aws, gh, docker, kube, keychains, histories, dotenv files,
 *     the daemon's own stores) (#9/#10), an env ALLOWLIST not a denylist (#24), output redaction (#18/#19).
 *
 * Pure + synchronous except canonicalize() (one realpath stat); fully unit-tested.
 */
import os from 'node:os';
import path from 'node:path';
import { realpathSync } from 'node:fs';

import type { Tier } from './tiers.js';

// ─── tier ordering ─────────────────────────────────────────────────────────────
const RANK: Record<Tier, number> = { green: 0, yellow: 1, red: 2 };
function maxTier(a: Tier, b: Tier): Tier {
  return RANK[a] >= RANK[b] ? a : b;
}

// ─── catastrophic commands (the shell tool REFUSES these outright) ───────────────

/** OS-critical roots an `rm -rf` / destructive `find` must never target (regex source string). The
 *  target is `/`, `~`, `$HOME`, or `/Users`-class root, bounded by end/space/quote/paren/`/`/`*` so a
 *  trailing quote (`rm -rf /"`) or a deeper path (`/Users/x`) still matches. */
const SYSTEM_ROOT =
  "(\\/(Users|System|Library|Applications|bin|sbin|usr|etc|var|private|opt|Volumes|cores)|\\$HOME|~|\\/)(?=[\\s\"'();|*]|\\/|$)";

const CATASTROPHIC: Array<{ re: RegExp; reason: string }> = [
  // privilege escalation (incl. macOS osascript "with administrator privileges") — #3/#23.
  { re: /(^|[\s;&|(])(sudo|doas|pkexec|run0)\b/i, reason: 'privilege escalation (sudo/doas/pkexec)' },
  { re: /(^|[\s;&|(])su\s+-?\b/i, reason: 'switches user (su)' },
  { re: /\bosascript\b[\s\S]*?(with\s+administrator\s+privileges|do\s+shell\s+script)/i, reason: 'osascript admin/shell escalation' },
  { re: /with\s+administrator\s+privileges/i, reason: 'runs with administrator privileges' },
  { re: /\bAuthorizationExecuteWithPrivileges\b/i, reason: 'privileged authorization API' },
  // recursive force-delete of a root/home/wildcard/system path — #15.
  { re: new RegExp('\\brm\\s+-[a-z]*[rf][a-z]*\\s+(-[a-z]+\\s+)*' + SYSTEM_ROOT, 'i'), reason: 'recursive force-delete of a root/system/home path' },
  // destructive `find` over a root/system tree (-delete/-exec rm …) — #1/#6.
  { re: new RegExp('\\bfind\\b\\s+' + SYSTEM_ROOT + '[\\s\\S]*\\s-(delete|exec|execdir|ok|okdir)\\b', 'i'), reason: 'destructive find over a system/home tree' },
  { re: /\bfind\b[\s\S]*\s-delete\b/i, reason: 'find -delete (recursive unlink)' },
  // disk format / raw-device writes (any mechanism) — #14.
  { re: /\bmkfs\b|\bnewfs\b|\bdiskutil\s+(erase|partition|reformat|secureErase)/i, reason: 'formats/erases a disk' },
  { re: /\/dev\/(r?disk\d|sd[a-z]|nvme\d|hd[a-z])/i, reason: 'raw device access (/dev/disk…)' },
  // fork bomb, power state.
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'fork bomb' },
  { re: /(^|[\s;&|(])(shutdown|reboot|halt|poweroff)\b/i, reason: 'powers down / reboots the machine' },
  // pipe network content into a shell/interpreter — #2-adjacent.
  { re: /\b(curl|wget|fetch)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh|dash|python3?|node|perl|ruby)\b/i, reason: 'pipes downloaded content into a shell/interpreter' },
  { re: /\bchmod\s+-R\s+0*777\s+\//i, reason: 'world-writable chmod on a root path' },
];

/** Detect a catastrophic command anywhere in the (whole) string. */
export function isCatastrophic(command: string): { bad: boolean; reason: string } {
  const cmd = command.trim();
  for (const { re, reason } of CATASTROPHIC) {
    if (re.test(cmd)) return { bad: true, reason };
  }
  return { bad: false, reason: '' };
}

// ─── command tiering (per-segment, wrapper/interpreter aware) ────────────────────

const SAFE_BINARIES = new Set<string>([
  'ls', 'pwd', 'echo', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'ag',
  'which', 'type', 'whereis', 'date', 'cal', 'whoami', 'hostname', 'uname', 'df', 'du', 'ps',
  'file', 'stat', 'tree', 'basename', 'dirname', 'realpath', 'sort', 'uniq', 'cut',
  'diff', 'cmp', 'man', 'help', 'history', 'uptime', 'sw_vers', 'arch', 'sleep', 'true', 'false',
  'test', 'printf', 'jobs', 'wait', 'jq', 'column', 'tr',
  // NB: sed/awk/tee are intentionally NOT here — they can write/execute (sed -i, awk system(), tee
  // a file/device), so they fall through to YELLOW (proceed+notify) rather than auto-running GREEN.
]);

/** Destructive first-word binaries → RED. (`find`/`grep -r` are handled specially below.) */
const DESTRUCTIVE_BINARIES = new Set<string>([
  'rm', 'rmdir', 'unlink', 'shred', 'kill', 'killall', 'pkill', 'chmod', 'chown', 'chgrp',
  'truncate', 'mkfs', 'fdisk', 'dd', 'crontab', 'launchctl', 'systemctl', 'defaults', 'mv',
  'ln', 'install', 'ditto', 'rsync', 'scp', 'osascript',
]);

/** Interpreters whose inline code (`-c`/`-e`) must be classified by PAYLOAD, never head. */
const INTERPRETERS = new Set<string>(['bash', 'sh', 'zsh', 'dash', 'ksh', 'python', 'python3', 'perl', 'ruby', 'node', 'php', 'deno', 'bun']);

/** Transparent wrappers stripped before classifying the REAL command. */
const WRAPPERS = new Set<string>(['env', 'nice', 'time', 'timeout', 'gtimeout', 'xargs', 'nohup', 'stdbuf', 'command', 'builtin', 'exec', 'setsid', 'ionice']);

const SAFE_SUBCOMMANDS: Record<string, Set<string>> = {
  git: new Set(['status', 'diff', 'log', 'show', 'branch', 'remote', 'config', 'blame', 'describe', 'rev-parse', 'ls-files', 'stash', 'fetch']),
  npm: new Set(['list', 'ls', 'outdated', 'view', 'config', 'why', 'root', 'bin', 'prefix', 'whoami']),
  pnpm: new Set(['list', 'ls', 'outdated', 'why', 'root', 'config']),
  yarn: new Set(['list', 'why', 'config', 'info']),
  brew: new Set(['list', 'info', 'search', 'config', 'doctor', 'outdated', '--version']),
  docker: new Set(['ps', 'images', 'logs', 'inspect', 'version', 'info']),
  pip: new Set(['list', 'show', 'freeze']),
  pip3: new Set(['list', 'show', 'freeze']),
  cargo: new Set(['--version', 'tree', 'metadata']),
  // NB: `npm run`/`npm test`/`cargo build` run arbitrary package scripts → NOT green; they fall to yellow.
};

const DESTRUCTIVE_SUBCOMMANDS: Record<string, Set<string>> = {
  git: new Set(['push', 'reset', 'clean', 'rebase', 'filter-branch', 'gc']),
  npm: new Set(['publish', 'unpublish', 'install', 'uninstall', 'update', 'ci']),
  docker: new Set(['rm', 'rmi', 'kill', 'prune', 'system']),
};

/** Inline-interpreter payloads that touch destructive APIs → RED. */
const DESTRUCTIVE_API = /(rmtree|rmsync|removeSync|unlink|\brm\s+-|os\.system|subprocess|\bsystem\s*\(|\bexec\b|\beval\b|spawn|popen|shutil|\brmdir\b|truncate|mkfs|\bdd\b|FileUtils)/i;

/** Persistence / system-mutation destinations → RED. */
const PERSISTENCE = /(LaunchAgents|LaunchDaemons|\/etc\/cron|\bcrontab\b|\/etc\/(passwd|sudoers|hosts)|\/Library\/StartupItems)/i;

function head(seg: string): { bin: string; sub: string } {
  const tokens = seg.trim().split(/\s+/);
  const bin = (tokens[0] ?? '').toLowerCase().replace(/^\\/, ''); // strip a leading \ (alias bypass)
  const sub = (tokens.slice(1).find((t) => t && !t.startsWith('-')) ?? '').toLowerCase();
  return { bin, sub };
}

/** Strip leading VAR=val assignments and transparent wrappers; return the real command. */
function stripWrappers(seg: string): string {
  let tokens = seg.trim().split(/\s+/);
  for (;;) {
    let changed = false;
    while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
      tokens = tokens.slice(1);
      changed = true;
    }
    const w = (tokens[0] ?? '').toLowerCase();
    if (tokens.length && WRAPPERS.has(w)) {
      tokens = tokens.slice(1);
      // skip the wrapper's own option args (flags, and a following value/number).
      while (tokens.length && (tokens[0].startsWith('-') || /^\d/.test(tokens[0]))) tokens = tokens.slice(1);
      changed = true;
    }
    if (!changed) break;
  }
  return tokens.join(' ');
}

/** Extract the inline-code payload after a -c / -e / -eval flag (quoted or to end-of-string). */
function inlinePayload(seg: string): string | null {
  const q = seg.match(/-(?:c|e|eval|-command|-eval)\s+(['"])([\s\S]*)\1\s*$/);
  if (q) return q[2];
  const u = seg.match(/-(?:c|e|eval|-command|-eval)\s+([\s\S]+)$/);
  return u ? u[1] : null;
}

/** Split a command into all classifiable segments: operator-separated pieces + substitution/subshell
 *  inner content. A destructive op can hide in any of them, so the caller classifies them all. */
function segmentsOf(command: string): string[] {
  const segs: string[] = [];
  // capture $(...), `...`, and (...) inner content (one level — nested handled by recursion upstream).
  for (const re of [/\$\(([^()]*)\)/g, /`([^`]*)`/g, /\(([^()]*)\)/g]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(command)) !== null) {
      if (m[1].trim()) segs.push(m[1].trim());
    }
  }
  // top-level split on ; newline && || | (|| before |).
  for (const piece of command.split(/\s*(?:&&|\|\||;|\n|\|)\s*/)) {
    const t = piece.trim();
    if (t) segs.push(t);
  }
  return segs.length ? segs : [command.trim()];
}

/** Classify a SINGLE already-segmented command (no top-level operators expected). */
function classifySegment(seg: string): Tier {
  const stripped = stripWrappers(seg);
  if (stripped && stripped !== seg) return classifySegment(stripped);

  const { bin, sub } = head(seg);
  if (!bin) return 'yellow';

  // inline interpreter code: classify by payload, floor at yellow (running code is never "green").
  if (INTERPRETERS.has(bin) && /(^|\s)(-c|-e|-eval|--command|--eval)\b/.test(seg)) {
    const payload = inlinePayload(seg);
    if (payload) {
      if (isCatastrophic(payload).bad) return 'red';
      if (DESTRUCTIVE_API.test(payload)) return 'red';
      return maxTier('yellow', classifyCommand(payload));
    }
    return 'yellow';
  }

  if (PERSISTENCE.test(seg)) return 'red';
  if (DESTRUCTIVE_BINARIES.has(bin)) return 'red';
  if (DESTRUCTIVE_SUBCOMMANDS[bin]?.has(sub)) return 'red';
  if (bin === 'find' && /\s-(delete|exec|execdir|ok|okdir)\b/.test(seg)) return 'red';
  if (/\s--force\b|\s-f\b/.test(seg) && /\b(git|rm|push|cp|mv|ln)\b/.test(seg)) return 'red';

  const hasWriteRedirect = /(^|[^>0-9])>>?(?!\s*\/dev\/null)/.test(seg);
  if (SAFE_BINARIES.has(bin) && !hasWriteRedirect) {
    // a recursive grep over a broad tree can sweep up secrets → at least yellow (notify) not green.
    if ((bin === 'grep' || bin === 'egrep' || bin === 'rg') && /\s-[a-z]*[rR]\b/.test(seg)) return 'yellow';
    return 'green';
  }
  if (SAFE_SUBCOMMANDS[bin]) {
    return SAFE_SUBCOMMANDS[bin].has(sub) && !hasWriteRedirect ? 'green' : 'yellow';
  }
  return 'yellow';
}

/**
 * Classify a (possibly chained) shell command into a tier — the MAX severity across every segment,
 * so a destructive op can never hide behind a safe head or inside a subshell/substitution.
 */
export function classifyCommand(command: string): Tier {
  const cmd = command.trim();
  if (!cmd) return 'yellow';
  if (isCatastrophic(cmd).bad) return 'red';
  let worst: Tier = 'green';
  for (const seg of segmentsOf(cmd)) {
    worst = maxTier(worst, classifySegment(seg));
    if (worst === 'red') break;
  }
  return worst;
}

// ─── filesystem path policy ──────────────────────────────────────────────────────

/** SECRET paths the hands must NEVER read or write. Matched case-insensitively on the CANONICAL path. */
const SECRET_PATH_RE: RegExp[] = [
  /(^|\/)\.kernel\.env/i, // ~/.kernel.env and any .kernel.env* backup
  /\.env(\.[^/]*)?$/i, // anything ending .env or .env.<x>
  /(^|\/)\.?env([.\-][^/]*)?$/i, // env, .env, env.production, .env-backup
  /(^|\/)[^/]*(secret|credential|passwd|password)[^/]*$/i, // *secret*/*credential* basenames
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)\.aws(\/|$)/i,
  /(^|\/)\.gnupg(\/|$)/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.git-credentials$/i,
  /(^|\/)\.gitconfig$/i,
  /(^|\/)\.config\/(gh|gcloud|gcp|doctl|stripe|op)(\/|$)/i,
  /(^|\/)\.docker(\/|$)/i,
  /(^|\/)\.kube(\/|$)/i,
  /(^|\/)\.cargo\/credentials/i,
  /(^|\/)\.(zsh|bash|sh|fish)_history$/i,
  /(^|\/)\.(zsh|bash)rc$/i, /(^|\/)\.(z|bash)profile$/i,
  /\/Library\/Keychains(\/|$)/i,
  /\/Library\/Application Support\/Kernel(\/|$)/i, // the daemon's own secret stores + transcripts
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks|asc|gpg)$/i,
];

/** True when an absolute (ideally canonicalized) path is a secret KERNEL must never touch. */
export function isSecretPath(absPath: string): boolean {
  return SECRET_PATH_RE.some((re) => re.test(absPath));
}

/** Expand a leading `~` and resolve to an absolute path (relative to `cwd`). Lexical only. */
export function resolveUserPath(input: string, cwd: string): string {
  let p = input.trim().replace(/^['"]|['"]$/g, '');
  if (p === '~') p = os.homedir();
  else if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));
  return path.resolve(cwd, p);
}

/**
 * Canonicalize a path: resolve symlinks + `..` + `/private` aliasing via realpath. For a path that
 * doesn't exist yet (a write target), resolve the deepest EXISTING ancestor and re-append the tail —
 * so a symlinked parent directory can't be used to escape the workspace or reach a secret (#7/#8).
 */
export function canonicalize(p: string): string {
  const abs = path.resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    /* doesn't exist — walk up to the deepest existing ancestor */
  }
  const tail: string[] = [];
  let cur = abs;
  while (cur !== path.dirname(cur)) {
    const parent = path.dirname(cur);
    tail.push(path.basename(cur));
    try {
      const realParent = realpathSync(parent);
      return path.join(realParent, ...tail.reverse());
    } catch {
      cur = parent;
    }
  }
  return abs;
}

/** True when `absPath` is inside `root`. Both are canonicalized + compared case-insensitively (macOS). */
export function isWithin(root: string, absPath: string): boolean {
  const r = canonicalize(root).toLowerCase();
  const a = canonicalize(absPath).toLowerCase();
  return a === r || a.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

// ─── env + output hardening ────────────────────────────────────────────────────

/** Env vars safe to pass to a child process. ALLOWLIST (drop-by-default) so a secret-named OR
 *  secret-valued var (DATABASE_URL, SESSION_COOKIE, *_TOKEN, …) can never leak via `env`/`$VAR` (#24). */
const ENV_ALLOWLIST = new Set<string>([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'TMPDIR', 'TZ', 'PWD', 'OLDPWD',
  'HOSTNAME', 'COLUMNS', 'LINES', 'SHLVL', 'EDITOR', 'PAGER',
]);

/** Build a child-process env containing ONLY allowlisted (and LC_*) variables. */
export function safeChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (ENV_ALLOWLIST.has(k) || k.startsWith('LC_')) out[k] = v;
  }
  return out;
}

/** Secret-VALUE shapes redacted from command output before it reaches the model (exfil channel). */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\btvly-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9-]{16,}/g,
  /\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, // JWT
  /\b[a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:[^@\s/]+@/gi, // user:pass@host in a URL
];

/** Redact secret-looking values from text (defense in depth for any read that slips a fence). */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_VALUE_PATTERNS) out = out.replace(re, '[redacted-secret]');
  return out;
}

/** Extract path-like argument tokens from a command (for the shell secret-arg fence). */
export function pathLikeArgs(command: string): string[] {
  return command
    .split(/[\s;&|<>()`]+/)
    .map((t) => t.replace(/^['"]|['"]$/g, '').trim())
    .filter((t) => t && !t.startsWith('-') && (t.startsWith('/') || t.startsWith('~') || t.startsWith('./') || t.startsWith('../') || t.includes('/')));
}
