/**
 * register-builtins.test.ts — the daemon-startup tool wiring (HANDS-04).
 *
 * Asserts registerBuiltinTools() loads the four built-in tool modules so they self-register, and
 * that listTools() then reports them. Runs in its own process (node --test isolates test files), so
 * the dynamic imports are fresh here and actually evaluate each module's register() side-effect.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { registerBuiltinTools } from './register-builtins.js';
import { listTools } from './registry.js';

test('registerBuiltinTools registers the built-in hands and listTools reports them', async () => {
  const returned = await registerBuiltinTools();
  for (const name of ['browser', 'finance', 'mail', 'peekaboo', 'web']) {
    assert.ok(returned.includes(name), `registerBuiltinTools result includes ${name}`);
    assert.ok(listTools().includes(name), `listTools() includes ${name}`);
  }
  // listTools is sorted + deduped (it is the registry's key set).
  assert.deepEqual(listTools(), [...new Set(listTools())].sort(), 'listTools is sorted and unique');
});
