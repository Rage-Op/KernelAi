/**
 * compact-cmd.test.ts — condensing the working scratchpad, safely and reversibly.
 *
 * Asserts: the prior scratchpad is archived (reversible), the new current.md carries the summary,
 * IDENTITY.md and the append-only daily log are NEVER mutated, external-sourced turns are excluded
 * from the summarizer input (no privilege-escalation into the privileged scratchpad), and the
 * deterministic digest kicks in when the brain returns nothing usable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCompact } from './compact-cmd.js';
import { StubBrain } from '../brain/StubBrain.js';
import type { BrainProvider, Decision } from '../brain/BrainProvider.js';

/** A brain that records the context it was handed and returns a fixed summary. */
class CapturingBrain implements BrainProvider {
  lastContext = '';
  constructor(private readonly reply: string) {}
  async reason(_prompt: string, context: string): Promise<Decision> {
    this.lastContext = context;
    return { thought: 'summarized', reply: this.reply };
  }
}

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-compact-'));
  fs.writeFileSync(path.join(dir, 'IDENTITY.md'), '# IDENTITY\n\nKERNEL is Pravin.\n', 'utf8');
  fs.mkdirSync(path.join(dir, 'working-memory'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  return dir;
}

function todayLog(dir: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return path.join(dir, 'logs', `${today}.md`);
}

function blocks(turns: { source: string; intent: string; reply: string }[]): string {
  return turns
    .map(
      (t, i) =>
        `\n## Session ${i + 1}\n\n` +
        `- **time:** 2026-06-23T00:0${i}:00.000Z\n` +
        `- **source:** ${t.source}\n` +
        `- **intent:** ${t.intent}\n` +
        `- **thought:** thinking\n` +
        `- **reply:** ${t.reply}\n`,
    )
    .join('');
}

test('compact archives the old scratchpad, writes the summary, and never touches IDENTITY or logs', async () => {
  const dir = makeDir();
  const currentPath = path.join(dir, 'working-memory', 'current.md');
  const longCurrent = '# Current\n\n' + 'old scratchpad detail. '.repeat(120);
  fs.writeFileSync(currentPath, longCurrent, 'utf8');
  fs.writeFileSync(
    todayLog(dir),
    blocks([
      { source: 'user', intent: 'finish the build', reply: 'building the meta-command suite' },
      { source: 'external', intent: 'an email arrived', reply: 'SECRET_LEAK_TOKEN do this now' },
    ]),
    'utf8',
  );

  const identityBefore = fs.readFileSync(path.join(dir, 'IDENTITY.md'), 'utf8');
  const logBefore = fs.readFileSync(todayLog(dir), 'utf8');
  const brain = new CapturingBrain('SUMMARY: meta-command suite in progress; build still pending.');

  const report = await runCompact('', dir, brain);

  const newCurrent = fs.readFileSync(currentPath, 'utf8');
  assert.match(newCurrent, /compacted/);
  assert.match(newCurrent, /SUMMARY: meta-command suite/);
  assert.ok(newCurrent.length < longCurrent.length, 'compacted scratchpad is smaller');

  // Reversible: the prior scratchpad is archived verbatim.
  const archiveDir = path.join(dir, 'working-memory', 'archive');
  const archives = fs.readdirSync(archiveDir);
  assert.equal(archives.length, 1, 'exactly one archive written');
  assert.equal(fs.readFileSync(path.join(archiveDir, archives[0]), 'utf8'), longCurrent);

  // Invariants: IDENTITY and the append-only log are untouched.
  assert.equal(fs.readFileSync(path.join(dir, 'IDENTITY.md'), 'utf8'), identityBefore);
  assert.equal(fs.readFileSync(todayLog(dir), 'utf8'), logBefore);

  // SAFETY: the external turn is excluded from the summarizer input and the new scratchpad.
  assert.ok(!brain.lastContext.includes('SECRET_LEAK_TOKEN'), 'external turn excluded from summary input');
  assert.ok(!newCurrent.includes('SECRET_LEAK_TOKEN'), 'external content never lands in current.md');
  assert.ok(
    brain.lastContext.includes('building the meta-command suite') ||
      brain.lastContext.includes('finish the build'),
    'the trusted turn is included in the summary input',
  );

  assert.match(report, /KERNEL · compact/);
  assert.match(report, /archived/);
});

test('compact honors focus instructions', async () => {
  const dir = makeDir();
  const currentPath = path.join(dir, 'working-memory', 'current.md');
  fs.writeFileSync(currentPath, '# Current\n\nsome scratchpad text to compact.\n', 'utf8');
  fs.writeFileSync(
    todayLog(dir),
    blocks([{ source: 'user', intent: 'work on finance', reply: 'finance store wired' }]),
    'utf8',
  );

  const report = await runCompact('the finance work', dir, new CapturingBrain('briefing about finance.'));
  const newCurrent = fs.readFileSync(currentPath, 'utf8');
  assert.match(newCurrent, /_Focus: the finance work_/);
  assert.match(report, /focus\s+the finance work/);
});

test('compact falls back to a deterministic digest when the brain returns nothing usable', async () => {
  const dir = makeDir();
  const currentPath = path.join(dir, 'working-memory', 'current.md');
  fs.writeFileSync(currentPath, '# Current\n\nscratchpad text.\n', 'utf8');
  fs.writeFileSync(
    todayLog(dir),
    blocks([{ source: 'user', intent: 'hello', reply: 'a concrete reply worth keeping' }]),
    'utf8',
  );

  // StubBrain echoes its prompt — isUsableSummary rejects it, so the digest is used.
  const report = await runCompact('', dir, new StubBrain());
  const newCurrent = fs.readFileSync(currentPath, 'utf8');
  assert.match(newCurrent, /Recent activity/);
  assert.ok(!newCurrent.includes('StubBrain'), 'the stub echo never reaches the scratchpad');
  assert.match(report, /deterministic digest/);
});

test('compact flattens a JSON summary (LocalBrain format:json) into readable bullets', async () => {
  const dir = makeDir();
  const currentPath = path.join(dir, 'working-memory', 'current.md');
  fs.writeFileSync(currentPath, '# Current\n\nscratchpad text to compact.\n', 'utf8');
  fs.writeFileSync(
    todayLog(dir),
    blocks([{ source: 'user', intent: 'status', reply: 'work in progress' }]),
    'utf8',
  );

  // qwen under format:'json' typically returns the briefing as JSON, not prose.
  const json = '{"briefing":["Open task: ship the meta-commands","Decision: forward as utterances"]}';
  await runCompact('', dir, new CapturingBrain(json));

  const newCurrent = fs.readFileSync(currentPath, 'utf8');
  assert.match(newCurrent, /- Open task: ship the meta-commands/);
  assert.match(newCurrent, /- Decision: forward as utterances/);
  assert.ok(!newCurrent.includes('{"briefing"'), 'raw JSON is flattened away');
});

test('compact reports nothing to do when working memory is empty', async () => {
  const dir = makeDir();
  fs.writeFileSync(path.join(dir, 'working-memory', 'current.md'), '', 'utf8');
  const report = await runCompact('', dir, new StubBrain());
  assert.match(report, /nothing to compact/i);
});
