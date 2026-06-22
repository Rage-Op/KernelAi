/**
 * settings.test.ts — RED until Task 3 creates settings.ts.
 *
 * Covers the brain=cloud|local Settings path: applySettings('local') swaps the active
 * brain to a LocalBrain via the EXISTING loop.setBrain seam; applySettings('cloud') swaps
 * it to a ClaudeBrain. The always-on 7B helper is a standalone module — it is NOT a
 * BrainProvider and is unaffected by the toggle (BRAIN-03 / BRAIN-05).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applySettings } from './settings.js';
import { getActiveBrain, setBrain } from './loop.js';
import { StubBrain } from './brain/StubBrain.js';
import { ClaudeBrain } from './brain/ClaudeBrain.js';
import { LocalBrain } from './brain/LocalBrain.js';
import * as helper from './brain/helper.js';

test('applySettings("local") swaps the active brain to a LocalBrain', () => {
  setBrain(new StubBrain()); // known starting point
  applySettings('local');
  assert.ok(getActiveBrain() instanceof LocalBrain, 'brain=local → LocalBrain is active');
});

test('applySettings("cloud") swaps the active brain to a ClaudeBrain', () => {
  setBrain(new StubBrain());
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
  // restore default for downstream tests
  setBrain(new StubBrain());
});
