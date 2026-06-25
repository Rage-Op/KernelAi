/**
 * server.test.ts — the transport-agnostic frame ROUTER + on-connect burst + control-surface handlers.
 *
 * Exercises the daemon's side of the contract directly through an in-memory mock `ClientConn` (the
 * primitive the web SSE transport wraps): `sendConnectFrames` pushes the on-connect snapshot, `routeFrame`
 * validates + dispatches inbound frames, and a malformed/invalid frame or a throwing handler is surfaced
 * as an `error` frame rather than crashing the daemon (T-01-09). (The line-framing/partial-buffer +
 * malformed-JSON tests moved out with the UDS transport; the web POST path's JSON parsing is covered by
 * http-server.test.ts.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  routeFrame,
  defaultFrameHandler,
  sendConnectFrames,
  addClient,
  removeClient,
  type ClientConn,
} from './server.js';
import type { Frame } from './protocol.js';
import { __setOwnerConfigPathForTest } from '../safety/owner-config.js';
import { FLAGS } from '../safety/flags.js';

/** A mock client collecting the frames the daemon pushes to it (the SSE transport's ClientConn). */
function mockClient(): { conn: ClientConn; frames: Frame[] } {
  const frames: Frame[] = [];
  const conn: ClientConn = { kind: 'web', send: (f) => frames.push(f) };
  return { conn, frames };
}

test('server: sendConnectFrames pushes ready + capabilities + control-surface + model state', () => {
  const { conn, frames } = mockClient();
  sendConnectFrames(conn);
  for (const t of ['ready', 'capabilities', 'override.state', 'settings.state', 'model.state']) {
    assert.ok(frames.find((f) => f.type === t), `the connect burst includes ${t}`);
  }
});

test('server: routeFrame answers ping → pong (default handler)', () => {
  const { conn, frames } = mockClient();
  routeFrame({ type: 'ping', id: 'p1' }, conn, defaultFrameHandler);
  const pong = frames.find((f) => f.type === 'pong') as { id: string } | undefined;
  assert.equal(pong?.id, 'p1');
});

test('server: routeFrame replies with an error frame for a schema-invalid frame (no throw)', () => {
  const { conn, frames } = mockClient();
  routeFrame({ type: 'bogus', id: 'x' }, conn, defaultFrameHandler);
  const err = frames.find((f) => f.type === 'error') as { id?: string; message: string } | undefined;
  assert.ok(err, 'an error frame is sent');
  assert.match(err!.message, /invalid frame/);
  assert.equal(err!.id, 'x', 'the error correlates to the offending frame id');
});

test('server: routeFrame catches a handler error and surfaces it as an error frame', () => {
  const { conn, frames } = mockClient();
  routeFrame({ type: 'ping', id: 'boom' }, conn, () => {
    throw new Error('kaboom');
  });
  const err = frames.find((f) => f.type === 'error') as { id?: string; message: string } | undefined;
  assert.ok(err, 'a handler error never crashes the router');
  assert.match(err!.message, /handler error: kaboom/);
  assert.equal(err!.id, 'boom', 'the error correlates to the frame id');
});

test('server (control surface): connect pushes override.state + settings.state, and update/query/override work', () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-srvcfg-'));
  __setOwnerConfigPathForTest(path.join(cfgDir, 'safety-config.json'));
  const flagBefore = FLAGS.breakerEnabled;
  const { conn, frames } = mockClient();
  addClient(conn); // so broadcasts (settings.state / override.state) reach this client
  try {
    // (1) connect pushes the control-surface state.
    sendConnectFrames(conn);
    const os0 = frames.find((f) => f.type === 'override.state') as { active: boolean } | undefined;
    assert.equal(os0?.active, false, 'no override active on a fresh connect');
    assert.ok(frames.find((f) => f.type === 'settings.state'), 'settings.state pushed on connect');

    // (2) settings.update flips the breaker + ceiling → broadcast settings.state + live flag synced.
    routeFrame({ type: 'settings.update', breakerEnabled: true, dailySpendCeiling: 30 }, conn, defaultFrameHandler);
    const ss = frames.find(
      (f) => f.type === 'settings.state' && (f as { breakerEnabled: boolean }).breakerEnabled === true,
    ) as { breakerEnabled: boolean; dailySpendCeiling: number } | undefined;
    assert.equal(ss?.breakerEnabled, true);
    assert.equal(ss?.dailySpendCeiling, 30);
    assert.equal(FLAGS.breakerEnabled, true, 'the live gate flag followed the owner toggle');

    // (3) audit.query is answered with an audit.data frame (empty is fine — no Red actions yet).
    routeFrame({ type: 'audit.query', id: 'q1' }, conn, defaultFrameHandler);
    const ad = frames.find((f) => f.type === 'audit.data') as { id: string; entries: unknown[] } | undefined;
    assert.equal(ad?.id, 'q1');
    assert.ok(Array.isArray(ad?.entries));

    // (4) override activation broadcasts an active override.state with a future expiry.
    routeFrame({ type: 'override', active: true, ttlMs: 5000 }, conn, defaultFrameHandler);
    const osActive = frames.find(
      (f) => f.type === 'override.state' && (f as { active: boolean }).active === true,
    ) as { active: boolean; expiresAt?: number } | undefined;
    assert.equal(osActive?.active, true);
    assert.ok((osActive?.expiresAt ?? 0) > 0, 'an active override carries an expiry to count down to');
  } finally {
    // deactivate the override so it doesn't leak into sibling tests in this process.
    routeFrame({ type: 'override', active: false }, conn, defaultFrameHandler);
    FLAGS.breakerEnabled = flagBefore;
    __setOwnerConfigPathForTest(null);
    removeClient(conn);
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }
});
