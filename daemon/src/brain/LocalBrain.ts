/**
 * LocalBrain.ts — the local brain (BRAIN-03), Ollama `/api/chat` over native fetch.
 *
 * Selectable from Settings (`brain=local`). POSTs role-structured messages to
 * `http://localhost:11434/api/chat` with `model: qwen2.5:7b-instruct-q4_K_M`,
 * `format: 'json'` (structured-output coercion), and `stream: false`. The model's
 * `message.content` JSON is mapped to a Decision via `parseDecision`.
 *
 * ABSENT-TOLERANT (RESEARCH.md Pitfall 5 — Ollama is absent on this machine): a rejected
 * fetch (ECONNREFUSED) and a non-ok "model not found" body each return a TYPED ESCALATION
 * Decision, never throwing across the loop boundary. `keep_alive` is OMITTED (never -1) so
 * the 16GB idle-unload behavior holds.
 */
import type { BrainProvider, Decision } from './BrainProvider.js';
import { parseDecision } from './decision.js';

/** The pinned local model tag (A1: configurable, kept in a named constant, not buried). */
export const OLLAMA_MODEL = 'qwen2.5:7b-instruct-q4_K_M';

/** The Ollama chat endpoint (local-only; no network port crosses a trust boundary). */
export const OLLAMA_CHAT_URL = 'http://localhost:11434/api/chat';

/** The Ollama `/api/chat` response shape (only the fields the brain reads). */
interface OllamaChatResponse {
  message?: { role: string; content: string };
  done?: boolean;
  error?: string;
}

export class LocalBrain implements BrainProvider {
  async reason(prompt: string, context: string): Promise<Decision> {
    let res: Response;
    try {
      res = await fetch(OLLAMA_CHAT_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          messages: [
            { role: 'system', content: context },
            { role: 'user', content: prompt },
          ],
          stream: false,
          format: 'json',
          options: { temperature: 0.2, num_ctx: 8192 },
          // keep_alive intentionally OMITTED — never -1 (16GB idle-unload, BRAIN-03 / Pitfall 3).
        }),
      });
    } catch {
      // ECONNREFUSED / DNS / network: Ollama is not running. Typed escalation, no throw.
      return {
        thought: 'ollama unreachable (ECONNREFUSED)',
        reply:
          'Local brain is unavailable — Ollama is not running. Start it (`ollama serve`) and ' +
          `ensure the model is pulled (\`ollama pull ${OLLAMA_MODEL}\`).`,
      };
    }

    if (!res.ok) {
      // A non-ok body frequently names a missing model on a fresh install. Surface the pull cmd.
      const bodyText = await res.text().catch(() => '');
      const namesMissingModel = /not found|no such model|pull/i.test(bodyText);
      return {
        thought: `ollama /api/chat non-ok (${res.status})`,
        reply: namesMissingModel
          ? `Local model is not installed — run \`ollama pull ${OLLAMA_MODEL}\`, then retry.`
          : `Local brain returned an error (HTTP ${res.status}). Check that Ollama is healthy.`,
      };
    }

    const body = (await res.json().catch(() => null)) as OllamaChatResponse | null;
    const content = body?.message?.content;
    if (!content) {
      return { thought: 'ollama reply had no message.content', reply: 'Local brain returned an empty reply.' };
    }
    return parseDecision(content);
  }
}
