/**
 * self/changelog.md writer (MAINT-02).
 *
 * KERNEL keeps an honest, append-only record of its own changes over time. `appendChangelog`
 * appends a dated entry to `self/changelog.md` under the memory repo, seeding the `# Changelog`
 * header if the file is absent. It is APPEND-ONLY (never truncates) and, like every memory
 * writer, calls `assertNotIdentityPath` before writing so it can never target IDENTITY.md.
 *
 * Plain markdown only — no finance amounts ever land here (spec §14 / V7). The consolidation
 * job calls this to record what it distilled/promoted on each run.
 */
import fs from 'node:fs';
import path from 'node:path';

import { config } from '../config.js';
import { assertNotIdentityPath } from '../memory/identity.js';

/** Absolute path of self/changelog.md under the given memory dir. */
function changelogPath(memoryDir: string): string {
  return path.join(memoryDir, 'self', 'changelog.md');
}

const HEADER = '# Changelog\n\n<!-- KERNEL\'s record of its own changes over time. -->\n';

/**
 * Append a dated entry to self/changelog.md (append-only, MAINT-02). Seeds the `# Changelog`
 * header if the file does not exist yet. Returns the entry line written.
 *
 * The `entry` is a single human-readable line; it is prefixed with the UTC date so the log
 * reads as a chronological record. Never targets IDENTITY.md (assertNotIdentityPath guard).
 */
export function appendChangelog(entry: string, memoryDir: string = config.memoryDir): string {
  const file = changelogPath(memoryDir);
  assertNotIdentityPath(file, memoryDir); // defense-in-depth: never IDENTITY.md
  fs.mkdirSync(path.dirname(file), { recursive: true });

  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, HEADER, 'utf8');
  }

  const date = new Date().toISOString().slice(0, 10);
  const line = `- **${date}** — ${entry.trim()}\n`;
  fs.appendFileSync(file, line, 'utf8');
  return line;
}
