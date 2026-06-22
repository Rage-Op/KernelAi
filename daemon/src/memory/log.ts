/**
 * Append-only session-block + heartbeat writer (CORE-05).
 *
 * All daemon activity is APPENDED (never truncated) to `logs/{YYYY-MM-DD}.md` under
 * the memory repo. Two markdown writers:
 *   - `logSession({intent, decision})` opens the next `## Session N` block (N = count of
 *     existing blocks + 1) and appends the intent, the brain's `thought`, the `reply`,
 *     and an ISO timestamp. Re-running appends a NEW block, leaving prior blocks intact.
 *   - `logHeartbeat()` appends a single dated `heartbeat {ISO}` line to the same file.
 *
 * Alongside the human-readable markdown blocks, `pino` writes structured JSON event
 * lines (the raw events later phases distill). `pino-pretty` is DEV-ONLY and never on
 * the launchd-run path — pino here writes plain JSON to stdout/the captured log.
 *
 * The IDENTITY write-path guard is honored implicitly: this writer only ever targets
 * `logs/{date}.md`, never IDENTITY.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';

import { config } from '../config.js';
import { assertNotIdentityPath } from './identity.js';

/**
 * Structured JSON logger. Plain pino (NOT pino-pretty) so it is safe on the
 * launchd-run path; the launchd plist captures stdout/stderr to logs/daemon.*.log.
 */
export const logger = pino({ level: process.env.KERNEL_LOG_LEVEL ?? 'info' });

/** Today's date as YYYY-MM-DD (UTC date slice, matching the e2e's todayLogPath). */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Absolute path of today's append-only log file under the given memory dir. */
function logPath(memoryDir: string): string {
  return path.join(memoryDir, 'logs', `${today()}.md`);
}

/** Ensure logs/ exists and return today's log file path. */
function ensureLogFile(memoryDir: string): string {
  const file = logPath(memoryDir);
  assertNotIdentityPath(file, memoryDir); // defense-in-depth: never IDENTITY.md
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

/** Count existing `## Session N` blocks in the file (0 if the file is absent). */
function countSessions(file: string): number {
  if (!fs.existsSync(file)) return 0;
  const text = fs.readFileSync(file, 'utf8');
  const matches = text.match(/^## Session \d+/gm);
  return matches ? matches.length : 0;
}

/** A logged loop tick: the originating intent and the brain's decision. */
export interface SessionEntry {
  /** The intent that drove the tick (e.g. {source:'user', payload:'...'}). */
  intent: { source: string; payload: unknown; id?: string };
  /** The brain's decision: thought + optional reply/action. */
  decision: { thought: string; reply?: string; action?: unknown };
}

/**
 * Append a `## Session N` block to today's log (CORE-05, append-only).
 * Never truncates; each call adds a new numbered block. Returns the block number.
 */
export function logSession(
  entry: SessionEntry,
  memoryDir: string = config.memoryDir,
): number {
  const file = ensureLogFile(memoryDir);
  const n = countSessions(file) + 1;
  const ts = new Date().toISOString();
  const replyLine = entry.decision.reply ?? '(no reply)';
  const payloadStr =
    typeof entry.intent.payload === 'string'
      ? entry.intent.payload
      : JSON.stringify(entry.intent.payload);

  const block =
    `\n## Session ${n}\n\n` +
    `- **time:** ${ts}\n` +
    `- **source:** ${entry.intent.source}\n` +
    (entry.intent.id ? `- **id:** ${entry.intent.id}\n` : '') +
    `- **intent:** ${payloadStr}\n` +
    `- **thought:** ${entry.decision.thought}\n` +
    `- **reply:** ${replyLine}\n`;

  fs.appendFileSync(file, block, 'utf8');
  logger.info(
    { event: 'session', n, source: entry.intent.source, id: entry.intent.id },
    'session logged',
  );
  return n;
}

/**
 * Append a single dated heartbeat line to today's log (CORE-03 / CORE-05).
 * Short-lived `--heartbeat` calls this then exit. Returns the line written.
 */
export function logHeartbeat(memoryDir: string = config.memoryDir): string {
  const file = ensureLogFile(memoryDir);
  const ts = new Date().toISOString();
  const line = `heartbeat ${ts}\n`;
  fs.appendFileSync(file, line, 'utf8');
  logger.info({ event: 'heartbeat', ts }, 'heartbeat appended');
  return line;
}
