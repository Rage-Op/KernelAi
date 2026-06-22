import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';

import { quarantineWrite } from './quarantine.js';

/** Create a throwaway memory dir with the working-memory/quarantine/ bucket. */
function makeMemoryDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-quarantine-'));
  fs.mkdirSync(path.join(dir, 'working-memory', 'quarantine'), { recursive: true });
  return dir;
}

test('quarantineWrite lands a file under working-memory/quarantine/', () => {
  const dir = makeMemoryDir();
  const written = quarantineWrite(
    { text: 'untrusted email body', origin: 'email:2026-06-22 from x@y.com' },
    dir,
  );

  const quarantineDir = path.join(dir, 'working-memory', 'quarantine');
  assert.ok(written.startsWith(quarantineDir + path.sep), 'file must live inside quarantine/');
  assert.equal(fs.existsSync(written), true, 'the file was actually written');
});

test('quarantined file carries source: external front-matter + origin + body', () => {
  const dir = makeMemoryDir();
  const written = quarantineWrite(
    { text: 'the untrusted body text', origin: 'web:https://evil.example' },
    dir,
  );

  const parsed = matter(fs.readFileSync(written, 'utf8'));
  assert.equal(parsed.data.source, 'external', 'quarantine content is always source: external');
  assert.equal(parsed.data.origin, 'web:https://evil.example');
  assert.match(parsed.content, /the untrusted body text/, 'body text is preserved');
});

test('quarantineWrite works without an origin', () => {
  const dir = makeMemoryDir();
  const written = quarantineWrite({ text: 'no origin given' }, dir);
  const parsed = matter(fs.readFileSync(written, 'utf8'));
  assert.equal(parsed.data.source, 'external');
  assert.match(parsed.content, /no origin given/);
});

test('two quarantine writes produce distinct files (no collision)', () => {
  const dir = makeMemoryDir();
  const a = quarantineWrite({ text: 'first' }, dir);
  const b = quarantineWrite({ text: 'second' }, dir);
  assert.notEqual(a, b, 'each write gets a unique filename');
});
