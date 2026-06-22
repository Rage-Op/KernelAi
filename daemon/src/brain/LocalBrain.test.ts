/**
 * LocalBrain.test.ts — RED until Task 2 creates LocalBrain.ts.
 *
 * Covers BRAIN-03: LocalBrain POSTs Ollama /api/chat (qwen2.5:7b-instruct-q4_K_M) and
 * parses `message.content` → Decision; it is ABSENT-TOLERANT — a rejected fetch
 * (ECONNREFUSED) and a non-ok "model not found" body each return a typed escalation
 * Decision, never throwing across the loop boundary.
 *
 * `fetch` is mocked by swapping `globalThis.fetch` (LocalBrain uses native fetch). No
 * live Ollama is needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LocalBrain, OLLAMA_MODEL } from './LocalBrain.js';

const realFetch = globalThis.fetch;
function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

test('LocalBrain: a JSON message.content maps to a Decision (model tag is qwen2.5:7b)', async () => {
  assert.equal(OLLAMA_MODEL, 'qwen2.5:7b-instruct-q4_K_M', 'the model tag is the pinned qwen2.5 7B');

  const seen: { body?: unknown } = {};
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    seen.body = init?.body ? JSON.parse(init.body) : undefined;
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          message: { role: 'assistant', content: JSON.stringify({ thought: 'considered', reply: 'Local says hi.' }) },
          done: true,
        };
      },
      async text() {
        return '';
      },
    };
  }) as unknown as typeof fetch;

  const decision = await new LocalBrain().reason('hello', 'ctx');
  assert.equal(decision.reply, 'Local says hi.', 'message.content JSON maps to Decision.reply');
  const body = seen.body as { model?: string };
  assert.equal(body.model, 'qwen2.5:7b-instruct-q4_K_M', 'POST body names the pinned model');

  restoreFetch();
});

test('LocalBrain: attaches usage (tokens + durations in ms) from Ollama counters', async () => {
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        model: 'qwen2.5:7b-instruct-q4_K_M',
        message: { role: 'assistant', content: JSON.stringify({ thought: 't', reply: 'hi' }) },
        done: true,
        prompt_eval_count: 120,
        eval_count: 40,
        eval_duration: 2_000_000_000, // 2s in ns → 40 tok / 2s = 20 tok/s downstream
        load_duration: 500_000_000, // 0.5s in ns
        total_duration: 2_600_000_000, // 2.6s in ns
      };
    },
    async text() {
      return '';
    },
  })) as unknown as typeof fetch;

  const decision = await new LocalBrain().reason('hello', 'ctx');
  assert.equal(decision.reply, 'hi');
  assert.ok(decision.usage, 'usage is attached');
  assert.equal(decision.usage!.promptTokens, 120);
  assert.equal(decision.usage!.outputTokens, 40);
  assert.equal(decision.usage!.evalMs, 2000, 'ns → ms');
  assert.equal(decision.usage!.loadMs, 500, 'ns → ms');
  assert.equal(decision.usage!.totalMs, 2600, 'ns → ms');
  assert.equal(decision.usage!.model, 'qwen2.5:7b-instruct-q4_K_M');
  assert.equal(decision.usage!.contextWindow, 8192, 'reports the num_ctx window');

  restoreFetch();
});

test('LocalBrain: a rejected fetch (ECONNREFUSED) returns a typed escalation, no throw', async () => {
  globalThis.fetch = (async () => {
    throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' });
  }) as unknown as typeof fetch;

  let decision;
  await assert.doesNotReject(async () => {
    decision = await new LocalBrain().reason('hello', 'ctx');
  }, 'an unreachable Ollama must NOT throw across the loop boundary');
  assert.ok(decision!.reply, 'an absent Ollama still yields a surfaceable reply');
  assert.match(decision!.reply!, /unavailable|not running|Ollama/i, 'reply names Ollama unavailability');

  restoreFetch();
});

test('LocalBrain: a non-ok body naming a missing model surfaces an "ollama pull" escalation', async () => {
  globalThis.fetch = (async () => {
    return {
      ok: false,
      status: 404,
      async json() {
        return { error: 'model "qwen2.5:7b-instruct-q4_K_M" not found, try pulling it first' };
      },
      async text() {
        return 'model "qwen2.5:7b-instruct-q4_K_M" not found, try pulling it first';
      },
    };
  }) as unknown as typeof fetch;

  const decision = await new LocalBrain().reason('hello', 'ctx');
  assert.match(
    decision.reply!,
    /ollama pull qwen2\.5:7b-instruct-q4_K_M/,
    'a missing model escalates with the exact pull command',
  );

  restoreFetch();
});
