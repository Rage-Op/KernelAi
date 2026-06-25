/**
 * server.browser.test.ts — the live-browser screencast is TARGETED: only web clients that opted in via a
 * `browser.view{streaming:true}` frame receive `browser.frame`s; the Mac Face (UDS) never does. This is
 * the no-Face-leakage + CPU-saving invariant from the review.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  addClient,
  removeClient,
  broadcastBrowser,
  anyBrowserViewers,
  defaultFrameHandler,
  type ClientConn,
} from './server.js';
import type { Frame } from './protocol.js';

function mkConn(kind: 'web' | 'uds'): ClientConn & { sent: Frame[] } {
  const sent: Frame[] = [];
  return { kind, sent, send: (f: Frame) => sent.push(f) };
}

test('browser screencast targeting: only opted-in web clients receive browser.frame', () => {
  const web = mkConn('web');
  const uds = mkConn('uds');
  addClient(web);
  addClient(uds);

  // No viewers yet.
  assert.equal(anyBrowserViewers(), false);
  assert.equal(broadcastBrowser({ type: 'browser.frame', dataB64: 'AAA', url: 'http://x', width: 8, height: 8 }), 0);

  // The web client opens its Browser pane → browser.view{streaming:true}.
  defaultFrameHandler({ type: 'browser.view', streaming: true }, web);
  assert.equal(web.wantsBrowser, true);
  assert.equal(anyBrowserViewers(), true);

  const frame: Frame = { type: 'browser.frame', dataB64: 'AAA', url: 'http://x', width: 8, height: 8 };
  assert.equal(broadcastBrowser(frame), 1, 'one viewer reached');
  assert.equal(web.sent.filter((f) => f.type === 'browser.frame').length, 1);
  assert.equal(uds.sent.filter((f) => f.type === 'browser.frame').length, 0, 'the UDS Face never gets the screencast');

  // The web client closes the pane → browser.view{streaming:false}.
  defaultFrameHandler({ type: 'browser.view', streaming: false }, web);
  assert.equal(anyBrowserViewers(), false);
  assert.equal(broadcastBrowser(frame), 0);

  removeClient(web);
  removeClient(uds);
});
