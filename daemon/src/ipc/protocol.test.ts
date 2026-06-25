/**
 * protocol.test.ts — the frozen frame contract validates P1 frames and rejects junk.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FrameSchema } from './protocol.js';

test('protocol: valid Face→daemon frames parse', () => {
  assert.equal(FrameSchema.safeParse({ type: 'hello', client: 'face', version: '0.1.0' }).success, true);
  assert.equal(
    FrameSchema.safeParse({ type: 'utterance', id: 'a1', text: 'hi', final: true }).success,
    true,
  );
  assert.equal(FrameSchema.safeParse({ type: 'ping', id: 'p1' }).success, true);
});

test('protocol: valid daemon→Face frames parse', () => {
  assert.equal(
    FrameSchema.safeParse({ type: 'ready', daemon: 'kernel', version: '0.1.0' }).success,
    true,
  );
  assert.equal(FrameSchema.safeParse({ type: 'reply', id: 'a1', text: 'hello' }).success, true);
  assert.equal(FrameSchema.safeParse({ type: 'pong', id: 'p1' }).success, true);
  assert.equal(FrameSchema.safeParse({ type: 'error', message: 'boom' }).success, true);
});

test('protocol: an unknown type is rejected', () => {
  const r = FrameSchema.safeParse({ type: 'nope', id: 'x' });
  assert.equal(r.success, false);
});

test('protocol: reasoning frame round-trips (additive, daemon→Face live chain-of-thought)', () => {
  assert.equal(
    FrameSchema.safeParse({ type: 'reasoning', id: 'a1', delta: 'Let me work it out.', final: false }).success,
    true,
  );
  assert.equal(
    FrameSchema.safeParse({ type: 'reasoning', id: 'a1', delta: '', final: true }).success,
    true,
    'the terminal frame carries an empty delta',
  );
  assert.equal(
    FrameSchema.safeParse({ type: 'reasoning', id: 'a1', delta: 'x' }).success,
    false,
    'final is required',
  );
});

test('protocol: progress frame round-trips (additive, daemon→Face determinate prefill bar)', () => {
  assert.equal(
    FrameSchema.safeParse({ type: 'progress', id: 'a1', etaMs: 1500, label: 'Processing prompt…' }).success,
    true,
  );
  assert.equal(
    FrameSchema.safeParse({ type: 'progress', id: 'a1', etaMs: 1500 }).success,
    true,
    'label is optional',
  );
  assert.equal(
    FrameSchema.safeParse({ type: 'progress', id: 'a1' }).success,
    false,
    'etaMs is required',
  );
});

test('protocol: tool.activity frame round-trips (additive, daemon→Face background tool use)', () => {
  assert.equal(
    FrameSchema.safeParse({ type: 'tool.activity', id: 'a1', tool: 'web', op: 'search', status: 'start', detail: 'apple news' }).success,
    true,
  );
  assert.equal(
    FrameSchema.safeParse({ type: 'tool.activity', id: 'a1', tool: 'finance', op: 'aggregate', status: 'ok' }).success,
    true,
    'detail is optional',
  );
  assert.equal(
    FrameSchema.safeParse({ type: 'tool.activity', id: 'a1', tool: 'web', op: 'search', status: 'bogus' }).success,
    false,
    'status is constrained to start|ok|error',
  );
});

test('protocol: control-surface frames round-trip (additive — override.state / settings / audit)', () => {
  // daemon→Face override.state (active with scope+expiry, and the inactive shape)
  assert.equal(
    FrameSchema.safeParse({ type: 'override.state', active: true, scope: 'face-override', expiresAt: 123 }).success,
    true,
  );
  assert.equal(FrameSchema.safeParse({ type: 'override.state', active: false }).success, true, 'scope/expiry optional');
  // Face→daemon settings.update (every field optional — one toggle at a time)
  assert.equal(FrameSchema.safeParse({ type: 'settings.update', breakerEnabled: true }).success, true);
  assert.equal(FrameSchema.safeParse({ type: 'settings.update', dailySpendCeiling: 25, defaultTtlMs: 120000 }).success, true);
  assert.equal(FrameSchema.safeParse({ type: 'settings.update' }).success, true, 'all fields optional');
  // daemon→Face settings.state (all required)
  assert.equal(
    FrameSchema.safeParse({ type: 'settings.state', breakerEnabled: false, dailySpendCeiling: 0, defaultTtlMs: 600000 }).success,
    true,
  );
  assert.equal(
    FrameSchema.safeParse({ type: 'settings.state', breakerEnabled: false }).success,
    false,
    'settings.state requires ceiling + ttl',
  );
  // audit.query / audit.data
  assert.equal(FrameSchema.safeParse({ type: 'audit.query', id: 'q1', limit: 50 }).success, true);
  assert.equal(
    FrameSchema.safeParse({
      type: 'audit.data',
      id: 'q1',
      entries: [{ tool: 'shell', outcome: 'executed', ts: '2026-06-24T10:00:00.000Z' }],
    }).success,
    true,
  );
  // model.state (boot gate) — status constrained; model/detail optional
  assert.equal(FrameSchema.safeParse({ type: 'model.state', status: 'loading', brain: 'local', model: 'qwen3.5:9b', detail: 'Loading…' }).success, true);
  assert.equal(FrameSchema.safeParse({ type: 'model.state', status: 'ready', brain: 'cloud' }).success, true, 'model/detail optional');
  assert.equal(FrameSchema.safeParse({ type: 'model.state', status: 'bogus', brain: 'local' }).success, false, 'status is loading|ready|error');
});

test('protocol: history.request / history.data round-trip (additive, persisted chat history)', () => {
  // Face→daemon request (limit optional).
  assert.equal(FrameSchema.safeParse({ type: 'history.request', id: 'h1', limit: 50 }).success, true);
  assert.equal(FrameSchema.safeParse({ type: 'history.request', id: 'h1' }).success, true, 'limit optional');
  // daemon→Face reply with typed turns.
  assert.equal(
    FrameSchema.safeParse({
      type: 'history.data',
      id: 'h1',
      turns: [
        { role: 'user', text: 'hi', ts: 1 },
        { role: 'assistant', text: 'hello', ts: 2 },
      ],
    }).success,
    true,
  );
  assert.equal(
    FrameSchema.safeParse({ type: 'history.data', id: 'h1', turns: [] }).success,
    true,
    'an empty transcript is valid',
  );
  // role is constrained — no 'clear'/external content leaks into the wire history.
  assert.equal(
    FrameSchema.safeParse({ type: 'history.data', id: 'h1', turns: [{ role: 'clear', text: '', ts: 0 }] }).success,
    false,
    'role is constrained to user|assistant',
  );
});

test('protocol: a missing required field is rejected', () => {
  // utterance without `text`
  assert.equal(FrameSchema.safeParse({ type: 'utterance', id: 'a1', final: true }).success, false);
  // ping without `id`
  assert.equal(FrameSchema.safeParse({ type: 'ping' }).success, false);
  // reply with a non-string text
  assert.equal(FrameSchema.safeParse({ type: 'reply', id: 'a1', text: 42 }).success, false);
});

test('protocol: the designed-for P2/P3 shapes are part of the frozen contract', () => {
  assert.equal(
    FrameSchema.safeParse({
      type: 'speak',
      id: 's1',
      text: 'hello',
      cues: [{ atChar: 0, action: 'bloom', widget: 'cloud' }],
    }).success,
    true,
  );
  assert.equal(
    FrameSchema.safeParse({ type: 'widget.data', widget: 'cloud', data: { x: 1 } }).success,
    true,
  );
  assert.equal(
    FrameSchema.safeParse({ type: 'ui.intent', id: 'u1', intent: 'open' }).success,
    true,
  );
});

// --- P3 ADDITIVE arms (CLOUD-01 / CLOUD-05) — settings + ui.state round-trip ---

test('protocol: a settings frame (brain toggle) round-trips through FrameSchema', () => {
  assert.equal(FrameSchema.safeParse({ type: 'settings', brain: 'cloud' }).success, true);
  assert.equal(FrameSchema.safeParse({ type: 'settings', brain: 'local' }).success, true);
  // an out-of-enum brain is rejected
  assert.equal(FrameSchema.safeParse({ type: 'settings', brain: 'martian' }).success, false);
  // missing brain is rejected
  assert.equal(FrameSchema.safeParse({ type: 'settings' }).success, false);
});

test('protocol: a ui.state frame (cloud scene state) round-trips through FrameSchema', () => {
  for (const state of ['fullscreen', 'cornerPill', 'idle']) {
    assert.equal(FrameSchema.safeParse({ type: 'ui.state', state }).success, true, state);
  }
  // an out-of-enum state is rejected
  assert.equal(FrameSchema.safeParse({ type: 'ui.state', state: 'maximized' }).success, false);
});

// --- P4 ADDITIVE arm (CC-02) — the Claude Code transcript ---

test('protocol: a transcript frame (Claude Code bridge) round-trips through FrameSchema', () => {
  // a kernel line (no partial flag)
  assert.equal(
    FrameSchema.safeParse({ type: 'transcript', id: 't1', role: 'kernel', text: 'I need you to refactor the parser.' }).success,
    true,
  );
  // a claude line, streaming (partial:true)
  assert.equal(
    FrameSchema.safeParse({ type: 'transcript', id: 't2', role: 'claude', text: 'Reading the file…', partial: true }).success,
    true,
  );
  // a claude line, finalized (partial:false)
  assert.equal(
    FrameSchema.safeParse({ type: 'transcript', id: 't3', role: 'claude', text: 'Done.', partial: false }).success,
    true,
  );
});

test('protocol: a malformed transcript frame is rejected', () => {
  // an out-of-enum role is rejected
  assert.equal(
    FrameSchema.safeParse({ type: 'transcript', id: 't4', role: 'martian', text: 'x' }).success,
    false,
  );
  // missing role is rejected
  assert.equal(FrameSchema.safeParse({ type: 'transcript', id: 't5', text: 'x' }).success, false);
  // missing text is rejected
  assert.equal(FrameSchema.safeParse({ type: 'transcript', id: 't6', role: 'kernel' }).success, false);
  // missing id is rejected
  assert.equal(FrameSchema.safeParse({ type: 'transcript', role: 'kernel', text: 'x' }).success, false);
  // a non-boolean partial is rejected
  assert.equal(
    FrameSchema.safeParse({ type: 'transcript', id: 't7', role: 'claude', text: 'x', partial: 'yes' }).success,
    false,
  );
});

// --- ADDITIVE arms — capabilities (on connect) + stats (per turn) ---

test('protocol: a capabilities frame round-trips through FrameSchema', () => {
  assert.equal(
    FrameSchema.safeParse({
      type: 'capabilities',
      brain: 'local',
      daemon: 'kernel',
      version: '0.1.0',
      injectCap: 16384,
      tools: ['browser', 'finance', 'mail', 'peekaboo'],
      integrations: ['Peekaboo', 'Playwright'],
    }).success,
    true,
  );
  // a non-enum brain is rejected
  assert.equal(
    FrameSchema.safeParse({ type: 'capabilities', brain: 'x', daemon: 'k', version: '1', injectCap: 1, tools: [], integrations: [] }).success,
    false,
  );
  // missing tools array is rejected
  assert.equal(
    FrameSchema.safeParse({ type: 'capabilities', brain: 'local', daemon: 'k', version: '1', injectCap: 1, integrations: [] }).success,
    false,
  );
});

test('protocol: a stats frame round-trips; metric fields are optional', () => {
  // a full local stats frame
  assert.equal(
    FrameSchema.safeParse({
      type: 'stats',
      id: 'u1',
      brain: 'local',
      model: 'qwen2.5:7b-instruct-q4_K_M',
      promptTokens: 120,
      outputTokens: 40,
      tokensPerSec: 20,
      evalMs: 2000,
      loadMs: 0,
      totalMs: 2600,
      contextWindow: 8192,
      estCostUsd: 0,
    }).success,
    true,
  );
  // a minimal stats frame (only id + brain) — all metrics omitted
  assert.equal(FrameSchema.safeParse({ type: 'stats', id: 'u2', brain: 'cloud' }).success, true);
  // missing id is rejected
  assert.equal(FrameSchema.safeParse({ type: 'stats', brain: 'local' }).success, false);
  // a non-numeric token count is rejected
  assert.equal(FrameSchema.safeParse({ type: 'stats', id: 'u3', brain: 'local', outputTokens: 'lots' }).success, false);
});

test('protocol: a speak frame carrying cues[] + onFinish round-trips (the frozen SpeakSchema)', () => {
  const r = FrameSchema.safeParse({
    type: 'speak',
    id: 's2',
    text: "You've got three events today, and your checking is at twelve hundred.",
    cues: [
      { atChar: 9, action: 'stage.present', widget: 'events', data: { count: 3 } },
      { atChar: 40, action: 'stage.dismiss', widget: 'events' },
      { atChar: 48, action: 'stage.present', widget: 'accounts', data: { balance: 1200 } },
    ],
    onFinish: [{ action: 'stage.dismiss', widget: 'accounts' }],
  });
  assert.equal(r.success, true, 'speak with cues[] + onFinish must round-trip');
});

test('protocol: the web browser-view frames round-trip (additive: browser.frame / browser.state / browser.view)', () => {
  // daemon→web screencast frame
  assert.equal(
    FrameSchema.safeParse({ type: 'browser.frame', dataB64: 'AAAA', url: 'http://x', width: 1280, height: 800 }).success,
    true,
  );
  // daemon→web high-level state (url optional)
  assert.equal(FrameSchema.safeParse({ type: 'browser.state', active: true, url: 'http://x' }).success, true);
  assert.equal(FrameSchema.safeParse({ type: 'browser.state', active: false }).success, true);
  // web→daemon subscribe/unsubscribe
  assert.equal(FrameSchema.safeParse({ type: 'browser.view', streaming: true }).success, true);
  // malformed: a non-string dataB64 is rejected
  assert.equal(FrameSchema.safeParse({ type: 'browser.frame', dataB64: 123, url: 'x', width: 1, height: 1 }).success, false);
  // malformed: browser.view requires streaming:boolean
  assert.equal(FrameSchema.safeParse({ type: 'browser.view' }).success, false);
});

test('protocol: the background-service frames round-trip (additive: service.list / service.action / service.data)', () => {
  assert.equal(FrameSchema.safeParse({ type: 'service.list', id: 'svc' }).success, true);
  assert.equal(FrameSchema.safeParse({ type: 'service.action', id: 'svc', name: 'ollama', action: 'stop' }).success, true);
  assert.equal(
    FrameSchema.safeParse({ type: 'service.data', id: 'svc', services: [{ name: 'ollama', label: 'Ollama', running: true, pid: 42, detail: ':11434', actions: ['stop'] }] }).success,
    true,
  );
  // malformed: action must be the stop/restart enum
  assert.equal(FrameSchema.safeParse({ type: 'service.action', id: 'svc', name: 'ollama', action: 'nuke' }).success, false);
  // malformed: a service entry missing `actions`
  assert.equal(FrameSchema.safeParse({ type: 'service.data', services: [{ name: 'x', label: 'x', running: false }] }).success, false);
});
