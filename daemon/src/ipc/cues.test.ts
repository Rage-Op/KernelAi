/**
 * cues.test.ts — RED until Task 3 creates cues.ts.
 *
 * Covers CLOUD-04: the daemon-side cue assembler turns a reply + planned widget sequence
 * into a single SpeakSchema-valid `speak` frame keyed to CHARACTER OFFSETS in the reply.
 * Cues are sorted ascending by atChar; each atChar lies within [0, reply.length]; onFinish
 * dissolves the last presented widget. The daemon ships all cues up front and NEVER emits
 * timing (the Face's TTS clock is the metronome).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assembleSpeak, type WidgetPlanItem } from './cues.js';
import { SpeakSchema } from './protocol.js';

const REPLY =
  "You've got three events today, and your checking is at twelve hundred.";

const PLAN: WidgetPlanItem[] = [
  // Present accounts FIRST in the plan but at a LATER offset — proves the assembler sorts.
  { widget: 'accounts', phrase: 'checking', data: { balance: 1200 } },
  { widget: 'events', phrase: 'events', data: { count: 3 } },
];

test('assembleSpeak produces a SpeakSchema-valid speak frame', () => {
  const frame = assembleSpeak('s1', REPLY, PLAN);
  const parsed = SpeakSchema.safeParse(frame);
  assert.equal(parsed.success, true, 'frame must validate against the frozen SpeakSchema');
  assert.equal(frame.type, 'speak');
  assert.equal(frame.id, 's1');
  assert.equal(frame.text, REPLY);
});

test('assembleSpeak: cues are sorted ascending by atChar and within [0, reply.length]', () => {
  const frame = assembleSpeak('s1', REPLY, PLAN);
  assert.ok(frame.cues.length >= PLAN.length, 'at least one present cue per planned widget');

  let prev = -1;
  for (const cue of frame.cues) {
    assert.ok(cue.atChar >= 0, `atChar ${cue.atChar} >= 0`);
    assert.ok(cue.atChar <= REPLY.length, `atChar ${cue.atChar} <= reply length ${REPLY.length}`);
    assert.ok(cue.atChar >= prev, `cues sorted ascending (saw ${cue.atChar} after ${prev})`);
    prev = cue.atChar;
  }
});

test('assembleSpeak: a present cue lands at the offset where its phrase begins', () => {
  const frame = assembleSpeak('s1', REPLY, PLAN);
  const eventsCue = frame.cues.find((c) => c.widget === 'events' && c.action.includes('present'));
  assert.ok(eventsCue, 'an events present cue exists');
  assert.equal(eventsCue!.atChar, REPLY.indexOf('events'), 'events present cue lands at the phrase offset');
});

test('assembleSpeak: onFinish dissolves the LAST presented widget', () => {
  const frame = assembleSpeak('s1', REPLY, PLAN);
  assert.ok(frame.onFinish && frame.onFinish.length >= 1, 'onFinish dissolves the trailing widget');
  // The last presented widget (by offset) is "accounts" (phrase "checking" comes after "events").
  const last = frame.onFinish![frame.onFinish!.length - 1];
  assert.equal(last.widget, 'accounts', 'onFinish dissolves the last-presented widget');
});

test('assembleSpeak: a reply with no widget plan still produces a valid speak frame (no cues)', () => {
  const frame = assembleSpeak('s2', 'Just a plain reply.', []);
  assert.equal(SpeakSchema.safeParse(frame).success, true);
  assert.deepEqual(frame.cues, [], 'no plan → no cues');
});
