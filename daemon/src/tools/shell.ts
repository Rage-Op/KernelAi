/**
 * tools/shell.ts (HANDS-06) — KERNEL's shell hands: run a command and return stdout/stderr/exit code.
 * The brain references this via ToolCall.tool='shell'. Tier is assigned CENTRALLY by classifyTier
 * (which routes shell calls through exec-policy.classifyCommand — per-segment, wrapper/interpreter
 * aware): a read-only allowlisted command is GREEN (auto), a general command is YELLOW (proceed+notify),
 * a destructive one is RED (the live breaker's cancel window). The gate is the only path to execute.
 *
 * Defense-in-depth guards this tool enforces directly (audit-hardened):
 *   - CATASTROPHIC REFUSAL: sudo/doas, root/system `rm -rf`, `find / -delete`, disk wipes, fork bombs,
 *     osascript admin escalation, `curl … | sh`, raw-device writes — refused outright (exec-policy).
 *   - SECRET-ARG FENCE: any path-like argument that canonicalizes to a secret (~/.ssh, ~/.kernel.env,
 *     keychains, *.pem, ~/.config/gh, …) is refused — so `cat ~/.ssh/id_rsa` can't exfiltrate keys.
 *   - ENV ALLOWLIST: the child runs with only safe vars (PATH/HOME/TERM/…); every secret-named OR
 *     secret-valued var is dropped, so `env`/`$VAR` leak nothing.
 *   - OUTPUT REDACTION: stdout/stderr are scrubbed of secret-shaped values before reaching the model.
 *
 * Never throws across the dispatch boundary — timeouts/spawn errors return a typed escalation; a
 * non-zero exit is a normal result (returned with its output so the model can react).
 */
import { exec } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { promisify } from 'node:util';
import { z } from 'zod';

import { register } from './registry.js';
import type { Tool, ToolResult } from './Tool.js';
import { logger } from '../memory/log.js';
import { config } from '../config.js';
import {
  isCatastrophic,
  isSecretPath,
  resolveUserPath,
  canonicalize,
  redactSecrets,
  safeChildEnv,
  pathLikeArgs,
} from '../safety/exec-policy.js';

const execAsync = promisify(exec);

/** Wall-clock limit for a command (ms). Long-running jobs should be launched, not awaited here. */
const SHELL_TIMEOUT_MS = 30_000;
/** Hard cap on captured output bytes (protects the daemon); slice further for the model below. */
const MAX_BUFFER_BYTES = 1024 * 1024;
/** Per-stream output returned to the model (keeps the small model's context manageable). */
const MAX_RETURN_CHARS = 8000;

export const shellArgsSchema = z
  .object({
    op: z.enum(['exec']).default('exec'),
    /** The full shell command to run. */
    command: z.string().min(1),
    /** Working directory (`~`/relative resolve against the workspace). Defaults to the workspace. */
    cwd: z.string().optional(),
  })
  .strict();

type ShellArgs = z.infer<typeof shellArgsSchema>;

export const SHELL_TOOL_DESCRIPTION =
  'Run a shell command on this Mac and get its stdout, stderr and exit code. Use it to list files, ' +
  'run scripts, use git, build/test code, or search. Read-only commands run immediately; commands ' +
  "that change the system run with a notice, and destructive ones need the owner's approval. Pass the " +
  'full command string in `command`.';

/** Truncate + redact output before it reaches the model. */
function clean(s: string): string {
  return redactSecrets((s ?? '').slice(0, MAX_RETURN_CHARS));
}

export const shellTool: Tool = {
  name: 'shell',
  schema: shellArgsSchema,
  async execute(args): Promise<ToolResult> {
    const a = args as ShellArgs;
    const command = a.command.trim();

    // CATASTROPHIC refusal — never run, regardless of tier/breaker outcome.
    const cat = isCatastrophic(command);
    if (cat.bad) {
      logger.warn({ tool: 'shell', reason: cat.reason }, 'shell: refused catastrophic command');
      return {
        ok: false,
        escalation: {
          reason: `refusing to run a catastrophic command (${cat.reason}).`,
          recommendation: 'Pravin runs system-level/destructive commands manually.',
        },
      };
    }

    // Resolve the cwd against the workspace; never run from inside a secret directory.
    const cwd = resolveUserPath(a.cwd ?? '.', config.workspaceDir);
    if (isSecretPath(canonicalize(cwd))) {
      return { ok: false, escalation: { reason: `refusing to run inside a secret path (${cwd}).` } };
    }

    // SECRET-ARG FENCE: refuse if any path-like argument canonicalizes to a secret (mirrors the fs
    // secret fence so the shell can't read what fs refuses — e.g. `cat ~/.ssh/id_rsa`).
    for (const tok of pathLikeArgs(command)) {
      const abs = canonicalize(resolveUserPath(tok, cwd));
      if (isSecretPath(abs)) {
        logger.warn({ tool: 'shell' }, 'shell: refused — command references a secret path');
        return {
          ok: false,
          escalation: {
            reason: `refusing to run a command that touches a credential/secret path (${tok}).`,
            recommendation: 'KERNEL never reads secrets; Pravin handles those directly.',
          },
        };
      }
    }

    // Make sure the default workspace exists so a first command there doesn't fail with ENOENT.
    await fsp.mkdir(config.workspaceDir, { recursive: true }).catch(() => {});

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        env: safeChildEnv(), // allowlist: only safe vars reach the child (no key exfiltration).
        timeout: SHELL_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
        windowsHide: true,
      });
      logger.info({ tool: 'shell' }, 'shell: command completed (exit 0)');
      return { ok: true, data: { op: 'exec', command, exitCode: 0, stdout: clean(stdout), stderr: clean(stderr) } };
    } catch (err) {
      const e = err as { killed?: boolean; code?: number | string; signal?: string; stdout?: string; stderr?: string; message?: string };
      // a timeout / kill is a real failure → escalate.
      if (e.killed || e.signal === 'SIGTERM') {
        return { ok: false, escalation: { reason: `shell command timed out after ${SHELL_TIMEOUT_MS / 1000}s.` } };
      }
      // a non-zero EXIT is a normal result the model should see — return it with the output.
      if (typeof e.code === 'number') {
        logger.info({ tool: 'shell', code: e.code }, 'shell: command exited non-zero');
        return { ok: true, data: { op: 'exec', command, exitCode: e.code, stdout: clean(e.stdout ?? ''), stderr: clean(e.stderr ?? '') } };
      }
      // spawn failure (command not found, etc.).
      return { ok: false, escalation: { reason: `shell command failed: ${e.message ?? 'spawn error'}` } };
    }
  },
};

// Module-init side effect: importing this tool wires it into the router (HANDS-04).
register(shellTool);
