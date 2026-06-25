/**
 * LMStudioBrain.ts — KERNEL's LOCAL brain, backed by **LM Studio** (BRAIN-03).
 *
 * Selectable from Settings (`brain=lmstudio`). It talks to LM Studio's **OpenAI-compatible** server
 * (`http://localhost:1234/v1/chat/completions`) instead of Ollama's native API, which is what lets the
 * owner run **MLX** models (Apple-Silicon-optimal) as well as GGUF — Ollama gates MLX to 32 GB+, LM
 * Studio does not. The reasoning, tool loop, gate, memory, and MCP are all KERNEL-side and UNCHANGED:
 * this class only swaps the transport, so the model orchestrates everything exactly the same.
 *
 * It draws its persona, depth gating, tool-loop shape, and generation budget from the engine-neutral
 * `persona.ts` (the single source of truth — SYSTEM_PROMPT and `localToolSpecs()` are imported, never
 * duplicated). The wire format is OpenAI-shaped:
 *   - tool calls arrive as `message.tool_calls[].function.arguments` (a JSON *string*, parsed here);
 *   - a tool result is replayed as `{role:'tool', tool_call_id, content}` (OpenAI requires the id);
 *   - streaming is SSE (`data: {…}\n\n` … `data: [DONE]`) with incremental `tool_calls` deltas to
 *     assemble by index;
 *   - reasoning (chain-of-thought) surfaces as `delta.reasoning_content` (LM Studio's separated channel
 *     for reasoning models) rather than Ollama's `message.thinking`.
 *
 * The active model is AUTO-DETECTED from LM Studio per turn (whatever you've loaded — MLX or GGUF — is
 * what KERNEL uses), so you can A/B models from LM Studio's UI without touching KERNEL. Pin one with
 * `KERNEL_LMSTUDIO_MODEL` to override.
 *
 * ABSENT-TOLERANT (mirrors LocalBrain): a refused connection or a non-ok/no-model-loaded response each
 * return a TYPED ESCALATION Decision, never throwing across the loop boundary.
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
import {
  SYSTEM_PROMPT,
  QUICK_ADDENDUM,
  DELIBERATE_ADDENDUM,
  FINAL_ANSWER_NUDGE,
  MAX_TOOL_HOPS,
  MAX_TOOL_HOPS_DELIBERATE,
  GEN_NUM_PREDICT as NUM_PREDICT,
  GEN_NUM_PREDICT_DELIBERATE as NUM_PREDICT_DELIBERATE,
  GEN_TEMPERATURE as TEMPERATURE,
  assessDepth,
  todayLine,
  normalizeArgs,
} from './persona.js';

/** LM Studio server base URL (local-only). Override with KERNEL_LMSTUDIO_URL for a non-default port. */
export const LMSTUDIO_BASE_URL =
  process.env.KERNEL_LMSTUDIO_URL?.trim() || 'http://localhost:1234';

/** The OpenAI-compatible chat endpoint LM Studio serves. */
export const LMSTUDIO_CHAT_URL = `${LMSTUDIO_BASE_URL}/v1/chat/completions`;

/** OpenAI-compatible model list (loaded + available), used as a last-resort fallback. */
export const LMSTUDIO_MODELS_URL = `${LMSTUDIO_BASE_URL}/v1/models`;
/** LM Studio NATIVE model list. v1 (0.4.0+) reports `loaded_instances` (the resident model); v0 reports
 *  per-model `state:'loaded'`. We prefer v1, fall back to v0, then to the OpenAI list. */
export const LMSTUDIO_V1_MODELS_URL = `${LMSTUDIO_BASE_URL}/api/v1/models`;
export const LMSTUDIO_NATIVE_MODELS_URL = `${LMSTUDIO_BASE_URL}/api/v0/models`;

/** Pin a specific model (its LM Studio id) — otherwise the active/loaded model is auto-detected. */
export const LMSTUDIO_MODEL = process.env.KERNEL_LMSTUDIO_MODEL?.trim() || '';

/** A readable placeholder when no model could be resolved (only used in an error Decision's text). */
const NO_MODEL = '(no model loaded in LM Studio)';

/** A fetch with a hard timeout, used for the model-LIST probes so a wedged LM Studio can never hang
 *  model RESOLUTION. The streaming chat path is intentionally UNtimed (mirrors LocalBrain) — it relies
 *  on token-flow liveness, not a hard deadline, so a long legitimate generation isn't cut off. */
async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  ms: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** A model entry as LM Studio's `/api/v0/models` (native) or `/v1/models` (OpenAI) reports it. */
interface LMStudioModelEntry {
  id?: string;
  state?: string; // native v0 only: 'loaded' | 'not-loaded'
}

/** A model entry as LM Studio's native `/api/v1/models` reports it (only the fields we read). */
interface LMStudioV1Entry {
  key?: string;
  loaded_instances?: { id?: string }[];
}

/**
 * Resolve which model to drive. A pin (`KERNEL_LMSTUDIO_MODEL`) always wins. Otherwise prefer the native
 * v1 `/api/v1/models` (it reports `loaded_instances` — the model the owner actually has resident), then
 * fall back to v0 `/api/v0/models` (`state:'loaded'`), then to the first OpenAI `/v1/models` entry.
 * Returns null when LM Studio is unreachable or has no model — the caller turns that into a typed
 * escalation.
 */
export async function resolveLmStudioModel(
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (LMSTUDIO_MODEL) return LMSTUDIO_MODEL;
  // Native v1: pick the model that has a loaded instance (or the first listed if none is loaded).
  try {
    const res = await fetchWithTimeout(fetchImpl, LMSTUDIO_V1_MODELS_URL, { method: 'GET' }, 3000);
    if (res.ok) {
      const body = (await res.json()) as { models?: LMStudioV1Entry[] };
      const arr = body.models ?? [];
      const loaded = arr.find((m) => (m.loaded_instances?.length ?? 0) > 0 && m.key);
      if (loaded?.key) return loaded.key;
      if (arr[0]?.key) return arr[0].key;
    }
  } catch {
    /* fall through to v0 */
  }
  // Native v0: pick the LOADED model (or the first listed if none reports loaded).
  try {
    const res = await fetchWithTimeout(fetchImpl, LMSTUDIO_NATIVE_MODELS_URL, { method: 'GET' }, 3000);
    if (res.ok) {
      const body = (await res.json()) as { data?: LMStudioModelEntry[]; models?: LMStudioModelEntry[] };
      const arr = body.data ?? body.models ?? [];
      const loaded = arr.find((m) => m.state === 'loaded' && m.id);
      if (loaded?.id) return loaded.id;
      if (arr[0]?.id) return arr[0].id;
    }
  } catch {
    /* fall through to the OpenAI list */
  }
  // OpenAI list: first entry.
  try {
    const res = await fetchWithTimeout(fetchImpl, LMSTUDIO_MODELS_URL, { method: 'GET' }, 3000);
    if (res.ok) {
      const body = (await res.json()) as { data?: LMStudioModelEntry[] };
      const first = (body.data ?? []).find((m) => m.id);
      if (first?.id) return first.id;
    }
  } catch {
    /* unreachable */
  }
  return null;
}

/** An OpenAI tool call (complete, or a streamed fragment carrying `index`). */
interface OpenAIToolCall {
  id?: string;
  index?: number;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

/** An OpenAI message / streaming delta (only the fields we read). */
interface OpenAIDelta {
  role?: string;
  content?: string | null;
  reasoning_content?: string | null; // LM Studio's separated chain-of-thought channel
  tool_calls?: OpenAIToolCall[];
}

interface OpenAIChoice {
  delta?: OpenAIDelta; // streaming
  message?: OpenAIDelta; // non-streaming
  finish_reason?: string | null;
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface OpenAIChatResponse {
  model?: string;
  choices?: OpenAIChoice[];
  usage?: OpenAIUsage;
  error?: unknown;
}

/** An outbound OpenAI chat message — system/user/assistant/tool, with the tool-call plumbing. */
interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OpenAIToolCall[]; // assistant turn that requested tools
  tool_call_id?: string; // tool result turn (correlates to the call's id)
}

/** Build a BrainUsage from the OpenAI usage block + locally-measured timing. LM Studio's /v1 endpoint
 *  doesn't split prefill vs generation, so we measure it: `promptEvalMs` is time-to-first-token
 *  (prefill — also feeds the progress-bar EWMA) and `evalMs` is first-token→done (generation, the
 *  tokens/sec basis). Tokens come from the server's `usage`. */
function usageFrom(
  body: OpenAIChatResponse | null,
  model: string,
  timing: { promptEvalMs?: number; evalMs?: number; totalMs?: number },
): BrainUsage {
  return {
    model: body?.model ?? model,
    promptTokens: body?.usage?.prompt_tokens,
    outputTokens: body?.usage?.completion_tokens,
    promptEvalMs: timing.promptEvalMs,
    evalMs: timing.evalMs,
    totalMs: timing.totalMs,
  };
}

/** Max tool hops before forcing a final answer (mirrors LocalBrain's loop guard). */
type ToolDispatcher = (call: ToolCall) => Promise<ToolResult>;
let dispatcherOverride: ToolDispatcher | null = null;

/** TEST-ONLY seam: inject a tool dispatcher (or null to reset to the real gated registry). */
export function __setLmStudioToolDispatcherForTest(d: ToolDispatcher | null): void {
  dispatcherOverride = d;
}

/** Default dispatch: route through the gated registry chokepoint (origin 'user' — owner's behalf). */
function defaultDispatch(call: ToolCall): Promise<ToolResult> {
  return registryDispatch(call);
}

/** TEST-ONLY seam: inject the model resolver (so tests don't probe a real LM Studio). null resets. */
let modelResolverOverride: ((f: typeof fetch) => Promise<string | null>) | null = null;
export function __setLmStudioModelResolverForTest(
  r: ((f: typeof fetch) => Promise<string | null>) | null,
): void {
  modelResolverOverride = r;
}

/** A successful chat hop. */
interface ChatOk {
  ok: true;
  text: string;
  toolCalls: OpenAIToolCall[];
  usage: BrainUsage;
}
/** A failed chat hop — carries the typed escalation Decision to return verbatim. */
interface ChatErr {
  ok: false;
  decision: Decision;
}

export class LMStudioBrain implements BrainProvider {
  async reason(
    prompt: string,
    context: string,
    onToken?: (chunk: string) => void,
    history?: ChatTurn[],
    onToolActivity?: (event: ToolActivityEvent) => void,
    onThinking?: (chunk: string, final: boolean) => void,
  ): Promise<Decision> {
    const depth = assessDepth(prompt, history);
    const deliberate = depth === 'deliberate';
    const addendum = deliberate ? DELIBERATE_ADDENDUM : QUICK_ADDENDUM;

    // Resolve whatever model LM Studio currently has loaded (MLX or GGUF) — auto-detected per turn so
    // swapping models in LM Studio's UI just works. No model ⇒ a clean, actionable escalation.
    const resolve = modelResolverOverride ?? resolveLmStudioModel;
    const model = await resolve(fetch);
    if (!model) {
      return {
        thought: 'LM Studio has no model loaded (or the server is unreachable)',
        reply:
          'LM Studio brain is unavailable — no model is loaded. Open LM Studio, load a model (MLX or ' +
          'GGUF), and make sure its **Local Server** is started (the developer tab, or `lms server start`).',
      };
    }

    const messages: OpenAIMessage[] = [
      { role: 'system', content: `${todayLine()}\n\n${context}\n\n${SYSTEM_PROMPT}\n\n${addendum}` },
      ...((history ?? []).map((t) => ({ role: t.role, content: t.content })) as OpenAIMessage[]),
      { role: 'user', content: prompt },
    ];
    const maxHops = deliberate ? MAX_TOOL_HOPS_DELIBERATE : MAX_TOOL_HOPS;
    return this.runToolLoop(messages, model, onToken, 0, false, onToolActivity, { deliberate, maxHops }, onThinking);
  }

  /** One ReAct hop (OpenAI shapes). Identical control flow to LocalBrain.runToolLoop — the only
   *  difference is the tool-result message carries `tool_call_id` (OpenAI requires it). */
  private async runToolLoop(
    messages: OpenAIMessage[],
    model: string,
    onToken: ((chunk: string) => void) | undefined,
    depth: number,
    usedTool: boolean,
    onToolActivity: ((event: ToolActivityEvent) => void) | undefined,
    opts: { deliberate: boolean; maxHops: number },
    onThinking?: (chunk: string, final: boolean) => void,
  ): Promise<Decision> {
    const finalHop = depth >= opts.maxHops;
    if (finalHop) {
      messages.push({ role: 'user', content: FINAL_ANSWER_NUDGE });
    }
    const result = await this.chat(messages, model, onToken, {
      deliberate: opts.deliberate,
      toolsAllowed: !finalHop,
    }, onThinking);
    if (!result.ok) return result.decision;
    const { text, toolCalls, usage } = result;

    if (!finalHop && toolCalls.length > 0) {
      // Stamp a STABLE, UNIQUE id on every call up front, so the assistant turn's tool_calls[] and each
      // tool-result message's tool_call_id are guaranteed identical (OpenAI requires the match). When the
      // model omits ids — or emits two calls to the SAME tool — a `call_${name}` fallback would either
      // mismatch the assistant turn or collide; index-keyed synthesis avoids both.
      toolCalls.forEach((tc, i) => {
        tc.id = tc.id ?? `call_${tc.function?.name ?? 'tool'}_${i}`;
      });
      // Record the assistant's tool-call turn, then run each call (GATE-dispatched) and append its
      // observation as a role:'tool' message keyed to the (now-stamped) call id.
      messages.push({ role: 'assistant', content: text, tool_calls: toolCalls });
      const dispatch = dispatcherOverride ?? defaultDispatch;
      for (const tc of toolCalls) {
        const name = tc.function?.name ?? '';
        const args = normalizeArgs(tc.function?.arguments);
        const op = typeof args.op === 'string' ? args.op : name;
        const detail = typeof args.query === 'string' ? args.query.slice(0, 60) : op;
        onToolActivity?.({ tool: name, op, status: 'start', detail });
        const disp = await dispatch({ tool: name, args, origin: 'user' });
        onToolActivity?.({ tool: name, op, status: disp.ok ? 'ok' : 'error', detail });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(
            disp.ok ? disp.data : { error: disp.escalation?.reason ?? 'tool unavailable' },
          ),
        });
      }
      return this.runToolLoop(messages, model, onToken, depth + 1, true, onToolActivity, opts, onThinking);
    }

    let reply = text.trim();
    let finalUsage = usage;
    // Same empty-after-tool guard as LocalBrain: if it USED tools but produced no prose, force one
    // tool-less summary hop so a tool run never ends silently.
    if (!reply && usedTool && !finalHop) {
      messages.push({ role: 'user', content: FINAL_ANSWER_NUDGE });
      const forced = await this.chat(messages, model, onToken, { deliberate: opts.deliberate, toolsAllowed: false }, onThinking);
      if (forced.ok) {
        reply = forced.text.trim();
        finalUsage = forced.usage;
      }
    }
    return {
      thought: usedTool ? 'lmstudio reply (after tool use)' : 'lmstudio reply',
      reply: reply.length ? reply : 'LM Studio brain returned an empty reply.',
      usage: finalUsage,
    };
  }

  /** A single `/v1/chat/completions` call (streamed iff `onToken`). Returns text + tool calls + usage,
   *  or a TYPED escalation Decision on a connection/non-ok failure — never throws across the loop. */
  private async chat(
    messages: OpenAIMessage[],
    model: string,
    onToken?: (chunk: string) => void,
    opts?: { deliberate?: boolean; toolsAllowed?: boolean },
    onThinking?: (chunk: string, final: boolean) => void,
  ): Promise<ChatOk | ChatErr> {
    const stream = typeof onToken === 'function';
    const deliberate = opts?.deliberate ?? false;
    const toolsAllowed = opts?.toolsAllowed ?? true;
    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetch(LMSTUDIO_CHAT_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          // localToolSpecs() is already in OpenAI {type:'function', function:{…}} shape — pass straight
          // through. Omitted on the forced final hop so LM Studio must answer instead of re-calling.
          ...(toolsAllowed ? { tools: localToolSpecs() } : {}),
          stream,
          // Ask LM Studio to include the usage block in the final SSE chunk (OpenAI extension).
          ...(stream ? { stream_options: { include_usage: true } } : {}),
          temperature: TEMPERATURE,
          max_tokens: deliberate ? NUM_PREDICT_DELIBERATE : NUM_PREDICT,
        }),
      });
    } catch {
      return {
        ok: false,
        decision: {
          thought: 'LM Studio unreachable (ECONNREFUSED)',
          reply:
            'LM Studio brain is unavailable — its local server is not responding. Open LM Studio and ' +
            'start the server (developer tab → Start, or `lms server start`).',
        },
      };
    }

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      const noModel = /no model|not loaded|model_not_found|not found/i.test(bodyText);
      return {
        ok: false,
        decision: {
          thought: `LM Studio /v1/chat/completions non-ok (${res.status})`,
          reply: noModel
            ? `LM Studio has no usable model loaded (${model === NO_MODEL ? 'none' : model}). Load one in LM Studio, then retry.`
            : `LM Studio returned an error (HTTP ${res.status}). Check that the server is healthy and a model is loaded.`,
        },
      };
    }

    // Reasoning is DELIBERATE-only (mirrors LocalBrain): a quick turn never surfaces a reasoning block.
    const thinkingSink = deliberate ? onThinking : undefined;
    const read = stream && res.body
      ? await this.readStream(res.body, model, onToken!, t0, thinkingSink)
      : await this.readSingle(res, model, t0, thinkingSink);
    return { ok: true, ...read };
  }

  /** Non-streamed path: one JSON response — read content + reasoning + any tool_calls. */
  private async readSingle(
    res: Response,
    model: string,
    t0: number,
    onThinking?: (chunk: string, final: boolean) => void,
  ): Promise<{ text: string; toolCalls: OpenAIToolCall[]; usage: BrainUsage }> {
    const body = (await res.json().catch(() => null)) as OpenAIChatResponse | null;
    const msg = body?.choices?.[0]?.message;
    const reasoning = msg?.reasoning_content;
    if (onThinking && typeof reasoning === 'string' && reasoning.length) {
      onThinking(reasoning, false);
      onThinking('', true);
    }
    const totalMs = Date.now() - t0;
    return {
      text: msg?.content ?? '',
      toolCalls: msg?.tool_calls ?? [],
      usage: usageFrom(body, model, { totalMs, evalMs: totalMs }),
    };
  }

  /**
   * Streamed path: parse LM Studio's OpenAI SSE (`data: {…}` lines; `data: [DONE]` ends). Accumulate
   * `delta.content` (→ onToken), `delta.reasoning_content` (→ onThinking, deliberate-gated, with a
   * one-way `contentStarted` latch so reasoning closes exactly once), and assemble `delta.tool_calls`
   * fragments by index (OpenAI streams the name once, then argument fragments). Usage arrives in the
   * final chunk; timing is measured locally (prefill = time-to-first-token, generation = first→done).
   */
  private async readStream(
    body: ReadableStream<Uint8Array>,
    model: string,
    onToken: (chunk: string) => void,
    t0: number,
    onThinking?: (chunk: string, final: boolean) => void,
  ): Promise<{ text: string; toolCalls: OpenAIToolCall[]; usage: BrainUsage }> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    const toolAcc = new Map<number, OpenAIToolCall>();
    let lastBody: OpenAIChatResponse | null = null;
    let firstTokenAt = 0;

    let thinkingOpen = false;
    let contentStarted = false;
    const closeThinking = (): void => {
      if (thinkingOpen) {
        onThinking?.('', true);
        thinkingOpen = false;
      }
    };

    const drainData = (payload: string): void => {
      const trimmed = payload.trim();
      if (!trimmed || trimmed === '[DONE]') return;
      let obj: OpenAIChatResponse;
      try {
        obj = JSON.parse(trimmed) as OpenAIChatResponse;
      } catch {
        return; // a malformed chunk never breaks the stream
      }
      if (obj.usage) lastBody = obj; // the final chunk carries usage (+ model)
      const choice = obj.choices?.[0];
      const delta = choice?.delta;
      if (!delta) return;

      const reasoning = delta.reasoning_content;
      if (typeof reasoning === 'string' && reasoning.length) {
        // Latch the first-output time on reasoning too: prefill ends at the FIRST token the model
        // produces (reasoning or content). Otherwise the reasoning-generation window is misattributed
        // to prefill (inflating promptEvalMs/the progress EWMA) and tokens/sec is overstated.
        if (!firstTokenAt) firstTokenAt = Date.now();
        if (onThinking && !contentStarted) {
          thinkingOpen = true;
          onThinking(reasoning, false);
        }
      }
      const content = delta.content;
      if (typeof content === 'string' && content.length) {
        if (!firstTokenAt) firstTokenAt = Date.now();
        contentStarted = true;
        closeThinking();
        full += content;
        onToken(content);
      }
      if (delta.tool_calls?.length) {
        closeThinking();
        for (const frag of delta.tool_calls) {
          const idx = frag.index ?? 0;
          const existing = toolAcc.get(idx) ?? { type: 'function', function: { name: '', arguments: '' } };
          if (frag.id) existing.id = frag.id;
          if (frag.function?.name) existing.function!.name = frag.function.name;
          if (frag.function?.arguments) existing.function!.arguments = (existing.function!.arguments ?? '') + frag.function.arguments;
          toolAcc.set(idx, existing);
        }
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE events are separated by blank lines; each line may be `data: <payload>`.
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          const t = line.trim();
          if (t.startsWith('data:')) drainData(t.slice(5));
        }
      }
      if (buffer.trim().startsWith('data:')) drainData(buffer.trim().slice(5));
    } catch {
      // a mid-stream read error degrades to whatever was accumulated — never throws past the loop.
    }
    closeThinking();

    const end = Date.now();
    const toolCalls = [...toolAcc.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    const promptEvalMs = firstTokenAt ? firstTokenAt - t0 : undefined;
    const evalMs = firstTokenAt ? end - firstTokenAt : undefined;
    return {
      text: full,
      toolCalls,
      usage: usageFrom(lastBody, model, { promptEvalMs, evalMs, totalMs: end - t0 }),
    };
  }
}
