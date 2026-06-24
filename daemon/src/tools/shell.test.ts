/**
 * shell.test.ts (HANDS-06) — the shell tool's own guards (audit-hardened): run a command + return
 * output, surface a non-zero exit, refuse catastrophic commands AND any command that touches a secret
 * path, run the child with an ALLOWLIST env (no key exfiltration), and redact secret-shaped output.
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

test('shell: refuses catastrophic commands outright (never runs)', async () => {
  for (const command of ['sudo rm -rf /', 'find / -delete', 'bash -c "rm -rf /"', "osascript -e 'do shell script \"x\" with administrator privileges'"]) {
    const r = await shellTool.execute({ op: 'exec', command, cwd: '/tmp' });
    assert.equal(r.ok, false, command);
    assert.match(r.escalation!.reason, /catastrophic/i, command);
  }
});

test('shell: refuses a command that references a secret path (cat ~/.kernel.env)', async () => {
  for (const command of ['cat ~/.kernel.env', 'cat ~/.ssh/id_rsa', 'openssl base64 -in ~/.kernel.env']) {
    const r = await shellTool.execute({ op: 'exec', command, cwd: '/tmp' });
    assert.equal(r.ok, false, command);
    assert.match(r.escalation!.reason, /secret|credential/i, command);
  }
});

test('shell: the child env is an ALLOWLIST — secret-named/valued vars never reach the child', async () => {
  process.env.FAKE_API_KEY = 'super-secret-value';
  process.env.DATABASE_URL = 'postgres://u:p@h/db';
  try {
    const r = await shellTool.execute({ op: 'exec', command: 'echo "k=$FAKE_API_KEY db=$DATABASE_URL home=$HOME"', cwd: '/tmp' });
    const out = (r.data as { stdout: string }).stdout;
    assert.doesNotMatch(out, /super-secret-value/, 'secret-named var dropped');
    assert.doesNotMatch(out, /postgres:\/\//, 'secret-valued var dropped');
    assert.match(out, /home=\//, 'an allowlisted var (HOME) still passes through');
  } finally {
    delete process.env.FAKE_API_KEY;
    delete process.env.DATABASE_URL;
  }
});

test('shell: secret-shaped values are redacted from stdout before reaching the model', async () => {
  const r = await shellTool.execute({ op: 'exec', command: 'echo "leak ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 done"', cwd: '/tmp' });
  const out = (r.data as { stdout: string }).stdout;
  assert.match(out, /\[redacted-secret\]/, 'token redacted');
  assert.doesNotMatch(out, /ghp_ABCDEFGH/, 'raw token never reaches the model');
});
