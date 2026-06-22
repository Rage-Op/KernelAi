/**
 * protocol.test.ts — the frozen frame contract validates P1 frames and rejects junk.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FrameSchema } from './protocol.js';

test('protocol: valid Face→daemon frames parse', () => {
  assert.equal(FrameSchema.safeParse({ type: 'hello', client: 'face', version: '0.1.0' }).success, true);
  assert.equal(
    FrameSchema.safeParse({ type: 'utterance', id: 'a1', text: 'hi', final: true }).success,
    true,
  );
  assert.equal(FrameSchema.safeParse({ type: 'ping', id: 'p1' }).success, true);
});

test('protocol: valid daemon→Face frames parse', () => {
  assert.equal(
    FrameSchema.safeParse({ type: 'ready', daemon: 'kernel', version: '0.1.0' }).success,
    true,
  );
  assert.equal(FrameSchema.safeParse({ type: 'reply', id: 'a1', text: 'hello' }).success, true);
  assert.equal(FrameSchema.safeParse({ type: 'pong', id: 'p1' }).success, true);
  assert.equal(FrameSchema.safeParse({ type: 'error', message: 'boom' }).success, true);
});

test('protocol: an unknown type is rejected', () => {
  const r = FrameSchema.safeParse({ type: 'nope', id: 'x' });
  assert.equal(r.success, false);
});

test('protocol: a missing required field is rejected', () => {
  // utterance without `text`
  assert.equal(FrameSchema.safeParse({ type: 'utterance', id: 'a1', final: true }).success, false);
  // ping without `id`
  assert.equal(FrameSchema.safeParse({ type: 'ping' }).success, false);
  // reply with a non-string text
  assert.equal(FrameSchema.safeParse({ type: 'reply', id: 'a1', text: 42 }).success, false);
});

test('protocol: the designed-for P2/P3 shapes are part of the frozen contract', () => {
  assert.equal(
    FrameSchema.safeParse({
      type: 'speak',
      id: 's1',
      text: 'hello',
      cues: [{ atChar: 0, action: 'bloom', widget: 'cloud' }],
    }).success,
    true,
  );
  assert.equal(
    FrameSchema.safeParse({ type: 'widget.data', widget: 'cloud', data: { x: 1 } }).success,
    true,
  );
  assert.equal(
    FrameSchema.safeParse({ type: 'ui.intent', id: 'u1', intent: 'open' }).success,
    true,
  );
});
