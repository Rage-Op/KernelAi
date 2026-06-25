/**
 * ClaudeBrain.ts — the DEFAULT brain (BRAIN-02), Anthropic API via @anthropic-ai/sdk.
 *
 * MANUAL TOOL LOOP (BRAIN-06 — the load-bearing rule): `reason()` calls `messages.create`
 * ONCE. If Claude replies with text, that maps to `Decision.reply`. If Claude wants a tool
 * (`stop_reason === 'tool_use'`), `reason()` returns exactly ONE `Decision.action`
 * `{ tool, args }` and EXECUTES NOTHING — the KERNEL loop dispatches that action through
 * `router.dispatch → gate.authorize`, keeping the §8 gate physically between decide and act.
 *
 * The SDK's auto tool-execution helper is FORBIDDEN here — it would execute tools itself and
 * bypass the gate. We never call it; this brain only ever returns a Decision.action.
 *
 * Test seam: `__setClientForTest(mock)` injects a mock client (mirrors tools/peekaboo.ts),
 * so unit tests run with NO live ANTHROPIC_API_KEY / network. The real client is created
 * lazily from the env key (T-03-03: the key is read from env only, never logged/persisted).
 *
 * ABSENT-TOLERANT (mirrors LMStudioBrain): a missing API key, a network failure, or any SDK error
 * returns a TYPED ESCALATION Decision with an actionable reply — it NEVER throws across the loop
 * boundary (an unhandled throw here would crash the whole daemon).
 */
import Anthropic from '@anthropic-ai/sdk';

import type { BrainProvider, ChatTurn, Decision } from './BrainProvider.js';

/** The default model (BRAIN-02). Kept a named constant so it is configurable, not buried (A1). */
export const CLAUDE_MODEL = 'claude-opus-4-8';

/** Upper bound on a single reasoning pass. */
const MAX_TOKENS = 4096;

/** A content block as Claude returns it (only the fields the brain reads). */
interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
}

/** The shape of a `messages.create` response the brain consumes. */
interface ClaudeMessage {
  stop_reason: string | null;
  content: ContentBlock[];
}

/**
 * The minimal SDK surface ClaudeBrain uses. Declaring it lets tests inject a mock via
 * `__setClientForTest` without depending on the concrete SDK class (mirrors peekaboo.ts).
 */
export interface ClaudeClient {
  messages: {
    create(params: unknown): Promise<ClaudeMessage>;
  };
}

/** The cached client (test seam overrides it). Created lazily from the env key. */
let client: ClaudeClient | null = null;

/** TEST-ONLY seam: inject a mocked SDK client (or null to reset to lazy real-client creation). */
export function __setClientForTest(mock: ClaudeClient | null): void {
  client = mock;
}

/** Lazily construct the real Anthropic client from the env key. Reused across calls. */
function getClient(): ClaudeClient {
  if (client) return client;
  // The SDK reads ANTHROPIC_API_KEY from the env by default (T-03-03 — env only).
  client = new Anthropic() as unknown as ClaudeClient;
  return client;
}

/** Turn an SDK/auth/network failure into a typed escalation Decision (never thrown across the loop). */
function claudeErrorDecision(err: unknown): Decision {
  const m = err instanceof Error ? err.message : String(err);
  const auth = /authenticat|api[_\s-]?key|x-api-key|401|unauthorized|credential|resolve authentication/i.test(m);
  return {
    thought: `cloud brain error: ${m.slice(0, 140)}`,
    reply: auth
      ? 'Cloud brain (Claude) is unavailable — no API key is configured. Add `export ANTHROPIC_API_KEY=…` ' +
        'to ~/.kernel.env and restart the daemon, or switch the engine to LM Studio in Settings.'
      : `Cloud brain (Claude) hit an error (${m.slice(0, 80)}). Check the network / API key, or switch to LM Studio.`,
  };
}

/** Concatenate all text blocks of a message into one string (the "thought"/reply text). */
function textOf(msg: ClaudeMessage): string {
  return msg.content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
    .trim();
}

export class ClaudeBrain implements BrainProvider {
  async reason(
    prompt: string,
    context: string,
    _onToken?: (chunk: string) => void,
    history?: ChatTurn[],
  ): Promise<Decision> {
    let msg: ClaudeMessage;
    try {
      msg = await getClient().messages.create({
        model: CLAUDE_MODEL,
        max_tokens: MAX_TOKENS,
        system: context, // IDENTITY + memory the loop's inject() assembled (stays the system prompt)
        // prior dialogue turns precede the current utterance so Claude can follow up across prompts.
        messages: [...(history ?? []), { role: 'user', content: prompt }],
      });
    } catch (err) {
      // Missing key / network / SDK error → a typed escalation, NOT a thrown daemon crash.
      return claudeErrorDecision(err);
    }

    // MANUAL tool loop (BRAIN-06): a tool_use turn returns ONE action; the loop gates+runs it.
    if (msg.stop_reason === 'tool_use') {
      const tu = msg.content.find((b) => b.type === 'tool_use');
      if (tu && typeof tu.name === 'string') {
        return {
          thought: textOf(msg) || 'claude requested a tool',
          action: { tool: tu.name, args: (tu.input as Record<string, unknown>) ?? {} },
        };
      }
      // tool_use with no usable block: degrade to a reply, never crash the loop.
      return { thought: 'claude tool_use without a tool block', reply: textOf(msg) };
    }

    // A plain text turn maps to Decision.reply.
    const text = textOf(msg);
    return { thought: text || 'claude reply', reply: text };
  }
}
