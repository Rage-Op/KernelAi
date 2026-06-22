/**
 * finance/store.ts (FIN-03 / FIN-04c / FIN-05) — the SQLCipher-encrypted finance store.
 *
 * Opens kernel-memory/finance/finance.db with the DB key (read from the Keychain by the caller
 * via keychain.ts) using better-sqlite3-multiple-ciphers (SQLCipher AES-256). The store holds
 * accounts + transactions and computes W/M/Y spending aggregates locally with SQL date bucketing.
 *
 * Layer (c) of the 4-layer finance-leak stack: data is encrypted at rest. A wrong-key open fails
 * on first read; the raw file bytes are ciphertext (no plaintext memo). This module proves (c).
 *
 * Hard invariants (ASVS V6/V7, threats T-04-07/08/11):
 *   - SQLCipher AES-256 via the standard pragma (cipher_compatibility=4) — NEVER hand-rolled crypto.
 *   - the key is NEVER logged or written to disk by this module.
 *   - finance amounts/memos are NEVER logged.
 *   - Plaid-sourced memos/payees are stored as DATA only (source:external) — never instruction.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';

/** A normalized account row (Plaid balance payloads map onto this). */
export interface AccountRow {
  id: string;
  name: string;
  type: string;
  balance: number;
}

/** A normalized transaction row. `amount<0` is spending; `posted` is YYYY-MM-DD. */
export interface TransactionRow {
  id: string;
  accountId: string;
  posted: string;
  amount: number;
  /** External-sourced memo/payee text — DATA only, never an instruction. */
  memo: string;
}

export type Timeframe = 'W' | 'M' | 'Y';

/** A W/M/Y aggregate: the spending total + a per-day series over the window. */
export interface SpendingAggregate {
  timeframe: Timeframe;
  total: number;
  series: Array<{ day: string; spent: number }>;
}

/** The store handle — synchronous (better-sqlite3 is sync; ideal for the single-process daemon). */
export interface FinanceStore {
  upsertAccount(a: AccountRow): void;
  upsertTransaction(t: TransactionRow): void;
  listAccounts(): AccountRow[];
  listTransactions(): TransactionRow[];
  aggregate(timeframe: Timeframe): SpendingAggregate;
  close(): void;
}

/** SQLite date('now', ?) offset per timeframe. */
const WINDOW: Record<Timeframe, string> = {
  W: '-7 days',
  M: '-1 month',
  Y: '-1 year',
};

/**
 * A SQLCipher key must be safe to interpolate into the `key = '...'` pragma. We accept only a
 * hex/base64url-ish key (no quotes/backslashes) — keychain.ts generates 64-char hex. This guards
 * the one unavoidable string-pragma interpolation against injection.
 */
function assertSafeKey(key: string): void {
  if (!/^[A-Za-z0-9+/_=-]{16,}$/.test(key)) {
    throw new Error('finance store: refusing an unsafe DB key shape');
  }
}

/**
 * Open (or create) the encrypted store at `dbPath` with `key`. Creates the schema on first open.
 * The directory is created if absent (it is gitignored — layer a).
 */
export function openStore(dbPath: string, key: string): FinanceStore {
  assertSafeKey(key);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  // SQLCipher: key the DB at open (AES-256), SQLCipher-4 page format.
  db.pragma(`key = '${key}'`);
  db.pragma('cipher_compatibility = 4');

  // Schema (idempotent). Creating a table forces a write that validates the key on a reopen.
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id      TEXT PRIMARY KEY,
      name    TEXT NOT NULL,
      type    TEXT NOT NULL,
      balance REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id        TEXT PRIMARY KEY,
      accountId TEXT NOT NULL,
      posted    TEXT NOT NULL,
      amount    REAL NOT NULL,
      memo      TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_tx_posted ON transactions(posted);
  `);

  const upsertAccountStmt = db.prepare(
    `INSERT INTO accounts (id, name, type, balance) VALUES (@id, @name, @type, @balance)
     ON CONFLICT(id) DO UPDATE SET name=@name, type=@type, balance=@balance`,
  );
  const upsertTxStmt = db.prepare(
    `INSERT INTO transactions (id, accountId, posted, amount, memo)
       VALUES (@id, @accountId, @posted, @amount, @memo)
     ON CONFLICT(id) DO UPDATE SET accountId=@accountId, posted=@posted, amount=@amount, memo=@memo`,
  );

  return {
    upsertAccount(a) {
      upsertAccountStmt.run(a as unknown as Record<string, unknown>);
    },
    upsertTransaction(t) {
      upsertTxStmt.run({ memo: '', ...t } as unknown as Record<string, unknown>);
    },
    listAccounts() {
      return db.prepare('SELECT id, name, type, balance FROM accounts ORDER BY id').all() as AccountRow[];
    },
    listTransactions() {
      return db
        .prepare('SELECT id, accountId, posted, amount, memo FROM transactions ORDER BY posted')
        .all() as TransactionRow[];
    },
    aggregate(timeframe) {
      const since = WINDOW[timeframe];
      // Spending only (amount<0); SUM the magnitude per day over the window. Income is excluded.
      const rows = db
        .prepare(
          `SELECT posted AS day, SUM(-amount) AS spent
             FROM transactions
            WHERE amount < 0 AND posted >= date('now', ?)
            GROUP BY posted
            ORDER BY posted`,
        )
        .all(since) as Array<{ day: string; spent: number }>;
      const total = rows.reduce((sum, r) => sum + r.spent, 0);
      return { timeframe, total, series: rows };
    },
    close() {
      db.close();
    },
  };
}
