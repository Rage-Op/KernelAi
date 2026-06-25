/**
 * settings.ts — the brain=cloud|lmstudio Settings path.
 *
 * `applySettings(brain)` swaps the ACTIVE brain via the EXISTING `loop.setBrain` seam — it does
 * NOT touch the loop's queue/drain/gate semantics. `lmstudio` → LMStudioBrain (the LOCAL engine —
 * LM Studio's OpenAI-compatible server, runs MLX or GGUF), `cloud` → ClaudeBrain. The always-on
 * helper (`brain/helper.ts`) is a standalone module, NOT a BrainProvider, and runs regardless of
 * this toggle (BRAIN-03 / BRAIN-05). (The former Ollama `local` engine was removed — a persisted
 * `local` choice is migrated to `lmstudio` on load.)
 *
 * Wired into the IPC path additively: the server's `settings` frame arm calls `applySettings`.
 *
 * Persistence (CLOUD-01): the selection is written to a tiny JSON file in the daemon's
 * Application Support dir — NOT the git-backed memory repo, because it is a UI preference, not a
 * memory, and must never be backed up. On daemon startup `restorePersistedBrain()` re-applies the
 * saved choice so a launchd relaunch keeps the owner's brain. The file path is injectable so tests
 * never touch the real Application Support dir (mirrors safety/spend-ledger.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { setBrain } from './loop.js';
import { ClaudeBrain } from './brain/ClaudeBrain.js';
import { LMStudioBrain } from './brain/LMStudioBrain.js';
import { config } from './config.js';
import { logger } from './memory/log.js';

/** The brain selection surfaced by the Settings toggle: the LOCAL engine (`lmstudio` — LM Studio's
 *  OpenAI-compatible server, MLX or GGUF) or `cloud` (Claude). */
export type BrainSelection = 'cloud' | 'lmstudio';

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
 * Where the brain preference persists across daemon restarts: `brain.json` in the daemon's
 * Application Support dir, NOT the memory repo (never backed up).
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
    if (parsed.brain === 'cloud' || parsed.brain === 'lmstudio') return parsed.brain;
    // Migrate a previously-persisted Ollama `local` choice to LM Studio (the local engine now).
    if (parsed.brain === 'local') return 'lmstudio';
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
  setBrain(brain === 'lmstudio' ? new LMStudioBrain() : new ClaudeBrain());
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
