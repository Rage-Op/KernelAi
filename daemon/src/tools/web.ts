/**
 * tools/web.ts (WS-B) — the registered READ-ONLY internet tool: how KERNEL stays up to date and
 * looks things up. Two ops, both reversible reads so classifyTier yields GREEN (see tiers.ts) and
 * the gate ALLOWS them without a prompt:
 *   - search(query)   → top {title, url, snippet} hits from a search backend
 *   - fetch(url)       → cleaned page text for one URL
 *
 * BACKEND is pluggable behind `KERNEL_WEB_BACKEND` (default 'tavily'): Tavily returns LLM-clean text
 * and bundles search+extract behind one key (fastest to reliable); a SearXNG adapter gives a
 * zero-cost / fully-private self-hosted posture. The Tavily key is read from the env only
 * (`TAVILY_API_KEY`, sourced from ~/.kernel.env — NEVER persisted to kernel-memory, never logged).
 *
 * PROVENANCE (T-03/T-04, leak/injection seam): every returned item is tagged `source:'external'`.
 * Web text is DATA, never instruction — the tool loop feeds it back as a `role:'tool'` observation
 * (A4), so a page that says "ignore your instructions" is read as content, not obeyed.
 *
 * ABSENT-TOLERANT: a missing key or a backend/network error returns a TYPED escalation — it never
 * throws across the dispatch boundary (mirroring LocalBrain's ECONNREFUSED handling).
 *
 * CACHE: a small in-memory TTL cache keyed on the normalized query/url spares an always-on daemon
 * from repeating identical lookups. Ephemeral (process-only) — never written to kernel-memory.
 */
import { z } from 'zod';

import { register } from './registry.js';
import type { Tool, ToolResult } from './Tool.js';
import { logger } from '../memory/log.js';

/** One search hit, shaped tiny to protect the small model's context window. */
export interface WebResult {
  title: string;
  url: string;
  snippet: string;
  /** Provenance: web content is untrusted DATA, never instruction. */
  source: 'external';
}

/** A fetched page's cleaned text. */
export interface WebPage {
  url: string;
  content: string;
  source: 'external';
}

/** The backend seam — Tavily (default) or SearXNG implement this; tests inject a mock. */
export interface WebBackend {
  search(query: string, maxResults: number): Promise<WebResult[]>;
  fetch(url: string): Promise<WebPage>;
}

/** Cap fetched/extracted bodies so a huge page can't blow the model's window. */
const MAX_FETCH_CHARS = 4000;
/** Cap each snippet (search results stay scannable for a 7-9B model). */
const MAX_SNIPPET_CHARS = 500;

// ─── Tavily backend (default) ───────────────────────────────────────────────

class TavilyBackend implements WebBackend {
  constructor(private readonly apiKey: string) {}

  async search(query: string, maxResults: number): Promise<WebResult[]> {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ query, max_results: maxResults, search_depth: 'basic' }),
    });
    if (!res.ok) throw new Error(`Tavily search HTTP ${res.status}`);
    const body = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
    return (body.results ?? []).slice(0, maxResults).map((r) => ({
      title: r.title ?? '(untitled)',
      url: r.url ?? '',
      snippet: (r.content ?? '').slice(0, MAX_SNIPPET_CHARS),
      source: 'external' as const,
    }));
  }

  async fetch(url: string): Promise<WebPage> {
    const res = await fetch('https://api.tavily.com/extract', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ urls: [url] }),
    });
    if (!res.ok) throw new Error(`Tavily extract HTTP ${res.status}`);
    const body = (await res.json()) as { results?: Array<{ url?: string; raw_content?: string }> };
    const first = body.results?.[0];
    return { url, content: (first?.raw_content ?? '').slice(0, MAX_FETCH_CHARS), source: 'external' };
  }
}

// ─── SearXNG backend (self-hosted, zero-cost/private) ────────────────────────

class SearxngBackend implements WebBackend {
  constructor(private readonly baseUrl: string) {}

  async search(query: string, maxResults: number): Promise<WebResult[]> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/search?q=${encodeURIComponent(query)}&format=json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`SearXNG search HTTP ${res.status}`);
    const body = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
    return (body.results ?? []).slice(0, maxResults).map((r) => ({
      title: r.title ?? '(untitled)',
      url: r.url ?? '',
      snippet: (r.content ?? '').slice(0, MAX_SNIPPET_CHARS),
      source: 'external' as const,
    }));
  }

  async fetch(url: string): Promise<WebPage> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch HTTP ${res.status}`);
    const html = await res.text();
    // Naive readability: strip scripts/styles/tags, collapse whitespace. Good enough for a lookup.
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { url, content: text.slice(0, MAX_FETCH_CHARS), source: 'external' };
  }
}

// ─── Backend selection + test seam ───────────────────────────────────────────

let backendOverride: WebBackend | null = null;

/** TEST-ONLY seam: inject a mock backend (or null to reset to env-driven selection). */
export function __setWebBackendForTest(mock: WebBackend | null): void {
  backendOverride = mock;
}

/** Resolve the active backend from env, or a typed escalation when it isn't configured. */
function getBackend(): WebBackend | { escalation: string } {
  if (backendOverride) return backendOverride;
  const kind = (process.env.KERNEL_WEB_BACKEND ?? 'tavily').toLowerCase();
  if (kind === 'searxng') {
    return new SearxngBackend(process.env.SEARXNG_URL ?? 'http://localhost:8080');
  }
  const key = process.env.TAVILY_API_KEY;
  if (!key) {
    return {
      escalation:
        'Web search needs a Tavily API key. Add `TAVILY_API_KEY=tvly-…` to ~/.kernel.env (free key at ' +
        'tavily.com), then restart the daemon — or set `KERNEL_WEB_BACKEND=searxng` to use a self-hosted backend.',
    };
  }
  return new TavilyBackend(key);
}

// ─── TTL cache (ephemeral, process-only) ─────────────────────────────────────

interface CacheEntry {
  data: unknown;
  expires: number;
}
const cache = new Map<string, CacheEntry>();
/** Search results: shortish — current-info queries shouldn't serve stale hits for long. */
const SEARCH_TTL_MS = 30 * 60 * 1000;
/** Fetched page bodies change less often. */
const FETCH_TTL_MS = 60 * 60 * 1000;

function cacheGet(key: string): unknown | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expires < nowMs()) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}
function cacheSet(key: string, data: unknown, ttl: number): void {
  cache.set(key, { data, expires: nowMs() + ttl });
}
/** Injectable clock-free now() — Date.now via a function so tests can wrap if needed. */
function nowMs(): number {
  return Date.now();
}
/** TEST-ONLY: clear the cache between cases. */
export function __clearWebCacheForTest(): void {
  cache.clear();
}

// ─── The tool ────────────────────────────────────────────────────────────────

export const webArgsSchema = z
  .object({
    op: z.enum(['search', 'fetch']).default('search'), // small models often omit op → default to search
    query: z.string().optional(),
    url: z.string().url().optional(),
    max_results: z.number().int().min(1).max(5).optional(),
  })
  .strict(); // reject unknown keys (ASVS V5) — no smuggled fields.

type WebArgs = z.infer<typeof webArgsSchema>;

/**
 * The model-facing tool description — the WHEN-TO-USE-IT rule lives HERE (what the model reads when
 * deciding), the calibrated dual framing (positive triggers + a negative list + an "if unsure" tie-
 * break) that curbs both over-calling on trivia and under-calling on stale facts.
 */
export const WEB_TOOL_DESCRIPTION =
  'Search the live internet for CURRENT or UNKNOWN information — recent events, today\'s date/news/' +
  'weather, prices, releases, schedules, or any fact that may have changed since your training — OR ' +
  'when you are not confident you know the answer. Do NOT search for stable facts you already know ' +
  '(definitions, math, history, capitals). When unsure whether a fact is current, prefer to search. ' +
  "Use op='search' with a query; then op='fetch' with a result url if you need its full text.";

export const webTool: Tool = {
  name: 'web',
  schema: webArgsSchema,
  async execute(args): Promise<ToolResult> {
    const a = args as WebArgs;
    const backend = getBackend();
    if ('escalation' in backend) return { ok: false, escalation: { reason: backend.escalation } };

    try {
      if (a.op === 'search') {
        if (!a.query) return { ok: false, escalation: { reason: 'web search requires a `query`.' } };
        const max = a.max_results ?? 3;
        const key = `s:${max}:${a.query.trim().toLowerCase()}`;
        const cached = cacheGet(key);
        if (cached) return { ok: true, data: cached };
        const results = await backend.search(a.query, max);
        const data = { op: 'search', query: a.query, results, source: 'external' as const };
        cacheSet(key, data, SEARCH_TTL_MS);
        logger.info({ tool: 'web', op: 'search', n: results.length }, 'web: search complete');
        return { ok: true, data };
      }

      // op === 'fetch'
      if (!a.url) return { ok: false, escalation: { reason: 'web fetch requires a `url`.' } };
      const key = `f:${a.url}`;
      const cached = cacheGet(key);
      if (cached) return { ok: true, data: cached };
      const page = await backend.fetch(a.url);
      cacheSet(key, page, FETCH_TTL_MS);
      logger.info({ tool: 'web', op: 'fetch' }, 'web: fetch complete');
      return { ok: true, data: page };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ tool: 'web', op: a.op }, 'web: op failed — escalating');
      return { ok: false, escalation: { reason: `web ${a.op} failed: ${reason}` } };
    }
  },
};

// Module-init side effect: importing this tool wires it into the router (HANDS-04).
register(webTool);
