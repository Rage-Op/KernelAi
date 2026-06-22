/**
 * Priority-order session injection under the hard 16K-char cap (MEM-03, MEM-02, PERS-01).
 *
 * Assembly order (RESEARCH.md "Assembly algorithm"):
 *   1. IDENTITY.md   — hash-verified (readIdentityVerified), NEVER truncated, always first.
 *   2. working-memory/current.md — the frozen-snapshot scratchpad, NEVER truncated.
 *   3. retrieved knowledge/tasks/projects — reranked, greedily filling the remaining budget;
 *      items that would overflow are SKIPPED (not truncated mid-item).
 *
 * Hard invariants:
 *   - Total output ≤ INJECT_CAP (16384). IDENTITY is never dropped.
 *   - source === 'external' items are excluded from privileged context (defense-in-depth
 *     alongside retrieve's 0.0 quarantine authority — MEM-05).
 *   - If IDENTITY + current alone exceed the cap, inject() FAILS LOUD (warns / surfaces a
 *     metric) yet still never drops IDENTITY (MEM-03 / Pitfall 14).
 *
 * IDENTITY is read through the hash guard. On first run the baseline is seeded
 * (baselineIdentityHash is idempotent — it only writes when absent); thereafter any
 * out-of-band change makes readIdentityVerified throw.
 */
import fs from 'node:fs';
import path from 'node:path';

import { config, INJECT_CAP } from '../config.js';
import { baselineIdentityHash, readIdentityVerified } from './identity.js';
import { retrieveAndRerank } from './retrieve.js';

const SEP = '\n\n';

export interface InjectOptions {
  /** Loud-warning sink for the fail-loud (IDENTITY+current over cap) condition. */
  warn?: (msg: string) => void;
}

function defaultWarn(msg: string): void {
  // Surfaced to stderr so the condition is never silently swallowed. A pino critical
  // log is wired by the loop in 01-03; stderr keeps inject() self-sufficient meanwhile.
  process.stderr.write(`[inject] WARN: ${msg}\n`);
}

function readCurrent(memoryDir: string): string {
  const file = path.join(memoryDir, 'working-memory', 'current.md');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

/**
 * Assemble the session-start context string in priority order under the hard cap.
 *
 * @param query     keyword query for retrieval; when omitted, current.md text is used as
 *                  the query basis (the e2e calls inject() with no args).
 * @param memoryDir memory root (defaults to config.memoryDir; overridable for tests).
 * @param opts      injection hooks (e.g. a warn sink).
 */
export async function inject(
  query?: string,
  memoryDir: string = config.memoryDir,
  opts: InjectOptions = {},
): Promise<string> {
  const warn = opts.warn ?? defaultWarn;

  // Priority 1: IDENTITY.md (hash-verified, never truncated, always first).
  baselineIdentityHash(memoryDir); // idempotent: seeds the baseline only on first run.
  const identity = readIdentityVerified(memoryDir); // throws on out-of-band tamper.

  // Priority 2: working-memory/current.md (never truncated).
  const current = readCurrent(memoryDir);

  const fixed = current ? `${identity}${SEP}${current}` : identity;
  if (fixed.length > INJECT_CAP) {
    // Fail loud — IDENTITY + current must always fit. We still NEVER drop IDENTITY:
    // return the fixed block (IDENTITY first) even though it exceeds the cap.
    warn(
      `IDENTITY + current.md (${fixed.length} chars) exceed the ${INJECT_CAP}-char cap. ` +
        `Returning the fixed block uncut — IDENTITY is never dropped. current.md must be trimmed.`,
    );
    return fixed;
  }

  // Priority 3: reranked retrieval, greedily filling the remaining budget.
  let budget = INJECT_CAP - fixed.length;
  const effectiveQuery = query ?? current;
  const ranked = await retrieveAndRerank(effectiveQuery, memoryDir);

  const parts: string[] = [fixed];
  for (const item of ranked) {
    if (item.source === 'external') continue; // never promote external into privileged context
    const cost = item.text.length + SEP.length;
    if (cost > budget) continue; // skip (do not truncate) items that overflow
    parts.push(item.text);
    budget -= cost;
  }

  return parts.join(SEP);
}
