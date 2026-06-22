/**
 * helper.test.ts — RED until Task 2 creates helper.ts.
 *
 * Covers BRAIN-05: the always-on local-7B helper (triage/classify/narrate) ALWAYS hits
 * Ollama and returns a NEUTRAL DEFAULT when the Ollama call rejects — it never throws and
 * never blocks the loop. The helper is NOT a BrainProvider and is NOT swapped by Settings.
 *
 * `fetch` is mocked by swapping `globalThis.fetch`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { triage, classify, narrate } from './helper.js';

const realFetch = globalThis.fetch;
function refuseFetch(): void {
  globalThis.fetch = (async () => {
    throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' });
  }) as unknown as typeof fetch;
}
function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

test('helper.triage returns a neutral default when Ollama is absent, never throws', async () => {
  refuseFetch();
  let out;
  await assert.doesNotReject(async () => {
    out = await triage('some message');
  }, 'triage must not throw when Ollama is unreachable');
  assert.ok(out !== undefined && out !== null, 'triage returns a usable neutral default');
  restoreFetch();
});

test('helper.classify returns a neutral default when Ollama is absent, never throws', async () => {
  refuseFetch();
  let out;
  await assert.doesNotReject(async () => {
    out = await classify('classify this', ['a', 'b']);
  }, 'classify must not throw when Ollama is unreachable');
  assert.ok(out !== undefined && out !== null, 'classify returns a usable neutral default');
  restoreFetch();
});

test('helper.narrate returns a neutral default when Ollama is absent, never throws', async () => {
  refuseFetch();
  let out;
  await assert.doesNotReject(async () => {
    out = await narrate('narrate this');
  }, 'narrate must not throw when Ollama is unreachable');
  assert.equal(typeof out, 'string', 'narrate returns a string default even when absent');
  restoreFetch();
});
