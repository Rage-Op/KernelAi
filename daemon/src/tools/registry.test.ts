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

import { register, dispatch, clearRegistry, setBreakerDeps } from './registry.js';
import type { Tool, ToolResult } from './Tool.js';
import { FLAGS } from '../safety/flags.js';
import type { BreakerDeps } from '../safety/breaker.js';

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

// --- PHASE 5: the `gated` arm routes to breaker.run (mock breakerDeps), NOT plain execute ---

/** Run a block with FLAGS.breakerEnabled forced ON, always restoring it + clearing the deps. */
async function withBreakerEnabled(fn: () => Promise<void>): Promise<void> {
  const prev = FLAGS.breakerEnabled;
  FLAGS.breakerEnabled = true;
  try {
    await fn();
  } finally {
    FLAGS.breakerEnabled = prev;
    setBreakerDeps(null); // restore the real wiring for any later-ordered test.
  }
}

test('registry: a GATED (Red) verdict routes to breaker.run with the injected deps, never plain execute', async () => {
  await withBreakerEnabled(async () => {
    clearRegistry();
    // The tool's OWN execute must NOT be reached via the plain allow path for a gated call —
    // only via the breaker's injected `execute` dep (mocked here). We assert the breaker ran.
    const { tool, reached } = stubTool({ name: 'fs', schema: z.object({ op: z.string() }) });
    register(tool);

    let breakerEntered = false;
    let breakerExecuteCalled = false;
    const mockDeps: BreakerDeps = {
      clock: { now: () => 0, sleep: async () => {} },
      cancelled: () => false,
      emitPreview: () => {
        breakerEntered = true;
      },
      ledger: {
        checkAndReserve: () => ({ ok: true, reserved: 0, ceiling: 100, totalReserved: 0 }),
        release: () => {},
        dayReset: () => {},
      },
      audit: () => {},
      execute: async () => {
        breakerExecuteCalled = true;
        return { ok: true, data: { viaBreaker: true } };
      },
      reReadState: async () => 'stable',
      windowMs: 0, // window already elapsed → straight to ceiling/TOCTOU/execute.
    };
    setBreakerDeps(mockDeps);

    // origin user + Red op (delete) → gate returns { kind:'gated' } → dispatch runs breaker.run.
    const result = await dispatch({ tool: 'fs', args: { op: 'delete' }, origin: 'user' });

    assert.equal(breakerEntered, true, 'the breaker was entered (a preview was emitted)');
    assert.equal(breakerExecuteCalled, true, 'the breaker, not the plain path, drove execute');
    assert.equal(result.ok, true, 'the breaker proceed path returned success');
    assert.deepEqual(result.data, { viaBreaker: true }, 'the result came from the breaker execute');
    assert.equal(reached(), false, 'the tool.execute plain path was NOT reached (gated did not fall through)');
  });
});

test('registry: a GATED cancel aborts via the breaker — the tool action never runs', async () => {
  await withBreakerEnabled(async () => {
    clearRegistry();
    const { tool } = stubTool({ name: 'fs', schema: z.object({ op: z.string() }) });
    register(tool);

    let executed = false;
    const mockDeps: BreakerDeps = {
      clock: { now: () => 0, sleep: async () => {} },
      cancelled: () => true, // owner cancels immediately.
      emitPreview: () => {},
      ledger: {
        checkAndReserve: () => ({ ok: true, reserved: 0, ceiling: 100, totalReserved: 0 }),
        release: () => {},
        dayReset: () => {},
      },
      audit: () => {},
      execute: async () => {
        executed = true;
        return { ok: true };
      },
      reReadState: async () => 'stable',
      windowMs: 1000,
    };
    setBreakerDeps(mockDeps);

    const result = await dispatch({ tool: 'fs', args: { op: 'rm -rf', path: '/' }, origin: 'user' });
    assert.equal(result.ok, false, 'a cancelled gated action returns an escalation');
    assert.equal(executed, false, 'the breaker NEVER executed the cancelled action');
  });
});
