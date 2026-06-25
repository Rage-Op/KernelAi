/**
 * transport.ts — the browser side of the daemon bridge: an SSE down-channel (daemon→web push) and a
 * POST up-channel (web→daemon frames). Mirrors what the Mac Face does over the Unix socket, but with
 * the browser's native EventSource (which auto-reconnects on drop — robustness the owner asked for).
 *
 * Auth: a bearer token from the launcher URL (`?token=…`), persisted to sessionStorage so a reload
 * keeps working even if the URL is cleaned. Every request carries it. The daemon also requires a
 * loopback Host/Origin (anti-rebinding / CSRF) — enforced server-side.
 */
import type { InboundFrame, OutboundFrame } from './frames.js';

function resolveToken(): string {
  const fromUrl = new URLSearchParams(location.search).get('token');
  if (fromUrl) {
    try { sessionStorage.setItem('kernel.token', fromUrl); } catch { /* private mode */ }
    // Scrub the token from the address bar + history so it isn't shoulder-surfed, bookmarked, or synced.
    try { history.replaceState(null, '', location.pathname); } catch { /* unsupported */ }
    return fromUrl;
  }
  try { return sessionStorage.getItem('kernel.token') ?? ''; } catch { return ''; }
}

export interface Transport {
  send(frame: OutboundFrame): void;
  onFrame(cb: (frame: InboundFrame) => void): void;
  onStatus(cb: (connected: boolean) => void): void;
}

export function connect(): Transport {
  const token = resolveToken();
  let clientId: string | null = null;
  let frameCb: (frame: InboundFrame) => void = () => {};
  let statusCb: (connected: boolean) => void = () => {};
  const outbox: OutboundFrame[] = []; // buffered until we have a clientId

  function flush(): void {
    if (!clientId) return;
    while (outbox.length) post(outbox.shift()!);
  }

  function post(frame: OutboundFrame): void {
    void fetch('/frame', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...frame, clientId, token }),
      keepalive: true,
    })
      .then((res) => {
        // 409 = our SSE stream was replaced (reconnect race) → our clientId is stale. Drop it and
        // re-queue the frame so flush() resends it after the next `hello` (don't silently lose it).
        if (res.status === 409) {
          clientId = null;
          outbox.unshift(frame);
          statusCb(false);
        }
      })
      .catch(() => {
        // network blip → re-queue; the EventSource reconnect flushes the outbox after the next hello.
        outbox.unshift(frame);
      });
  }

  function open(): void {
    const es = new EventSource(`/events?token=${encodeURIComponent(token)}`);
    es.addEventListener('hello', (e) => {
      try {
        clientId = JSON.parse((e as MessageEvent).data).clientId;
        statusCb(true);
        flush();
      } catch { /* ignore */ }
    });
    es.onmessage = (e) => {
      try { frameCb(JSON.parse(e.data) as InboundFrame); } catch { /* skip malformed */ }
    };
    es.onerror = () => {
      // EventSource auto-reconnects; surface the drop. A fresh `hello` (new clientId) arrives on reopen.
      clientId = null;
      statusCb(false);
    };
  }

  open();

  return {
    send(frame) { if (clientId) post(frame); else outbox.push(frame); },
    onFrame(cb) { frameCb = cb; },
    onStatus(cb) { statusCb = cb; },
  };
}
