/**
 * gate.test.ts — the single classify-only chokepoint (HANDS-05).
 *
 *   (a) a credential-fence call denies with a recommendation — the HARD RULE fires BEFORE
 *       tier classification (it denies even though a non-secret type/fill would be Yellow);
 *   (b) a Red-classified call (delete/purchase) denies per the LOCKED DECISION (NOT gated);
 *   (c) a green call allows;
 *   (d) a yellow non-secret type allows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { authorize, type Verdict } from './gate.js';
import type { ToolCall } from '../brain/BrainProvider.js';
import type { Provenance } from '../memory/types.js';
import { FLAGS } from './flags.js';
import { createOverride } from './override.js';
import { fakeClock, captureAudit } from './test-helpers.js';

const call = (tool: string, args: Record<string, unknown>, origin?: Provenance): ToolCall => ({
  tool,
  args,
  origin,
});

/** Build an ACTIVE /override (fake clock) so the hard-rule tests run under live override. */
function activeOverride() {
  const ov = createOverride({ clock: fakeClock(), audit: captureAudit().audit });
  ov.activate('test-session', 60_000);
  return ov;
}

/** Run a block with FLAGS.breakerEnabled forced to `val`, always restoring it. */
async function withBreakerFlag(val: boolean, fn: () => Promise<void>): Promise<void> {
  const prev = FLAGS.breakerEnabled;
  FLAGS.breakerEnabled = val;
  try {
    await fn();
  } finally {
    FLAGS.breakerEnabled = prev;
  }
}

test('authorize: the credential fence denies (hard rule fires before tier classification)', async () => {
  // A type/fill into a password field would otherwise classify Yellow; the fence denies first.
  const verdict: Verdict = await authorize(call('browser', { op: 'fill', fieldLabel: 'Password' }));
  assert.equal(verdict.kind, 'deny');
  assert.equal(verdict.tier, 'red');
  assert.ok(verdict.kind === 'deny' && verdict.escalation.recommendation, 'carries a recommendation');
  assert.match(
    verdict.kind === 'deny' ? verdict.escalation.reason : '',
    /secure\/credential field/,
    'credential-fence escalation',
  );
});

test('authorize: a secure text field also denies via the fence (isSecureField)', async () => {
  const verdict = await authorize(call('peekaboo', { op: 'type', isSecureField: true }));
  assert.equal(verdict.kind, 'deny');
  assert.equal(verdict.tier, 'red');
});

test('authorize: a Red-classified call denies + escalates per the LOCKED DECISION (NOT gated)', async () => {
  const del = await authorize(call('fs', { op: 'delete' }));
  assert.equal(del.kind, 'deny', 'Red is deny in Phase 2, never gated');
  assert.equal(del.tier, 'red');
  assert.match(del.kind === 'deny' ? del.escalation.reason : '', /Red-tier/, 'Red escalation');

  const buy = await authorize(call('shop', { op: 'purchase' }));
  assert.equal(buy.kind, 'deny');
});

test('authorize: a green call is allowed', async () => {
  const verdict = await authorize(call('peekaboo', { op: 'click' }));
  assert.equal(verdict.kind, 'allow');
  assert.equal(verdict.tier, 'green');
});

test('authorize: a yellow non-secret type is allowed', async () => {
  // A non-secret field (label "To") classifies Yellow and is NOT fenced → allow.
  const verdict = await authorize(call('peekaboo', { op: 'type', fieldLabel: 'To' }));
  assert.equal(verdict.kind, 'allow');
  assert.equal(verdict.tier, 'yellow');
});

// --- CC-03: a Red-tier action proposed by a Claude Code session is DENIED ---
// (the re-submission shim is DEFERRED to Phase 5 — Green/Yellow only this phase).

test('authorize: a Red action from a Claude Code session is DENIED (shim deferred to Phase 5)', async () => {
  // A Claude Code session that proposes a destructive op routes through the SAME shipped
  // chokepoint as everything else — the originator does not matter. It classifies Red and
  // is denied + escalated; there is NO 'gated'/'allow' arm for Red this phase (CC-03).
  const rmrf = await authorize(call('claude-code', { op: 'rm -rf', path: '/' }));
  assert.equal(rmrf.kind, 'deny', 'a Claude Code rm -rf is denied, never gated or allowed');
  assert.equal(rmrf.tier, 'red');
  assert.notEqual(rmrf.kind, 'gated', 'NO gated arm for Red — the shim is deferred to Phase 5');
  assert.notEqual(rmrf.kind, 'allow', 'NO Red autonomy for a Claude Code session');

  const purchase = await authorize(call('claude-code', { op: 'purchase', item: 'server' }));
  assert.equal(purchase.kind, 'deny', 'a Claude Code purchase is denied');
  assert.equal(purchase.tier, 'red');
  assert.match(
    purchase.kind === 'deny' ? purchase.escalation.reason : '',
    /Red-tier/,
    'the denial carries a Red-tier escalation for the originator',
  );
});

// --- PHASE 5: the three hard rules ABOVE /override + the SAFE-07 flag gate ---

test('SAFE-04 i: the credential fence DENIES even under ACTIVE /override (overridable=false)', async () => {
  // Even with the breaker flag ON and /override active, the credential fence fires first.
  await withBreakerFlag(true, async () => {
    const verdict = await authorize(
      call('browser', { op: 'fill', fieldLabel: 'Password' }),
      activeOverride(),
    );
    assert.equal(verdict.kind, 'deny', 'the credential fence denies under active override');
    assert.match(
      verdict.kind === 'deny' ? verdict.escalation.reason : '',
      /secure\/credential field/,
      'fence escalation, not a gated/allow verdict',
    );
  });
});

test('SAFE-04 ii: a Red action with origin=external is HARD-BLOCKED even under ACTIVE /override (poisoned email)', async () => {
  // The test-injection "poisoned email": an external-sourced instruction that classifies Red.
  // Even with the breaker flag ON and /override ACTIVE, it must DENY (never gated, never allowed).
  await withBreakerFlag(true, async () => {
    const poisoned = await authorize(
      call('fs', { op: 'rm -rf', path: '/' }, 'external'),
      activeOverride(),
    );
    assert.equal(poisoned.kind, 'deny', 'external-sourced Red is hard-blocked, NOT gated');
    assert.equal(poisoned.tier, 'red');
    assert.notEqual(poisoned.kind, 'gated', 'a poisoned email can NEVER reach the breaker');
    assert.match(
      poisoned.kind === 'deny' ? poisoned.escalation.reason : '',
      /external content/i,
      'the denial cites the external-content origin',
    );
  });
});

test('SAFE-04 ii: Red with absent/unknown origin defaults to gated (breaker, default-deny posture) — NOT auto-allowed', async () => {
  await withBreakerFlag(true, async () => {
    const unknown = await authorize(call('fs', { op: 'delete' }) /* no origin */, activeOverride());
    assert.equal(unknown.kind, 'gated', 'unknown-origin Red is still gated by the breaker (suspect, not hard-blocked)');
    assert.notEqual(unknown.kind, 'allow', 'unknown-origin Red is NEVER auto-allowed');
  });
});

test('SAFE-07: flag OFF → Red denies (P1-P4 behaviour-preserving); flag ON + user/self origin → gated', async () => {
  await withBreakerFlag(false, async () => {
    const off = await authorize(call('shop', { op: 'purchase', amount: 5 }, 'user'));
    assert.equal(off.kind, 'deny', 'flag OFF reproduces the P1-P4 Red deny');
    assert.match(off.kind === 'deny' ? off.escalation.reason : '', /Red-tier/, 'P1-P4 escalation');
  });
  await withBreakerFlag(true, async () => {
    const onUser = await authorize(call('shop', { op: 'purchase', amount: 5 }, 'user'));
    assert.equal(onUser.kind, 'gated', 'flag ON + user origin → gated (the live breaker)');
    const onSelf = await authorize(call('fs', { op: 'rm -rf', path: '/tmp/x' }, 'self'));
    assert.equal(onSelf.kind, 'gated', 'flag ON + self origin → gated');
  });
});

test('SAFE-02 defense-in-depth: ACTIVE /override does NOT change the Red decision', async () => {
  await withBreakerFlag(true, async () => {
    const ov = activeOverride();
    assert.equal(ov.isActive(), true, 'override is active for this assertion');
    const red = await authorize(call('fs', { op: 'rm -rf', path: '/tmp/y' }, 'user'), ov);
    assert.equal(red.kind, 'gated', 'Red stays gated under active override — override never bypasses Red');
  });
});

test('green/yellow: still allow under Phase 5 (existing shipped cases stay green; override threads friction)', async () => {
  const green = await authorize(call('peekaboo', { op: 'click' }, 'user'), activeOverride());
  assert.equal(green.kind, 'allow');
  assert.equal(green.tier, 'green');
  const yellow = await authorize(call('peekaboo', { op: 'type', fieldLabel: 'To' }, 'user'), activeOverride());
  assert.equal(yellow.kind, 'allow');
  assert.equal(yellow.tier, 'yellow');
});
