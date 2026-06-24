/**
 * LocalBrain.test.ts — BRAIN-03.
 *
 * LocalBrain POSTs Ollama /api/chat (qwen3.5:9b) and surfaces the model's plain
 * prose as Decision.reply (NO json-coercion — that made it announce-then-stop). It streams when an
 * `onToken` callback is passed, and is ABSENT-TOLERANT: a rejected fetch (ECONNREFUSED) and a
 * non-ok "model not found" body each return a typed escalation Decision, never throwing.
 *
 * `fetch` is mocked by swapping `globalThis.fetch`. No live Ollama is needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LocalBrain,
  OLLAMA_MODEL,
  OLLAMA_NUM_CTX,
  OLLAMA_NUM_PREDICT,
  OLLAMA_NUM_PREDICT_DELIBERATE,
  assessDepth,
  __setToolDispatcherForTest,
} from './LocalBrain.js';
import type { ToolCall } from './BrainProvider.js';

/** A non-streamed Ollama /api/chat mock response carrying `obj` as the JSON body. */
function mockChatResponse(obj: unknown) {
  return {
    ok: true,
    status: 200,
    async json() {
      return obj;
    },
    async text() {
      return '';
    },
  };
}

const realFetch = globalThis.fetch;
function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

/** A web ReadableStream that emits each NDJSON line (newline-terminated) — mimics Ollama streaming. */
function ndjsonStream(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < lines.length) {
        controller.enqueue(enc.encode(lines[i] + '\n'));
        i += 1;
      } else {
        controller.close();
      }
    },
  });
}

test('LocalBrain: plain prose content becomes Decision.reply (no JSON coercion)', async () => {
  assert.equal(OLLAMA_MODEL, 'qwen3.5:9b', 'the model tag is the pinned qwen3.5 9B');

  const seen: { body?: { model?: string; stream?: boolean; format?: unknown } } = {};
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    seen.body = init?.body ? JSON.parse(init.body) : undefined;
    return {
      ok: true,
      status: 200,
      async json() {
        return { message: { role: 'assistant', content: 'Local says hi.' }, done: true };
      },
      async text() {
        return '';
      },
    };
  }) as unknown as typeof fetch;

  const decision = await new LocalBrain().reason('hello', 'ctx');
  assert.equal(decision.reply, 'Local says hi.', 'plain content maps straight to reply');
  assert.equal(seen.body?.model, OLLAMA_MODEL, 'POST body names the pinned model');
  assert.equal(seen.body?.stream, false, 'no onToken → non-streamed request');
  assert.equal(seen.body?.format, undefined, 'format:json is NOT forced anymore');

  restoreFetch();
});

test('LocalBrain: replays conversation history between the system message and the current prompt', async () => {
  const seen: { body?: { messages?: Array<{ role: string; content: string }> } } = {};
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    seen.body = init?.body ? JSON.parse(init.body) : undefined;
    return {
      ok: true,
      status: 200,
      async json() {
        return { message: { role: 'assistant', content: 'ok' }, done: true };
      },
      async text() {
        return '';
      },
    };
  }) as unknown as typeof fetch;

  await new LocalBrain().reason('now make it about mountains', 'ctx', undefined, [
    { role: 'user', content: 'write a haiku about the sea' },
    { role: 'assistant', content: 'Salt wind on grey swells' },
  ]);

  const messages = seen.body?.messages ?? [];
  assert.equal(messages.length, 4, 'system + 2 history turns + current user');
  assert.equal(messages[0].role, 'system', 'system (memory+persona) stays element 0');
  assert.equal(messages[1].content, 'write a haiku about the sea', 'history user turn replayed');
  assert.equal(messages[2].role, 'assistant', 'history assistant turn replayed');
  assert.equal(messages[3].content, 'now make it about mountains', 'current utterance is LAST');

  restoreFetch();
});

test('LocalBrain: tool loop — model requests web, the gated dispatcher runs it, model answers from the observation', async () => {
  let call = 0;
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    call += 1;
    const body = init?.body ? (JSON.parse(init.body) as { tools?: unknown; messages?: Array<{ role: string }> }) : {};
    if (call === 1) {
      assert.ok(Array.isArray(body.tools) && body.tools.length > 0, 'tools advertised to the model');
      // first hop: the model asks for a web search (no content yet)
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'web', arguments: { op: 'search', query: 'latest mac mini price' } } }] },
            done: true,
          };
        },
        async text() {
          return '';
        },
      };
    }
    // second hop: a role:'tool' observation must precede the answer hop
    assert.ok((body.messages ?? []).some((m) => m.role === 'tool'), 'observation appended before the answer hop');
    return {
      ok: true,
      status: 200,
      async json() {
        return { message: { role: 'assistant', content: 'The latest Mac mini starts at $599.' }, done: true };
      },
      async text() {
        return '';
      },
    };
  }) as unknown as typeof fetch;

  const dispatched: ToolCall[] = [];
  __setToolDispatcherForTest(async (c: ToolCall) => {
    dispatched.push(c);
    return { ok: true, data: { results: [{ title: 'Mac mini', url: 'https://apple.com', snippet: '$599' }] } };
  });

  const activity: Array<{ tool: string; status: string }> = [];
  const decision = await new LocalBrain().reason(
    'what is the latest mac mini price?',
    'ctx',
    undefined,
    undefined,
    (e) => activity.push({ tool: e.tool, status: e.status }),
  );

  assert.equal(dispatched.length, 1, 'the web tool was dispatched exactly once');
  assert.equal(dispatched[0].tool, 'web', 'dispatched the web tool');
  assert.equal((dispatched[0].args as { op?: string }).op, 'search', 'with op=search');
  assert.match(decision.reply!, /599/, 'final answer uses the tool observation');
  assert.equal(call, 2, 'one tool hop + one answer hop');
  // background tool-use events reported start→ok for the Face's live indicator
  assert.deepEqual(activity, [
    { tool: 'web', status: 'start' },
    { tool: 'web', status: 'ok' },
  ]);

  __setToolDispatcherForTest(null);
  restoreFetch();
});

test('LocalBrain: attaches usage (tokens + durations in ms) from Ollama counters', async () => {
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        model: 'qwen2.5:7b-instruct-q4_K_M',
        message: { role: 'assistant', content: 'hi' },
        done: true,
        prompt_eval_count: 120,
        eval_count: 40,
        eval_duration: 2_000_000_000, // 2s in ns → 20 tok/s downstream
        load_duration: 500_000_000,
        total_duration: 2_600_000_000,
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
  assert.equal(decision.usage!.contextWindow, OLLAMA_NUM_CTX, 'reports the num_ctx window');

  restoreFetch();
});

test('LocalBrain: streams content deltas through onToken and concatenates the reply', async () => {
  const seen: { body?: { stream?: boolean } } = {};
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    seen.body = init?.body ? JSON.parse(init.body) : undefined;
    return {
      ok: true,
      status: 200,
      body: ndjsonStream([
        JSON.stringify({ message: { role: 'assistant', content: 'Hello' }, done: false }),
        JSON.stringify({ message: { role: 'assistant', content: ', world' }, done: false }),
        JSON.stringify({
          message: { role: 'assistant', content: '' },
          done: true,
          model: OLLAMA_MODEL,
          prompt_eval_count: 10,
          eval_count: 3,
          eval_duration: 1_000_000_000,
        }),
      ]),
      async text() {
        return '';
      },
    };
  }) as unknown as typeof fetch;

  const chunks: string[] = [];
  const decision = await new LocalBrain().reason('hi', 'ctx', (c) => chunks.push(c));
  assert.equal(seen.body?.stream, true, 'onToken → streamed request');
  assert.deepEqual(chunks, ['Hello', ', world'], 'each content delta is surfaced via onToken');
  assert.equal(decision.reply, 'Hello, world', 'the deltas concatenate into the full reply');
  assert.equal(decision.usage!.outputTokens, 3, 'usage comes from the final done line');

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

test('assessDepth: trivial turns are quick; multi-step / complex turns are deliberate', () => {
  // quick: short, single-shot, factual, conversational
  assert.equal(assessDepth('hi'), 'quick');
  assert.equal(assessDepth('what is the capital of France?'), 'quick');
  assert.equal(assessDepth('what is the latest mac mini price?'), 'quick');
  assert.equal(assessDepth('now make it about mountains'), 'quick');
  // deliberate: explicit planning / multi-step / complex signals
  assert.equal(assessDepth('plan a 3-day trip to Kyoto'), 'deliberate');
  assert.equal(assessDepth('compare Postgres and MySQL and recommend one'), 'deliberate');
  assert.equal(assessDepth('research the best local LLM for a 16GB Mac'), 'deliberate');
  assert.equal(assessDepth('how do I set up a launchd agent?'), 'deliberate');
  assert.equal(assessDepth('a'.repeat(300)), 'deliberate', 'a very long ask is treated as complex');
});

test('LocalBrain: a simple prompt stays on the QUICK gear (no thinking, snappy budget)', async () => {
  let body: { think?: boolean; options?: { num_predict?: number } } | undefined;
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    body = init?.body ? JSON.parse(init.body) : undefined;
    return mockChatResponse({ message: { role: 'assistant', content: 'hi' }, done: true });
  }) as unknown as typeof fetch;

  await new LocalBrain().reason('hi', 'ctx');
  assert.equal(body?.think, false, 'quick path keeps thinking OFF (snappy, no rumination)');
  assert.equal(body?.options?.num_predict, OLLAMA_NUM_PREDICT, 'quick path uses the snappy output budget');

  restoreFetch();
});

test('LocalBrain: a multi-step prompt takes the DELIBERATE gear (thinking ON, doubled budget)', async () => {
  let body: { think?: boolean; options?: { num_predict?: number } } | undefined;
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    body = init?.body ? JSON.parse(init.body) : undefined;
    return mockChatResponse({ message: { role: 'assistant', content: '1. plan\n2. result' }, done: true });
  }) as unknown as typeof fetch;

  await new LocalBrain().reason('research and compare three options step by step', 'ctx');
  assert.equal(body?.think, true, 'deliberate path turns thinking ON');
  assert.equal(
    body?.options?.num_predict,
    OLLAMA_NUM_PREDICT_DELIBERATE,
    'deliberate path doubles the budget so reasoning + a full answer both fit',
  );

  restoreFetch();
});

test('LocalBrain: exhausting tool hops drops the tools and nudges a final answer (no stall)', async () => {
  let calls = 0;
  let lastBody: { tools?: unknown[]; messages?: Array<{ role: string; content: string }> } | undefined;
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    calls += 1;
    lastBody = init?.body ? JSON.parse(init.body) : undefined;
    const hasTools = Array.isArray(lastBody?.tools) && lastBody!.tools!.length > 0;
    // While tools are advertised the model keeps asking for one; once they're dropped it must answer.
    return hasTools
      ? mockChatResponse({
          message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'web', arguments: { op: 'search', query: 'x' } } }] },
          done: true,
        })
      : mockChatResponse({ message: { role: 'assistant', content: 'Final answer from observations.' }, done: true });
  }) as unknown as typeof fetch;

  __setToolDispatcherForTest(async () => ({ ok: true, data: { hit: 1 } }));

  // 'hello' → quick gear (MAX_TOOL_HOPS=4): hops 0..3 each call a tool, hop 4 is forced tool-less.
  const decision = await new LocalBrain().reason('hello', 'ctx');
  assert.equal(calls, 5, 'four tool hops then one forced, tool-less answer hop');
  assert.equal(
    Array.isArray(lastBody?.tools) && lastBody!.tools!.length > 0,
    false,
    'the final hop advertises NO tools so the model cannot keep looping',
  );
  assert.ok(
    (lastBody?.messages ?? []).some((m) => m.role === 'user' && /more tools/i.test(m.content)),
    'the final hop carries the "answer now" nudge',
  );
  assert.match(decision.reply!, /Final answer/, 'the loop terminates with a real answer, not the empty fallback');

  __setToolDispatcherForTest(null);
  restoreFetch();
});

test('LocalBrain: a tool run that yields no prose triggers a forced summary (never ends empty)', async () => {
  let calls = 0;
  let lastBody: { tools?: unknown[] } | undefined;
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    calls += 1;
    lastBody = init?.body ? JSON.parse(init.body) : undefined;
    if (calls === 1) {
      // hop 0: the model asks for a tool, no prose yet.
      return mockChatResponse({
        message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'fs', arguments: { op: 'write', path: 'a.txt', content: 'x' } } }] },
        done: true,
      });
    }
    if (calls === 2) {
      // hop 1 (after the observation): the model returns EMPTY content and no tool call.
      return mockChatResponse({ message: { role: 'assistant', content: '' }, done: true });
    }
    // forced summary hop: tools dropped → the model finally narrates the result.
    return mockChatResponse({ message: { role: 'assistant', content: 'Wrote a.txt successfully.' }, done: true });
  }) as unknown as typeof fetch;

  __setToolDispatcherForTest(async () => ({ ok: true, data: { written: true } }));
  const decision = await new LocalBrain().reason('hello', 'ctx'); // quick gear, no deliberate signal
  assert.equal(calls, 3, 'tool hop + empty-prose hop + a forced, tool-less summary hop');
  assert.equal(
    Array.isArray(lastBody?.tools) && lastBody!.tools!.length > 0,
    false,
    'the forced summary hop advertises NO tools',
  );
  assert.match(decision.reply!, /Wrote a\.txt/, 'a tool run never ends in an empty reply');
  __setToolDispatcherForTest(null);
  restoreFetch();
});

test('LocalBrain: a non-ok body naming a missing model surfaces an "ollama pull" escalation', async () => {
  globalThis.fetch = (async () => {
    return {
      ok: false,
      status: 404,
      async json() {
        return { error: 'model not found, try pulling it first' };
      },
      async text() {
        return 'model "qwen3.5:9b" not found, try pulling it first';
      },
    };
  }) as unknown as typeof fetch;

  const decision = await new LocalBrain().reason('hello', 'ctx');
  assert.ok(
    decision.reply!.includes(`ollama pull ${OLLAMA_MODEL}`),
    'a missing model escalates with the exact pull command',
  );

  restoreFetch();
});
