/** header.ts — the StatusHeader: honest daemon/engine/model transparency + override pill. */
import { byId, el, clear } from '../dom.js';
import { engineLabel, type Brain } from '../frames.js';
import type { State, Store } from '../store.js';

function modelDotClass(status: State['model']['status']): string {
  return status === 'ready' ? 'good' : status === 'error' ? 'bad' : 'warn';
}

function modelText(s: State): string {
  if (s.model.status === 'error') return s.model.detail ? `error — ${s.model.detail}` : 'error';
  if (s.model.status === 'loading') return s.model.model ? `loading ${s.model.model}…` : 'loading…';
  return s.model.model ?? '(model)';
}

function busy(s: State): boolean {
  return s.turns.some((t) => t.role === 'assistant' && t.streaming);
}

export function mountHeader(store: Store): void {
  const host = byId('status-header');
  const render = (s: State): void => {
    clear(host);
    const brain = s.brain as Brain;
    const nodes: (Node | null)[] = [
      el('div', { class: 'sh-item' },
        el('span', { class: 'sh-dot ' + (s.connected ? 'good' : 'bad') }),
        el('span', { class: 'sh-key' }, 'daemon'),
        el('span', { class: 'sh-val' }, s.daemon ? `${s.daemon.name} ${s.daemon.version}` : 'offline'),
      ),
      el('div', { class: 'sh-item' },
        el('span', { class: 'sh-key' }, 'engine'),
        el('span', { class: 'sh-val' }, engineLabel(brain)),
      ),
      el('div', { class: 'sh-item' },
        el('span', { class: 'sh-dot ' + modelDotClass(s.model.status) }),
        el('span', { class: 'sh-key' }, 'model'),
        el('span', { class: 'sh-val mono' }, modelText(s)),
      ),
      el('div', { class: 'sh-spacer' }),
      busy(s) ? el('div', { class: 'sh-item' }, el('span', { class: 'sh-dot warn' }), el('span', { class: 'sh-val' }, 'thinking…')) : null,
      s.override.active ? el('div', { class: 'sh-pill override' }, '⚡ override active') : null,
    ];
    host.append(...nodes.filter((n): n is Node => n != null));
  };
  store.subscribe(render);
  render(store.state);
}
