/**
 * LMStudioBrain.test.ts — the LM Studio (OpenAI-compatible) local brain.
 *
 * Mirrors LocalBrain.test.ts but for OpenAI wire shapes: `/v1/chat/completions`, tool calls as a JSON
 * *string* in `function.arguments`, tool results replayed with `tool_call_id`, SSE streaming
 * (`data: {…}` … `data: [DONE]`) with incremental `tool_calls` fragments, and reasoning surfaced via
 * `delta.reasoning_content`. `fetch` and the model resolver are both stubbed — no live LM Studio.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LMStudioBrain,
  __setLmStudioToolDispatcherForTest,
  __setLmStudioModelResolverForTest,
} from './LMStudioBrain.js';
import type { ToolCall } from './BrainProvider.js';

const realFetch = globalThis.fetch;
function restore(): void {
  globalThis.fetch = realFetch;
  __setLmStudioToolDispatcherForTest(null);
  __setLmStudioModelResolverForTest(null);
}

/** Pin a model so chat tests never probe a real LM Studio. */
function pinModel(id = 'mlx-community/test-model'): void {
  __setLmStudioModelResolverForTest(async () => id);
}

/** A non-streamed OpenAI chat response carrying `obj`. */
function jsonResponse(obj: unknown) {
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

/** A web ReadableStream emitting OpenAI SSE: each chunk as `data: {…}\n\n`, then `data: [DONE]`. */
function sseStream(chunks: unknown[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const frames = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`);
  frames.push('data: [DONE]\n\n');
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < frames.length) {
        controller.enqueue(enc.encode(frames[i]));
        i += 1;
      } else {
        controller.close();
      }
    },
  });
}

test('LMStudioBrain: non-streamed content becomes Decision.reply; POSTs the resolved model + tools', async () => {
  pinModel('mlx-community/Qwen3-8B');
  const seen: { url?: string; body?: { model?: string; stream?: boolean; tools?: unknown[] } } = {};
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    seen.url = url;
    seen.body = init?.body ? JSON.parse(init.body) : undefined;
    return jsonResponse({
      model: 'mlx-community/Qwen3-8B',
      choices: [{ message: { role: 'assistant', content: 'LM Studio says hi.' } }],
    });
  }) as unknown as typeof fetch;

  const decision = await new LMStudioBrain().reason('hello', 'ctx');
  assert.equal(decision.reply, 'LM Studio says hi.');
  assert.match(seen.url!, /\/v1\/chat\/completions$/, 'hits the OpenAI-compatible endpoint');
  assert.equal(seen.body?.model, 'mlx-community/Qwen3-8B', 'POSTs the resolved (loaded) model');
  assert.equal(seen.body?.stream, false, 'no onToken → non-streamed');
  assert.ok(Array.isArray(seen.body?.tools) && seen.body!.tools!.length > 0, 'advertises the tool catalog');

  restore();
});

test('LMStudioBrain: no model loaded → typed escalation, no fetch', async () => {
  __setLmStudioModelResolverForTest(async () => null);
  let fetched = false;
  globalThis.fetch = (async () => {
    fetched = true;
    return jsonResponse({});
  }) as unknown as typeof fetch;

  const decision = await new LMStudioBrain().reason('hello', 'ctx');
  assert.equal(fetched, false, 'never calls the chat endpoint when no model is loaded');
  assert.match(decision.reply!, /no model is loaded/i, 'actionable escalation text');

  restore();
});

test('LMStudioBrain: ECONNREFUSED → typed escalation (never throws)', async () => {
  pinModel();
  globalThis.fetch = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;

  const decision = await new LMStudioBrain().reason('hello', 'ctx');
  assert.match(decision.reply!, /not responding|start the server/i, 'unreachable → actionable escalation');

  restore();
});

test('LMStudioBrain: non-streamed tool call is gate-dispatched; observation replayed with tool_call_id', async () => {
  pinModel();
  let call = 0;
  const bodies: Array<{ messages?: Array<{ role: string; tool_call_id?: string }> }> = [];
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    call += 1;
    const body = init?.body ? JSON.parse(init.body) : {};
    bodies.push(body);
    if (call === 1) {
      // first hop: the model asks for the web tool (arguments are a JSON STRING, OpenAI-style)
      return jsonResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_abc',
                  type: 'function',
                  function: { name: 'web', arguments: '{"op":"search","query":"mac mini price"}' },
                },
              ],
            },
          },
        ],
      });
    }
    // second hop: a role:'tool' observation (with tool_call_id) must precede the answer
    const toolMsg = (body.messages ?? []).find((m: { role: string }) => m.role === 'tool');
    assert.ok(toolMsg, 'observation appended before the answer hop');
    assert.equal(toolMsg!.tool_call_id, 'call_abc', 'tool result carries the originating call id');
    return jsonResponse({
      choices: [{ message: { role: 'assistant', content: 'The latest Mac mini starts at $599.' } }],
    });
  }) as unknown as typeof fetch;

  const dispatched: ToolCall[] = [];
  __setLmStudioToolDispatcherForTest(async (c: ToolCall) => {
    dispatched.push(c);
    return { ok: true, data: { results: [{ title: 'Mac mini', snippet: '$599' }] } };
  });

  const activity: Array<{ tool: string; status: string }> = [];
  const decision = await new LMStudioBrain().reason(
    'what is the latest mac mini price?',
    'ctx',
    undefined,
    undefined,
    (e) => activity.push({ tool: e.tool, status: e.status }),
  );

  assert.equal(dispatched.length, 1, 'the web tool dispatched exactly once');
  assert.equal(dispatched[0].tool, 'web');
  assert.equal((dispatched[0].args as { op?: string }).op, 'search', 'JSON-string args parsed to an object');
  assert.match(decision.reply!, /599/, 'final answer uses the observation');
  assert.equal(call, 2, 'one tool hop + one answer hop');
  assert.deepEqual(activity, [
    { tool: 'web', status: 'start' },
    { tool: 'web', status: 'ok' },
  ]);

  restore();
});

test('LMStudioBrain: when the model omits tool-call ids, the assistant turn + tool result still correlate (stamped id)', async () => {
  pinModel();
  let call = 0;
  let assistantToolCallId: string | undefined;
  let toolMsgId: string | undefined;
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    call += 1;
    const body = init?.body ? JSON.parse(init.body) : {};
    if (call === 1) {
      // NO id on the tool call (some servers/models omit it)
      return jsonResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ type: 'function', function: { name: 'fs', arguments: '{"op":"list","path":"/tmp"}' } }],
            },
          },
        ],
      });
    }
    // second hop: capture the ids from both the replayed assistant turn and the tool result message
    const msgs = (body.messages ?? []) as Array<{ role: string; tool_call_id?: string; tool_calls?: Array<{ id?: string }> }>;
    assistantToolCallId = msgs.find((m) => m.role === 'assistant' && m.tool_calls)?.tool_calls?.[0]?.id;
    toolMsgId = msgs.find((m) => m.role === 'tool')?.tool_call_id;
    return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'done' } }] });
  }) as unknown as typeof fetch;

  __setLmStudioToolDispatcherForTest(async () => ({ ok: true, data: {} }));
  await new LMStudioBrain().reason('list /tmp', 'ctx');

  assert.ok(assistantToolCallId, 'the assistant turn carries a (stamped) tool-call id');
  assert.equal(assistantToolCallId, toolMsgId, 'the tool result tool_call_id matches the assistant turn');

  restore();
});

test('LMStudioBrain: streams content deltas via onToken; usage from the final chunk', async () => {
  pinModel();
  const seen: { body?: { stream?: boolean; stream_options?: unknown } } = {};
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    seen.body = init?.body ? JSON.parse(init.body) : undefined;
    return {
      ok: true,
      status: 200,
      body: sseStream([
        { choices: [{ delta: { role: 'assistant', content: 'Hello' } }] },
        { choices: [{ delta: { content: ', world' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3 } },
      ]),
      async text() {
        return '';
      },
    };
  }) as unknown as typeof fetch;

  const chunks: string[] = [];
  const decision = await new LMStudioBrain().reason('hi', 'ctx', (c) => chunks.push(c));
  assert.equal(seen.body?.stream, true, 'onToken → streamed request');
  assert.ok(seen.body?.stream_options, 'requests usage in the final stream chunk');
  assert.deepEqual(chunks, ['Hello', ', world'], 'each content delta surfaces via onToken');
  assert.equal(decision.reply, 'Hello, world', 'deltas concatenate into the reply');
  assert.equal(decision.usage!.outputTokens, 3, 'usage comes from the final chunk');
  assert.equal(decision.usage!.promptTokens, 10);

  restore();
});

test('LMStudioBrain: streams reasoning_content via onThinking, closed once, separate from the answer', async () => {
  pinModel();
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    body: sseStream([
      { choices: [{ delta: { role: 'assistant', reasoning_content: 'Let me ' } }] },
      { choices: [{ delta: { reasoning_content: 'work it out.' } }] },
      { choices: [{ delta: { content: 'The answer ' } }] },
      { choices: [{ delta: { content: 'is 42.' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { completion_tokens: 4 } },
    ]),
    async text() {
      return '';
    },
  })) as unknown as typeof fetch;

  const answer: string[] = [];
  const thoughts: string[] = [];
  let finals = 0;
  const decision = await new LMStudioBrain().reason(
    'analyze this step by step and figure out the answer', // deliberate → reasoning sink active
    'ctx',
    (c) => answer.push(c),
    [],
    undefined,
    (delta, final) => {
      if (delta) thoughts.push(delta);
      if (final) finals += 1;
    },
  );

  assert.deepEqual(thoughts, ['Let me ', 'work it out.'], 'reasoning_content surfaces via onThinking');
  assert.equal(finals, 1, 'reasoning closed exactly once (when the answer begins)');
  assert.deepEqual(answer, ['The answer ', 'is 42.'], 'the answer streams via onToken');
  assert.equal(decision.reply, 'The answer is 42.', 'reasoning is NOT part of the reply');

  restore();
});

test('LMStudioBrain: prefill timing ends at the FIRST output token (reasoning), not the first content token', async () => {
  pinModel();
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    // reasoning streams first, then content — like a real reasoning turn. firstTokenAt must latch on
    // the first reasoning delta so the reasoning-generation window is counted as generation, not prefill.
    body: sseStream([
      { choices: [{ delta: { reasoning_content: 'thinking…' } }] },
      { choices: [{ delta: { content: 'Answer.' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } },
    ]),
    async text() {
      return '';
    },
  })) as unknown as typeof fetch;

  const decision = await new LMStudioBrain().reason(
    'analyze this step by step and figure out the answer',
    'ctx',
    () => {},
  );
  // Both timings are present and prefill is not inflated by the reasoning-generation window.
  assert.ok(typeof decision.usage!.promptEvalMs === 'number', 'prefill (time-to-first-output) is measured');
  assert.ok(typeof decision.usage!.evalMs === 'number', 'generation time is measured');
  assert.ok(
    decision.usage!.promptEvalMs! <= decision.usage!.totalMs!,
    'prefill never exceeds the total turn time',
  );

  restore();
});

test('LMStudioBrain: a QUICK turn surfaces no reasoning even if reasoning_content arrives', async () => {
  pinModel();
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    body: sseStream([
      { choices: [{ delta: { role: 'assistant', reasoning_content: 'stray', content: 'Hi.' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { completion_tokens: 1 } },
    ]),
    async text() {
      return '';
    },
  })) as unknown as typeof fetch;

  const thoughts: string[] = [];
  await new LMStudioBrain().reason('hi there', 'ctx', () => {}, [], undefined, (d) => {
    if (d) thoughts.push(d);
  });
  assert.deepEqual(thoughts, [], 'a quick turn surfaces NO reasoning (sink gated on deliberate)');

  restore();
});

test('LMStudioBrain: assembles a streamed tool call from indexed fragments and dispatches it', async () => {
  pinModel();
  let call = 0;
  globalThis.fetch = (async () => {
    call += 1;
    if (call === 1) {
      return {
        ok: true,
        status: 200,
        body: sseStream([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_x', type: 'function', function: { name: 'fs', arguments: '' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"op":"li' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'st","path":"/tmp"}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { completion_tokens: 2 } },
        ]),
        async text() {
          return '';
        },
      };
    }
    return {
      ok: true,
      status: 200,
      body: sseStream([
        { choices: [{ delta: { content: 'Listed /tmp.' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { completion_tokens: 2 } },
      ]),
      async text() {
        return '';
      },
    };
  }) as unknown as typeof fetch;

  const dispatched: ToolCall[] = [];
  __setLmStudioToolDispatcherForTest(async (c: ToolCall) => {
    dispatched.push(c);
    return { ok: true, data: { entries: [] } };
  });

  const decision = await new LMStudioBrain().reason('list the files in /tmp', 'ctx', () => {});
  assert.equal(dispatched.length, 1, 'the streamed tool call assembled + dispatched once');
  assert.equal(dispatched[0].tool, 'fs');
  assert.deepEqual(dispatched[0].args, { op: 'list', path: '/tmp' }, 'fragmented JSON arguments reassembled + parsed');
  assert.match(decision.reply!, /Listed/, 'final answer follows the tool result');

  restore();
});
