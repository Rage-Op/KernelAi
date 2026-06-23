/**
 * loop-intercept.test.ts — meta-commands short-circuit the loop BEFORE the brain.
 *
 * The loop must answer `context`/`usage`/`compact` (typed or natural-language) deterministically
 * without ever reaching brain.reason(), and must STILL route an ordinary utterance to the brain.
 * Uses a SpyBrain to prove which path ran. (node --test isolates this file's loop singleton.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { enqueue, drain, setBrain } from '../loop.js';
import type { BrainProvider, Decision } from '../brain/BrainProvider.js';

class SpyBrain implements BrainProvider {
  called = false;
  async reason(): Promise<Decision> {
    this.called = true;
    return { thought: 'spy', reply: 'BRAIN REPLY (should not appear for a command)' };
  }
}

function tempMemoryDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-loopcmd-'));
  fs.writeFileSync(path.join(dir, 'IDENTITY.md'), '# IDENTITY\n\nKERNEL is Pravin.\n', 'utf8');
  fs.mkdirSync(path.join(dir, 'working-memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'working-memory', 'current.md'), '# Current\n\nnothing in flight.\n', 'utf8');
  for (const d of ['logs', 'self', 'knowledge', 'tasks', 'projects']) {
    fs.mkdirSync(path.join(dir, d), { recursive: true });
  }
  return dir;
}

async function runUtterance(text: string, dir: string, spy: SpyBrain): Promise<string[]> {
  const replies: string[] = [];
  enqueue({ source: 'user', id: 't', payload: text, memoryDir: dir, reply: (r) => replies.push(r) });
  await drain();
  return replies;
}

test('typed /context is answered by the command, not the brain', async () => {
  const spy = new SpyBrain();
  setBrain(spy);
  const replies = await runUtterance('/context', tempMemoryDir(), spy);
  assert.equal(spy.called, false, 'brain.reason was NOT called');
  assert.match(replies[0] ?? '', /KERNEL · context/);
});

test('natural-language "how much have I used" routes to the usage command', async () => {
  const spy = new SpyBrain();
  setBrain(spy);
  const replies = await runUtterance('how much have I used so far', tempMemoryDir(), spy);
  assert.equal(spy.called, false, 'brain.reason was NOT called');
  assert.match(replies[0] ?? '', /KERNEL · usage/);
});

test('an ordinary utterance still reaches the brain', async () => {
  const spy = new SpyBrain();
  setBrain(spy);
  const replies = await runUtterance('what is the weather like today', tempMemoryDir(), spy);
  assert.equal(spy.called, true, 'brain.reason WAS called for a non-command');
  assert.match(replies[0] ?? '', /BRAIN REPLY/);
});
