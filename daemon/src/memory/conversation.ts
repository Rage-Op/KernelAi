/**
 * conversation.ts — the rolling SHORT-TERM conversation buffer (the fix for "KERNEL doesn't
 * remember context between two consecutive prompts").
 *
 * Until now every utterance was a stateless single-shot: the brain saw only the current prompt +
 * the long-term memory injection, never the previous turn. Ollama `/api/chat` keeps NO server-side
 * session state, so the daemon must own the rolling message array and replay it each call. This
 * module is that owner.
 *
 * Two memories, kept DISTINCT (no double-counting):
 *   - LONG-TERM  = inject() (IDENTITY, current.md, retrieved knowledge) → the SYSTEM message.
 *   - SHORT-TERM = this buffer (the literal back-and-forth of THIS session) → the dialogue turns.
 * `/compact` is the one-way valve from short→long; `/clear` empties the short-term buffer.
 *
 * PROVENANCE (defense-in-depth, matching inject()'s external-exclusion and /override's user-only
 * parse): ONLY `source:'user'` turns are ever recorded — a poisoned email or tool result is injected
 * DATA, never a conversational turn, so it can never gain the standing of something "you said".
 *
 * BOUNDED two ways so it can never overflow the model window: a TURN cap (most recent exchanges
 * kept verbatim) and a TOKEN budget (oldest dropped first). It is EPHEMERAL (in-process, never
 * written to the git memory repo — the durable record already lives in the append-only logs).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatTurn } from '../brain/BrainProvider.js';

/** Keep at most this many recent turns verbatim (≈4 user+assistant exchanges — enough for a 7-9B
 *  model to stay coherent without crowding the window). */
export const MAX_TURNS = 8;

/** One persisted line in the durable transcript (JSONL). `clear` is a sentinel the boot-time
 *  reload stops at, so `/clear` resets the model's context across restarts while the history view
 *  still shows the full record. */
export interface PersistedTurn {
  role: 'user' | 'assistant' | 'clear';
  content: string;
  ts: number;
}

/** A history entry surfaced to the Face (owner/assistant turns only, with a timestamp). */
export interface HistoryEntry {
  role: 'user' | 'assistant';
  text: string;
  ts: number;
}

/**
 * The durable transcript path: a JSONL next to the UDS socket / brain.json in the daemon's
 * Application Support dir — NOT the git-backed kernel-memory repo, so chat logs are never pushed to
 * GitHub. Computed without importing config (mirrors config.resolveSocketPath) to keep this module
 * dependency-light and test-safe.
 */
export function defaultConversationLogPath(): string {
  return path.join(os.homedir(), 'Library', 'Application Support', 'Kernel', 'conversation.jsonl');
}

/** Hard ceiling on replayed-history tokens, regardless of the dynamic budget — a safety rail
 *  against context-window overflow (the model front-truncates, which would drop the system prompt
 *  first). Sized to sit comfortably inside the local model's window alongside memory + output. */
export const HISTORY_TOKEN_BUDGET = 3000;

/** ~4 chars/token — the same cheap estimate the meta-command reports use (no real tokenizer). */
export function estTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/**
 * A bounded, in-process ring of recent dialogue turns. Owned by the loop; one per daemon process.
 */
export class ConversationBuffer {
  private turns: ChatTurn[] = [];

  /**
   * @param logPath durable JSONL transcript path, or null for an in-memory-only buffer (tests).
   *   When set, every recorded turn is appended and `load()` repopulates the in-context buffer on
   *   boot so the model remembers across daemon restarts.
   */
  constructor(private readonly logPath: string | null = null) {}

  /** Record the owner's utterance (called only for `source:'user'` intents). */
  recordUser(content: string): void {
    const text = content.trim();
    if (text) {
      this.turns.push({ role: 'user', content: text });
      this.append('user', text);
    }
  }

  /** Record KERNEL's reply (called only after a `source:'user'` turn produced a reply). */
  recordAssistant(content: string): void {
    const text = content.trim();
    if (text) {
      this.turns.push({ role: 'assistant', content: text });
      this.append('assistant', text);
    }
  }

  /** Append one persisted line to the durable transcript. Best-effort — a write failure is
   *  swallowed (the in-memory buffer still works; persistence is a convenience, never load-bearing). */
  private append(role: PersistedTurn['role'], content: string): void {
    if (!this.logPath) return;
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      const entry: PersistedTurn = { role, content, ts: Date.now() };
      fs.appendFileSync(this.logPath, JSON.stringify(entry) + '\n', 'utf8');
    } catch {
      /* persistence is best-effort */
    }
  }

  /** Parse the durable transcript into entries, skipping malformed lines. */
  private readPersisted(): PersistedTurn[] {
    if (!this.logPath) return [];
    let raw: string;
    try {
      raw = fs.readFileSync(this.logPath, 'utf8');
    } catch {
      return []; // absent file → empty history
    }
    const out: PersistedTurn[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as PersistedTurn;
        if (
          (o.role === 'user' || o.role === 'assistant' || o.role === 'clear') &&
          typeof o.content === 'string'
        ) {
          out.push({ role: o.role, content: o.content, ts: typeof o.ts === 'number' ? o.ts : 0 });
        }
      } catch {
        /* skip a corrupt line */
      }
    }
    return out;
  }

  /**
   * Reload the in-context buffer from the durable transcript on boot, so the model continues the
   * conversation across daemon restarts. Only the turns AFTER the last `/clear` sentinel are
   * restored (a clear resets context durably), capped to the most recent MAX_TURNS. A no-op for an
   * in-memory-only buffer or an absent log.
   */
  load(): void {
    if (!this.logPath) return; // in-memory-only buffer: nothing to restore, keep current turns
    const persisted = this.readPersisted();
    const lastClear = persisted.map((t) => t.role).lastIndexOf('clear');
    const live = persisted
      .slice(lastClear + 1)
      .filter((t): t is PersistedTurn & { role: 'user' | 'assistant' } => t.role !== 'clear');
    this.turns = live.slice(-MAX_TURNS).map((t) => ({ role: t.role, content: t.content }));
  }

  /**
   * The recent chat history for the Face's Chat page (owner/assistant turns only, with timestamps),
   * across the WHOLE transcript (clears are not visual breaks here — the owner can scroll past
   * conversations). Returns the most recent `limit` entries in chronological order.
   */
  readRecent(limit = 200): HistoryEntry[] {
    const entries = this.readPersisted()
      .filter((t) => t.role === 'user' || t.role === 'assistant')
      .map((t) => ({ role: t.role as 'user' | 'assistant', text: t.content, ts: t.ts }));
    return entries.slice(-limit);
  }

  /**
   * The recent turns to replay, newest-anchored and trimmed OLDEST-FIRST to fit BOTH the turn cap
   * and a token budget. `budgetTokens` lets the loop subtract the already-assembled memory/context
   * from the window each turn; it is additionally clamped to HISTORY_TOKEN_BUDGET so a huge window
   * (e.g. a cloud brain) still can't let the buffer balloon. Returned in chronological order so the
   * model reads user→assistant→…→ the current prompt that follows.
   */
  history(budgetTokens: number = HISTORY_TOKEN_BUDGET): ChatTurn[] {
    const cap = Math.max(0, Math.min(budgetTokens, HISTORY_TOKEN_BUDGET));
    const kept: ChatTurn[] = [];
    let tokens = 0;
    for (let i = this.turns.length - 1; i >= 0 && kept.length < MAX_TURNS; i--) {
      const t = estTokens(this.turns[i].content);
      if (tokens + t > cap) break;
      kept.unshift(this.turns[i]);
      tokens += t;
    }
    return kept;
  }

  /**
   * Empty the in-context buffer (the `/clear` command — start a fresh conversation). Writes a
   * `clear` sentinel to the durable transcript so the reset survives a restart (`load()` only
   * restores turns after the last clear), WITHOUT erasing the history the Chat page shows.
   */
  clear(): void {
    this.turns = [];
    this.append('clear', '');
  }

  /** Total recorded turns (for the /context report + tests). */
  size(): number {
    return this.turns.length;
  }
}

/**
 * The single daemon-process conversation buffer (module singleton, like the loop's queue/brain).
 * Persists to the durable transcript so chat history survives restarts; `index.ts` calls `load()`
 * on boot to restore the model's recent context.
 */
export const conversation = new ConversationBuffer(defaultConversationLogPath());
