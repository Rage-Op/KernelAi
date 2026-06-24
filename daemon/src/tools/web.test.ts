/**
 * web.test.ts (WS-B) — the read-only internet tool.
 *
 * Asserts: search returns tiny external-tagged hits; fetch returns external-tagged page text; a
 * second identical search is served from cache (no extra backend call); a missing key escalates;
 * the tool's ops classify GREEN so the gate allows them without a prompt; bad args are rejected.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  webTool,
  webArgsSchema,
  __setWebBackendForTest,
  __clearWebCacheForTest,
  type WebBackend,
} from './web.js';
import { classifyTier } from '../safety/tiers.js';

/** A counting mock backend. */
function mockBackend(): WebBackend & { searches: number; fetches: number } {
  return {
    searches: 0,
    fetches: 0,
    async search(query, max) {
      this.searches += 1;
      return Array.from({ length: max }, (_, i) => ({
        title: `Result ${i} for ${query}`,
        url: `https://example.com/${i}`,
        snippet: 'snippet text',
        source: 'external' as const,
      }));
    },
    async fetch(url) {
      this.fetches += 1;
      return { url, content: 'cleaned page text', source: 'external' as const };
    },
  };
}

test('search returns external-tagged hits and is served from cache on repeat', async () => {
  __clearWebCacheForTest();
  const be = mockBackend();
  __setWebBackendForTest(be);

  const r1 = await webTool.execute({ op: 'search', query: 'latest mac mini price', max_results: 3 });
  assert.equal(r1.ok, true);
  const data = r1.data as { results: Array<{ source: string }>; source: string };
  assert.equal(data.results.length, 3);
  assert.equal(data.source, 'external', 'payload tagged external (untrusted data)');
  assert.ok(data.results.every((x) => x.source === 'external'), 'every hit tagged external');
  assert.equal(be.searches, 1);

  // identical query → cache hit, no second backend call
  await webTool.execute({ op: 'search', query: 'latest mac mini price', max_results: 3 });
  assert.equal(be.searches, 1, 'second identical search served from cache');

  __setWebBackendForTest(null);
  __clearWebCacheForTest();
});

test('fetch returns external-tagged cleaned text', async () => {
  __clearWebCacheForTest();
  const be = mockBackend();
  __setWebBackendForTest(be);

  const r = await webTool.execute({ op: 'fetch', url: 'https://example.com/article' });
  assert.equal(r.ok, true);
  const page = r.data as { content: string; source: string };
  assert.equal(page.content, 'cleaned page text');
  assert.equal(page.source, 'external');

  __setWebBackendForTest(null);
  __clearWebCacheForTest();
});

test('missing backend config escalates (does not throw)', async () => {
  __setWebBackendForTest(null);
  const prevKey = process.env.TAVILY_API_KEY;
  const prevBackend = process.env.KERNEL_WEB_BACKEND;
  delete process.env.TAVILY_API_KEY;
  delete process.env.KERNEL_WEB_BACKEND;

  const r = await webTool.execute({ op: 'search', query: 'anything' });
  assert.equal(r.ok, false);
  assert.match(r.escalation!.reason, /Tavily API key|kernel\.env/i);

  if (prevKey !== undefined) process.env.TAVILY_API_KEY = prevKey;
  if (prevBackend !== undefined) process.env.KERNEL_WEB_BACKEND = prevBackend;
});

test('web ops classify GREEN (gate allows read-only lookups without a prompt)', () => {
  assert.equal(classifyTier({ tool: 'web', args: { op: 'search' } }), 'green');
  assert.equal(classifyTier({ tool: 'web', args: { op: 'fetch' } }), 'green');
});

test('schema rejects unknown keys and bad ops', () => {
  assert.equal(webArgsSchema.safeParse({ op: 'search', query: 'x' }).success, true);
  assert.equal(webArgsSchema.safeParse({ op: 'delete', query: 'x' }).success, false, 'bad op rejected');
  assert.equal(
    webArgsSchema.safeParse({ op: 'search', query: 'x', secret: 'y' }).success,
    false,
    'unknown key rejected (no smuggling)',
  );
});
