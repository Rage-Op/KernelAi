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
  brain: z.enum(['cloud', 'local']),
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
  brain: z.enum(['cloud', 'local']),
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
  brain: z.enum(['cloud', 'local']),
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

/**
 * Every frame has a `type` and an optional correlation `id`. The structural minimum
 * the transport guarantees before the discriminated union narrows it.
 */
export interface Envelope {
  type: string;
  id?: string;
}
