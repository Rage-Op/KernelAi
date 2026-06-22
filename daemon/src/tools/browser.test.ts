/**
 * browser.test.ts — the Playwright browser adapter unit lane (HANDS-03 + HANDS-05).
 *
 * Validation split (RESEARCH.md Validation Architecture / 02-VALIDATION.md "Playwright headful
 * end-to-end" — unit lane): navigate / scrape / fill run against a LOCAL `file://` fixture page —
 * NO live network. The dedicated-profile-dir assertion and the credential fence run with NO browser
 * at all. A real SITE login + scrape + form-fill end-to-end is the documented MANUAL OWNER CHECK
 * (needs live network + credentials) — it gates the phase, not this plan.
 *
 * Every browser-driving assertion goes THROUGH `registry.dispatch` (not by calling `execute`
 * directly) so the gate path — and the credential fence — is exercised. The fence-signal surfacing
 * runs inside dispatch (the `surfaceSignals` hook) BEFORE the gate, so a `type="password"` field is
 * DENIED before any keystroke.
 *
 * The live-Chromium tests are gated behind a capability check: if `npx playwright install chromium`
 * has not run, the browser binary is absent and those tests SKIP with a clear message (CI without
 * the binary still passes the non-browser assertions — profile dir + fence-signal surfacing).
 *
 * Covered behaviors (plan Task 3 <behavior>):
 *   - Profile dir: PROFILE_DIR resolves under ~/Library/Application Support/Kernel/browser-profile/
 *     and never contains a real-Chrome `User Data` path nor `kernel-memory/`.
 *   - Navigation logging: navigating the fixture emits a log line carrying full url + provenance +
 *     tool:'browser' (captured via a logger spy).
 *   - Scrape tagging: scraping a text node returns ToolResult.data tagged source:'external'.
 *   - Fence (HANDS-05): a `fill` into the Password field is DENIED (the adapter surfaces
 *     type=password / current-password) and the field is NOT filled.
 *   - Allowed fill: a `fill` into the Email field fills the normal field (non-secret → allow).
 *   - Locators: scrape/fill use getByRole/getByLabel/text, not raw CSS (the role/label API is used).
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { dispatch, register, clearRegistry } from './registry.js';
import {
  browserTool,
  navigate,
  PROFILE_DIR,
  __setContextForTest,
  __resetForTest,
} from './browser.js';
import { logger } from '../memory/log.js';

// --- fixture path (file:// URL built from this test file's dir) ---
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/tools/browser.test.ts → daemon root is two levels up → test/fixtures/login-form.html
const FIXTURE_PATH = path.resolve(__dirname, '..', '..', 'test', 'fixtures', 'login-form.html');
const FIXTURE_URL = pathToFileURL(FIXTURE_PATH).href;

// --- logger spy: capture pino `info` calls without losing the real output ---
type LogCall = { obj: Record<string, unknown>; msg?: string };
const logCalls: LogCall[] = [];
let realInfo: typeof logger.info;

function startLogSpy(): void {
  logCalls.length = 0;
  realInfo = logger.info.bind(logger);
  // pino's info signature is (obj, msg?) | (msg). We only assert the (obj, msg) shape used by navigate.
  (logger as unknown as { info: (...a: unknown[]) => void }).info = (...args: unknown[]) => {
    const [first, second] = args;
    if (first && typeof first === 'object') {
      logCalls.push({ obj: first as Record<string, unknown>, msg: typeof second === 'string' ? second : undefined });
    }
    return (realInfo as unknown as (...a: unknown[]) => void)(...args);
  };
}

function stopLogSpy(): void {
  if (realInfo) (logger as unknown as { info: typeof logger.info }).info = realInfo;
}

// --- live-Chromium capability check: launch a headless context against a temp profile dir ---
// (We do NOT launch the adapter's real headful PROFILE_DIR in tests; we inject a headless context
//  via __setContextForTest so the file:// fixture drives without opening the owner's dedicated
//  profile. If the binary is missing, hasBrowser stays false and the live tests skip cleanly.)
let hasBrowser = false;
let tempProfile = '';

before(async () => {
  try {
    const { chromium } = await import('playwright');
    tempProfile = path.join(os.tmpdir(), `kernel-browser-test-${process.pid}-${Date.now()}`);
    const ctx = await chromium.launchPersistentContext(tempProfile, { headless: true });
    __setContextForTest(ctx);
    hasBrowser = true;
  } catch {
    hasBrowser = false; // binary not installed (npx playwright install chromium not run) → skip live tests
  }
});

after(async () => {
  await __resetForTest();
});

beforeEach(() => {
  // Deterministic registry: importing browser.js self-registers, but clearRegistry wipes it.
  clearRegistry();
  register(browserTool);
});

const skipMsg =
  'Chromium binary not installed — run `npx playwright install chromium` from daemon/ (live browser tests skipped)';

// ------------------------------------------------------------------------------------------------
// No-browser assertions (always run — profile dir + the constant shape).
// ------------------------------------------------------------------------------------------------

test('browser: PROFILE_DIR is the DEDICATED app-support profile, never the real Chrome profile', () => {
  // dedicated dir under app-support
  assert.ok(
    PROFILE_DIR.includes(path.join('Library', 'Application Support', 'Kernel', 'browser-profile')),
    'PROFILE_DIR points at the dedicated Kernel browser-profile dir',
  );
  assert.ok(PROFILE_DIR.startsWith(os.homedir()), 'PROFILE_DIR is under the user home');
  // never the real Chrome profile
  assert.ok(!/Google\/Chrome/i.test(PROFILE_DIR), 'PROFILE_DIR is not the real Chrome profile');
  assert.ok(!/User Data/i.test(PROFILE_DIR), 'PROFILE_DIR is not a Chrome "User Data" path');
  // outside kernel-memory/ — the GitHub backup must never touch live session cookies (ASVS V12)
  assert.ok(!/kernel-memory/.test(PROFILE_DIR), 'PROFILE_DIR is outside kernel-memory/');
});

// ------------------------------------------------------------------------------------------------
// Live-Chromium assertions against the file:// fixture (skip cleanly if the binary is absent).
// ------------------------------------------------------------------------------------------------

test('browser: every navigation logs full URL + provenance + tool:browser', async (t) => {
  if (!hasBrowser) return t.skip(skipMsg);
  startLogSpy();
  try {
    await navigate(FIXTURE_URL, 'self');
  } finally {
    stopLogSpy();
  }
  const navLog = logCalls.find((c) => c.obj.tool === 'browser' && c.obj.url === FIXTURE_URL);
  assert.ok(navLog, 'a navigation log line carrying the full file:// url was emitted');
  assert.equal(navLog?.obj.provenance, 'self', 'the provenance tag is logged');
  assert.equal(navLog?.msg, 'browser: navigate', 'the egress log message is the navigate seam');
});

test('browser: scrape returns content tagged source:external (Provenance shape)', async (t) => {
  if (!hasBrowser) return t.skip(skipMsg);
  await dispatch({ tool: 'browser', args: { op: 'navigate', url: FIXTURE_URL, provenance: 'self' } });

  // role-based locator (getByRole('heading')) — never raw CSS (RESEARCH.md Pitfall 15).
  const result = await dispatch({ tool: 'browser', args: { op: 'scrape', role: 'heading' } });

  assert.equal(result.ok, true, 'scrape succeeds');
  const data = result.data as { source?: string; text?: string; origin?: string };
  assert.equal(data.source, 'external', 'scraped web content is external-sourced (tainted at the read site)');
  assert.match(data.text ?? '', /Sign in to Example/, 'the scraped heading text is carried in the ContextItem');
  assert.match(data.origin ?? '', /^browser:/, 'origin records the read source URL');
});

test('browser: FENCE (HANDS-05) — a fill into the Password field is DENIED and never typed', async (t) => {
  if (!hasBrowser) return t.skip(skipMsg);
  await dispatch({ tool: 'browser', args: { op: 'navigate', url: FIXTURE_URL, provenance: 'self' } });

  // getByLabel('Password') → the adapter surfaces type=password / current-password BEFORE the gate.
  const result = await dispatch({ tool: 'browser', args: { op: 'fill', label: 'Password', text: 'hunter2' } });

  assert.equal(result.ok, false, 'the secure password field is refused by the gate');
  assert.match(
    result.escalation?.reason ?? '',
    /secure\/credential field/,
    'the credential-fence escalation is surfaced',
  );

  // The field must NOT have been filled — re-read its value via a role/label locator.
  const pageValue = await readInputValue('Password');
  assert.equal(pageValue, '', 'the password field is still empty — no keystroke was synthesized');
});

test('browser: an allowed fill — the Email field is filled (non-secret passes the fence)', async (t) => {
  if (!hasBrowser) return t.skip(skipMsg);
  await dispatch({ tool: 'browser', args: { op: 'navigate', url: FIXTURE_URL, provenance: 'self' } });

  // getByLabel('Email') — a normal field; the fence allows; .fill() types via the label locator.
  const result = await dispatch({
    tool: 'browser',
    args: { op: 'fill', label: 'Email', text: 'alice@example.com' },
  });

  assert.equal(result.ok, true, 'a non-secret field passes the fence (Yellow → allow)');
  const value = await readInputValue('Email');
  assert.equal(value, 'alice@example.com', 'the email field reflects the typed value');
});

/**
 * Read an input's current value by its accessible label, through the injected context's page —
 * role/label-based, not raw CSS — used to assert "filled / not filled" from the live DOM.
 */
async function readInputValue(label: string): Promise<string> {
  const { __getPageForTest } = await import('./browser.js');
  const p = await __getPageForTest();
  return p.getByLabel(label).inputValue();
}
