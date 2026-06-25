/**
 * The FROZEN IPC frame contract (CORE-04).
 *
 * Transport is a Unix-domain socket carrying newline-delimited JSON (NDJSON):
 * each frame is one `JSON.stringify(frame) + '\n'`. This file is the single source
 * of truth the Swift Face mirrors; it is authored transport-agnostic so the shape is
 * stable across phases.
 *
 * Phase 1 EXERCISES: hello / utterance / ping (Face→daemon) and ready / reply / pong /
 * error (daemon→Face). The Phase 2/3 shapes (speak{cues,onFinish}, widget.data,
 * ui.intent) are authored here so the contract is frozen now, but are NOT used in P1.
 *
 * Every frame validates against `FrameSchema` (a zod discriminated union on `type`).
 * A malformed/invalid line never crashes the daemon — the server replies with an
 * `error` frame instead (T-01-09).
 */
import { z } from 'zod';

// --- Face → daemon -------------------------------------------------------------

/** First frame a client may send announcing itself (optional in P1). */
export const HelloSchema = z.object({
  type: z.literal('hello'),
  client: z.literal('face'),
  version: z.string(),
});

/** A user utterance: final STT (P3) or typed input (P1 dev). Drives one loop tick. */
export const UtteranceSchema = z.object({
  type: z.literal('utterance'),
  id: z.string(),
  text: z.string(),
  final: z.boolean(),
});

/** A liveness probe. The daemon answers with `pong` carrying the same id. */
export const PingSchema = z.object({
  type: z.literal('ping'),
  id: z.string(),
});

/** A structured UI intent from the Face (P3+). Authored now; not used in P1. */
export const UiIntentSchema = z.object({
  type: z.literal('ui.intent'),
  id: z.string(),
  intent: z.string(),
  payload: z.unknown().optional(),
});

/**
 * P3 ADDITIVE arm (CLOUD-01): the Settings brain toggle (Face→daemon). Selecting
 * `local` swaps the active brain to LocalBrain (Ollama) via `loop.setBrain`; `cloud`
 * swaps to ClaudeBrain. The always-on 7B helper runs regardless of this toggle.
 * Appended to the frozen FrameSchema union — existing arms are NEVER mutated.
 */
export const SettingsSchema = z.object({
  type: z.literal('settings'),
  brain: z.enum(['cloud', 'local', 'lmstudio']),
});

// --- daemon → Face -------------------------------------------------------------

/** Sent unprompted on connect — proves the Face can attach without a daemon restart. */
export const ReadySchema = z.object({
  type: z.literal('ready'),
  daemon: z.string(),
  version: z.string(),
});

/** The brain's reply (StubBrain echo in P1), correlated to an utterance by `id`. */
export const ReplySchema = z.object({
  type: z.literal('reply'),
  id: z.string(),
  text: z.string(),
});

/** The answer to a `ping`. */
export const PongSchema = z.object({
  type: z.literal('pong'),
  id: z.string(),
});

/**
 * P3 speech choreography: text plus timed cues + onFinish actions the Face renders
 * in sync with TTS word boundaries. Authored now to freeze the contract; not used in P1.
 */
export const SpeakSchema = z.object({
  type: z.literal('speak'),
  id: z.string(),
  text: z.string(),
  cues: z.array(
    z.object({
      atChar: z.number(),
      action: z.string(),
      widget: z.string().optional(),
      data: z.unknown().optional(),
    }),
  ),
  onFinish: z
    .array(
      z.object({
        action: z.string(),
        widget: z.string().optional(),
      }),
    )
    .optional(),
});

/** P3 widget payload push. Authored now; not used in P1. */
export const WidgetDataSchema = z.object({
  type: z.literal('widget.data'),
  widget: z.string(),
  data: z.unknown(),
});

/**
 * P3 ADDITIVE arm (CLOUD-05): the cloud scene state (daemon→Face). Drives the single
 * animated scene between full-screen (boot/speaking), the top-left corner pill (a
 * Claude Code session), and idle. Appended to the frozen FrameSchema union — existing
 * arms are NEVER mutated. The Swift Face mirrors this arm.
 */
export const UiStateSchema = z.object({
  type: z.literal('ui.state'),
  state: z.enum(['fullscreen', 'cornerPill', 'idle']),
});

/** Sent when a line fails to parse/validate, or a frame cannot be handled. */
export const ErrorSchema = z.object({
  type: z.literal('error'),
  id: z.string().optional(),
  message: z.string(),
});

/**
 * ADDITIVE arm (daemon→Face): the daemon's runtime capabilities, pushed once on connect (right
 * after `ready`). Lets a client render a dashboard of what KERNEL can do WITHOUT reaching into the
 * daemon's internals: the active brain, the memory-injection context cap, the registered tools, and
 * the external integrations ("hands"). Appended to the frozen union — existing arms are NEVER
 * mutated.
 */
export const CapabilitiesSchema = z.object({
  type: z.literal('capabilities'),
  brain: z.enum(['cloud', 'local', 'lmstudio']),
  daemon: z.string(),
  version: z.string(),
  /** The memory-injection context cap in characters (config.injectCap). */
  injectCap: z.number(),
  /** Registered tool names the brain may dispatch (gate-chokepointed). */
  tools: z.array(z.string()),
  /** External integrations / MCP-style hands available to the daemon. */
  integrations: z.array(z.string()),
});

/**
 * ADDITIVE arm (daemon→Face): per-turn telemetry for the utterance correlated by `id`. Emitted
 * after a reply when the active brain reported usage (LocalBrain always does; ClaudeBrain when
 * wired). Powers the client's tokens/sec, token counts, context use, latency, and cost readouts.
 * All metric fields optional — a brain that doesn't measure sends only `id`/`brain`/`model`.
 */
export const StatsSchema = z.object({
  type: z.literal('stats'),
  id: z.string(),
  brain: z.enum(['cloud', 'local', 'lmstudio']),
  model: z.string().optional(),
  promptTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  tokensPerSec: z.number().optional(),
  evalMs: z.number().optional(),
  loadMs: z.number().optional(),
  totalMs: z.number().optional(),
  contextWindow: z.number().optional(),
  /** Actual spend for this turn in USD (0 for the local brain; cloud when token-priced). */
  estCostUsd: z.number().optional(),
});

/**
 * P4 ADDITIVE arm (CC-02): one line of the live Kernel↔Claude transcript (daemon→Face). A
 * Claude Code session streams `claude -p --output-format stream-json --include-partial-messages`
 * NDJSON events; each becomes a transcript frame. `role:'kernel'` is the first-person prompt
 * KERNEL authored as Pravin; `role:'claude'` is what the session is doing. `partial:true` is a
 * streaming chunk that UPDATES the in-progress line; a final/absent partial finalizes it. The
 * Face renders ONLY this typed text in the cornerPill (no remote-resource loads — T-04-19).
 * Appended to the frozen FrameSchema union — existing arms are NEVER mutated (Pattern 1).
 */
export const TranscriptSchema = z.object({
  type: z.literal('transcript'),
  id: z.string(),
  role: z.enum(['kernel', 'claude']),
  text: z.string(),
  partial: z.boolean().optional(),
});

/**
 * P5 ADDITIVE arm (SAFE-02): `/override` activation from the Face (Face→daemon). `active:true`
 * activates the scoped capability (Green full-speed, Yellow proceed+notify) for `ttlMs`; the
 * daemon's loop also accepts a literal "/override" utterance. NEVER unlocks Red. Appended to the
 * frozen FrameSchema union — existing arms are NEVER mutated (mirrors P3/P4 additive arms).
 */
export const OverrideSchema = z.object({
  type: z.literal('override'),
  active: z.boolean(),
  ttlMs: z.number().optional(),
});

/**
 * P5 ADDITIVE arm (SAFE-03): the breaker's dry-run preview (daemon→Face). Surfaced when a Red
 * action enters the breaker so the owner sees what/how-much/why and has the 10s cancel window.
 * `estimatedSpend` is shown to the owner but NEVER written to the audit log (V7).
 */
export const BreakerPreviewSchema = z.object({
  type: z.literal('breaker.preview'),
  id: z.string(),
  summary: z.string(),
  estimatedSpend: z.number(),
  tier: z.literal('red'),
});

/**
 * P5 ADDITIVE arm (SAFE-03): the owner cancelling a Red action within the 10s window
 * (Face→daemon). Correlated to the preview by `id`. The breaker aborts WITHOUT executing.
 */
export const BreakerCancelSchema = z.object({
  type: z.literal('breaker.cancel'),
  id: z.string(),
});

/**
 * ADDITIVE arm (daemon→Face): a streamed output delta for a snappy, real-time reply. While the
 * brain generates, each chunk is sent as `say{delta}` (append to the in-progress line + speak the
 * newly-completed sentences); the terminal `say{final:true, delta:''}` closes the line. A streamed
 * turn sends `say` frames INSTEAD of a single `reply` (the loop's reply is replaced by the stream).
 * Appended to the frozen union — existing arms are NEVER mutated.
 */
export const SaySchema = z.object({
  type: z.literal('say'),
  id: z.string(),
  /** One output delta to append to the in-progress reply (empty string on the final frame). */
  delta: z.string(),
  /** True on the terminal frame — the reply is complete (finalize the line, flush any TTS). */
  final: z.boolean(),
});

/**
 * ADDITIVE arm (daemon→Face): the model's REASONING (chain-of-thought) streamed as it forms, SEPARATE
 * from the spoken `say` answer. A deliberate local pass runs Ollama with `think:true`, which emits a
 * `message.thinking` channel; rather than discard it (the old behavior), we stream it so the Face can
 * show "what KERNEL is thinking" live, ahead of the answer. Correlated to the turn by `id` (the same
 * id as the turn's `say`/`tool.activity` frames). `final:true` (with `delta:''`) closes the reasoning —
 * the answer is about to begin. QUICK turns never think, so this frame simply never arrives then. This
 * is the model's own private reasoning surfaced for transparency — informational, drives no action.
 * Appended to the frozen union — existing arms are NEVER mutated.
 */
export const ReasoningSchema = z.object({
  type: z.literal('reasoning'),
  id: z.string(),
  /** One reasoning delta to append to the in-progress thoughts (empty string on the final frame). */
  delta: z.string(),
  /** True on the terminal frame — reasoning is complete (the answer begins next). */
  final: z.boolean(),
});

/**
 * ADDITIVE arm (daemon→Face): an estimated PROMPT-PROCESSING (prefill) time for a turn, so the Face can
 * render a DETERMINATE LM-Studio-style progress bar (it animates a fill over `etaMs`, then yields to the
 * reasoning/answer stream). Ollama doesn't expose true incremental prefill progress over HTTP, so this
 * is an honest ESTIMATE from a learned throughput EWMA (see brain/prefill-estimate.ts); on a cold start
 * (no sample) NO progress frame is sent and the Face keeps its indeterminate sweep. Correlated to the
 * turn by `id`. Informational — drives no action. Appended to the frozen union — never mutate existing arms.
 */
export const ProgressSchema = z.object({
  type: z.literal('progress'),
  id: z.string(),
  /** Estimated prefill time in ms (the bar animates a determinate fill over this duration). */
  etaMs: z.number(),
  /** Optional short label (e.g. "Processing prompt…"). */
  label: z.string().optional(),
});

/**
 * ADDITIVE arm (daemon→Face): a widget-displayer COMMAND. KERNEL (or a tool) emits a single
 * command-language string and the Face's displayer parses it, slides in from the right (the sphere
 * minimizes left), and renders the right card with the right options + interactivity. Grammar:
 *   `<verb> <kind> key:value key:value … options:opt,opt(auto Ns)`
 * e.g. `focus email to:john@x.com from:Acme subject:Renewal content:… options:abort,send(auto 15s)`.
 * The Face never acts on an option locally — tapping one emits a `ui.intent` the daemon dispatches
 * through the gate (so send/abort stay gate-chokepointed). Appended to the frozen union.
 */
export const WidgetCommandSchema = z.object({
  type: z.literal('widget.command'),
  id: z.string(),
  command: z.string(),
});

/**
 * ADDITIVE arm (daemon→Face): BACKGROUND TOOL ACTIVITY. As the local brain's tool loop runs, the
 * daemon emits one of these per tool call so the Face can show what KERNEL is doing ("🔧 web ·
 * searching…", then "✓ web") instead of an opaque pause. Purely informational — it drives no action.
 *   - status 'start' → the tool was dispatched (show a working indicator)
 *   - status 'ok'    → it returned (brief confirm, then fade)
 *   - status 'error' → it escalated/failed (brief notice)
 * `detail` is a short, non-sensitive label (e.g. the search query or "balances") — never raw results.
 */
export const ToolActivitySchema = z.object({
  type: z.literal('tool.activity'),
  id: z.string(),
  tool: z.string(),
  op: z.string(),
  status: z.enum(['start', 'ok', 'error']),
  detail: z.string().optional(),
});

/**
 * ADDITIVE arm (Face→daemon): request the persisted chat history so the Chat page can render past
 * conversations on connect (the daemon owns the durable transcript at
 * ~/Library/Application Support/Kernel/conversation.jsonl). `limit` caps how many recent turns to
 * return (default applied daemon-side). Correlated to the `history.data` reply by `id`. Appended to
 * the frozen union — existing arms are NEVER mutated.
 */
export const HistoryRequestSchema = z.object({
  type: z.literal('history.request'),
  id: z.string(),
  limit: z.number().optional(),
});

/**
 * ADDITIVE arm (daemon→Face): the persisted chat history, in chronological order, answering a
 * `history.request` (same `id`). Each turn carries its role, text, and a millisecond timestamp so
 * the Chat page can show day/time separators. Owner/assistant turns only (external/tool content is
 * never recorded as dialogue — provenance). Appended to the frozen union.
 */
export const HistoryDataSchema = z.object({
  type: z.literal('history.data'),
  id: z.string(),
  turns: z.array(
    z.object({
      role: z.enum(['user', 'assistant']),
      text: z.string(),
      ts: z.number(),
    }),
  ),
});

/**
 * ADDITIVE arm (daemon→Face): the live `/override` state, broadcast on activate/deactivate and once
 * on connect, so the Face can render an override status pill + a live countdown WITHOUT polling.
 * `active:false` means no override is in effect (scope/expiresAt then meaningless). `expiresAt` is a
 * millisecond epoch the Face counts down to. NEVER reflects a Red bypass — override cannot unlock
 * Red (override.ts). Appended to the frozen union — existing arms are NEVER mutated.
 */
export const OverrideStateSchema = z.object({
  type: z.literal('override.state'),
  active: z.boolean(),
  scope: z.string().optional(),
  expiresAt: z.number().optional(),
});

/**
 * ADDITIVE arm (Face→daemon): update the owner-configurable safety posture (SAFE-08). Every field
 * is optional so the Face can change one toggle at a time. `breakerEnabled` flips the live Red
 * breaker; `dailySpendCeiling` sets the breaker's daily reserve ceiling (USD); `defaultTtlMs` sets
 * the /override default duration. The daemon persists the change and echoes the new `settings.state`.
 */
export const SettingsUpdateSchema = z.object({
  type: z.literal('settings.update'),
  breakerEnabled: z.boolean().optional(),
  dailySpendCeiling: z.number().optional(),
  defaultTtlMs: z.number().optional(),
});

/**
 * ADDITIVE arm (daemon→Face): the current owner safety posture, broadcast on connect and after a
 * `settings.update`, so the Settings page can render the toggles + spend ceiling from the daemon's
 * truth (never a stale local guess).
 */
export const SettingsStateSchema = z.object({
  type: z.literal('settings.state'),
  breakerEnabled: z.boolean(),
  dailySpendCeiling: z.number(),
  defaultTtlMs: z.number(),
});

/**
 * ADDITIVE arm (Face→daemon): request the recent audit log (the Activity view). `limit` caps how
 * many recent entries to return (default applied daemon-side). Correlated to `audit.data` by `id`.
 */
export const AuditQuerySchema = z.object({
  type: z.literal('audit.query'),
  id: z.string(),
  limit: z.number().optional(),
});

/**
 * ADDITIVE arm (daemon→Face): the recent audit entries answering an `audit.query` (same `id`), most
 * recent last. Each entry is the SAFE shape only — tool name, terminal outcome, ISO timestamp. NEVER
 * the content hash, args, or any finance amount (V7 — the audit log never holds finance PII, and the
 * Face never needs more than what/when/outcome).
 */
export const AuditDataSchema = z.object({
  type: z.literal('audit.data'),
  id: z.string(),
  entries: z.array(
    z.object({
      tool: z.string(),
      outcome: z.string(),
      ts: z.string(),
    }),
  ),
});

/**
 * ADDITIVE arm (daemon→Face): model warm-up readiness (BRAIN-07), broadcast on connect and as the
 * active model loads. The Face holds its boot screen until `status:'ready'` so the owner never types
 * into a cold model; `error` surfaces an actionable `detail` (Ollama down / model not installed).
 * `model` is the tag (local brain). Appended to the frozen union — existing arms are NEVER mutated.
 */
export const ModelStateSchema = z.object({
  type: z.literal('model.state'),
  status: z.enum(['loading', 'ready', 'error']),
  brain: z.enum(['cloud', 'local', 'lmstudio']),
  model: z.string().optional(),
  detail: z.string().optional(),
});

/**
 * ADDITIVE arm (daemon→web): one frame of the LIVE browser screencast (CDP `Page.screencastFrame`),
 * so the WEB Face can show what KERNEL's Playwright browser is doing in real time. `dataB64` is a
 * base64 JPEG; `url` is the page's current URL; `width`/`height` are the captured device pixels (for
 * aspect-ratio). Delivered ONLY to web clients that opted in via `browser.view{streaming:true}` — it
 * is NEVER broadcast to the Mac Face (targeted push, see server.broadcastBrowser). Informational —
 * drives no action. Appended to the frozen union — existing arms are NEVER mutated.
 */
export const BrowserFrameSchema = z.object({
  type: z.literal('browser.frame'),
  dataB64: z.string(),
  url: z.string(),
  width: z.number(),
  height: z.number(),
});

/**
 * ADDITIVE arm (daemon→web): the browser's high-level state — whether a live page exists and its
 * current URL — so the web Face can label the screencast pane and show "idle" when nothing is loaded.
 * Pushed to opted-in web clients on screencast start/stop and on navigation. Appended to the frozen
 * union — existing arms are NEVER mutated.
 */
export const BrowserStateSchema = z.object({
  type: z.literal('browser.state'),
  active: z.boolean(),
  url: z.string().optional(),
});

/**
 * ADDITIVE arm (web→daemon): subscribe/unsubscribe THIS client to the live browser screencast. The
 * web Face sends `{streaming:true}` when its Browser pane is open and `{streaming:false}` when it
 * closes, so the daemon only runs the CDP screencast (and only emits `browser.frame`s) while someone
 * is watching — saving CPU on the 16GB Mac. Appended to the frozen union — existing arms are NEVER
 * mutated.
 */
export const BrowserViewSchema = z.object({
  type: z.literal('browser.view'),
  streaming: z.boolean(),
});

/**
 * ADDITIVE arm (web→daemon): request the live status of the background services KERNEL depends on
 * (Ollama, LM Studio, the Playwright browser, stray duplicate daemons), so the web Face can show a
 * mini control panel. Correlated to `service.data` by `id`. Appended to the frozen union.
 */
export const ServiceListSchema = z.object({
  type: z.literal('service.list'),
  id: z.string(),
});

/**
 * ADDITIVE arm (web→daemon): perform an action on ONE allowlisted background service. `name` must be a
 * known service (the daemon refuses anything else — no arbitrary process control from the browser), and
 * `action` is currently just `stop` (kill/stop the service). The daemon replies with a fresh
 * `service.data` reflecting the new state. Appended to the frozen union.
 */
export const ServiceActionSchema = z.object({
  type: z.literal('service.action'),
  id: z.string(),
  name: z.string(),
  action: z.enum(['stop', 'restart']),
});

/**
 * ADDITIVE arm (daemon→web): the live status of each background service for the web Face's control
 * panel. `running` + optional `pid`/`detail`, and `actions` lists what the owner may do (e.g. `['stop']`).
 * Sent in reply to `service.list`/`service.action` (same `id`). Appended to the frozen union.
 */
export const ServiceDataSchema = z.object({
  type: z.literal('service.data'),
  id: z.string().optional(),
  services: z.array(
    z.object({
      name: z.string(),
      label: z.string(),
      running: z.boolean(),
      pid: z.number().optional(),
      detail: z.string().optional(),
      actions: z.array(z.string()),
    }),
  ),
});

/**
 * The frozen frame contract: a discriminated union on `type` over every P1 frame
 * plus the designed-for P2/P3/P4/P5 shapes. `safeParse` every incoming line against this.
 */
export const FrameSchema = z.discriminatedUnion('type', [
  // Face → daemon
  HelloSchema,
  UtteranceSchema,
  PingSchema,
  UiIntentSchema,
  SettingsSchema, // P3 additive (Face→daemon brain toggle)
  OverrideSchema, // P5 additive (Face→daemon /override activation)
  BreakerCancelSchema, // P5 additive (Face→daemon Red cancel within the 10s window)
  HistoryRequestSchema, // additive (Face→daemon request persisted chat history)
  SettingsUpdateSchema, // additive (Face→daemon update owner safety posture)
  AuditQuerySchema, // additive (Face→daemon request recent audit entries)
  BrowserViewSchema, // additive (web→daemon subscribe/unsubscribe the live browser screencast)
  ServiceListSchema, // additive (web→daemon request background-service status)
  ServiceActionSchema, // additive (web→daemon stop/restart an allowlisted background service)
  // daemon → Face
  ReadySchema,
  ReplySchema,
  PongSchema,
  SpeakSchema,
  WidgetDataSchema,
  UiStateSchema, // P3 additive (daemon→Face cloud scene state)
  ErrorSchema,
  TranscriptSchema, // P4 additive (daemon→Face Claude Code transcript)
  BreakerPreviewSchema, // P5 additive (daemon→Face Red dry-run preview)
  CapabilitiesSchema, // additive (daemon→Face runtime capabilities on connect)
  StatsSchema, // additive (daemon→Face per-turn token/timing/cost telemetry)
  SaySchema, // additive (daemon→Face streamed reply deltas for real-time render + TTS)
  ReasoningSchema, // additive (daemon→Face streamed chain-of-thought for live reasoning visibility)
  ProgressSchema, // additive (daemon→Face estimated prefill time for a determinate progress bar)
  WidgetCommandSchema, // additive (daemon→Face widget-displayer command-language string)
  ToolActivitySchema, // additive (daemon→Face background tool-use activity for live visibility)
  HistoryDataSchema, // additive (daemon→Face persisted chat history on request)
  OverrideStateSchema, // additive (daemon→Face live /override state for the status pill + countdown)
  SettingsStateSchema, // additive (daemon→Face current owner safety posture for the Settings page)
  AuditDataSchema, // additive (daemon→Face recent audit entries for the Activity view)
  ModelStateSchema, // additive (daemon→Face model warm-up readiness for the boot gate)
  BrowserFrameSchema, // additive (daemon→web live browser screencast frame)
  BrowserStateSchema, // additive (daemon→web browser high-level state for the screencast pane)
  ServiceDataSchema, // additive (daemon→web background-service status for the control panel)
]);

/** Any valid frame. */
export type Frame = z.infer<typeof FrameSchema>;

/** Convenience aliases for the individual frame shapes. */
export type Hello = z.infer<typeof HelloSchema>;
export type Utterance = z.infer<typeof UtteranceSchema>;
export type Ping = z.infer<typeof PingSchema>;
export type UiIntent = z.infer<typeof UiIntentSchema>;
export type Settings = z.infer<typeof SettingsSchema>;
export type Ready = z.infer<typeof ReadySchema>;
export type Reply = z.infer<typeof ReplySchema>;
export type Pong = z.infer<typeof PongSchema>;
export type Speak = z.infer<typeof SpeakSchema>;
export type WidgetData = z.infer<typeof WidgetDataSchema>;
export type UiState = z.infer<typeof UiStateSchema>;
export type ErrorFrame = z.infer<typeof ErrorSchema>;
export type Transcript = z.infer<typeof TranscriptSchema>;
export type Override = z.infer<typeof OverrideSchema>;
export type BreakerPreview = z.infer<typeof BreakerPreviewSchema>;
export type BreakerCancel = z.infer<typeof BreakerCancelSchema>;
export type Capabilities = z.infer<typeof CapabilitiesSchema>;
export type Stats = z.infer<typeof StatsSchema>;
export type Say = z.infer<typeof SaySchema>;
export type Reasoning = z.infer<typeof ReasoningSchema>;
export type Progress = z.infer<typeof ProgressSchema>;
export type WidgetCommand = z.infer<typeof WidgetCommandSchema>;
export type ToolActivity = z.infer<typeof ToolActivitySchema>;
export type HistoryRequest = z.infer<typeof HistoryRequestSchema>;
export type HistoryData = z.infer<typeof HistoryDataSchema>;
export type OverrideState = z.infer<typeof OverrideStateSchema>;
export type SettingsUpdate = z.infer<typeof SettingsUpdateSchema>;
export type SettingsState = z.infer<typeof SettingsStateSchema>;
export type AuditQuery = z.infer<typeof AuditQuerySchema>;
export type AuditData = z.infer<typeof AuditDataSchema>;
export type ModelStateFrame = z.infer<typeof ModelStateSchema>;
export type BrowserFrame = z.infer<typeof BrowserFrameSchema>;
export type BrowserState = z.infer<typeof BrowserStateSchema>;
export type BrowserView = z.infer<typeof BrowserViewSchema>;
export type ServiceList = z.infer<typeof ServiceListSchema>;
export type ServiceAction = z.infer<typeof ServiceActionSchema>;
export type ServiceData = z.infer<typeof ServiceDataSchema>;

/**
 * Every frame has a `type` and an optional correlation `id`. The structural minimum
 * the transport guarantees before the discriminated union narrows it.
 */
export interface Envelope {
  type: string;
  id?: string;
}
