/**
 * keychain.test.ts (FIN-03) — the `security` CLI wrapper.
 *
 * getOrCreateKeychainKey(service, account) reads the SQLCipher DB key from the macOS Keychain
 * via the `security` CLI (find-generic-password -w); on a miss it generates a random key and
 * persists it (add-generic-password -U). The plaintext key NEVER touches a file or the memory
 * repo. The spawn is MOCKED here (mirrors ClaudeCodeBrain.__setRunnerForTest) so unit tests
 * never write a real Keychain entry. Absent-tolerant: a spawn failure surfaces a TYPED result,
 * never a throw.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  getOrCreateKeychainKey,
  __setSecuritySpawnForTest,
  type SecuritySpawn,
  type SecurityResult,
} from './keychain.js';

afterEach(() => __setSecuritySpawnForTest(null));

/** A mock `security` CLI: a tiny in-memory keychain keyed by `-s <service> -a <account>`. */
function mockSecurity(initial: Record<string, string> = {}): {
  spawn: SecuritySpawn;
  store: Record<string, string>;
  calls: string[][];
} {
  const store = { ...initial };
  const calls: string[][] = [];
  const keyOf = (args: string[]) => {
    const s = args[args.indexOf('-s') + 1];
    const a = args[args.indexOf('-a') + 1];
    return `${s}::${a}`;
  };
  const spawn: SecuritySpawn = async (args: string[]): Promise<SecurityResult> => {
    calls.push(args);
    const sub = args[0];
    const k = keyOf(args);
    if (sub === 'find-generic-password') {
      if (k in store) return { code: 0, stdout: store[k] + '\n', stderr: '' };
      // security exits non-zero when the item is absent.
      return { code: 44, stdout: '', stderr: 'SecKeychainSearchCopyNext: The item cannot be found.' };
    }
    if (sub === 'add-generic-password') {
      const w = args[args.indexOf('-w') + 1];
      store[k] = w;
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: `unexpected security subcommand: ${sub}` };
  };
  return { spawn, store, calls };
}

test('getOrCreateKeychainKey: existing key is read back unchanged (find-generic-password -w)', async () => {
  const m = mockSecurity({ 'com.kernel.finance::db-key': 'EXISTING_KEY_ABC' });
  __setSecuritySpawnForTest(m.spawn);
  const res = await getOrCreateKeychainKey('com.kernel.finance', 'db-key');
  assert.equal(res.ok, true);
  assert.equal(res.key, 'EXISTING_KEY_ABC');
  // it must have used find-generic-password with -w (output the password to stdout).
  const findCall = m.calls.find((c) => c[0] === 'find-generic-password');
  assert.ok(findCall && findCall.includes('-w'), 'find-generic-password -w must be invoked');
});

test('getOrCreateKeychainKey: a missing key is generated then added, then read-stable', async () => {
  const m = mockSecurity(); // empty keychain
  __setSecuritySpawnForTest(m.spawn);

  const first = await getOrCreateKeychainKey('com.kernel.finance', 'db-key');
  assert.equal(first.ok, true);
  assert.ok(first.key.length >= 32, 'a generated key must be sufficiently long/random');

  // add-generic-password -U must have been called to persist it.
  const addCall = m.calls.find((c) => c[0] === 'add-generic-password');
  assert.ok(addCall && addCall.includes('-U'), 'add-generic-password -U must persist on a miss');

  // a second call now finds the persisted key — stable round-trip.
  const second = await getOrCreateKeychainKey('com.kernel.finance', 'db-key');
  assert.equal(second.key, first.key, 'the key must be stable across calls (round-trip)');
});

test('getOrCreateKeychainKey: absent-tolerant — a spawn failure returns a typed result, never throws', async () => {
  const failing: SecuritySpawn = async () => {
    throw new Error('ENOENT: security not on PATH');
  };
  __setSecuritySpawnForTest(failing);
  // must NOT throw — a typed { ok:false } is returned.
  const res = await getOrCreateKeychainKey('com.kernel.finance', 'db-key');
  assert.equal(res.ok, false);
  assert.match(res.reason ?? '', /security|spawn|ENOENT/i);
});

test('getOrCreateKeychainKey: the plaintext key is never the literal service/account (sanity)', async () => {
  const m = mockSecurity();
  __setSecuritySpawnForTest(m.spawn);
  const res = await getOrCreateKeychainKey('com.kernel.finance', 'db-key');
  assert.notEqual(res.key, 'com.kernel.finance');
  assert.notEqual(res.key, 'db-key');
});
