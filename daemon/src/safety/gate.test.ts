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
