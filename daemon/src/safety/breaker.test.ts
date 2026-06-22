/**
 * breaker.test.ts — the Red-tier circuit breaker as a pure injectable state machine (SAFE-03).
 *
 * EVERY path uses the Wave-0 harness (fake clock, recording mock executor, controllable cancel,
 * in-memory ledger, capture audit) — NO real timer, NO real executor, NO real spend. The five
 * SAFE-03 cases:
 *   1. proceed: one preview emitted → 10s window elapses (fake clock) → ceiling OK → audit
 *      'executed' → executor called EXACTLY ONCE.
 *   2. cancel during the window → audit 'cancelled', executor NEVER called.
 *   3. ceiling exceeded → audit 'ceiling-exceeded', escalate, executor NEVER called, no reserve held.
 *   4. TOCTOU: reReadState differs at execute time → audit 'toctou-abort', reserve released,
 *      executor NEVER called.
 *   5. no real side effects in any path (asserted by the recording executor + capture audit).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { run, estimatedSpend, canonical, type BreakerDeps } from './breaker.js';
import type { ToolCall } from '../brain/BrainProvider.js';
import {
  fakeClock,
  recordingExecutor,
  controllableCancel,
  memoryLedger,
  captureAudit,
} from './test-helpers.js';

/** A non-financial Red call (estimatedSpend 0). */
const rmCall: ToolCall = { tool: 'fs', args: { op: 'rm -rf', path: '/tmp/x' } };
/** A financial Red call. */
const buyCall: ToolCall = { tool: 'shop', args: { op: 'purchase', item: 'server', amount: 40 } };

/** Build a default deps bundle wired to the harness, with a short window for the fake clock. */
function deps(overrides: Partial<BreakerDeps> = {}): {
  d: BreakerDeps;
  exec: ReturnType<typeof recordingExecutor>;
  cancel: ReturnType<typeof controllableCancel>;
  aud: ReturnType<typeof captureAudit>;
  reReadCalls: string[];
} {
  const clock = fakeClock();
  const exec = recordingExecutor();
  const cancel = controllableCancel();
  const aud = captureAudit();
  const reReadCalls: string[] = [];
  const d: BreakerDeps = {
    clock,
    cancelled: cancel.cancelled,
    emitPreview: () => {},
    ledger: memoryLedger(100),
    audit: aud.audit,
    execute: exec.execute,
    // default reReadState returns the SAME canonical(call) the preview hashed → no TOCTOU.
    reReadState: async (call) => {
      reReadCalls.push(canonical(call));
      return canonical(call);
    },
    windowMs: 1_000,
    ...overrides,
  };
  return { d, exec, cancel, aud, reReadCalls };
}

test('breaker: estimatedSpend reads a numeric amount; non-financial ops are 0', () => {
  assert.equal(estimatedSpend(buyCall), 40);
  assert.equal(estimatedSpend(rmCall), 0);
});

test('breaker: proceed path — preview emitted, window elapses, ceiling OK, audit executed, executor called once', async () => {
  let previews = 0;
  const { d, exec, aud } = deps({ emitPreview: () => previews++ });
  const result = await run(buyCall, d);

  assert.equal(previews, 1, 'exactly one dry-run preview emitted (no side effects)');
  assert.equal(result.ok, true, 'the proceed path returns the executor result');
  assert.equal(exec.calls.length, 1, 'the executor is called EXACTLY ONCE on proceed');
  const last = aud.entries.at(-1);
  assert.equal(last?.outcome, 'executed', 'audit records executed');
  assert.ok(typeof last?.hash === 'string' && last.hash.length === 64, 'executed audit carries a sha256 content hash');
});

test('breaker: cancel during the window aborts + audits cancelled, executor NEVER called', async () => {
  const { d, exec, cancel, aud } = deps();
  cancel.trigger(); // owner cancels before the window opens.
  const result = await run(rmCall, d);

  assert.equal(result.ok, false, 'a cancel returns an escalation, not success');
  assert.equal(exec.calls.length, 0, 'the executor is NEVER called when cancelled');
  assert.equal(aud.entries.at(-1)?.outcome, 'cancelled', 'audit records cancelled');
});

test('breaker: ceiling exceeded → audit ceiling-exceeded, escalate, executor NEVER called', async () => {
  // ceiling 10, but the buy is 40 → over the ceiling.
  const { d, exec, aud } = deps({ ledger: memoryLedger(10) });
  const result = await run(buyCall, d);

  assert.equal(result.ok, false, 'exceeding the ceiling escalates');
  assert.match(result.escalation?.reason ?? '', /ceiling/i, 'the escalation cites the ceiling');
  assert.equal(exec.calls.length, 0, 'the executor is NEVER called when the ceiling is exceeded');
  assert.equal(aud.entries.at(-1)?.outcome, 'ceiling-exceeded', 'audit records ceiling-exceeded');
});

test('breaker: TOCTOU — state hash changes between preview and execute → toctou-abort, reserve released, executor NEVER called', async () => {
  const ledger = memoryLedger(100);
  // reReadState returns one state at preview time and a DIFFERENT state at execute time → the
  // world mutated between preview and execute → hash mismatch → abort.
  let reads = 0;
  const { d, exec, aud } = deps({
    ledger,
    reReadState: async () => (reads++ === 0 ? 'state-at-preview' : 'state-at-execute-CHANGED'),
  });
  const result = await run(buyCall, d);

  assert.equal(result.ok, false, 'a TOCTOU mismatch aborts');
  assert.match(result.escalation?.reason ?? '', /TOCTOU|state changed/i, 'the escalation cites TOCTOU');
  assert.equal(exec.calls.length, 0, 'the executor is NEVER called on a TOCTOU abort');
  assert.equal(aud.entries.at(-1)?.outcome, 'toctou-abort', 'audit records toctou-abort');
  // the reserve was released — a fresh 40 reserve must now fit under the 100 ceiling with room.
  assert.equal((ledger as ReturnType<typeof memoryLedger>).total(), 0, 'the reserve was released back to 0');
});

test('breaker: no real side effects — every abort path leaves the recording executor untouched', async () => {
  // cancel
  {
    const { d, exec, cancel } = deps();
    cancel.trigger();
    await run(buyCall, d);
    assert.equal(exec.calls.length, 0, 'cancel: no execute');
  }
  // ceiling
  {
    const { d, exec } = deps({ ledger: memoryLedger(1) });
    await run(buyCall, d);
    assert.equal(exec.calls.length, 0, 'ceiling: no execute');
  }
  // toctou (state differs between the preview read and the execute read)
  {
    let n = 0;
    const { d, exec } = deps({ reReadState: async () => (n++ === 0 ? 'before' : 'after-CHANGED') });
    await run(buyCall, d);
    assert.equal(exec.calls.length, 0, 'toctou: no execute');
  }
});
