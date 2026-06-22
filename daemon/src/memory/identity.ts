/**
 * IDENTITY.md integrity guard (MEM-02).
 *
 * IDENTITY.md is the durable persona injected at the start of every session and is
 * NEVER auto-edited. Two code-level invariants protect it:
 *
 *   1. A SHA-256 baseline (self/identity.hash) recorded on first run; `readIdentityVerified`
 *      recomputes the hash at read time and FAILS LOUD on any mismatch (an out-of-band
 *      tamper) — it never silently returns and never auto-re-baselines. The only sanctioned
 *      way to change IDENTITY.md is a human edit followed by a human re-baseline.
 *   2. A write-path guard (`assertNotIdentityPath`) every memory writer calls before
 *      writing, so no daemon code path can ever target IDENTITY.md.
 *
 * The hash uses node:crypto SHA-256 — never a hand-rolled hash (RESEARCH.md Security V6).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { config } from '../config.js';

/** Thrown when IDENTITY.md's current hash does not match its recorded baseline. */
export class IdentityIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityIntegrityError';
  }
}

/** Absolute path of IDENTITY.md under the given memory dir. */
function identityPath(memoryDir: string): string {
  return path.join(memoryDir, 'IDENTITY.md');
}

/** Absolute path of the stored SHA-256 baseline (self/identity.hash). */
function baselinePath(memoryDir: string): string {
  return path.join(memoryDir, 'self', 'identity.hash');
}

/**
 * SHA-256 hex digest of IDENTITY.md's raw bytes. Deterministic; node:crypto only.
 */
export function computeIdentityHash(memoryDir: string = config.memoryDir): string {
  const bytes = fs.readFileSync(identityPath(memoryDir));
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Record the current IDENTITY.md hash to self/identity.hash IF no baseline exists yet.
 * On first run this seeds the baseline; if a baseline already exists it is returned
 * unchanged — there is NO auto-re-baseline (a human must delete/replace it deliberately).
 * Returns the effective baseline hash.
 */
export function baselineIdentityHash(memoryDir: string = config.memoryDir): string {
  const file = baselinePath(memoryDir);
  if (fs.existsSync(file)) {
    return fs.readFileSync(file, 'utf8').trim();
  }
  const hash = computeIdentityHash(memoryDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, hash + '\n', 'utf8');
  return hash;
}

/**
 * Read IDENTITY.md and verify its SHA-256 against the recorded baseline.
 * Returns the file text on match. FAILS LOUD on mismatch or missing baseline —
 * never silently returns, never re-baselines.
 */
export function readIdentityVerified(memoryDir: string = config.memoryDir): string {
  const file = baselinePath(memoryDir);
  if (!fs.existsSync(file)) {
    throw new IdentityIntegrityError(
      `CRITICAL: no IDENTITY baseline recorded at ${file}. ` +
        `Refusing to inject an unverified IDENTITY.md. Run the human re-baseline step first.`,
    );
  }
  const baseline = fs.readFileSync(file, 'utf8').trim();
  const current = computeIdentityHash(memoryDir);
  if (current !== baseline) {
    throw new IdentityIntegrityError(
      `CRITICAL: IDENTITY.md hash mismatch — the persona file was changed out of band ` +
        `(baseline=${baseline.slice(0, 12)}…, current=${current.slice(0, 12)}…). ` +
        `Refusing to inject. The only sanctioned change is a human edit + human re-baseline.`,
    );
  }
  return fs.readFileSync(identityPath(memoryDir), 'utf8');
}

/**
 * Write-path guard: throws if `target` resolves to the IDENTITY.md path.
 * Every memory writer MUST call this before writing so no daemon code path
 * can ever target IDENTITY.md (defense-in-depth alongside the hash guard).
 */
export function assertNotIdentityPath(target: string, memoryDir: string = config.memoryDir): void {
  const resolved = path.resolve(target);
  const identity = path.resolve(identityPath(memoryDir));
  if (resolved === identity) {
    throw new Error(
      `Refusing to write to IDENTITY.md (${identity}) — it is never auto-edited (MEM-02).`,
    );
  }
}
