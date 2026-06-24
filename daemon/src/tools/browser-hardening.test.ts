/**
 * browser-hardening.test.ts (WS-C) — the reliability hardening for finance/automation flows:
 * navigation retry/backoff, the host allowlist (egress control), and 2FA/CAPTCHA detection. These
 * run with NO real browser (pure helpers + a mock page), complementing the file://-fixture lane.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserContext } from 'playwright';

import { hostAllowed, detectChallenge, navigate, __setContextForTest } from './browser.js';

test('hostAllowed: empty/absent allowlist allows everything; present allowlist gates by host', () => {
  assert.equal(hostAllowed('https://secure.chase.com/login'), true, 'no allowlist → allow');
  assert.equal(hostAllowed('https://secure.chase.com/login', ['chase.com']), true, 'host substring match');
  assert.equal(hostAllowed('https://evil.example/login', ['chase.com']), false, 'off-allowlist denied');
  assert.equal(hostAllowed('not a url', ['chase.com']), false, 'malformed url denied');
});

test('detectChallenge: classifies CAPTCHA and 2FA walls, else null', () => {
  assert.equal(detectChallenge('Please complete the reCAPTCHA to continue'), 'captcha');
  assert.equal(detectChallenge("Verify you're human before proceeding"), 'captcha');
  assert.equal(detectChallenge('Enter the verification code we sent to your phone'), '2fa');
  assert.equal(detectChallenge('Open your authenticator app and enter the 6-digit code'), '2fa');
  assert.equal(detectChallenge('Welcome back — here is your account summary'), null);
});

test('navigate retries a transient goto failure with backoff, then succeeds', async () => {
  let attempts = 0;
  const mockPage = {
    async goto(): Promise<void> {
      attempts += 1;
      if (attempts < 3) throw new Error('net::ERR_TIMED_OUT'); // transient blip twice
    },
    url(): string {
      return 'https://example.com';
    },
  };
  const mockCtx = { pages: () => [mockPage] } as unknown as BrowserContext;
  __setContextForTest(mockCtx);

  await navigate('https://example.com', 'self', 50); // small per-try timeout
  assert.equal(attempts, 3, 'failed twice, recovered on the third attempt (retry+backoff)');

  __setContextForTest(null);
});

test('navigate gives up after exhausting retries (a real failure still throws)', async () => {
  const mockPage = {
    async goto(): Promise<void> {
      throw new Error('net::ERR_NAME_NOT_RESOLVED');
    },
    url: () => 'https://nope.invalid',
  };
  __setContextForTest({ pages: () => [mockPage] } as unknown as BrowserContext);

  await assert.rejects(() => navigate('https://nope.invalid', 'self', 20), /ERR_NAME_NOT_RESOLVED/);

  __setContextForTest(null);
});
