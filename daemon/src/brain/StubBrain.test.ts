import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DecisionSchema } from './BrainProvider.js';
import { StubBrain } from './StubBrain.js';
import type { ContextItem } from '../memory/types.js';

test('StubBrain.reason returns a Decision with a non-empty thought and a reply echoing the prompt', async () => {
  const brain = new StubBrain();
  const decision = await brain.reason('hello', 'ctx');

  assert.ok(decision.thought.length > 0, 'thought must be non-empty');
  assert.ok(decision.reply, 'reply must be present');
  assert.match(decision.reply!, /hello/, 'reply must echo the prompt');
  assert.equal(decision.action, undefined, 'no action — no tools exist in Phase 1');
});

test('StubBrain output parses cleanly against DecisionSchema (zod)', async () => {
  const decision = await new StubBrain().reason('hello', 'ctx');
  // Throws if invalid — the contract is enforced even for the stub.
  const parsed = DecisionSchema.parse(decision);
  assert.equal(parsed.thought, decision.thought);
});

test('DecisionSchema rejects a malformed Decision (missing thought)', () => {
  const result = DecisionSchema.safeParse({});
  assert.equal(result.success, false, 'empty object must fail — thought is required');
});

test('ContextItem carries a source provenance tag', () => {
  const item: ContextItem = { text: 'something Pravin said', source: 'user' };
  assert.equal(item.source, 'user');

  // The three legal provenance values compile and round-trip.
  const sources: ContextItem['source'][] = ['user', 'self', 'external'];
  assert.deepEqual(sources, ['user', 'self', 'external']);
});
