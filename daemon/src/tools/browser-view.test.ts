/**
 * browser-view.test.ts — the screencast RECONCILER (start iff someone watches; stop otherwise), without
 * launching a real browser. The CDP attach path needs a live Chromium and is covered by the live e2e.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Frame } from '../ipc/protocol.js';
import { configureBrowserView, syncScreencast, __resetBrowserViewForTest } from './browser-view.js';

test('browser-view: reconciles to inactive when there is no live page, and stops when nobody watches', async () => {
  __resetBrowserViewForTest();
  const sent: Frame[] = [];
  let viewers = true;
  configureBrowserView({ broadcast: (f) => sent.push(f), hasViewers: () => viewers });

  // Viewers want it but no browser context exists yet → honest "inactive" state, no launch.
  await syncScreencast();
  assert.ok(
    sent.some((f) => f.type === 'browser.state' && (f as { active?: boolean }).active === false),
    'emits browser.state{active:false} with no live page',
  );

  // Nobody watching → stop reconcile emits inactive again, no throw.
  viewers = false;
  sent.length = 0;
  await syncScreencast();
  assert.ok(sent.some((f) => f.type === 'browser.state'), 'stop path emits a browser.state');

  __resetBrowserViewForTest();
});
