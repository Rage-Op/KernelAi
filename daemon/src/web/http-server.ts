/**
 * http-server.ts — the daemon-hosted WEB Face transport.
 *
 * Serves the prebuilt `webface/dist/` SPA and bridges a browser into the daemon's frozen frame contract.
 * Because `defaultFrameHandler` is transport-agnostic (it only ever calls `send(conn, frame)`), a web
 * client is just a `ClientConn`: every utterance flows `routeFrame → defaultFrameHandler → enqueue →
 * loop → dispatch → GATE`. The gate, tools, MCP, meta-commands, and /override are preserved unchanged —
 * the web UI gains nothing the gate doesn't allow. This is the daemon's SOLE transport.
 *
 * Transport (zero new dependencies, robust, native browser auto-reconnect):
 *   - GET  /events  → Server-Sent Events: the daemon→client push channel (ready, say, reasoning,
 *                     tool.activity, stats, progress, model.state, browser.frame, …). On connect we mint
 *                     a `clientId`, register a web ClientConn, and replay the on-connect frame burst.
 *   - POST /frame   → one client→daemon frame (utterance/ping/settings/override/browser.view/…). The
 *                     body carries the `clientId` so the reply routes back to that client's SSE stream.
 *   - GET  /*       → static assets from webface/dist (path-traversal-safe).
 *
 * SECURITY (this endpoint can ultimately reach shell/fs/finance, so the front door is locked HARD):
 *   - BIND 127.0.0.1 ONLY — never 0.0.0.0. No remote access, ever.
 *   - HOST header allowlist (127.0.0.1 / localhost / [::1] on our port) on EVERY request — defeats
 *     DNS-rebinding (an attacker domain pointed at 127.0.0.1 sends a foreign Host header → rejected).
 *   - BEARER TOKEN (web-token.ts) required on /events and /frame — stops other local processes / random
 *     browser tabs from driving KERNEL.
 *   - ORIGIN allowlist on POST /frame — CSRF defense (a cross-origin page cannot forge state-changing
 *     frames even if it somehow learned the token).
 *   - The gate is still the authority for WHAT an authenticated client may do.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import type { Frame } from '../ipc/protocol.js';
import {
  addClient,
  removeClient,
  sendConnectFrames,
  routeFrame,
  notifyViewersChanged,
  type ClientConn,
} from '../ipc/server.js';
import { getOrCreateWebToken, validateWebToken, webTokenPath } from './web-token.js';
import { logger } from '../memory/log.js';
import { exitIfStale } from '../build-stamp.js';

const HOST = '127.0.0.1';
/** Max POST body — frames are tiny; a 256KB cap stops a local process from ballooning memory. */
const MAX_BODY_BYTES = 256 * 1024;

/** The bound port (env override, default 7777). */
export function webPort(): number {
  const p = Number(process.env.KERNEL_HTTP_PORT);
  return Number.isFinite(p) && p > 0 ? p : 7777;
}

/**
 * The built web UI directory. From compiled `daemon/dist/web/http-server.js` (or `daemon/src/web/...`
 * under tsx) the repo root is three levels up, and `webface/dist` is its sibling. Override with
 * KERNEL_WEBFACE_DIR.
 */
function webfaceDir(): string {
  const fromEnv = process.env.KERNEL_WEBFACE_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..', 'webface', 'dist');
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** clientId → web ClientConn (its live SSE stream), so a POSTed frame routes its reply to the stream. */
const webClients = new Map<string, ClientConn>();

/** HOST header allowlist — defeats DNS-rebinding. Accept only loopback names on our port. */
function hostAllowed(req: http.IncomingMessage): boolean {
  const host = (req.headers.host ?? '').toLowerCase();
  const p = webPort();
  return host === `127.0.0.1:${p}` || host === `localhost:${p}` || host === `[::1]:${p}`;
}

/** ORIGIN allowlist for state-changing POSTs — CSRF defense. A missing Origin (same-origin GET-ish) is
 *  tolerated since the Host check already constrains the request; a PRESENT foreign Origin is rejected. */
function originAllowed(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  const p = webPort();
  return (
    origin === `http://127.0.0.1:${p}` ||
    origin === `http://localhost:${p}` ||
    origin === `http://[::1]:${p}`
  );
}

/** Extract the bearer token from `?token=`, the Authorization header, or (POST) a body field. */
function tokenFromRequest(req: http.IncomingMessage, url: URL, bodyToken?: unknown): string | null {
  const q = url.searchParams.get('token');
  if (q) return q;
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice('Bearer '.length);
  if (typeof bodyToken === 'string') return bodyToken;
  return null;
}

/** Read the request body up to the cap; rejects (resolves null) if oversized. */
function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

/** SSE: open the daemon→client push stream, register a web ClientConn, replay the on-connect burst. */
function handleEvents(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  if (!validateWebToken(tokenFromRequest(req, url))) {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('unauthorized');
    return;
  }
  // Symmetric with POST /frame: reject a present foreign Origin so a cross-origin page cannot open the
  // read stream even if the token leaks (EventSource always sets Origin on cross-origin connects).
  if (!originAllowed(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('bad origin');
    return;
  }
  // MAINT-04: if dist was rebuilt since this process booted, a launchd-owned daemon exits here (after
  // auth) so launchd relaunches it on the fresh code. A no-op unless genuinely stale; in dev/test (no
  // build stamp) it never triggers. Previously ran on each UDS connect; now on each authenticated SSE connect.
  exitIfStale(logger);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  const clientId = crypto.randomBytes(9).toString('hex');
  let backpressured = false;
  const conn: ClientConn = {
    kind: 'web',
    send: (frame: Frame) => {
      // BACKPRESSURE: while the socket's write buffer is full, DROP high-rate screencast frames (they are
      // disposable/latest-wins) instead of queueing them — otherwise a slow/backgrounded viewer grows the
      // response buffer unbounded. Low-rate control/chat frames are always written. res.write()===false
      // means the buffer exceeded highWaterMark; a 'drain' event clears the flag.
      if (backpressured && frame.type === 'browser.frame') return;
      try {
        const ok = res.write(`data: ${JSON.stringify(frame)}\n\n`);
        if (!ok && !backpressured) {
          backpressured = true;
          res.once('drain', () => { backpressured = false; });
        }
      } catch {
        /* dead stream — cleanup handler removes it */
      }
    },
    destroy: () => {
      try {
        res.end();
      } catch {
        /* already closed */
      }
    },
  };
  addClient(conn);
  webClients.set(clientId, conn);
  // First event tells the client its id so its POSTs correlate to THIS stream (custom `hello` event).
  res.write(`event: hello\ndata: ${JSON.stringify({ clientId })}\n\n`);
  // The on-connect snapshot (ready + capabilities + control-surface + model state).
  sendConnectFrames(conn);

  const keepAlive = setInterval(() => {
    try {
      res.write(': ka\n\n');
    } catch {
      /* dead — cleanup runs on close */
    }
  }, 15_000);

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(keepAlive);
    removeClient(conn);
    webClients.delete(clientId);
    // This client may have been the last browser-screencast viewer — reconcile (stop if nobody watches).
    notifyViewersChanged();
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
}

/** POST: one client→daemon frame, routed to that client's SSE stream by `clientId`. */
async function handleFrame(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const raw = await readBody(req);
  if (raw === null) {
    res.writeHead(413, { 'Content-Type': 'text/plain' });
    res.end('payload too large');
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('malformed JSON');
    return;
  }
  const bodyToken = (parsed as { token?: unknown })?.token;
  if (!validateWebToken(tokenFromRequest(req, url, bodyToken))) {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('unauthorized');
    return;
  }
  if (!originAllowed(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('bad origin');
    return;
  }
  const clientId = (parsed as { clientId?: unknown })?.clientId;
  const conn = typeof clientId === 'string' ? webClients.get(clientId) : undefined;
  if (!conn) {
    // No live SSE stream to route the reply to — the client must (re)open /events first.
    res.writeHead(409, { 'Content-Type': 'text/plain' });
    res.end('no event stream; reconnect');
    return;
  }
  // Strip transport-only envelope fields before frame validation (they are not part of FrameSchema).
  if (parsed && typeof parsed === 'object') {
    delete (parsed as Record<string, unknown>).clientId;
    delete (parsed as Record<string, unknown>).token;
  }
  // Validation + routing via the shared routeFrame. Replies/says/etc. stream back over the client's SSE
  // channel via conn.send.
  routeFrame(parsed, conn);
  res.writeHead(204);
  res.end();
}

/** Serve a static asset from webface/dist, path-traversal-safe. `/` → index.html (SPA entry). */
function handleStatic(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  const root = webfaceDir();
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  // Resolve under the root and refuse anything that escapes it (path traversal).
  const resolved = path.resolve(root, '.' + rel);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('forbidden');
    return;
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      // SPA fallback: unknown non-asset path → index.html (so client-side routing works).
      if (!path.extname(resolved)) {
        fs.readFile(path.join(root, 'index.html'), (e2, html) => {
          if (e2) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('web UI not built — run `npm run build:web` in daemon/');
            return;
          }
          res.writeHead(200, { 'Content-Type': MIME['.html'], 'Referrer-Policy': 'no-referrer' });
          res.end(html);
        });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    const mime = MIME[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Referrer-Policy': 'no-referrer' });
    res.end(data);
  });
}

/** The single request router. Host check first (anti-rebinding), then route by method + path. */
function handler(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (!hostAllowed(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('forbidden host');
    return;
  }
  const url = new URL(req.url ?? '/', `http://${HOST}:${webPort()}`);
  if (url.pathname === '/events' && req.method === 'GET') {
    handleEvents(req, res, url);
    return;
  }
  if (url.pathname === '/frame' && req.method === 'POST') {
    void handleFrame(req, res, url);
    return;
  }
  if (req.method === 'GET') {
    handleStatic(req, res, url);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
}

/** A running web server handle. */
export interface WebServer {
  close: () => Promise<void>;
  url: string;
  port: number;
  token: string;
}

/**
 * Start the localhost web server. Binds 127.0.0.1 only. Returns the launcher URL (with the token) the
 * owner opens. Idempotent w.r.t. the token (reused across restarts so a bookmark keeps working).
 */
export function startWebServer(): Promise<WebServer> {
  const token = getOrCreateWebToken();
  const server = http.createServer(handler);
  const p = webPort();
  return new Promise<WebServer>((resolve, reject) => {
    server.once('error', reject);
    server.listen(p, HOST, () => {
      server.removeListener('error', reject);
      const url = `http://${HOST}:${p}/?token=${token}`;
      logger.info(
        { addr: `http://${HOST}:${p}`, tokenPath: webTokenPath(), webfaceDir: webfaceDir() },
        'KERNEL web face listening',
      );
      resolve({
        url,
        port: p,
        token,
        close: () =>
          new Promise<void>((res) => {
            for (const conn of webClients.values()) conn.destroy?.();
            webClients.clear();
            server.close(() => res());
          }),
      });
    });
  });
}
