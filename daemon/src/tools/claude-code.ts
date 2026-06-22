/**
 * tools/claude-code.ts — the Claude Code bridge (CC-01 / CC-02 / CC-04).
 *
 * KERNEL hires the installed `claude` CLI as a sub-contractor. This module:
 *   - CC-01: authors the prompt in the FIRST PERSON, as Pravin ("I need you to …") — a
 *     direct, personal register, never the third-person "Kernel asks" / "the user wants".
 *   - CC-02: runs `claude -p <prompt> --output-format stream-json --include-partial-messages`
 *     (Green/Yellow fence retained: --permission-mode dontAsk --allowedTools Read) and parses
 *     the NDJSON stream LINE-BY-LINE; each event becomes a TranscriptSchema frame pushed through
 *     an injected `emit(frame)` seam (the IPC server supplies the real emitter; tests capture).
 *   - CC-04: appends a row to projects/registry.md on session start so KERNEL can cold-resume.
 *
 * PHASE 5 — the Red RE-SUBMISSION SHIM (SAFE-05): the session keeps the shipped Green/Yellow
 * read-only fence AND now carries `--disallowedTools` scoped Red deny rules (`Bash(rm *)`,
 * `Bash(*install*)`, `Bash(*git push*)`, `Bash(sudo *)`, `Bash(rmdir *)`) — enforced even under a
 * `--dangerously-skip-permissions` bypass (deny rules are non-overridable). When a session attempts
 * one of these, `claude` records it in the final result event's `permission_denials[]`. Each denial
 * is mapped (`mapDenialToToolCall`) to a KERNEL `ToolCall` stamped `origin:'self'` (it is KERNEL's
 * OWN sub-contractor, NOT external content — so it is GATED by the breaker, NOT external-hard-blocked)
 * and RE-ENTERS `registry.dispatch` (injected as `deps.dispatch`). dispatch routes a Red verdict to
 * the live breaker from 05-01 (dry-run → 10s cancel → ceiling → audit → TOCTOU → execute). The shim
 * NEVER executes the destructive op itself — it re-submits it to the SAME chokepoint so a mid-session
 * `rm -rf`/purchase can never auto-run (RESEARCH Pitfall 6 / TOCTOU lives in the breaker it reaches).
 *
 * We deliberately do NOT rely on the `canUseTool`/`--permission-prompt-tool` callback (a documented
 * gap in stream-json print mode); the `--disallowedTools` deny rules + `permission_denials` re-entry
 * is the bypass-proof path.
 *
 * ABSENT-TOLERANT (T-04-20): a spawn ENOENT, a non-zero exit, or a malformed NDJSON line each
 * drop gracefully — a bad line is skipped, never thrown across the loop boundary (mirrors the
 * ClaudeCodeBrain discipline). An absent/malformed `permission_denials` field is likewise tolerated.
 * The CLI runner is injectable via `__setRunnerForTest` so unit tests NEVER spawn a real `claude`.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { Frame, Transcript } from '../ipc/protocol.js';
import { CLAUDE_CLI } from '../brain/ClaudeCodeBrain.js';
import { logger } from '../memory/log.js';
import type { ToolCall } from '../brain/BrainProvider.js';
import type { ToolResult } from './Tool.js';
import { dispatch as registryDispatch } from './registry.js';

/** A task KERNEL hands the sub-contractor: a plain goal + the repo it operates in. */
export interface ClaudeCodeTask {
  /** What KERNEL wants done, in Pravin's words (becomes the first-person prompt body). */
  goal: string;
  /** The repo/working dir the session operates in (recorded in the registry for cold resume). */
  repoPath: string;
}

/** Emit a frame onto the IPC transport (tests inject a capture; the server injects the real send). */
export type EmitFrame = (frame: Frame) => void;

/** Per-line callback the stream runner invokes for each NDJSON line as it arrives. */
export type OnLine = (line: string) => void;

/** The result of a finished stream-json run. */
export interface StreamResult {
  code: number;
}

/** A runner spawns the CLI and invokes `onLine` per NDJSON line; resolves on close. */
export type StreamRunner = (args: string[], onLine: OnLine) => Promise<StreamResult>;

/** Dependencies injected into a session run (the emit seam + the registry target + re-entry). */
export interface RunSessionDeps {
  /** Where transcript frames go (the IPC server's send, or a test capture). */
  emit: EmitFrame;
  /** The projects/registry.md path to append to (defaults to the memory repo). */
  registryPath?: string;
  /**
   * SAFE-05 re-entry seam: each `permission_denials` entry is re-submitted here so a Red action
   * a CC session attempted RE-ENTERS the SAME gate→breaker (05-01) and never auto-runs. Defaults
   * to the real `registry.dispatch`; tests inject a recording mock so no real claude/op is run.
   */
  dispatch?: (call: ToolCall) => Promise<ToolResult>;
}

/**
 * SAFE-05 — the scoped Red deny rules carried in `--disallowedTools`. These are enforced even under
 * a `--dangerously-skip-permissions` bypass. A match records a `permission_denials` entry in the
 * final result event, which the shim re-submits to the gate→breaker. The Read-only fence already
 * blocks most Red surface; these patterns close the destructive/install/escalation Bash holes.
 */
export const RED_DENY: readonly string[] = [
  'Bash(rm *)',
  'Bash(rmdir *)',
  'Bash(*install*)',
  'Bash(*git push*)',
  'Bash(sudo *)',
];

/** One `permission_denials[]` entry as the stream-json final result event carries it. */
export interface PermissionDenial {
  tool?: string;
  input?: { command?: string; [k: string]: unknown };
}

/**
 * Map a CC `permission_denials` entry to a KERNEL ToolCall stamped `origin:'self'`. The denial is
 * KERNEL's own sub-contractor's action (NOT external content), so it is GATED by the breaker rather
 * than external-hard-blocked. The blocked command text is surfaced on `args.op` so the breaker's
 * dry-run can preview exactly what would run; `args.command` carries the raw command for the audit.
 */
export function mapDenialToToolCall(denial: PermissionDenial): ToolCall {
  const command = typeof denial.input?.command === 'string' ? denial.input.command : '';
  return {
    tool: 'shell',
    args: { op: command || (denial.tool ?? 'unknown'), command, sourceTool: denial.tool ?? 'unknown' },
    origin: 'self',
  };
}

/** The active runner (test seam overrides it). Defaults to the real line-buffered spawn. */
let runner: StreamRunner | null = null;

/** TEST-ONLY seam: inject a mock stream runner (or null to reset to the real spawn). */
export function __setRunnerForTest(fn: StreamRunner | null): void {
  runner = fn;
}

/**
 * The default projects/registry.md path: sibling kernel-memory/projects/registry.md.
 * Resolved lazily (NOT via config import) so tests never depend on a present memory repo.
 */
function defaultRegistryPath(): string {
  const fromEnv = process.env.KERNEL_MEMORY_DIR?.trim();
  const memoryDir = fromEnv
    ? path.resolve(fromEnv)
    : path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', 'kernel-memory');
  return path.join(memoryDir, 'projects', 'registry.md');
}

/**
 * CC-01: author the prompt in the FIRST PERSON, as Pravin. Direct, personal register — "I need
 * you to …" — never the third-person "Kernel asks" / "the user wants". This is the literal text
 * handed to `claude -p` and the `role:'kernel'` transcript line shown in the pill.
 */
export function authorFirstPersonPrompt(task: ClaudeCodeTask): string {
  return `I need you to work in ${task.repoPath}. ${task.goal}\n\nWork carefully and tell me what you're doing as you go.`;
}

/**
 * Build the stream-json argv: print mode, NDJSON streaming with partials, the Green/Yellow read-only
 * fence RETAINED, PLUS the SAFE-05 `--disallowedTools` Red deny rules (bypass-proof). Exported so the
 * shim test can assert both the deny rules and the retained read-only fence are in the argv.
 */
export function argvFor(prompt: string): string[] {
  return [
    '-p',
    prompt,
    '--output-format',
    'stream-json', // NDJSON event stream (one JSON object per line)
    '--include-partial-messages', // surface streaming chunks so the pill updates live
    '--bare', // env-key auth, skip hook/MCP/CLAUDE.md auto-discovery (deterministic)
    '--permission-mode',
    'dontAsk', // deny anything outside the read-only set (Green/Yellow-only this phase)
    '--allowedTools',
    'Read',
    // SAFE-05: scoped Red deny rules, enforced even under bypass. A match records a
    // permission_denials entry the shim re-submits to the gate→breaker (origin:'self').
    '--disallowedTools',
    RED_DENY.join(','),
  ];
}

/** The real runner: spawn `claude`, split stdout into NDJSON lines, never throw on spawn error. */
const realRunner: StreamRunner = (args, onLine) =>
  new Promise<StreamResult>((resolve) => {
    let buffer = '';
    const child = spawn(CLAUDE_CLI, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (d: Buffer) => {
      buffer += d.toString('utf8');
      // emit each complete line; keep the trailing partial in the buffer.
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim().length > 0) onLine(line);
        nl = buffer.indexOf('\n');
      }
    });
    // spawn ENOENT (no `claude` on PATH) surfaces as an 'error' event — translate, don't throw.
    child.on('error', () => resolve({ code: 127 }));
    child.on('close', (code) => {
      // flush any final unterminated line.
      if (buffer.trim().length > 0) onLine(buffer);
      resolve({ code: code ?? 0 });
    });
  });

/** The fields the bridge reads out of a stream-json event (everything else is ignored). */
interface StreamEvent {
  type?: string;
  result?: string;
  message?: { content?: Array<{ type?: string; text?: string }> };
  /** SAFE-05: the final result event lists each tool call the deny rules blocked. */
  permission_denials?: PermissionDenial[];
}

/**
 * SAFE-05: extract the `permission_denials[]` from a final result event. An absent or malformed
 * field yields an empty array — a bad shape is tolerated (shipped discipline), never thrown.
 */
function denialsFromEvent(evt: StreamEvent): PermissionDenial[] {
  if (evt.type !== 'result') return [];
  return Array.isArray(evt.permission_denials) ? evt.permission_denials : [];
}

/**
 * Extract the human-readable text + partial flag from one stream-json event. Returns null for
 * events that carry no renderable text (e.g. system/init, tool bookkeeping) so they are skipped.
 */
function textFromEvent(evt: StreamEvent): { text: string; partial: boolean } | null {
  // a finalized result line: the session's terminal output (partial:false).
  if (evt.type === 'result' && typeof evt.result === 'string') {
    return { text: evt.result, partial: false };
  }
  // a streaming assistant chunk: concatenate the text blocks (partial:true).
  if (evt.type === 'assistant' && evt.message?.content) {
    const text = evt.message.content
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('');
    if (text.length > 0) return { text, partial: true };
  }
  return null;
}

/**
 * CC-04: append a row to projects/registry.md for cold resume. Seeds a header if the file is
 * absent. Explicit-path write only — NEVER a `git add -A` near the memory repo (T-04-21).
 */
export function appendToRegistry(registryPath: string, task: ClaudeCodeTask): void {
  try {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    if (!fs.existsSync(registryPath)) {
      fs.writeFileSync(
        registryPath,
        '# Claude Code Project Registry\n\n' +
          '<!-- Every Claude Code project KERNEL hires is appended here for cold resume. -->\n\n' +
          '| When | Repo | Goal |\n| --- | --- | --- |\n',
      );
    }
    const when = new Date().toISOString();
    const safeGoal = task.goal.replace(/\|/g, '\\|').replace(/\n/g, ' ');
    fs.appendFileSync(registryPath, `| ${when} | ${task.repoPath} | ${safeGoal} |\n`);
  } catch (err) {
    // a registry write failure must never crash a session — log and continue.
    logger.warn({ tool: 'claude-code', err: String(err) }, 'claude-code: registry append failed');
  }
}

/**
 * Run a Claude Code session: record it for cold resume, emit the first-person kernel prompt as a
 * transcript line, then stream the session's stdout as `role:'claude'` transcript frames.
 */
export async function runSession(task: ClaudeCodeTask, deps: RunSessionDeps): Promise<void> {
  const registryPath = deps.registryPath ?? defaultRegistryPath();
  // CC-04: record the project on session start, before any work.
  appendToRegistry(registryPath, task);

  const prompt = authorFirstPersonPrompt(task);
  let seq = 0;
  const nextId = (): string => `cc-${Date.now().toString(36)}-${seq++}`;

  // CC-01/02: surface the first-person prompt as the opening kernel transcript line.
  const kernelFrame: Transcript = { type: 'transcript', id: nextId(), role: 'kernel', text: prompt };
  deps.emit(kernelFrame);

  // SAFE-05: denials are collected synchronously as lines arrive, then re-submitted to the
  // gate→breaker AFTER the run resolves (the async dispatch must not race the line parser).
  const denials: PermissionDenial[] = [];

  const run = runner ?? realRunner;
  await run(argvFor(prompt), (line) => {
    // T-04-20: a malformed NDJSON line is dropped, never thrown across the boundary.
    let evt: StreamEvent;
    try {
      evt = JSON.parse(line) as StreamEvent;
    } catch {
      return;
    }
    // SAFE-05: harvest any permission_denials from the final result event (absent/malformed → none).
    for (const d of denialsFromEvent(evt)) denials.push(d);

    const extracted = textFromEvent(evt);
    if (!extracted) return;
    const frame: Transcript = {
      type: 'transcript',
      id: nextId(),
      role: 'claude',
      text: extracted.text,
      partial: extracted.partial,
    };
    deps.emit(frame);
  });

  // SAFE-05: each Red action the deny rules blocked RE-ENTERS the SAME gate→breaker (origin:'self')
  // and is owner-gated — never auto-run. The shim itself executes NOTHING; it re-submits to dispatch.
  const dispatch = deps.dispatch ?? registryDispatch;
  for (const denial of denials) {
    const reentry = mapDenialToToolCall(denial);
    // Note the re-gated action in the transcript so the owner sees it in the pill (not silent).
    deps.emit({
      type: 'transcript',
      id: nextId(),
      role: 'kernel',
      text: `Claude Code attempted a Red action (${reentry.args.op}); re-gating it through the breaker — not auto-running.`,
    });
    try {
      await dispatch(reentry);
    } catch (err) {
      // A re-entry failure must never crash a session — log and continue (shipped discipline).
      logger.warn({ tool: 'claude-code', err: String(err) }, 'claude-code: Red re-entry dispatch failed');
    }
  }
}
