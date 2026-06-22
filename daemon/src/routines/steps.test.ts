/**
 * steps.test.ts — RED until Task 2 creates steps.ts (ROUT-04/05).
 *
 * One handler per step id. The two security-load-bearing handlers:
 *   - mail_triage TAGS each message via the always-on 7B helper.classify with labels
 *     ['log','reply','open','archive'] (ROUT-04). With Ollama mocked-absent every message
 *     gets the neutral default ('log') and the handler NEVER throws (T-04-02 — triage only
 *     tags, it never auto-acts).
 *   - invitations / email_reply EMIT a ToolCall envelope ({tool:'mail', args:{op:'reply'…}})
 *     for the loop to dispatch through registry.dispatch → gate.authorize. The handler NEVER
 *     classifies the tier itself — the shipped classifyTier owns that. We assert the emitted
 *     op classifies 'yellow' (ROUT-05) and that a Red-shaped op would classify 'red' (proving
 *     the engine never self-classifies).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handlers, type StepDeps } from './steps.js';
import { classifyTier } from '../safety/tiers.js';

const realFetch = globalThis.fetch;
function refuseFetch(): void {
  globalThis.fetch = (async () => {
    throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' });
  }) as unknown as typeof fetch;
}
function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

function baseDeps(): StepDeps {
  return {
    id: 'brief-1',
    messages: [
      { sender: 'Ana', subject: 'Lunch?', snippet: 'free today?', source: 'external' },
      { sender: 'Ops', subject: 'Deploy', snippet: 'all green', source: 'external' },
    ],
    invitations: [{ title: 'Design sync', organizer: 'Lee', source: 'external' }],
    balances: { accounts: [{ name: 'Checking', tail: '4321', balance: 1200 }] },
    spending: { timeframe: 'W', total: 240, series: [] },
    emailPreview: { to: 'ana@x.com', subject: 'Re: Lunch?', body: 'Sure!', signature: '— P' },
    events: { count: 1, items: [{ time: '9:30', title: 'Standup' }] },
  };
}

// --- ROUT-04: mail_triage tags via helper.classify; neutral default when Ollama absent ---

test('mail_triage tags each message with a label from log/reply/open/archive (ROUT-04)', async () => {
  refuseFetch(); // Ollama absent → classify returns the neutral default (first label = 'log')
  const out = await handlers.mail_triage(baseDeps(), { labels: ['log', 'reply', 'open', 'archive'] });
  assert.ok(Array.isArray(out.tags), 'mail_triage returns a per-message tag list');
  assert.equal(out.tags.length, 2, 'one tag per message');
  for (const tag of out.tags) {
    assert.ok(['log', 'reply', 'open', 'archive'].includes(tag), 'tag is one of the offered labels');
  }
  // Neutral default with Ollama absent is the FIRST label.
  assert.ok(out.tags.every((t) => t === 'log'), 'neutral default is the first label (log) when Ollama absent');
  restoreFetch();
});

test('mail_triage never throws when Ollama is unreachable (ROUT-04, T-04-02)', async () => {
  refuseFetch();
  await assert.doesNotReject(async () => {
    await handlers.mail_triage(baseDeps(), { labels: ['log', 'reply', 'open', 'archive'] });
  }, 'mail_triage must not throw when Ollama is absent');
  restoreFetch();
});

test('mail_triage produces a mail widget plan with ≤2 items (ROUT-03/04)', async () => {
  refuseFetch();
  const out = await handlers.mail_triage(baseDeps(), { labels: ['log', 'reply', 'open', 'archive'] });
  assert.ok(out.widgetPlan.length <= 2, 'mail_triage plans ≤2 widgets');
  assert.ok(out.widgetPlan.some((w) => w.widget === 'mail'), 'mail_triage names the mail widget');
  restoreFetch();
});

// --- ROUT-05: invitation reply emits a Yellow-classified ToolCall envelope ----------------

test('invitations emits a ToolCall envelope (it never self-classifies the tier) (ROUT-05)', async () => {
  const out = await handlers.invitations(baseDeps(), {});
  assert.ok(out.toolCall, 'invitations emits a ToolCall envelope for the loop to dispatch');
  assert.equal(out.toolCall!.tool, 'mail', 'the reply routes through the mail tool');
  assert.equal(out.toolCall!.args.op, 'reply', "the op is 'reply'");
  // The handler itself must carry NO tier field — tier is the gate's job, derived centrally.
  assert.equal(
    (out.toolCall as unknown as Record<string, unknown>).tier,
    undefined,
    'the ToolCall carries no self-classified tier',
  );
});

test('the emitted invitation-reply op classifies Yellow via the shipped classifyTier (ROUT-05)', async () => {
  const out = await handlers.invitations(baseDeps(), {});
  const tier = classifyTier(out.toolCall!);
  assert.equal(tier, 'yellow', "a 'reply' op classifies yellow centrally");
});

test('a Red-shaped op classifies Red via the same central classifier (anti-self-classify)', () => {
  // Proves the engine relies on the central classifier — a destructive op would be Red.
  assert.equal(classifyTier({ tool: 'mail', args: { op: 'delete' } }), 'red');
});

test('invitations widgetPlan names the events widget for the calendar surface (ROUT-05)', async () => {
  const out = await handlers.invitations(baseDeps(), {});
  assert.ok(out.widgetPlan.length <= 2, 'invitations plans ≤2 widgets');
  assert.ok(out.widgetPlan.some((w) => w.widget === 'events'), 'invitations surfaces the events widget');
});

// --- narration-only + injected-data handlers (no live fetch) ------------------------------

test('greeting and weather are narration-only handlers (empty widgetPlan)', async () => {
  const g = await handlers.greeting(baseDeps(), {});
  const w = await handlers.weather(baseDeps(), {});
  assert.equal(g.widgetPlan.length, 0, 'greeting plans no widget');
  assert.equal(w.widgetPlan.length, 0, 'weather plans no widget');
  assert.ok(g.narration.length > 0 && w.narration.length > 0, 'both narrate');
});

test('balances/spending/email_reply name their widgets and consume injected deps (no self-fetch)', async () => {
  const b = await handlers.balances(baseDeps(), {});
  const s = await handlers.spending(baseDeps(), {});
  const e = await handlers.email_reply(baseDeps(), {});
  assert.ok(b.widgetPlan.some((w) => w.widget === 'accounts'), 'balances → accounts widget');
  assert.ok(s.widgetPlan.some((w) => w.widget === 'spending'), 'spending → spending widget');
  assert.ok(e.widgetPlan.some((w) => w.widget === 'email-preview'), 'email_reply → email-preview widget');
});
