/**
 * heartbeat.test.ts — the short-lived heartbeat job appends a dated line (CORE-03).
 *
 * Runs runHeartbeat() against a temp memory dir and asserts logs/{today}.md gained a
 * `heartbeat ...` line bearing today's date. (The launchd-fires-on-schedule behavior is
 * the manual Task-4 gate; here we prove the job's write contract.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runHeartbeat } from '../src/heartbeat.js';

function tempMemoryDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-hb-'));
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  return dir;
}

test('heartbeat: runHeartbeat appends a dated heartbeat line and resolves', async () => {
  const memoryDir = tempMemoryDir();
  const today = new Date().toISOString().slice(0, 10);

  const line = await runHeartbeat(memoryDir);
  assert.match(line, /^heartbeat /, 'returns the heartbeat line written');

  const file = path.join(memoryDir, 'logs', `${today}.md`);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /heartbeat /, 'log contains a heartbeat line');
  assert.ok(text.includes(today), 'heartbeat line bears today’s date');
});

test('heartbeat: a second run appends another line (append-only, never truncates)', async () => {
  const memoryDir = tempMemoryDir();
  const today = new Date().toISOString().slice(0, 10);
  const file = path.join(memoryDir, 'logs', `${today}.md`);

  await runHeartbeat(memoryDir);
  await runHeartbeat(memoryDir);

  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n').filter((l) => l.startsWith('heartbeat '));
  assert.equal(lines.length, 2, 'two heartbeat lines appended');
});
