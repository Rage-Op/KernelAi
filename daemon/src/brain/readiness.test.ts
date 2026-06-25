/**
 * readiness.test.ts (BRAIN-07) — model warm-up state machine. A FAKE LM Studio (injected fetch) drives
 * every path: cloud → instant ready; LM Studio up + a model loaded → loading→ready; server down / no
 * model loaded → error with an actionable detail. No real LM Studio, no network.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  warmupActiveBrain,
  setModelBroadcast,
  getModelState,
  probeLmStudio,
  __resetModelStateForTest,
  type ModelState,
} from './readiness.js';

afterEach(() => __resetModelStateForTest());

/** Capture every broadcast state transition. */
function captureStates(): ModelState[] {
  const states: ModelState[] = [];
  setModelBroadcast((s) => states.push(s));
  return states;
}

test('cloud brain reports ready immediately (no local load)', async () => {
  const states = captureStates();
  const s = await warmupActiveBrain('cloud');
  assert.equal(s.status, 'ready');
  assert.equal(s.brain, 'cloud');
  assert.equal(getModelState().status, 'ready');
  assert.ok(states.some((x) => x.status === 'ready'));
});

/** A fake LM Studio server as an injectable fetch. Answers both the native (`/api/v0|v1/models`) and
 *  OpenAI (`/v1/models`) list endpoints; `models` is the loaded inventory the resolver/probe see. */
function fakeLmStudio(
  opts: { up?: boolean; models?: Array<{ id: string; state?: string }> } = {},
): typeof fetch {
  const { up = true, models = [{ id: 'mlx-community/Qwen3-8B', state: 'loaded' }] } = opts;
  return (async (url: string | URL) => {
    if (!up) throw new Error('ECONNREFUSED');
    const u = String(url);
    if (u.endsWith('/models')) {
      // Native v1 reports `loaded_instances`; v0/OpenAI report a flat `data` array with `state`.
      const v1 = models.map((m) => ({ key: m.id, loaded_instances: m.state === 'loaded' ? [{ id: m.id }] : [] }));
      return new Response(JSON.stringify({ models: v1, data: models }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
}

test('lmstudio: server up + model loaded → loading…→ ready (model carried)', async () => {
  const states = captureStates();
  const s = await warmupActiveBrain('lmstudio', { fetchImpl: fakeLmStudio(), baseUrl: 'http://x' });
  assert.equal(s.status, 'ready');
  assert.equal(s.brain, 'lmstudio');
  assert.equal(s.model, 'mlx-community/Qwen3-8B');
  assert.ok(states.some((x) => x.status === 'loading'), 'emits a loading state first');
  assert.equal(states.at(-1)!.status, 'ready');
});

test('lmstudio: server down → error (start the server)', async () => {
  const s = await warmupActiveBrain('lmstudio', { fetchImpl: fakeLmStudio({ up: false }), baseUrl: 'http://x' });
  assert.equal(s.status, 'error');
  assert.match(s.detail!, /isn't running|lms server start/i);
});

test('lmstudio: server up but no model loaded → error (load a model)', async () => {
  const s = await warmupActiveBrain('lmstudio', { fetchImpl: fakeLmStudio({ models: [] }), baseUrl: 'http://x' });
  assert.equal(s.status, 'error');
  assert.match(s.detail!, /no model is loaded/i);
});

test('probeLmStudio tolerates a thrown fetch (never crash warm-up)', async () => {
  const bad = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
  assert.equal(await probeLmStudio('http://x', bad), false);
});

test('a superseded warm-up cannot clobber a newer one (generation guard)', async () => {
  const states = captureStates();
  // A SLOW lmstudio warm-up whose first probe hangs until we release it; after release it answers with
  // an EMPTY inventory (→ the warm-up resolves to an error emit that the guard must DROP, since a newer
  // cloud warm-up has taken over).
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  let first = true;
  const slowFetch = (async (url: string | URL) => {
    if (first) { first = false; await gate; } // park the first probe until released
    const u = String(url);
    if (u.endsWith('/models')) return new Response(JSON.stringify({ models: [], data: [] }), { status: 200 });
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;

  // Start the slow lmstudio warm-up (don't await), then a NEWER cloud warm-up supersedes it.
  const slow = warmupActiveBrain('lmstudio', { fetchImpl: slowFetch, baseUrl: 'http://x' });
  await warmupActiveBrain('cloud');
  assert.equal(getModelState().brain, 'cloud');
  assert.equal(getModelState().status, 'ready');

  // Release the stale warm-up — its terminal emit must be DROPPED (older generation), not clobber cloud.
  release();
  await slow;
  assert.equal(getModelState().brain, 'cloud', 'stale lmstudio warm-up did not clobber the active cloud state');
  assert.equal(getModelState().status, 'ready');
  assert.ok(
    !states.slice(states.findIndex((s) => s.brain === 'cloud')).some((s) => s.brain === 'lmstudio'),
    'no lmstudio state is broadcast after cloud took over',
  );
});
