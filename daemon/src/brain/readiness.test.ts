/**
 * readiness.test.ts (BRAIN-07) — model warm-up state machine. A FAKE Ollama (injected fetch) drives
 * every path: cloud → instant ready; local up+installed → loading→ready; Ollama down / model missing /
 * load failed → error with an actionable detail. No real Ollama, no network.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  warmupActiveBrain,
  setModelBroadcast,
  getModelState,
  probeOllama,
  probeLmStudio,
  installedModels,
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

/** A fake Ollama server as an injectable fetch. */
function fakeOllama(opts: { up?: boolean; models?: string[]; loadOk?: boolean } = {}): typeof fetch {
  const { up = true, models = ['qwen3.5:9b'], loadOk = true } = opts;
  return (async (url: string | URL) => {
    if (!up) throw new Error('ECONNREFUSED');
    const u = String(url);
    if (u.endsWith('/api/tags')) {
      return new Response(JSON.stringify({ models: models.map((name) => ({ name })) }), { status: 200 });
    }
    if (u.endsWith('/api/generate')) {
      return new Response(JSON.stringify({ done: true, done_reason: 'load' }), { status: loadOk ? 200 : 500 });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
}

test('cloud brain reports ready immediately (no local load)', async () => {
  const states = captureStates();
  const s = await warmupActiveBrain('cloud');
  assert.equal(s.status, 'ready');
  assert.equal(s.brain, 'cloud');
  assert.equal(getModelState().status, 'ready');
  assert.ok(states.some((x) => x.status === 'ready'));
});

test('local: Ollama up + model installed → loading…→ ready (model tag carried)', async () => {
  const states = captureStates();
  const s = await warmupActiveBrain('local', { fetchImpl: fakeOllama(), model: 'qwen3.5:9b', baseUrl: 'http://x' });
  assert.equal(s.status, 'ready');
  assert.equal(s.brain, 'local');
  assert.equal(s.model, 'qwen3.5:9b');
  assert.ok(states.some((x) => x.status === 'loading'), 'emits at least one loading state first');
  assert.equal(states.at(-1)!.status, 'ready', 'terminal state is ready');
});

test('local: Ollama down → error with an actionable detail (start ollama)', async () => {
  const s = await warmupActiveBrain('local', { fetchImpl: fakeOllama({ up: false }), baseUrl: 'http://x' });
  assert.equal(s.status, 'error');
  assert.match(s.detail!, /ollama serve|isn't running/i);
});

test('local: model not installed → error with the pull hint', async () => {
  const s = await warmupActiveBrain('local', {
    fetchImpl: fakeOllama({ models: ['llama3:8b'] }),
    model: 'qwen3.5:9b',
    baseUrl: 'http://x',
  });
  assert.equal(s.status, 'error');
  assert.match(s.detail!, /ollama pull qwen3\.5:9b/);
});

test('local: model present but load fails → error', async () => {
  const s = await warmupActiveBrain('local', {
    fetchImpl: fakeOllama({ loadOk: false }),
    model: 'qwen3.5:9b',
    baseUrl: 'http://x',
  });
  assert.equal(s.status, 'error');
  assert.match(s.detail!, /failed to load/i);
});

test('probeOllama / installedModels tolerate a thrown fetch (never crash warm-up)', async () => {
  const bad = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
  assert.equal(await probeOllama('http://x', bad), false);
  assert.deepEqual(await installedModels('http://x', bad), []);
});

/** A fake LM Studio (OpenAI-compatible) server as an injectable fetch. */
function fakeLmStudio(
  opts: { up?: boolean; models?: Array<{ id: string; state?: string }> } = {},
): typeof fetch {
  const { up = true, models = [{ id: 'mlx-community/Qwen3-8B', state: 'loaded' }] } = opts;
  return (async (url: string | URL) => {
    if (!up) throw new Error('ECONNREFUSED');
    const u = String(url);
    if (u.endsWith('/api/v0/models') || u.endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: models }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
}

test('lmstudio: server up + model loaded → loading…→ ready (model carried)', async () => {
  const states = captureStates();
  const s = await warmupActiveBrain('lmstudio', { fetchImpl: fakeLmStudio() });
  assert.equal(s.status, 'ready');
  assert.equal(s.brain, 'lmstudio');
  assert.equal(s.model, 'mlx-community/Qwen3-8B');
  assert.ok(states.some((x) => x.status === 'loading'), 'emits a loading state first');
  assert.equal(states.at(-1)!.status, 'ready');
});

test('lmstudio: server down → error (start the server)', async () => {
  const s = await warmupActiveBrain('lmstudio', { fetchImpl: fakeLmStudio({ up: false }) });
  assert.equal(s.status, 'error');
  assert.match(s.detail!, /isn't running|lms server start/i);
});

test('lmstudio: server up but no model loaded → error (load a model)', async () => {
  const s = await warmupActiveBrain('lmstudio', { fetchImpl: fakeLmStudio({ models: [] }) });
  assert.equal(s.status, 'error');
  assert.match(s.detail!, /no model is loaded/i);
});

test('probeLmStudio tolerates a thrown fetch (never crash warm-up)', async () => {
  const bad = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
  assert.equal(await probeLmStudio('http://x', bad), false);
});

test('a superseded warm-up cannot clobber a newer one (generation guard)', async () => {
  const states = captureStates();
  // A SLOW local warm-up whose model load hangs until we release it.
  let releaseLoad: () => void = () => {};
  const slowFetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith('/api/tags')) {
      return new Response(JSON.stringify({ models: [{ name: 'qwen3.5:9b' }] }), { status: 200 });
    }
    if (u.endsWith('/api/generate')) {
      await new Promise<void>((r) => { releaseLoad = r; }); // hang inside loadModel
      return new Response('{}', { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;

  // Start the slow local warm-up (don't await), then a NEWER cloud warm-up supersedes it.
  const slow = warmupActiveBrain('local', { fetchImpl: slowFetch, model: 'qwen3.5:9b', baseUrl: 'http://x' });
  await warmupActiveBrain('cloud');
  assert.equal(getModelState().brain, 'cloud');
  assert.equal(getModelState().status, 'ready');

  // Release the stale load — its terminal emit must be DROPPED (older generation), not clobber cloud.
  releaseLoad();
  await slow;
  assert.equal(getModelState().brain, 'cloud', 'stale local warm-up did not clobber the active cloud state');
  assert.equal(getModelState().status, 'ready');
  assert.ok(
    !states.slice(states.findIndex((s) => s.brain === 'cloud')).some((s) => s.brain === 'local'),
    'no local state is broadcast after cloud took over',
  );
});
