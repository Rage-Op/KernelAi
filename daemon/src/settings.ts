/**
 * settings.ts — the brain=cloud|local Settings path.
 *
 * `applySettings(brain)` swaps the ACTIVE brain via the EXISTING `loop.setBrain` seam — it does
 * NOT touch the loop's queue/drain/gate semantics. `local` → LocalBrain (Ollama), `cloud` →
 * ClaudeBrain (the default). The always-on 7B helper (`brain/helper.ts`) is a standalone module,
 * NOT a BrainProvider, and runs regardless of this toggle (BRAIN-03 / BRAIN-05).
 *
 * Wired into the IPC path additively: the server's `settings` frame arm calls `applySettings`.
 */
import { setBrain } from './loop.js';
import { ClaudeBrain } from './brain/ClaudeBrain.js';
import { LocalBrain } from './brain/LocalBrain.js';

/** The current Settings selection. ClaudeBrain (cloud) is the default (BRAIN-02). */
let currentBrain: 'cloud' | 'local' = 'cloud';

/** Read the current brain selection (test/inspection seam). */
export function currentBrainSelection(): 'cloud' | 'local' {
  return currentBrain;
}

/**
 * Apply a brain selection by swapping the active BrainProvider via `setBrain`. The 7B helper is
 * untouched — it is not a BrainProvider and never passes through this path.
 */
export function applySettings(brain: 'cloud' | 'local'): void {
  currentBrain = brain;
  setBrain(brain === 'local' ? new LocalBrain() : new ClaudeBrain());
}
