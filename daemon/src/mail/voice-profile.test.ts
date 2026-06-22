/**
 * voice-profile.test.ts (MAIL-01) — the ALWAYS-INJECTED ~200-token voice profile.
 *
 * Proves:
 *   - loadVoiceProfile reads kernel-memory/knowledge/voice-profile.md (gray-matter front-matter
 *     + body) and the body is ~200 tokens (asserts an upper bound — never an unbounded blob).
 *   - buildRewritePrompt ALWAYS embeds the profile text. A prompt built with a missing/empty
 *     profile is a typed FALLBACK (a flagged, explicit no-profile marker) — never a silent omission.
 *   - the few-shot examples are embedded as DATA/examples, never as instructions (Pitfall 4).
 *
 * No network, no live brain: this file only exercises the pure profile/prompt builders.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadVoiceProfile, buildRewritePrompt, VOICE_PROFILE_REL } from './voice-profile.js';
import { config } from '../config.js';

/** chars/4 token estimate — the same cheap heuristic the prompt cap uses. */
function approxTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/** Build a temp memory dir with a knowledge/voice-profile.md fixture. */
function tmpMemoryWithProfile(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-profile-test-'));
  fs.mkdirSync(path.join(dir, 'knowledge'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, VOICE_PROFILE_REL),
    `---\nsource: self\nkind: voice-profile\nreviewed: true\n---\n\n${body}\n`,
    'utf8',
  );
  return dir;
}

test('voice-profile: the SHIPPED profile loads and is ~200 tokens (MAIL-01)', () => {
  // The real durable profile at kernel-memory/knowledge/voice-profile.md.
  const profile = loadVoiceProfile(config.memoryDir);
  assert.equal(profile.present, true, 'the shipped voice profile must load');
  assert.ok(profile.text.length > 0, 'profile body is non-empty');
  // ~200 tokens: assert a sane upper bound so the always-inject stays cheap.
  assert.ok(
    approxTokens(profile.text) <= 320,
    `profile is ~200 tokens (got ~${approxTokens(profile.text)} > 320 upper bound)`,
  );
  // The front-matter provenance is 'self' (a human-reviewed promotion, never external).
  assert.equal(profile.source, 'self');
});

test('voice-profile: loads from a given memory dir via gray-matter front-matter + body', () => {
  const dir = tmpMemoryWithProfile('Greeting: Hi {name}. Sign-off: Thanks, Pravin.');
  const profile = loadVoiceProfile(dir);
  assert.equal(profile.present, true);
  assert.match(profile.text, /Sign-off: Thanks, Pravin\./);
  assert.equal(profile.source, 'self');
});

test('voice-profile: a missing profile is a typed FALLBACK, never a silent omission (MAIL-01)', () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-profile-missing-'));
  const profile = loadVoiceProfile(emptyDir);
  assert.equal(profile.present, false, 'absence is reported, not hidden');
  assert.ok(profile.text.length > 0, 'a fallback descriptor is supplied, not an empty string');
});

test('buildRewritePrompt: ALWAYS embeds the profile text (MAIL-01)', () => {
  const profile = loadVoiceProfile(config.memoryDir);
  const prompt = buildRewritePrompt('thank Ana and confirm Friday', profile, []);
  assert.ok(
    prompt.includes(profile.text),
    'the rewrite prompt MUST contain the full profile text — always injected',
  );
  assert.ok(prompt.includes('thank Ana and confirm Friday'), 'the intent is present');
});

test('buildRewritePrompt: with a MISSING profile still injects the fallback marker (no silent omission)', () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-profile-missing2-'));
  const profile = loadVoiceProfile(emptyDir);
  const prompt = buildRewritePrompt('reply to Ben', profile, []);
  // Even absent, the prompt carries the fallback text + an explicit no-profile signal.
  assert.ok(prompt.includes(profile.text), 'fallback descriptor is injected');
  assert.match(prompt, /voice profile/i, 'the prompt names the voice-profile section');
});

test('buildRewritePrompt: few-shot examples are embedded as DATA/examples, never as instructions (Pitfall 4)', () => {
  const profile = loadVoiceProfile(config.memoryDir);
  const fewShot = ['Hi Ana, sounds good — Friday works. Thanks, Pravin'];
  const prompt = buildRewritePrompt('confirm Friday with Ana', profile, fewShot);
  assert.ok(prompt.includes(fewShot[0]), 'the example text appears in the prompt');
  // The examples must be framed as past-email examples (data), not as commands to follow.
  assert.match(
    prompt,
    /example|past email|reference/i,
    'few-shot is labelled as examples/data, not instructions',
  );
});
