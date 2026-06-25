/**
 * browser-view.ts — stream KERNEL's live Playwright browser into the web Face (the owner's 2nd ask:
 * "when the model uses the browser, can we look at what it's doing?").
 *
 * Chromium stays HEADFUL (browser.ts is unchanged — the real window still handles 2FA/CAPTCHA), and on
 * top of that we attach a CDP `Page.startScreencast` and forward each JPEG frame to web viewers as a
 * `browser.frame`. Delivery is TARGETED (server.broadcastBrowser → only web clients that opened their
 * Browser pane), so the Mac Face never sees it and the heavy stream runs only while someone watches.
 *
 * Decoupling: this module imports ONLY browser.ts (for the live page + the navigation hook). Its push
 * channel and "is anyone watching?" predicate are INJECTED via `configureBrowserView` (wired in
 * index.ts), so there is no browser-view↔server import cycle. `syncScreencast()` is the one reconciler
 * the server calls whenever the viewer set may have changed (a browser.view frame, or a web disconnect).
 */
import type { CDPSession, Page, Frame as PwFrame } from 'playwright';

import type { Frame } from '../ipc/protocol.js';
import { livePageOrNull, setPageReadyHook } from './browser.js';
import { logger } from '../memory/log.js';

// Screencast knobs — capped for the 16GB Mac: modest resolution/quality, skip frames to bound the rate.
const SCREENCAST_OPTS = {
  format: 'jpeg' as const,
  quality: 50,
  maxWidth: 1280,
  maxHeight: 800,
  everyNthFrame: 2,
};

/** Injected push channel (server.broadcastBrowser) and viewer predicate (server.anyBrowserViewers). */
let broadcastFn: ((frame: Frame) => void) | null = null;
let hasViewersFn: (() => boolean) | null = null;

/** Wire the screencast to the IPC layer. Called once at boot (index.ts), after tools are registered. */
export function configureBrowserView(deps: {
  broadcast: (frame: Frame) => void;
  hasViewers: () => boolean;
}): void {
  broadcastFn = deps.broadcast;
  hasViewersFn = deps.hasViewers;
  // Attach to any page KERNEL navigates while a viewer is watching (covers: pane opened before the model
  // has browsed anything → we attach on the first navigation).
  setPageReadyHook((page) => {
    if (running) void attachTo(page);
  });
}

let running = false; // do viewers want the stream?
let cdp: CDPSession | null = null;
let attachedPage: Page | null = null;
let navHandler: ((f: PwFrame) => void) | null = null; // the framenavigated listener we must remove on detach
let attachSeq = 0; // bumped on every detach/attach so an in-flight attach can detect it was superseded
let reconciling: Promise<void> | null = null; // serializes viewer-driven reconciles (one attach/detach at a time)

function emit(frame: Frame): void {
  try {
    broadcastFn?.(frame);
  } catch {
    /* a dead viewer is cleaned up by its own SSE close handler */
  }
}

/**
 * Attach the CDP screencast to a specific page (idempotent per page; race-safe). A sequence token guards
 * against two overlapping attaches (the viewer-driven reconcile vs the navigation pageReadyHook): if a
 * newer detach/attach ran while we awaited newCDPSession, we abandon (and detach) our now-stale session
 * so it can never become an orphaned, unstoppable screencast.
 */
async function attachTo(page: Page): Promise<void> {
  if (attachedPage === page && cdp) return; // already streaming this page
  await detach(); // tear down any prior page's session first (also bumps attachSeq)
  const seq = ++attachSeq; // our token, taken AFTER detach so it reflects the latest intent
  try {
    const session = await page.context().newCDPSession(page);
    if (seq !== attachSeq) {
      // A newer detach/attach superseded us during the await — discard this session, don't leak it.
      try { await session.detach(); } catch { /* best-effort */ }
      return;
    }
    cdp = session;
    attachedPage = page;
    session.on('Page.screencastFrame', (payload) => {
      const meta = payload.metadata as { deviceWidth?: number; deviceHeight?: number } | undefined;
      emit({
        type: 'browser.frame',
        dataB64: payload.data,
        url: safeUrl(page),
        width: meta?.deviceWidth ?? SCREENCAST_OPTS.maxWidth,
        height: meta?.deviceHeight ?? SCREENCAST_OPTS.maxHeight,
      });
      // Ack so Chromium sends the next frame (ack-driven → throttles to the consumer when send() drops).
      session.send('Page.screencastFrameAck', { sessionId: payload.sessionId }).catch(() => {});
    });
    // Surface navigations so the pane can relabel the URL even between screencast frames. Keep the bound
    // handler so detach() can remove it (else it leaks across re-attach on the long-lived persistent page).
    navHandler = (f) => {
      if (f === page.mainFrame()) emit({ type: 'browser.state', active: true, url: safeUrl(page) });
    };
    page.on('framenavigated', navHandler);
    await session.send('Page.startScreencast', SCREENCAST_OPTS);
    emit({ type: 'browser.state', active: true, url: safeUrl(page) });
    logger.info({ tool: 'browser-view', url: safeUrl(page) }, 'browser screencast attached');
  } catch (err) {
    logger.warn(
      { tool: 'browser-view', err: err instanceof Error ? err.message : String(err) },
      'browser screencast attach failed',
    );
    cdp = null;
    attachedPage = null;
  }
}

/** Tear down the current CDP session AND its framenavigated listener (best-effort). Bumps attachSeq. */
async function detach(): Promise<void> {
  attachSeq++; // invalidate any attach awaiting newCDPSession
  const session = cdp;
  const page = attachedPage;
  cdp = null;
  attachedPage = null;
  if (page && navHandler) {
    try { page.off('framenavigated', navHandler); } catch { /* page may be gone */ }
  }
  navHandler = null;
  if (!session) return;
  try {
    await session.send('Page.stopScreencast');
  } catch {
    /* page may be gone */
  }
  try {
    await session.detach();
  } catch {
    /* already detached */
  }
}

function safeUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return '';
  }
}

/**
 * Reconcile the screencast against the live viewer set: start streaming if any web client is watching
 * (and a page exists), stop if nobody is. SERIALIZED — chained on the prior reconcile so two viewer-set
 * changes can't run attach/detach concurrently. Re-checks the desired state after acquiring the turn (so
 * a change during the await isn't lost). Called by the server on every viewer-set change. Never throws.
 */
export function syncScreencast(): Promise<void> {
  const run = (reconciling ?? Promise.resolve()).then(() => reconcileOnce());
  reconciling = run.catch(() => {});
  return run;
}

async function reconcileOnce(): Promise<void> {
  const wanted = hasViewersFn?.() ?? false;
  if (wanted && !running) {
    running = true;
    const page = livePageOrNull();
    if (page) await attachTo(page);
    else emit({ type: 'browser.state', active: false }); // no page yet — attach on first navigation
  } else if (!wanted && running) {
    running = false;
    await detach();
    emit({ type: 'browser.state', active: false });
  }
}

/** TEST-ONLY: reset module state between tests. */
export function __resetBrowserViewForTest(): void {
  running = false;
  cdp = null;
  attachedPage = null;
  navHandler = null;
  attachSeq = 0;
  reconciling = null;
  broadcastFn = null;
  hasViewersFn = null;
  setPageReadyHook(null);
}
