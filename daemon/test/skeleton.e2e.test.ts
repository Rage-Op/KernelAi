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
import { runTick } from '../src/loop.js';
import { inject } from '../src/memory/inject.js';

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
