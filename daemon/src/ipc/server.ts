/**
 * UDS NDJSON IPC server (CORE-04) — the one genuinely subtle hand-rolled component.
 *
 * Creates a Unix-domain socket at `config.socketPath`, sends a `ready` frame on
 * connect, and reads newline-delimited JSON with PARTIAL-FRAME-SAFE buffering: a
 * single `data` event may carry 0..n complete lines plus a trailing partial, so a
 * per-connection string buffer carries the partial across events (RESEARCH.md
 * Pitfall 3). Every complete line is `JSON.parse`d and `FrameSchema.safeParse`d; a
 * malformed/invalid line replies with an `error` frame and NEVER throws out of the
 * data handler (T-01-09 — a bad frame must not crash the daemon).
 *
 * Server→client push is just a write: `send(conn, frame)` writes
 * `JSON.stringify(frame) + '\n'`. The raw duplex socket supports unprompted pushes,
 * which is why no WebSocket is required (RESEARCH.md transport notes).
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

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
import { exitIfStale } from '../build-stamp.js';
import { logger } from '../memory/log.js';
import { listServices, runServiceAction } from '../web/services.js';

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
 * Probe whether a LIVE daemon is already listening on `socketPath`. A successful connect means
 * another daemon owns the socket, so the boot path (index.ts) should exit rather than start a
 * second one: `startIpc` unlinks the socket before binding, which would otherwise STEAL it from the
 * running daemon (the two-daemon bug). A connection ERROR — ENOENT (no socket file) or ECONNREFUSED
 * (a stale socket file with no listener) — means no live daemon, so binding is safe. Resolves false
 * on a short timeout so a wedged peer can never hang startup.
 */
export function probeDaemonAlive(socketPath: string = config.socketPath): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(socketPath);
    const finish = (alive: boolean) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(alive);
    };
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    sock.setTimeout(800, () => finish(false));
  });
}

/**
 * A connected client, transport-agnostic. The UDS path (the Mac Face) wraps a `net.Socket`; the web
 * path (`web/http-server.ts`) wraps an SSE response. `send` is the ONE write primitive each transport
 * implements (NDJSON line for UDS, `data:` SSE event for web). `kind` lets targeted pushes — the live
 * browser screencast — reach only web viewers. `wantsBrowser` is the per-client screencast opt-in
 * (web clients flip it via the `browser.view` frame; UDS clients never set it).
 */
export interface ClientConn {
  send(frame: Frame): void;
  kind: 'uds' | 'web';
  wantsBrowser?: boolean;
  /** Tear down the underlying transport on server shutdown (destroy the socket / end the SSE response). */
  destroy?: () => void;
}

/** A handler invoked for every successfully-parsed, schema-valid inbound frame. */
export type FrameHandler = (frame: Frame, conn: ClientConn) => void;

/**
 * Every currently-connected client (Mac Face over UDS + web Faces over SSE). Server→client pushes
 * (breaker.preview, model.state, …) fan out via `broadcast`. A client is added on connect and removed
 * on close/error so a disconnected client never receives a write (which would otherwise EPIPE/throw).
 */
const clients = new Set<ClientConn>();

/** Register a connected client (used by both the UDS server and the web HTTP server). */
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
 * Push a frame ONLY to web clients that opted into the live browser screencast (`browser.view`). The
 * Mac Face never receives screencast frames (it has its own headful window), and a web client that
 * closed its Browser pane stops getting them — so the heavy JPEG stream is confined to who is actually
 * watching. Returns the number of viewers the frame reached.
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

/** The running IPC server handle returned to callers (e.g. the e2e). */
export interface IpcServer {
  /** The underlying net.Server. */
  server: net.Server;
  /** Close the server and unlink the socket file. Resolves when closed. */
  close: () => Promise<void>;
}

/**
 * Push a frame to a client. Transport-agnostic — delegates to the client's own `send` (NDJSON line
 * for UDS, `data:` SSE event for web).
 */
export function send(conn: ClientConn, frame: Frame): void {
  conn.send(frame);
}

/**
 * Send the on-connect frame burst to a freshly-connected client: `ready`, then the runtime
 * `capabilities`, the live `/override` state, the owner `settings.state`, and the current model
 * readiness. Shared by the UDS server and the web HTTP server so both transports give a client the
 * SAME initial snapshot. A client that ignores any of these is unaffected; all are also broadcast on
 * change so a client never polls.
 */
export function sendConnectFrames(conn: ClientConn): void {
  send(conn, { type: 'ready', daemon: DAEMON_NAME, version: DAEMON_VERSION });
  send(conn, buildCapabilities());
  send(conn, buildOverrideState());
  send(conn, buildSettingsState());
  send(conn, buildModelState());
}

/**
 * Attach the NDJSON line framing + validation pipeline to a single UDS connection.
 * Maintains a per-connection buffer so a JSON line split across `data` events is
 * reassembled into exactly one parsed frame.
 */
function attachReader(sock: net.Socket, conn: ClientConn, onFrame: FrameHandler): void {
  let buffer = '';
  sock.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1); // keep the trailing partial in the buffer
      if (!line.trim()) continue;
      handleLine(line, conn, onFrame);
    }
  });
}

/** Parse a single complete NDJSON line, then route it; never throws out of the data handler. */
function handleLine(line: string, conn: ClientConn, onFrame: FrameHandler): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    send(conn, { type: 'error', message: 'malformed JSON frame' });
    return;
  }
  routeFrame(parsed, conn, onFrame);
}

/**
 * Validate an already-JSON-parsed value against the frozen FrameSchema and route it to the handler.
 * SHARED by the UDS line reader and the web POST path (`web/http-server.ts`) so both transports apply
 * the SAME validation + error discipline (T-01-09): an invalid frame replies with an `error` frame and
 * NEVER throws; a handler error is likewise caught and surfaced as an `error` frame.
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
 * Start the UDS NDJSON server. Creates the socket dir, unlinks any stale socket,
 * sends `ready` on connect, and routes every valid frame to `onFrame`.
 *
 * @param onFrame   per-frame handler (defaults to the loop-connected router below).
 * @param socketPath socket path (defaults to config.socketPath; overridable in tests).
 */
export function startIpc(
  onFrame: FrameHandler = defaultFrameHandler,
  socketPath: string = config.socketPath,
): Promise<IpcServer> {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  try {
    fs.unlinkSync(socketPath); // remove a stale socket from a prior run
  } catch {
    /* no stale socket — fine */
  }

  // The registry's production breaker `emitPreview` calls THIS server's broadcast so a Red
  // dry-run preview reaches every connected Face (SAFE-03). Injected here so the breaker logic
  // (safety/breaker.ts) stays pure + the registry has no static dependency on the server (no
  // import cycle). Each preview gets a fresh id the matching breaker.cancel frame correlates to.
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

  // BRAIN-07: model warm-up progress (loading→ready/error) broadcasts to every connected Face so the
  // boot screen can advance only when the model is truly ready. Injected here (no readiness↔server cycle).
  setModelBroadcast((state) => broadcast({ type: 'model.state', ...state }));

  const server = net.createServer((sock) => {
    // MAINT-04: if dist was rebuilt since this process booted, a launchd-owned daemon exits here so
    // launchd relaunches it on the fresh code (automating the rebuild+kickstart). A no-op unless
    // genuinely stale; in dev/test (no build stamp) it never triggers.
    exitIfStale(logger);
    sock.setEncoding('utf8');
    // Wrap the raw socket in a transport-agnostic ClientConn so the handler/broadcast path is shared
    // with the web (SSE) transport. `send` is one NDJSON line; `destroy` tears the socket down on shutdown.
    const conn: ClientConn = {
      kind: 'uds',
      send: (frame) => sock.write(JSON.stringify(frame) + '\n'),
      destroy: () => sock.destroy(),
    };
    clients.add(conn);
    // The on-connect frame burst (ready + capabilities + control-surface state + model readiness) so a
    // client can render its dashboard immediately and a Face attaching to an ALREADY-WARM daemon leaves
    // its boot screen instantly. Identical to the web transport's burst (sendConnectFrames).
    sendConnectFrames(conn);
    attachReader(sock, conn, onFrame);
    const drop = () => clients.delete(conn);
    sock.on('close', drop);
    sock.on('end', drop);
    sock.on('error', () => {
      // a client disconnecting mid-write must not crash the daemon; drop it from the fan-out set.
      drop();
    });
  });

  return new Promise<IpcServer>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve({
        server,
        close: () =>
          new Promise<void>((res) => {
            for (const conn of clients) conn.destroy?.();
            clients.clear();
            server.close(() => {
              try {
                fs.unlinkSync(socketPath);
              } catch {
                /* already gone */
              }
              res();
            });
          }),
      });
    });
  });
}

/**
 * The default frame router used by `startIpcServer()`. An `utterance` enqueues a user
 * intent into the loop (the reply is pushed back to this connection by the loop); a
 * `ping` is answered immediately with `pong`. Other inbound types are ignored in P1.
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
      // anyone now watches, stop it if nobody does (saves CPU). UDS clients never send this; no reply.
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
    default:
      // hello / ui.intent / ui.state / daemon-origin frames: no action here.
      break;
  }
}

/**
 * Convenience entry used by the Walking-Skeleton e2e and index.ts: start the server
 * wired to the default loop-connected frame router.
 */
export function startIpcServer(socketPath: string = config.socketPath): Promise<IpcServer> {
  return startIpc(defaultFrameHandler, socketPath);
}
