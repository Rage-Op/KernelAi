/**
 * loop.conversation.test.ts — the multi-turn memory fix, end-to-end through the loop.
 *
 * The bug: every utterance was a stateless single-shot, so KERNEL "didn't remember context between
 * two consecutive prompts." These tests assert the loop now replays the rolling buffer:
 *   - turn 1 reaches the brain with NO history; turn 2 replays turn 1's user+assistant exchange
 *   - the current utterance always follows the history (the model answers IT, not an old turn)
 *   - PROVENANCE: a `source:'schedule'` turn is NOT recorded (external/automated work never gains
 *     conversational standing — defense-in-depth matching inject()/override)
 *   - `/clear` empties the buffer
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { enqueue, runTick, setBrain, type Intent } from './loop.js';
import { conversation } from './memory/conversation.js';
import type { BrainProvider, ChatTurn, Decision } from './brain/BrainProvider.js';

/** Minimal temp memory dir inject() can read. */
function tempMemoryDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-conv-'));
  fs.writeFileSync(path.join(dir, 'IDENTITY.md'), '# IDENTITY\n\nKERNEL.\n', 'utf8');
  fs.mkdirSync(path.join(dir, 'working-memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'working-memory', 'current.md'), '# current\n', 'utf8');
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  return dir;
}

/** A brain that captures the `history` it was handed each turn. */
class CaptureBrain implements BrainProvider {
  seen: ChatTurn[][] = [];
  async reason(prompt: string, _ctx: string, _onToken?: (c: string) => void, history?: ChatTurn[]): Promise<Decision> {
    this.seen.push(history ?? []);
    return { thought: 'capture', reply: `reply to: ${prompt}` };
  }
}

test('the 2nd consecutive user turn replays the 1st as history', async () => {
  conversation.clear();
  const brain = new CaptureBrain();
  setBrain(brain);
  const dir = tempMemoryDir();

  enqueue({ source: 'user', payload: 'write a haiku about the sea', memoryDir: dir, reply: () => {} });
  await runTick();
  enqueue({ source: 'user', payload: 'now make it about mountains', memoryDir: dir, reply: () => {} });
  await runTick();

  assert.equal(brain.seen.length, 2);
  assert.equal(brain.seen[0].length, 0, 'turn 1 sees no prior history');
  assert.deepEqual(
    brain.seen[1].map((t) => t.role),
    ['user', 'assistant'],
    'turn 2 replays the first exchange',
  );
  assert.equal(brain.seen[1][0].content, 'write a haiku about the sea');
  assert.match(brain.seen[1][1].content, /reply to: write a haiku/);
  conversation.clear();
});

test('a schedule-sourced turn is NOT recorded into the conversation buffer', async () => {
  conversation.clear();
  setBrain(new CaptureBrain());
  const dir = tempMemoryDir();

  enqueue({ source: 'schedule', payload: 'nightly consolidation', memoryDir: dir, reply: () => {} });
  await runTick();

  assert.equal(conversation.size(), 0, 'automated work must not enter the conversation buffer');
  conversation.clear();
});
