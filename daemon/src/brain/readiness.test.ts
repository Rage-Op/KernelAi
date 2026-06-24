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
