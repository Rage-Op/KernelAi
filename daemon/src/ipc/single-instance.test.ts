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
import {
  acquireSingleInstanceLock,
  lockPath,
  pidAlive,
  pidIsResidentDaemon,
} from './single-instance-lock.js';

/** A pid that effectively never exists on macOS (max pid ~99998) — a reliable "dead holder". */
const DEAD_PID = 2_147_483_646;

function tmpLock(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-lock-'));
  return path.join(dir, 'daemon.pid');
}

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

// --- PID lock: catches a live-but-UNREACHABLE daemon the connect-probe misses (the real bug) ---

test('pidAlive: true for this process, false for a dead/invalid pid', () => {
  assert.equal(pidAlive(process.pid), true, 'our own pid is alive');
  assert.equal(pidAlive(DEAD_PID), false, 'a never-existing pid is dead');
  assert.equal(pidAlive(0), false, 'pid 0 is invalid');
  assert.equal(pidAlive(-1), false, 'negative pid is invalid');
});

test('acquireSingleInstanceLock: acquires a fresh lock and writes our pid', () => {
  const p = tmpLock();
  const r = acquireSingleInstanceLock(p, 4321);
  assert.equal(r.acquired, true, 'fresh lock is acquired');
  assert.equal(fs.readFileSync(p, 'utf8').trim(), '4321', 'our pid is written');
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('acquireSingleInstanceLock: REFUSES when a LIVE resident-daemon pid already holds the lock', () => {
  const p = tmpLock();
  fs.writeFileSync(p, '4242');
  // Inject "holder is a live resident daemon" so the test doesn't depend on a real daemon process.
  const r = acquireSingleInstanceLock(p, 9999, () => true);
  assert.equal(r.acquired, false, 'a live resident-daemon holder blocks a second daemon');
  assert.equal(r.heldByPid, 4242, 'reports who holds it');
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('pidIsResidentDaemon: false for the test runner (not a daemon) and for a dead pid', () => {
  // The test process command is `node --test …`, NOT `dist/index.js`, so it is not a resident daemon.
  assert.equal(pidIsResidentDaemon(process.pid), false, 'the test runner is not a KERNEL daemon');
  assert.equal(pidIsResidentDaemon(DEAD_PID), false, 'a dead pid is not a daemon');
});

test('acquireSingleInstanceLock: STEALS a recycled LIVE pid that is NOT a resident daemon (pid-reuse safety)', () => {
  const p = tmpLock();
  fs.writeFileSync(p, String(process.pid)); // a LIVE pid, but it's the test runner, not a daemon
  const r = acquireSingleInstanceLock(p, 7777); // default liveness = pidIsResidentDaemon → false → steal
  assert.equal(r.acquired, true, 'a live-but-not-a-daemon (recycled) pid is stolen, not refused');
  assert.equal(fs.readFileSync(p, 'utf8').trim(), '7777', 'we take over the lock');
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('acquireSingleInstanceLock: STEALS a stale lock (dead holder) and takes over', () => {
  const p = tmpLock();
  fs.writeFileSync(p, String(DEAD_PID)); // a stale lock from a crashed daemon
  const r = acquireSingleInstanceLock(p, 5555);
  assert.equal(r.acquired, true, 'a stale (dead-pid) lock is stolen');
  assert.equal(fs.readFileSync(p, 'utf8').trim(), '5555', 'we take over the lock file');
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('acquireSingleInstanceLock: re-entrant — the same pid re-acquires its own lock', () => {
  const p = tmpLock();
  assert.equal(acquireSingleInstanceLock(p, 6789).acquired, true, 'first acquire');
  assert.equal(acquireSingleInstanceLock(p, 6789).acquired, true, 'same pid re-acquires');
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('lockPath: sits beside the socket (App Support), not in the memory repo', () => {
  assert.equal(lockPath('/x/y/Kernel/kernel.sock'), '/x/y/Kernel/daemon.pid');
});
