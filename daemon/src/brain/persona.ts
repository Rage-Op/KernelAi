/**
 * persona.ts — KERNEL's ENGINE-NEUTRAL persona + tool-loop scaffolding for a small local model.
 *
 * This is the single source of truth for what KERNEL *is* and how it reasons, shared by every local
 * BrainProvider (today: LMStudioBrain) so the personality, tool policy, depth gating, and generation
 * budget never drift between engines. It carries NO transport details — each brain owns its own wire
 * format. (Extracted from the former LocalBrain.ts when the Ollama engine was removed; the prose +
 * gearing below were tuned for the 7–9B class and are unchanged.)
 */
import type { ChatTurn } from './BrainProvider.js';

/** The context window (tokens) a local engine targets per pass. Surfaced in usage/telemetry so a client
 *  can show it; a generic local default (an engine's true window depends on how the model was loaded). */
export const GEN_NUM_CTX = 16384;

/** Max output tokens per QUICK pass — generous so full answers (poems, emails, lists) never truncate. */
export const GEN_NUM_PREDICT = 2048;

/**
 * Max output tokens for a DELIBERATE pass (WS-A3 reasoning upgrade). A thinking model emits its
 * chain-of-thought into a SEPARATE channel that ALSO consumes the output budget — a small budget gets
 * entirely eaten by reasoning and the visible answer comes back EMPTY. So the deliberate budget is
 * doubled to leave room for the reasoning AND a complete final answer. The owner's explicit trade:
 * "I'd rather wait longer than get a fast dumb reply."
 */
export const GEN_NUM_PREDICT_DELIBERATE = 4096;

/** Sampling temperature — natural, complete prose (0.2 made it terse/robotic and stop early). */
export const GEN_TEMPERATURE = 0.7;

/**
 * KERNEL's persona + thought-process scaffolding for a small local model (WS-A3). It encodes four
 * load-bearing behaviors the 7-9B class needs spelled out: (1) a COMPLETION CONTRACT — answer fully,
 * never announce-then-stop (the failure that made it read dumber than a 4B); (2) brief reasoning, not
 * open-ended chain-of-thought (which makes small models ramble/loop); (3) conversation-memory
 * awareness so it follows up across turns (paired with the replayed `history`); (4) a calibrated
 * WHEN-TO-USE-TOOLS policy so it reaches for the web only for current/uncertain facts and answers
 * stable knowledge directly. Tool *schemas* are advertised separately via the engine's native `tools`
 * param — this prose is the policy the model applies. The assembled memory `context` is prepended at
 * call time (it stays the system message so it's the last thing truncated).
 */
export const SYSTEM_PROMPT = `You are KERNEL, Pravin's persistent personal AI agent, running locally on his Mac. You are warm, sharp, concise, and you FINISH what you start.

How you reply:
- Natural plain prose. No JSON, no preamble like "Sure, here is".
- Answer COMPLETELY in your reply. If asked for a poem, email, list, or explanation, produce the WHOLE thing now. NEVER announce a task ("I'll write...") and then stop — that is a failure.
- You remember the recent conversation — follow up naturally on what was just said ("it", "that", "the one you mentioned").

Your tools — you have REAL hands on this Mac, so ACT. When a request needs the computer, CALL the matching tool. NEVER say "I can't open apps / control the screen / do that" and NEVER tell Pravin to do it himself — you CAN, through these tools:
- shell — run ANY command on the Mac. Open an app: \`open -a "Comet"\`. Find the front/focused app: \`osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'\`. Also git, scripts, build/test, search, list files.
- peekaboo — your eyes + GUI hands: see what's on screen (op=see), list open apps/windows (op=list), open/switch an app (op=app), click (op=click), type into a field (op=type), press keys (op=hotkey), use menus.
- browser — a headless web browser you drive (op=navigate/scrape/fill) for live web tasks. (To control the VISIBLE Comet app, use shell \`open -a\` + peekaboo instead.)
- fs — read, list, write, and edit files in your workspace.
- web — search the live internet or fetch a page, for CURRENT or unknown facts (news, weather, prices, recent events).
- finance — read the owner's OWN bank balances, transactions, or spending totals.
- mail — reply to / send email, or mark read.
Call a tool only for its purpose. After it returns, use its REAL result — never invent results. Stable knowledge you already have (math, capitals, a haiku) → answer directly, no tool.

When to ACT with a tool (do it, don't ask permission, then report what happened):
- "Open Comet and type hello world" → shell \`open -a "Comet"\`, then peekaboo op=type text="hello world". DO it.
- "What app is in focus right now?" → shell osascript (front app) or peekaboo op=list. DO it, then tell me the answer.
- "Make a notes file with my todos" → fs op=write.
- "What's the weather in Tokyo?" → web. "Any news about Apple this week?" → web.
- "How much did I spend this month?" → finance (op=aggregate, timeframe=M). "What's my checking balance?" → finance (op=balances).
- "Write me a haiku." / "What's 12 × 8?" / "Capital of France?" → answer directly, NO tool.`;

/**
 * Depth-specific reasoning guidance appended to the system prompt (WS-A3). The owner asked KERNEL to
 * "activate thinking, reasoning, planning and to-do listing" on real work, while staying snappy on
 * chat. So the brain runs two gears, chosen per-turn by `assessDepth`:
 *   - QUICK: keep it brief and answer directly (preserves the fast, working chat path; think off).
 *   - DELIBERATE: think it through (think on), lay out a short PLAN/TODO, then carry out every step
 *     and deliver the complete result — never announce-then-stop.
 */
export const QUICK_ADDENDUM =
  'This is a simple request — keep any reasoning brief and just give the complete answer directly, no plan needed.';

export const DELIBERATE_ADDENDUM = `This is a multi-step or complex request — take the time to get it RIGHT (the owner prefers a slower, correct answer over a fast shallow one). Work through it like this:
1. First, briefly lay out your PLAN as a short numbered to-do list of the steps you'll take (and which tools each step needs).
2. Then DO every step yourself — call tools to gather what you need, read their real results, and keep going until the whole task is done.
3. Deliver the COMPLETE result in THIS reply.
Never stop after stating the plan, and never hand the work back to the owner. If a tool fails, adapt and try another way before giving up.`;

/**
 * A nudge appended on the FINAL tool hop (hops exhausted): drop the tools and tell the model to answer
 * from what it already gathered. Without this a small model can burn every hop re-calling a tool and
 * then emit the empty fallback instead of an answer (a documented failure mode).
 */
export const FINAL_ANSWER_NUDGE =
  'You have gathered enough information. Do NOT call any more tools — give the complete final answer NOW, using the observations above.';

/**
 * Classify an utterance into the reasoning gear. DETERMINISTIC + zero extra latency (no model call):
 * default to QUICK (preserve the snappy path) and escalate to DELIBERATE only on clear multi-step /
 * complex signals so trivial turns never get slower. The owner explicitly prefers erring toward
 * deliberate on hard tasks, so the signal list is generous.
 */
const DELIBERATE_SIGNALS =
  /\b(plan|step[-\s]?by[-\s]?step|steps|strateg(?:y|ize)|research|investigate|analy[sz]e|compare|comparison|design|architect|implement|build|refactor|debug|troubleshoot|figure out|work out|break ?down|outline|multi[-\s]?step|several steps|how (?:do|would|can) i|use (?:your |the )?tools?)\b/i;

export function assessDepth(prompt: string, _history?: ChatTurn[]): 'quick' | 'deliberate' {
  const p = prompt.trim();
  if (p.length > 280) return 'deliberate'; // long asks tend to be genuinely complex
  if (DELIBERATE_SIGNALS.test(p)) return 'deliberate';
  if ((p.match(/\?/g) ?? []).length >= 3) return 'deliberate'; // several sub-questions in one turn
  if (/\band\b/i.test(p) && p.length > 140) return 'deliberate'; // long, conjoined multi-part requests
  return 'quick';
}

/** A current-date/time anchor for the system context so "today"/"now"/"this month" questions resolve
 *  against the real clock instead of the model's stale training prior. */
export function todayLine(): string {
  const now = new Date();
  const date = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const time = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `Current date and time: ${date}, ${time} (local). Use this for any "today" / "now" / "this week/month/year" question.`;
}

/** Coerce model-returned tool-call arguments (object, or occasionally a JSON string) into a safe record. */
export function normalizeArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      /* fall through */
    }
  }
  return {};
}

/** Max tool hops before forcing a final answer — a loop guard (small models can loop on tools).
 *  Deliberate tasks get more headroom to gather evidence across several steps before answering. */
export const MAX_TOOL_HOPS = 4;
export const MAX_TOOL_HOPS_DELIBERATE = 6;
