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

/** The Ollama chat endpoint (local-only; no network port crosses a trust boundary). */
export const OLLAMA_CHAT_URL = 'http://localhost:11434/api/chat';

/** The context window (tokens) requested per pass. Surfaced in usage so a client can show it.
 *  Raised to 16384 once short-term conversation history was added: system(memory+persona) + the
 *  replayed dialogue turns + the output reserve must all fit, and qwen3.5/qwen2.5 both support it
 *  comfortably on the 16 GB box (verify resident size with `ollama ps`). */
export const OLLAMA_NUM_CTX = 16384;

/** Max output tokens per pass — generous so full answers (poems, emails, lists) never truncate. */
export const OLLAMA_NUM_PREDICT = 2048;

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
const SYSTEM_PROMPT = `You are KERNEL, Pravin's persistent personal AI agent, running locally on his Mac. You are warm, sharp, concise, and you FINISH what you start.

How you reply:
- Natural plain prose. No JSON, no preamble like "Sure, here is".
- Answer COMPLETELY in your reply. If asked for a poem, email, list, or explanation, produce the WHOLE thing now. NEVER announce a task ("I'll write...") and then stop — that is a failure.
- Keep any reasoning brief; give the answer, not a plan to make one.
- You remember the recent conversation — follow up naturally on what was just said ("it", "that", "the one you mentioned").

Your tools (you decide when to use them):
- web — search the live internet, or fetch a page. For CURRENT or unknown facts: news, weather, prices, recent events, schedules, anything past your training, or when you're unsure.
- finance — read the owner's OWN bank balances, recent transactions, or spending totals. For any question about HIS money.
Call a tool only for its purpose. After it returns, use its REAL result — never invent results. If you can answer correctly without a tool, just answer.

When to use a tool vs. answer directly (follow these):
- "What's the weather in Tokyo right now?" → web (current info)
- "Any news about Apple this week?" → web (recent events)
- "How much did I spend this month?" → finance (op=aggregate, timeframe=M)
- "What's my checking balance?" → finance (op=balances)
- "Write me a haiku." / "What's 12 × 8?" / "Capital of France?" → answer directly, NO tool — you already know these.
Don't ask permission to use web or finance — just use them when the question calls for it, then answer.`;

/** A tool call as Ollama returns it in `message.tool_calls`. Arguments arrive as an object (Ollama
 *  parses them), but we normalize defensively in case a build returns a JSON string. */
interface OllamaToolCall {
  function?: { name?: string; arguments?: unknown };
}

/** The Ollama `/api/chat` response shape (only the fields the brain reads). Durations are ns. */
interface OllamaChatResponse {
  message?: { role: string; content: string; tool_calls?: OllamaToolCall[] };
  model?: string;
  done?: boolean;
  error?: string;
  prompt_eval_count?: number; // input tokens evaluated
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

/** Max tool hops before forcing a final answer — a loop guard (small models can loop on tools). */
const MAX_TOOL_HOPS = 4;

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
function normalizeArgs(raw: unknown): Record<string, unknown> {
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
  ): Promise<Decision> {
    const messages: OllamaMessage[] = [
      // system(memory+persona) → prior dialogue turns → the current utterance. The system message
      // stays element 0 so front-truncation evicts OLD DIALOGUE before the instructions.
      { role: 'system', content: `${context}\n\n${SYSTEM_PROMPT}` },
      ...(history ?? []),
      { role: 'user', content: prompt },
    ];
    return this.runToolLoop(messages, onToken, 0, false, onToolActivity);
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
    onToolActivity?: (event: ToolActivityEvent) => void,
  ): Promise<Decision> {
    const result = await this.chat(messages, onToken);
    if (!result.ok) return result.decision;
    const { text, toolCalls, usage } = result;

    if (toolCalls.length > 0 && depth < MAX_TOOL_HOPS) {
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
      return this.runToolLoop(messages, onToken, depth + 1, true, onToolActivity);
    }

    const reply = text.trim();
    return {
      thought: usedTool ? 'local reply (after tool use)' : 'local reply',
      reply: reply.length ? reply : 'Local brain returned an empty reply.',
      usage,
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
  ): Promise<ChatOk | ChatErr> {
    const stream = typeof onToken === 'function';
    let res: Response;
    try {
      res = await fetch(OLLAMA_CHAT_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          messages,
          tools: localToolSpecs(), // the model decides WHEN to call these (see WEB_TOOL_DESCRIPTION).
          stream,
          // qwen3.5 is thinking-capable; keep thinking OFF for the orchestration loop — non-thinking
          // mode dispatches eagerly, ~40% fewer tokens/latency, and avoids the <think>-rumination
          // that reproduces the announce-then-stop failure. Hard reasoning escalates to Cloud.
          think: false,
          options: {
            temperature: OLLAMA_TEMPERATURE,
            num_ctx: OLLAMA_NUM_CTX,
            num_predict: OLLAMA_NUM_PREDICT,
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

    const read = stream && res.body
      ? await this.readStream(res.body, onToken!)
      : await this.readSingle(res);
    return { ok: true, ...read };
  }

  /** Non-streamed path: one JSON response — read content + any tool_calls. */
  private async readSingle(
    res: Response,
  ): Promise<{ text: string; toolCalls: OllamaToolCall[]; usage: BrainUsage }> {
    const body = (await res.json().catch(() => null)) as OllamaChatResponse | null;
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
  ): Promise<{ text: string; toolCalls: OllamaToolCall[]; usage: BrainUsage }> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    const toolCalls: OllamaToolCall[] = [];
    let usage: BrainUsage = { model: OLLAMA_MODEL, contextWindow: OLLAMA_NUM_CTX };

    const drainLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let obj: OllamaChatResponse;
      try {
        obj = JSON.parse(trimmed) as OllamaChatResponse;
      } catch {
        return; // a malformed line never breaks the stream
      }
      const delta = obj.message?.content;
      if (typeof delta === 'string' && delta.length) {
        full += delta;
        onToken(delta);
      }
      if (obj.message?.tool_calls?.length) toolCalls.push(...obj.message.tool_calls);
      if (obj.done) usage = usageFrom(obj);
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
    return { text: full, toolCalls, usage };
  }
}
