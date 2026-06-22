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
  argvFor,
  mapDenialToToolCall,
  RED_DENY,
  __setRunnerForTest,
  type StreamRunner,
  type ClaudeCodeTask,
} from './claude-code.js';
import type { Frame } from '../ipc/protocol.js';
import type { ToolCall } from '../brain/BrainProvider.js';
import type { ToolResult } from './Tool.js';

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

// --- SAFE-05: Red re-submission shim — disallowedTools deny rules + permission_denials re-entry ---

test('SAFE-05: argvFor carries the --disallowedTools Red deny rules AND retains the Green/Yellow read-only fence', () => {
  const argv = argvFor('do the thing');

  // The confirmed deny-rules flag (claude --help: --disallowedTools, --disallowed-tools <tools...>).
  assert.ok(argv.includes('--disallowedTools'), 'the disallowedTools deny-rules flag is present in the argv');

  // The deny rules are carried as the flag's value (one comma-joined argument).
  const flagIdx = argv.indexOf('--disallowedTools');
  const denyArg = argv[flagIdx + 1];
  assert.equal(typeof denyArg, 'string', 'the deny-rules value follows the flag');
  for (const rule of RED_DENY) {
    assert.ok(denyArg.includes(rule), `the deny argument carries the Red rule "${rule}"`);
  }
  // Specifically the load-bearing destructive/install/escalation patterns.
  assert.ok(RED_DENY.some((r) => /rm /.test(r)), 'RED_DENY blocks rm');
  assert.ok(RED_DENY.some((r) => /install/.test(r)), 'RED_DENY blocks installs');
  assert.ok(RED_DENY.some((r) => /git push/.test(r)), 'RED_DENY blocks git push');
  assert.ok(RED_DENY.some((r) => /sudo /.test(r)), 'RED_DENY blocks sudo');

  // The shipped Green/Yellow read-only fence is RETAINED alongside the new deny rules.
  assert.ok(argv.includes('--permission-mode') && argv.includes('dontAsk'), 'read-only permission-mode fence retained');
  assert.ok(argv.includes('--allowedTools') && argv.includes('Read'), 'allowedTools=Read fence retained');
  assert.ok(argv.includes('--bare'), 'the deterministic --bare fence retained');
});

test('SAFE-05: mapDenialToToolCall builds a {tool, args:{op,...}, origin:"self"} ToolCall from a permission_denial', () => {
  const call = mapDenialToToolCall({ tool: 'Bash', input: { command: 'rm -rf /tmp/x' } });
  // It is KERNEL's own sub-contractor's action → origin:'self' (NOT external, so NOT hard-blocked).
  assert.equal(call.origin, 'self', 'a re-entered CC denial is origin:self (NOT external)');
  // It maps to a dispatchable ToolCall shape with the op surfaced in args (what the breaker previews).
  assert.equal(typeof call.tool, 'string', 'maps to a ToolCall tool name');
  assert.ok(call.args && typeof call.args === 'object', 'carries args');
  assert.match(String(call.args.op ?? ''), /rm/i, 'the op text carries the destructive command');
});

test('SAFE-05: a permission_denials result event RE-ENTERS the injected dispatch once per denial (origin:self), never auto-runs', async () => {
  // A mocked stream-json final result event carrying two Red denials (a destructive rm + a purchase).
  const mock: StreamRunner = async (_args, onLine) => {
    onLine(
      JSON.stringify({
        type: 'result',
        result: 'I tried two privileged actions but was denied.',
        permission_denials: [
          { tool: 'Bash', input: { command: 'rm -rf /tmp/x' } },
          { tool: 'Bash', input: { command: 'npm install left-pad' } },
        ],
      }),
    );
    return { code: 0 };
  };
  __setRunnerForTest(mock);

  // An injected dispatch seam stands in for registry.dispatch (which in 05-01 routes a Red verdict
  // to the breaker). The shim itself NEVER executes the destructive op — it only re-enters dispatch.
  const dispatched: ToolCall[] = [];
  const dispatch = async (c: ToolCall): Promise<ToolResult> => {
    dispatched.push(c);
    return { ok: false, escalation: { reason: 'gated by the breaker' } };
  };

  const frames: Frame[] = [];
  await runSession(
    { goal: 'do something', repoPath: '/tmp/widget' },
    { emit: (f) => frames.push(f), registryPath: tmpRegistry(), dispatch },
  );

  // RE-ENTRY: dispatch was called EXACTLY once per denial — the Red action re-enters the gate→breaker.
  assert.equal(dispatched.length, 2, 'each permission_denial re-enters dispatch exactly once');

  // Every re-entered call is origin:'self' (KERNEL's own sub-contractor) → GATED by the breaker,
  // NOT external-hard-blocked.
  assert.ok(dispatched.every((c) => c.origin === 'self'), 'every re-entered ToolCall is origin:self');

  // The destructive op text is carried so the breaker can preview it; the shim itself never ran it.
  assert.ok(
    dispatched.some((c) => /rm/i.test(String(c.args.op ?? ''))),
    'the rm -rf denial was re-entered for gating',
  );
  assert.ok(
    dispatched.some((c) => /install/i.test(String(c.args.op ?? ''))),
    'the install denial was re-entered for gating',
  );

  // A transcript line notes the re-gated action so the owner sees it in the pill.
  assert.ok(
    frames.some((f) => f.type === 'transcript' && /re-?gat|gated|breaker/i.test(f.text)),
    'a transcript line notes the Red action was re-gated, not auto-run',
  );
});

test('SAFE-05: an absent/malformed permission_denials field is tolerated (no dispatch, no throw)', async () => {
  const mock: StreamRunner = async (_args, onLine) => {
    // a final result with NO permission_denials, and a malformed prior line.
    onLine('not json <<<');
    onLine(JSON.stringify({ type: 'result', result: 'Done, nothing denied.' }));
    return { code: 0 };
  };
  __setRunnerForTest(mock);

  const dispatched: ToolCall[] = [];
  const dispatch = async (c: ToolCall): Promise<ToolResult> => {
    dispatched.push(c);
    return { ok: true };
  };

  await assert.doesNotReject(async () => {
    await runSession(
      { goal: 'x', repoPath: '/tmp/x' },
      { emit: () => {}, registryPath: tmpRegistry(), dispatch },
    );
  }, 'an absent/malformed permission_denials must not throw');
  assert.equal(dispatched.length, 0, 'no denials → dispatch is never called');
});
