/**
 * registry.test.ts — the tool router + the single dispatch chokepoint (HANDS-04, HANDS-05).
 *
 * Asserts the load-bearing dispatch order:
 *   (a) a registered green tool with valid args reaches execute and returns its result;
 *   (b) an UNKNOWN tool name is default-denied — no execute, structured escalation;
 *   (c) a gate-denied call (credential fence / Red) NEVER reaches execute;
 *   (d) invalid args (failing the tool's zod schema) are rejected before execute.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { register, dispatch, clearRegistry } from './registry.js';
import type { Tool, ToolResult } from './Tool.js';

/** A stub tool whose execute flips `reached` so "execute was reached" is assertable. */
function stubTool(overrides: Partial<Tool> = {}): { tool: Tool; reached: () => boolean } {
  let executed = false;
  const tool: Tool = {
    name: 'stub',
    schema: z.object({ op: z.string() }),
    async execute(args): Promise<ToolResult> {
      executed = true;
      return { ok: true, data: { echo: args } };
    },
    ...overrides,
  };
  return { tool, reached: () => executed };
}

test('registry: register then dispatch reaches execute for a known green tool with valid args', async () => {
  clearRegistry();
  const { tool, reached } = stubTool();
  register(tool);

  const result = await dispatch({ tool: 'stub', args: { op: 'click' } });

  assert.equal(reached(), true, 'execute must be reached for an allowed green call');
  assert.equal(result.ok, true, 'dispatch returns the tool result');
  assert.deepEqual(result.data, { echo: { op: 'click' } }, 'tool output is surfaced');
});

test('registry: an UNKNOWN tool name is default-denied and never calls execute', async () => {
  clearRegistry();
  const { tool, reached } = stubTool();
  register(tool); // a different tool is registered, but we dispatch a name that is not present.

  const result = await dispatch({ tool: 'does-not-exist', args: { op: 'click' } });

  assert.equal(result.ok, false, 'unknown tool is denied');
  assert.match(result.escalation?.reason ?? '', /unknown tool/, 'structured unknown-tool escalation');
  assert.equal(reached(), false, 'no tool execute is ever reached (default-deny)');
});

test('registry: a gate-denied call (credential fence) never reaches execute', async () => {
  clearRegistry();
  // The fence applies to peekaboo/browser type/fill ops — model the stub as the browser tool.
  const { tool, reached } = stubTool({
    name: 'browser',
    schema: z.object({ op: z.string(), fieldLabel: z.string() }),
  });
  register(tool);

  const result = await dispatch({
    tool: 'browser',
    args: { op: 'fill', fieldLabel: 'Password' },
  });

  assert.equal(result.ok, false, 'a denied call returns ok:false');
  assert.match(result.escalation?.reason ?? '', /secure\/credential field/, 'fence escalation surfaced');
  assert.equal(reached(), false, 'execute is NEVER reached when the gate denies');
});

test('registry: a Red-classified call is denied and never reaches execute', async () => {
  clearRegistry();
  const { tool, reached } = stubTool({
    name: 'fs',
    schema: z.object({ op: z.string() }),
  });
  register(tool);

  const result = await dispatch({ tool: 'fs', args: { op: 'delete' } });

  assert.equal(result.ok, false, 'a Red call is denied in Phase 2 (LOCKED: deny + escalate)');
  assert.match(result.escalation?.reason ?? '', /Red-tier/, 'Red escalation surfaced');
  assert.equal(reached(), false, 'execute is never reached for a Red call');
});

test('registry: invalid args (failing the tool zod schema) are rejected before execute', async () => {
  clearRegistry();
  // Schema requires { op: string, n: number }. The call carries a GREEN op (so the gate ALLOWS)
  // but `n` is a string — the rejection must come from zod, not the gate, proving args are
  // validated AFTER the gate clears and BEFORE execute.
  const { tool, reached } = stubTool({
    schema: z.object({ op: z.string(), n: z.number() }),
  });
  register(tool);

  const result = await dispatch({ tool: 'stub', args: { op: 'click', n: 'not-a-number' } });

  assert.equal(result.ok, false, 'invalid args are rejected');
  assert.match(result.escalation?.reason ?? '', /invalid tool args/, 'structured invalid-args escalation');
  assert.equal(reached(), false, 'execute is not reached when args fail validation');
});
