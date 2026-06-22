import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { config } from '../src/config.js';

/**
 * MEM-06: finance/ is gitignored in kernel-memory/ and nothing finance-pathed is
 * ever tracked. This is the cheap fourth layer of the §14 defense-in-depth — laid
 * before finance/ exists, so Phase 4 can never accidentally commit the finance store.
 */

const memDir = config.memoryDir;

/** True iff `git check-ignore <relPath>` reports the path as ignored (exit 0 + printed). */
function isIgnored(relPath: string): boolean {
  try {
    const out = execFileSync('git', ['-C', memDir, 'check-ignore', relPath], {
      encoding: 'utf8',
    });
    return out.trim().length > 0;
  } catch {
    return false; // non-zero exit => path is NOT ignored
  }
}

test('git check-ignore: a finance-pathed file is ignored', () => {
  assert.ok(isIgnored('finance/x.db'), 'finance/x.db must be gitignored in kernel-memory/');
});

test('FIN-04a: the REAL finance DB filename is ignored', () => {
  assert.ok(isIgnored('finance/finance.db'), 'finance/finance.db must be gitignored');
});

test('FIN-04a: every SQLCipher sidecar (-wal/-shm/-journal) is ignored', () => {
  for (const sidecar of [
    'finance/finance.db-wal',
    'finance/finance.db-shm',
    'finance/finance.db-journal',
  ]) {
    assert.ok(isIgnored(sidecar), `${sidecar} must be gitignored (SQLCipher sidecar)`);
  }
});

test('git ls-files: nothing finance-pathed is tracked', () => {
  const tracked = execFileSync('git', ['-C', memDir, 'ls-files'], { encoding: 'utf8' });
  const financeTracked = tracked
    .split('\n')
    .filter((line) => /finance/i.test(line));
  assert.deepEqual(
    financeTracked,
    [],
    `no finance-pathed file may be tracked; found: ${financeTracked.join(', ')}`,
  );
});
