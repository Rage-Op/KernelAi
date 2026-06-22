import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  computeIdentityHash,
  baselineIdentityHash,
  readIdentityVerified,
  assertNotIdentityPath,
  IdentityIntegrityError,
} from './identity.js';

/** Create a throwaway memory dir seeded with an IDENTITY.md + self/. */
function makeMemoryDir(identityText: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-identity-'));
  fs.writeFileSync(path.join(dir, 'IDENTITY.md'), identityText, 'utf8');
  fs.mkdirSync(path.join(dir, 'self'), { recursive: true });
  return dir;
}

test('computeIdentityHash returns a stable SHA-256 hex of the IDENTITY bytes', () => {
  const dir = makeMemoryDir('# IDENTITY\n\nKERNEL is Pravin.\n');
  const h1 = computeIdentityHash(dir);
  const h2 = computeIdentityHash(dir);
  assert.equal(h1, h2, 'hash must be deterministic');
  assert.match(h1, /^[0-9a-f]{64}$/, 'SHA-256 hex is 64 lowercase hex chars');
});

test('baselineIdentityHash records the current hash to self/identity.hash on first run', () => {
  const dir = makeMemoryDir('# IDENTITY\n\nseed\n');
  const hashFile = path.join(dir, 'self', 'identity.hash');
  assert.equal(fs.existsSync(hashFile), false, 'no baseline before first run');

  const baseline = baselineIdentityHash(dir);
  assert.equal(fs.existsSync(hashFile), true, 'baseline file written');
  assert.equal(fs.readFileSync(hashFile, 'utf8').trim(), baseline);
  assert.equal(baseline, computeIdentityHash(dir));
});

test('baselineIdentityHash does NOT overwrite an existing baseline (no auto-re-baseline)', () => {
  const dir = makeMemoryDir('# IDENTITY\n\noriginal\n');
  const original = baselineIdentityHash(dir);

  // Tamper the file, then call baseline again — it must keep the ORIGINAL baseline.
  fs.writeFileSync(path.join(dir, 'IDENTITY.md'), '# IDENTITY\n\nTAMPERED\n', 'utf8');
  const second = baselineIdentityHash(dir);
  assert.equal(second, original, 'existing baseline is never silently re-written');
  assert.equal(fs.readFileSync(path.join(dir, 'self', 'identity.hash'), 'utf8').trim(), original);
});

test('readIdentityVerified returns the IDENTITY text when the hash matches the baseline', () => {
  const text = '# IDENTITY\n\nKERNEL is Pravin. Never auto-edited.\n';
  const dir = makeMemoryDir(text);
  baselineIdentityHash(dir);

  const got = readIdentityVerified(dir);
  assert.equal(got, text, 'verified read returns the exact IDENTITY bytes');
});

test('readIdentityVerified FAILS LOUD (throws IdentityIntegrityError) on an out-of-band change', () => {
  const dir = makeMemoryDir('# IDENTITY\n\noriginal persona\n');
  baselineIdentityHash(dir);

  // Out-of-band tamper (no human re-baseline).
  fs.writeFileSync(path.join(dir, 'IDENTITY.md'), '# IDENTITY\n\nPOISONED persona\n', 'utf8');

  assert.throws(
    () => readIdentityVerified(dir),
    (err: unknown) => err instanceof IdentityIntegrityError,
    'a tampered IDENTITY must throw IdentityIntegrityError, never silently return',
  );
});

test('readIdentityVerified throws if no baseline has been recorded (refuses to silently re-baseline)', () => {
  const dir = makeMemoryDir('# IDENTITY\n\nno baseline yet\n');
  assert.throws(() => readIdentityVerified(dir), 'must throw when no baseline exists');
});

test('assertNotIdentityPath throws for the IDENTITY.md path and passes for any other path', () => {
  const dir = makeMemoryDir('# IDENTITY\n\nx\n');
  const identityPath = path.join(dir, 'IDENTITY.md');

  assert.throws(
    () => assertNotIdentityPath(identityPath, dir),
    'the write-path guard must reject the IDENTITY.md path',
  );
  // A relative/unnormalized spelling of the same file is still rejected.
  assert.throws(
    () => assertNotIdentityPath(path.join(dir, 'self', '..', 'IDENTITY.md'), dir),
    'an unnormalized path to IDENTITY.md is still rejected',
  );
  // Any non-IDENTITY target is fine.
  assert.doesNotThrow(() => assertNotIdentityPath(path.join(dir, 'knowledge', 'note.md'), dir));
});
