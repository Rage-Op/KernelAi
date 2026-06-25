/** settings.ts — brain toggle, safety posture (breaker + spend ceiling), /override, and capabilities. */
import { byId, el, clear } from '../dom.js';
import type { State, Store } from '../store.js';
import type { Brain, OutboundFrame } from '../frames.js';

const BRAINS: { id: Brain; name: string; desc: string }[] = [
  { id: 'lmstudio', name: 'LM Studio', desc: 'Local MLX/GGUF via LM Studio server (:1234). Apple-Silicon optimal.' },
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

    // --- LM Studio models ---
    const lms = s.lmstudio;
    const fmtSize = (b?: number): string | null => {
      if (b == null || !Number.isFinite(b) || b <= 0) return null;
      const gb = b / 1e9;
      return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`;
    };
    let lmsRows: (Node | null)[];
    if (!lms.serverUp) {
      lmsRows = [el('div', { class: 's-sub' }, 'LM Studio server not reachable (start it on :1234)')];
    } else if (lms.models.length === 0) {
      lmsRows = [el('div', { class: 's-sub' }, 'No models found.')];
    } else {
      lmsRows = lms.models.map((m) => {
        const isActive = m.key === lms.active;
        const subParts: string[] = [];
        if (m.paramsString) subParts.push(m.paramsString);
        if (m.format) subParts.push(m.format);
        const sz = fmtSize(m.sizeBytes);
        if (sz) subParts.push(sz);
        if (m.loaded && m.loadedContextLength != null) {
          subParts.push(m.maxContextLength != null ? `ctx ${m.loadedContextLength}/${m.maxContextLength}` : `ctx ${m.loadedContextLength}`);
        } else if (m.maxContextLength != null) {
          subParts.push(`ctx ≤${m.maxContextLength}`);
        }

        let control: Node;
        if (m.loaded) {
          const b = el('button', { class: 's-btn warn' }, 'Unload');
          b.addEventListener('click', () => send({ type: 'lmstudio.action', id: 'lms', action: 'unload', key: m.key }));
          control = b;
        } else {
          const ctxAttrs: Record<string, unknown> = { class: 's-input', type: 'number', min: '1', step: '1', placeholder: 'ctx' };
          if (m.maxContextLength != null) ctxAttrs.max = String(m.maxContextLength);
          const ctxInput = el('input', ctxAttrs) as HTMLInputElement;
          const b = el('button', { class: 's-btn' }, 'Load');
          b.addEventListener('click', () => {
            const raw = ctxInput.value.trim();
            const frame: OutboundFrame = { type: 'lmstudio.action', id: 'lms', action: 'load', key: m.key };
            if (raw !== '') {
              const v = Number(raw);
              if (Number.isFinite(v) && v > 0) frame.contextLength = v;
            }
            send(frame);
          });
          control = el('div', { class: 'kv' }, ctxInput, b);
        }

        return el('div', { class: 's-row' },
          el('div', {},
            el('div', { class: 's-label' }, dot(m.loaded), m.displayName, isActive ? el('span', { class: 's-sub', style: 'margin-left:8px' }, '(active)') : null),
            el('div', { class: 's-sub', style: 'margin-left:16px' }, subParts.join(' · ') || '—'),
          ),
          control,
        );
      });
    }
    const lmsRefresh = el('button', { class: 's-btn' }, '↻ Refresh');
    lmsRefresh.addEventListener('click', () => send({ type: 'lmstudio.list', id: 'lms' }));
    wrap.append(el('div', { class: 's-card' },
      el('h3', {}, 'LM Studio models'),
      el('p', {}, 'Load or unload models in the LM Studio server (:1234). The active engine model is marked.'),
      ...lmsRows.filter((n): n is Node => n != null),
      lms.note ? el('div', { class: 's-sub', style: 'margin-top:12px' }, lms.note) : null,
      el('div', { style: 'margin-top:12px' }, lmsRefresh),
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
