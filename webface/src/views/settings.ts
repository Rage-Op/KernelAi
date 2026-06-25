/** settings.ts — brain toggle, safety posture (breaker + spend ceiling), /override, and capabilities. */
import { byId, el, clear } from '../dom.js';
import type { State, Store } from '../store.js';
import type { Brain, OutboundFrame } from '../frames.js';

const BRAINS: { id: Brain; name: string; desc: string }[] = [
  { id: 'lmstudio', name: 'LM Studio', desc: 'Local MLX/GGUF via LM Studio server (:1234). Apple-Silicon optimal.' },
  { id: 'local', name: 'Ollama', desc: 'Local GGUF via Ollama (:11434). qwen3.5:9b by default.' },
  { id: 'cloud', name: 'Claude (cloud)', desc: 'Anthropic API — priced per token. Most capable.' },
];

export function mountSettings(store: Store, send: (f: OutboundFrame) => void): void {
  const host = byId('view-settings');

  const render = (s: State): void => {
    clear(host);
    const wrap = el('div', { class: 'settings-wrap' });

    // --- Background services (kill panel) ---
    const dot = (on: boolean) =>
      el('span', { style: `display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:8px;vertical-align:middle;background:${on ? 'var(--good)' : 'var(--text-faint)'}` });
    const svcRows: (Node | null)[] = s.services.length === 0
      ? [el('div', { class: 's-sub' }, 'Loading service status…')]
      : s.services.map((sv) => {
          const right = sv.actions.includes('stop')
            ? (() => {
                const b = el('button', { class: 's-btn warn' }, 'Stop');
                b.addEventListener('click', () => send({ type: 'service.action', id: 'svc', name: sv.name, action: 'stop' }));
                return b;
              })()
            : el('span', { class: 's-sub' }, sv.running ? '—' : 'stopped');
          return el('div', { class: 's-row' },
            el('div', {},
              el('div', { class: 's-label' }, dot(sv.running), sv.label),
              el('div', { class: 's-sub', style: 'margin-left:16px' }, sv.detail ?? (sv.running ? 'running' : 'stopped')),
            ),
            right,
          );
        });
    const refresh = el('button', { class: 's-btn' }, '↻ Refresh');
    refresh.addEventListener('click', () => send({ type: 'service.list', id: 'svc' }));
    wrap.append(el('div', { class: 's-card' },
      el('h3', {}, 'Background services'),
      el('p', {}, 'Stop the local pieces KERNEL relies on when one wedges (owner-only, localhost). Killing “stray daemons” clears the old duplicate-daemon bug.'),
      ...svcRows.filter((n): n is Node => n != null),
      el('div', { style: 'margin-top:12px' }, refresh),
    ));

    // --- Brain ---
    const brainOpts = el('div', { class: 'brain-opts' },
      ...BRAINS.map((b) =>
        el('div', { class: 'brain-opt' + (s.brain === b.id ? ' is-active' : ''), onClick: () => {
          store.setBrain(b.id);
          send({ type: 'settings', brain: b.id });
        } },
          el('div', {},
            el('div', { class: 'b-name' }, b.name),
            el('div', { class: 'b-desc' }, b.desc),
          ),
        ),
      ),
    );
    wrap.append(el('div', { class: 's-card' },
      el('h3', {}, 'Engine'),
      el('p', {}, 'Which model orchestrates. Tools, MCP, memory, and the safety gate are identical for all three.'),
      brainOpts,
    ));

    // --- Safety posture ---
    const breakerToggle = el('div', { class: 'toggle' + (s.settings.breakerEnabled ? ' on' : '') });
    breakerToggle.addEventListener('click', () => send({ type: 'settings.update', breakerEnabled: !s.settings.breakerEnabled }));
    const ceiling = el('input', { class: 's-input', type: 'number', min: '0', step: '1', value: String(s.settings.dailySpendCeiling) }) as HTMLInputElement;
    const ceilingSave = el('button', { class: 's-btn' }, 'Save');
    ceilingSave.addEventListener('click', () => {
      const v = Number(ceiling.value);
      if (Number.isFinite(v) && v >= 0) send({ type: 'settings.update', dailySpendCeiling: v });
    });
    const overrideBtn = el('button', { class: 's-btn warn' }, s.override.active ? 'Deactivate /override' : 'Activate /override');
    overrideBtn.addEventListener('click', () => send({ type: 'override', active: !s.override.active }));

    wrap.append(el('div', { class: 's-card' },
      el('h3', {}, 'Safety'),
      el('p', {}, 'The gate always governs every tool call. These tune the Red breaker and the spend reserve.'),
      el('div', { class: 's-row' },
        el('div', {}, el('div', { class: 's-label' }, 'Red breaker'), el('div', { class: 's-sub' }, 'Require the 10s preview/cancel window for destructive (Red) actions.')),
        breakerToggle,
      ),
      el('div', { class: 's-row' },
        el('div', {}, el('div', { class: 's-label' }, 'Daily spend ceiling (USD)'), el('div', { class: 's-sub' }, 'The breaker’s daily reserve cap.')),
        el('div', { class: 'kv' }, ceiling, ceilingSave),
      ),
      el('div', { class: 's-row' },
        el('div', {}, el('div', { class: 's-label' }, 'Override'),
          el('div', { class: 's-sub' }, s.override.active ? 'Active — Green full-speed, Yellow proceed+notify. Red still gated.' : 'Off. Activating speeds Green/Yellow for a while; never unlocks Red.')),
        overrideBtn,
      ),
    ));

    // --- Capabilities (transparency) ---
    const cap = s.capabilities;
    wrap.append(el('div', { class: 's-card' },
      el('h3', {}, 'Capabilities'),
      el('p', {}, 'What KERNEL can reach. Every one is gate-chokepointed.'),
      el('div', { class: 'kv' }, el('b', {}, 'tools')),
      el('div', { class: 'tools-list' }, ...(cap?.tools ?? []).map((t) => el('span', { class: 'tool-chip' }, t))),
      el('div', { class: 'kv', style: 'margin-top:12px' }, el('b', {}, 'integrations')),
      el('div', { class: 'tools-list' }, ...(cap?.integrations ?? []).map((t) => el('span', { class: 'tool-chip' }, t))),
      el('div', { class: 'kv', style: 'margin-top:12px' }, el('b', {}, 'context cap'), `${cap?.injectCap ?? 0} chars`),
    ));

    host.append(wrap);
  };
  store.subscribe(render);
  render(store.state);
}
