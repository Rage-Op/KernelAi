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

import { enqueue, drain, runTick, isRunning, queueDepth, setBrain, type Intent } from './loop.js';
import { StubBrain } from './brain/StubBrain.js';
import { z } from 'zod';
import type { BrainProvider, Decision, ToolCall } from './brain/BrainProvider.js';
import { register, clearRegistry } from './tools/registry.js';
import type { Tool, ToolResult } from './tools/Tool.js';

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
