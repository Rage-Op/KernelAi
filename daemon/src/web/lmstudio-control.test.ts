import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  listLmStudioModels,
  loadLmStudioModel,
  unloadLmStudioModel,
} from './lmstudio-control.js';

/**
 * These tests stub the GLOBAL fetch so they never touch a real LM Studio. The original fetch is saved
 * and restored around every test, so other suites that rely on the real global are unaffected.
 *
 * The module talks to LM Studio's native v1 REST API on the default base http://localhost:1234, i.e.:
 *   GET  http://localhost:1234/api/v1/models
 *   POST http://localhost:1234/api/v1/models/load
 *   POST http://localhost:1234/api/v1/models/unload
 */

const ORIGINAL_FETCH = globalThis.fetch;

/** Records of the fetch calls a single test made, so assertions can inspect URL/method/body. */
interface FetchCall {
  url: string;
  method: string;
  body?: string;
}

let calls: FetchCall[];

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  // Restore the real global fetch no matter what, so sibling suites are unaffected.
  globalThis.fetch = ORIGINAL_FETCH;
});

/** A canned 200 JSON Response. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/**
 * Install a fetch stub. `routes` decides the response for a given (url, method); the stub records every
 * call and throws if a route is missing, so we are forced to handle every fetch the code makes.
 */
function stubFetch(routes: (url: string, method: string) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : undefined;
    calls.push({ url, method, body });
    return await routes(url, method);
  }) as typeof fetch;
}

const MODELS_URL = 'http://localhost:1234/api/v1/models';
const LOAD_URL = 'http://localhost:1234/api/v1/models/load';
const UNLOAD_URL = 'http://localhost:1234/api/v1/models/unload';

/** A models-list body with one loaded LLM (a/b) plus an embeddings entry that must be filtered out. */
function modelsBody() {
  return {
    models: [
      {
        type: 'llm',
        key: 'a/b',
        display_name: 'AB',
        format: 'mlx',
        size_bytes: 1,
        params_string: '9B',
        max_context_length: 1000,
        loaded_instances: [{ id: 'a/b', config: { context_length: 512 } }],
        capabilities: { trained_for_tool_use: true, reasoning: {} },
      },
      { type: 'embeddings', key: 'emb', display_name: 'E' },
    ],
  };
}

test('listLmStudioModels: network error -> { serverUp:false, models:[] }', async () => {
  stubFetch(() => {
    throw new TypeError('fetch failed');
  });
  const inv = await listLmStudioModels();
  assert.deepEqual(inv, { serverUp: false, models: [] });
});

test('listLmStudioModels: maps v1 body, filters embeddings, surfaces loaded/caps', async () => {
  stubFetch((url, method) => {
    assert.equal(url, MODELS_URL);
    assert.equal(method, 'GET');
    return json(modelsBody());
  });

  const inv = await listLmStudioModels();
  assert.equal(inv.serverUp, true);
  assert.equal(inv.models.length, 1); // embeddings filtered out

  const m = inv.models[0];
  assert.equal(m.key, 'a/b');
  assert.equal(m.loaded, true);
  assert.equal(m.instanceId, 'a/b');
  assert.equal(m.loadedContextLength, 512);
  assert.equal(m.toolUse, true);
  assert.equal(m.reasoning, true);
  assert.equal(m.maxContextLength, 1000);
});

test('loadLmStudioModel: unknown key -> refuses, never POSTs to load', async () => {
  stubFetch((url, method) => {
    if (url === MODELS_URL && method === 'GET') return json(modelsBody());
    // Any other call (i.e. a load POST) is a failure for this test.
    throw new Error(`unexpected fetch ${method} ${url}`);
  });

  const out = await loadLmStudioModel('unknown', 8192);
  assert.match(out, /unknown model/);

  // The load endpoint must never have been called.
  assert.equal(calls.some((c) => c.url === LOAD_URL), false);
  // Only the inventory GET happened.
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url}`),
    [`GET ${MODELS_URL}`],
  );
});

test('unloadLmStudioModel: present-but-not-loaded key -> refuses, never POSTs to unload', async () => {
  // Same model body but with no loaded instances, so the key exists yet is not loaded.
  const notLoaded = {
    models: [
      {
        type: 'llm',
        key: 'a/b',
        display_name: 'AB',
        format: 'mlx',
        size_bytes: 1,
        params_string: '9B',
        max_context_length: 1000,
        loaded_instances: [],
        capabilities: { trained_for_tool_use: true, reasoning: {} },
      },
    ],
  };

  stubFetch((url, method) => {
    if (url === MODELS_URL && method === 'GET') return json(notLoaded);
    throw new Error(`unexpected fetch ${method} ${url}`);
  });

  const out = await unloadLmStudioModel('a/b');
  assert.match(out, /not loaded/);
  assert.equal(calls.some((c) => c.url === UNLOAD_URL), false);
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url}`),
    [`GET ${MODELS_URL}`],
  );
});

test('loadLmStudioModel: known key -> POSTs to load with { model: key } and resolves /Loaded/', async () => {
  stubFetch((url, method) => {
    if (url === MODELS_URL && method === 'GET') return json(modelsBody());
    if (url === LOAD_URL && method === 'POST') return json({ ok: true });
    throw new Error(`unexpected fetch ${method} ${url}`);
  });

  const out = await loadLmStudioModel('a/b');
  assert.match(out, /Loaded/);

  const loadCall = calls.find((c) => c.url === LOAD_URL && c.method === 'POST');
  assert.ok(loadCall, 'expected a POST to the load endpoint');
  assert.ok(loadCall.body, 'expected a JSON body on the load POST');
  const sent = JSON.parse(loadCall.body) as { model?: string };
  assert.equal(sent.model, 'a/b');
});
