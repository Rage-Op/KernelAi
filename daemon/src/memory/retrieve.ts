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

/**
 * A small surface→concept synonym/alias map so a query and a doc that use DIFFERENT words for the
 * same idea still overlap ("finances"/"spending"/"budget" → `finance`; "emails"/"inbox" → `mail`).
 * Keyword-only retrieval is otherwise brittle to vocabulary mismatch; this is the cheap, dependency-
 * free stand-in for embeddings (which the 16GB ceiling rules out). Expansion is ADDITIVE — the
 * original token is always kept too — and applied symmetrically to query and doc, so a full literal
 * match still scores exactly as before (the existing score() invariants are preserved).
 */
const SYNONYMS: Record<string, string> = {
  // money
  finances: 'finance', financial: 'finance', money: 'finance', spending: 'finance', spend: 'finance',
  budget: 'finance', budgets: 'finance', expense: 'finance', expenses: 'finance', cost: 'finance',
  costs: 'finance', payment: 'finance', payments: 'finance', transaction: 'finance', transactions: 'finance',
  invoice: 'finance', invoices: 'finance', bill: 'finance', bills: 'finance',
  // mail
  email: 'mail', emails: 'mail', inbox: 'mail', message: 'mail', messages: 'mail', gmail: 'mail',
  // calendar
  schedule: 'calendar', calendars: 'calendar', meeting: 'calendar', meetings: 'calendar',
  event: 'calendar', events: 'calendar', appointment: 'calendar', appointments: 'calendar',
  // tasks
  task: 'task', tasks: 'task', todo: 'task', todos: 'task', reminder: 'task', reminders: 'task',
  // web
  internet: 'web', online: 'web', news: 'web', browse: 'web', website: 'web', websites: 'web',
  // files
  files: 'file', document: 'file', documents: 'file', doc: 'file', docs: 'file', folder: 'file',
  folders: 'file', directory: 'file', directories: 'file',
};

/**
 * A conservative, dependency-free stemmer: strip the commonest English inflections so
 * "deploys"/"deployed"/"deploying" unify with "deploy". Order matters; the bare-plural rule is
 * length-guarded to avoid mangling short words. Best-effort — the SYNONYMS map carries the
 * load-bearing domain unification; this is a bonus for everything else.
 */
export function stem(t: string): string {
  if (t.length <= 3) return t;
  if (t.endsWith('ies') && t.length > 4) return t.slice(0, -3) + 'y'; // "policies" → "policy"
  if (t.endsWith('ing') && t.length > 5) return t.slice(0, -3); // "deploying" → "deploy"
  if (t.endsWith('ed') && t.length > 4) return t.slice(0, -2); // "deployed" → "deploy"
  if (t.endsWith('es') && t.length > 4) return t.slice(0, -2); // "boxes" → "box"
  if (t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1); // "tasks" → "task"
  return t;
}

/**
 * Expand a token set into its retrieval-matching form: each token plus its stem plus any
 * synonym/alias concept. Applied to BOTH the query and every doc, so vocabulary mismatch no longer
 * zeroes the overlap. Additive (originals retained) → literal matches are unaffected.
 */
export function expand(tokens: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const t of tokens) {
    out.add(t);
    const s = stem(t);
    if (s && s !== t) out.add(s);
    const syn = SYNONYMS[t] ?? SYNONYMS[s];
    if (syn) out.add(syn);
  }
  return out;
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
 *   keywordOverlap = |expand(query) ∩ expand(docTokens)| / |expand(query)|
 *   recencyMult    = max(0.3, 0.5 ** (ageDays / 14))
 *   authority      = weight of the longest matching path prefix (default 0.5)
 *
 * Query and doc are both run through `expand` (stem + synonym), so vocabulary mismatch
 * ("finances" vs "spending") no longer zeroes the overlap. Expansion is additive and symmetric,
 * so a full literal match still scores exactly as it did before normalization was added.
 */
export function score(
  query: Set<string>,
  doc: { text: string; path: string; ageDays: number },
): number {
  const q = expand(query);
  const docTokens = expand(tokenize(doc.text));
  let hits = 0;
  for (const t of q) if (docTokens.has(t)) hits++;
  const keyword = q.size ? hits / q.size : 0;
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
