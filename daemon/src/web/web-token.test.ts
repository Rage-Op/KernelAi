import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import {
  getOrCreateWebToken,
  validateWebToken,
  webTokenPath,
  __resetWebTokenCacheForTest,
} from './web-token.js';

function tmpHome(): void {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-webtoken-'));
  process.env.HOME = d; // libuv os.homedir() honours $HOME on posix
  __resetWebTokenCacheForTest();
}

test('web-token: generates a >=32-char token, persists it 0600, and reuses it', () => {
  tmpHome();
  const t1 = getOrCreateWebToken();
  assert.ok(t1.length >= 32, 'token is long enough');
  const p = webTokenPath();
  assert.ok(fs.existsSync(p), 'token file written');
  assert.equal(fs.statSync(p).mode & 0o777, 0o600, 'owner-only perms');
  __resetWebTokenCacheForTest();
  assert.equal(getOrCreateWebToken(), t1, 'a restart reuses the persisted token');
});

test('web-token: validation is exact and rejects wrong/short/empty/non-string', () => {
  tmpHome();
  const t = getOrCreateWebToken();
  assert.equal(validateWebToken(t), true);
  assert.equal(validateWebToken(t + 'x'), false, 'longer mismatch rejected');
  assert.equal(validateWebToken('nope'), false, 'short mismatch rejected');
  assert.equal(validateWebToken(''), false);
  assert.equal(validateWebToken(undefined), false);
  assert.equal(validateWebToken(12345), false);
});
