/**
 * loop.test.ts — the event-driven serial intent runner (CORE-02).
 *
 * Enqueues a fake user intent against a temp memory dir, awaits the drain, and asserts:
 *   - a ## Session block was appended to logs/{today}.md (the log step ran)
 *   - a reply text was produced and surfaced (the StubBrain echo reached intent.reply)
 *   - one full tick ran perceive→recall(inject)→decide(StubBrain)→act(none)→log
 *   - the runner fell genuinely idle: running===false and the queue is empty (no timer)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { enqueue, drain, runTick, isRunning, queueDepth, setBrain, parseOverrideCommand, type Intent } from './loop.js';
import { StubBrain } from './brain/StubBrain.js';
import { z } from 'zod';
import type { BrainProvider, Decision, ToolCall } from './brain/BrainProvider.js';
import { register, clearRegistry } from './tools/registry.js';
import type { Tool, ToolResult } from './tools/Tool.js';
import { overrideSingleton } from './safety/override.js';

/** A temp memory dir with the minimum inject() needs: IDENTITY.md, current.md, logs/. */
function tempMemoryDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-loop-'));
  fs.writeFileSync(
    path.join(dir, 'IDENTITY.md'),
    '# IDENTITY\n\nKERNEL is a digital copy of Pravin. Terse to him.\n',
    'utf8',
  );
  fs.mkdirSync(path.join(dir, 'working-memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'working-memory', 'current.md'), '# Current\n\nNothing in flight.\n', 'utf8');
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'self'), { recursive: true });
  return dir;
}

function todayLog(memoryDir: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return path.join(memoryDir, 'logs', `${today}.md`);
}

test('loop: one tick runs perceive→recall→decide→act→log and produces a reply', async () => {
  setBrain(new StubBrain());
  const memoryDir = tempMemoryDir();
  const replies: string[] = [];

  const intent: Intent = {
    source: 'user',
    id: 'loop-1',
    payload: 'hello kernel',
    memoryDir,
    reply: (text) => replies.push(text),
  };

  enqueue(intent);
  await drain();

  // log step: a ## Session block exists in today's log.
  const log = fs.readFileSync(todayLog(memoryDir), 'utf8');
  assert.match(log, /## Session 1/, 'a ## Session block must be appended');
  assert.match(log, /hello kernel/, 'the intent payload is recorded in the session block');

  // decide step: the StubBrain reply was surfaced to the originator.
  assert.equal(replies.length, 1, 'exactly one reply produced');
  assert.match(replies[0], /StubBrain echo/, 'reply carries the StubBrain echo');
  assert.match(replies[0], /hello kernel/, 'reply echoes the utterance');

  // idle: the runner fell genuinely idle — no concurrent pass, no armed timer.
  assert.equal(isRunning(), false, 'running must be false after draining');
  assert.equal(queueDepth(), 0, 'queue must be empty (idle)');
});

test('loop: drain runs serially — a second enqueue during a pass is handled, then idle', async () => {
  setBrain(new StubBrain());
  const memoryDir = tempMemoryDir();
  const replies: string[] = [];
  const mk = (id: string): Intent => ({
    source: 'user',
    id,
    payload: `msg ${id}`,
    memoryDir,
    reply: (t) => replies.push(t),
  });

  enqueue(mk('a'));
  enqueue(mk('b'));
  await drain();

  assert.equal(replies.length, 2, 'both intents drained');
  assert.equal(isRunning(), false, 'idle after draining both');
  assert.equal(queueDepth(), 0, 'queue empty');

  const log = fs.readFileSync(todayLog(memoryDir), 'utf8');
  const blocks = log.match(/^## Session \d+/gm) ?? [];
  assert.equal(blocks.length, 2, 'two session blocks (one per intent)');
});

test('loop: runTick on an empty queue is a no-op and stays idle', async () => {
  await runTick();
  assert.equal(isRunning(), false);
  assert.equal(queueDepth(), 0);
});

/** A fake brain that always returns a fixed action (the act-seam test seam). */
class ActionBrain implements BrainProvider {
  constructor(private readonly action: ToolCall) {}
  async reason(prompt: string): Promise<Decision> {
    return { thought: `act on: ${prompt.slice(0, 40)}`, action: this.action };
  }
}

/** A stub green tool whose execute flips `reached` so "the dispatch reached it" is assertable. */
function stubTool(name: string): { tool: Tool; reached: () => boolean } {
  let executed = false;
  const tool: Tool = {
    name,
    schema: z.object({ op: z.string() }).passthrough(),
    async execute(): Promise<ToolResult> {
      executed = true;
      return { ok: true };
    },
  };
  return { tool, reached: () => executed };
}

test('loop: act seam dispatches an allowed green action through the router to the tool', async () => {
  clearRegistry();
  const { tool, reached } = stubTool('stub');
  register(tool);
  setBrain(new ActionBrain({ tool: 'stub', args: { op: 'click' } }));

  const memoryDir = tempMemoryDir();
  const replies: string[] = [];
  enqueue({ source: 'user', id: 'act-1', payload: 'do a click', memoryDir, reply: (t) => replies.push(t) });
  await runTick();

  assert.equal(reached(), true, 'the dispatch reached the tool through the gate (green → allow)');
  assert.equal(replies.length, 0, 'an allowed action produces no Blocked reply');
  assert.equal(isRunning(), false, 'idle after the tick');
});

test('loop: a gate-denied action surfaces a Blocked reply and the tool never executes', async () => {
  clearRegistry();
  // The fence applies to browser fill of a Password field — the gate denies before execute.
  const { tool, reached } = stubTool('browser');
  register(tool);
  setBrain(new ActionBrain({ tool: 'browser', args: { op: 'fill', fieldLabel: 'Password' } }));

  const memoryDir = tempMemoryDir();
  const replies: string[] = [];
  enqueue({ source: 'user', id: 'act-2', payload: 'fill the password', memoryDir, reply: (t) => replies.push(t) });
  await runTick();

  assert.equal(reached(), false, 'a denied action never reaches the tool execute');
  assert.equal(replies.length, 1, 'a Blocked reply is surfaced to the originator');
  assert.match(replies[0], /^Blocked:/, 'the reply is prefixed Blocked:');
  assert.match(replies[0], /secure\/credential field/, 'the fence reason is surfaced');
  assert.equal(isRunning(), false, 'idle after the tick');

  // restore the StubBrain so any later-ordered tests are unaffected.
  setBrain(new StubBrain());
  clearRegistry();
});

// --- PHASE 5: /override is parsed as a LITERAL command BEFORE the brain (T-05-05) ---

/** A brain that records whether reason() was ever called (to prove /override short-circuits it). */
class SpyBrain implements BrainProvider {
  called = false;
  async reason(prompt: string): Promise<Decision> {
    this.called = true;
    return { thought: 'spy', reply: `spy: ${prompt}` };
  }
}

test('loop: a literal "/override" utterance activates override WITHOUT reaching the brain', async () => {
  const spy = new SpyBrain();
  setBrain(spy);
  overrideSingleton().deactivate();

  const memoryDir = tempMemoryDir();
  const replies: string[] = [];
  enqueue({ source: 'user', id: 'ov-1', payload: '/override', memoryDir, reply: (t) => replies.push(t) });
  await runTick();

  assert.equal(spy.called, false, 'the brain.reason() was NEVER reached for an /override command');
  assert.equal(overrideSingleton().isActive(), true, 'override was activated by the literal command');
  assert.equal(replies.length, 1, 'a confirmation reply was surfaced');
  assert.match(replies[0], /Override active/i, 'the reply confirms activation');
  assert.match(replies[0], /Red stays gated/i, 'the reply states Red remains gated');

  setBrain(new StubBrain());
  overrideSingleton().deactivate();
});

test('loop: parseOverrideCommand only fires for a USER utterance (external content can never activate)', () => {
  // A user utterance starting with the literal command → parsed.
  assert.notEqual(parseOverrideCommand({ source: 'user', payload: '/override' }), null, 'user /override parses');
  assert.notEqual(parseOverrideCommand({ source: 'user', payload: 'override now' }), null, 'user "override" parses');
  // A non-user source (schedule/tool) is NOT an override command, even with identical text.
  assert.equal(parseOverrideCommand({ source: 'schedule', payload: '/override' }), null, 'schedule cannot activate');
  assert.equal(parseOverrideCommand({ source: 'tool', payload: '/override' }), null, 'tool cannot activate');
  // The command must be at the START — quoting it inside a sentence does not trigger.
  assert.equal(
    parseOverrideCommand({ source: 'user', payload: 'please do not /override anything' }),
    null,
    'a mid-sentence mention does not activate override',
  );
});

test('loop: active /override does NOT change the Red decision — a Red action is still Blocked (defense-in-depth)', async () => {
  // Activate override, then drive a Red action through the loop with the flag OFF (default).
  // The gate must still DENY Red (override never bypasses Red), surfacing a Blocked reply.
  clearRegistry();
  const { tool, reached } = stubTool('fs');
  register(tool);
  overrideSingleton().activate('session', 60_000);
  setBrain(new ActionBrain({ tool: 'fs', args: { op: 'rm -rf', path: '/' } }));

  const memoryDir = tempMemoryDir();
  const replies: string[] = [];
  enqueue({ source: 'user', id: 'ov-red-1', payload: 'delete it', memoryDir, reply: (t) => replies.push(t) });
  await runTick();

  assert.equal(reached(), false, 'the Red action never reached execute even under active override');
  assert.equal(replies.length, 1, 'a Blocked reply was surfaced');
  assert.match(replies[0], /^Blocked:/, 'override did NOT unlock the Red action');

  setBrain(new StubBrain());
  overrideSingleton().deactivate();
  clearRegistry();
});
