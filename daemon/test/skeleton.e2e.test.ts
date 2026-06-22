// RED until 01-02 + 01-03; this is the Walking Skeleton acceptance contract.
//
// This test names the FULL tick the skeleton must satisfy end to end:
//   perceive → recall → decide → act → log
// It deliberately imports modules that Plans 01-02 and 01-03 will create
// (../src/ipc/server.js, ../src/loop.js, ../src/memory/inject.js). Those modules
// do not exist yet, so this file fails to import — that RED state is intentional
// and is the contract the rest of Phase 1 makes pass. Do NOT force this green.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

import { config, INJECT_CAP } from '../src/config.js';

// --- Modules that land in Plans 01-02 / 01-03 (do not exist yet → RED) ---
import { startIpcServer } from '../src/ipc/server.js';
import { runTick, setBrain, enqueue } from '../src/loop.js';
import { inject } from '../src/memory/inject.js';

// --- Phase 3: the brain swap-seam, the cue assembler, and the gated dispatch chokepoint ---
import type { BrainProvider, Decision } from '../src/brain/BrainProvider.js';
import { StubBrain } from '../src/brain/StubBrain.js';
import { assembleSpeak } from '../src/ipc/cues.js';
import { SpeakSchema } from '../src/ipc/protocol.js';
import { register, clearRegistry, dispatch } from '../src/tools/registry.js';
import { z } from 'zod';

/** A minimal NDJSON client: connects, splits incoming frames on '\n'. */
function connectClient(socketPath: string): Promise<{
  socket: net.Socket;
  frames: () => unknown[];
}> {
  return new Promise((resolve, reject) => {
    const received: unknown[] = [];
    let buffer = '';
    const socket = net.createConnection(socketPath, () => {
      resolve({ socket, frames: () => received });
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim()) received.push(JSON.parse(line));
      }
    });
    socket.on('error', reject);
  });
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
  // (1) IPC server listens on the UDS and the client receives a `ready` frame on connect.
  const server = await startIpcServer();
  const client = await connectClient(config.socketPath);
  const ready = (await waitFor(() =>
    client.frames().find((f) => (f as { type?: string }).type === 'ready'),
  )) as { type: string };
  assert.equal(ready.type, 'ready', 'daemon must send `ready` on connect');

  // (2) Sending an `utterance` frame runs one loop tick; the client receives a
  //     `reply` frame whose text contains the StubBrain echo.
  const id = 'e2e-1';
  client.socket.write(
    JSON.stringify({ type: 'utterance', id, text: 'hello kernel', final: true }) + '\n',
  );
  await runTick();
  const reply = (await waitFor(() =>
    client.frames().find((f) => (f as { type?: string }).type === 'reply'),
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

  client.socket.end();
  await server.close();
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

test('03-01: utterance → mock ClaudeBrain → reply frame over IPC; speak frame producible', async () => {
  setBrain(new MockReplyBrain());
  const server = await startIpcServer();
  const client = await connectClient(config.socketPath);
  await waitFor(() => client.frames().find((f) => (f as { type?: string }).type === 'ready'));

  const id = 'p3-reply-1';
  client.socket.write(
    JSON.stringify({ type: 'utterance', id, text: 'how is my day', final: true }) + '\n',
  );
  await runTick();
  const reply = (await waitFor(() =>
    client.frames().find((f) => (f as { type?: string; id?: string }).type === 'reply'),
  )) as { type: string; id: string; text: string };
  assert.equal(reply.id, id, 'reply is correlated to the utterance id');
  assert.match(reply.text, /Cloud reply to: how is my day/, 'the mock ClaudeBrain reply is surfaced');

  // A speak frame is producible from the reply via the cue assembler (CLOUD-04) and validates.
  const speak = assembleSpeak(id, reply.text, [{ widget: 'events', phrase: 'day', data: { count: 3 } }]);
  assert.equal(SpeakSchema.safeParse(speak).success, true, 'assembled speak frame validates against SpeakSchema');
  assert.ok(speak.cues.length >= 1, 'the speak frame carries char-offset cues');

  client.socket.end();
  await server.close();
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
