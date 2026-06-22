/**
 * Cleanup / prune (MEM-07, MAINT-03) — "no junk, no degradation".
 *
 * `runCleanup` prunes machine-local, regenerable memory that has aged past a retention window:
 *   - stale working-memory/ entries: quarantine/ and reflections/ files older than the window,
 *   - old logs/{date}.md daily files older than the window (already distilled by consolidation).
 *
 * It NEVER touches:
 *   - IDENTITY.md             (assertNotIdentityPath guard on every candidate, by construction),
 *   - knowledge/              (durable facts — not a prune candidate dir),
 *   - finance/                (never even enumerated — the §14 store is out of bounds),
 *   - working-memory/current.md (the live scratchpad — only the bucket subdirs are pruned).
 *
 * Pruning is explicit per-file `fs.rmSync` of files we enumerated under the candidate dirs — never
 * a recursive blanket delete of a parent. `.gitkeep` files are preserved so the tracked dirs
 * survive. Zero new dependencies (node:fs/node:path).
 */
import fs from 'node:fs';
import path from 'node:path';

import { config } from '../config.js';
import { assertNotIdentityPath } from './identity.js';
import { logger } from './log.js';

/** Default retention window in days. Anything older than this is prunable. */
export const DEFAULT_RETENTION_DAYS = 30;

/** Outcome of a cleanup run (counts only). */
export interface CleanupResult {
  /** Number of files pruned. */
  pruned: number;
  /** Absolute paths pruned (for the audit/changelog line). */
  prunedPaths: string[];
}

/**
 * The ONLY dirs cleanup enumerates. knowledge/ and finance/ are deliberately absent — durable
 * facts and the finance store are never prune candidates. working-memory/current.md is a FILE
 * (the live scratchpad), not under these bucket subdirs, so it is never enumerated/pruned.
 */
const CANDIDATE_DIRS = [
  path.join('working-memory', 'quarantine'),
  path.join('working-memory', 'reflections'),
  'logs',
];

/** Age of a file in days from its mtime. */
function ageDays(file: string): number {
  const mtimeMs = fs.statSync(file).mtimeMs;
  return Math.max(0, (Date.now() - mtimeMs) / (24 * 60 * 60 * 1000));
}

/** Is this a file we are willing to prune? Preserve .gitkeep so tracked dirs survive. */
function isPrunable(name: string): boolean {
  if (name === '.gitkeep') return false;
  return true;
}

/**
 * Run cleanup over the memory repo (MEM-07). Prunes files under the candidate working-memory and
 * logs dirs older than `retentionDays`. IDENTITY.md, knowledge/, finance/, and
 * working-memory/current.md are never touched. Returns the prune counts/paths.
 */
export async function runCleanup(
  memoryDir: string = config.memoryDir,
  retentionDays: number = DEFAULT_RETENTION_DAYS,
): Promise<CleanupResult> {
  const prunedPaths: string[] = [];

  for (const sub of CANDIDATE_DIRS) {
    const dir = path.join(memoryDir, sub);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !isPrunable(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (ageDays(file) <= retentionDays) continue;
      // Defense-in-depth: a prune target can NEVER be IDENTITY.md (it lives outside these dirs,
      // but the guard makes that structural rather than incidental).
      assertNotIdentityPath(file, memoryDir);
      fs.rmSync(file);
      prunedPaths.push(file);
    }
  }

  logger.info(
    { event: 'cleanup.run', pruned: prunedPaths.length, retentionDays },
    'cleanup complete',
  );

  return { pruned: prunedPaths.length, prunedPaths };
}
