/**
 * conversation.test.ts — the rolling short-term conversation buffer (the multi-turn-memory fix).
 *
 * Asserts the mechanics the loop relies on:
 *   - records user/assistant turns and replays them in CHRONOLOGICAL order
 *   - never exceeds the MAX_TURNS cap (oldest dropped first)
 *   - never exceeds the token budget (oldest dropped first; clamped to HISTORY_TOKEN_BUDGET)
 *   - blank turns are ignored; clear() empties it
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConversationBuffer, MAX_TURNS, HISTORY_TOKEN_BUDGET, estTokens } from './conversation.js';

test('records turns and replays them in chronological order', () => {
  const buf = new ConversationBuffer();
  buf.recordUser('write a haiku about the sea');
  buf.recordAssistant('Salt wind on grey swells / …');
  buf.recordUser('now make it about mountains');

  const h = buf.history();
  assert.equal(h.length, 3);
  assert.deepEqual(h.map((t) => t.role), ['user', 'assistant', 'user']);
  assert.equal(h[0].content, 'write a haiku about the sea');
  assert.equal(h[2].content, 'now make it about mountains');
});

test('caps at MAX_TURNS, dropping the oldest first', () => {
  const buf = new ConversationBuffer();
  for (let i = 0; i < MAX_TURNS + 4; i++) buf.recordUser(`turn ${i}`);
  const h = buf.history();
  assert.equal(h.length, MAX_TURNS);
  // the oldest kept turn is the (size - MAX_TURNS)th recorded one — earliest turns were dropped.
  assert.equal(h[0].content, `turn ${MAX_TURNS + 4 - MAX_TURNS}`);
  assert.equal(h[h.length - 1].content, `turn ${MAX_TURNS + 3}`);
});

test('respects the token budget, dropping the oldest first', () => {
  const buf = new ConversationBuffer();
  // three ~250-token turns (1000 chars each)
  const big = 'x'.repeat(1000);
  buf.recordUser(big);
  buf.recordAssistant(big);
  buf.recordUser(big);
  // budget for ~one turn only
  const h = buf.history(estTokens(big) + 1);
  assert.equal(h.length, 1);
  assert.equal(h[0].content, big); // the NEWEST turn is the one kept
});

test('clamps an oversized budget to HISTORY_TOKEN_BUDGET', () => {
  const buf = new ConversationBuffer();
  // many small turns whose total exceeds the hard cap
  const chunk = 'y'.repeat(400); // ~100 tokens each
  for (let i = 0; i < 8; i++) buf.recordUser(chunk);
  const h = buf.history(1_000_000); // absurd budget — must still clamp
  const tokens = h.reduce((n, t) => n + estTokens(t.content), 0);
  assert.ok(tokens <= HISTORY_TOKEN_BUDGET, `history tokens ${tokens} must be ≤ ${HISTORY_TOKEN_BUDGET}`);
});

test('ignores blank turns and clear() empties the buffer', () => {
  const buf = new ConversationBuffer();
  buf.recordUser('   ');
  buf.recordAssistant('');
  assert.equal(buf.size(), 0);
  buf.recordUser('real');
  assert.equal(buf.size(), 1);
  buf.clear();
  assert.equal(buf.size(), 0);
  assert.deepEqual(buf.history(), []);
});
