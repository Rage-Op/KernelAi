/**
 * whisper.test.ts — the daemon-side STT wrapper unit lane (VOICE-01), spawn MOCKED.
 *
 * NO real whisper-cli, NO mic (whisper.cpp is ABSENT on this machine — RESEARCH.md Pitfall 5,
 * Environment Availability). This lane proves the wrapper/parser is fully exercisable with the
 * binary mocked; live mic→transcript is a documented MANUAL owner check (build the Core ML/ANE
 * whisper.cpp, speak, confirm a transcript reaches the loop), NOT run here.
 *
 * Covered behaviors:
 *   (a) parseTranscript(fixture): the whisper-cli stdout fixture (timestamped segments, includes a
 *       number — the known-flaky case) parses to a single clean transcript string (timestamps
 *       stripped, segments joined, whitespace normalized);
 *   (b) ABSENT (T-03-06): a spawn that fails with code 'ENOENT' returns a TYPED ESCALATION
 *       ({ ok:false, escalation:{ reason: /whisper.cpp not found/ } }) and does NOT throw;
 *   (c) SUCCESS: a clean whisper stdout returns { ok:true, transcript } whose text matches the
 *       parsed fixture.
 *
 * The spawn dependency is injected via `__setSpawnForTest` (mirrors the peekaboo
 * `__setClientForTest` / ClaudeCodeBrain `__setRunnerForTest` discipline) so nothing real spawns.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  transcribe,
  parseTranscript,
  __setSpawnForTest,
  type WhisperResult,
  type WhisperRun,
} from '../voice/whisper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** The whisper-cli stdout fixture lives under daemon/test/fixtures/ (src/voice → ../../test/...). */
const FIXTURE_PATH = path.resolve(__dirname, '..', '..', 'test', 'fixtures', 'whisper-stdout.txt');
const FIXTURE = readFileSync(FIXTURE_PATH, 'utf8');

afterEach(() => {
  __setSpawnForTest(null);
});

test('whisper.parseTranscript: strips timestamps, joins segments, normalizes whitespace (incl. a number)', () => {
  const out = parseTranscript(FIXTURE);

  // No whisper-cli timestamp scaffolding survives.
  assert.doesNotMatch(out, /-->/, 'segment timestamp arrows are stripped');
  assert.doesNotMatch(out, /\[\d\d:\d\d/, 'bracketed timestamp markers are stripped');
  // Segments are joined into one clean line with single-spaced whitespace.
  assert.doesNotMatch(out, /\n/, 'segments are joined into a single line');
  assert.doesNotMatch(out, /\s{2,}/, 'internal whitespace is normalized to single spaces');
  assert.equal(out, out.trim(), 'no leading/trailing whitespace');
  // The known-flaky number-bearing content survives the parse verbatim.
  assert.match(out, /call the bank/, 'segment content is preserved');
  assert.match(out, /4 PM/, 'a number-bearing segment survives the parse (known-flaky case)');
  assert.match(out, /250 dollars/, 'the second number-bearing segment survives');
  assert.match(out, /open Mail and start a reply/, 'the final segment is included');
});

test('whisper.transcribe: binary ABSENT (spawn ENOENT) → typed escalation, never throws (T-03-06)', async () => {
  // Mock the spawn to reject as a missing binary would: ENOENT, exit code 127, no stdout.
  __setSpawnForTest(async (): Promise<WhisperRun> => ({
    code: 127,
    stdout: '',
    stderr: "spawn whisper-cli ENOENT",
    error: Object.assign(new Error('spawn whisper-cli ENOENT'), { code: 'ENOENT' }),
  }));

  let result: WhisperResult;
  await assert.doesNotReject(async () => {
    result = await transcribe({ wavPath: '/tmp/utterance.wav' });
  }, 'a missing binary must NOT throw across the loop boundary');

  // @ts-expect-error result is assigned inside doesNotReject above
  assert.equal(result.ok, false, 'absence degrades to ok:false');
  // @ts-expect-error narrowed by the assertion above
  assert.match(result.escalation.reason, /whisper\.cpp not found/i, 'typed escalation names the missing binary');
});

test('whisper.transcribe: clean whisper stdout → { ok:true, transcript } matching the parsed fixture', async () => {
  __setSpawnForTest(async (): Promise<WhisperRun> => ({
    code: 0,
    stdout: FIXTURE,
    stderr: '',
  }));

  const result = await transcribe({ wavPath: '/tmp/utterance.wav' });

  assert.equal(result.ok, true, 'a clean run succeeds');
  if (result.ok) {
    assert.equal(result.transcript, parseTranscript(FIXTURE), 'transcript is the parsed stdout (loop turns it into an utterance)');
    assert.match(result.transcript, /call the bank/, 'the transcript carries the spoken content');
  }
});
