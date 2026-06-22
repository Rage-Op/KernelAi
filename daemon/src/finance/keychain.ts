/**
 * finance/keychain.ts (FIN-03) — read/create the SQLCipher DB key in the macOS Keychain via the
 * zero-dep `security` CLI (verified working live: add-generic-password / find-generic-password).
 *
 * Why the CLI (not keytar / a native addon): the `security` round-trip is verified on this
 * machine, adds NO dependency + no legitimacy checkpoint, and mirrors the shipped
 * ClaudeCodeBrain spawn discipline (node:child_process, never execa). keytar is REJECTED
 * (archived atom/node-keytar). @napi-rs/keyring is the documented fallback only.
 *
 * Hard invariants (ASVS V6/V7, threat T-04-08):
 *   - the plaintext key NEVER touches a file or the kernel-memory repo — it lives ONLY in the
 *     Keychain (read on demand) and transiently in process memory to open the DB.
 *   - the key is NEVER logged.
 *   - ABSENT-TOLERANT: any spawn failure (no `security` on PATH, denied access) returns a TYPED
 *     { ok:false, reason } result — it NEVER throws across the caller boundary.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

/** The `security` CLI binary. Named constant so it is correctable if the path ever changes. */
export const SECURITY_CLI = '/usr/bin/security';

/** The captured result of one `security` invocation. */
export interface SecurityResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** A spawn fn for the `security` CLI. The test seam injects a mock to avoid a real Keychain write. */
export type SecuritySpawn = (args: string[]) => Promise<SecurityResult>;

/** A typed key result. ok=false carries a reason (absent-tolerant — never a throw). */
export interface KeychainKeyResult {
  ok: boolean;
  /** The DB key (only meaningful when ok=true). Never logged. */
  key: string;
  reason?: string;
}

/** The real spawn: run `security <args>`, capture streams, translate spawn-error into a code. */
const realSpawn: SecuritySpawn = (args: string[]) =>
  new Promise<SecurityResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(SECURITY_CLI, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr?.on('data', (d) => (stderr += d.toString('utf8')));
    // ENOENT (no `security` on PATH) surfaces as an 'error' event — translate, never throw.
    child.on('error', (err) => resolve({ code: 127, stdout, stderr: stderr + String(err) }));
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });

/** The active spawn (test seam overrides it). */
let securitySpawn: SecuritySpawn | null = null;

/** TEST-ONLY seam: inject a mock `security` spawn (or null to reset to the real CLI). */
export function __setSecuritySpawnForTest(fn: SecuritySpawn | null): void {
  securitySpawn = fn;
}

/** A fresh 256-bit key as a hex string (64 hex chars) — strong, file-safe for the SQLCipher pragma. */
function generateKey(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Read the DB key from the Keychain, creating + persisting a fresh random one on a miss.
 * Absent-tolerant: ANY spawn failure returns { ok:false, reason } — never throws.
 *
 * @param service the generic-password service label (e.g. 'com.kernel.finance')
 * @param account the generic-password account label (e.g. 'db-key')
 */
export async function getOrCreateKeychainKey(
  service: string,
  account: string,
): Promise<KeychainKeyResult> {
  const run = securitySpawn ?? realSpawn;
  try {
    // 1. try to read an existing key (-w prints just the password to stdout).
    const found = await run(['find-generic-password', '-s', service, '-a', account, '-w']);
    if (found.code === 0) {
      const key = found.stdout.trim();
      if (key.length > 0) return { ok: true, key };
    }

    // 2. miss → generate a random key and persist it (-U updates if it somehow exists).
    const key = generateKey();
    const added = await run([
      'add-generic-password',
      '-s',
      service,
      '-a',
      account,
      '-w',
      key,
      '-U',
    ]);
    if (added.code !== 0) {
      return {
        ok: false,
        key: '',
        reason: `security add-generic-password failed (code ${added.code}): ${added.stderr.trim()}`,
      };
    }
    return { ok: true, key };
  } catch (err) {
    // absent-tolerant: a thrown spawn error becomes a typed result.
    return {
      ok: false,
      key: '',
      reason: `security spawn failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
