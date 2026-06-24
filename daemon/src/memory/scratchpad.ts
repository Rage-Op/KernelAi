/**
 * scratchpad.ts (MEM-08) — the WRITER for working-memory/current.md, the always-injected
 * live scratchpad.
 *
 * The gap this closes: inject.ts reads current.md as priority-2 context (after IDENTITY, never
 * truncated), but NOTHING ever wrote it — so it sat frozen at its seed placeholder and went stale.
 * This module gives current.md a curated, bounded, sectioned shape and an upsert discipline, so
 * nightly consolidation (consolidate.ts) can keep it fresh from the durable source:user|self facts.
 *
 * Design (learned from the agentic-os curated MEMORY.md scratchpad):
 *   - A small, FIXED set of canonical H2 sections (Active Threads / Environment Notes /
 *     Pending Decisions) so the model always sees the same working-memory shape.
 *   - Items are bullet lines; upsert NORMALIZES (first line, collapsed whitespace, per-item char
 *     cap), DEDUPES case-insensitively, and re-adding an existing item BUMPS it to most-recent
 *     (a natural LRU — a fact re-mentioned today stays; an old one ages out).
 *   - A hard char CAP on the whole file (well under INJECT_CAP); when over, the OLDEST item from
 *     the largest section is evicted until it fits — current.md can never balloon and crowd out
 *     IDENTITY or retrieval.
 *   - The owner's PREAMBLE (the `# Current` heading + the HTML-comment discipline note, and any
 *     unknown sections) is PRESERVED across rewrites — we curate the canonical sections, we don't
 *     clobber hand-authored framing.
 *
 * PROVENANCE: current.md is `source:self` curated working memory. Consolidation only ever feeds it
 * source:user|self facts (external is filtered out upstream, MEM-07/Pitfall 4), so a poisoned email
 * can never reach the always-injected scratchpad. This module does no provenance parsing itself — it
 * trusts the caller to pass already-vetted text — but it NEVER writes IDENTITY.md (assertNotIdentityPath).
 *
 * Zero new dependencies — node:fs/node:path + the existing identity guard.
 */
import fs from 'node:fs';
import path from 'node:path';

import { assertNotIdentityPath } from './identity.js';

/** The current.md path, relative to the memory dir. */
const CURRENT_REL = path.join('working-memory', 'current.md');

/**
 * Hard char cap on the WHOLE rendered current.md. Sits comfortably under INJECT_CAP (16384) so the
 * always-injected scratchpad can never crowd out IDENTITY or retrieved knowledge. Matches the
 * ~2,500-char soft cap the seed file documents, with a little headroom.
 */
export const SCRATCHPAD_CAP = 2800;

/** Per-item char cap — keeps one long distilled reply from eating the whole scratchpad. */
export const MAX_ITEM_CHARS = 200;

/** The canonical sections, in render order. Unknown sections are preserved AFTER these. */
export const CANONICAL_SECTIONS = ['Active Threads', 'Environment Notes', 'Pending Decisions'] as const;
export type CanonicalSection = (typeof CANONICAL_SECTIONS)[number];

/** The seed preamble used when current.md is absent/empty (mirrors the shipped seed file). */
const DEFAULT_PREAMBLE = [
  '# Current',
  '',
  '<!--',
  'Rolling live scratchpad — the frozen-snapshot discipline.',
  'Injected every session (priority 2, after IDENTITY.md, never truncated).',
  'Curated by nightly consolidation from durable source:user|self facts; keep it lean',
  `(hard cap ~${SCRATCHPAD_CAP} chars). It holds the live working set (what KERNEL is in the`,
  'middle of), not durable knowledge — that goes to knowledge/.',
  '-->',
].join('\n');

/** A parsed scratchpad: the preserved preamble + ordered sections (name → bullet items). */
export interface ParsedScratchpad {
  /** Everything before the first `## ` header (heading + comment), preserved verbatim. */
  preamble: string;
  /** Section name → its bullet items, in file order. Insertion order preserved (Map). */
  sections: Map<string, string[]>;
}

/** Normalize one raw item to a single, bounded, whitespace-collapsed line. */
export function normalizeItem(raw: string): string {
  const firstLine = raw.split('\n').find((l) => l.trim().length > 0) ?? '';
  // strip a leading bullet marker if the caller passed "- foo"
  let t = firstLine.replace(/^\s*[-*]\s+/, '').replace(/\s+/g, ' ').trim();
  if (t.length > MAX_ITEM_CHARS) t = t.slice(0, MAX_ITEM_CHARS - 1).trimEnd() + '…';
  return t;
}

/** Case-insensitive dedup key (also ignores trailing punctuation so "x." == "x"). */
function dedupKey(item: string): string {
  return item.toLowerCase().replace(/[.!?,;:]+$/, '').trim();
}

/**
 * Parse a current.md body into preamble + sections. The preamble is the leading run of lines that
 * are blank, an H1 (`# `), or inside an HTML comment; it ends at the first content/`## ` line.
 * Within the sections region, only `- `/`* ` bullets under a `## ` header are kept as items
 * (loose body — e.g. the seed `_Nothing in flight_` placeholder — and `_None yet._` markers are
 * dropped, which is how the seed migrates to the structured skeleton on first write).
 */
export function parseScratchpad(text: string): ParsedScratchpad {
  const lines = text.split('\n');

  // 1) Consume the preamble.
  const preambleLines: string[] = [];
  let i = 0;
  let inComment = false;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (inComment) {
      preambleLines.push(line);
      if (trimmed.includes('-->')) inComment = false;
      continue;
    }
    if (trimmed.startsWith('## ')) break; // first section header — preamble ends
    if (trimmed === '' || trimmed.startsWith('# ') || trimmed.startsWith('<!--')) {
      preambleLines.push(line);
      if (trimmed.startsWith('<!--') && !trimmed.includes('-->')) inComment = true;
      continue;
    }
    break; // first real content line (e.g. the seed placeholder) — preamble ends, drop the rest
  }

  // 2) Parse `## ` sections from i onward.
  const sections = new Map<string, string[]>();
  let current: string[] | null = null;
  for (; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const header = trimmed.match(/^##\s+(.+?)\s*$/);
    if (header) {
      const name = header[1].trim();
      current = sections.get(name) ?? [];
      sections.set(name, current);
      continue;
    }
    if (!current) continue; // loose body before the first header — dropped
    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      const item = normalizeItem(bullet[1]);
      if (item) current.push(item);
    }
    // non-bullet lines inside a section (e.g. `_None yet._`) are ignored
  }

  const preamble = preambleLines.join('\n').replace(/\s+$/, '');
  return { preamble: preamble || DEFAULT_PREAMBLE, sections };
}

/** Render a parsed scratchpad back to markdown: preamble, canonical sections in order, then extras. */
export function renderScratchpad(parsed: ParsedScratchpad): string {
  const { preamble, sections } = parsed;
  const seen = new Set<string>();
  const blocks: string[] = [];

  const renderSection = (name: string): void => {
    const items = sections.get(name) ?? [];
    const body = items.length ? items.map((it) => `- ${it}`).join('\n') : '_None yet._';
    blocks.push(`## ${name}\n\n${body}`);
    seen.add(name);
  };

  for (const name of CANONICAL_SECTIONS) renderSection(name);
  for (const name of sections.keys()) if (!seen.has(name)) renderSection(name); // preserve unknowns

  return `${preamble}\n\n${blocks.join('\n\n')}\n`;
}

/**
 * Enforce the whole-file char cap by evicting the OLDEST item (index 0) from the section with the
 * MOST items until the render fits (or no items remain — the preamble alone is never evicted; the
 * cap sits far under INJECT_CAP, so a too-large preamble is an inject-level concern, not ours).
 */
function enforceCap(parsed: ParsedScratchpad): string {
  let rendered = renderScratchpad(parsed);
  // bounded loop: each pass removes one item, and item count is finite
  for (let guard = 0; rendered.length > SCRATCHPAD_CAP && guard < 10000; guard++) {
    let victim: string | null = null;
    let max = 0;
    for (const [name, items] of parsed.sections) {
      if (items.length > max) {
        max = items.length;
        victim = name;
      }
    }
    if (!victim || max === 0) break; // nothing left to drop
    parsed.sections.get(victim)!.shift(); // evict oldest
    rendered = renderScratchpad(parsed);
  }
  return rendered;
}

/**
 * Upsert items into a section of a current.md body and return the new rendered body.
 *   - normalizes + dedupes each item (case-insensitively, trailing-punctuation-insensitively);
 *   - an item already present is REMOVED then re-appended (bumped to most-recent — LRU);
 *   - the whole file is then capped (oldest-of-largest-section evicted) to SCRATCHPAD_CAP.
 * Pure: takes the old body text, returns the new body text. Empty/whitespace items are ignored.
 */
export function upsertSection(body: string, section: string, rawItems: string[]): string {
  const parsed = parseScratchpad(body);
  const items = parsed.sections.get(section) ?? [];
  parsed.sections.set(section, items);

  for (const raw of rawItems) {
    const item = normalizeItem(raw);
    if (!item) continue;
    const key = dedupKey(item);
    const idx = items.findIndex((existing) => dedupKey(existing) === key);
    if (idx !== -1) items.splice(idx, 1); // remove the stale copy (will be re-appended as newest)
    items.push(item);
  }

  return enforceCap(parsed);
}

/** Read current.md (absolute path under memoryDir), or '' if absent. */
export function readScratchpad(memoryDir: string): string {
  const file = path.join(memoryDir, CURRENT_REL);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

/** Write current.md (never IDENTITY.md), creating working-memory/ if needed. */
export function writeScratchpad(memoryDir: string, body: string): void {
  const file = path.join(memoryDir, CURRENT_REL);
  assertNotIdentityPath(file, memoryDir); // defense-in-depth: current.md is never IDENTITY.md
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
}

/**
 * Read-modify-write convenience: upsert items into a section of the on-disk current.md.
 * Returns the number of items written (after normalization; empties skipped). A no-op (no write,
 * returns 0) when there are no non-empty items — so an external-only consolidation run never
 * touches current.md.
 */
export function refreshScratchpad(memoryDir: string, section: string, rawItems: string[]): number {
  const normalized = rawItems.map(normalizeItem).filter((s) => s.length > 0);
  if (normalized.length === 0) return 0;
  const next = upsertSection(readScratchpad(memoryDir), section, normalized);
  writeScratchpad(memoryDir, next);
  return normalized.length;
}
