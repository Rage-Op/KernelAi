/** browser.ts — the live browser pane: renders the CDP screencast streamed from the daemon. */
import { byId } from '../dom.js';
import type { State, Store } from '../store.js';

export function mountBrowser(store: Store): void {
  const img = byId<HTMLImageElement>('browser-img');
  const idle = byId('browser-idle');
  const urlEl = byId('browser-url');
  const dot = byId('browser-dot');

  const render = (s: State): void => {
    const f = s.browser.frame;
    if (f) {
      img.src = `data:image/jpeg;base64,${f.dataB64}`;
      img.classList.remove('hidden');
      idle.classList.add('hidden');
    } else {
      img.classList.add('hidden');
      idle.classList.remove('hidden');
    }
    urlEl.textContent = s.browser.url || 'No page loaded';
    dot.classList.toggle('live', s.browser.active);
  };
  store.subscribe(render);
  render(store.state);
}
