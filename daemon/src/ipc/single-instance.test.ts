/**
 * single-instance.test.ts — the boot-time guard that stops a SECOND daemon from clobbering the
 * socket of a running one (the two-daemon bug: a manually-run daemon stole the launchd daemon's
 * socket and, lacking the owner's ~/.kernel.env, broke web/internet tools).
 *
 * `probeDaemonAlive` is the primitive index.ts uses: connect → alive; ENOENT/ECONNREFUSED → not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startIpc, probeDaemonAlive } from './server.js';

test('probeDaemonAlive: false when no socket file exists', async () => {
  const p = path.join(
    os.tmpdir(),
    `kernel-probe-absent-${process.pid}-${Math.random().toString(36).slice(2)}.sock`,
  );
  assert.equal(await probeDaemonAlive(p), false, 'ENOENT → not alive');
});

test('probeDaemonAlive: true while a daemon listens, false after it closes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-probe-'));
  const p = path.join(dir, 'kernel.sock');
  const ipc = await startIpc(() => {}, p);
  try {
    assert.equal(await probeDaemonAlive(p), true, 'a live listener probes alive');
  } finally {
    await ipc.close();
  }
  // After close the socket file is unlinked → a probe must report dead (safe to bind a new one).
  assert.equal(await probeDaemonAlive(p), false, 'no listener after close → not alive');
  fs.rmSync(dir, { recursive: true, force: true });
});
