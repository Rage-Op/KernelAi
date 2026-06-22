/**
 * safety/audit.ts — the append-only audit log for every Red verdict (SAFE-03 / V7 logging).
 *
 * Records WHAT happened (the ToolCall + the outcome + the content hash the breaker computed) so a
 * Red action is never silent and is non-repudiable. It is append-only NDJSON under the memory repo
 * (`self/audit-log`), one JSON object per line, never truncated.
 *
 * SECURITY (V7): the audit NEVER logs finance amounts or transaction detail — only the call shape,
 * the outcome, and the content hash. The hashing itself lives in the breaker (node:crypto SHA-256);
 * this module merely records the supplied hash. Hand-rolling a hash here is forbidden (ASVS V6).
 */
import fs from 'node:fs';
import path from 'node:path';

import type { ToolCall } from '../brain/BrainProvider.js';

/** The outcome of a gated Red verdict, in the order the breaker resolves them. */
export type AuditOutcome =
  | 'executed' // breaker ran the action (no cancel, ceiling OK, TOCTOU OK)
  | 'cancelled' // owner cancelled within the 10s window
  | 'ceiling-exceeded' // daily spend ceiling would be crossed → escalate
  | 'toctou-abort' // state changed between preview and execute → abort
  | 'denied'; // gate denied (credential fence / external-Red hard block)

/**
 * One audit record. `hash` is present on the 'executed' path (the content hash that was verified
 * immediately before execute). `ts` is an ISO timestamp. NO finance amount ever appears here.
 */
export interface AuditEntry {
  /** The tool call this verdict concerned (shape only — never finance amounts). */
  call: Pick<ToolCall, 'tool'> & { tool: string; args?: Record<string, unknown> };
  /** The terminal outcome. */
  outcome: AuditOutcome;
  /** The SHA-256 content hash the breaker verified before execute (executed path only). */
  hash?: string;
  /** ISO-8601 timestamp. */
  ts: string;
}

/** Default audit-log location under a memory dir (NDJSON, append-only). */
export function defaultAuditPath(memoryDir: string): string {
  return path.join(memoryDir, 'self', 'audit-log');
}

/**
 * Append one entry to the audit log as a single NDJSON line. Creates the parent dir if needed.
 * `filePath` is injectable so tests write to a tmpdir (and most tests use the capturing sink from
 * test-helpers instead of touching the filesystem at all).
 */
export function appendAudit(entry: AuditEntry, filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8');
}
