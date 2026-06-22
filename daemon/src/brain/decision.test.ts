/**
 * decision.test.ts — parseDecision: schema match, salvage of non-Decision envelopes, and the
 * never-throw degraded path. Covers the small-local-model case where Ollama returns valid JSON
 * that is NOT a Decision (a chat envelope), which must surface readable text, not raw JSON.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDecision } from './decision.js';

test('parseDecision: a valid Decision JSON passes through unchanged', () => {
  const d = parseDecision(JSON.stringify({ thought: 'considered', reply: 'Hello.' }));
  assert.equal(d.thought, 'considered');
  assert.equal(d.reply, 'Hello.');
});

test('parseDecision: an Ollama chat envelope {role,content} salvages content as the reply', () => {
  const d = parseDecision(JSON.stringify({ role: 'assistant', content: 'I am KERNEL.' }));
  assert.equal(d.reply, 'I am KERNEL.', 'content is surfaced, not the raw JSON');
  assert.doesNotMatch(d.reply!, /[{}"]/, 'no raw JSON leaks into the reply');
});

test('parseDecision: a {reply} object missing the required thought still surfaces the reply', () => {
  const d = parseDecision(JSON.stringify({ reply: 'Just the reply.' }));
  assert.equal(d.reply, 'Just the reply.');
});

test('parseDecision: a nested {message:{content}} envelope is salvaged', () => {
  const d = parseDecision(JSON.stringify({ message: { role: 'assistant', content: 'nested text' } }));
  assert.equal(d.reply, 'nested text');
});

test('parseDecision: non-JSON degrades to the raw text clipped (never throws)', () => {
  const d = parseDecision('not json at all');
  assert.equal(d.reply, 'not json at all');
});

test('parseDecision: valid JSON with no readable field falls back to the clipped raw text', () => {
  const raw = JSON.stringify({ foo: 1, bar: true });
  const d = parseDecision(raw);
  assert.equal(d.reply, raw.slice(0, 500), 'nothing readable → raw fallback');
});
