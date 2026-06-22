/**
 * peekaboo.test.ts — the Peekaboo adapter unit lane (HANDS-01, HANDS-02, HANDS-05).
 *
 * MOCKED MCP transport — no real Peekaboo server, no TCC (RESEARCH.md Validation Architecture:
 * this is the unit lane; real Mail open/drive + the fence on a real secure field are documented
 * MANUAL owner checks, not run here). Every assertion drives the tool THROUGH `registry.dispatch`
 * (not by calling `execute` directly) so the gate path — and the credential fence — is exercised.
 *
 * Covered behaviors:
 *   (a) op→callTool mapping: a `click` reaches the mocked `callTool` with the discovered tool name;
 *   (b) runtime discovery: `discover()` returns the mocked `listTools()` payload (no hardcoded schema);
 *   (c) external tagging: a `see` result is surfaced with `source:'external'` (Provenance shape);
 *   (d) fence (HANDS-05): a derived-secure `type` is DENIED and `callTool` is NEVER invoked;
 *   (e) allowed type: a non-secret `type` (To field) reaches the mocked `callTool`;
 *   (f) TCC failure: a thrown transport error escalates structurally — execute does NOT throw.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { register, dispatch, clearRegistry } from './registry.js';
import {
  peekabooTool,
  discover,
  callPeekaboo,
  __setClientForTest,
  type PeekabooClient,
} from './peekaboo.js';

/** The discovered tool catalog the live server would return — kept a FIXTURE so "discovery, not
 * hardcoding" is assertable (the adapter must read this, not a literal). Mirrors the real
 * `tools/list` names confirmed against Peekaboo 3.5.2. */
const LIST_TOOLS_FIXTURE = {
  tools: [
    { name: 'see', inputSchema: { type: 'object', properties: { app_target: {}, annotate: {} } } },
    { name: 'image', inputSchema: { type: 'object', properties: { app_target: {}, format: {} } } },
    { name: 'click', inputSchema: { type: 'object', properties: { on: {}, query: {} } } },
    { name: 'type', inputSchema: { type: 'object', properties: { text: {}, on: {} } } },
    { name: 'menu', inputSchema: { type: 'object', properties: { action: {}, path: {} } } },
    { name: 'list', inputSchema: { type: 'object', properties: { item_type: {}, app: {} } } },
    { name: 'app', inputSchema: { type: 'object', properties: { action: {}, name: {} } } },
  ],
};

/** A mock MCP client recording every callTool invocation and returning canned content. */
function mockClient(opts: { throwOnCall?: boolean } = {}): {
  client: PeekabooClient;
  calls: Array<{ name: string; arguments: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const client: PeekabooClient = {
    async listTools() {
      return LIST_TOOLS_FIXTURE;
    },
    async callTool(req) {
      calls.push({ name: req.name, arguments: req.arguments });
      if (opts.throwOnCall) {
        throw new Error('peekaboo permission denied: Accessibility not granted');
      }
      return { content: [{ type: 'text', text: `ok:${req.name}` }] };
    },
  };
  return { client, calls };
}

beforeEach(() => {
  // Start from a known registry; importing peekaboo.ts self-registers the tool, but clearRegistry
  // wipes it, so re-register explicitly for a deterministic dispatch path.
  clearRegistry();
  register(peekabooTool);
});

afterEach(() => {
  __setClientForTest(null);
});

test('peekaboo: discover() reads the mocked listTools payload (runtime discovery, not hardcoded)', async () => {
  const { client } = mockClient();
  __setClientForTest(client);

  const result = await discover();

  assert.deepEqual(result, LIST_TOOLS_FIXTURE, 'discover() returns the live server tool catalog');
  const names = result.tools.map((t) => t.name);
  assert.ok(names.includes('type') && names.includes('click'), 'the adapter reads the mock, not a literal');
});

test('peekaboo: op→callTool mapping — a click reaches the mocked callTool via dispatch', async () => {
  const { client, calls } = mockClient();
  __setClientForTest(client);

  const result = await dispatch({ tool: 'peekaboo', args: { op: 'click', on: 'el-42' } });

  assert.equal(result.ok, true, 'a green click is allowed and reaches execute');
  assert.equal(calls.length, 1, 'callTool was invoked exactly once');
  assert.equal(calls[0].name, 'click', 'op "click" maps to the discovered "click" tool name');
  assert.deepEqual(calls[0].arguments, { on: 'el-42' }, 'the op envelope key is stripped; runtime args forwarded');
  assert.deepEqual(result.data, { content: [{ type: 'text', text: 'ok:click' }] }, 'callTool content surfaced as data');
});

test('peekaboo: a see result is tagged source:external (Provenance shape)', async () => {
  const { client } = mockClient();
  __setClientForTest(client);

  const result = await dispatch({ tool: 'peekaboo', args: { op: 'see', app_target: 'Mail' } });

  assert.equal(result.ok, true);
  const data = result.data as { source?: string; text?: string; origin?: string };
  assert.equal(data.source, 'external', 'captured GUI content is external-sourced (tainted at the read site)');
  assert.equal(data.origin, 'peekaboo:see', 'origin records the read source');
  assert.match(data.text ?? '', /ok:see/, 'the captured payload is carried in the ContextItem text');
});

test('peekaboo: FENCE (HANDS-05) — a derived-secure type is DENIED and callTool is never invoked', async () => {
  const { client, calls } = mockClient();
  __setClientForTest(client);

  const result = await dispatch({
    tool: 'peekaboo',
    args: { op: 'type', text: 'hunter2', fieldLabel: 'Password', isSecureField: true },
  });

  assert.equal(result.ok, false, 'a secure-field type is refused by the gate');
  assert.match(
    result.escalation?.reason ?? '',
    /secure\/credential field/,
    'the credential-fence escalation is surfaced',
  );
  assert.equal(calls.length, 0, 'callTool was NEVER reached — the gate denied before any keystroke');
});

test('peekaboo: a non-secret type (To field) passes the fence and reaches callTool', async () => {
  const { client, calls } = mockClient();
  __setClientForTest(client);

  const result = await dispatch({
    tool: 'peekaboo',
    args: { op: 'type', text: 'alice@example.com', fieldLabel: 'To' },
  });

  assert.equal(result.ok, true, 'a non-secret field passes the fence (Yellow → allow)');
  assert.equal(calls.length, 1, 'callTool was invoked');
  assert.equal(calls[0].name, 'type', 'op "type" maps to the discovered "type" tool');
  assert.deepEqual(calls[0].arguments, { text: 'alice@example.com' }, 'fence signals stripped; only Peekaboo args forwarded');
});

test('peekaboo: TCC failure — a thrown transport error escalates structurally without crashing', async () => {
  const { client, calls } = mockClient({ throwOnCall: true });
  __setClientForTest(client);

  const result = await dispatch({ tool: 'peekaboo', args: { op: 'click', on: 'el-1' } });

  assert.equal(result.ok, false, 'a transport failure returns ok:false (does not throw)');
  assert.match(result.escalation?.reason ?? '', /peekaboo click failed/, 'structured escalation reason');
  assert.match(
    result.escalation?.recommendation ?? '',
    /Accessibility|Screen Recording|Peekaboo/,
    'escalation recommends granting the TCC permissions (probe-then-escalate)',
  );
  assert.equal(calls.length, 1, 'the op was attempted once, then the failure was caught');
});

test('peekaboo: callPeekaboo forwards name + arguments to the mocked client', async () => {
  const { client, calls } = mockClient();
  __setClientForTest(client);

  await callPeekaboo('list', { item_type: 'running_applications' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'list');
  assert.deepEqual(calls[0].arguments, { item_type: 'running_applications' });
});
