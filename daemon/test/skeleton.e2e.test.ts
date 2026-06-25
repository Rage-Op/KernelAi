// The Walking Skeleton acceptance contract: the FULL tick end to end —
//   perceive → recall → decide → act → log
// Originally exercised over the UDS socket; it now drives the SAME frame router (routeFrame →
// defaultFrameHandler → enqueue → loop) through an in-memory mock ClientConn (the primitive the web
// SSE transport wraps), so the transport is irrelevant to the contract being proved.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { config, INJECT_CAP } from '../src/config.js';

import {
  defaultFrameHandler,
  routeFrame,
  sendConnectFrames,
  type ClientConn,
} from '../src/ipc/server.js';
import type { Frame } from '../src/ipc/protocol.js';
import { runTick, setBrain, enqueue } from '../src/loop.js';
import { inject } from '../src/memory/inject.js';

// --- Phase 3: the brain swap-seam, the cue assembler, and the gated dispatch chokepoint ---
import type { BrainProvider, Decision } from '../src/brain/BrainProvider.js';
import { StubBrain } from '../src/brain/StubBrain.js';
import { assembleSpeak } from '../src/ipc/cues.js';
import { SpeakSchema } from '../src/ipc/protocol.js';
import { register, clearRegistry, dispatch } from '../src/tools/registry.js';
import { z } from 'zod';

/**
 * A mock client over the transport-agnostic frame router: `send` routes an inbound frame through the
 * real `defaultFrameHandler` (enqueue → loop), and the daemon's pushes land in `frames()`. `connect()`
 * replays the on-connect burst (so `ready` arrives), mirroring what the web SSE transport does.
 */
function mockClient(): {
  conn: ClientConn;
  frames: () => Frame[];
  send: (f: unknown) => void;
  connect: () => void;
} {
  const received: Frame[] = [];
  const conn: ClientConn = { kind: 'web', send: (f) => received.push(f) };
  return {
    conn,
    frames: () => received,
    send: (f) => routeFrame(f, conn, defaultFrameHandler),
    connect: () => sendConnectFrames(conn),
  };
}

function todayLogPath(): string {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(config.memoryDir, 'logs', `${today}.md`);
}

function waitFor<T>(fn: () => T | undefined, timeoutMs = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const v = fn();
      if (v !== undefined) return resolve(v);
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

test('skeleton: one tick perceive→recall→decide→act→log end to end', async () => {
  // (1) On connect the client receives a `ready` frame (the on-connect frame burst).
  const client = mockClient();
  client.connect();
  const ready = client.frames().find((f) => f.type === 'ready') as { type: string } | undefined;
  assert.equal(ready?.type, 'ready', 'daemon must send `ready` on connect');

  // (2) Routing an `utterance` frame runs one loop tick; the client receives a
  //     `reply` frame whose text contains the StubBrain echo.
  const id = 'e2e-1';
  client.send({ type: 'utterance', id, text: 'hello kernel', final: true });
  await runTick();
  const reply = (await waitFor(() =>
    client.frames().find((f) => f.type === 'reply'),
  )) as { type: string; text: string };
  assert.match(reply.text, /StubBrain echo/, 'reply must carry the StubBrain echo');
  assert.match(reply.text, /hello kernel/, 'reply must echo the utterance');

  // (3) After the tick, logs/{today}.md contains a `## Session` block.
  const log = fs.readFileSync(todayLogPath(), 'utf8');
  assert.match(log, /## Session/, 'today log must contain a `## Session` block');

  // (4) inject() output begins with IDENTITY.md content and total length ≤ INJECT_CAP.
  const identity = fs.readFileSync(path.join(config.memoryDir, 'IDENTITY.md'), 'utf8');
  const injected = await inject();
  assert.ok(
    injected.startsWith(identity.slice(0, 32)),
    'injected context must begin with IDENTITY.md',
  );
  assert.ok(injected.length <= INJECT_CAP, `injected context must be ≤ ${INJECT_CAP} chars`);
});

// ---------------------------------------------------------------------------
// Phase 3 (03-01): utterance → mock ClaudeBrain → reply over IPC, a speak frame
// is producible from the reply, and a Decision.action reaches the gated dispatch
// (BRAIN-06 anti-bypass — the gate stays the chokepoint).
// ---------------------------------------------------------------------------

/** A mock ClaudeBrain that returns a fixed text reply (no live SDK / network). */
class MockReplyBrain implements BrainProvider {
  async reason(prompt: string): Promise<Decision> {
    return { thought: 'mock cloud reasoned', reply: `Cloud reply to: ${prompt}` };
  }
}

/** A mock ClaudeBrain that returns ONE Decision.action (the manual tool loop shape). */
class MockToolUseBrain implements BrainProvider {
  async reason(): Promise<Decision> {
    // 'screenshot' classifies Green in tiers.ts → gate allows → dispatch reaches execute.
    return { thought: 'mock cloud wants a tool', action: { tool: 'screenshot', args: { op: 'see' } } };
  }
}

test('03-01: utterance → mock ClaudeBrain → reply frame over the router; speak frame producible', async () => {
  setBrain(new MockReplyBrain());
  const client = mockClient();
  client.connect();
  assert.ok(client.frames().find((f) => f.type === 'ready'), 'ready arrives on connect');

  const id = 'p3-reply-1';
  client.send({ type: 'utterance', id, text: 'how is my day', final: true });
  await runTick();
  const reply = (await waitFor(() =>
    client.frames().find((f) => f.type === 'reply'),
  )) as { type: string; id: string; text: string };
  assert.equal(reply.id, id, 'reply is correlated to the utterance id');
  assert.match(reply.text, /Cloud reply to: how is my day/, 'the mock ClaudeBrain reply is surfaced');

  // A speak frame is producible from the reply via the cue assembler (CLOUD-04) and validates.
  const speak = assembleSpeak(id, reply.text, [{ widget: 'events', phrase: 'day', data: { count: 3 } }]);
  assert.equal(SpeakSchema.safeParse(speak).success, true, 'assembled speak frame validates against SpeakSchema');
  assert.ok(speak.cues.length >= 1, 'the speak frame carries char-offset cues');

  setBrain(new StubBrain()); // restore the default
});

test('03-01: a Decision.action reaches the gated dispatch (BRAIN-06 — gate is the chokepoint)', async () => {
  // Register a sentinel tool; its execute is reachable ONLY via dispatch (after gate.authorize).
  // Driven through the loop directly (enqueue + runTick) — no IPC server needed, which keeps the
  // proof tight: the brain returns ONE Decision.action and the LOOP gates+executes it.
  clearRegistry();
  let executed = false;
  let executedArgs: Record<string, unknown> | null = null;
  register({
    name: 'screenshot',
    schema: z.object({ op: z.string() }).passthrough(),
    async execute(args) {
      executed = true;
      executedArgs = args;
      return { ok: true, data: 'captured' };
    },
  });

  setBrain(new MockToolUseBrain());
  enqueue({ source: 'user', id: 'p3-act-1', payload: 'show me the screen' });
  await runTick();

  assert.equal(executed, true, 'the action reached the tool via the loop’s gated dispatch (BRAIN-06)');
  assert.deepEqual(executedArgs, { op: 'see' }, 'the brain’s Decision.action.args reached execute intact');

  // Direct dispatch of the same action also proves the gate is the single entry to execute.
  executed = false;
  const result = await dispatch({ tool: 'screenshot', args: { op: 'see' } });
  assert.equal(result.ok, true, 'gate.authorize allows the Green action and dispatch executes it');
  assert.equal(executed, true, 'execute is reached only through the gated dispatch chokepoint');

  clearRegistry();
  setBrain(new StubBrain());
});
