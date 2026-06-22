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
 */
import Anthropic from '@anthropic-ai/sdk';

import type { BrainProvider, Decision } from './BrainProvider.js';

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

/** Concatenate all text blocks of a message into one string (the "thought"/reply text). */
function textOf(msg: ClaudeMessage): string {
  return msg.content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
    .trim();
}

export class ClaudeBrain implements BrainProvider {
  async reason(prompt: string, context: string): Promise<Decision> {
    const msg = await getClient().messages.create({
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      system: context, // IDENTITY + memory the loop's inject() assembled
      messages: [{ role: 'user', content: prompt }],
    });

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
