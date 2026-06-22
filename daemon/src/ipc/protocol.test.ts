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

// --- P3 ADDITIVE arms (CLOUD-01 / CLOUD-05) — settings + ui.state round-trip ---

test('protocol: a settings frame (brain toggle) round-trips through FrameSchema', () => {
  assert.equal(FrameSchema.safeParse({ type: 'settings', brain: 'cloud' }).success, true);
  assert.equal(FrameSchema.safeParse({ type: 'settings', brain: 'local' }).success, true);
  // an out-of-enum brain is rejected
  assert.equal(FrameSchema.safeParse({ type: 'settings', brain: 'martian' }).success, false);
  // missing brain is rejected
  assert.equal(FrameSchema.safeParse({ type: 'settings' }).success, false);
});

test('protocol: a ui.state frame (cloud scene state) round-trips through FrameSchema', () => {
  for (const state of ['fullscreen', 'cornerPill', 'idle']) {
    assert.equal(FrameSchema.safeParse({ type: 'ui.state', state }).success, true, state);
  }
  // an out-of-enum state is rejected
  assert.equal(FrameSchema.safeParse({ type: 'ui.state', state: 'maximized' }).success, false);
});

test('protocol: a speak frame carrying cues[] + onFinish round-trips (the frozen SpeakSchema)', () => {
  const r = FrameSchema.safeParse({
    type: 'speak',
    id: 's2',
    text: "You've got three events today, and your checking is at twelve hundred.",
    cues: [
      { atChar: 9, action: 'stage.present', widget: 'events', data: { count: 3 } },
      { atChar: 40, action: 'stage.dismiss', widget: 'events' },
      { atChar: 48, action: 'stage.present', widget: 'accounts', data: { balance: 1200 } },
    ],
    onFinish: [{ action: 'stage.dismiss', widget: 'accounts' }],
  });
  assert.equal(r.success, true, 'speak with cues[] + onFinish must round-trip');
});
