/**
 * store.ts — the single app-state store. Frames mutate it via `applyFrame`; views subscribe and
 * re-render incrementally. Turns are keyed by id so streaming say/reasoning/tool/stats/progress frames
 * land on the right assistant turn (the same id the composer minted for the utterance).
 */
import type { Brain, InboundFrame, ServiceInfo } from './frames.js';

export interface ToolAct { tool: string; op: string; status: 'start' | 'ok' | 'error'; detail?: string; }
export interface TurnStats {
  model?: string; tokensPerSec?: number; promptTokens?: number; outputTokens?: number;
  totalMs?: number; contextWindow?: number; estCostUsd?: number;
}
export interface Turn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  reasoning: string;
  reasoningDone: boolean;
  tools: ToolAct[];
  stats?: TurnStats;
  progress?: { etaMs: number; startedAt: number };
  streaming: boolean;
}
export interface State {
  connected: boolean;
  daemon?: { name: string; version: string };
  capabilities?: { brain: Brain; tools: string[]; integrations: string[]; injectCap: number };
  model: { status: 'loading' | 'ready' | 'error'; brain: Brain; model?: string; detail?: string };
  settings: { breakerEnabled: boolean; dailySpendCeiling: number; defaultTtlMs: number };
  override: { active: boolean; scope?: string; expiresAt?: number };
  brain: Brain;
  turns: Turn[];
  browser: { active: boolean; url?: string; frame?: { dataB64: string; width: number; height: number; url: string } };
  services: ServiceInfo[];
}

type Listener = (s: State) => void;

export class Store {
  state: State = {
    connected: false,
    model: { status: 'loading', brain: 'local' },
    settings: { breakerEnabled: false, dailySpendCeiling: 0, defaultTtlMs: 300000 },
    override: { active: false },
    brain: 'local',
    turns: [],
    browser: { active: false },
    services: [],
  };
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): void { this.listeners.add(fn); }
  private emit(): void { for (const fn of this.listeners) fn(this.state); }

  private turn(id: string): Turn | undefined { return this.state.turns.find((t) => t.id === id && t.role === 'assistant'); }

  /** Composer calls this when the owner sends: a user turn + an assistant placeholder sharing `id`. */
  beginTurn(id: string, text: string): void {
    this.state.turns.push({ id: id + ':u', role: 'user', text, reasoning: '', reasoningDone: true, tools: [], streaming: false });
    this.state.turns.push({ id, role: 'assistant', text: '', reasoning: '', reasoningDone: false, tools: [], streaming: true });
    this.emit();
  }

  applyFrame(f: InboundFrame): void {
    switch (f.type) {
      case 'ready':
        this.state.daemon = { name: (f as any).daemon, version: (f as any).version };
        this.state.connected = true;
        break;
      case 'capabilities': {
        const c = f as any;
        this.state.capabilities = { brain: c.brain, tools: c.tools, integrations: c.integrations, injectCap: c.injectCap };
        this.state.brain = c.brain;
        break;
      }
      case 'model.state': {
        const m = f as any;
        this.state.model = { status: m.status, brain: m.brain, model: m.model, detail: m.detail };
        this.state.brain = m.brain;
        break;
      }
      case 'settings.state': {
        const s = f as any;
        this.state.settings = { breakerEnabled: s.breakerEnabled, dailySpendCeiling: s.dailySpendCeiling, defaultTtlMs: s.defaultTtlMs };
        break;
      }
      case 'override.state': {
        const o = f as any;
        this.state.override = { active: o.active, scope: o.scope, expiresAt: o.expiresAt };
        break;
      }
      case 'say': {
        const s = f as any;
        const t = this.turn(s.id);
        if (t) { t.text += s.delta; if (s.final) t.streaming = false; }
        break;
      }
      case 'reply': {
        const r = f as any;
        const t = this.turn(r.id);
        if (t) { t.text = r.text; t.streaming = false; }
        break;
      }
      case 'reasoning': {
        const r = f as any;
        const t = this.turn(r.id);
        if (t) { t.reasoning += r.delta; if (r.final) t.reasoningDone = true; }
        break;
      }
      case 'tool.activity': {
        const a = f as any;
        const t = this.turn(a.id);
        if (t) {
          // collapse start→ok/error on the same tool+op into one row
          const existing = [...t.tools].reverse().find((x) => x.tool === a.tool && x.op === a.op && x.status === 'start');
          if (existing && a.status !== 'start') { existing.status = a.status; if (a.detail) existing.detail = a.detail; }
          else t.tools.push({ tool: a.tool, op: a.op, status: a.status, detail: a.detail });
        }
        break;
      }
      case 'stats': {
        const s = f as any;
        const t = this.turn(s.id);
        if (t) t.stats = { model: s.model, tokensPerSec: s.tokensPerSec, promptTokens: s.promptTokens, outputTokens: s.outputTokens, totalMs: s.totalMs, contextWindow: s.contextWindow, estCostUsd: s.estCostUsd };
        break;
      }
      case 'progress': {
        const p = f as any;
        const t = this.turn(p.id);
        if (t) t.progress = { etaMs: p.etaMs, startedAt: Date.now() };
        break;
      }
      case 'history.data': {
        const h = f as any;
        if (this.state.turns.length === 0 && Array.isArray(h.turns)) {
          for (const [i, turn] of h.turns.entries()) {
            this.state.turns.push({ id: `hist-${i}`, role: turn.role, text: turn.text, reasoning: '', reasoningDone: true, tools: [], streaming: false });
          }
        }
        break;
      }
      case 'browser.frame': {
        const b = f as any;
        this.state.browser = { active: true, url: b.url, frame: { dataB64: b.dataB64, width: b.width, height: b.height, url: b.url } };
        break;
      }
      case 'browser.state': {
        const b = f as any;
        this.state.browser = { ...this.state.browser, active: b.active, url: b.url ?? this.state.browser.url };
        if (!b.active) this.state.browser.frame = undefined;
        break;
      }
      case 'service.data': {
        const s = f as any;
        if (Array.isArray(s.services)) this.state.services = s.services;
        break;
      }
      case 'error':
        // surfaced via console for the MVP; reply errors also arrive as reply text where relevant.
        console.warn('[kernel] error frame:', (f as any).message);
        break;
      default:
        break;
    }
    this.emit();
  }

  setConnected(v: boolean): void { this.state.connected = v; this.emit(); }
  setBrain(b: Brain): void { this.state.brain = b; this.emit(); }

  /**
   * Close out any assistant turn still marked streaming — used after an SSE reconnect, since the
   * daemon delivers say/reasoning/stats to the ORIGINATING connection only, so a turn in flight during
   * a drop would otherwise spin forever (blinking cursor + stuck progress + "thinking…" pill).
   */
  finalizeStuckTurns(): void {
    let changed = false;
    for (const t of this.state.turns) {
      if (t.role === 'assistant' && t.streaming) {
        t.streaming = false;
        t.progress = undefined;
        if (t.text === '') t.text = '⚠ interrupted — the connection dropped mid-answer. Resend to retry.';
        changed = true;
      }
    }
    if (changed) this.emit();
  }
}
