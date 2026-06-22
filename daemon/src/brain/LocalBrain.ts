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

/**
 * Output contract appended to the system message so the small local model emits the Decision
 * shape (qwen2.5 with `format:'json'` returns valid JSON, but without steering it invents shapes
 * like `{"role":"assistant","content":"…"}`). Mirrors DecisionSchema: `thought` + `reply` for a
 * conversational answer; `action` only when a tool is genuinely needed. parseDecision still
 * salvages a reply if the model ignores this, so it is guidance, not a hard dependency.
 */
const DECISION_INSTRUCTION =
  'Respond with ONLY a single JSON object and nothing else. Shape: ' +
  '{"thought": "<your brief private reasoning>", "reply": "<the message to show the user, in plain prose>"}. ' +
  'Put your conversational answer in "reply" as plain text (do not nest JSON inside it). ' +
  'Include an "action" field only if you must call a tool.';

/** The context window (tokens) requested per pass. Surfaced in usage so a client can show it. */
export const OLLAMA_NUM_CTX = 8192;

/** The Ollama `/api/chat` response shape (only the fields the brain reads). Durations are ns. */
interface OllamaChatResponse {
  message?: { role: string; content: string };
  model?: string;
  done?: boolean;
  error?: string;
  /** Input tokens evaluated. */
  prompt_eval_count?: number;
  /** Output tokens generated. */
  eval_count?: number;
  /** Generation duration (nanoseconds) — basis for tokens/sec. */
  eval_duration?: number;
  /** Model load duration (nanoseconds) — non-zero when the model (re)loaded this turn. */
  load_duration?: number;
  /** End-to-end duration (nanoseconds). */
  total_duration?: number;
}

/** Nanoseconds → milliseconds (Ollama reports durations in ns), or undefined when absent. */
function nsToMs(ns?: number): number | undefined {
  return typeof ns === 'number' ? ns / 1e6 : undefined;
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
            { role: 'system', content: `${context}\n\n${DECISION_INSTRUCTION}` },
            { role: 'user', content: prompt },
          ],
          stream: false,
          format: 'json',
          options: { temperature: 0.2, num_ctx: OLLAMA_NUM_CTX },
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
    const decision = parseDecision(content);
    // Attach per-pass telemetry from Ollama's counters (set programmatically — never parsed from
    // the model's JSON). The IPC server turns this into a `stats` frame for the client dashboard.
    decision.usage = {
      model: body?.model ?? OLLAMA_MODEL,
      promptTokens: body?.prompt_eval_count,
      outputTokens: body?.eval_count,
      evalMs: nsToMs(body?.eval_duration),
      loadMs: nsToMs(body?.load_duration),
      totalMs: nsToMs(body?.total_duration),
      contextWindow: OLLAMA_NUM_CTX,
    };
    return decision;
  }
}
