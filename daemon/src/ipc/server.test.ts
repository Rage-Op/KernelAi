/**
 * server.test.ts — UDS NDJSON framing: ready on connect, ping→pong, partial-frame
 * carryover (split line → exactly one frame), and malformed lines never crash.
 *
 * Uses startIpc(customHandler, tempSocket) so the framing is tested in isolation from
 * the loop/memory; the loop-connected path is covered by skeleton.e2e.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { startIpc, startIpcServer, send, type FrameHandler } from './server.js';
import type { Frame } from './protocol.js';
import { __setOwnerConfigPathForTest } from '../safety/owner-config.js';
import { FLAGS } from '../safety/flags.js';

function tempSocket(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-sock-'));
  return path.join(dir, 'k.sock');
}

/** A minimal NDJSON client collecting parsed frames. */
function connectClient(socketPath: string): Promise<{
  socket: net.Socket;
  frames: () => Frame[];
}> {
  return new Promise((resolve, reject) => {
    const received: Frame[] = [];
    let buffer = '';
    const socket = net.createConnection(socketPath, () => resolve({ socket, frames: () => received }));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim()) received.push(JSON.parse(line) as Frame);
      }
    });
    socket.on('error', reject);
  });
}

function waitFor<T>(fn: () => T | undefined, timeoutMs = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const v = fn();
      if (v !== undefined) return resolve(v);
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

// A handler that answers ping with pong and counts every frame it receives.
function makeHandler(seen: Frame[]): FrameHandler {
  return (frame, conn) => {
    seen.push(frame);
    if (frame.type === 'ping') send(conn, { type: 'pong', id: frame.id });
  };
}

test('server: sends `ready` on connect and answers ping→pong', async () => {
  const sock = tempSocket();
  const seen: Frame[] = [];
  const srv = await startIpc(makeHandler(seen), sock);
  const client = await connectClient(sock);

  const ready = await waitFor(() => client.frames().find((f) => f.type === 'ready'));
  assert.equal(ready.type, 'ready');

  client.socket.write(JSON.stringify({ type: 'ping', id: 'p1' }) + '\n');
  const pong = (await waitFor(() => client.frames().find((f) => f.type === 'pong'))) as {
    type: string;
    id: string;
  };
  assert.equal(pong.id, 'p1');

  client.socket.end();
  await srv.close();
});

test('server: a JSON line split across two chunks yields exactly one parsed frame', async () => {
  const sock = tempSocket();
  const seen: Frame[] = [];
  const srv = await startIpc(makeHandler(seen), sock);
  const client = await connectClient(sock);
  await waitFor(() => client.frames().find((f) => f.type === 'ready'));

  const frame = JSON.stringify({ type: 'utterance', id: 'split-1', text: 'hello', final: true }) + '\n';
  const cut = Math.floor(frame.length / 2);
  client.socket.write(frame.slice(0, cut));
  // small gap so the two writes land as separate `data` events
  await new Promise((r) => setTimeout(r, 30));
  client.socket.write(frame.slice(cut));

  const utt = await waitFor(() => seen.find((f) => f.type === 'utterance'));
  assert.equal(utt.type, 'utterance');
  // exactly one utterance parsed despite the split
  assert.equal(seen.filter((f) => f.type === 'utterance').length, 1);

  client.socket.end();
  await srv.close();
});

test('server: a malformed line replies with an error frame and does not crash', async () => {
  const sock = tempSocket();
  const seen: Frame[] = [];
  const srv = await startIpc(makeHandler(seen), sock);
  const client = await connectClient(sock);
  await waitFor(() => client.frames().find((f) => f.type === 'ready'));

  client.socket.write('{ this is not json }\n');
  const err = (await waitFor(() => client.frames().find((f) => f.type === 'error'))) as {
    type: string;
    message: string;
  };
  assert.match(err.message, /malformed JSON/);

  // the connection is still alive — a valid ping still gets answered
  client.socket.write(JSON.stringify({ type: 'ping', id: 'after-bad' }) + '\n');
  const pong = await waitFor(() => client.frames().find((f) => f.type === 'pong'));
  assert.equal(pong.type, 'pong');

  client.socket.end();
  await srv.close();
});

test('server: an invalid (schema-failing) frame replies with an error frame', async () => {
  const sock = tempSocket();
  const seen: Frame[] = [];
  const srv = await startIpc(makeHandler(seen), sock);
  const client = await connectClient(sock);
  await waitFor(() => client.frames().find((f) => f.type === 'ready'));

  // valid JSON, unknown frame type → schema rejects → error frame, no crash
  client.socket.write(JSON.stringify({ type: 'bogus', id: 'x' }) + '\n');
  const err = await waitFor(() => client.frames().find((f) => f.type === 'error'));
  assert.equal(err.type, 'error');

  client.socket.end();
  await srv.close();
});

test('server (control surface): pushes override.state + settings.state on connect, and handles update/query/override', async () => {
  const sock = tempSocket();
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-srvcfg-'));
  __setOwnerConfigPathForTest(path.join(cfgDir, 'safety-config.json'));
  const flagBefore = FLAGS.breakerEnabled;
  const srv = await startIpcServer(sock); // the DEFAULT loop-connected handler
  const client = await connectClient(sock);
  try {
    // (1) connect pushes the control-surface state unprompted.
    const os0 = (await waitFor(() => client.frames().find((f) => f.type === 'override.state'))) as {
      active: boolean;
    };
    assert.equal(os0.active, false, 'no override active on a fresh connect');
    await waitFor(() => client.frames().find((f) => f.type === 'settings.state'));

    // (2) settings.update flips the breaker + ceiling → echoed settings.state + live flag synced.
    client.socket.write(JSON.stringify({ type: 'settings.update', breakerEnabled: true, dailySpendCeiling: 30 }) + '\n');
    const ss = (await waitFor(() =>
      client.frames().find((f) => f.type === 'settings.state' && (f as { breakerEnabled: boolean }).breakerEnabled === true),
    )) as { breakerEnabled: boolean; dailySpendCeiling: number };
    assert.equal(ss.breakerEnabled, true);
    assert.equal(ss.dailySpendCeiling, 30);
    assert.equal(FLAGS.breakerEnabled, true, 'the live gate flag followed the owner toggle');

    // (3) audit.query is answered with an audit.data frame (empty is fine — no Red actions yet).
    client.socket.write(JSON.stringify({ type: 'audit.query', id: 'q1' }) + '\n');
    const ad = (await waitFor(() => client.frames().find((f) => f.type === 'audit.data'))) as {
      id: string;
      entries: unknown[];
    };
    assert.equal(ad.id, 'q1');
    assert.ok(Array.isArray(ad.entries));

    // (4) override activation broadcasts an active override.state with a future expiry.
    client.socket.write(JSON.stringify({ type: 'override', active: true, ttlMs: 5000 }) + '\n');
    const osActive = (await waitFor(() =>
      client.frames().find((f) => f.type === 'override.state' && (f as { active: boolean }).active === true),
    )) as { active: boolean; expiresAt?: number };
    assert.equal(osActive.active, true);
    assert.ok((osActive.expiresAt ?? 0) > 0, 'an active override carries an expiry to count down to');
  } finally {
    FLAGS.breakerEnabled = flagBefore;
    __setOwnerConfigPathForTest(null);
    client.socket.end();
    await srv.close();
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }
});
