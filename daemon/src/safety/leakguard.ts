/**
 * safety/leakguard.ts (FIN-04d) — the startup finance-leak assertion, layer (d) of the 4-layer
 * stack, as a reusable + directly-tested module.
 *
 * assertFinanceNotTracked(memoryDir) wraps `git -C <memoryDir> ls-files | grep -i finance`: if
 * ANY finance-pathed file is tracked in the memory repo, it FAILS LOUD (throws) so the daemon
 * refuses to start — the existential finance leak (Pitfall 1) cannot be silently shipped. A
 * non-git memory dir is tolerated (greenfield/test) — only an ACTUAL tracked finance path throws.
 *
 * index.ts delegates to this module (single source of truth) without changing its fail-loud
 * behavior.
 */
import { execFileSync } from 'node:child_process';

import { logger } from '../memory/log.js';

/**
 * Refuse to proceed if anything finance-pathed is git-tracked in `memoryDir` (MEM-06 / FIN-04d).
 * Throws on a real tracked finance path; tolerates a non-git directory.
 */
export function assertFinanceNotTracked(memoryDir: string): void {
  let tracked: string;
  try {
    tracked = execFileSync('git', ['-C', memoryDir, 'ls-files'], { encoding: 'utf8' });
  } catch {
    // not a git repo (or git unavailable) — nothing tracked to assert against.
    logger.warn(
      { memoryDir },
      'finance assertion skipped: memory dir is not a git repo (or git unavailable)',
    );
    return;
  }
  const offending = tracked
    .split('\n')
    .filter((f) => /finance/i.test(f))
    .filter(Boolean);
  if (offending.length > 0) {
    throw new Error(
      `CRITICAL: finance-pathed files are git-tracked in the memory repo (MEM-06 violation): ` +
        offending.join(', ') +
        `. Refusing to start — finance/ must NEVER be tracked or backed up.`,
    );
  }
}
