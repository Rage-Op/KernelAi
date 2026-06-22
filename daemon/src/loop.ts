/**
 * Event-driven serial intent runner (CORE-02) — explicitly NOT a polling setInterval.
 *
 * `enqueue(intent)` pushes onto a module-level queue and triggers `drain()`. `drain()`
 * runs ONE intent at a time (a `running` guard prevents concurrent passes) and, when the
 * queue empties, sets `running=false` and returns — the daemon falls GENUINELY IDLE with
 * no timer armed (RESEARCH.md Pattern 1 / Anti-Pattern 5).
 *
 * One drained intent runs the full tick:
 *   perceive (the intent) → recall (inject() — IDENTITY-first context ≤16K)
 *   → decide (brain.reason() — StubBrain in P1) → act (no tools in P1; a P2+ seam)
 *   → log (logSession appends a ## Session block) → surface the reply to the originator.
 *
 * The brain is injected (defaults to StubBrain) so the swap-seam is real even for the stub.
 * The reply is delivered via the intent's own `reply` callback (the IPC server supplies one
 * that pushes a `reply` frame back to the originating connection), so the loop never imports
 * the server — no cycle.
 */
import type { BrainProvider, ToolCall, BrainUsage } from './brain/BrainProvider.js';
import type { Provenance } from './memory/types.js';
import { StubBrain } from './brain/StubBrain.js';
import { inject } from './memory/inject.js';
import { logSession } from './memory/log.js';
import { dispatch } from './tools/registry.js';
import { overrideSingleton } from './safety/override.js';

/** A unit of work for the loop. `reply` surfaces the brain's text to the originator. */
export interface Intent {
  /** Provenance of the work: a user utterance, a scheduled wake, or a tool callback. */
  source: 'user' | 'schedule' | 'tool';
  /** The payload (for a user utterance, the text). */
  payload: unknown;
  /** Correlation id (echoed into the reply frame / session log). */
  id?: string;
  /** Deliver the brain's reply text back to the originator (e.g. push a reply frame). */
  reply?: (text: string) => void;
  /** Surface per-pass telemetry (tokens/timing/model) — the server turns it into a `stats` frame. */
  onUsage?: (usage: BrainUsage) => void;
  /** Memory dir override (tests run against a temp dir; defaults to config.memoryDir). */
  memoryDir?: string;
}

/** The serial queue and the single-pass guard. Module-level by design (one daemon loop). */
const queue: Intent[] = [];
let running = false;
/** The in-flight drain pass, so callers can await completion instead of returning early. */
let inflight: Promise<void> | null = null;

/** The active brain (swap-seam). Defaults to StubBrain; overridable for tests. */
let brain: BrainProvider = new StubBrain();

/** Override the brain (test seam / Settings brain-swap wiring via settings.ts). */
export function setBrain(b: BrainProvider): void {
  brain = b;
}

/** Read the active brain (test seam — lets settings.test assert which brain is selected). */
export function getActiveBrain(): BrainProvider {
  return brain;
}

/** True while a drain pass is in flight. Exposed for tests asserting idle. */
export function isRunning(): boolean {
  return running;
}

/** Current queue depth. Exposed for tests asserting the queue empties. */
export function queueDepth(): number {
  return queue.length;
}

/** Build the brain prompt for an intent (P1: the utterance text). */
function promptFor(intent: Intent): string {
  return typeof intent.payload === 'string'
    ? intent.payload
    : JSON.stringify(intent.payload);
}

/** Default `/override` session duration (5 minutes). */
const OVERRIDE_DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * Parse a LITERAL `/override` (or `override`) command from a USER utterance, BEFORE any brain
 * call. Returns the activation scope + TTL, or null if the intent is not an override command.
 *
 * SECURITY (T-05-05): only `source:'user'` text is parsed — external content arrives as context
 * items inside inject(), never as the utterance here, so a poisoned email can NEVER activate
 * override. The match is a strict literal at the start of the trimmed utterance (not a substring
 * anywhere in arbitrary text) so quoting "/override" inside a sentence does not trigger it.
 */
export function parseOverrideCommand(intent: Intent): { scope: string; ttlMs: number } | null {
  if (intent.source !== 'user') return null;
  if (typeof intent.payload !== 'string') return null;
  const text = intent.payload.trim();
  // Accept "/override", "override", optionally followed by a scope word — at the START only.
  const m = /^\/?override\b\s*(\S+)?/i.exec(text);
  if (!m) return null;
  const scope = m[1] ?? 'session';
  return { scope, ttlMs: OVERRIDE_DEFAULT_TTL_MS };
}

/**
 * Derive the provenance taint for an action driven by this intent. A user utterance is trusted
 * 'user'; a scheduled/tool wake is KERNEL's own 'self'. The brain may override this per-action
 * when it sees an external-sourced instruction (it sets action.origin='external' directly).
 */
function originForIntent(intent: Intent): Provenance {
  return intent.source === 'user' ? 'user' : 'self';
}

/**
 * Enqueue an intent and trigger a drain. Returns immediately — the work runs async.
 */
export function enqueue(intent: Intent): void {
  queue.push(intent);
  void drain();
}

/**
 * Drain the queue serially, one intent at a time. Only ONE pass runs at a time (the
 * `running` guard prevents concurrent loops); if a pass is already in flight, callers
 * AWAIT it rather than starting a second pass or returning early. Any intent enqueued
 * during a pass is picked up by the same `while (queue.length)` loop. Falls genuinely
 * idle in `finally` (running=false, inflight cleared) — no timer left armed.
 */
export function drain(): Promise<void> {
  if (running) return inflight ?? Promise.resolve(); // one pass at a time — await it
  running = true;
  inflight = (async () => {
    try {
      while (queue.length) {
        const intent = queue.shift()!;

        // PHASE 5 — LITERAL /override command parse, BEFORE brain.reason() (T-05-05, locked
        // decision). Only a USER utterance can activate override; external content is data and
        // never reaches this parse, so a poisoned email can never flip override on. The command
        // short-circuits the tick (no brain call, no dispatch) — and even when active it does NOT
        // change the Red decision (the gate ignores override for Red; defense in depth).
        const overrideCmd = parseOverrideCommand(intent);
        if (overrideCmd) {
          overrideSingleton().activate(overrideCmd.scope, overrideCmd.ttlMs);
          if (intent.reply) {
            intent.reply(
              `Override active (${overrideCmd.scope}) for ${Math.round(overrideCmd.ttlMs / 1000)}s — Green full-speed, Yellow proceed+notify; Red stays gated.`,
            );
          }
          logSession({ intent, decision: { thought: 'override activated', reply: 'override' } }, intent.memoryDir);
          continue; // do NOT reach the brain for an override command.
        }

        // recall: assemble IDENTITY-first context under the 16K cap.
        const context = await inject(promptFor(intent), intent.memoryDir);
        // decide: route even the stub through reason() so the seam is real.
        const decision = await brain.reason(promptFor(intent), context);
        // act: dispatch a real decision.action through the router. The loop NEVER imports the
        // gate or a tool directly — dispatch() runs gate.authorize internally, preserving the
        // single-chokepoint invariant. A blocked/escalated result is surfaced like a reply.
        if (decision.action) {
          // PHASE 5 — stamp provenance taint on the action (SAFE-04 ii, RESEARCH Pattern 3). The
          // gate HARD-BLOCKS a Red action with origin==='external'. Honor an origin the brain
          // already set (it sees per-item provenance); otherwise derive from the intent source: a
          // user utterance is 'user', a schedule/tool wake is 'self'.
          const action: ToolCall = {
            ...decision.action,
            origin: decision.action.origin ?? originForIntent(intent),
          };
          const result = await dispatch(action);
          if (!result.ok && result.escalation && intent.reply) {
            intent.reply(
              `Blocked: ${result.escalation.reason}` +
                (result.escalation.recommendation ? ` — ${result.escalation.recommendation}` : ''),
            );
          }
        }
        // log: append a ## Session block (append-only, CORE-05).
        logSession({ intent, decision }, intent.memoryDir);
        // surface the reply to the originator (the IPC server pushes a reply frame).
        if (decision.reply && intent.reply) intent.reply(decision.reply);
        // surface per-pass telemetry AFTER the reply (the server pushes a stats frame; the client
        // renders it under the answer). Absent when the brain reported no usage (e.g. the stub).
        if (decision.usage && intent.onUsage) intent.onUsage(decision.usage);
      }
    } finally {
      running = false; // fall genuinely idle — no timer left armed
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Run the loop to completion for the currently-queued work and await idle.
 *
 * This is the Walking-Skeleton e2e entry (`runTick`): after a frame has been enqueued
 * by the IPC server, `await runTick()` drains the queue and resolves once the loop is
 * idle (queue empty, running=false). If a drain is already in flight, it awaits its
 * completion rather than starting a concurrent pass.
 */
export async function runTick(): Promise<void> {
  await drain();
}
