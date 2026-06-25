/**
 * The transport-agnostic frame ROUTER + server→client fan-out (CORE-04).
 *
 * This module owns the daemon's side of the frozen IPC frame contract: it validates every inbound
 * frame against `FrameSchema`, routes it (`routeFrame → defaultFrameHandler`) into the loop/gate, and
 * pushes frames back out to connected clients (`broadcast`). It is deliberately TRANSPORT-AGNOSTIC — a
 * connected client is a `ClientConn` whose only required primitive is `send(frame)`. The daemon-hosted
 * WEB Face (`web/http-server.ts`) wraps an SSE response in a `ClientConn`; that is the sole transport
 * today. (The original Unix-domain-socket transport for the now-removed SwiftUI Mac app has been
 * stripped — see git history if it is ever needed again.)
 *
 * A malformed/invalid frame replies with an `error` frame and NEVER throws out of the router (T-01-09 —
 * a bad frame must not crash the daemon).
 */
import { config } from '../config.js';
import { FrameSchema, type Frame, type Stats } from './protocol.js';
import { enqueue } from '../loop.js';
import type { BrainUsage } from '../brain/BrainProvider.js';
import { applySettings, currentBrainSelection } from '../settings.js';
import { signalBreakerCancel, setBreakerBroadcast, listTools } from '../tools/registry.js';
import { overrideSingleton } from '../safety/override.js';
import { applyOwnerConfig, ownerConfig, defaultOverrideTtlMs } from '../safety/owner-config.js';
import { readAudit, defaultAuditPath } from '../safety/audit.js';
import { getModelState, setModelBroadcast, warmupActiveBrain } from '../brain/readiness.js';
import { CLOUD_PRICE_PER_TOKEN } from '../brain/pricing.js';
import { recordTurn } from '../commands/session-usage.js';
import { conversation } from '../memory/conversation.js';
import { logger } from '../memory/log.js';
import { listServices, runServiceAction } from '../web/services.js';
import {
  listLmStudioModels,
  loadLmStudioModel,
  unloadLmStudioModel,
  activeModelKey,
} from '../web/lmstudio-control.js';

const DAEMON_NAME = 'kernel';
const DAEMON_VERSION = '0.1.0';

/**
 * External integrations / MCP-style "hands" the daemon exposes, surfaced in the capabilities frame
 * for the client dashboard. Static, human-readable labels (the runtime tool NAMES come from
 * `listTools()`); this names what each gate-chokepointed capability talks to.
 */
const INTEGRATIONS = [
  'Peekaboo (screen capture + UI automation)',
  'Playwright (headless web browsing)',
  'Plaid + SQLCipher (finance)',
  'Mail / Gmail (drafts + send)',
  'Claude Code (delegated coding sessions)',
  'whisper.cpp (speech-to-text)',
];

/** Build the capabilities snapshot pushed to a client on connect. */
function buildCapabilities(): Frame {
  return {
    type: 'capabilities',
    brain: currentBrainSelection(),
    daemon: DAEMON_NAME,
    version: DAEMON_VERSION,
    injectCap: config.injectCap,
    tools: listTools(),
    integrations: INTEGRATIONS,
  };
}

/** Build the live `/override` state frame (the Face's status pill + countdown source). */
function buildOverrideState(): Frame {
  return { type: 'override.state', ...overrideSingleton().snapshot() };
}

/** Build the current model-readiness frame (the Face's boot gate). */
function buildModelState(): Frame {
  return { type: 'model.state', ...getModelState() };
}

/** Build the current owner safety-posture frame (the Settings page's source of truth). */
function buildSettingsState(): Frame {
  const cfg = ownerConfig();
  return {
    type: 'settings.state',
    breakerEnabled: cfg.breakerEnabled,
    dailySpendCeiling: cfg.dailySpendCeiling,
    defaultTtlMs: cfg.defaultTtlMs,
  };
}

/** Derive a `stats` frame from a brain's per-pass usage (tokens/sec + cost computed here). */
function statsFromUsage(id: string, usage: BrainUsage): Stats {
  const brain = currentBrainSelection();
  const tokensPerSec =
    usage.outputTokens && usage.evalMs && usage.evalMs > 0
      ? usage.outputTokens / (usage.evalMs / 1000)
      : undefined;
  // Local compute is free ($0) — both Ollama (local) and LM Studio (lmstudio). Cloud is priced from
  // tokens when the brain reports them.
  const estCostUsd =
    brain === 'cloud'
      ? (usage.promptTokens ?? 0) * CLOUD_PRICE_PER_TOKEN.input +
        (usage.outputTokens ?? 0) * CLOUD_PRICE_PER_TOKEN.output
      : 0;
  return {
    type: 'stats',
    id,
    brain,
    model: usage.model,
    promptTokens: usage.promptTokens,
    outputTokens: usage.outputTokens,
    tokensPerSec,
    evalMs: usage.evalMs,
    loadMs: usage.loadMs,
    totalMs: usage.totalMs,
    contextWindow: usage.contextWindow,
    estCostUsd,
  };
}

/**
 * A connected client, transport-agnostic. Today the only transport is the web Face, which wraps an SSE
 * response (`web/http-server.ts`); `send` is the ONE write primitive it implements (a `data:` SSE event).
 * `kind` lets targeted pushes — the live browser screencast — reach only web viewers. `wantsBrowser` is
 * the per-client screencast opt-in (flipped via the `browser.view` frame). The `kind` union keeps the
 * older non-web value so screencast targeting reads intentionally rather than assuming every client is web.
 */
export interface ClientConn {
  send(frame: Frame): void;
  kind: 'uds' | 'web';
  wantsBrowser?: boolean;
  /** Tear down the underlying transport on server shutdown (end the SSE response). */
  destroy?: () => void;
}

/** A handler invoked for every successfully-parsed, schema-valid inbound frame. */
export type FrameHandler = (frame: Frame, conn: ClientConn) => void;

/**
 * Every currently-connected client (web Faces over SSE). Server→client pushes (breaker.preview,
 * model.state, …) fan out via `broadcast`. A client is added on connect and removed on close/error so a
 * disconnected client never receives a write (which would otherwise throw).
 */
const clients = new Set<ClientConn>();

/** Register a connected client (the web HTTP server, on each SSE connect). */
export function addClient(conn: ClientConn): void {
  clients.add(conn);
}

/** Remove a connected client. Idempotent. */
export function removeClient(conn: ClientConn): void {
  clients.delete(conn);
}

/**
 * Push a frame to EVERY connected client. This is how the breaker's `emitPreview` reaches the Face
 * (SAFE-03): the daemon broadcasts the dry-run preview so the owner sees the 10s cancel window. A
 * write to a dead client is swallowed (its own close/error handler removes it) so a broadcast never
 * crashes the daemon. Returns the number of clients the frame was written to (0 == headless: the
 * action stays gated by ceiling+audit, but a live cancel is not possible — see SAFE-03 locked
 * decision: proceed after the window).
 */
export function broadcast(frame: Frame): number {
  let delivered = 0;
  for (const conn of clients) {
    try {
      send(conn, frame);
      delivered++;
    } catch {
      /* a dead client is cleaned up by its own error/close handler */
    }
  }
  return delivered;
}

/**
 * Push a frame ONLY to web clients that opted into the live browser screencast (`browser.view`). A web
 * client that closed its Browser pane stops getting them — so the heavy JPEG stream is confined to who is
 * actually watching. Returns the number of viewers the frame reached.
 */
export function broadcastBrowser(frame: Frame): number {
  let delivered = 0;
  for (const conn of clients) {
    if (conn.kind !== 'web' || !conn.wantsBrowser) continue;
    try {
      send(conn, frame);
      delivered++;
    } catch {
      /* a dead client is cleaned up by its own error/close handler */
    }
  }
  return delivered;
}

/** True if any connected web client currently wants the live browser screencast. */
export function anyBrowserViewers(): boolean {
  for (const conn of clients) {
    if (conn.kind === 'web' && conn.wantsBrowser) return true;
  }
  return false;
}

/**
 * The browser-view module injects its screencast start/stop reconciler here (avoids a server↔
 * browser-view import cycle). Called whenever the set of browser viewers may have changed — a
 * `browser.view` frame or a web client disconnecting — so the CDP screencast runs iff someone watches.
 */
let browserViewSync: () => void = () => {};
export function setBrowserViewSync(fn: () => void): void {
  browserViewSync = fn;
}
/** Re-evaluate whether the browser screencast should be running (viewer set changed). */
export function notifyViewersChanged(): void {
  browserViewSync();
}

/**
 * Push a frame to a client. Transport-agnostic — delegates to the client's own `send` (a `data:` SSE
 * event for the web transport).
 */
export function send(conn: ClientConn, frame: Frame): void {
  conn.send(frame);
}

/**
 * Wire the daemon's server→client broadcast seams to the shared `broadcast()`. Call ONCE at boot
 * (index.ts), before the web server starts, so a Red breaker preview and model warm-up progress reach
 * every connected client. (This wiring previously lived inside the UDS `startIpc()`; it now stands alone
 * because the web transport, not this module, owns the listening socket.)
 *   - setBreakerBroadcast: the registry's production breaker `emitPreview` calls broadcast so a Red
 *     dry-run preview reaches every connected Face (SAFE-03). Each preview gets a fresh id the matching
 *     `breaker.cancel` frame correlates to. Kept here (not in the registry) so the breaker logic stays
 *     pure and there is no registry→server import cycle.
 *   - setModelBroadcast: model warm-up progress (loading→ready/error) broadcasts as `model.state` so the
 *     boot gate can advance only when the model is truly ready (no readiness→server cycle).
 */
export function wireBroadcasts(): void {
  setBreakerBroadcast((preview) => {
    const id = `bp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    broadcast({
      type: 'breaker.preview',
      id,
      summary: preview.summary,
      estimatedSpend: preview.estimatedSpend,
      tier: 'red',
    });
    return id;
  });
  setModelBroadcast((state) => broadcast({ type: 'model.state', ...state }));
}

/**
 * Send the on-connect frame burst to a freshly-connected client: `ready`, then the runtime
 * `capabilities`, the live `/override` state, the owner `settings.state`, and the current model
 * readiness. Called by the web HTTP server on each SSE connect so a client can render its dashboard
 * immediately (and a client attaching to an ALREADY-WARM daemon leaves its boot screen instantly). A
 * client that ignores any of these is unaffected; all are also broadcast on change so a client never polls.
 */
export function sendConnectFrames(conn: ClientConn): void {
  send(conn, { type: 'ready', daemon: DAEMON_NAME, version: DAEMON_VERSION });
  send(conn, buildCapabilities());
  send(conn, buildOverrideState());
  send(conn, buildSettingsState());
  send(conn, buildModelState());
}

/**
 * Validate an already-JSON-parsed value against the frozen FrameSchema and route it to the handler.
 * Called by the web POST path (`web/http-server.ts`) for every inbound frame: an invalid frame replies
 * with an `error` frame and NEVER throws (T-01-09); a handler error is likewise caught and surfaced as
 * an `error` frame.
 */
export function routeFrame(
  parsed: unknown,
  conn: ClientConn,
  onFrame: FrameHandler = defaultFrameHandler,
): void {
  const result = FrameSchema.safeParse(parsed);
  if (!result.success) {
    const id = (parsed as { id?: unknown })?.id;
    send(conn, {
      type: 'error',
      ...(typeof id === 'string' ? { id } : {}),
      message: 'invalid frame: ' + result.error.issues.map((i) => i.message).join('; '),
    });
    return;
  }
  try {
    onFrame(result.data, conn);
  } catch (err) {
    // A handler error must also never crash the daemon.
    const id = (result.data as { id?: string }).id;
    send(conn, {
      type: 'error',
      ...(id ? { id } : {}),
      message: 'handler error: ' + (err instanceof Error ? err.message : String(err)),
    });
  }
}

/**
 * The default frame router. An `utterance` enqueues a user intent into the loop (the reply is pushed
 * back to this connection by the loop); a `ping` is answered immediately with `pong`. Every other arm is
 * an additive control-surface handler. Transport-agnostic — invoked by the web POST path via `routeFrame`.
 */
export function defaultFrameHandler(frame: Frame, conn: ClientConn): void {
  switch (frame.type) {
    case 'utterance': {
      // A streaming brain surfaces deltas via `onToken`; we forward each as a `say` frame for a
      // real-time render + TTS. When that happens, the terminal `reply` is REPLACED by a final
      // `say{final}` so the client doesn't render the answer twice.
      let streamed = false;
      enqueue({
        source: 'user',
        id: frame.id,
        payload: frame.text,
        onToken: (delta: string) => {
          streamed = true;
          send(conn, { type: 'say', id: frame.id, delta, final: false });
        },
        reply: (text: string) => {
          if (streamed) send(conn, { type: 'say', id: frame.id, delta: '', final: true });
          else send(conn, { type: 'reply', id: frame.id, text });
        },
        // Per-turn telemetry → a stats frame the client renders under the answer (tokens/sec, cost…).
        // The same stats also feed the daemon's cumulative session accumulator so the `usage`
        // meta-command (and a natural-language "how much have I used") can report authoritative totals.
        onUsage: (usage) => {
          const stats = statsFromUsage(frame.id, usage);
          recordTurn(stats);
          send(conn, stats);
        },
        // Background tool use → a `tool.activity` frame so the Face can show what KERNEL is doing
        // ("🔧 web · searching…", then a brief ✓). Purely informational; drives no action.
        onToolActivity: (event) => {
          send(conn, { type: 'tool.activity', id: frame.id, ...event });
        },
        // Live reasoning → a `reasoning` frame so the Face can show the model's chain-of-thought as it
        // forms (deliberate turns only — quick turns never think). The answer streams via `say` after.
        onThinking: (delta: string, final: boolean) => {
          send(conn, { type: 'reasoning', id: frame.id, delta, final });
        },
        // Estimated prefill time → a `progress` frame so the Face shows a determinate progress bar
        // (omitted on a cold start, where the Face keeps its honest indeterminate sweep).
        onProgress: (etaMs: number) => {
          send(conn, { type: 'progress', id: frame.id, etaMs, label: 'Processing prompt…' });
        },
      });
      break;
    }
    case 'ping':
      send(conn, { type: 'pong', id: frame.id });
      break;
    case 'settings':
      // P3 ADDITIVE arm: swap the active brain via the existing setBrain seam (settings.ts).
      // The 7B helper is unaffected. No reply frame in P3 — the toggle is fire-and-apply.
      applySettings(frame.brain);
      // Re-warm for the newly-selected brain so model.state reflects the switch (local → load the
      // model; cloud → ready immediately). Fire-and-forget; progress broadcasts as it resolves.
      void warmupActiveBrain(frame.brain);
      break;
    case 'override':
      // P5 ADDITIVE arm (SAFE-02): the Face activates/deactivates the scoped /override
      // capability. NEVER unlocks Red (override.allows('red') is structurally {gated:true}).
      if (frame.active) {
        // Use the Face's ttl, else the owner's persisted default; the capability auto-expires.
        overrideSingleton().activate('face-override', frame.ttlMs ?? defaultOverrideTtlMs());
      } else {
        overrideSingleton().deactivate();
      }
      // Broadcast the new state so EVERY Face updates its status pill + countdown immediately.
      broadcast(buildOverrideState());
      break;
    case 'settings.update': {
      // ADDITIVE arm (SAFE-08): update the owner safety posture (breaker on/off, spend ceiling,
      // override TTL), persist it, and echo the new state to every Face. Undefined fields are left
      // untouched (one toggle at a time). Enabling the breaker only makes Red REACHABLE — the
      // preview/cancel + ceiling + audit still gate every Red action.
      applyOwnerConfig({
        breakerEnabled: frame.breakerEnabled,
        dailySpendCeiling: frame.dailySpendCeiling,
        defaultTtlMs: frame.defaultTtlMs,
      });
      broadcast(buildSettingsState());
      break;
    }
    case 'audit.query': {
      // ADDITIVE arm (SAFE-08): the Activity view asks for the recent audit entries. Read the
      // append-only log and reply with the SAFE projection only (tool/outcome/ts — never the hash,
      // args, or any finance amount). Read-only; correlated by `id`.
      const entries = readAudit(defaultAuditPath(config.memoryDir), frame.limit ?? 200);
      send(conn, { type: 'audit.data', id: frame.id, entries });
      break;
    }
    case 'breaker.cancel':
      // P5 ADDITIVE arm (SAFE-03): the owner cancelled a Red action within the 10s window.
      // Flip the breaker's cancel latch (the in-flight gated run polls it and aborts WITHOUT
      // executing). `id` correlates to the active preview; the registry ignores a stale id.
      signalBreakerCancel(frame.id);
      break;
    case 'history.request': {
      // ADDITIVE arm: the Face's Chat page asks for the persisted transcript on connect. Read the
      // durable conversation log and reply with the recent turns (owner/assistant only, with
      // timestamps), correlated by `id`. Read-only — never mutates the conversation.
      const turns = conversation.readRecent(frame.limit ?? 200).map((t) => ({
        role: t.role,
        text: t.text,
        ts: t.ts,
      }));
      send(conn, { type: 'history.data', id: frame.id, turns });
      break;
    }
    case 'browser.view':
      // ADDITIVE arm (web→daemon): this web client opens/closes its Browser pane. Flip its per-client
      // screencast opt-in, then ask the browser-view module to reconcile — start the CDP screencast if
      // anyone now watches, stop it if nobody does (saves CPU). No reply.
      conn.wantsBrowser = frame.streaming;
      notifyViewersChanged();
      break;
    case 'service.list':
      // ADDITIVE arm (web→daemon): the Services panel asks for live background-service status.
      void listServices().then((services) => send(conn, { type: 'service.data', id: frame.id, services }));
      break;
    case 'service.action': {
      // ADDITIVE arm (web→daemon): stop an allowlisted background service, then reply with fresh status.
      const { id, name, action } = frame;
      void runServiceAction(name, action)
        .then(async (outcome) => {
          logger.info({ service: name, action, outcome }, 'web service action');
          const services = await listServices();
          send(conn, { type: 'service.data', id, services });
        })
        .catch(async (err) => {
          logger.warn({ service: name, action, err: String(err) }, 'web service action failed');
          const services = await listServices();
          send(conn, { type: 'service.data', id, services });
        });
      break;
    }
    case 'lmstudio.list':
      // ADDITIVE arm (web→daemon): the LM Studio model panel asks for the downloaded-model inventory.
      void listLmStudioModels().then((inv) =>
        send(conn, {
          type: 'lmstudio.data',
          id: frame.id,
          serverUp: inv.serverUp,
          active: activeModelKey(inv),
          models: inv.models,
        }),
      );
      break;
    case 'lmstudio.action': {
      // ADDITIVE arm (web→daemon): load/unload an LM Studio model (owner-only, localhost), then reply
      // with a fresh inventory. The control module refuses an unknown key — no arbitrary action path.
      const { id, action, key, contextLength } = frame;
      const run = action === 'load' ? loadLmStudioModel(key, contextLength) : unloadLmStudioModel(key);
      void run
        .then(async (note) => {
          logger.info({ lmstudio: action, key, contextLength }, 'web lmstudio action');
          const inv = await listLmStudioModels();
          send(conn, {
            type: 'lmstudio.data',
            id,
            serverUp: inv.serverUp,
            active: activeModelKey(inv),
            note,
            models: inv.models,
          });
        })
        .catch(async (err) => {
          logger.warn({ lmstudio: action, key, err: String(err) }, 'web lmstudio action failed');
          const inv = await listLmStudioModels().catch(() => ({ serverUp: false, models: [] }));
          send(conn, {
            type: 'lmstudio.data',
            id,
            serverUp: inv.serverUp,
            active: activeModelKey(inv),
            note: `action failed: ${err instanceof Error ? err.message : String(err)}`,
            models: inv.models,
          });
        });
      break;
    }
    default:
      // hello / ui.intent / ui.state / daemon-origin frames: no action here.
      break;
  }
}
