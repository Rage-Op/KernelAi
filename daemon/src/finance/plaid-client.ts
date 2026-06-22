/**
 * finance/plaid-client.ts (FIN-01 / FIN-02) — a thin, read-only wrapper over the Plaid Node SDK.
 *
 * READ-ONLY by construction: it exposes ONLY accountsBalanceGet + transactionsSync (the Balance +
 * Transactions products). There is NO write/transfer/credential path — KERNEL never types bank
 * credentials; the bank authenticates via its own OAuth (Plaid Link / Sandbox public-token
 * create), and KERNEL only ever holds a read-only access_token (kept in the Keychain or env,
 * NEVER in the kernel-memory repo).
 *
 * Test seam: __setPlaidClientForTest(mock) injects a fake client (mirrors peekaboo
 * __setClientForTest), so all automated tests run with NO live Plaid call and need no Link UI.
 * Sandbox helpers (sandboxPublicTokenCreate / itemPublicTokenExchange — confirmed present on the
 * SDK this session) are used ONLY by the optional owner integration path, never the unit lane.
 */
import pkg from 'plaid';

/** The minimal read-only Plaid surface the finance tool needs (lets tests inject a fake). */
export interface FinancePlaidClient {
  accountsBalanceGet(req: { access_token: string }): Promise<{
    accounts: Array<{
      account_id: string;
      name: string;
      type: string;
      balances: { current: number | null };
    }>;
  }>;
  transactionsSync(req: { access_token: string; cursor?: string }): Promise<{
    added: Array<{
      transaction_id: string;
      account_id: string;
      date: string;
      amount: number;
      name: string;
    }>;
    modified: unknown[];
    removed: unknown[];
    next_cursor: string;
    has_more: boolean;
  }>;
}

/** The injected test client, if any. */
let testClient: FinancePlaidClient | null = null;

/** TEST-ONLY seam: inject a mocked Plaid client (or null to reset). */
export function __setPlaidClientForTest(mock: FinancePlaidClient | null): void {
  testClient = mock;
}

/**
 * Build a real Plaid Sandbox client from env (PLAID_CLIENT_ID / PLAID_SECRET). Read-only products
 * (Balance + Transactions). Only reached on the live owner path — the unit lane uses the mock.
 * The Plaid SDK's PlaidApi response objects carry the JSON under `.data`; we unwrap to the shape
 * FinancePlaidClient declares so the tool code is identical for mock + live.
 */
function buildRealClient(): FinancePlaidClient {
  const { Configuration, PlaidApi, PlaidEnvironments } = pkg as unknown as {
    Configuration: new (cfg: unknown) => unknown;
    PlaidApi: new (cfg: unknown) => Record<string, (...a: unknown[]) => Promise<{ data: unknown }>>;
    PlaidEnvironments: Record<string, string>;
  };
  const configuration = new Configuration({
    basePath: PlaidEnvironments.sandbox,
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID ?? '',
        'PLAID-SECRET': process.env.PLAID_SECRET ?? '',
      },
    },
  });
  const api = new PlaidApi(configuration);
  return {
    async accountsBalanceGet(req) {
      const r = await api.accountsBalanceGet({ access_token: req.access_token });
      return r.data as Awaited<ReturnType<FinancePlaidClient['accountsBalanceGet']>>;
    },
    async transactionsSync(req) {
      const r = await api.transactionsSync({ access_token: req.access_token, cursor: req.cursor });
      return r.data as Awaited<ReturnType<FinancePlaidClient['transactionsSync']>>;
    },
  };
}

/** Get the active client: the injected mock if present, else a real Sandbox client. */
export function getPlaidClient(): FinancePlaidClient {
  return testClient ?? buildRealClient();
}
