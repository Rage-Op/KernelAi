/**
 * tiers.test.ts — the tier classifier (SAFE-01 seed) + the credential-entry fence (HANDS-05).
 *
 *   (a) a representative matrix: green for capture/click/navigate/read, yellow for
 *       non-secret type/fill/send/mark-read, red for purchase/delete/rm;
 *   (b) an unknown op defaults to red (default-deny);
 *   (c) detectCredentialField is secret for isSecureField:true, a 'Password' label,
 *       a 'current-password' autocomplete, and a 'cvv' label;
 *   (d) a normal field (label 'To') is NOT secret;
 *   (e) a non-type op (e.g. click) is never fenced.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyTier, detectCredentialField } from './tiers.js';
import type { ToolCall } from '../brain/BrainProvider.js';

const call = (tool: string, args: Record<string, unknown>): ToolCall => ({ tool, args });

test('classifyTier: green for reversible capture/click/navigate/read ops', () => {
  assert.equal(classifyTier(call('peekaboo', { op: 'see' })), 'green');
  assert.equal(classifyTier(call('peekaboo', { op: 'click' })), 'green');
  assert.equal(classifyTier(call('browser', { op: 'navigate' })), 'green');
  assert.equal(classifyTier(call('browser', { op: 'scrape' })), 'green');
  assert.equal(classifyTier(call('mail', { op: 'read' })), 'green');
  assert.equal(classifyTier(call('peekaboo', { op: 'list' })), 'green');
});

test('classifyTier: yellow for recoverable type/fill/send/mark-read ops', () => {
  assert.equal(classifyTier(call('peekaboo', { op: 'type' })), 'yellow');
  assert.equal(classifyTier(call('browser', { op: 'fill' })), 'yellow');
  assert.equal(classifyTier(call('mail', { op: 'send' })), 'yellow');
  assert.equal(classifyTier(call('mail', { op: 'mark-read' })), 'yellow');
  assert.equal(classifyTier(call('app', { op: 'install' })), 'yellow');
});

test('classifyTier: red for irreversible / financial purchase/delete/rm ops', () => {
  assert.equal(classifyTier(call('shop', { op: 'purchase' })), 'red');
  assert.equal(classifyTier(call('bank', { op: 'transfer' })), 'red');
  assert.equal(classifyTier(call('fs', { op: 'delete' })), 'red');
  assert.equal(classifyTier(call('shell', { op: 'rm -rf' })), 'red');
});

test('classifyTier: an unknown / unrecognized op defaults to red (default-deny)', () => {
  assert.equal(classifyTier(call('mystery', { op: 'frobnicate' })), 'red');
  assert.equal(classifyTier(call('mystery', {})), 'red', 'no op falls back to the tool name → unrecognized → red');
});

test('detectCredentialField: isSecret for a secure text field', () => {
  const r = detectCredentialField(call('peekaboo', { op: 'type', isSecureField: true }));
  assert.equal(r.isSecret, true);
  assert.match(r.reason, /secure text field/);
});

test('detectCredentialField: isSecret for a "Password" field label', () => {
  const r = detectCredentialField(call('browser', { op: 'fill', fieldLabel: 'Password' }));
  assert.equal(r.isSecret, true);
  assert.match(r.reason, /label matched/);
});

test('detectCredentialField: isSecret for a "current-password" autocomplete hint', () => {
  const r = detectCredentialField(call('browser', { op: 'fill', autocomplete: 'current-password' }));
  assert.equal(r.isSecret, true);
  assert.match(r.reason, /autocomplete hint/);
});

test('detectCredentialField: isSecret for a CVV field label', () => {
  const r = detectCredentialField(call('browser', { op: 'fill', fieldLabel: 'CVV' }));
  assert.equal(r.isSecret, true);
});

test('detectCredentialField: a normal field (label "To") is NOT secret', () => {
  const r = detectCredentialField(call('peekaboo', { op: 'type', fieldLabel: 'To' }));
  assert.equal(r.isSecret, false);
  assert.equal(r.reason, '');
});

test('detectCredentialField: a non-type op (click) is never fenced', () => {
  const r = detectCredentialField(call('peekaboo', { op: 'click', fieldLabel: 'Password' }));
  assert.equal(r.isSecret, false, 'the fence only applies to type/fill ops');
});

test('detectCredentialField: a non-peekaboo/browser tool is out of fence scope', () => {
  const r = detectCredentialField(call('mail', { op: 'type', fieldLabel: 'Password' }));
  assert.equal(r.isSecret, false, 'only peekaboo/browser tools synthesize keystrokes');
});
