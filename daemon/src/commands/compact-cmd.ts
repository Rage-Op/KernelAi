/**
 * `compact` meta-command — condense the conversation so far, à la Claude Code's /compact.
 *
 * KERNEL's "conversation" lives as (a) the append-only daily logs — the FULL record, never touched
 * here — and (b) working-memory/current.md, the rolling scratchpad that injection carries verbatim
 * (priority 2, never truncated). When that scratchpad grows it eats the 16K injection budget, so
 * compaction's legitimate, useful target is current.md: summarize (old scratchpad + recent turns)
 * into a tight briefing and write it back, freeing budget for retrieval.
 *
 * Safety:
 *   - IDENTITY.md is NEVER a write target (assertNotIdentityPath guards every write).
 *   - The append-only logs are READ, never rewritten (CORE-05 invariant preserved).
 *   - The prior scratchpad is ARCHIVED before overwrite, so compaction is fully reversible.
 *   - `source:external` turns are EXCLUDED from the summary input — external content is never
 *     promoted into the privileged scratchpad (the same rule consolidation enforces, Pitfall 4).
 *
 * `compact <focus>` passes free-text focus instructions to the summarizer (e.g. "focus on the
 * finance work"), mirroring Claude Code's optional /compact instructions.
 */
import fs from 'node:fs';
import path from 'node:path';

import { config } from '../config.js';
import { assertNotIdentityPath } from '../memory/identity.js';
import { logger } from '../memory/log.js';
import type { BrainProvider } from '../brain/BrainProvider.js';
import { commas, estTokens } from './format.js';

const SEP = '\n';
/** Most recent trusted turns folded into the summary (bounds the prompt size). */
const MAX_TURNS = 30;
/** Per-turn reply cap when building the summarization input (bounds prompt size). */
const TURN_CLIP = 600;
/** Daily log files to scan (today + the prior day, so we span a midnight boundary). */
const RECENT_LOG_FILES = 2;

interface Turn {
  source: string;
  intent?: string;
  reply?: string;
}

/** Parse `## Session N` blocks of one daily log into turns. */
function parseTurns(logText: string): Turn[] {
  const blocks = logText.split(/^## Session \d+/m).slice(1);
  const field = (block: string, name: string): string | undefined => {
    const m = block.match(new RegExp(`\\*\\*${name}:\\*\\*\\s*(.+)`));
    return m ? m[1].trim() : undefined;
  };
  return blocks.map((block) => ({
    source: (field(block, 'source') ?? 'self').toLowerCase(),
    intent: field(block, 'intent'),
    reply: field(block, 'reply'),
  }));
}

/** Most recent trusted (non-external), non-command turns with a real reply, oldest→newest. */
function gatherRecentTurns(memoryDir: string): Turn[] {
  const dir = path.join(memoryDir, 'logs');
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/.test(e.name))
    .map((e) => e.name)
    .sort()
    .slice(-RECENT_LOG_FILES);

  const turns: Turn[] = [];
  for (const name of files) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    for (const t of parseTurns(text)) {
      // SAFETY: never feed external-sourced content into the privileged scratchpad.
      if (t.source === 'external') continue;
      if (!t.reply || t.reply === '(no reply)') continue;
      // Skip meta/override command echoes (their intent is a slash-command).
      if (t.intent && t.intent.trim().startsWith('/')) continue;
      turns.push(t);
    }
  }
  return turns.slice(-MAX_TURNS);
}

/** Assemble the text handed to the summarizer: the scratchpad plus the recent dialogue. */
function buildConversationText(oldCurrent: string, turns: Turn[]): string {
  const parts: string[] = [];
  if (oldCurrent.trim()) parts.push(`## Current scratchpad\n${oldCurrent.trim()}`);
  if (turns.length) {
    const dialogue = turns
      .map((t) => {
        const reply = (t.reply ?? '').slice(0, TURN_CLIP);
        const ask = t.intent ? `Pravin: ${t.intent.slice(0, TURN_CLIP)}\n` : '';
        return `${ask}KERNEL: ${reply}`;
      })
      .join('\n\n');
    parts.push(`## Recent conversation (${turns.length} turns)\n${dialogue}`);
  }
  return parts.join('\n\n');
}

function summarizationPrompt(focus: string): string {
  const focusLine = focus
    ? ` Pay special attention to: ${focus}.`
    : '';
  return (
    'Compact KERNEL\'s working memory. Below is the current scratchpad and the recent ' +
    'conversation. Produce a CONCISE briefing (plain prose or short bullets) that preserves ' +
    'open tasks, decisions made, key facts, and anything still in flight — and drops chit-chat ' +
    'and resolved noise.' +
    focusLine +
    ' Output ONLY the briefing text, no preamble, no JSON.'
  );
}

/** Is the brain's reply a usable summary (vs. an echo / empty / the input verbatim)? */
function isUsableSummary(summary: string | undefined, conversationText: string): summary is string {
  if (!summary) return false;
  const s = summary.trim();
  if (s.length < 16) return false;
  if (s.includes('StubBrain')) return false; // the no-op stub echo
  // Reject a verbatim echo of the input (the model parroting instead of summarizing).
  if (conversationText.length > 40 && s.includes(conversationText.slice(0, 40))) return false;
  return true;
}

/** Collect the string leaves of an arbitrary JSON value into bullet lines. */
function flattenToLines(value: unknown, lines: string[]): void {
  if (typeof value === 'string') {
    const t = value.trim();
    if (t) lines.push(/^[-•*]/.test(t) ? t : `- ${t}`);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) flattenToLines(v, lines);
    return;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) flattenToLines(v, lines);
  }
}

/**
 * Normalize a brain summary to clean prose. The LocalBrain runs Ollama in `format:'json'` (for the
 * Decision schema), so qwen often returns the briefing as a JSON object/array rather than prose —
 * flatten that into bullet lines so current.md stays human-readable. Non-JSON replies pass through.
 */
function normalizeSummary(raw: string): string {
  const s = raw.trim();
  if (!(s.startsWith('{') || s.startsWith('['))) return s;
  try {
    const lines: string[] = [];
    flattenToLines(JSON.parse(s), lines);
    return lines.length ? lines.join('\n') : s;
  } catch {
    return s; // not valid JSON after all — keep the original text
  }
}

/** Deterministic extractive digest — the fallback when the brain returns nothing usable. */
function fallbackDigest(turns: Turn[]): string {
  if (!turns.length) return 'No recent conversation to summarize.';
  const recent = turns.slice(-12);
  const bullets = recent
    .map((t) => {
      const r = (t.reply ?? '').replace(/\s+/g, ' ').slice(0, 160);
      return `- ${r}`;
    })
    .join('\n');
  return `Recent activity (most recent ${recent.length} turns):\n${bullets}`;
}

/** Filesystem-safe ISO stamp for the archive filename. */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Compact working-memory/current.md: summarize (old scratchpad + recent turns), archive the prior
 * scratchpad, write the condensed briefing back, and report what was freed.
 */
export async function runCompact(
  arg: string,
  memoryDir: string = config.memoryDir,
  brain: BrainProvider,
): Promise<string> {
  const focus = arg.trim();
  const currentPath = path.join(memoryDir, 'working-memory', 'current.md');
  const oldCurrent = fs.existsSync(currentPath) ? fs.readFileSync(currentPath, 'utf8') : '';
  const turns = gatherRecentTurns(memoryDir);

  const conversationText = buildConversationText(oldCurrent, turns);
  if (!conversationText.trim()) {
    return 'KERNEL · compact — nothing to compact (working memory is already empty).';
  }

  // Summarize via the active brain; fall back to a deterministic digest if it returns nothing usable
  // (e.g. the StubBrain, or a flaky model), so compact is reliable regardless of the brain.
  let summary: string;
  let summarizedBy: string;
  try {
    const decision = await brain.reason(summarizationPrompt(focus), conversationText);
    if (isUsableSummary(decision.reply, conversationText)) {
      summary = normalizeSummary(decision.reply.trim());
      summarizedBy = 'the active brain';
    } else {
      summary = fallbackDigest(turns);
      summarizedBy = 'a deterministic digest (the brain returned no usable summary)';
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'compact: brain summarization failed — using deterministic digest',
    );
    summary = fallbackDigest(turns);
    summarizedBy = 'a deterministic digest (summarization failed)';
  }

  // Archive the prior scratchpad first (compaction is reversible — nothing is lost).
  let archiveRel = '(none — scratchpad was empty)';
  if (oldCurrent.trim()) {
    const archiveDir = path.join(memoryDir, 'working-memory', 'archive');
    const archivePath = path.join(archiveDir, `current-${stamp()}.md`);
    assertNotIdentityPath(archivePath, memoryDir);
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(archivePath, oldCurrent, 'utf8');
    archiveRel = path.relative(memoryDir, archivePath).split(path.sep).join('/');
  }

  // Write the condensed scratchpad back (IDENTITY can never be the target).
  assertNotIdentityPath(currentPath, memoryDir);
  fs.mkdirSync(path.dirname(currentPath), { recursive: true });
  const compactedAt = new Date().toISOString();
  const newCurrent =
    `# Working memory (compacted ${compactedAt})\n\n` +
    (focus ? `_Focus: ${focus}_\n\n` : '') +
    `${summary.trim()}\n\n` +
    `---\n` +
    `_Compacted from ${commas(oldCurrent.length)} chars + ${turns.length} recent session(s). ` +
    `Prior scratchpad archived to ${archiveRel}._\n`;
  fs.writeFileSync(currentPath, newCurrent, 'utf8');

  const before = oldCurrent.length;
  const after = newCurrent.length;
  const freed = before - after;
  const pct = before > 0 ? Math.round((freed / before) * 100) : 0;

  logger.info(
    { event: 'compact.run', before, after, freed, turns: turns.length },
    'working memory compacted',
  );

  return [
    'KERNEL · compact',
    '─'.repeat(54),
    `  before    ${commas(before)} chars (~${commas(estTokens(before))} tok)   + ${turns.length} recent session(s)`,
    `  after     ${commas(after)} chars (~${commas(estTokens(after))} tok)`,
    freed > 0
      ? `  freed     ${commas(freed)} chars (${pct}%)   in working-memory/current.md`
      : `  note      scratchpad grew by ${commas(-freed)} chars (it was already lean)`,
    `  archived  prior scratchpad → ${archiveRel}`,
    `  summary   by ${summarizedBy}`,
    focus ? `  focus     ${focus}` : '',
  ]
    .filter(Boolean)
    .join(SEP);
}
