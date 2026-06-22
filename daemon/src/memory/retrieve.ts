/**
 * Keyword retrieval + authority×recency rerank (MEM-04) — NO embeddings.
 *
 * Ported from the agentic-os `memory-config.json` reranker (RESEARCH.md Code Examples):
 *   - HALF_LIFE = 14 days, recency multiplier floored at 0.3
 *   - authority = weight of the LONGEST matching path prefix (default 0.5)
 *   - final score = keywordOverlap × recencyMult × authority
 *
 * `working-memory/quarantine/` has authority 0.0, so external/quarantine content scores 0
 * and never enters privileged context — code-level enforcement of MEM-05, not a prompt rule.
 *
 * Keyword-only by design: the project rejects the reference's BGE-M3 embeddings path
 * (16GB ceiling). gray-matter splits front-matter (source/priority/status) from the body.
 */
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

import { config } from '../config.js';
import type { ContextItem, Provenance } from './types.js';

const HALF_LIFE = 14;
const FLOOR = 0.3;

/**
 * Authority weights by path prefix (relative to the memory dir). The longest matching
 * prefix wins; unmatched paths default to 0.5. quarantine/ is 0.0 (never surfaced).
 */
const AUTH: Record<string, number> = {
  'knowledge/': 1.5,
  'working-memory/current.md': 1.0,
  'tasks/': 1.0,
  'projects/': 0.8,
  'logs/': 0.5,
  'working-memory/quarantine/': 0.0,
};

/** A reranked retrieval result: a ContextItem plus its computed score. */
export interface RankedItem extends ContextItem {
  /** The final keyword×recency×authority score (higher = more relevant). */
  score: number;
}

/** Lowercase Set of [a-z0-9]+ tokens. */
export function tokenize(s: string): Set<string> {
  return new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

/** Authority weight for a path = the value of its LONGEST matching prefix (else 0.5). */
function authorityFor(relPath: string): number {
  const normalized = relPath.split(path.sep).join('/');
  let best: { key: string; weight: number } | null = null;
  for (const [key, weight] of Object.entries(AUTH)) {
    if (normalized.startsWith(key) && (best === null || key.length > best.key.length)) {
      best = { key, weight };
    }
  }
  return best ? best.weight : 0.5;
}

/**
 * score(query, doc) = keywordOverlap × recencyMult × authority.
 *   keywordOverlap = |query ∩ docTokens| / |query|
 *   recencyMult    = max(0.3, 0.5 ** (ageDays / 14))
 *   authority      = weight of the longest matching path prefix (default 0.5)
 */
export function score(
  query: Set<string>,
  doc: { text: string; path: string; ageDays: number },
): number {
  const docTokens = tokenize(doc.text);
  let hits = 0;
  for (const t of query) if (docTokens.has(t)) hits++;
  const keyword = query.size ? hits / query.size : 0;
  const recency = Math.max(FLOOR, Math.pow(0.5, doc.ageDays / HALF_LIFE));
  const authority = authorityFor(doc.path);
  return keyword * recency * authority;
}

/** The candidate dirs gathered for retrieval (quarantine is deliberately excluded). */
const CANDIDATE_DIRS = ['knowledge', 'tasks', 'projects'];

/** Recursively list all *.md files under a dir (returns absolute paths). */
function listMarkdown(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMarkdown(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function ageDaysOf(file: string): number {
  const mtimeMs = fs.statSync(file).mtimeMs;
  return Math.max(0, (Date.now() - mtimeMs) / (24 * 60 * 60 * 1000));
}

/**
 * Gather candidate docs from knowledge/, tasks/, projects/, score each by
 * keyword × recency × authority, and return them sorted descending. Each result
 * carries its `source` from front-matter (default 'self') and its relative `path`.
 */
export async function retrieveAndRerank(
  query: string,
  memoryDir: string = config.memoryDir,
): Promise<RankedItem[]> {
  const queryTokens = tokenize(query);
  const results: RankedItem[] = [];

  for (const sub of CANDIDATE_DIRS) {
    const baseDir = path.join(memoryDir, sub);
    for (const file of listMarkdown(baseDir)) {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = matter(raw);
      const relPath = path.relative(memoryDir, file).split(path.sep).join('/');
      const text = parsed.content.trim();
      const s = score(queryTokens, { text, path: relPath, ageDays: ageDaysOf(file) });
      if (s <= 0) continue; // no keyword overlap or authority 0.0 → never surfaced
      const source = (parsed.data.source as Provenance | undefined) ?? 'self';
      results.push({
        text,
        source,
        path: relPath,
        origin: parsed.data.origin as string | undefined,
        score: s,
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}
