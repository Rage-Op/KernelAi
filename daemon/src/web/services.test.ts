import { test } from 'node:test';
import assert from 'node:assert/strict';

import { listServices, runServiceAction } from './services.js';

test('services: lists exactly the four known background services', async () => {
  const svcs = await listServices();
  assert.deepEqual(
    svcs.map((s) => s.name).sort(),
    ['browser', 'lmstudio', 'ollama', 'stray-daemons'],
  );
  for (const s of svcs) {
    assert.equal(typeof s.label, 'string');
    assert.equal(typeof s.running, 'boolean');
    assert.ok(Array.isArray(s.actions));
  }
});

test('services: action is hard-allowlisted — unknown name / non-stop action are refused (no process touched)', async () => {
  assert.match(await runServiceAction('bogus', 'stop'), /unknown service/);
  assert.match(await runServiceAction('ollama', 'restart'), /unsupported action/);
  // NOTE: we deliberately do NOT exercise a real `stop` here — it would kill a live local service.
});
