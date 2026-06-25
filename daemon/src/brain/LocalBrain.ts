/**
 * LocalBrain.ts — the local brain (BRAIN-03), Ollama `/api/chat` over native fetch.
 *
 * Selectable from Settings (`brain=local`). POSTs role-structured messages to
 * `http://localhost:11434/api/chat` with `model: qwen3.5:9b`. It speaks as KERNEL
 * in plain prose — NOT JSON. (The old `format:'json'` + temperature 0.2 coercion made the model
 * announce-then-stop, e.g. "I'll write a poem" with no poem, and read dumber than a 4B model. We
 * removed it: a warm persona, a normal sampling temperature, and a generous output budget let the
 * model actually answer.)
 *
 * Streaming: when the caller passes `onToken`, the model is streamed (`stream:true`) and each
 * content delta is surfaced immediately so the reply renders + speaks in real time. Without it, a
 * single non-streamed response is used (the simpler path the unit tests exercise).
 *
 * ABSENT-TOLERANT (RESEARCH.md Pitfall 5): a rejected fetch (ECONNREFUSED) and a non-ok
 * "model not found" body each return a TYPED ESCALATION Decision, never throwing across the loop
 * boundary. `keep_alive` is OMITTED (never -1) so the 16GB idle-unload behavior holds.
 */
import type {
  BrainProvider,
  BrainUsage,
  ChatTurn,
  Decision,
  ToolActivityEvent,
  ToolCall,
} from './BrainProvider.js';
import type { ToolResult } from '../tools/Tool.js';
import { dispatch as registryDispatch } from '../tools/registry.js';
import { localToolSpecs } from '../tools/specs.js';

/** The pinned local model tag (A1: configurable, kept in a named constant, not buried).
 *  qwen3.5:9b — current-gen instruct model with NATIVE tool calling + a 256K window, ~6.6 GB Q4
 *  resident (fits the 16 GB box alongside the Metal Face). A clear step up from qwen2.5:7b for tool
 *  use + reasoning; we deliberately did NOT pick a distilled-reasoning model (those ruminate instead
 *  of acting — the announce-then-stop failure we fought). Lighter fallback if RAM-pressured:
 *  `qwen3.5:4b` (~3.4 GB). Cloud `claude-opus-4-8` remains the hard-reasoning escalation tier. */
export const OLLAMA_MODEL = 'qwen3.5:9b';

/** The Ollama server base URL (local-only; no network port crosses a trust boundary). Override with
 *  KERNEL_OLLAMA_URL for a non-default host/port. The chat/tags/generate endpoints derive from it. */
export const OLLAMA_BASE_URL = process.env.KERNEL_OLLAMA_URL?.trim() || 'http://localhost:11434';

/** The Ollama chat endpoint. */
export const OLLAMA_CHAT_URL = `${OLLAMA_BASE_URL}/api/chat`;

/** The context window (tokens) requested per pass. Surfaced in usage so a client can show it.
 *  Raised to 16384 once short-term conversation history was added: system(memory+persona) + the
 *  replayed dialogue turns + the output reserve must all fit, and qwen3.5/qwen2.5 both support it
 *  comfortably on the 16 GB box (verify resident size with `ollama ps`). */
export const OLLAMA_NUM_CTX = 16384;

/** Max output tokens per QUICK pass — generous so full answers (poems, emails, lists) never truncate. */
export const OLLAMA_NUM_PREDICT = 2048;

/**
 * Max output tokens for a DELIBERATE pass (WS-A3 reasoning upgrade). When `think:true`, qwen3.5 emits
 * its chain-of-thought into a SEPARATE `message.thinking` channel that ALSO consumes the output budget
 * — a small num_predict gets entirely eaten by reasoning and the visible `content` answer comes back
 * EMPTY (verified live). So the deliberate budget is doubled to leave room for the reasoning AND a
 * complete final answer. The owner's explicit trade: "I'd rather wait longer than get a fast dumb reply."
 */
export const OLLAMA_NUM_PREDICT_DELIBERATE = 4096;

/** Sampling temperature — natural, complete prose (0.2 made it terse/robotic and stop early). */
export const OLLAMA_TEMPERATURE = 0.7;

/**
 * KERNEL's persona + thought-process scaffolding for a small local model (WS-A3). It encodes four
 * load-bearing behaviors the 7-9B class needs spelled out: (1) a COMPLETION CONTRACT — answer fully,
 * never announce-then-stop (the failure that made it read dumber than a 4B); (2) brief reasoning, not
 * open-ended chain-of-thought (which makes small models ramble/loop); (3) conversation-memory
 * awareness so it follows up across turns (paired with the replayed `history`); (4) a calibrated
 * WHEN-TO-USE-TOOLS policy so it reaches for the web only for current/uncertain facts and answers
 * stable knowledge directly. Tool *schemas* are advertised separately via Ollama's native `tools`
 * param (WS-A4) — this prose is the policy the model applies. The assembled memory `context` is
 * prepended at call time (it stays the system message so it's the last thing truncated).
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
 *   - QUICK: keep it brief and answer directly (preserves the fast, working chat path; think:false).
 *   - DELIBERATE: think it through (think:true), lay out a short PLAN/TODO, then carry out every step
 *     and deliver the complete result — never announce-then-stop.
 * Splitting the guidance is what lets us turn thinking ON for hard tasks WITHOUT re-introducing the
 * announce-then-stop rumination that the old global think:false was there to prevent.
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

/** A tool call as Ollama returns it in `message.tool_calls`. Arguments arrive as an object (Ollama
 *  parses them), but we normalize defensively in case a build returns a JSON string. */
interface OllamaToolCall {
  function?: { name?: string; arguments?: unknown };
}

/** The Ollama `/api/chat` response shape (only the fields the brain reads). Durations are ns. */
interface OllamaChatResponse {
  message?: { role: string; content: string; thinking?: string; tool_calls?: OllamaToolCall[] };
  model?: string;
  done?: boolean;
  error?: string;
  prompt_eval_count?: number; // input tokens evaluated
  prompt_eval_duration?: number; // prefill duration (ns) — basis for the progress estimate
  eval_count?: number; // output tokens generated
  eval_duration?: number; // generation duration (ns) — basis for tokens/sec
  load_duration?: number; // model load duration (ns)
  total_duration?: number; // end-to-end duration (ns)
}

/** Nanoseconds → milliseconds (Ollama reports durations in ns), or undefined when absent. */
function nsToMs(ns?: number): number | undefined {
  return typeof ns === 'number' ? ns / 1e6 : undefined;
}

/** Pull the per-pass telemetry out of an Ollama response object (the final/done line when streaming). */
function usageFrom(body: OllamaChatResponse | null): BrainUsage {
  return {
    model: body?.model ?? OLLAMA_MODEL,
    promptTokens: body?.prompt_eval_count,
    promptEvalMs: nsToMs(body?.prompt_eval_duration),
    outputTokens: body?.eval_count,
    evalMs: nsToMs(body?.eval_duration),
    loadMs: nsToMs(body?.load_duration),
    totalMs: nsToMs(body?.total_duration),
    contextWindow: OLLAMA_NUM_CTX,
  };
}

/** A message in the Ollama `/api/chat` array — system/user/assistant/tool, plus optional tool_calls. */
interface OllamaMessage {
  role: string;
  content: string;
  tool_calls?: OllamaToolCall[];
}

/** Max tool hops before forcing a final answer — a loop guard (small models can loop on tools).
 *  Deliberate tasks get more headroom to gather evidence across several steps before answering. */
export const MAX_TOOL_HOPS = 4;
export const MAX_TOOL_HOPS_DELIBERATE = 6;

/** The gated tool dispatcher (default routes through registry.dispatch so the gate stays in the
 *  path). A test seam swaps it so the tool loop runs without the real registry/network. */
type ToolDispatcher = (call: ToolCall) => Promise<ToolResult>;
let dispatcherOverride: ToolDispatcher | null = null;

/** TEST-ONLY seam: inject a tool dispatcher (or null to reset to the real gated registry). */
export function __setToolDispatcherForTest(d: ToolDispatcher | null): void {
  dispatcherOverride = d;
}

/** Default dispatch: stamp provenance and route through the gated registry chokepoint. Only GREEN
 *  read-only tools are advertised to this loop (see specs.ts), so origin doesn't gate them; we mark
 *  'user' because the local brain acts on the owner's behalf. */
function defaultDispatch(call: ToolCall): Promise<ToolResult> {
  return registryDispatch(call);
}

/** Coerce Ollama tool-call arguments (object, or occasionally a JSON string) into a safe record. */
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

/** A successful chat hop. */
interface ChatOk {
  ok: true;
  text: string;
  toolCalls: OllamaToolCall[];
  usage: BrainUsage;
}
/** A failed chat hop — carries the typed escalation Decision to return verbatim. */
interface ChatErr {
  ok: false;
  decision: Decision;
}

export class LocalBrain implements BrainProvider {
  async reason(
    prompt: string,
    context: string,
    onToken?: (chunk: string) => void,
    history?: ChatTurn[],
    onToolActivity?: (event: ToolActivityEvent) => void,
    onThinking?: (chunk: string, final: boolean) => void,
  ): Promise<Decision> {
    // Pick the reasoning gear for this turn (WS-A3). Quick = snappy chat; deliberate = think + plan.
    const depth = assessDepth(prompt, history);
    const deliberate = depth === 'deliberate';
    const addendum = deliberate ? DELIBERATE_ADDENDUM : QUICK_ADDENDUM;
    const messages: OllamaMessage[] = [
      // date anchor → system(memory+persona) → depth guidance → prior dialogue turns → the current
      // utterance. The system message stays element 0 so front-truncation evicts OLD DIALOGUE before
      // the instructions; the date anchor leads so "today/now" questions always have a real clock.
      { role: 'system', content: `${todayLine()}\n\n${context}\n\n${SYSTEM_PROMPT}\n\n${addendum}` },
      ...(history ?? []),
      { role: 'user', content: prompt },
    ];
    const maxHops = deliberate ? MAX_TOOL_HOPS_DELIBERATE : MAX_TOOL_HOPS;
    return this.runToolLoop(messages, onToken, 0, false, onToolActivity, { deliberate, maxHops }, onThinking);
  }

  /**
   * One ReAct hop: call the model (tools advertised). If it asks for a tool, GATE-dispatch each call
   * (through registry.dispatch — the §8 chokepoint stays physically between decide and act, never
   * raw execute), append the observation as a `role:'tool'` message (web text is DATA, not
   * instruction), and recurse for the final answer. Bounded by MAX_TOOL_HOPS so it always finishes.
   */
  private async runToolLoop(
    messages: OllamaMessage[],
    onToken: ((chunk: string) => void) | undefined,
    depth: number,
    usedTool: boolean,
    onToolActivity: ((event: ToolActivityEvent) => void) | undefined,
    opts: { deliberate: boolean; maxHops: number },
    onThinking?: (chunk: string, final: boolean) => void,
  ): Promise<Decision> {
    // On the final hop (tool budget exhausted) force a real answer: drop the tools and nudge the model
    // to answer from the observations it already has, so it can't burn out re-calling tools then stall.
    const finalHop = depth >= opts.maxHops;
    if (finalHop) {
      messages.push({ role: 'user', content: FINAL_ANSWER_NUDGE });
    }
    const result = await this.chat(messages, onToken, {
      deliberate: opts.deliberate,
      toolsAllowed: !finalHop,
    }, onThinking);
    if (!result.ok) return result.decision;
    const { text, toolCalls, usage } = result;

    if (!finalHop && toolCalls.length > 0) {
      // record the assistant's tool-call turn, then run each call and append its observation.
      messages.push({ role: 'assistant', content: text, tool_calls: toolCalls });
      const dispatch = dispatcherOverride ?? defaultDispatch;
      for (const tc of toolCalls) {
        const name = tc.function?.name ?? '';
        const args = normalizeArgs(tc.function?.arguments);
        const op = typeof args.op === 'string' ? args.op : name;
        // a short, non-sensitive label for the activity line (query for web; the op otherwise).
        const detail = typeof args.query === 'string' ? args.query.slice(0, 60) : op;
        onToolActivity?.({ tool: name, op, status: 'start', detail });
        const disp = await dispatch({ tool: name, args, origin: 'user' });
        onToolActivity?.({ tool: name, op, status: disp.ok ? 'ok' : 'error', detail });
        messages.push({
          role: 'tool',
          content: JSON.stringify(
            disp.ok ? disp.data : { error: disp.escalation?.reason ?? 'tool unavailable' },
          ),
        });
      }
      return this.runToolLoop(messages, onToken, depth + 1, true, onToolActivity, opts, onThinking);
    }

    let reply = text.trim();
    let finalUsage = usage;
    // If the model USED tools but produced NO prose, force one tool-less summary hop so a tool run can
    // never end in a silent/empty "I did nothing" reply (a documented small-model failure mode — it
    // sometimes stops after the observation without narrating the result). Bounded: one extra hop.
    if (!reply && usedTool && !finalHop) {
      messages.push({ role: 'user', content: FINAL_ANSWER_NUDGE });
      const forced = await this.chat(messages, onToken, { deliberate: opts.deliberate, toolsAllowed: false }, onThinking);
      if (forced.ok) {
        reply = forced.text.trim();
        finalUsage = forced.usage;
      }
    }
    return {
      thought: usedTool ? 'local reply (after tool use)' : 'local reply',
      reply: reply.length ? reply : 'Local brain returned an empty reply.',
      usage: finalUsage,
    };
  }

  /**
   * A single `/api/chat` call (streamed iff `onToken`), with the curated tool catalog advertised so
   * the model can decide to call a tool. Returns the text + any tool calls + usage, or a TYPED
   * escalation Decision on a connection/non-ok failure — it never throws across the loop boundary.
   */
  private async chat(
    messages: OllamaMessage[],
    onToken?: (chunk: string) => void,
    opts?: { deliberate?: boolean; toolsAllowed?: boolean },
    onThinking?: (chunk: string, final: boolean) => void,
  ): Promise<ChatOk | ChatErr> {
    const stream = typeof onToken === 'function';
    const deliberate = opts?.deliberate ?? false;
    const toolsAllowed = opts?.toolsAllowed ?? true;
    let res: Response;
    try {
      res = await fetch(OLLAMA_CHAT_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          messages,
          // Advertise the tool catalog so the model decides WHEN to call a tool — EXCEPT on the forced
          // final hop, where we omit tools entirely so Ollama can't emit a tool_call and must answer.
          ...(toolsAllowed ? { tools: localToolSpecs() } : {}),
          stream,
          // WS-A3 reasoning gear. QUICK turns keep thinking OFF — non-thinking mode dispatches eagerly,
          // ~40% fewer tokens/latency, and avoids the <think>-rumination that reproduced the
          // announce-then-stop failure. DELIBERATE turns turn thinking ON (with a doubled output budget,
          // since reasoning shares it) so hard tasks get the depth the owner asked for.
          think: deliberate,
          options: {
            temperature: OLLAMA_TEMPERATURE,
            num_ctx: OLLAMA_NUM_CTX,
            num_predict: deliberate ? OLLAMA_NUM_PREDICT_DELIBERATE : OLLAMA_NUM_PREDICT,
          },
          // keep_alive intentionally OMITTED — never -1 (16GB idle-unload, BRAIN-03 / Pitfall 3).
        }),
      });
    } catch {
      return {
        ok: false,
        decision: {
          thought: 'ollama unreachable (ECONNREFUSED)',
          reply:
            'Local brain is unavailable — Ollama is not running. Start it (`ollama serve`) and ' +
            `ensure the model is pulled (\`ollama pull ${OLLAMA_MODEL}\`).`,
        },
      };
    }

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      const namesMissingModel = /not found|no such model|pull/i.test(bodyText);
      return {
        ok: false,
        decision: {
          thought: `ollama /api/chat non-ok (${res.status})`,
          reply: namesMissingModel
            ? `Local model is not installed — run \`ollama pull ${OLLAMA_MODEL}\`, then retry.`
            : `Local brain returned an error (HTTP ${res.status}). Check that Ollama is healthy.`,
        },
      };
    }

    // Reasoning is a DELIBERATE-only signal: a quick turn runs think:false, so it must never surface a
    // reasoning block. Make that a code invariant (not a dependency on Ollama omitting message.thinking
    // for a non-think request) by only honoring the thinking sink on deliberate passes.
    const thinkingSink = deliberate ? onThinking : undefined;
    const read = stream && res.body
      ? await this.readStream(res.body, onToken!, thinkingSink)
      : await this.readSingle(res, thinkingSink);
    return { ok: true, ...read };
  }

  /** Non-streamed path: one JSON response — read content + any tool_calls. A deliberate pass also
   *  carries the whole `message.thinking` at once; surface it (then immediately close) so the
   *  non-streamed callers see reasoning too. */
  private async readSingle(
    res: Response,
    onThinking?: (chunk: string, final: boolean) => void,
  ): Promise<{ text: string; toolCalls: OllamaToolCall[]; usage: BrainUsage }> {
    const body = (await res.json().catch(() => null)) as OllamaChatResponse | null;
    const thinking = body?.message?.thinking;
    if (onThinking && typeof thinking === 'string' && thinking.length) {
      onThinking(thinking, false);
      onThinking('', true);
    }
    return {
      text: body?.message?.content ?? '',
      toolCalls: body?.message?.tool_calls ?? [],
      usage: usageFrom(body),
    };
  }

  /**
   * Streamed path: read Ollama's NDJSON, accumulate `message.content` deltas (surfaced via
   * `onToken` for a snappy reply), capture any `message.tool_calls`, and read usage from the `done`
   * line. Line-buffered, mirroring the IPC NDJSON discipline. When the model emits a tool call it
   * typically streams little/no content, so onToken simply doesn't fire until the answer hop.
   */
  private async readStream(
    body: ReadableStream<Uint8Array>,
    onToken: (chunk: string) => void,
    onThinking?: (chunk: string, final: boolean) => void,
  ): Promise<{ text: string; toolCalls: OllamaToolCall[]; usage: BrainUsage }> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    const toolCalls: OllamaToolCall[] = [];
    let usage: BrainUsage = { model: OLLAMA_MODEL, contextWindow: OLLAMA_NUM_CTX };
    // Track whether we're still in the model's REASONING phase. In `think:true` mode Ollama streams
    // `message.thinking` deltas FIRST, then `message.content`; the transition (first content delta, or
    // a tool call, or the done line) closes reasoning with a single `final:true`. `contentStarted` is a
    // one-way latch: once the answer begins we IGNORE any further stray thinking deltas, so reasoning
    // can be closed exactly once even if a model interleaves thinking after content.
    let thinkingOpen = false;
    let contentStarted = false;
    const closeThinking = (): void => {
      if (thinkingOpen) {
        onThinking?.('', true);
        thinkingOpen = false;
      }
    };

    const drainLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let obj: OllamaChatResponse;
      try {
        obj = JSON.parse(trimmed) as OllamaChatResponse;
      } catch {
        return; // a malformed line never breaks the stream
      }
      const thought = obj.message?.thinking;
      if (onThinking && !contentStarted && typeof thought === 'string' && thought.length) {
        thinkingOpen = true;
        onThinking(thought, false);
      }
      const delta = obj.message?.content;
      if (typeof delta === 'string' && delta.length) {
        contentStarted = true;
        closeThinking(); // the answer has begun — reasoning is complete
        full += delta;
        onToken(delta);
      }
      if (obj.message?.tool_calls?.length) {
        closeThinking(); // a tool call ends this hop's reasoning
        toolCalls.push(...obj.message.tool_calls);
      }
      if (obj.done) {
        closeThinking();
        usage = usageFrom(obj);
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          drainLine(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
        }
      }
      if (buffer.length) drainLine(buffer); // any trailing line
    } catch {
      // a mid-stream read error degrades to whatever was accumulated — never throws past the loop.
    }
    closeThinking(); // belt-and-braces: never leave reasoning visually "open" if the stream cut off
    return { text: full, toolCalls, usage };
  }
}
