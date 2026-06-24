/**
 * fs.test.ts (HANDS-06) — the filesystem tool's own guards: workspace-scoped writes/deletes, the
 * secret-path fence (read + write), broad reads, and the CRUD round-trips. These exercise the tool's
 * execute() directly (the gate/tier is tested separately in tiers/gate tests).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fsTool } from './fs.js';
import { config } from '../config.js';

const dir = path.join(config.workspaceDir, '__fs_test__');
const file = path.join(dir, 'note.txt');

async function cleanup(): Promise<void> {
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}

test('fs: write then read round-trips inside the workspace', async (t) => {
  t.after(cleanup);
  const w = await fsTool.execute({ op: 'write', path: file, content: 'hello kernel' });
  assert.equal(w.ok, true, JSON.stringify(w));
  const r = await fsTool.execute({ op: 'read', path: file });
  assert.equal(r.ok, true);
  assert.equal((r.data as { content?: string }).content, 'hello kernel');
});

test('fs: edit replaces text in a workspace file', async (t) => {
  t.after(cleanup);
  await fsTool.execute({ op: 'write', path: file, content: 'foo bar foo' });
  const e = await fsTool.execute({ op: 'edit', path: file, find: 'foo', replace: 'baz' });
  assert.equal(e.ok, true, JSON.stringify(e));
  const r = await fsTool.execute({ op: 'read', path: file });
  assert.equal((r.data as { content?: string }).content, 'baz bar baz');
});

test('fs: list returns workspace entries', async (t) => {
  t.after(cleanup);
  await fsTool.execute({ op: 'write', path: file, content: 'x' });
  const l = await fsTool.execute({ op: 'list', path: dir });
  assert.equal(l.ok, true);
  assert.ok((l.data as { items: Array<{ name: string }> }).items.some((i) => i.name === 'note.txt'));
});

test('fs: a write OUTSIDE the workspace is refused', async () => {
  const out = await fsTool.execute({ op: 'write', path: '/tmp/kernel-escape.txt', content: 'nope' });
  assert.equal(out.ok, false);
  assert.match(out.escalation!.reason, /workspace/i);
});

test('fs: reading a secret path is refused (credential fence)', async () => {
  const r = await fsTool.execute({ op: 'read', path: path.join(os.homedir(), '.kernel.env') });
  assert.equal(r.ok, false);
  assert.match(r.escalation!.reason, /secret|credential/i);
});

test('fs: reading a non-secret absolute path is allowed (reads are broad)', async () => {
  const r = await fsTool.execute({ op: 'read', path: '/etc/hosts' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(typeof (r.data as { content?: string }).content, 'string');
});

test('fs: delete removes a workspace file', async (t) => {
  t.after(cleanup);
  await fsTool.execute({ op: 'write', path: file, content: 'x' });
  const d = await fsTool.execute({ op: 'delete', path: file });
  assert.equal(d.ok, true, JSON.stringify(d));
  const r = await fsTool.execute({ op: 'read', path: file });
  assert.equal(r.ok, false, 'the file is gone after delete');
});

test('fs: a workspace symlink pointing at a secret is refused (canonicalized fence, audit #7)', async (t) => {
  t.after(cleanup);
  const secret = path.join(os.tmpdir(), `kfs-secret-${process.pid}.pem`);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(secret, 'PRIVATE KEY');
  const link = path.join(dir, 'innocent.txt');
  await fsp.symlink(secret, link).catch(() => {});
  const r = await fsTool.execute({ op: 'read', path: link });
  await fsp.rm(secret, { force: true });
  assert.equal(r.ok, false);
  assert.match(r.escalation!.reason, /secret|credential/i);
});

test('fs: writing through a directory symlink that escapes the workspace is refused (audit #8)', async (t) => {
  t.after(cleanup);
  const outside = path.join(os.tmpdir(), `kfs-out-${process.pid}`);
  await fsp.mkdir(outside, { recursive: true });
  await fsp.mkdir(dir, { recursive: true });
  const dlink = path.join(dir, 'up');
  await fsp.symlink(outside, dlink).catch(() => {});
  const r = await fsTool.execute({ op: 'write', path: path.join(dlink, 'escape.txt'), content: 'x' });
  await fsp.rm(outside, { recursive: true, force: true });
  assert.equal(r.ok, false);
  assert.match(r.escalation!.reason, /workspace/i);
});
