/**
 * helper.ts — the ALWAYS-ON local-7B helper (BRAIN-05).
 *
 * This is NOT a BrainProvider and is NEVER swapped by Settings — it sits BESIDE the providers
 * because it cannot belong to any one impl. It runs regardless of which brain is selected, for
 * cheap high-frequency turns: `triage()` (importance/urgency tagging), `classify()` (pick a
 * label from a set), `narrate()` (a short filler line while the cloud thinks).
 *
 * It always hits Ollama (`/api/chat`, same pinned model as LocalBrain) and is ABSENT-TOLERANT:
 * when the Ollama call rejects (Ollama not running on this machine) every function returns a
 * NEUTRAL DEFAULT and NEVER throws — it must never block the loop (RESEARCH.md Pattern 4).
 */
import { OLLAMA_CHAT_URL, OLLAMA_MODEL } from './LocalBrain.js';

/** A triage verdict for a short message. Neutral default = unflagged, normal priority. */
export interface Triage {
  important: boolean;
  urgency: 'low' | 'normal' | 'high';
}

/** The neutral triage default returned when Ollama is absent or the reply is unusable. */
const NEUTRAL_TRIAGE: Triage = { important: false, urgency: 'normal' };

/**
 * Hit Ollama `/api/chat` once and return the assistant's text content, or null on any failure
 * (unreachable, non-ok, empty). Never throws — absence is a null, not an exception.
 */
async function ask(system: string, user: string): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(OLLAMA_CHAT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        stream: false,
        options: { temperature: 0.1, num_ctx: 4096 },
        // keep_alive OMITTED — never -1 (16GB idle-unload).
      }),
    });
  } catch {
    return null; // Ollama unreachable → neutral default upstream.
  }
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { message?: { content?: string } } | null;
  return body?.message?.content ?? null;
}

/**
 * Tag a short message's importance/urgency. Returns the neutral default when Ollama is absent
 * or the model output cannot be parsed. Never throws.
 */
export async function triage(message: string): Promise<Triage> {
  const text = await ask(
    'You triage short messages. Reply ONLY with compact JSON: {"important":boolean,"urgency":"low|normal|high"}.',
    message,
  );
  if (!text) return NEUTRAL_TRIAGE;
  try {
    const obj = JSON.parse(text) as Partial<Triage>;
    const urgency = obj.urgency === 'low' || obj.urgency === 'high' ? obj.urgency : 'normal';
    return { important: Boolean(obj.important), urgency };
  } catch {
    return NEUTRAL_TRIAGE;
  }
}

/**
 * Pick the best-fitting label from `labels` for `text`. Returns the FIRST label as the neutral
 * default when Ollama is absent or the reply is not one of the offered labels. Never throws.
 */
export async function classify(text: string, labels: string[]): Promise<string> {
  const fallback = labels[0] ?? '';
  const reply = await ask(
    `Classify the text into exactly one of these labels: ${labels.join(', ')}. Reply with ONLY the label.`,
    text,
  );
  if (!reply) return fallback;
  const match = labels.find((l) => reply.trim().toLowerCase() === l.toLowerCase());
  return match ?? fallback;
}

/**
 * Produce a short narration line for `topic` (e.g. a filler while the cloud thinks). Returns an
 * empty string as the neutral default when Ollama is absent. Never throws.
 */
export async function narrate(topic: string): Promise<string> {
  const reply = await ask(
    'You write a single short, calm sentence of narration. No preamble. One sentence only.',
    topic,
  );
  return reply ? reply.trim() : '';
}
