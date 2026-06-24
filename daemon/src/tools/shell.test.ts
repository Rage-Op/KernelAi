/**
 * shell.test.ts (HANDS-06) — the shell tool's own guards: it runs a command and returns output,
 * surfaces a non-zero exit as a normal result, refuses catastrophic commands outright, and runs the
 * child with a SECRET-STRIPPED env so a command cannot exfiltrate the owner's keys.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shellTool } from './shell.js';

test('shell: runs a read-only command and returns stdout + exit 0', async () => {
  const r = await shellTool.execute({ op: 'exec', command: 'echo hello-kernel', cwd: '/tmp' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const d = r.data as { exitCode: number; stdout: string };
  assert.equal(d.exitCode, 0);
  assert.match(d.stdout, /hello-kernel/);
});

test('shell: a non-zero exit is returned as a normal result with its code', async () => {
  const r = await shellTool.execute({ op: 'exec', command: 'exit 3', cwd: '/tmp' });
  assert.equal(r.ok, true);
  assert.equal((r.data as { exitCode: number }).exitCode, 3);
});

test('shell: refuses a catastrophic command outright (never runs)', async () => {
  const r = await shellTool.execute({ op: 'exec', command: 'sudo rm -rf /', cwd: '/tmp' });
  assert.equal(r.ok, false);
  assert.match(r.escalation!.reason, /catastrophic/i);
});

test('shell: the child env strips secret-looking variables (no key exfiltration)', async () => {
  process.env.FAKE_API_KEY = 'super-secret-value';
  process.env.SAFE_VAR = 'ok';
  try {
    const r = await shellTool.execute({ op: 'exec', command: 'echo "k=$FAKE_API_KEY safe=$SAFE_VAR"', cwd: '/tmp' });
    const out = (r.data as { stdout: string }).stdout;
    assert.doesNotMatch(out, /super-secret-value/, 'a secret-looking var is stripped from the child env');
    assert.match(out, /safe=ok/, 'a non-secret var still passes through');
  } finally {
    delete process.env.FAKE_API_KEY;
    delete process.env.SAFE_VAR;
  }
});
