/**
 * breaker-wiring.test.ts — the PRODUCTION IPC↔breaker wiring (SAFE-03 gap closure).
 *
 * Closes the verifier WARNING: the production `emitPreview` was a no-op, so a live Red action's
 * dry-run PREVIEW never reached the Face and the owner could not use the 10s cancel window. These
 * tests prove the END-TO-END seam over a REAL UDS IPC server (no mock transport) with the REAL
 * production breaker deps (`registry.defaultBreakerDeps` via `dispatch`):
 *
 *   1. emitPreview BROADCASTS a `breaker.preview` frame to a connected (mock) Face client.
 *   2. a `breaker.cancel` frame WITHIN the window cancels the pending Red action — the tool's
 *      executor is NEVER called.
 *   3. NO Face client connected → the action is STILL gated (ceiling+audit), no crash; the
 *      preview simply isn't surfaced (a live cancel is not possible — locked SAFE-03 default).
 *
 * NO real irreversible action is performed: the registered `fs` tool's execute is a recording
 * spy. The window is shortened via KERNEL_DAILY_SPEND_CEILING-independent paths; the proceed path
 * here is non-financial (estimatedSpend 0) so it never crosses the ceiling.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';

import { startIpc, broadcast } from './server.js';
import type { Frame } from './protocol.js';
import {
  register,
  dispatch,
  clearRegistry,
  setBreakerDeps,
  resetBreakerCancel,
} from '../tools/registry.js';
import type { Tool, ToolResult } from '../tools/Tool.js';
import { FLAGS } from '../safety/flags.js';

function tempSocket(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-breaker-'));
  return path.join(dir, 'k.sock');
}

/** A minimal NDJSON client collecting parsed inbound frames. */
function connectClient(socketPath: string): Promise<{ socket: net.Socket; frames: () => Frame[] }> {
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

/** A recording `fs` tool: its execute is a spy that NEVER performs a real action. */
function recordingFsTool(): { tool: Tool; calls: () => number } {
  let n = 0;
  const tool: Tool = {
    name: 'fs',
    schema: z.object({ op: z.string(), path: z.string().optional() }),
    async execute(): Promise<ToolResult> {
      n += 1;
      return { ok: true, data: { ran: true } };
    },
  };
  return { tool, calls: () => n };
}

/** Run a block with the breaker flag forced ON + a short cancel window, restoring everything after. */
async function withBreakerEnabled(fn: () => Promise<void>): Promise<void> {
  const prevFlag = FLAGS.breakerEnabled;
  const prevWindow = process.env.KERNEL_BREAKER_WINDOW_MS;
  FLAGS.breakerEnabled = true;
  // A short real-clock window so the proceed/stale-cancel paths don't wait the full 10s. The
  // PRODUCTION default stays 10s (spec §8); only these tests shorten it via the env override.
  process.env.KERNEL_BREAKER_WINDOW_MS = '300';
  try {
    await fn();
  } finally {
    FLAGS.breakerEnabled = prevFlag;
    if (prevWindow === undefined) delete process.env.KERNEL_BREAKER_WINDOW_MS;
    else process.env.KERNEL_BREAKER_WINDOW_MS = prevWindow;
    setBreakerDeps(null);
    resetBreakerCancel();
  }
}

test('breaker-wiring: emitPreview BROADCASTS a breaker.preview frame to a connected Face client', async () => {
  await withBreakerEnabled(async () => {
    clearRegistry();
    const { tool } = recordingFsTool();
    register(tool);

    const sock = tempSocket();
    // startIpc wires setBreakerBroadcast(...) so the production defaultBreakerDeps.emitPreview pushes.
    const srv = await startIpc((f) => void f, sock);
    const client = await connectClient(sock);
    await waitFor(() => client.frames().find((f) => f.type === 'ready'));

    // Dispatch a Red action through the REAL production breaker deps. We only care that the
    // preview was broadcast (the short window then proceeds; fs.execute is a recording spy).
    const dispatched = dispatch({ tool: 'fs', args: { op: 'rm -rf', path: '/tmp/x' }, origin: 'user' });

    const preview = (await waitFor(() =>
      client.frames().find((f) => f.type === 'breaker.preview'),
    )) as Extract<Frame, { type: 'breaker.preview' }>;
    await dispatched;

    assert.equal(preview.type, 'breaker.preview');
    assert.equal(preview.tier, 'red', 'the preview is tagged red');
    assert.match(preview.summary, /rm -rf|Red action/, 'the summary describes the Red action');
    assert.equal(typeof preview.id, 'string', 'a correlation id is stamped for the cancel frame');
    assert.equal(preview.estimatedSpend, 0, 'a non-financial Red op has estimatedSpend 0');

    client.socket.end();
    await srv.close();
  });
});

test('breaker-wiring: a breaker.cancel frame WITHIN the window cancels — the executor is NEVER called', async () => {
  await withBreakerEnabled(async () => {
    clearRegistry();
    const { tool, calls } = recordingFsTool();
    register(tool);

    const sock = tempSocket();
    const srv = await startIpc(undefined, sock); // default handler routes breaker.cancel → signalBreakerCancel
    const client = await connectClient(sock);
    await waitFor(() => client.frames().find((f) => f.type === 'ready'));

    // Kick off the gated Red dispatch (real deps: a 10s window on the real clock). It is in-flight.
    const dispatched = dispatch({ tool: 'fs', args: { op: 'rm -rf', path: '/tmp/y' }, origin: 'user' });

    // The Face receives the preview, reads its id, and sends a matching breaker.cancel WITHIN the window.
    const preview = (await waitFor(() =>
      client.frames().find((f) => f.type === 'breaker.preview'),
    )) as Extract<Frame, { type: 'breaker.preview' }>;
    client.socket.write(JSON.stringify({ type: 'breaker.cancel', id: preview.id }) + '\n');

    const result = await dispatched;

    assert.equal(result.ok, false, 'a cancelled Red action returns an escalation, not success');
    assert.match(result.escalation?.reason ?? '', /cancel/i, 'the escalation cites the cancel');
    assert.equal(calls(), 0, 'the tool executor is NEVER called when cancelled within the window');

    client.socket.end();
    await srv.close();
  });
});

test('breaker-wiring: a STALE breaker.cancel id (not the active preview) does NOT cancel the in-flight run', async () => {
  await withBreakerEnabled(async () => {
    clearRegistry();
    const { tool, calls } = recordingFsTool();
    register(tool);

    const sock = tempSocket();
    const srv = await startIpc(undefined, sock);
    const client = await connectClient(sock);
    await waitFor(() => client.frames().find((f) => f.type === 'ready'));

    // A non-financial Red op proceeds at the end of the window (ceiling 0 default, spend 0 ⇒ OK).
    const dispatched = dispatch({ tool: 'fs', args: { op: 'rm -rf', path: '/tmp/z' }, origin: 'user' });
    await waitFor(() => client.frames().find((f) => f.type === 'breaker.preview'));

    // A cancel for a DIFFERENT (stale) id must be IGNORED — it cannot abort this run.
    client.socket.write(JSON.stringify({ type: 'breaker.cancel', id: 'bp-stale-not-active' }) + '\n');

    const result = await dispatched;
    assert.equal(result.ok, true, 'a stale-id cancel did not abort: the action proceeded');
    assert.equal(calls(), 1, 'the executor ran exactly once (the stale cancel was ignored)');

    client.socket.end();
    await srv.close();
  });
});

test('breaker-wiring: NO Face connected → the Red action is STILL gated, no crash (headless: cannot live-cancel)', async () => {
  await withBreakerEnabled(async () => {
    clearRegistry();
    const { tool, calls } = recordingFsTool();
    register(tool);

    const sock = tempSocket();
    const srv = await startIpc(undefined, sock); // server up, but NO client connects.

    // The broadcast fans out to ZERO clients — broadcast returns 0, the preview is not surfaced,
    // and the gated run still completes through the breaker (ceiling+audit) WITHOUT crashing.
    assert.equal(broadcast({ type: 'breaker.preview', id: 'x', summary: 's', estimatedSpend: 0, tier: 'red' }), 0, 'broadcast to zero clients delivers to nobody');

    const result = await dispatch({ tool: 'fs', args: { op: 'rm -rf', path: '/tmp/none' }, origin: 'user' });

    // Non-financial Red op, default ceiling 0, spend 0 ⇒ window elapses → ceiling OK → executes.
    assert.equal(result.ok, true, 'the action is still gated through the breaker and proceeds (no live cancel)');
    assert.equal(calls(), 1, 'the breaker drove the executor exactly once on the headless proceed path');

    await srv.close();
  });
});
