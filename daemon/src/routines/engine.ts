/**
 * engine.ts — the morning-brief routine engine (ROUT-01/02/03).
 *
 * `load(yamlPath)` parses routines/morning-brief.yaml with `yaml` and validates it against a
 * zod RoutineSchema. The brief is CONFIG, not code: the engine reads the step list from the YAML
 * — no step is hardcoded here (ROUT-01). A malformed/schema-invalid config rejects with a TYPED
 * Error, never a raw throw past this boundary (T-04-01).
 *
 * `run(routine, deps)` resolves the active preset's enabled step subset (ROUT-02), sorts it
 * ascending by `order`, runs each step's handler serially, and per narrated step wraps its
 * { narration, widgetPlan } into ONE `speak` frame via the SHIPPED assembleSpeak (≤2 widget cues
 * — never a static grid, ROUT-03). It pushes `widget.data` frames FIRST (fill), then the speak
 * frame — mirroring cues.ts Pattern 2. Any emitted ToolCall envelope is collected for the loop to
 * dispatch through registry.dispatch → gate.authorize (the engine NEVER self-classifies the tier).
 *
 * ANTI-BYPASS: this module does NOT import safety/gate.ts or safety/tiers.ts.
 */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

import { assembleSpeak, type WidgetPlanItem } from '../ipc/cues.js';
import type { Speak, WidgetData } from '../ipc/protocol.js';
import type { ToolCall } from '../brain/BrainProvider.js';
import { logger } from '../memory/log.js';
import { handlers, type StepDeps, type StepResult } from './steps.js';
import { stepsForPreset } from './presets.js';

const log = logger.child({ mod: 'routines/engine' });

// --- Schema (zod-validate every step; spec §11 / 04-RESEARCH Code Examples) --------------

export const PRESET_NAMES = ['Workday', 'Weekend', 'Travel'] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

const STEP_IDS = [
  'greeting',
  'weather',
  'calendar',
  'invitations',
  'mail_triage',
  'unread_announce',
  'email_reply',
  'balances',
  'spending',
] as const;

const StepSchema = z.object({
  id: z.enum(STEP_IDS),
  order: z.number().int().positive(),
  enabled: z.boolean(),
  tier: z.enum(['green', 'yellow', 'red']),
  params: z.record(z.string(), z.unknown()).optional(),
});

const RoutineSchema = z.object({
  preset: z.enum(PRESET_NAMES),
  presets: z.record(z.string(), z.array(z.string())).optional(),
  steps: z.array(StepSchema).min(1),
});

export type RoutineStep = z.infer<typeof StepSchema>;
export type Routine = z.infer<typeof RoutineSchema>;

// Re-export the step seam so callers import the engine surface from one place.
export type { StepDeps, StepResult } from './steps.js';

/** A typed routine-config error — load() never lets a raw parse/validation error escape. */
export class RoutineConfigError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(`routine config: ${message}`);
    this.name = 'RoutineConfigError';
  }
}

// --- load --------------------------------------------------------------------------------

/**
 * Load + validate the routine config. Any read/parse/validation failure becomes a typed
 * RoutineConfigError (never a raw throw past the engine boundary — T-04-01).
 */
export function load(yamlPath: string): Routine {
  if (!yamlPath || typeof yamlPath !== 'string') {
    throw new RoutineConfigError('a yaml path string is required');
  }
  let raw: string;
  try {
    raw = readFileSync(yamlPath, 'utf8');
  } catch (err) {
    throw new RoutineConfigError(`cannot read ${yamlPath}`, err);
  }
  let doc: unknown;
  try {
    doc = parse(raw);
  } catch (err) {
    throw new RoutineConfigError('YAML failed to parse', err);
  }
  const parsed = RoutineSchema.safeParse(doc);
  if (!parsed.success) {
    throw new RoutineConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), parsed.error);
  }
  return parsed.data;
}

// --- run ---------------------------------------------------------------------------------

/** The frames + envelopes a run produced, plus the recorded run sequence (for tests/logs). */
export interface RunResult {
  /** The step ids actually run, in run order. */
  sequence: string[];
  /** The speak frames produced, one per narrated step (ROUT-03). */
  frames: Speak[];
  /** The widget.data frames produced (pushed before each speak frame). */
  widgetData: WidgetData[];
  /** ToolCall envelopes the loop must dispatch through the gate (e.g. an invitation reply). */
  toolCalls: ToolCall[];
}

/**
 * Run the active preset's enabled steps in ascending `order`, serially. Per narrated step:
 *   1. run the step handler (async)
 *   2. push a `widget.data` frame per planned widget that carries data (fill — Pattern 2)
 *   3. wrap { narration, widgetPlan } into ONE speak frame via assembleSpeak (≤2 cues)
 *   4. collect any emitted ToolCall envelope for the loop to dispatch (gate runs there)
 */
export async function run(routine: Routine, deps: StepDeps): Promise<RunResult> {
  const active = stepsForPreset(routine.preset, routine.steps, routine.presets);
  const ordered = [...active].sort((a, b) => a.order - b.order);

  const sequence: string[] = [];
  const frames: Speak[] = [];
  const widgetData: WidgetData[] = [];
  const toolCalls: ToolCall[] = [];

  for (const step of ordered) {
    const handler = handlers[step.id];
    if (!handler) {
      // Unknown handler for a validated id is impossible, but degrade gracefully (never throw).
      log.warn({ step: step.id }, 'no handler for step — skipping');
      continue;
    }
    const result: StepResult = await handler(deps, step.params ?? {});

    // Cap the widget plan at 2 — defensive against a handler over-planning (ROUT-03, never a grid).
    const plan: WidgetPlanItem[] = result.widgetPlan.slice(0, 2);

    // 2. fill: push a widget.data frame per planned widget carrying data (Pattern 2 ordering).
    for (const item of plan) {
      if (item.data !== undefined) {
        widgetData.push({ type: 'widget.data', widget: item.widget, data: item.data });
      }
    }

    // 3. ONE speak frame via the shipped assembleSpeak (char-offset cues; no daemon timing).
    const frameId = `${deps.id}:${step.id}`;
    frames.push(assembleSpeak(frameId, result.narration, plan));

    // 4. collect a ToolCall envelope (the loop dispatches it through the gate — never here).
    if (result.toolCall) toolCalls.push(result.toolCall);

    sequence.push(step.id);
    log.info({ step: step.id, tier: step.tier, widgets: plan.map((p) => p.widget) }, 'ran routine step');
  }

  return { sequence, frames, widgetData, toolCalls };
}
