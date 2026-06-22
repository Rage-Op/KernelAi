/**
 * finance.test.ts (FIN-01 / FIN-02 / FIN-05) — the registered read-only finance Tool.
 *
 * With a MOCKED Plaid client (__setPlaidClientForTest returning sandbox-shaped balance/
 * transaction payloads) the tool syncs read-only into the SQLCipher store and returns
 * widget.data-shaped payloads. It exposes ONLY read ops (balances/transactions/aggregate),
 * every one of which classifies GREEN via the shipped classifyTier (FIN-01). It has NO
 * type/fill/credential op — finance NEVER types bank credentials (FIN-02).
 *
 * No live Plaid, no real Keychain entry, no committed finance file is touched.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { financeTool, __setPlaidClientForTest, type FinancePlaidClient } from './finance.js';
import { __setSecuritySpawnForTest, type SecuritySpawn } from '../finance/keychain.js';
import { classifyTier } from '../safety/tiers.js';
import { dispatch } from './registry.js';

/** A mock keychain spawn so the tool's store-open never touches the real Keychain. */
const mockKeychain: SecuritySpawn = (() => {
  const store: Record<string, string> = {};
  return async (args: string[]) => {
    const s = args[args.indexOf('-s') + 1];
    const a = args[args.indexOf('-a') + 1];
    const k = `${s}::${a}`;
    if (args[0] === 'find-generic-password') {
      return k in store
        ? { code: 0, stdout: store[k] + '\n', stderr: '' }
        : { code: 44, stdout: '', stderr: 'not found' };
    }
    if (args[0] === 'add-generic-password') {
      store[k] = args[args.indexOf('-w') + 1];
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
})();

/** A mock Plaid client returning sandbox-shaped read-only payloads. */
function mockPlaid(): FinancePlaidClient {
  return {
    async accountsBalanceGet() {
      return {
        accounts: [
          {
            account_id: 'acc1',
            name: 'Plaid Checking',
            type: 'depository',
            balances: { current: 1234.56 },
          },
        ],
      };
    },
    async transactionsSync() {
      return {
        added: [
          { transaction_id: 'tx1', account_id: 'acc1', date: isoDaysAgo(1), amount: 12.5, name: 'Coffee' },
          { transaction_id: 'tx2', account_id: 'acc1', date: isoDaysAgo(2), amount: 40.0, name: 'Groceries' },
        ],
        modified: [],
        removed: [],
        next_cursor: 'CURSOR_DONE',
        has_more: false,
      };
    },
  };
}

function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function tmpDbPath(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-tool-test-'));
  return path.join(d, 'finance.db');
}

afterEach(() => {
  __setPlaidClientForTest(null);
  __setSecuritySpawnForTest(null);
});

test('finance tool: read ops all classify GREEN (FIN-01)', () => {
  for (const op of ['balances', 'transactions', 'aggregate']) {
    const tier = classifyTier({ tool: 'finance', args: { op } });
    assert.equal(tier, 'green', `finance op '${op}' must classify GREEN`);
  }
});

test('finance tool (FIN-02): the schema exposes NO type/fill/credential op', () => {
  // Any attempt to use a write/credential op must be rejected by the schema (no such enum value).
  for (const forbidden of ['type', 'fill', 'credential', 'login', 'password']) {
    const parsed = financeTool.schema.safeParse({ op: forbidden });
    assert.equal(parsed.success, false, `finance must NOT accept op='${forbidden}'`);
  }
});

test('finance tool: balances syncs the mocked Plaid client into the store and returns accounts widget data', async () => {
  __setSecuritySpawnForTest(mockKeychain);
  __setPlaidClientForTest(mockPlaid());
  const dbPath = tmpDbPath();

  const res = await financeTool.execute({ op: 'balances', dbPath, accessToken: 'access-sandbox-xxx' });
  assert.equal(res.ok, true);
  const data = res.data as { widget: string; data: { accounts: Array<{ name: string }> } };
  assert.equal(data.widget, 'accounts');
  assert.ok(data.data.accounts.some((a) => a.name === 'Plaid Checking'));
});

test('finance tool: aggregate returns a spending widget over the synced transactions (FIN-05)', async () => {
  __setSecuritySpawnForTest(mockKeychain);
  __setPlaidClientForTest(mockPlaid());
  const dbPath = tmpDbPath();

  // sync first (balances pulls accounts + transactions), then aggregate over the local store.
  await financeTool.execute({ op: 'balances', dbPath, accessToken: 'access-sandbox-xxx' });
  const res = await financeTool.execute({ op: 'aggregate', dbPath, timeframe: 'W', accessToken: 'access-sandbox-xxx' });
  assert.equal(res.ok, true);
  const data = res.data as { widget: string; data: { timeframe: string; total: number } };
  assert.equal(data.widget, 'spending');
  assert.equal(data.data.timeframe, 'W');
  assert.equal(Math.round(data.data.total * 100) / 100, 52.5);
});

test('finance tool: reachable through registry.dispatch and allowed (Green chokepoint)', async () => {
  __setSecuritySpawnForTest(mockKeychain);
  __setPlaidClientForTest(mockPlaid());
  const dbPath = tmpDbPath();
  // importing finance.ts self-registers the tool — dispatch runs gate.authorize first.
  const res = await dispatch({ tool: 'finance', args: { op: 'balances', dbPath, accessToken: 'access-sandbox-xxx' } });
  assert.equal(res.ok, true, 'a Green finance read must pass the gate via dispatch');
});
