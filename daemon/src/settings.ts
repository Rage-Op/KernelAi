/**
 * settings.ts — the brain=cloud|local Settings path.
 *
 * `applySettings(brain)` swaps the ACTIVE brain via the EXISTING `loop.setBrain` seam — it does
 * NOT touch the loop's queue/drain/gate semantics. `local` → LocalBrain (Ollama), `cloud` →
 * ClaudeBrain (the default). The always-on 7B helper (`brain/helper.ts`) is a standalone module,
 * NOT a BrainProvider, and runs regardless of this toggle (BRAIN-03 / BRAIN-05).
 *
 * Wired into the IPC path additively: the server's `settings` frame arm calls `applySettings`.
 *
 * Persistence (CLOUD-01): the selection is written to a tiny JSON file in the daemon's
 * Application Support dir (the same dir that holds the UDS socket) — NOT the git-backed memory
 * repo, because it is a UI preference, not a memory, and must never be backed up. On daemon
 * startup `restorePersistedBrain()` re-applies the saved choice so a launchd relaunch keeps the
 * owner's brain. The file path is injectable so tests never touch the real Application Support dir
 * (mirrors safety/spend-ledger.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { setBrain } from './loop.js';
import { ClaudeBrain } from './brain/ClaudeBrain.js';
import { LocalBrain } from './brain/LocalBrain.js';
import { config } from './config.js';
import { logger } from './memory/log.js';

/** The brain selection surfaced by the Settings toggle. */
export type BrainSelection = 'cloud' | 'local';

/** The current Settings selection. ClaudeBrain (cloud) is the default (BRAIN-02). */
let currentBrain: BrainSelection = 'cloud';

/** TEST-ONLY override of the persistence file path (null → the real Application Support path). */
let prefPathOverride: string | null = null;

/**
 * TEST-ONLY seam: redirect the persisted-brain file to a tmp path (or null to reset). Lets unit
 * tests exercise persist/restore without writing the real `~/Library/Application Support/Kernel/`.
 */
export function __setBrainPrefPathForTest(p: string | null): void {
  prefPathOverride = p;
}

/**
 * Where the brain preference persists across daemon restarts: `brain.json` next to the UDS
 * socket (the daemon's Application Support dir), NOT the memory repo (never backed up).
 */
function brainPrefPath(): string {
  return prefPathOverride ?? path.join(path.dirname(config.socketPath), 'brain.json');
}

/** Read the current brain selection (test/inspection seam). */
export function currentBrainSelection(): BrainSelection {
  return currentBrain;
}

/** Persist the selection (best-effort; a write failure is logged, never fatal). */
function persistBrain(brain: BrainSelection): void {
  try {
    const file = brainPrefPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ brain }) + '\n', 'utf8');
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'failed to persist brain selection',
    );
  }
}

/** Read the persisted selection; null when absent/unreadable/invalid (→ keep the loop default). */
export function loadPersistedBrain(): BrainSelection | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(brainPrefPath(), 'utf8')) as { brain?: unknown };
    if (parsed.brain === 'local' || parsed.brain === 'cloud') return parsed.brain;
  } catch {
    // absent / unreadable / corrupt → no persisted choice
  }
  return null;
}

/**
 * Apply a brain selection by swapping the active BrainProvider via `setBrain`. The 7B helper is
 * untouched — it is not a BrainProvider and never passes through this path. `persist` defaults to
 * true (the live toggle writes the choice); startup restore passes false (the value already came
 * from disk — no need to rewrite it).
 */
export function applySettings(brain: BrainSelection, persist = true): void {
  currentBrain = brain;
  setBrain(brain === 'local' ? new LocalBrain() : new ClaudeBrain());
  if (persist) persistBrain(brain);
}

/**
 * Restore a previously-persisted brain on daemon startup. A no-op when nothing was saved — the
 * loop keeps its default brain (behavior-preserving for a fresh install / never-toggled owner).
 */
export function restorePersistedBrain(): void {
  const saved = loadPersistedBrain();
  if (saved) applySettings(saved, false);
}
