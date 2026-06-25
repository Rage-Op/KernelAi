/**
 * ClaudeCodeBrain.ts — KERNEL's CLAUDE (SUBSCRIPTION) brain, the installed `claude` CLI headless.
 *
 * Spawns `claude -p "<prompt>" --output-format json` (zero-dep via node:child_process — NOT execa,
 * avoiding a dependency + its legitimacy checkpoint) and parses `JSON.parse(stdout).result` →
 * `Decision.reply`. This is how the owner gets Claude's intelligence in KERNEL using their Claude
 * Pro/Max SUBSCRIPTION (the CLI's logged-in OAuth) — NO `ANTHROPIC_API_KEY` and no per-token billing.
 *
 * SUBSCRIPTION AUTH (the load-bearing choice): we deliberately do NOT pass `--bare`. `--bare` forces the
 * CLI into env-API-key mode (it reads `ANTHROPIC_API_KEY`), which DEFEATS the subscription. Without it,
 * the CLI uses the owner's `claude login` OAuth. KERNEL's identity + memory are injected via
 * `--append-system-prompt` so it answers AS KERNEL, and the run is spawned in the owner's home dir so it
 * doesn't auto-load a project's CLAUDE.md.
 *
 * FULL-ACCESS AGENT (the owner's EXPLICIT choice — "give it all the claude code own tools, full access,
 * no bargain"): this brain runs Claude Code with ALL its native tools and `--permission-mode
 * bypassPermissions` — read/write files, run shell, search, browse, with NO approval prompts. Claude
 * Code executes those tools in its OWN process, so they DO NOT pass through KERNEL's §8 gate, secret
 * fence, RED breaker, or audit log (unlike LM Studio / API-Claude, which return a Decision.action the
 * loop gates). The owner accepts that trade. The TIERED-ACCESS POLICY that the gate would normally
 * enforce is instead fed to the model AS PROMPT (TIER_POLICY below): it self-applies 🟢/🟡/🔴 judgement —
 * notably, pause and ask before a 🔴 irreversible/financial action. This is prompt-level governance, not
 * a hard guarantee; it is exactly what the owner asked for. (See KERNEL_FRAMING below for the policy.
 * Use the LM Studio engine when you want actions to flow through KERNEL's hard gate instead.)
 *
 * ABSENT-TOLERANT: a spawn ENOENT (no `claude` on PATH), a non-zero exit, or garbled (non-JSON) stdout
 * each return a TYPED ESCALATION Decision — never a throw across the loop boundary.
 *
 * Test seam: `__setRunnerForTest(fn)` injects a mock runner so the unit tests never spawn a real process
 * (mirrors the peekaboo `__setClientForTest` discipline).
 */
import { spawn } from 'node:child_process';
import os from 'node:os';

import type { BrainProvider, ChatTurn, Decision } from './BrainProvider.js';
import { todayLine } from './persona.js';
import { safeChildEnv } from '../safety/exec-policy.js';

/** The CLI binary (on PATH). Named constant so it is correctable if the install path changes. */
export const CLAUDE_CLI = 'claude';

/** The result of running the CLI: exit code + captured streams. */
export interface ClaudeCodeResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** A runner spawns the CLI with the given argv (+ cwd) and resolves its result. */
export type ClaudeCodeRunner = (args: string[]) => Promise<ClaudeCodeResult>;

/** The `claude -p --output-format json` JSON contract (only the field the brain reads). */
interface ClaudeCodeJson {
  result?: string;
  session_id?: string;
}

/** The active runner (test seam overrides it). Defaults to the real node:child_process spawn. */
let runner: ClaudeCodeRunner | null = null;

/** TEST-ONLY seam: inject a mock runner (or null to reset to the real spawn). */
export function __setRunnerForTest(fn: ClaudeCodeRunner | null): void {
  runner = fn;
}

/** The real runner: spawn the `claude` CLI in the owner's HOME dir (so no project CLAUDE.md auto-loads),
 *  capture stdout/stderr, never throw on spawn error.
 *
 *  ENV (security + subscription-auth correctness): the child gets an ALLOWLISTED env via `safeChildEnv()`
 *  — NOT the daemon's full `process.env`. That (a) keeps the daemon's secrets (ANTHROPIC_API_KEY,
 *  TAVILY_API_KEY, Plaid creds sourced from ~/.kernel.env) OUT of the child, matching the discipline
 *  shell.ts already follows, and (b) crucially DROPS ANTHROPIC_API_KEY so the CLI can't fall back to
 *  per-token API billing — it must use the owner's `claude login` SUBSCRIPTION OAuth (the whole point).
 *  `safeChildEnv` retains HOME, so the CLI still finds the ~/.claude OAuth credentials. PATH is then
 *  augmented with the usual user-install dirs (~/.local/bin, Homebrew) because the daemon's launcher
 *  runs with a MINIMAL PATH that omits ~/.local/bin — where Claude Code is typically installed. */
const realRunner: ClaudeCodeRunner = (args: string[]) =>
  new Promise<ClaudeCodeResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    const env = safeChildEnv();
    env.PATH = [process.env.PATH ?? '', `${os.homedir()}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin']
      .filter(Boolean)
      .join(':');
    const child = spawn(CLAUDE_CLI, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: os.homedir(),
      env,
    });
    child.stdout?.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr?.on('data', (d) => (stderr += d.toString('utf8')));
    // spawn ENOENT (no `claude` on PATH) surfaces as an 'error' event — translate, don't throw.
    child.on('error', (err) => resolve({ code: 127, stdout, stderr: stderr + String(err) }));
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });

/** KERNEL identity + the TIERED-ACCESS POLICY, injected on top of the assembled memory context. Because
 *  this brain has FULL tool access OUTSIDE KERNEL's hard gate, the gate's tier policy is given to the
 *  model as guidance to self-apply (the owner's chosen posture). Tiers mirror safety/tiers.ts. */
const KERNEL_FRAMING =
  "You are KERNEL, Pravin's persistent personal AI agent, acting on his Mac with FULL tool access (read/" +
  'write files, run shell commands, search, browse, edit). You have his standing permission to ACT — there ' +
  'is no approval prompt — so DO the task, don\'t just describe it, then report what you did. Be warm, ' +
  'sharp, concise, and COMPLETE (never announce a task then stop). Use the memory/context above to follow ' +
  'up naturally.\n\n' +
  'Apply this TIERED-ACCESS judgement yourself (you are trusted to act, so this replaces an approval gate):\n' +
  '- GREEN (reversible — read/list/inspect, capture, search the web): do freely.\n' +
  '- YELLOW (recoverable — create/edit a file, change a setting, send one ordinary message): do it, then ' +
  'tell Pravin exactly what you changed.\n' +
  '- RED (irreversible or money — delete data, `rm -rf`, purchase, transfer, sign, change access/security ' +
  'settings, mass-send): STOP and ask Pravin first in your reply BEFORE doing it, unless he already clearly ' +
  'authorized that specific action. Never do a Red action speculatively.\n' +
  "Stay within Pravin's interests and never touch his secrets/credentials (~/.kernel.env, ~/.ssh, keys) " +
  'unless he explicitly asks.';

/** Build the headless argv: print mode, JSON output, subscription auth (NO --bare), KERNEL identity +
 *  tier policy injected, and FULL tool access (bypassPermissions — the owner's explicit choice). */
function argvFor(prompt: string, systemPrompt: string): string[] {
  return [
    '-p',
    prompt,
    '--output-format',
    'json',
    // NO --bare → use the owner's `claude login` SUBSCRIPTION auth (not ANTHROPIC_API_KEY).
    '--append-system-prompt',
    systemPrompt,
    // FULL ACCESS (owner's explicit "no bargain"): all native Claude Code tools, no approval prompts.
    // These run OUTSIDE KERNEL's gate — the tier policy in the system prompt is the (soft) governance.
    '--permission-mode',
    'bypassPermissions',
  ];
}

/** Render the recent dialogue into a compact transcript block for the system prompt. The CLI's `-p` is
 *  single-shot (no server-side conversation), so to follow up across turns we replay the recent history
 *  the loop assembled (owner/assistant only), bounded so the prompt stays small. */
function historyBlock(history?: ChatTurn[]): string {
  const turns = (history ?? []).slice(-8);
  if (turns.length === 0) return '';
  const lines = turns.map((t) => `${t.role === 'user' ? 'Pravin' : 'KERNEL'}: ${t.content}`);
  return `\n\nRecent conversation (for follow-up):\n${lines.join('\n')}`;
}

export class ClaudeCodeBrain implements BrainProvider {
  async reason(
    prompt: string,
    context: string,
    _onToken?: (chunk: string) => void,
    history?: ChatTurn[],
  ): Promise<Decision> {
    // Inject KERNEL's identity + the assembled memory context (+ recent dialogue) as an appended system
    // prompt, so the subscription Claude answers as KERNEL and can follow up across turns.
    const systemPrompt = `${todayLine()}\n\n${context}\n\n${KERNEL_FRAMING}${historyBlock(history)}`;
    const run = runner ?? realRunner;
    const { code, stdout, stderr } = await run(argvFor(prompt, systemPrompt));

    if (code !== 0) {
      const noCli = code === 127 || /ENOENT|not found/i.test(stderr);
      // A non-127 failure often still carries an actionable message in the JSON `.result` (e.g. an API/
      // login error) — surface that over the generic line when present.
      const fromResult = (() => {
        try {
          const r = (JSON.parse(stdout) as ClaudeCodeJson).result;
          return typeof r === 'string' && r.trim() ? r.trim() : '';
        } catch {
          return '';
        }
      })();
      return {
        thought: `claude code exited ${code}`,
        reply: noCli
          ? 'Claude (subscription) is unavailable — the `claude` CLI was not found. Install Claude Code and ' +
            'run `claude login`, or switch the engine to LM Studio in Settings.'
          : fromResult ||
            'Claude (subscription) run failed' +
              (stderr ? ` (${stderr.slice(0, 200)})` : '') +
              '. Make sure you are logged in (`claude login`), or switch the engine to LM Studio.',
      };
    }

    let parsed: ClaudeCodeJson;
    try {
      parsed = JSON.parse(stdout) as ClaudeCodeJson;
    } catch {
      return {
        thought: 'claude code returned non-JSON stdout',
        reply: 'Claude (subscription) returned an unparseable response.',
      };
    }

    if (typeof parsed.result !== 'string') {
      return { thought: 'claude code JSON had no .result', reply: 'Claude (subscription) returned no result.' };
    }
    return { thought: 'claude-code (subscription)', reply: parsed.result };
  }
}
