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
import { CLOUD_PRICE_PER_TOKEN } from '../brain/pricing.js';
import { recordTurn } from '../commands/session-usage.js';

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

/** Derive a `stats` frame from a brain's per-pass usage (tokens/sec + cost computed here). */
function statsFromUsage(id: string, usage: BrainUsage): Stats {
  const brain = currentBrainSelection();
  const tokensPerSec =
    usage.outputTokens && usage.evalMs && usage.evalMs > 0
      ? usage.outputTokens / (usage.evalMs / 1000)
      : undefined;
  // Local compute is free ($0). Cloud is priced from tokens when the brain reports them.
  const estCostUsd =
    brain === 'local'
      ? 0
      : (usage.promptTokens ?? 0) * CLOUD_PRICE_PER_TOKEN.input +
        (usage.outputTokens ?? 0) * CLOUD_PRICE_PER_TOKEN.output;
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

/** A handler invoked for every successfully-parsed, schema-valid inbound frame. */
export type FrameHandler = (frame: Frame, conn: net.Socket) => void;

/**
 * Every currently-connected Face client. Server→client pushes (the breaker.preview frame)
 * fan out to all of them via `broadcast`. A socket is added on connect and removed on
 * close/error so a disconnected Face never receives a write (which would otherwise EPIPE).
 */
const clients = new Set<net.Socket>();

/**
 * Push a frame to EVERY connected Face client. This is how the breaker's `emitPreview`
 * reaches the Face (SAFE-03): the daemon broadcasts the dry-run preview so the owner sees
 * the 10s cancel window. A write to a dead socket is swallowed (the socket's own 'error'
 * handler removes it) so a broadcast never crashes the daemon. Returns the number of
 * clients the frame was written to (0 == headless: the action stays gated by ceiling+audit,
 * but a live cancel is not possible — see SAFE-03 locked decision: proceed after the window).
 */
export function broadcast(frame: Frame): number {
  let delivered = 0;
  for (const conn of clients) {
    try {
      send(conn, frame);
      delivered++;
    } catch {
      /* a dead socket is cleaned up by its own error/close handler */
    }
  }
  return delivered;
}

/** The running IPC server handle returned to callers (e.g. the e2e). */
export interface IpcServer {
  /** The underlying net.Server. */
  server: net.Server;
  /** Close the server and unlink the socket file. Resolves when closed. */
  close: () => Promise<void>;
}

/**
 * Push a frame to a client. Server→client is just a newline-delimited JSON write.
 */
export function send(conn: net.Socket, frame: Frame): void {
  conn.write(JSON.stringify(frame) + '\n');
}

/**
 * Attach the NDJSON line framing + validation pipeline to a single connection.
 * Maintains a per-connection buffer so a JSON line split across `data` events is
 * reassembled into exactly one parsed frame.
 */
function attachReader(conn: net.Socket, onFrame: FrameHandler): void {
  let buffer = '';
  conn.on('data', (chunk: Buffer) => {
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

/** Parse + validate a single complete line; never throws out of the data handler. */
function handleLine(line: string, conn: net.Socket, onFrame: FrameHandler): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    send(conn, { type: 'error', message: 'malformed JSON frame' });
    return;
  }
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

  const server = net.createServer((conn) => {
    conn.setEncoding('utf8');
    clients.add(conn);
    send(conn, { type: 'ready', daemon: DAEMON_NAME, version: DAEMON_VERSION });
    // Push the runtime capabilities right after ready so a client can render its dashboard
    // immediately (brain, context cap, tools, integrations). A client that ignores it is unaffected.
    send(conn, buildCapabilities());
    attachReader(conn, onFrame);
    const drop = () => clients.delete(conn);
    conn.on('close', drop);
    conn.on('end', drop);
    conn.on('error', () => {
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
            for (const conn of clients) conn.destroy();
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
export function defaultFrameHandler(frame: Frame, conn: net.Socket): void {
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
      break;
    case 'override':
      // P5 ADDITIVE arm (SAFE-02): the Face activates/deactivates the scoped /override
      // capability. NEVER unlocks Red (override.allows('red') is structurally {gated:true}).
      if (frame.active) {
        // Default 10 min if the Face omits a ttl; the capability auto-expires on its own clock.
        overrideSingleton().activate('face-override', frame.ttlMs ?? 600_000);
      } else {
        overrideSingleton().deactivate();
      }
      break;
    case 'breaker.cancel':
      // P5 ADDITIVE arm (SAFE-03): the owner cancelled a Red action within the 10s window.
      // Flip the breaker's cancel latch (the in-flight gated run polls it and aborts WITHOUT
      // executing). `id` correlates to the active preview; the registry ignores a stale id.
      signalBreakerCancel(frame.id);
      break;
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
