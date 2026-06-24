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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ConversationBuffer, MAX_TURNS, HISTORY_TOKEN_BUDGET, estTokens } from './conversation.js';

/** A fresh temp transcript path per persistence test (never touches the real App Support dir). */
function tmpLog(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-conv-'));
  return path.join(dir, 'conversation.jsonl');
}

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

// --- persistence (the "store chat history + remember across restart" fix) --------------------

test('persists turns to disk and reloads recent context on a fresh buffer (restart)', () => {
  const log = tmpLog();
  const a = new ConversationBuffer(log);
  a.recordUser('hello');
  a.recordAssistant('hi there');
  a.recordUser('what did I just say?');

  // A NEW buffer (simulating a daemon restart) reloads the recent dialogue from disk.
  const b = new ConversationBuffer(log);
  assert.equal(b.size(), 0, 'a fresh buffer is empty until load()');
  b.load();
  const h = b.history();
  assert.equal(h.length, 3, 'reloaded the 3 persisted turns');
  assert.deepEqual(h.map((t) => t.content), ['hello', 'hi there', 'what did I just say?']);
});

test('readRecent returns owner/assistant turns with timestamps, capped to the limit', () => {
  const log = tmpLog();
  const buf = new ConversationBuffer(log);
  for (let i = 0; i < 5; i++) {
    buf.recordUser(`q${i}`);
    buf.recordAssistant(`a${i}`);
  }
  const recent = buf.readRecent(4);
  assert.equal(recent.length, 4, 'capped to the limit');
  // recorded order: q0 a0 q1 a1 q2 a2 q3 a3 q4 a4  → the newest 4 are q3,a3,q4,a4.
  assert.deepEqual(recent.map((t) => t.text), ['q3', 'a3', 'q4', 'a4']);
  assert.ok(recent.every((t) => typeof t.ts === 'number'), 'every entry carries a numeric ts');
});

test('clear() writes a sentinel: load() resets context but readRecent keeps full history', () => {
  const log = tmpLog();
  const buf = new ConversationBuffer(log);
  buf.recordUser('old convo');
  buf.recordAssistant('old reply');
  buf.clear(); // start fresh — but the history record persists
  buf.recordUser('new convo');
  buf.recordAssistant('new reply');

  // A restart restores ONLY the post-clear turns into the model's context.
  const restarted = new ConversationBuffer(log);
  restarted.load();
  assert.deepEqual(
    restarted.history().map((t) => t.content),
    ['new convo', 'new reply'],
    'model context resets at the last /clear',
  );
  // …but the Chat page still sees the WHOLE transcript across the clear.
  assert.deepEqual(
    buf.readRecent().map((t) => t.text),
    ['old convo', 'old reply', 'new convo', 'new reply'],
    'history view keeps everything',
  );
});

test('an in-memory-only buffer (no logPath) never touches disk', () => {
  const buf = new ConversationBuffer(); // null logPath
  buf.recordUser('ephemeral');
  assert.deepEqual(buf.readRecent(), [], 'no persistence → readRecent is empty');
  buf.load(); // no-op, must not throw
  assert.equal(buf.size(), 1, 'in-memory turn survives a no-op load');
});
