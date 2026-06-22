/**
 * ClaudeCodeBrain.ts — the code-heavy brain (BRAIN-04), the installed `claude` CLI headless.
 *
 * Spawns `claude -p "<prompt>" --output-format json --bare` (zero-dep via node:child_process —
 * NOT execa, avoiding a dependency + its legitimacy checkpoint) and parses `JSON.parse(stdout).result`
 * → `Decision.reply`.
 *
 * GREEN/YELLOW-ONLY this phase (BRAIN-04 / T-03-05): the run is fenced with
 * `--permission-mode dontAsk` + `--allowedTools Read` so Claude Code cannot perform Red-tier /
 * irreversible / ambient-money actions. The Red re-submission shim (routing a Red action UP to
 * KERNEL's gate) is DEFERRED to Phase 4 (CC-03). `--bare` reads the env ANTHROPIC_API_KEY
 * (T-03-03 — env only, not keychain) and skips hook/MCP/CLAUDE.md auto-discovery for determinism.
 *
 * ABSENT-TOLERANT: a spawn ENOENT (no `claude` on PATH), a non-zero exit, or garbled (non-JSON)
 * stdout each return a TYPED ESCALATION Decision — never a throw across the loop boundary.
 *
 * Test seam: `__setRunnerForTest(fn)` injects a mock runner so the unit tests never spawn a real
 * process (mirrors the peekaboo `__setClientForTest` discipline).
 */
import { spawn } from 'node:child_process';

import type { BrainProvider, Decision } from './BrainProvider.js';

/** The CLI binary (on PATH). Named constant so it is correctable if the install path changes. */
export const CLAUDE_CLI = 'claude';

/** The result of running the CLI: exit code + captured streams. */
export interface ClaudeCodeResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** A runner spawns the CLI with the given argv and resolves its result. */
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

/** The real runner: spawn the `claude` CLI, capture stdout/stderr, never throw on spawn error. */
const realRunner: ClaudeCodeRunner = (args: string[]) =>
  new Promise<ClaudeCodeResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(CLAUDE_CLI, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr?.on('data', (d) => (stderr += d.toString('utf8')));
    // spawn ENOENT (no `claude` on PATH) surfaces as an 'error' event — translate, don't throw.
    child.on('error', (err) => resolve({ code: 127, stdout, stderr: stderr + String(err) }));
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });

/** Build the headless argv: print mode, JSON output, deterministic, Green/Yellow-only fenced. */
function argvFor(prompt: string): string[] {
  return [
    '-p',
    prompt,
    '--output-format',
    'json',
    '--bare', // env-key auth, skip hook/MCP/CLAUDE.md auto-discovery (deterministic)
    '--permission-mode',
    'dontAsk', // deny anything outside the read-only set (Green/Yellow-only this phase)
    '--allowedTools',
    'Read',
  ];
}

export class ClaudeCodeBrain implements BrainProvider {
  async reason(prompt: string, _context: string): Promise<Decision> {
    const run = runner ?? realRunner;
    const { code, stdout, stderr } = await run(argvFor(prompt));

    if (code !== 0) {
      return {
        thought: `claude code exited ${code}`,
        reply:
          'Claude Code is unavailable or the run failed' +
          (stderr ? ` (${stderr.slice(0, 200)})` : '') +
          '. Confirm `claude` is installed and ANTHROPIC_API_KEY is set.',
      };
    }

    let parsed: ClaudeCodeJson;
    try {
      parsed = JSON.parse(stdout) as ClaudeCodeJson;
    } catch {
      return {
        thought: 'claude code returned non-JSON stdout',
        reply: 'Claude Code returned an unparseable response.',
      };
    }

    if (typeof parsed.result !== 'string') {
      return { thought: 'claude code JSON had no .result', reply: 'Claude Code returned no result.' };
    }
    return { thought: 'claude-code', reply: parsed.result };
  }
}
