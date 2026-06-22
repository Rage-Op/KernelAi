/**
 * Quarantine single-write path (MEM-05).
 *
 * `working-memory/quarantine/` is the ONLY landing zone for `source: external`
 * (untrusted) content — anything read from mail/web/calendar. `quarantineWrite` is
 * the single sanctioned write path for it: it confines writes to quarantine/, stamps
 * every file with `source: external` front-matter, and refuses any target outside the
 * bucket. There is no promoter in Phase 1 — the retrieval reranker gives quarantine
 * authority 0.0 and inject() additionally skips source==='external', so quarantined
 * content can never enter privileged injected context. The promotion gate is Phase 5.
 *
 * Phase 1 has no caller that produces external content yet (Phase 2 mail/web readers
 * do); the seam + no-promote rule exist now so taint isn't retrofitted later.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

import { config } from '../config.js';

export interface QuarantineItem {
  /** The untrusted body text to quarantine. */
  text: string;
  /** Where it came from, e.g. "email:2026-06-22 from x@y.com". */
  origin?: string;
}

/** Absolute path of the quarantine bucket under the given memory dir. */
function quarantineDir(memoryDir: string): string {
  return path.join(memoryDir, 'working-memory', 'quarantine');
}

/**
 * Write external-sourced content into working-memory/quarantine/ ONLY.
 * Filename = ISO-timestamp + short random suffix (collision-resistant). The file
 * carries `source: external` (+ optional `origin`) front-matter and the body text.
 * Refuses (throws) any resolved path outside the quarantine dir. Returns the path written.
 */
export function quarantineWrite(
  item: QuarantineItem,
  memoryDir: string = config.memoryDir,
): string {
  const dir = quarantineDir(memoryDir);
  fs.mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = randomBytes(4).toString('hex');
  const target = path.join(dir, `${stamp}-${suffix}.md`);

  // Defense-in-depth: assert the resolved target is inside quarantine/ before writing.
  const resolved = path.resolve(target);
  const dirResolved = path.resolve(dir);
  if (resolved !== dirResolved && !resolved.startsWith(dirResolved + path.sep)) {
    throw new Error(
      `Refusing to write external content outside quarantine/ (target=${resolved}).`,
    );
  }

  const file = matter.stringify(item.text, {
    source: 'external',
    ...(item.origin ? { origin: item.origin } : {}),
    quarantined_at: new Date().toISOString(),
  });
  fs.writeFileSync(target, file, 'utf8');
  return resolved;
}
