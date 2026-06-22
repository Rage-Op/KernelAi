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

const call = (tool: string, args: Record<string, unknown>): ToolCall => ({ tool, args });

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
