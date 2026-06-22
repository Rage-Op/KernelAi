/**
 * self/metrics.md writer (MAINT-02).
 *
 * KERNEL records its own self-observed operational metrics in `self/metrics.md` under the memory
 * repo. Unlike the append-only changelog, metrics are a CURRENT snapshot — `writeMetrics`
 * rewrites the file each run with a dated header and a key/value table. Like every memory writer
 * it calls `assertNotIdentityPath` before writing so it can never target IDENTITY.md.
 *
 * Plain markdown only — NO finance amounts ever land here (spec §14 / V7). Counts and timestamps
 * only (e.g. logs distilled, facts promoted, entries pruned, last backup time).
 */
import fs from 'node:fs';
import path from 'node:path';

import { config } from '../config.js';
import { assertNotIdentityPath } from '../memory/identity.js';

/** A flat metrics map — values are plain scalars (counts/timestamps), never finance amounts. */
export type Metrics = Record<string, string | number | boolean>;

/** Absolute path of self/metrics.md under the given memory dir. */
function metricsPath(memoryDir: string): string {
  return path.join(memoryDir, 'self', 'metrics.md');
}

/**
 * Write self/metrics.md as a current snapshot (MAINT-02). Rewrites the file with a `# Metrics`
 * header, a generated-at timestamp, and a markdown table of the supplied key/value pairs.
 * Returns the file text written. Never targets IDENTITY.md (assertNotIdentityPath guard).
 */
export function writeMetrics(metrics: Metrics, memoryDir: string = config.memoryDir): string {
  const file = metricsPath(memoryDir);
  assertNotIdentityPath(file, memoryDir); // defense-in-depth: never IDENTITY.md
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const generatedAt = new Date().toISOString();
  const rows = Object.entries(metrics)
    .map(([k, v]) => `| ${k} | ${String(v)} |`)
    .join('\n');

  const text =
    `# Metrics\n\n` +
    `<!-- KERNEL's self-observed operational metrics. Regenerated each maintenance run. -->\n\n` +
    `_Generated: ${generatedAt}_\n\n` +
    `| Metric | Value |\n` +
    `|--------|-------|\n` +
    (rows ? rows + '\n' : '');

  fs.writeFileSync(file, text, 'utf8');
  return text;
}
