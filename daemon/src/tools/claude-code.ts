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
 * GREEN/YELLOW-ONLY this phase (CC-03 / T-04-17): the run keeps the shipped read-only fence. A
 * Red-tier action a session proposes hits the shipped `gate.authorize` and is DENIED — the Red
 * re-submission shim is DEFERRED to Phase 5. This module does NOT build the shim.
 *
 * ABSENT-TOLERANT (T-04-20): a spawn ENOENT, a non-zero exit, or a malformed NDJSON line each
 * drop gracefully — a bad line is skipped, never thrown across the loop boundary (mirrors the
 * ClaudeCodeBrain discipline). The CLI runner is injectable via `__setRunnerForTest` so unit
 * tests NEVER spawn a real `claude`.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { Frame, Transcript } from '../ipc/protocol.js';
import { CLAUDE_CLI } from '../brain/ClaudeCodeBrain.js';
import { logger } from '../memory/log.js';

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

/** Dependencies injected into a session run (the emit seam + the registry target). */
export interface RunSessionDeps {
  /** Where transcript frames go (the IPC server's send, or a test capture). */
  emit: EmitFrame;
  /** The projects/registry.md path to append to (defaults to the memory repo). */
  registryPath?: string;
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

/** Build the stream-json argv: print mode, NDJSON streaming with partials, Green/Yellow fenced. */
function argvFor(prompt: string): string[] {
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

  const run = runner ?? realRunner;
  await run(argvFor(prompt), (line) => {
    // T-04-20: a malformed NDJSON line is dropped, never thrown across the boundary.
    let evt: StreamEvent;
    try {
      evt = JSON.parse(line) as StreamEvent;
    } catch {
      return;
    }
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
}
