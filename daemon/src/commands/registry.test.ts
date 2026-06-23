/**
 * registry.test.ts — the meta-command parser (parseCommand).
 *
 * Asserts the deterministic resolution of typed slash commands, standalone keywords, and
 * conservative natural-language phrasing — and, crucially, that it NEVER fires on non-user
 * (injected/external) text and does NOT hijack ordinary requests that merely contain the words.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCommand } from './registry.js';

test('explicit slash commands resolve with their arg', () => {
  assert.deepEqual(parseCommand('/context', 'user'), { name: 'context', arg: '' });
  assert.deepEqual(parseCommand('/usage', 'user'), { name: 'usage', arg: '' });
  assert.deepEqual(parseCommand('/usage reset', 'user'), { name: 'usage', arg: 'reset' });
  assert.deepEqual(parseCommand('/compact focus on the build', 'user'), {
    name: 'compact',
    arg: 'focus on the build',
  });
});

test('slash aliases map to the canonical command', () => {
  assert.equal(parseCommand('/ctx', 'user')?.name, 'context');
  assert.equal(parseCommand('/cost', 'user')?.name, 'usage');
  assert.equal(parseCommand('/tokens', 'user')?.name, 'usage');
  assert.equal(parseCommand('/condense', 'user')?.name, 'compact');
});

test('an unknown slash command is NOT intercepted (falls through to the brain)', () => {
  assert.equal(parseCommand('/banana', 'user'), null);
});

test('standalone keywords trigger; focus text comes via the explicit slash form', () => {
  assert.equal(parseCommand('context', 'user')?.name, 'context');
  assert.equal(parseCommand('ctx', 'user')?.name, 'context');
  assert.equal(parseCommand('usage', 'user')?.name, 'usage');
  assert.equal(parseCommand('compact', 'user')?.name, 'compact');
  assert.equal(parseCommand('context.', 'user')?.name, 'context'); // trailing punctuation tolerated
  // Focus instructions are carried by the slash form (bare "compact X" is too ambiguous with a task).
  assert.deepEqual(parseCommand('/compact the finance notes', 'user'), {
    name: 'compact',
    arg: 'the finance notes',
  });
});

test('conservative natural-language phrasings resolve', () => {
  assert.equal(parseCommand("what's in your context?", 'user')?.name, 'context');
  assert.equal(parseCommand('show me the context', 'user')?.name, 'context');
  assert.equal(parseCommand('how much context is left', 'user')?.name, 'context');
  assert.equal(parseCommand('how much have I used', 'user')?.name, 'usage');
  assert.equal(parseCommand('how many tokens did this cost', 'user')?.name, 'usage');
  assert.equal(parseCommand('summarize the conversation', 'user')?.name, 'compact');
  assert.equal(parseCommand('free up some context', 'user')?.name, 'compact');
});

test('does NOT hijack ordinary requests that merely mention the words', () => {
  assert.equal(parseCommand('add more context to the README intro', 'user'), null);
  assert.equal(parseCommand('the usage stats page looks broken, fix it', 'user'), null);
  assert.equal(parseCommand('tokens are expensive these days', 'user'), null);
  assert.equal(parseCommand('compact the sprint scope into one doc', 'user'), null);
});

test('SECURITY: only source:user text is ever parsed (external/self never trigger a command)', () => {
  // A poisoned email body is injected as DATA, never as the utterance — but defense in depth:
  // even if such text reached parseCommand, a non-user source must yield null.
  assert.equal(parseCommand('/compact', 'external'), null);
  assert.equal(parseCommand('/override', 'external'), null);
  assert.equal(parseCommand('context', 'schedule'), null);
  assert.equal(parseCommand('how much have I used', 'tool'), null);
});

test('non-string / empty payloads yield null', () => {
  assert.equal(parseCommand('', 'user'), null);
  assert.equal(parseCommand('   ', 'user'), null);
  assert.equal(parseCommand(42, 'user'), null);
  assert.equal(parseCommand(undefined, 'user'), null);
});
