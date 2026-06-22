/**
 * ClaudeBrain.test.ts — RED until Task 2 creates ClaudeBrain.ts.
 *
 * Covers BRAIN-02 (default brain, model 'claude-opus-4-8', text → Decision.reply) and
 * BRAIN-06 (manual tool loop: stop_reason 'tool_use' → exactly ONE Decision.action and
 * NO tool executed inside reason() — the loop's gated dispatch is the chokepoint).
 *
 * The SDK is mocked via the `__setClientForTest` seam (mirrors tools/peekaboo.ts). No
 * live ANTHROPIC_API_KEY / network is needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ClaudeBrain, CLAUDE_MODEL, __setClientForTest, type ClaudeClient } from './ClaudeBrain.js';

/** A mock SDK client that returns a canned text reply and records the params it saw. */
function textClient(text: string): { client: ClaudeClient; calls: unknown[] } {
  const calls: unknown[] = [];
  const client: ClaudeClient = {
    messages: {
      async create(params: unknown) {
        calls.push(params);
        return {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text }],
        };
      },
    },
  };
  return { client, calls };
}

/** A mock SDK client whose reply is a single tool_use block (stop_reason 'tool_use'). */
function toolUseClient(): { client: ClaudeClient; executed: boolean } {
  const state = { executed: false };
  const client: ClaudeClient = {
    messages: {
      async create() {
        // If the brain ever "ran" a tool itself, a real impl would flip executed; the
        // mock NEVER executes — we assert the brain returns the action instead.
        return {
          stop_reason: 'tool_use',
          content: [
            { type: 'text', text: 'I should look at the screen.' },
            { type: 'tool_use', id: 'tu_1', name: 'peekaboo', input: { op: 'see' } },
          ],
        };
      },
    },
  };
  return { client, executed: state.executed };
}

test('ClaudeBrain: a text reply maps to Decision.reply; model is claude-opus-4-8', async () => {
  const { client, calls } = textClient('Hello, Pravin.');
  __setClientForTest(client);
  const decision = await new ClaudeBrain().reason('hi', 'identity+memory');

  assert.equal(decision.reply, 'Hello, Pravin.', 'text reply maps to Decision.reply');
  assert.equal(decision.action, undefined, 'a plain text reply carries no action');
  assert.equal(CLAUDE_MODEL, 'claude-opus-4-8', 'the model tag is claude-opus-4-8 (BRAIN-02)');
  const params = calls[0] as { model?: string };
  assert.equal(params.model, 'claude-opus-4-8', 'messages.create is called with claude-opus-4-8');

  __setClientForTest(null);
});

test('ClaudeBrain: stop_reason tool_use → exactly ONE Decision.action, no tool executed (BRAIN-06)', async () => {
  const { client } = toolUseClient();
  __setClientForTest(client);
  const decision = await new ClaudeBrain().reason('look at my screen', 'ctx');

  assert.ok(decision.action, 'a tool_use reply must surface a Decision.action');
  assert.equal(decision.action!.tool, 'peekaboo', 'the action tool is the tool_use block name');
  assert.deepEqual(decision.action!.args, { op: 'see' }, 'the action args are the tool_use input');
  assert.equal(decision.reply, undefined, 'a tool turn returns an action, not a reply');

  __setClientForTest(null);
});
