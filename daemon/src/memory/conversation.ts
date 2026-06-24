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
import type { ChatTurn } from '../brain/BrainProvider.js';

/** Keep at most this many recent turns verbatim (≈4 user+assistant exchanges — enough for a 7-9B
 *  model to stay coherent without crowding the window). */
export const MAX_TURNS = 8;

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

  /** Record the owner's utterance (called only for `source:'user'` intents). */
  recordUser(content: string): void {
    const text = content.trim();
    if (text) this.turns.push({ role: 'user', content: text });
  }

  /** Record KERNEL's reply (called only after a `source:'user'` turn produced a reply). */
  recordAssistant(content: string): void {
    const text = content.trim();
    if (text) this.turns.push({ role: 'assistant', content: text });
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

  /** Empty the buffer (the `/clear` command — start a fresh conversation). */
  clear(): void {
    this.turns = [];
  }

  /** Total recorded turns (for the /context report + tests). */
  size(): number {
    return this.turns.length;
  }
}

/** The single daemon-process conversation buffer (module singleton, like the loop's queue/brain). */
export const conversation = new ConversationBuffer();
