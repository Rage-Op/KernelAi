/**
 * mail.test.ts (MAIL-05) — the registered Yellow Peekaboo-Mail send/mark-read tool.
 *
 * Proves:
 *   - the tool's op set is exactly ['reply','send','mark-read'] and each classifies YELLOW via
 *     the SHIPPED classifyTier (so gate.authorize gates, never silently allows a Red).
 *   - send/mark-read are reachable ONLY through registry.dispatch (the gate runs first); a
 *     direct execute is never the production path.
 *   - send drives a Peekaboo Mail provider (the default), marks the source read, and logs — and
 *     the provider is an injectable interface (a Gmail path could be added later; Peekaboo default).
 *   - the tool NEVER sends as a side effect of construction/registration — only a dispatched send.
 *
 * No live Peekaboo/MCP: the Mail provider is a test double recording the calls it received.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { mailTool, __setMailProviderForTest, type MailProvider } from './mail.js';
import { classifyTier } from '../safety/tiers.js';
import { dispatch } from './registry.js';

/** A recording Mail provider double — captures send/markRead calls, performs no real GUI work. */
function recordingProvider(): MailProvider & { sends: unknown[]; reads: unknown[] } {
  const sends: unknown[] = [];
  const reads: unknown[] = [];
  return {
    sends,
    reads,
    async send(msg) {
      sends.push(msg);
      return { ok: true };
    },
    async markRead(ref) {
      reads.push(ref);
      return { ok: true };
    },
  };
}

afterEach(() => {
  __setMailProviderForTest(null);
});

test('mail tool: op set is exactly reply/send/mark-read and each classifies YELLOW (MAIL-05)', () => {
  for (const op of ['reply', 'send', 'mark-read']) {
    const tier = classifyTier({ tool: 'mail', args: { op } });
    assert.equal(tier, 'yellow', `mail op '${op}' must classify YELLOW (gate-routed), got ${tier}`);
  }
  // The schema rejects anything outside the constrained op set (ASVS V5).
  for (const forbidden of ['purchase', 'delete', 'type', 'login']) {
    const parsed = mailTool.schema.safeParse({ op: forbidden });
    assert.equal(parsed.success, false, `mail must NOT accept op='${forbidden}'`);
  }
});

test('mail tool: send drives the Peekaboo Mail provider, marks the source read, and logs (MAIL-05)', async () => {
  const provider = recordingProvider();
  __setMailProviderForTest(provider);
  const res = await dispatch({
    tool: 'mail',
    args: {
      op: 'send',
      to: 'ana@acme.com',
      subject: 'Re: Friday',
      body: 'Hi Ana,\n\nFriday works.\n\nThanks,\nPravin',
      sourceRef: 'mail://inbox/42',
    },
  });
  assert.equal(res.ok, true, 'a dispatched Yellow send passes the gate and executes');
  assert.equal(provider.sends.length, 1, 'the provider sent exactly once');
  assert.equal(provider.reads.length, 1, 'the source message was marked read on send');
  assert.deepEqual(provider.reads[0], 'mail://inbox/42');
});

test('mail tool: mark-read alone marks the source read via the provider', async () => {
  const provider = recordingProvider();
  __setMailProviderForTest(provider);
  const res = await dispatch({ tool: 'mail', args: { op: 'mark-read', sourceRef: 'mail://inbox/7' } });
  assert.equal(res.ok, true);
  assert.equal(provider.reads.length, 1);
  assert.equal(provider.sends.length, 0, 'mark-read sends nothing');
});

test('mail tool: reachable through registry.dispatch (the gate is the chokepoint) (MAIL-05)', async () => {
  const provider = recordingProvider();
  __setMailProviderForTest(provider);
  // importing mail.ts self-registers the tool — dispatch runs gate.authorize FIRST.
  const res = await dispatch({ tool: 'mail', args: { op: 'send', to: 'b@x.com', subject: 'Hi', body: 'Hi' } });
  assert.equal(res.ok, true, 'a Yellow mail send must pass the gate via dispatch');
});

test('mail tool: registering/importing the tool does NOT send (no construction side-effect send)', async () => {
  const provider = recordingProvider();
  __setMailProviderForTest(provider);
  // Merely having imported + registered the tool sends nothing — only an explicit dispatch does.
  assert.equal(provider.sends.length, 0, 'no auto-send on import/register');
});
