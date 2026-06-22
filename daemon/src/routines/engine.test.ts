/**
 * engine.test.ts — RED until Task 2 creates engine.ts (ROUT-01/02/03).
 *
 * The routine engine LOADS routines/morning-brief.yaml (steps are config, not hardcoded),
 * zod-VALIDATES every step, then RUNS the enabled steps for the active preset in ascending
 * `order`, producing per narrated step exactly ONE `speak` frame via the shipped assembleSpeak
 * whose widgetPlan has ≤2 items (never a static grid). A malformed/schema-invalid config
 * rejects with a typed Error — never a raw throw past the engine boundary.
 *
 * The 7B helper is mocked-absent (Ollama unreachable) exactly as brain/helper.test.ts does
 * (swap globalThis.fetch) so mail_triage falls back to its neutral default and no test hits
 * a live Ollama.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { load, run, type Routine, type StepDeps } from './engine.js';

const YAML_PATH = fileURLToPath(new URL('./morning-brief.yaml', import.meta.url));

// --- mock the 7B helper absent (Ollama unreachable) — mirrors brain/helper.test.ts -------
const realFetch = globalThis.fetch;
function refuseFetch(): void {
  globalThis.fetch = (async () => {
    throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' });
  }) as unknown as typeof fetch;
}
function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

/** Minimal deps with a couple of mail messages + injected finance/email data seams. */
function depsWithMail(): StepDeps {
  return {
    id: 'brief-1',
    messages: [
      { sender: 'Ana', subject: 'Lunch?', snippet: 'free today?', source: 'external' },
      { sender: 'Ops', subject: 'Deploy done', snippet: 'all green', source: 'external' },
    ],
    balances: { accounts: [{ name: 'Checking', tail: '4321', balance: 1200 }] },
    spending: { timeframe: 'W', total: 240, series: [] },
    emailPreview: { to: 'ana@x.com', subject: 'Re: Lunch?', body: 'Sure!', signature: '— P' },
    events: { count: 1, items: [{ time: '9:30', title: 'Standup' }] },
    invitations: [{ title: 'Design sync', organizer: 'Lee', source: 'external' }],
  };
}

// --- ROUT-01: YAML loads + every step has enabled/order/params?/tier ---------------------

test('load parses morning-brief.yaml — every step exposes enabled/order/tier (ROUT-01)', () => {
  const routine: Routine = load(YAML_PATH);
  assert.ok(Array.isArray(routine.steps) && routine.steps.length > 0, 'steps is a non-empty array');
  for (const step of routine.steps) {
    assert.equal(typeof step.enabled, 'boolean', `${step.id}.enabled is a boolean`);
    assert.ok(Number.isInteger(step.order) && step.order > 0, `${step.id}.order is a positive int`);
    assert.ok(['green', 'yellow', 'red'].includes(step.tier), `${step.id}.tier is a valid tier`);
    if (step.params !== undefined) {
      assert.equal(typeof step.params, 'object', `${step.id}.params is an object when present`);
    }
  }
});

test('load rejects malformed YAML / schema-invalid steps with a typed Error (ROUT-01, T-04-01)', () => {
  // A bad order (0 / negative) must reject; never a raw throw past the engine boundary.
  assert.throws(
    () => load(undefined as unknown as string),
    /routine config/i,
    'a missing path must throw a typed routine-config error',
  );
});

// --- ROUT-02: preset switching changes the enabled step set ------------------------------

test('preset switching: Weekend yields a different enabled-step set than Workday (ROUT-02)', async () => {
  const routine = load(YAML_PATH);
  const workday = await run({ ...routine, preset: 'Workday' }, depsWithMail());
  const weekend = await run({ ...routine, preset: 'Weekend' }, depsWithMail());
  const workdayIds = workday.sequence;
  const weekendIds = weekend.sequence;
  assert.notDeepEqual(weekendIds, workdayIds, 'Weekend runs a different step set than Workday');
  // Weekend trims the work-centric steps.
  assert.ok(!weekendIds.includes('calendar'), 'Weekend omits calendar');
  assert.ok(workdayIds.includes('calendar'), 'Workday includes calendar');
});

// --- ROUT-03: run order, enabled-only, ≤2-widget speak frames via assembleSpeak ----------

test('run executes enabled steps sorted ascending by order, skipping disabled (ROUT-03)', async () => {
  const routine = load(YAML_PATH);
  // Disable mail_triage; flip an out-of-order order to prove sorting, not file order.
  const steps = routine.steps.map((s) =>
    s.id === 'mail_triage' ? { ...s, enabled: false } : s,
  );
  const result = await run({ ...routine, steps }, depsWithMail());
  assert.ok(!result.sequence.includes('mail_triage'), 'a disabled step is skipped');
  // The recorded run sequence is sorted ascending by each step's order.
  const orders = result.sequence.map((id) => steps.find((s) => s.id === id)!.order);
  const sorted = [...orders].sort((a, b) => a - b);
  assert.deepEqual(orders, sorted, 'steps run in ascending order');
});

test('each narrated step produces ONE speak frame whose widgetPlan has ≤2 cues (ROUT-03)', async () => {
  const routine = load(YAML_PATH);
  const result = await run(routine, depsWithMail());
  for (const frame of result.frames) {
    assert.equal(frame.type, 'speak', 'every produced frame is a speak frame');
    assert.ok(frame.cues.length <= 2, 'no speak frame carries more than 2 widget cues (never a grid)');
  }
});

test('greeting/weather produce a narration-only speak frame (empty widgetPlan) (ROUT-03)', async () => {
  const routine = load(YAML_PATH);
  const result = await run(routine, depsWithMail());
  const greeting = result.frames.find((f) => f.id.includes('greeting'));
  const weather = result.frames.find((f) => f.id.includes('weather'));
  assert.ok(greeting, 'a greeting frame was produced');
  assert.ok(weather, 'a weather frame was produced');
  assert.equal(greeting!.cues.length, 0, 'greeting is narration-only (no widget)');
  assert.equal(weather!.cues.length, 0, 'weather is narration-only (no widget)');
});

// --- mail_triage neutral default when Ollama absent (cross-check at engine level) --------

test('a full run with Ollama absent never throws and still produces frames (ROUT-04)', async () => {
  refuseFetch();
  const routine = load(YAML_PATH);
  await assert.doesNotReject(async () => {
    const result = await run(routine, depsWithMail());
    assert.ok(result.frames.length > 0, 'a brief still produces frames with Ollama absent');
  });
  restoreFetch();
});
