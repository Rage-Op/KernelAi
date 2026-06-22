/**
 * claude-code.test.ts (CC-01 / CC-02 / CC-04) — the Claude Code bridge.
 *
 * Covers:
 *   - CC-01: authorFirstPersonPrompt builds a prompt written AS Pravin (first-person,
 *     direct register) — no third-person "Kernel" / "the user" framing.
 *   - CC-02: runSession spawns `claude -p ... --output-format stream-json
 *     --include-partial-messages` (Green/Yellow fence retained) and turns each NDJSON
 *     event into a TranscriptSchema frame {role:'claude', text, partial} emitted through an
 *     injected seam. A partial chunk then a final line both surface as transcript frames.
 *   - CC-04: each session appends a row to projects/registry.md.
 *
 * The CLI runner is mocked via `__setRunnerForTest` — node:child_process is NEVER spawned
 * (mirrors ClaudeCodeBrain.__setRunnerForTest). The registry write targets a tmpdir so the
 * real kernel-memory/ repo is never touched.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  authorFirstPersonPrompt,
  runSession,
  appendToRegistry,
  __setRunnerForTest,
  type StreamRunner,
  type ClaudeCodeTask,
} from './claude-code.js';
import type { Frame } from '../ipc/protocol.js';

afterEach(() => {
  __setRunnerForTest(null);
});

function tmpRegistry(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-registry-test-'));
  return path.join(d, 'registry.md');
}

// --- CC-01: first-person prompt authored as Pravin ---

test('authorFirstPersonPrompt: writes in first person as Pravin (direct register, no third-person)', () => {
  const prompt = authorFirstPersonPrompt({
    goal: 'refactor the NDJSON parser to be line-buffered',
    repoPath: '/Users/pravin/code/widget',
  });
  // first-person, direct register: "I need you to ..." / "I want ..." / "my ...".
  assert.match(prompt, /\bI\b/, 'prompt speaks in the first person');
  assert.match(prompt, /\byou\b/i, 'prompt addresses Claude directly (you)');
  // NO third-person framing: it must not refer to "Kernel" or "the user" doing the asking.
  assert.doesNotMatch(prompt, /\bKernel\b/, 'no third-person "Kernel" framing');
  assert.doesNotMatch(prompt, /\bthe user\b/i, 'no third-person "the user" framing');
  // the actual goal text is carried through.
  assert.match(prompt, /refactor the NDJSON parser/, 'carries the goal');
});

// --- CC-02: stream-json events → transcript frames via the mock runner ---

test('runSession: stream-json NDJSON events become transcript frames (count + role + partial)', async () => {
  let seenArgs: string[] = [];
  // A mock stream-json runner: emits an assistant partial chunk, then a finalized result line.
  const mock: StreamRunner = async (args, onLine) => {
    seenArgs = args;
    onLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the file' }] } }));
    onLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the file…' }] } }));
    onLine(JSON.stringify({ type: 'result', result: 'Refactored the parser.' }));
    return { code: 0 };
  };
  __setRunnerForTest(mock);

  const frames: Frame[] = [];
  const task: ClaudeCodeTask = { goal: 'refactor the parser', repoPath: '/tmp/widget' };
  await runSession(task, { emit: (f) => frames.push(f), registryPath: tmpRegistry() });

  // stream-json + include-partial-messages fence + Green/Yellow read-only flags.
  assert.ok(seenArgs.includes('-p'), 'headless print mode');
  assert.ok(seenArgs.includes('--output-format') && seenArgs.includes('stream-json'), 'stream-json output');
  assert.ok(seenArgs.includes('--include-partial-messages'), 'partial messages enabled');
  assert.ok(
    seenArgs.includes('--permission-mode') || seenArgs.includes('--allowedTools'),
    'a read-only permission fence flag is present (Green/Yellow-only this phase)',
  );

  // Every emitted frame is a transcript frame; the kernel prompt is the first line.
  const transcripts = frames.filter((f) => f.type === 'transcript');
  assert.ok(transcripts.length >= 4, 'at least the kernel prompt + 3 claude events surface');

  const kernelLine = transcripts.find((f) => f.type === 'transcript' && f.role === 'kernel');
  assert.ok(kernelLine, 'the first-person kernel prompt is surfaced as a transcript line');

  const claudeLines = transcripts.filter((f) => f.type === 'transcript' && f.role === 'claude');
  assert.equal(claudeLines.length, 3, 'three claude events became three claude transcript frames');
});

test('runSession: a partial chunk carries partial:true, the final line carries partial:false', async () => {
  const mock: StreamRunner = async (_args, onLine) => {
    onLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'thinking…' }] } }));
    onLine(JSON.stringify({ type: 'result', result: 'Done.' }));
    return { code: 0 };
  };
  __setRunnerForTest(mock);

  const frames: Frame[] = [];
  await runSession({ goal: 'x', repoPath: '/tmp/x' }, { emit: (f) => frames.push(f), registryPath: tmpRegistry() });

  const claude = frames.filter((f) => f.type === 'transcript' && f.role === 'claude');
  // the assistant chunk is a partial; the result line is the finalization.
  assert.equal(claude[0].type === 'transcript' && claude[0].partial, true, 'assistant chunk is partial');
  assert.equal(claude[1].type === 'transcript' && claude[1].partial, false, 'result line is final');
});

test('runSession: a malformed NDJSON line is dropped, never throws across the boundary (T-04-20)', async () => {
  const mock: StreamRunner = async (_args, onLine) => {
    onLine('this is not json <<<');
    onLine(JSON.stringify({ type: 'result', result: 'Recovered.' }));
    return { code: 0 };
  };
  __setRunnerForTest(mock);

  const frames: Frame[] = [];
  await assert.doesNotReject(async () => {
    await runSession({ goal: 'x', repoPath: '/tmp/x' }, { emit: (f) => frames.push(f), registryPath: tmpRegistry() });
  }, 'a malformed stream-json line must NOT throw');
  // the good line still produced a transcript frame.
  assert.ok(
    frames.some((f) => f.type === 'transcript' && f.role === 'claude' && f.text.includes('Recovered')),
    'the good line after a bad one still surfaces',
  );
});

// --- CC-04: every session appends a row to projects/registry.md ---

test('runSession: appends a row to projects/registry.md for cold resume (CC-04)', async () => {
  const mock: StreamRunner = async (_args, onLine) => {
    onLine(JSON.stringify({ type: 'result', result: 'ok' }));
    return { code: 0 };
  };
  __setRunnerForTest(mock);

  const registryPath = tmpRegistry();
  fs.writeFileSync(registryPath, '# Claude Code Project Registry\n');

  await runSession({ goal: 'build the widget', repoPath: '/Users/pravin/code/widget' }, {
    emit: () => {},
    registryPath,
  });

  const after = fs.readFileSync(registryPath, 'utf8');
  assert.match(after, /\/Users\/pravin\/code\/widget/, 'the repo path is recorded for cold resume');
  assert.match(after, /build the widget/, 'the goal is recorded');
});

test('appendToRegistry: seeds a header when the file is absent, then appends (CC-04)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-registry-seed-'));
  const registryPath = path.join(d, 'registry.md');
  // the file does not exist yet.
  assert.equal(fs.existsSync(registryPath), false);

  appendToRegistry(registryPath, { goal: 'first project', repoPath: '/tmp/proj' });
  const seeded = fs.readFileSync(registryPath, 'utf8');
  assert.match(seeded, /Claude Code Project Registry/i, 'a header is seeded on first write');
  assert.match(seeded, /\/tmp\/proj/, 'the first row is appended');

  appendToRegistry(registryPath, { goal: 'second project', repoPath: '/tmp/proj2' });
  const both = fs.readFileSync(registryPath, 'utf8');
  assert.match(both, /\/tmp\/proj2/, 'a second row appends below the first');
  assert.ok(both.indexOf('/tmp/proj') < both.indexOf('/tmp/proj2'), 'rows are append-only, in order');
});
