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

test('git check-ignore: a finance-pathed file is ignored', () => {
  // `git check-ignore <path>` exits 0 if the path is ignored, 1 if not.
  // We do NOT pass --error-unmatch; a clean exit 0 + printed path = ignored.
  let ignored = false;
  try {
    const out = execFileSync('git', ['-C', memDir, 'check-ignore', 'finance/x.db'], {
      encoding: 'utf8',
    });
    ignored = out.trim().length > 0;
  } catch {
    ignored = false; // non-zero exit => path is NOT ignored
  }
  assert.ok(ignored, 'finance/x.db must be gitignored in kernel-memory/');
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
