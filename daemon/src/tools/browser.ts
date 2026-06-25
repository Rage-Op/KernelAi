/**
 * tools/browser.ts — the Playwright headful browser hand (HANDS-03), RESEARCH.md Pattern 4.
 *
 * KERNEL gains a web hand by driving ONE headful Chromium opened via
 * `chromium.launchPersistentContext` against a DEDICATED profile dir — NEVER the user's real
 * Chrome profile (FORBIDDEN: Chrome policy breaks it AND it risks the owner's live cookies). The
 * Chromium browser BINARY is downloaded out-of-repo by `npx playwright install chromium`; it is
 * NOT an npm dependency — the only npm dependency this lands is `playwright@1.61.0`.
 *
 * Load-bearing invariants (all enforced here, all in RESEARCH.md):
 *   - DEDICATED PROFILE DIR: `~/Library/Application Support/Kernel/browser-profile/` — outside
 *     `kernel-memory/` so the GitHub backup never touches live session cookies (ASVS V12). Never
 *     points at the owner's real Chrome profile (forbidden: Chrome policy breaks it and it risks
 *     the owner's live cookies).
 *   - ONE persistent context reused across calls (RESEARCH.md Pitfall 8: 16GB ceiling — never
 *     respawn a context per dispatch). Lazily launched, cached at module scope.
 *   - HEADFUL, PLAIN CHROMIUM: `headless: false`, no evasion plugins (forbidden: a headless
 *     evasion-plugin combo — brittle and invites login-grinding).
 *   - EVERY navigation logs the FULL URL + provenance: `logger.info({ tool:'browser', url,
 *     provenance }, ...)` before every `page.goto` (HANDS-03 acceptance, RESEARCH.md Pitfall 5 —
 *     the egress-logging seam lands here).
 *   - Scraped page content is tagged `source:'external'` at the READ site (Phase-1
 *     `ContextItem`/`Provenance` — untrusted, web-sourced content).
 *   - Locators are role/label/text (`getByRole`/`getByLabel`/`getByText`), NOT brittle CSS or
 *     coordinates (RESEARCH.md Pitfall 15).
 *   - For the `fill` op, the adapter SURFACES the DOM credential signals (`type`/`autocomplete`/
 *     accessible label → `fieldType`/`autocomplete`/`fieldLabel`/`isSecureField`) into
 *     `ToolCall.args` at the READ site so the credential fence in `gate.authorize` (02-01) can
 *     classify and REFUSE secrets BEFORE `.fill()` types a single character (HANDS-05). The
 *     adapter does NOT decide to refuse — refusal is the gate's job; the adapter populating these
 *     fields IS the fence's data source.
 *   - On any Playwright failure (navigation timeout, missing browser binary, locator not found)
 *     the adapter CATCHES and returns a structured `{ ok:false, escalation }` — it NEVER crashes
 *     the loop.
 *
 * ANTI-BYPASS: `browserTool.execute` is only ever reached via `registry.dispatch` (after the
 * gate). Importing this module self-registers the tool (module-init side effect); nothing calls
 * `execute` directly except the registry.
 */
import os from 'node:os';
import path from 'node:path';

import { chromium, type BrowserContext, type Page, type Locator } from 'playwright';
import { z } from 'zod';

import { register } from './registry.js';
import type { Tool, ToolResult } from './Tool.js';
import type { ContextItem, Provenance } from '../memory/types.js';
import { logger } from '../memory/log.js';

/**
 * The DEDICATED Chromium profile dir (RESEARCH.md Runtime State Inventory). Lives under macOS
 * app-support, OUTSIDE `kernel-memory/`, so live session cookies are never committed or backed up
 * (ASVS V12). This is a brand-new profile, NEVER the owner's real Chrome profile.
 */
export const PROFILE_DIR = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Kernel',
  'browser-profile',
);

/** The ONE persistent context (RESEARCH.md Pitfall 8: reuse across calls, never respawn per dispatch). */
let ctx: BrowserContext | null = null;

/**
 * Optional observer notified with the live page whenever KERNEL navigates (browser-view.ts attaches the
 * CDP screencast here). Decoupled via a setter so browser.ts never imports the view/IPC layer — no cycle.
 * Best-effort: a throwing hook is swallowed so it can never break a navigation.
 */
let pageReadyHook: ((p: Page) => void) | null = null;
export function setPageReadyHook(fn: ((p: Page) => void) | null): void {
  pageReadyHook = fn;
}

// ─── WS-C hardening knobs ────────────────────────────────────────────────────
/** Default navigation timeout — generous for slow-loading finance SPAs (was an implicit short one). */
const DEFAULT_NAV_TIMEOUT_MS = 10_000;
/** Retries for a transient navigation failure (network blip), with exponential backoff. */
const MAX_NAV_RETRIES = 3;
/** Timeout for surfacing a fill target's DOM signals to the credential fence. */
const FILL_SIGNAL_TIMEOUT_MS = 2_000;

/**
 * Is `url`'s host permitted by the optional allowlist? An empty/absent allowlist allows everything
 * (backward-compatible); when present, the host must contain one of the entries (substring match on
 * the host, so "chase.com" matches "secure.chase.com"). A malformed URL is denied.
 */
export function hostAllowed(url: string, allow?: string[]): boolean {
  if (!allow || allow.length === 0) return true;
  try {
    const host = new URL(url).host.toLowerCase();
    return allow.some((a) => host.includes(a.toLowerCase()));
  } catch {
    return false;
  }
}

/**
 * Classify a 2FA / CAPTCHA wall from page text so KERNEL STOPS and hands off to the owner instead
 * of blindly proceeding past an auth challenge. Pure (testable) — the page-reading wrapper is below.
 */
export function detectChallenge(text: string): '2fa' | 'captcha' | null {
  if (/recaptcha|hcaptcha|\bcaptcha\b|not a robot|verify (you('| a)?re|that you are) human/i.test(text)) {
    return 'captcha';
  }
  if (/two[- ]?factor|\b2fa\b|verification code|one[- ]?time (code|password|passcode)|\botp\b|authenticator app|enter the code (we|that was)? ?sent/i.test(text)) {
    return '2fa';
  }
  return null;
}

/** Navigate with exponential backoff so a transient network blip retries instead of escalating. */
async function gotoWithRetry(p: Page, url: string, timeoutMs: number): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_NAV_RETRIES; attempt++) {
    try {
      await p.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_NAV_RETRIES) {
        const backoff = 100 * 2 ** attempt; // 100 → 200 → 400 ms
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
  throw lastErr;
}

/** Read the live page's visible text and classify any 2FA/CAPTCHA challenge (best-effort). */
async function detectChallengeOnPage(p: Page): Promise<'2fa' | 'captcha' | null> {
  try {
    const text = (await p.locator('body').first().textContent({ timeout: 1500 })) ?? '';
    return detectChallenge(text);
  } catch {
    return null;
  }
}

/**
 * Lazily launch ONE headful Chromium against the dedicated profile dir and cache the context.
 * Subsequent calls reuse the cached context. Headful, plain Chromium (no evasion plugins).
 */
async function context(): Promise<BrowserContext> {
  if (ctx) return ctx;
  ctx = await chromium.launchPersistentContext(PROFILE_DIR, { headless: false });
  return ctx;
}

/** Get the single live page (reuse the first one the persistent context opens, else create one). */
async function page(): Promise<Page> {
  const c = await context();
  const existing = c.pages();
  return existing.length > 0 ? existing[0] : c.newPage();
}

/**
 * The live page IFF a context is already launched — never launches one. Used by the screencast view to
 * attach to a page that exists (so opening the web Browser pane doesn't pop a blank headful window).
 */
export function livePageOrNull(): Page | null {
  if (!ctx) return null;
  const pages = ctx.pages();
  return pages.length > 0 ? pages[0] : null;
}

/** Ensure a page exists (launching the persistent context if needed). Exposed for the screencast view. */
export async function ensurePage(): Promise<Page> {
  return page();
}

/** Close the live Chromium context (the "stop browser" service action). Idempotent; best-effort. */
export async function closeBrowser(): Promise<void> {
  if (!ctx) return;
  const c = ctx;
  ctx = null;
  try {
    await c.close();
  } catch {
    /* already gone */
  }
}

/** TEST-ONLY seam: inject a pre-built context (e.g. a real headless Chromium) so the unit lane
 *  can drive a `file://` fixture without launching the dedicated headful profile. */
export function __setContextForTest(mock: BrowserContext | null): void {
  ctx = mock;
}

/** TEST-ONLY seam: expose the single live page so a test can read an input's value (role/label),
 *  asserting "filled / not filled" from the live DOM without re-implementing locator logic. */
export async function __getPageForTest(): Promise<Page> {
  return page();
}

/** TEST-ONLY: close + clear the cached context between test files so each starts clean. */
export async function __resetForTest(): Promise<void> {
  if (ctx) {
    try {
      await ctx.close();
    } catch {
      /* best-effort */
    }
  }
  ctx = null;
}

/**
 * Navigate to `url`, logging the FULL URL + provenance on EVERY goto (HANDS-03 acceptance —
 * the egress-logging seam). Exported so the egress log point is independently testable.
 */
export async function navigate(
  url: string,
  provenance: Provenance,
  timeoutMs: number = DEFAULT_NAV_TIMEOUT_MS,
): Promise<Page> {
  const p = await page();
  // EVERY navigation logs the full URL + provenance BEFORE the goto (RESEARCH.md Pitfall 5).
  logger.info({ tool: 'browser', url, provenance }, 'browser: navigate');
  await gotoWithRetry(p, url, timeoutMs); // transient blips retry with backoff; a real failure throws.
  // Notify the screencast view (if attached) that a live page is ready — so opening the web Browser
  // pane mid-task, or KERNEL navigating while a viewer watches, attaches the CDP stream. Best-effort.
  try {
    pageReadyHook?.(p);
  } catch {
    /* a hook must never break navigation */
  }
  return p;
}

/**
 * Resolve a role/label/text locator from the fill/scrape args (RESEARCH.md Pitfall 15 — role/label,
 * never brittle CSS). Precedence: explicit `role`(+`name`) → `label` → `text`.
 */
function locate(p: Page, args: Record<string, unknown>): Locator {
  const role = typeof args.role === 'string' ? args.role : undefined;
  const label = typeof args.label === 'string' ? args.label : undefined;
  const text = typeof args.text_selector === 'string' ? args.text_selector : undefined;
  const name = typeof args.name === 'string' ? args.name : undefined;

  if (role) {
    // getByRole with an optional accessible-name filter (role+name is the most robust locator).
    return name
      ? p.getByRole(role as Parameters<Page['getByRole']>[0], { name })
      : p.getByRole(role as Parameters<Page['getByRole']>[0]);
  }
  if (label) return p.getByLabel(label);
  if (text) return p.getByText(text);
  // default-deny on an unlocatable target: an empty body that yields zero elements (never CSS).
  return p.locator('__kernel_no_locator__');
}

/** Tag external-sourced web content with the Phase-1 provenance shape (tainted at the read site). */
function asExternal(url: string, data: unknown): ContextItem {
  return {
    text: typeof data === 'string' ? data : JSON.stringify(data),
    source: 'external',
    origin: `browser:${url}`,
  };
}

/**
 * The high-level browser op envelope. `op` is constrained tightly (so the gate can classify a
 * known op); locator + fence-signal fields are optional. The fence-signal fields
 * (`fieldType`/`autocomplete`/`fieldLabel`/`isSecureField`) are populated BY THE ADAPTER from the
 * DOM for a `fill`; they are declared here so they validate, but the adapter overwrites whatever
 * the brain sends with the live DOM truth (the adapter, not the brain, is the fence's data source).
 */
export const browserArgsSchema = z
  .object({
    op: z.enum(['navigate', 'scrape', 'fill']),
    url: z.string().optional(),
    provenance: z.enum(['user', 'self', 'external']).optional(),
    // locator (role/label/text — never CSS)
    role: z.string().optional(),
    name: z.string().optional(),
    label: z.string().optional(),
    text_selector: z.string().optional(),
    // value to type (fill)
    text: z.string().optional(),
    // WS-C hardening: per-call navigation timeout (ms) + an optional host allowlist (egress control)
    timeout_ms: z.number().optional(),
    allow: z.array(z.string()).optional(),
    // fence signals — surfaced by the adapter from the DOM for the fill op (HANDS-05)
    fieldType: z.string().optional(),
    autocomplete: z.string().optional(),
    fieldLabel: z.string().optional(),
    isSecureField: z.boolean().optional(),
  })
  .passthrough();

/**
 * The registered browser `Tool` (the 02-01 contract). `execute` switches on `args.op`. NEVER call
 * this outside the registry — `registry.dispatch` runs `gate.authorize` (and the credential fence)
 * FIRST. For the `fill` op the fence runs INSIDE dispatch BEFORE execute, so the adapter surfaces
 * the DOM signals into `call.args` at the read site (the SURFACE_FILL_SIGNALS step in dispatch's
 * pre-execute pass — see `surfaceFillSignals` below, invoked by the registry path).
 */
export const browserTool: Tool = {
  name: 'browser',
  schema: browserArgsSchema,
  // HANDS-05: the registry runs this BEFORE the gate, so the fence sees the live DOM truth.
  surfaceSignals: surfaceFillSignals,
  async execute(args): Promise<ToolResult> {
    const op = String(args.op);

    try {
      switch (op) {
        case 'navigate': {
          const url = String(args.url ?? '');
          if (!url) return { ok: false, escalation: { reason: 'browser navigate: no url' } };
          // EGRESS CONTROL (WS-C): if an allowlist is supplied, the host must be on it.
          const allow = Array.isArray(args.allow) ? (args.allow as unknown[]).map(String) : undefined;
          if (!hostAllowed(url, allow)) {
            return {
              ok: false,
              escalation: {
                reason: `browser navigate blocked: ${url} is not in the allowlist`,
                recommendation: 'Add the host to `allow`, or omit `allow` to permit any host.',
              },
            };
          }
          const provenance = (args.provenance as Provenance) ?? 'self';
          const timeoutMs = typeof args.timeout_ms === 'number' ? args.timeout_ms : DEFAULT_NAV_TIMEOUT_MS;
          const p = await navigate(url, provenance, timeoutMs);
          // 2FA / CAPTCHA HANDOFF (WS-C): don't blunder past an auth wall — stop and hand off to the
          // owner in the visible headful window.
          const challenge = await detectChallengeOnPage(p);
          if (challenge) {
            return {
              ok: false,
              escalation: {
                reason: `browser navigate: a ${challenge} challenge is on the page (${url})`,
                recommendation: `Complete the ${challenge} in the Kernel browser window, then retry.`,
              },
            };
          }
          return { ok: true, data: { navigated: url } };
        }

        case 'scrape': {
          const p = await page();
          // role/label/text locator — never brittle CSS (RESEARCH.md Pitfall 15).
          const loc = locate(p, args);
          // DIAGNOSTIC (WS-C): a zero-element locator means the page layout changed (or no locator
          // was given) — escalate with a page-text snippet instead of silently returning empty.
          if ((await loc.count()) === 0) {
            const pageText = ((await p.locator('body').first().textContent().catch(() => '')) ?? '')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 200);
            return {
              ok: false,
              escalation: {
                reason: 'browser scrape: locator matched 0 elements — the page layout may have changed',
                recommendation: pageText ? `Page begins: "${pageText}…"` : 'The page appears empty.',
              },
            };
          }
          const content = await loc.first().textContent();
          const url = p.url();
          // External-sourced web read — tainted at the READ site (Phase-1 Provenance).
          return { ok: true, data: asExternal(url, content ?? '') };
        }

        case 'fill': {
          const p = await page();
          const loc = locate(p, args).first();
          // The fence already ran inside dispatch (on the surfaced signals). Reaching here means
          // it ALLOWED — so this is a non-secret field. Type via the role/label locator's .fill().
          await loc.fill(String(args.text ?? ''));
          return { ok: true, data: { filled: true } };
        }

        default:
          return { ok: false, escalation: { reason: `unsupported browser op: ${op}` } };
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ tool: 'browser', op, reason }, 'browser: op failed — escalating');
      return {
        ok: false,
        escalation: {
          reason: `browser ${op} failed: ${reason}`,
          recommendation:
            'Confirm Chromium is installed (run `npx playwright install chromium` from daemon/) ' +
            'and that the target page/element is reachable, then retry.',
        },
      };
    }
  },
};

/**
 * Read the DOM credential signals for a `fill` target and surface them into `call.args` at the
 * READ site (HANDS-05). MUST be called BEFORE the gate authorizes a `fill`, so the fence in
 * `gate.authorize` (02-01) classifies the LIVE DOM truth (`type="password"`, sensitive
 * `autocomplete`, or a secret-matching accessible label) and DENIES before `.fill()` runs.
 *
 * This is the browser analogue of Peekaboo surfacing AX secure-field signals: the adapter is the
 * fence's data source; it does NOT decide refusal. The registry dispatch path invokes this for any
 * `browser` `fill` call before `authorize`.
 */
export async function surfaceFillSignals(args: Record<string, unknown>): Promise<void> {
  if (String(args.op) !== 'fill') return;
  let p: Page;
  try {
    p = await page();
  } catch {
    return; // no live page yet — nothing to surface; the gate sees whatever was passed.
  }
  try {
    const loc = locate(p, args).first();
    // DOM secure-field signals, read straight from the element.
    const handle = await loc.elementHandle({ timeout: FILL_SIGNAL_TIMEOUT_MS });
    if (!handle) return;
    const [type, autocomplete] = await Promise.all([
      handle.getAttribute('type'),
      handle.getAttribute('autocomplete'),
    ]);
    // The accessible label (aria-label / associated <label>) drives the fence's label regex.
    const ariaLabel = await handle.getAttribute('aria-label');
    const labelText = typeof args.label === 'string' ? args.label : ariaLabel ?? '';

    if (type) args.fieldType = type;
    if (autocomplete) args.autocomplete = autocomplete;
    if (labelText) args.fieldLabel = labelText;
    // A DOM type=password IS a secure field — surface the hard signal the fence checks first.
    if (type && type.toLowerCase() === 'password') args.isSecureField = true;
  } catch {
    // best-effort: a missing element means the fill will fail at execute and escalate cleanly.
  }
}

// Module-init side effect: importing this tool wires it into the router (HANDS-04).
register(browserTool);
