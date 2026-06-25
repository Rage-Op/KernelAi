/**
 * frames.ts — the subset of the daemon's frozen IPC frame contract the web Face consumes/produces.
 * Mirrors daemon/src/ipc/protocol.ts (kept deliberately small — only what the UI uses). The daemon
 * remains the single source of truth; these are structural types for the browser side.
 */
export type Brain = 'cloud' | 'local' | 'lmstudio';

// ---- daemon → web ----
export interface ReadyFrame { type: 'ready'; daemon: string; version: string; }
export interface CapabilitiesFrame {
  type: 'capabilities'; brain: Brain; daemon: string; version: string;
  injectCap: number; tools: string[]; integrations: string[];
}
export interface ReplyFrame { type: 'reply'; id: string; text: string; }
export interface SayFrame { type: 'say'; id: string; delta: string; final: boolean; }
export interface ReasoningFrame { type: 'reasoning'; id: string; delta: string; final: boolean; }
export interface ProgressFrame { type: 'progress'; id: string; etaMs: number; label?: string; }
export interface ToolActivityFrame {
  type: 'tool.activity'; id: string; tool: string; op: string;
  status: 'start' | 'ok' | 'error'; detail?: string;
}
export interface StatsFrame {
  type: 'stats'; id: string; brain: Brain; model?: string;
  promptTokens?: number; outputTokens?: number; tokensPerSec?: number;
  evalMs?: number; loadMs?: number; totalMs?: number; contextWindow?: number; estCostUsd?: number;
}
export interface ModelStateFrame {
  type: 'model.state'; status: 'loading' | 'ready' | 'error'; brain: Brain; model?: string; detail?: string;
}
export interface OverrideStateFrame { type: 'override.state'; active: boolean; scope?: string; expiresAt?: number; }
export interface SettingsStateFrame { type: 'settings.state'; breakerEnabled: boolean; dailySpendCeiling: number; defaultTtlMs: number; }
export interface HistoryDataFrame {
  type: 'history.data'; id: string; turns: { role: 'user' | 'assistant'; text: string; ts: number }[];
}
export interface ErrorFrame { type: 'error'; id?: string; message: string; }
export interface BrowserFrameFrame { type: 'browser.frame'; dataB64: string; url: string; width: number; height: number; }
export interface BrowserStateFrame { type: 'browser.state'; active: boolean; url?: string; }
export interface ServiceInfo { name: string; label: string; running: boolean; pid?: number; detail?: string; actions: string[]; }
export interface ServiceDataFrame { type: 'service.data'; id?: string; services: ServiceInfo[]; }

export type InboundFrame =
  | ReadyFrame | CapabilitiesFrame | ReplyFrame | SayFrame | ReasoningFrame | ProgressFrame
  | ToolActivityFrame | StatsFrame | ModelStateFrame | OverrideStateFrame | SettingsStateFrame
  | HistoryDataFrame | ErrorFrame | BrowserFrameFrame | BrowserStateFrame | ServiceDataFrame
  | { type: string; [k: string]: unknown }; // tolerate unknown/future arms

// ---- web → daemon ----
export interface UtteranceFrame { type: 'utterance'; id: string; text: string; final: boolean; }
export interface PingFrame { type: 'ping'; id: string; }
export interface SettingsFrame { type: 'settings'; brain: Brain; }
export interface SettingsUpdateFrame { type: 'settings.update'; breakerEnabled?: boolean; dailySpendCeiling?: number; defaultTtlMs?: number; }
export interface OverrideFrame { type: 'override'; active: boolean; ttlMs?: number; }
export interface HistoryRequestFrame { type: 'history.request'; id: string; limit?: number; }
export interface BrowserViewFrame { type: 'browser.view'; streaming: boolean; }
export interface ServiceListFrame { type: 'service.list'; id: string; }
export interface ServiceActionFrame { type: 'service.action'; id: string; name: string; action: 'stop' | 'restart'; }

export type OutboundFrame =
  | UtteranceFrame | PingFrame | SettingsFrame | SettingsUpdateFrame
  | OverrideFrame | HistoryRequestFrame | BrowserViewFrame | ServiceListFrame | ServiceActionFrame;

/** Brain → human label (matches the daemon's engine naming). */
export function engineLabel(b: Brain): string {
  return b === 'cloud' ? 'cloud' : b === 'lmstudio' ? 'lm studio' : 'ollama';
}
export function shortBrain(b: Brain): string {
  return b === 'cloud' ? 'claude' : b === 'lmstudio' ? 'lm studio' : 'ollama';
}
