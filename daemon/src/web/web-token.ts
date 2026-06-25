/**
 * web-token.ts — the bearer token that authenticates the daemon-hosted web Face.
 *
 * The web HTTP server (web/http-server.ts) exposes endpoints that ultimately reach the gate-chokepointed
 * tools (shell/fs/finance). Binding to 127.0.0.1 stops remote access, but ANY local process (or a random
 * browser tab) could still POST frames. So every web request must carry a secret token. It is generated
 * once (32 random bytes), persisted next to the socket at `~/Library/Application Support/Kernel/web-token`
 * with 0600 perms (owner-only), and embedded in the launcher URL the owner opens. This is the SAME
 * "secret in a 0600 file the owner already controls" pattern the rest of KERNEL uses (keychain/ledger).
 *
 * The token is NOT a substitute for the gate — every action still routes through registry.dispatch →
 * gate.authorize. It is the front-door lock on WHO can talk to the daemon over HTTP.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** The token file path: alongside the UDS socket under macOS app-support, owner-only. */
export function webTokenPath(): string {
  return path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Kernel',
    'web-token',
  );
}

/** Cached token for the life of the process (avoids re-reading the file on every request). */
let cached: string | null = null;

/**
 * Return the persisted web token, generating + persisting one on first use. A pre-existing token of
 * sufficient length is reused (so the owner's bookmarked URL keeps working across restarts); anything
 * too short/garbled is regenerated. Best-effort 0600 perms.
 */
export function getOrCreateWebToken(): string {
  if (cached) return cached;
  const p = webTokenPath();
  try {
    const existing = fs.readFileSync(p, 'utf8').trim();
    if (existing.length >= 32) {
      cached = existing;
      return existing;
    }
  } catch {
    /* absent — generate below */
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, token, { mode: 0o600 });
  try {
    fs.chmodSync(p, 0o600); // enforce perms even if the file pre-existed with looser ones
  } catch {
    /* best-effort */
  }
  cached = token;
  return token;
}

/**
 * Constant-time comparison of a provided token against the real one. Returns false for any
 * absent/short/mismatched input WITHOUT leaking timing. Use for every web request.
 */
export function validateWebToken(provided: unknown): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const real = getOrCreateWebToken();
  const a = Buffer.from(provided);
  const b = Buffer.from(real);
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** TEST-ONLY: reset the in-process cache so a test can point at a temp HOME/token. */
export function __resetWebTokenCacheForTest(): void {
  cached = null;
}
