/**
 * Nightly consolidation (MEM-07, MAINT-03) — the privilege-escalation pump, defused.
 *
 * `runConsolidation` reads the append-only daily logs (logs/{date}.md), distills each day into a
 * reflection under working-memory/reflections/, and PROMOTES durable facts into knowledge/ —
 * but ONLY facts tagged `source:user` or `source:self`. Externally-sourced facts
 * (`source:external`, read from mail/web/calendar) are NEVER promoted: they may be SUMMARIZED for
 * recall inside the reflection, marked "unverified, from <origin>", but they never reach
 * knowledge/ and they NEVER touch IDENTITY.md (Pitfall 4 — the automated privilege-escalation
 * pump that would turn a one-shot poisoned email into a permanent backdoor).
 *
 * Two code-level invariants protect this:
 *   1. Promotion is gated on `source !== 'external'` — external facts are filtered out before any
 *      knowledge/ write. A run over ONLY external-sourced logs writes ZERO knowledge files.
 *   2. `assertNotIdentityPath` is called before EVERY write target, so no consolidation write can
 *      ever land on IDENTITY.md (defense-in-depth alongside the SHA-256 hash guard).
 *
 * Reflections carry gray-matter front-matter (like quarantine.ts/retrieve.ts). Promoted knowledge
 * files carry `source` + `reviewed:false` (auto-promoted, distinct from the human-reviewed
 * voice-profile) so retrieval/inject treat them as self-authored durable facts.
 *
 * Zero new dependencies — node:fs/node:path/node:crypto + the shipped gray-matter.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

import { config } from '../config.js';
import { assertNotIdentityPath } from './identity.js';
import { logger } from './log.js';
import type { Provenance } from './types.js';

/** A single fact distilled from a log session block. */
interface DistilledFact {
  /** The reply/output text (the distilled content). */
  text: string;
  /** Provenance tag parsed from the session block (defaults to 'self' if absent). */
  source: Provenance;
  /** Human-readable origin for external facts (e.g. "email:2026-... from x@y.com"). */
  origin?: string;
  /** ISO timestamp of the session (used for recency ordering). */
  time?: string;
}

/** Outcome of a consolidation run (counts only — no finance PII, no IDENTITY edits). */
export interface ConsolidationResult {
  /** Number of log files read. */
  logsRead: number;
  /** Number of reflection files written under working-memory/reflections/. */
  reflectionsWritten: number;
  /** Number of durable facts promoted into knowledge/ (source:user|self ONLY). */
  promoted: number;
  /** Number of external-sourced facts summarized-for-recall but NEVER promoted. */
  externalSummarized: number;
}

const REFLECTIONS_SUBDIR = path.join('working-memory', 'reflections');
const KNOWLEDGE_SUBDIR = 'knowledge';
const LOGS_SUBDIR = 'logs';

/** List daily log markdown files (logs/{YYYY-MM-DD}.md), ignoring .gitkeep / launchd .log files. */
function listDailyLogs(memoryDir: string): string[] {
  const dir = path.join(memoryDir, LOGS_SUBDIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/.test(e.name))
    .map((e) => path.join(dir, e.name))
    .sort();
}

/**
 * Parse the `## Session N` blocks of a daily log into distilled facts. Each block carries a
 * `**source:**` line (the load-bearing provenance tag), an optional `**origin:**` / `**id:**`,
 * a `**reply:**` (the distilled content), and a `**time:**`. Blocks with no usable reply are
 * skipped. `heartbeat {ISO}` lines are not session blocks and are ignored.
 */
function parseLog(file: string): DistilledFact[] {
  const text = fs.readFileSync(file, 'utf8');
  const blocks = text.split(/^## Session \d+/m).slice(1);
  const facts: DistilledFact[] = [];
  for (const block of blocks) {
    const field = (name: string): string | undefined => {
      const m = block.match(new RegExp(`\\*\\*${name}:\\*\\*\\s*(.+)`));
      return m ? m[1].trim() : undefined;
    };
    const rawSource = (field('source') ?? 'self').toLowerCase();
    const source: Provenance =
      rawSource === 'user' || rawSource === 'external' ? (rawSource as Provenance) : 'self';
    const reply = field('reply');
    const intent = field('intent');
    const distilled = reply && reply !== '(no reply)' ? reply : intent;
    if (!distilled) continue;
    facts.push({
      text: distilled,
      source,
      origin: field('origin'),
      time: field('time'),
    });
  }
  return facts;
}

/** Stable short id for a reflection/knowledge filename derived from the source log date. */
function logDate(file: string): string {
  return path.basename(file, '.md');
}

/** Short content hash to disambiguate promoted-knowledge filenames within a day. */
function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 8);
}

/**
 * Write a reflection markdown file for one day's distilled facts. Trusted (user/self) facts are
 * listed plainly; external facts are SUMMARIZED with an explicit "unverified, from <origin>"
 * marker — never promoted, only recalled. Returns the absolute path written.
 */
function writeReflection(
  memoryDir: string,
  date: string,
  trusted: DistilledFact[],
  external: DistilledFact[],
): string {
  const dir = path.join(memoryDir, REFLECTIONS_SUBDIR);
  const target = path.join(dir, `${date}.md`);
  assertNotIdentityPath(target, memoryDir); // never IDENTITY.md
  fs.mkdirSync(dir, { recursive: true });

  const trustedLines = trusted.map((f) => `- (${f.source}) ${f.text}`).join('\n');
  const externalLines = external
    .map((f) => `- [unverified, from ${f.origin ?? 'unknown external source'}] ${f.text}`)
    .join('\n');

  const body =
    `# Reflection ${date}\n\n` +
    `## Durable (source-vetted)\n\n` +
    (trustedLines ? trustedLines + '\n' : '_None._\n') +
    `\n## External (summarized for recall — NEVER promoted)\n\n` +
    (externalLines ? externalLines + '\n' : '_None._\n');

  const file = matter.stringify(body, {
    source: 'self',
    kind: 'reflection',
    consolidated_at: new Date().toISOString(),
    distilled_from: `logs/${date}.md`,
  });
  fs.writeFileSync(target, file, 'utf8');
  return target;
}

/**
 * Promote a single durable, source-vetted fact into knowledge/. Caller MUST have already filtered
 * on `source !== 'external'`; this function asserts it as a final guard. The knowledge file carries
 * `reviewed:false` (auto-promoted — distinct from a human-reviewed entry). Returns the path written.
 */
function promoteFact(memoryDir: string, fact: DistilledFact, date: string): string {
  // FINAL GUARD (defense-in-depth): external facts are unrepresentable in knowledge/.
  if (fact.source === 'external') {
    throw new Error(
      'consolidate: refusing to promote a source:external fact to knowledge/ (MEM-07/Pitfall 4).',
    );
  }
  const dir = path.join(memoryDir, KNOWLEDGE_SUBDIR);
  const target = path.join(dir, `consolidated-${date}-${shortHash(fact.text)}.md`);
  assertNotIdentityPath(target, memoryDir); // never IDENTITY.md
  fs.mkdirSync(dir, { recursive: true });

  const file = matter.stringify(`${fact.text}\n`, {
    source: fact.source,
    priority: 'normal',
    status: 'active',
    kind: 'consolidated-fact',
    reviewed: false,
    promoted_at: new Date().toISOString(),
    distilled_from: `logs/${date}.md`,
  });
  fs.writeFileSync(target, file, 'utf8');
  return target;
}

/**
 * Heuristic: is a fact "durable" enough to promote? Keeps the bar deliberately simple and
 * conservative — non-trivial length and not a pure stub echo. The SAFETY filter (source) is
 * applied by the caller; this only decides whether a trusted fact is worth a knowledge file.
 */
function isDurable(fact: DistilledFact): boolean {
  const t = fact.text.trim();
  if (t.length < 8) return false;
  if (/stub|echo|skeleton online/i.test(t)) return false;
  return true;
}

/**
 * Run nightly consolidation over the memory repo's logs (MEM-07).
 *
 * For each daily log: distill the session blocks, write a reflection (trusted facts plainly,
 * external facts summarized-for-recall with an "unverified, from <origin>" marker), and promote
 * ONLY the durable `source:user|self` facts into knowledge/. External facts are NEVER promoted and
 * IDENTITY.md is NEVER touched. Returns the run counts.
 */
export async function runConsolidation(
  memoryDir: string = config.memoryDir,
): Promise<ConsolidationResult> {
  const logs = listDailyLogs(memoryDir);
  let reflectionsWritten = 0;
  let promoted = 0;
  let externalSummarized = 0;

  for (const log of logs) {
    const facts = parseLog(log);
    if (facts.length === 0) continue;
    const date = logDate(log);

    // THE SAFETY FILTER (Pitfall 4): split on source. External never promoted.
    const trusted = facts.filter((f) => f.source !== 'external');
    const external = facts.filter((f) => f.source === 'external');
    externalSummarized += external.length;

    writeReflection(memoryDir, date, trusted, external);
    reflectionsWritten++;

    for (const fact of trusted) {
      if (isDurable(fact)) {
        promoteFact(memoryDir, fact, date);
        promoted++;
      }
    }
  }

  logger.info(
    { event: 'consolidate.run', logsRead: logs.length, reflectionsWritten, promoted, externalSummarized },
    'consolidation complete',
  );

  return { logsRead: logs.length, reflectionsWritten, promoted, externalSummarized };
}
