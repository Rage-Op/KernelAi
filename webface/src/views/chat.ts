/**
 * chat.ts — the scrollable conversation: streaming answers, live reasoning, tool activity, per-turn
 * stats, and a determinate progress bar. Incremental DOM (a node cache keyed by turn id) keeps streaming
 * smooth (we mutate textContent, not rebuild). Composer mints the utterance id and opens the turn.
 */
import { byId, el } from '../dom.js';
import type { State, Store, Turn } from '../store.js';
import type { OutboundFrame } from '../frames.js';

interface Refs {
  root: HTMLElement;
  bubble: HTMLElement;
  reasoning?: HTMLElement;
  reasoningBody?: HTMLElement;
  tools?: HTMLElement;
  stats?: HTMLElement;
  progress?: HTMLElement;
  progressBar?: HTMLElement;
  progressStarted?: boolean;
}

/** Per-turn manual reasoning override: true=open, false=closed. Absent ⇒ auto (open while thinking). */
const manual = new Map<string, boolean>();

function newId(): string {
  return 'u-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

function fmtCost(u?: number): string | null {
  if (u == null) return null;
  if (u === 0) return 'free';
  return '$' + u.toFixed(u < 0.01 ? 4 : 2);
}

export function mountChat(store: Store, send: (f: OutboundFrame) => void): void {
  const list = byId('chat-list');
  const scroll = byId('chat-scroll');
  const input = byId<HTMLTextAreaElement>('composer-input');
  const form = byId<HTMLFormElement>('composer');
  const sendBtn = byId<HTMLButtonElement>('composer-send');
  const refs = new Map<string, Refs>();

  function nearBottom(): boolean {
    return scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 80;
  }

  function buildTurn(t: Turn): Refs {
    const bubble = el('div', { class: 'msg-bubble' });
    const root = el('div', { class: 'msg ' + t.role },
      el('div', { class: 'msg-role' }, t.role === 'user' ? 'you' : 'kernel'),
    );
    const r: Refs = { root, bubble };
    if (t.role === 'assistant') {
      // progress (determinate, CSS-transition driven)
      r.progressBar = el('i');
      r.progress = el('div', { class: 'progress' }, r.progressBar);
      // reasoning (collapsible)
      r.reasoningBody = el('div', { class: 'reasoning-body' });
      const head = el('div', { class: 'reasoning-head' },
        el('span', { class: 'caret' }, '▾'), el('span', {}, 'reasoning'));
      r.reasoning = el('div', { class: 'reasoning collapsed' }, head, r.reasoningBody);
      head.addEventListener('click', () => {
        // toggle: if currently collapsed, open it (manual=true); else close it (manual=false).
        manual.set(t.id, r.reasoning!.classList.contains('collapsed'));
        syncOne(t);
      });
      r.tools = el('div', { class: 'tools' });
      r.stats = el('div', { class: 'stats' });
      root.append(r.progress, r.reasoning, r.tools, bubble, r.stats);
    } else {
      root.append(bubble);
    }
    return r;
  }

  function syncOne(t: Turn): void {
    let r = refs.get(t.id);
    if (!r) { r = buildTurn(t); refs.set(t.id, r); list.append(r.root); }
    // text
    r.bubble.textContent = t.text;
    r.bubble.classList.toggle('streaming', t.streaming && t.text === '' && t.reasoning === '' && !t.progress);
    if (t.role !== 'assistant') return;

    // reasoning — auto-expand while thinking; auto-collapse once the answer starts; honor a manual toggle.
    if (r.reasoning && r.reasoningBody) {
      r.reasoning.classList.toggle('hidden', t.reasoning.length === 0);
      r.reasoningBody.textContent = t.reasoning;
      const shouldCollapse = manual.has(t.id)
        ? !manual.get(t.id)
        : t.reasoningDone && t.text.length > 0;
      r.reasoning.classList.toggle('collapsed', shouldCollapse);
    }

    // tools
    if (r.tools) {
      r.tools.classList.toggle('hidden', t.tools.length === 0);
      // rebuild tool rows (few of them)
      r.tools.replaceChildren(...t.tools.map((a) => {
        const ic = a.status === 'ok' ? '✓' : a.status === 'error' ? '✕' : '⏳';
        return el('div', { class: 'tool-row ' + a.status },
          el('span', { class: 'tool-ic' }, ic),
          el('span', { class: 'tool-name' }, a.tool + (a.op && a.op !== a.tool ? '·' + a.op : '')),
          a.detail ? el('span', { class: 'tool-detail' }, a.detail) : null,
        );
      }));
    }

    // progress (determinate via CSS width transition over etaMs)
    if (r.progress && r.progressBar) {
      const showProg = !!t.progress && t.streaming && t.text === '';
      r.progress.classList.toggle('hidden', !showProg && !r.progressStarted);
      if (t.progress && !r.progressStarted) {
        r.progressStarted = true;
        const bar = r.progressBar;
        bar.style.width = '0%';
        requestAnimationFrame(() => {
          bar.style.transitionDuration = `${Math.max(400, t.progress!.etaMs)}ms`;
          bar.style.width = '95%';
        });
      }
      if (r.progressStarted && (t.text !== '' || !t.streaming)) {
        r.progressBar.style.transitionDuration = '180ms';
        r.progressBar.style.width = '100%';
        const prog = r.progress;
        setTimeout(() => prog.classList.add('hidden'), 220);
      }
    }

    // stats
    if (r.stats) {
      const s = t.stats;
      if (!s) { r.stats.classList.add('hidden'); }
      else {
        r.stats.classList.remove('hidden');
        const parts: (Node | null)[] = [];
        const add = (k: string, v: string | null) => { if (v != null) parts.push(el('span', {}, el('b', {}, k + ' '), v)); };
        add('tok/s', s.tokensPerSec != null ? s.tokensPerSec.toFixed(1) : null);
        add('in', s.promptTokens != null ? String(s.promptTokens) : null);
        add('out', s.outputTokens != null ? String(s.outputTokens) : null);
        add('ctx', s.contextWindow != null ? String(s.contextWindow) : null);
        add('time', s.totalMs != null ? (s.totalMs / 1000).toFixed(1) + 's' : null);
        add('cost', fmtCost(s.estCostUsd));
        r.stats.replaceChildren(...parts.filter((n): n is Node => n != null));
      }
    }
  }

  function render(s: State): void {
    const wasNear = nearBottom();
    for (const t of s.turns) syncOne(t);
    // prune nodes for turns no longer present (e.g. after /clear)
    const live = new Set(s.turns.map((t) => t.id));
    for (const [id, r] of refs) if (!live.has(id)) { r.root.remove(); refs.delete(id); }
    if (wasNear) scroll.scrollTop = scroll.scrollHeight;
    sendBtn.disabled = !s.connected;
  }

  // composer: autoresize + Enter-to-send
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 180) + 'px'; });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    const id = newId();
    store.beginTurn(id, text);
    send({ type: 'utterance', id, text, final: true });
    input.value = '';
    input.style.height = 'auto';
    scroll.scrollTop = scroll.scrollHeight;
  });

  store.subscribe(render);
  render(store.state);
}
