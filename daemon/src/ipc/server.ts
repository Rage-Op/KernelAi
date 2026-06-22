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
import { FrameSchema, type Frame } from './protocol.js';
import { enqueue } from '../loop.js';
import { applySettings } from '../settings.js';

const DAEMON_NAME = 'kernel';
const DAEMON_VERSION = '0.1.0';

/** A handler invoked for every successfully-parsed, schema-valid inbound frame. */
export type FrameHandler = (frame: Frame, conn: net.Socket) => void;

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

  const server = net.createServer((conn) => {
    conn.setEncoding('utf8');
    send(conn, { type: 'ready', daemon: DAEMON_NAME, version: DAEMON_VERSION });
    attachReader(conn, onFrame);
    conn.on('error', () => {
      /* a client disconnecting mid-write must not crash the daemon */
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
    case 'utterance':
      enqueue({
        source: 'user',
        id: frame.id,
        payload: frame.text,
        reply: (text: string) => send(conn, { type: 'reply', id: frame.id, text }),
      });
      break;
    case 'ping':
      send(conn, { type: 'pong', id: frame.id });
      break;
    case 'settings':
      // P3 ADDITIVE arm: swap the active brain via the existing setBrain seam (settings.ts).
      // The 7B helper is unaffected. No reply frame in P3 — the toggle is fire-and-apply.
      applySettings(frame.brain);
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
