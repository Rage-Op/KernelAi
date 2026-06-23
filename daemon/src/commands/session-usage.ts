/**
 * Cumulative session usage — the daemon-authoritative telemetry behind the `usage` meta-command.
 *
 * Every turn that produces brain usage feeds `recordTurn` (wired from the IPC server right where it
 * builds the per-turn `stats` frame, so the numbers match exactly what a client renders). The
 * accumulator is module-level on purpose: there is ONE daemon loop and ONE persistent session, so
 * "usage" means "since this daemon started" — surfaced that way and resettable via `/usage reset`.
 *
 * Importing nothing from the loop/server graph (only the pure pricing helper) keeps it free of any
 * import cycle: the server imports `recordTurn`, the loop's `usage` command imports `snapshot`.
 */
import { cloudEquivUsd } from '../brain/pricing.js';

/** A turn's measured usage — the subset of the `stats` frame the accumulator consumes. */
export interface TurnUsage {
  brain: 'cloud' | 'local';
  model?: string;
  promptTokens?: number;
  outputTokens?: number;
  evalMs?: number;
  totalMs?: number;
  /** Actual USD billed this turn (0 for local). */
  estCostUsd?: number;
}

/** An immutable snapshot of cumulative session usage for rendering. */
export interface UsageSnapshot {
  /** When this accounting window began (daemon start, or last reset). */
  startedAt: string;
  /** Turns that reported usage. */
  turns: number;
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Generation time summed across turns (basis for avg tok/s). */
  evalMs: number;
  /** End-to-end time summed across turns. */
  totalMs: number;
  /** Actual USD billed (0 on the local brain). */
  costUsd: number;
  /** What the same tokens would have cost on the cloud brain (list price). */
  cloudEquivUsd: number;
  /** Average generation throughput, or null when no generation time was measured. */
  avgTokensPerSec: number | null;
  /** Last turn's prompt tokens (a proxy for current model-window fill). */
  lastPromptTokens: number | null;
  /** Most recent model + brain seen (for labelling the report). */
  lastModel?: string;
  lastBrain?: 'cloud' | 'local';
}

interface State {
  startedAt: string;
  turns: number;
  promptTokens: number;
  outputTokens: number;
  evalMs: number;
  totalMs: number;
  costUsd: number;
  cloudEquivUsd: number;
  lastPromptTokens: number | null;
  lastModel?: string;
  lastBrain?: 'cloud' | 'local';
}

function freshState(): State {
  return {
    startedAt: new Date().toISOString(),
    turns: 0,
    promptTokens: 0,
    outputTokens: 0,
    evalMs: 0,
    totalMs: 0,
    costUsd: 0,
    cloudEquivUsd: 0,
    lastPromptTokens: null,
  };
}

let state: State = freshState();

/** Fold one turn's usage into the running totals. Called once per turn from the IPC server. */
export function recordTurn(usage: TurnUsage): void {
  state.turns += 1;
  state.promptTokens += usage.promptTokens ?? 0;
  state.outputTokens += usage.outputTokens ?? 0;
  state.evalMs += usage.evalMs ?? 0;
  state.totalMs += usage.totalMs ?? 0;
  state.costUsd += usage.estCostUsd ?? 0;
  state.cloudEquivUsd += cloudEquivUsd(usage.promptTokens ?? 0, usage.outputTokens ?? 0);
  state.lastPromptTokens = usage.promptTokens ?? state.lastPromptTokens;
  state.lastModel = usage.model ?? state.lastModel;
  state.lastBrain = usage.brain;
}

/** A read-only snapshot with derived fields, safe to format. */
export function snapshot(): UsageSnapshot {
  return {
    startedAt: state.startedAt,
    turns: state.turns,
    promptTokens: state.promptTokens,
    outputTokens: state.outputTokens,
    totalTokens: state.promptTokens + state.outputTokens,
    evalMs: state.evalMs,
    totalMs: state.totalMs,
    costUsd: state.costUsd,
    cloudEquivUsd: state.cloudEquivUsd,
    avgTokensPerSec: state.evalMs > 0 ? state.outputTokens / (state.evalMs / 1000) : null,
    lastPromptTokens: state.lastPromptTokens,
    lastModel: state.lastModel,
    lastBrain: state.lastBrain,
  };
}

/** Reset the accounting window (used by `/usage reset` and tests). */
export function resetUsage(): void {
  state = freshState();
}
