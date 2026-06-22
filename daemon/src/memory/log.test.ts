/**
 * log.test.ts — append-only session blocks + heartbeat lines (CORE-05).
 *
 * Runs against a temp memory dir. Asserts logSession appends numbered `## Session N`
 * blocks (never truncating prior blocks) and logHeartbeat adds a dated line.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { logSession, logHeartbeat } from './log.js';

function tempMemoryDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-mem-'));
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  return dir;
}

function todayLog(memoryDir: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return path.join(memoryDir, 'logs', `${today}.md`);
}

test('logSession: appends two numbered ## Session blocks, first stays intact (append-only)', () => {
  const memoryDir = tempMemoryDir();

  const n1 = logSession(
    {
      intent: { source: 'user', payload: 'first utterance', id: 'a1' },
      decision: { thought: 'first thought', reply: 'first reply' },
    },
    memoryDir,
  );
  assert.equal(n1, 1);

  const afterFirst = fs.readFileSync(todayLog(memoryDir), 'utf8');

  const n2 = logSession(
    {
      intent: { source: 'user', payload: 'second utterance', id: 'a2' },
      decision: { thought: 'second thought', reply: 'second reply' },
    },
    memoryDir,
  );
  assert.equal(n2, 2);

  const text = fs.readFileSync(todayLog(memoryDir), 'utf8');
  const blocks = text.match(/^## Session \d+/gm) ?? [];
  assert.equal(blocks.length, 2, 'two ## Session blocks must exist');
  assert.match(text, /## Session 1/);
  assert.match(text, /## Session 2/);

  // append-only: the entire first-write content is still a prefix of the file.
  assert.ok(text.startsWith(afterFirst), 'first block must remain intact (never truncated)');
  assert.match(text, /first utterance/);
  assert.match(text, /second utterance/);
});

test('logHeartbeat: appends a dated heartbeat line bearing today’s date', () => {
  const memoryDir = tempMemoryDir();
  const today = new Date().toISOString().slice(0, 10);

  const line = logHeartbeat(memoryDir);
  assert.match(line, /^heartbeat /);

  const text = fs.readFileSync(todayLog(memoryDir), 'utf8');
  assert.match(text, /heartbeat /);
  assert.ok(text.includes(today), 'heartbeat line must include today’s date');
});

test('logHeartbeat then logSession both append to the same dated file', () => {
  const memoryDir = tempMemoryDir();
  logHeartbeat(memoryDir);
  logSession(
    { intent: { source: 'schedule', payload: 'tick' }, decision: { thought: 't' } },
    memoryDir,
  );
  const text = fs.readFileSync(todayLog(memoryDir), 'utf8');
  assert.match(text, /heartbeat /);
  assert.match(text, /## Session 1/);
});
