/**
 * Meta-command registry + parser — KERNEL's Claude-Code-style introspection commands.
 *
 * Three commands: `context` (what's assembled into the prompt), `usage` (cumulative session
 * telemetry), `compact` (condense the working scratchpad). They're reachable two ways, both routed
 * HERE:
 *   1. Typed:           `/context`, `/usage`, `/compact focus on the build` (forwarded verbatim
 *                       by any client — the CLI, the `nc -U` backdoor, a future Face).
 *   2. Natural language: "what's in your context", "how much have I used", "compact the conversation".
 *
 * `parseCommand` is deterministic and runs in the loop BEFORE the brain (mirroring
 * parseOverrideCommand): it short-circuits the tick so the answer is exact and instant, never at the
 * mercy of a 7B model deciding to "call a tool". Crucially it only ever inspects `source:'user'`
 * text — external content arrives as injected DATA, never as the utterance — so a poisoned email can
 * no more run `/compact` than it can run `/override`.
 *
 * Natural-language matching is deliberately CONSERVATIVE (anchored phrasings, standalone keywords)
 * to avoid hijacking ordinary requests like "let's compact the sprint scope into one doc".
 */
import { config } from '../config.js';
import type { BrainProvider } from '../brain/BrainProvider.js';
import { conversation } from '../memory/conversation.js';
import { runContextReport } from './context-cmd.js';
import { runUsageReport } from './usage-cmd.js';
import { runCompact } from './compact-cmd.js';

export type CommandName = 'context' | 'usage' | 'compact' | 'clear';

export interface ParsedCommand {
  name: CommandName;
  /** Free-text argument (e.g. compact focus instructions, or "reset" for usage). */
  arg: string;
}

/** Explicit slash-command aliases → canonical command. */
const ALIASES: Record<string, CommandName> = {
  context: 'context',
  ctx: 'context',
  usage: 'usage',
  cost: 'usage',
  tokens: 'usage',
  spend: 'usage',
  compact: 'compact',
  condense: 'compact',
  clear: 'clear',
  forget: 'clear',
  newchat: 'clear',
};

/**
 * Conservative natural-language patterns per command. Anchored to clearly-introspective phrasings so
 * ordinary work ("compact the report", "the usage stats look fine") doesn't trip them.
 */
const NL_PATTERNS: Record<CommandName, RegExp[]> = {
  context: [
    /\bcontext\s+(?:is\s+|are\s+|do\s+i\s+have\s+)?(window|size|usage|breakdown|budget|left|remaining)\b/i,
    /what(?:'s| is| are)?\s+(?:currently\s+)?(?:in\s+)?(?:your|the)\s+context\b/i,
    /how\s+(?:much|big|full)\s+(?:is\s+)?(?:your|the)\s+context\b/i,
    /show\s+(?:me\s+)?(?:the\s+|your\s+)?context\b/i,
    /what(?:'s| is)\s+(?:loaded|injected)\b/i,
  ],
  usage: [
    /how\s+(?:much|many)\s+(?:tokens?|have\s+i\s+(?:used|spent)|did\s+(?:i|this|we)\s+(?:cost|use))/i,
    /\b(?:token|tokens)\s+(?:used|usage|count|spent)\b/i,
    /(?:what(?:'s| is)|show)\s+(?:me\s+)?(?:my\s+|the\s+|our\s+)?(?:usage|cost|spend)\b/i,
    /how\s+much\s+(?:have\s+i|did\s+i|has\s+this|did\s+we)\s+(?:cost|spent|spend|used)/i,
  ],
  compact: [
    /\bcompact\b[^\n]*\b(conversation|context|memory|chat|history|scratchpad|working\s*memory)\b/i,
    /\bcompact\s+(this|it|everything)\b/i,
    /(summari[sz]e|condense|shrink|trim|compress)\s+(?:the\s+|my\s+|our\s+)?(conversation|context|working\s*memory|memory|scratchpad)\b/i,
    /free\s+up\s+(?:some\s+)?(context|memory)\b/i,
  ],
  clear: [
    /(clear|reset|wipe|forget)\s+(?:the\s+|this\s+|our\s+)?(conversation|chat|history)\b/i,
    /\bstart\s+(?:a\s+)?(?:new|fresh)\s+(conversation|chat)\b/i,
    /\bforget\s+(?:everything|what\s+we\s+(?:talked|discussed|said))\b/i,
  ],
};

/**
 * Resolve a USER utterance to a meta-command, or null if it isn't one.
 *
 * Resolution order:
 *   1. Explicit slash command (`/context`, `/compact <arg>`). Unknown slashes are NOT intercepted.
 *   2. Standalone keyword (`context`, `ctx`, `usage`) or a leading `compact [focus]`.
 *   3. Conservative natural-language phrasing anywhere in the utterance.
 */
export function parseCommand(rawText: unknown, source: string): ParsedCommand | null {
  if (source !== 'user') return null; // only trusted user text — never injected/external content
  if (typeof rawText !== 'string') return null;
  const text = rawText.trim();
  if (!text) return null;

  // 1) explicit slash command: /name [arg...]
  if (text.startsWith('/')) {
    const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text);
    if (m) {
      const name = ALIASES[m[1].toLowerCase()];
      if (name) return { name, arg: m[2].trim() };
    }
    return null; // unknown slash → not a meta-command (don't intercept)
  }

  // 2) standalone keyword (the typed shorthand). Bare `compact` triggers, but `compact <free text>`
  //    does NOT — that's ambiguous with a real task ("compact the sprint scope into one doc"), so
  //    focus instructions must come via the explicit slash form (`/compact <focus>`). Memory-anchored
  //    phrasings ("compact the conversation") are handled by the NL patterns below.
  const oneWord = text.toLowerCase().replace(/[.!?]+$/, '');
  if (oneWord === 'context' || oneWord === 'ctx') return { name: 'context', arg: '' };
  if (oneWord === 'usage') return { name: 'usage', arg: '' };
  if (oneWord === 'compact') return { name: 'compact', arg: '' };

  // 3) conservative natural-language phrasing.
  for (const name of ['context', 'usage', 'compact'] as CommandName[]) {
    if (NL_PATTERNS[name].some((re) => re.test(text))) return { name, arg: '' };
  }
  return null;
}

/** Context a command needs to run. */
export interface CommandContext {
  /** Memory root (tests pass a temp dir; defaults to config.memoryDir). */
  memoryDir?: string;
  /** The active brain (compact uses it to summarize). */
  brain: BrainProvider;
}

/** Execute a parsed meta-command and return its plain-text report (delivered as a reply frame). */
export async function runCommand(cmd: ParsedCommand, ctx: CommandContext): Promise<string> {
  const memoryDir = ctx.memoryDir ?? config.memoryDir;
  switch (cmd.name) {
    case 'context':
      return runContextReport(memoryDir);
    case 'usage':
      return runUsageReport(cmd.arg);
    case 'compact':
      return runCompact(cmd.arg, memoryDir, ctx.brain);
    case 'clear': {
      // Empty the SHORT-TERM conversation buffer (start a fresh dialogue). Long-term memory in
      // kernel-memory (IDENTITY, current.md, knowledge) is untouched — that's `/compact`'s domain.
      const n = conversation.size();
      conversation.clear();
      return n > 0
        ? `Cleared the conversation — ${n} turn${n === 1 ? '' : 's'} forgotten. Long-term memory is untouched.`
        : 'Conversation already empty — nothing to clear.';
    }
  }
}
