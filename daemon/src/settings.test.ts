/**
 * settings.test.ts — the brain=cloud|local Settings path + persistence (CLOUD-01).
 *
 * Covers: applySettings('local') swaps the active brain to a LocalBrain via the EXISTING
 * loop.setBrain seam; applySettings('cloud') swaps it to a ClaudeBrain; the always-on 7B helper
 * is a standalone module unaffected by the toggle (BRAIN-03 / BRAIN-05); and the selection
 * persists to disk + is re-applied by restorePersistedBrain() on startup.
 *
 * The persistence file is redirected to a per-test tmp path via __setBrainPrefPathForTest so this
 * NEVER writes the real ~/Library/Application Support/Kernel/brain.json (mirrors spend-ledger).
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  applySettings,
  loadPersistedBrain,
  restorePersistedBrain,
  __setBrainPrefPathForTest,
} from './settings.js';
import { getActiveBrain, setBrain } from './loop.js';
import { StubBrain } from './brain/StubBrain.js';
import { ClaudeBrain } from './brain/ClaudeBrain.js';
import { LocalBrain } from './brain/LocalBrain.js';
import * as helper from './brain/helper.js';

let tmpDir: string;
let prefPath: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-settings-'));
  prefPath = path.join(tmpDir, 'brain.json');
  __setBrainPrefPathForTest(prefPath);
});

after(() => {
  __setBrainPrefPathForTest(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Start every test from a clean slate: no persisted file, known StubBrain.
  fs.rmSync(prefPath, { force: true });
  setBrain(new StubBrain());
});

test('applySettings("local") swaps the active brain to a LocalBrain', () => {
  applySettings('local');
  assert.ok(getActiveBrain() instanceof LocalBrain, 'brain=local → LocalBrain is active');
});

test('applySettings("cloud") swaps the active brain to a ClaudeBrain', () => {
  applySettings('cloud');
  assert.ok(getActiveBrain() instanceof ClaudeBrain, 'brain=cloud → ClaudeBrain is active');
});

test('the 7B helper is a standalone module, unaffected by the brain toggle', () => {
  // The helper exposes triage/classify/narrate as standalone functions — it is NOT a
  // BrainProvider and is never passed to setBrain. Toggling the brain does not touch it.
  applySettings('local');
  assert.equal(typeof helper.triage, 'function', 'helper.triage exists regardless of toggle');
  applySettings('cloud');
  assert.equal(typeof helper.triage, 'function', 'helper.triage still exists after cloud toggle');
});

test('applySettings persists the selection to disk by default', () => {
  applySettings('local');
  assert.equal(loadPersistedBrain(), 'local', 'local is persisted');
  applySettings('cloud');
  assert.equal(loadPersistedBrain(), 'cloud', 'cloud overwrites the persisted choice');
});

test('applySettings(brain, false) does NOT persist (startup-restore path)', () => {
  applySettings('local', false);
  assert.equal(loadPersistedBrain(), null, 'no file written when persist=false');
});

test('loadPersistedBrain returns null when absent or corrupt', () => {
  assert.equal(loadPersistedBrain(), null, 'absent file → null');
  fs.writeFileSync(prefPath, 'not json', 'utf8');
  assert.equal(loadPersistedBrain(), null, 'corrupt file → null');
  fs.writeFileSync(prefPath, JSON.stringify({ brain: 'martian' }), 'utf8');
  assert.equal(loadPersistedBrain(), null, 'invalid brain value → null');
});

test('restorePersistedBrain re-applies a saved local brain on startup', () => {
  applySettings('local'); // owner chose local in a prior session (persisted)
  setBrain(new StubBrain()); // simulate a fresh daemon process default
  restorePersistedBrain();
  assert.ok(getActiveBrain() instanceof LocalBrain, 'startup restore → LocalBrain active');
});

test('restorePersistedBrain re-applies a saved cloud brain on startup', () => {
  applySettings('cloud');
  setBrain(new StubBrain());
  restorePersistedBrain();
  assert.ok(getActiveBrain() instanceof ClaudeBrain, 'startup restore → ClaudeBrain active');
});

test('restorePersistedBrain is a no-op when nothing was saved (keeps the loop default)', () => {
  setBrain(new StubBrain());
  restorePersistedBrain();
  assert.ok(getActiveBrain() instanceof StubBrain, 'never-toggled → default brain untouched');
});
