/**
 * presets.ts — preset selection for the morning brief (ROUT-02).
 *
 * CHOSEN SHAPE (documented in 04-01-SUMMARY): the YAML carries a `presets:` MAP
 * (preset-name → list of step ids that preset turns on) PLUS the full `steps:`
 * catalogue. A step runs for the active preset only when BOTH:
 *   (a) `step.enabled` is true (the owner can hard-disable a step everywhere), AND
 *   (b) the active preset's id list contains `step.id`.
 *
 * This keeps per-step config (order/tier/params) in ONE place (`steps`) while a
 * preset re-shapes the brief by naming a subset — no duplicated step blocks. If a
 * preset has no entry in the map (or the map is absent), the preset falls back to
 * "all enabled steps" so a minimal config still runs.
 */
import type { PresetName, RoutineStep } from './engine.js';

/**
 * Return the steps that should run for `preset`, in no particular order (the engine
 * sorts by `order`). Filters to enabled steps that the preset's id list includes; if
 * the preset names no ids, every enabled step runs.
 */
export function stepsForPreset(
  preset: PresetName,
  steps: RoutineStep[],
  presets: Record<string, string[]> | undefined,
): RoutineStep[] {
  const enabled = steps.filter((s) => s.enabled);
  const allow = presets?.[preset];
  if (!allow || allow.length === 0) return enabled;
  const allowSet = new Set(allow);
  return enabled.filter((s) => allowSet.has(s.id));
}
