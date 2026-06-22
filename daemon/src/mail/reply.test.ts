/**
 * reply.test.ts (MAIL-02/03/04/05) — the email reply composition flow (NO send).
 *
 * Proves:
 *   - few-shot: buildFewShot(recipient) uses the SHIPPED retrieveAndRerank and returns 2-3 of the
 *     most-similar past emails when the corpus has >=3 candidates with recipient overlap (MAIL-02).
 *   - stakes routing: a casual intent routes to the 7B 'helper'; a high-stakes intent
 *     (new client / money / contract / sensitive, or an explicit stakes flag) routes to 'cloud'
 *     (asserts WHICH brain seam compose invoked) (MAIL-03).
 *   - preview: compose returns a preview payload { to, subject, body, signature, toProvenance }
 *     and performs NO send (MAIL-04).
 *   - never auto-send: compose has no send side effect; an external-sourced To
 *     (toProvenance:'external') is flagged so the UI shows it before Send (MAIL-05).
 *
 * No network: the 7B helper is exercised with Ollama absent (neutral); the cloud seam is a
 * test double so no live ANTHROPIC_API_KEY is hit. The corpus is treated as source:external DATA.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildFewShot, routeStakes, compose, type ComposeDeps } from './reply.js';

/** Seed a temp memory dir with a sent-mail corpus under knowledge/ (retrieveAndRerank candidate dir). */
function tmpMemoryWithCorpus(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-test-'));
  const knowledge = path.join(dir, 'knowledge', 'sent-mail');
  fs.mkdirSync(knowledge, { recursive: true });
  // The voice profile (always-injected).
  fs.mkdirSync(path.join(dir, 'knowledge'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'knowledge', 'voice-profile.md'),
    `---\nsource: self\nkind: voice-profile\n---\n\nGreeting: Hi {name}. Sign-off: Thanks, Pravin. Short, direct sentences.\n`,
    'utf8',
  );
  // A sent-mail corpus — each note names the recipient (ana / acme.com) so keyword overlap is
  // non-zero against a recipient query (the 04-RESEARCH design assumption).
  const corpus: Record<string, string> = {
    'to-ana-1.md': 'Email to Ana at acme.com. Hi Ana, Friday works for me. Thanks, Pravin',
    'to-ana-2.md': 'Email to Ana at acme.com. Hi Ana, sounds good — see you then. Thanks, Pravin',
    'to-ana-3.md': 'Email to Ana at acme.com. Hi Ana, sharing the deck now. Best, Pravin',
    'to-ben-1.md': 'Email to Ben at other.org. Hi Ben, here is the update. Thanks, Pravin',
  };
  for (const [name, body] of Object.entries(corpus)) {
    fs.writeFileSync(
      path.join(knowledge, name),
      `---\nsource: external\nkind: sent-mail\n---\n\n${body}\n`,
      'utf8',
    );
  }
  return dir;
}

/** A compose deps double that records which brain seam fired and returns a canned rewrite. */
function recordingDeps(memoryDir: string): ComposeDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    memoryDir,
    calls,
    async helperRewrite(prompt: string): Promise<string> {
      calls.push('helper');
      return 'Hi Ana,\n\nFriday works.\n\nThanks,\nPravin';
    },
    async cloudRewrite(prompt: string): Promise<string> {
      calls.push('cloud');
      return 'Hi Ana,\n\nFriday works for me — happy to firm up the contract terms then.\n\nThanks,\nPravin';
    },
  };
}

test('buildFewShot: selects 2-3 examples via the shipped retrieveAndRerank (MAIL-02)', async () => {
  const dir = tmpMemoryWithCorpus();
  const fewShot = await buildFewShot('ana acme.com', dir);
  assert.ok(fewShot.length >= 2 && fewShot.length <= 3, `expected 2-3 examples, got ${fewShot.length}`);
  // The most-similar examples are the Ana ones (recipient-overlap ranks them highest).
  assert.ok(fewShot.every((ex) => /ana/i.test(ex)), 'few-shot is ranked toward the recipient');
});

test('buildFewShot: ranks recipient-similar emails above unrelated ones (MAIL-02)', async () => {
  const dir = tmpMemoryWithCorpus();
  const fewShot = await buildFewShot('ana acme.com', dir);
  // The Ben/other.org email is the least similar and should be dropped from a 2-3 slice.
  assert.ok(!fewShot.some((ex) => /ben/i.test(ex)), 'the unrelated recipient is not selected');
});

test('routeStakes: casual intent → helper; high-stakes intent → cloud (MAIL-03)', () => {
  assert.equal(routeStakes('thanks, see you friday'), 'helper');
  assert.equal(routeStakes('quick reply to confirm lunch'), 'helper');
  // High-stakes keywords.
  assert.equal(routeStakes('reply to the new client about the contract'), 'cloud');
  assert.equal(routeStakes('about the money we owe'), 'cloud');
  assert.equal(routeStakes('this is a sensitive matter'), 'cloud');
});

test('routeStakes: an explicit stakes flag forces the cloud route (MAIL-03)', () => {
  assert.equal(routeStakes('casual note', { highStakes: true }), 'cloud');
  assert.equal(routeStakes('casual note', { highStakes: false }), 'helper');
});

test('compose: a casual intent invokes the 7B helper seam and returns a preview (MAIL-03/04)', async () => {
  const dir = tmpMemoryWithCorpus();
  const deps = recordingDeps(dir);
  const preview = await compose('thank Ana and confirm Friday', { address: 'ana@acme.com' }, deps);
  assert.deepEqual(deps.calls, ['helper'], 'casual → the 7B helper rewrites');
  assert.equal(preview.to, 'ana@acme.com');
  assert.ok(preview.body.length > 0, 'a body was produced');
  assert.ok('subject' in preview && 'signature' in preview, 'preview has subject + signature');
});

test('compose: a high-stakes intent invokes the cloud ClaudeBrain seam (MAIL-03)', async () => {
  const dir = tmpMemoryWithCorpus();
  const deps = recordingDeps(dir);
  await compose('reply to the new client about the contract and money', { address: 'ana@acme.com' }, deps);
  assert.deepEqual(deps.calls, ['cloud'], 'high-stakes → the cloud brain rewrites');
});

test('compose: returns a preview payload and performs NO send (MAIL-04)', async () => {
  const dir = tmpMemoryWithCorpus();
  const deps = recordingDeps(dir);
  let sendCount = 0;
  // A spy send seam: compose MUST NOT call it (sending is the gated tool's job, never compose).
  (deps as ComposeDeps & { send?: () => void }).send = () => { sendCount += 1; };
  const preview = await compose('confirm Friday', { address: 'ana@acme.com' }, deps);
  assert.equal(sendCount, 0, 'compose performs NO send');
  assert.ok(Object.prototype.hasOwnProperty.call(preview, 'toProvenance'), 'preview carries toProvenance');
});

test('compose: an external-sourced To is flagged toProvenance:external so the UI shows it (MAIL-05)', async () => {
  const dir = tmpMemoryWithCorpus();
  const deps = recordingDeps(dir);
  const ext = await compose('reply', { address: 'stranger@unknown.io', provenance: 'external' }, deps);
  assert.equal(ext.toProvenance, 'external', 'an externally-sourced To is flagged external');

  const known = await compose('reply', { address: 'ana@acme.com', provenance: 'user' }, deps);
  assert.equal(known.toProvenance, 'user', 'a user-supplied To is not flagged external');
});

test('compose: always injects the voice profile + few-shot into the rewrite prompt (MAIL-01/02)', async () => {
  const dir = tmpMemoryWithCorpus();
  const calls: string[] = [];
  let seenPrompt = '';
  const deps: ComposeDeps = {
    memoryDir: dir,
    async helperRewrite(prompt: string): Promise<string> {
      calls.push('helper');
      seenPrompt = prompt;
      return 'Hi Ana,\n\nOk.\n\nThanks,\nPravin';
    },
    async cloudRewrite(): Promise<string> {
      calls.push('cloud');
      return '';
    },
  };
  await compose('confirm Friday with Ana', { address: 'ana@acme.com' }, deps);
  assert.match(seenPrompt, /Sign-off: Thanks, Pravin/, 'the voice profile is injected into the prompt');
  assert.match(seenPrompt, /ana/i, 'a recipient-similar few-shot example is injected');
});
