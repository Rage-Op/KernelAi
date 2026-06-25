/**
 * http-server.test.ts — the web transport's SECURITY + bridge. Verifies the front-door lock (token,
 * Host anti-rebinding, Origin CSRF) and that an authenticated client's frame routes through the SAME
 * defaultFrameHandler as the UDS Face (ping→pong over SSE). Uses raw http (no EventSource dependency).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// Env MUST be set before the first token/port read (startWebServer reads them lazily, so this is fine).
const PORT = 7791;
process.env.KERNEL_HTTP_PORT = String(PORT);
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-http-home-'));
const WEBDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-http-web-'));
fs.writeFileSync(path.join(WEBDIR, 'index.html'), '<!doctype html><title>kernel-test</title>');
process.env.KERNEL_WEBFACE_DIR = WEBDIR;

import { startWebServer, type WebServer } from './http-server.js';
import { getOrCreateWebToken, __resetWebTokenCacheForTest } from './web-token.js';

__resetWebTokenCacheForTest();
const TOKEN = getOrCreateWebToken();

interface Res { status: number; body: string; }
function request(opts: http.RequestOptions, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, ...opts }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

interface SSE { frames: Record<string, unknown>[]; helloId: string; close: () => void; }
function openSSE(token: string): Promise<SSE> {
  return new Promise((resolve, reject) => {
    const frames: Record<string, unknown>[] = [];
    let helloId = '';
    let resolved = false;
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: `/events?token=${encodeURIComponent(token)}`, method: 'GET' },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`SSE status ${res.statusCode}`));
          return;
        }
        let buf = '';
        res.on('data', (c) => {
          buf += c.toString();
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            let event = 'message';
            let data = '';
            for (const line of chunk.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim();
              else if (line.startsWith('data:')) data += line.slice(5).trim();
            }
            if (!data) continue;
            if (event === 'hello') {
              helloId = (JSON.parse(data) as { clientId: string }).clientId;
              if (!resolved) { resolved = true; resolve({ frames, get helloId() { return helloId; }, close: () => req.destroy() }); }
            } else {
              try { frames.push(JSON.parse(data)); } catch { /* skip */ }
            }
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
    setTimeout(() => { if (!resolved) reject(new Error('SSE hello timeout')); }, 3000);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: WebServer;
before(async () => { server = await startWebServer(); });
after(async () => { await server.close(); });

test('static: GET / serves index.html without a token', async () => {
  const r = await request({ path: '/', method: 'GET' });
  assert.equal(r.status, 200);
  assert.match(r.body, /kernel-test/);
});

test('auth: GET /events without a token → 401', async () => {
  const r = await request({ path: '/events', method: 'GET' });
  assert.equal(r.status, 401);
});

test('auth: POST /frame without a token → 401', async () => {
  const r = await request(
    { path: '/frame', method: 'POST', headers: { 'Content-Type': 'application/json' } },
    JSON.stringify({ type: 'ping', id: 'x' }),
  );
  assert.equal(r.status, 401);
});

test('anti-rebinding: a foreign Host header → 403', async () => {
  const r = await request({ path: '/', method: 'GET', headers: { host: 'evil.example.com' } });
  assert.equal(r.status, 403);
});

test('CSRF: POST /frame with a foreign Origin → 403 (even with a valid token)', async () => {
  const r = await request(
    {
      path: '/frame',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example.com', Authorization: `Bearer ${TOKEN}` },
    },
    JSON.stringify({ type: 'ping', id: 'x', clientId: 'nope' }),
  );
  assert.equal(r.status, 403);
});

test('bridge: an authenticated client gets the connect burst and ping→pong over SSE', async () => {
  const sse = await openSSE(TOKEN);
  // connect burst: ready + capabilities + model.state should arrive
  await sleep(150);
  const types = sse.frames.map((f) => f.type);
  assert.ok(types.includes('ready'), 'ready frame');
  assert.ok(types.includes('capabilities'), 'capabilities frame');
  assert.ok(types.includes('model.state'), 'model.state frame');

  // POST a ping with the clientId → defaultFrameHandler answers pong on THIS stream.
  const r = await request(
    { path: '/frame', method: 'POST', headers: { 'Content-Type': 'application/json' } },
    JSON.stringify({ type: 'ping', id: 'ping-1', clientId: sse.helloId, token: TOKEN }),
  );
  assert.equal(r.status, 204);
  let pong: Record<string, unknown> | undefined;
  for (let i = 0; i < 20 && !pong; i++) { await sleep(50); pong = sse.frames.find((f) => f.type === 'pong'); }
  assert.ok(pong, 'pong received over SSE');
  assert.equal(pong!.id, 'ping-1');
  sse.close();
});

test('routing: POST /frame with an unknown clientId → 409', async () => {
  const r = await request(
    { path: '/frame', method: 'POST', headers: { 'Content-Type': 'application/json' } },
    JSON.stringify({ type: 'ping', id: 'x', clientId: 'does-not-exist', token: TOKEN }),
  );
  assert.equal(r.status, 409);
});
