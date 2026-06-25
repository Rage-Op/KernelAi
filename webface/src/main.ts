/**
 * main.ts — entry point. Connects the transport, builds the store, mounts the views, and wires the
 * boot gate + nav rail. The browser screencast is subscribed only while the Browser pane is open
 * (browser.view frames), so the daemon streams JPEGs only when someone is watching.
 */
import { connect } from './transport.js';
import { Store } from './store.js';
import { byId } from './dom.js';
import { mountHeader } from './views/header.js';
import { mountChat } from './views/chat.js';
import { mountBrowser } from './views/browser.js';
import { mountSettings } from './views/settings.js';
import type { State } from './store.js';

const store = new Store();
const transport = connect();

transport.onFrame((f) => store.applyFrame(f));

let askedHistory = false;
let everConnected = false;
transport.onStatus((connected) => {
  store.setConnected(connected);
  byId('rail-conn').classList.toggle('is-on', connected);
  if (!connected) return;
  if (!askedHistory) {
    askedHistory = true;
    transport.send({ type: 'history.request', id: 'hist', limit: 200 });
  }
  transport.send({ type: 'service.list', id: 'svc' }); // refresh the services panel each (re)connect
  transport.send({ type: 'lmstudio.list', id: 'lms' }); // and the LM Studio models panel
  if (everConnected) {
    // RECONNECT: the new server-side conn lost our per-conn state. Re-assert the screencast intent if the
    // Browser pane is open, and close out any turn orphaned by the drop (its deltas went to the dead conn).
    if (browserStreaming) transport.send({ type: 'browser.view', streaming: true });
    store.finalizeStuckTurns();
  }
  everConnected = true;
});

// --- Views ---
mountHeader(store);
mountChat(store, (f) => transport.send(f));
mountBrowser(store);
mountSettings(store, (f) => transport.send(f));

// --- Boot gate ---
let revealed = false;
function reveal(): void {
  if (revealed) return;
  revealed = true;
  byId('boot').classList.add('hidden');
  byId('app').classList.remove('hidden');
}
function bootRender(s: State): void {
  if (s.model.status === 'ready') { reveal(); return; }
  const status = byId('boot-status');
  const detail = byId('boot-detail');
  if (!s.connected) status.textContent = 'Connecting to the daemon…';
  else if (s.model.status === 'loading') status.textContent = s.model.model ? `Warming ${s.model.model}…` : 'Warming the model…';
  else if (s.model.status === 'error') status.textContent = 'The model isn’t ready.';
  if (s.model.status === 'error' && s.model.detail) {
    if (!detail.querySelector('button')) {
      // First error: set the text, then append the button ONCE.
      detail.textContent = s.model.detail;
      const btn = document.createElement('button');
      btn.className = 's-btn';
      btn.textContent = 'Continue anyway';
      btn.style.marginTop = '12px';
      btn.style.display = 'block';
      btn.addEventListener('click', reveal);
      detail.appendChild(document.createElement('br'));
      detail.appendChild(btn);
    } else {
      // Subsequent error frames: update ONLY the text node, keep the single button (no restack).
      const first = detail.firstChild;
      if (first && first.nodeType === Node.TEXT_NODE) first.textContent = s.model.detail;
    }
  }
}
store.subscribe(bootRender);
bootRender(store.state);

// --- Nav rail ---
const VIEWS = ['chat', 'browser', 'settings'] as const;
type ViewName = (typeof VIEWS)[number];
let browserStreaming = false;

function showView(name: ViewName): void {
  for (const v of VIEWS) {
    byId('view-' + v).classList.toggle('hidden', v !== name);
  }
  document.querySelectorAll<HTMLElement>('.rail-tab').forEach((tab) => {
    tab.classList.toggle('is-active', tab.dataset.view === name);
  });
  // Subscribe/unsubscribe the screencast as the Browser pane opens/closes (saves CPU).
  const wantStream = name === 'browser';
  if (wantStream !== browserStreaming) {
    browserStreaming = wantStream;
    transport.send({ type: 'browser.view', streaming: wantStream });
  }
  if (name === 'chat') byId<HTMLTextAreaElement>('composer-input').focus();
  if (name === 'settings') {
    transport.send({ type: 'service.list', id: 'svc' }); // fresh status when opened
    transport.send({ type: 'lmstudio.list', id: 'lms' }); // fresh LM Studio model list when opened
  }
}

document.querySelectorAll<HTMLElement>('.rail-tab').forEach((tab) => {
  tab.addEventListener('click', () => showView((tab.dataset.view as ViewName) ?? 'chat'));
});
