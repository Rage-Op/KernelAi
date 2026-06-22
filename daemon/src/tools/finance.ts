/**
 * tools/finance.ts (FIN-01 / FIN-02 / FIN-05) — the registered READ-ONLY finance Tool.
 *
 * The brain references this via ToolCall.tool='finance'. Its schema constrains `op` to the
 * read-only set ['balances','transactions','aggregate'] so the shipped classifyTier yields GREEN
 * and gate.authorize allows it (FIN-01). There is NO type/fill/credential op — so no
 * credential-entry surface ever exists in the finance flow (FIN-02). KERNEL never types bank
 * credentials.
 *
 * execute() syncs the mocked/live Plaid client read-only into the SQLCipher store (key from the
 * Keychain) and returns widget.data-shaped payloads:
 *   - balances    → { widget:'accounts', data:{ accounts:[...] } }
 *   - transactions→ { widget:'accounts', data:{ accounts:[...], transactions:[...] } }
 *   - aggregate   → { widget:'spending', data:{ timeframe, total, series } }
 *
 * ANTI-BYPASS: execute is only ever reached via registry.dispatch (after gate.authorize).
 * Importing this module self-registers the tool (module-init side effect), mirroring peekaboo.
 *
 * Logging (ASVS V7, T-04-11): pino logs the SYNC EVENT only — never amounts, the DB key, or the
 * access_token. Plaid memos/payees are stored as DATA (source:external), never instruction.
 */
import { z } from 'zod';

import { register } from './registry.js';
import type { Tool, ToolResult } from './Tool.js';
import { logger } from '../memory/log.js';
import { config } from '../config.js';
import { getOrCreateKeychainKey } from '../finance/keychain.js';
import { getPlaidClient } from '../finance/plaid-client.js';
import { openStore, type FinanceStore, type Timeframe } from '../finance/store.js';

// Re-export the test seam so finance.test.ts can inject a mock Plaid client.
export { __setPlaidClientForTest, type FinancePlaidClient } from '../finance/plaid-client.js';

/** Keychain service/account labels for the DB key (T-04-08: key lives only in the Keychain). */
const KEYCHAIN_SERVICE = 'com.kernel.finance';
const KEYCHAIN_ACCOUNT = 'db-key';

/**
 * The finance op envelope. READ-ONLY by construction: the enum has NO write/credential op. Any
 * `op:'type'|'fill'|'login'|...` fails the schema (ASVS V5) — the credential surface cannot exist.
 */
export const financeArgsSchema = z
  .object({
    op: z.enum(['balances', 'transactions', 'aggregate']),
    timeframe: z.enum(['W', 'M', 'Y']).optional(),
    /** Read-only Plaid access_token (Keychain/env on the live path; passed explicitly in tests). */
    accessToken: z.string().optional(),
    /** Override the DB path (tests use a tmpdir; production defaults to the memory repo). */
    dbPath: z.string().optional(),
  })
  .strict(); // reject ANY unknown key — no smuggling a credential field in.

type FinanceArgs = z.infer<typeof financeArgsSchema>;

/** Default store path: kernel-memory/finance/finance.db (gitignored — layer a). */
function defaultDbPath(): string {
  return `${config.memoryDir}/finance/finance.db`;
}

/** Open the encrypted store with the Keychain-held key. Returns a typed escalation on key failure. */
async function openFinanceStore(dbPath: string): Promise<{ store: FinanceStore } | { escalation: string }> {
  const keyResult = await getOrCreateKeychainKey(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
  if (!keyResult.ok) {
    return { escalation: `finance store unavailable: ${keyResult.reason ?? 'keychain error'}` };
  }
  return { store: openStore(dbPath, keyResult.key) };
}

/**
 * Read-only Plaid → store sync. Pulls balances + transactions and upserts them. Never writes to
 * Plaid. The access_token is read (never logged); amounts/memos are stored, never logged.
 */
async function syncFromPlaid(store: FinanceStore, accessToken: string): Promise<void> {
  const plaid = getPlaidClient();

  const balanceResp = await plaid.accountsBalanceGet({ access_token: accessToken });
  for (const a of balanceResp.accounts) {
    store.upsertAccount({
      id: a.account_id,
      name: a.name,
      type: a.type,
      balance: a.balances.current ?? 0,
    });
  }

  // /transactions/sync cursor loop (read-only). Plaid `amount` is positive for spending; our
  // store convention is amount<0 = spending, so negate.
  let cursor: string | undefined = undefined;
  for (let guard = 0; guard < 50; guard++) {
    const tx = await plaid.transactionsSync({ access_token: accessToken, cursor });
    for (const t of tx.added) {
      store.upsertTransaction({
        id: t.transaction_id,
        accountId: t.account_id,
        posted: t.date,
        amount: -t.amount,
        memo: t.name, // external-sourced payee/memo — DATA only.
      });
    }
    if (!tx.has_more) break;
    cursor = tx.next_cursor;
  }
  logger.info({ tool: 'finance', event: 'sync' }, 'finance: read-only Plaid sync complete');
}

/** The registered read-only finance Tool. */
export const financeTool: Tool = {
  name: 'finance',
  schema: financeArgsSchema,
  async execute(args): Promise<ToolResult> {
    const a = args as FinanceArgs;
    const dbPath = a.dbPath ?? defaultDbPath();

    const opened = await openFinanceStore(dbPath);
    if ('escalation' in opened) {
      return { ok: false, escalation: { reason: opened.escalation } };
    }
    const store = opened.store;

    try {
      const accessToken = a.accessToken ?? process.env.PLAID_ACCESS_TOKEN ?? '';

      if (a.op === 'balances' || a.op === 'transactions') {
        if (accessToken) {
          await syncFromPlaid(store, accessToken);
        }
        const accounts = store.listAccounts();
        if (a.op === 'transactions') {
          return {
            ok: true,
            data: { widget: 'accounts', data: { accounts, transactions: store.listTransactions() } },
          };
        }
        return { ok: true, data: { widget: 'accounts', data: { accounts } } };
      }

      // aggregate: compute W/M/Y locally over the encrypted store (no network).
      const timeframe: Timeframe = a.timeframe ?? 'M';
      const agg = store.aggregate(timeframe);
      return { ok: true, data: { widget: 'spending', data: agg } };
    } catch (err) {
      // never log amounts; surface a structured escalation, never crash the loop.
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ tool: 'finance', op: a.op }, 'finance: op failed — escalating');
      return { ok: false, escalation: { reason: `finance ${a.op} failed: ${reason}` } };
    } finally {
      store.close();
    }
  },
};

// Module-init side effect: importing this tool wires it into the router (HANDS-04).
register(financeTool);
