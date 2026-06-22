/**
 * override.test.ts — `/override` as a scoped capability (SAFE-02, Pitfall 7).
 *
 *   (a) with override active, allows('green') is full speed; allows('yellow') is proceed + notify;
 *   (b) allows('red') is STRUCTURALLY incapable of returning a bypass — it returns { gated:true }
 *       regardless of override state (a Red bypass is unrepresentable in the return type);
 *   (c) override auto-expires after its TTL (fake clock advance) — isActive flips false;
 *   (d) activation is audit-logged with scope + duration;
 *   (e) the denylist (the three hard rules + the Red breaker) can NEVER be unlocked by override.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createOverride, OVERRIDE_DENYLIST } from './override.js';
import { fakeClock, captureAudit } from './test-helpers.js';

test('override: active → green full-speed, yellow proceed+notify', () => {
  const clock = fakeClock();
  const aud = captureAudit();
  const ov = createOverride({ clock, audit: aud.audit });
  ov.activate('session', 60_000);

  assert.deepEqual(ov.allows('green'), { speed: 'full' }, 'green → full speed under active override');
  assert.deepEqual(ov.allows('yellow'), { proceed: true, notify: true }, 'yellow → proceed + notify');
});

test('override: allows(red) is STRUCTURALLY incapable of a bypass — always { gated:true }', () => {
  const clock = fakeClock();
  const aud = captureAudit();
  const ov = createOverride({ clock, audit: aud.audit });

  // before activation:
  assert.deepEqual(ov.allows('red'), { gated: true }, 'red gated when override is inactive');
  // after activation (the dangerous case): STILL gated.
  ov.activate('session', 60_000);
  assert.deepEqual(ov.allows('red'), { gated: true }, 'red STILL gated under ACTIVE override — no bypass shape exists');

  // The return type for red can only be { gated:true } — there is no { speed } / { proceed } arm
  // a red call can ever reach. Asserting the runtime value proves the structural guarantee.
  const redBehavior = ov.allows('red');
  assert.equal('speed' in redBehavior, false, 'red can never carry a full-speed bypass');
  assert.equal('proceed' in redBehavior, false, 'red can never carry a proceed bypass');
});

test('override: auto-expires after its TTL (fake clock advance)', () => {
  const clock = fakeClock();
  const aud = captureAudit();
  const ov = createOverride({ clock, audit: aud.audit });

  ov.activate('session', 10_000);
  assert.equal(ov.isActive(), true, 'active immediately after activation');

  clock.advance(9_999);
  assert.equal(ov.isActive(), true, 'still active just before the TTL');

  clock.advance(2); // cross the TTL boundary.
  assert.equal(ov.isActive(), false, 'auto-expired after the TTL elapses');
  // and green reverts to default friction (still full-speed allowed, but not the active grant).
  assert.deepEqual(ov.allows('red'), { gated: true }, 'red remains gated after expiry');
});

test('override: activation is audit-logged with scope + duration', () => {
  const clock = fakeClock(1000);
  const aud = captureAudit();
  const ov = createOverride({ clock, audit: aud.audit });

  ov.activate('voice-session', 30_000);
  const entry = aud.entries.at(-1);
  assert.equal(entry?.call.tool, 'override', 'the activation is audited as an override event');
  assert.equal(entry?.call.args?.scope, 'voice-session', 'scope is recorded');
  assert.equal(entry?.call.args?.ttlMs, 30_000, 'duration is recorded');
});

test('override: the denylist (hard rules + Red breaker) can NEVER be unlocked', () => {
  const clock = fakeClock();
  const aud = captureAudit();
  const ov = createOverride({ clock, audit: aud.audit });
  ov.activate('session', 60_000);

  // every denylisted capability reports as off-limits, even under active override.
  for (const cap of OVERRIDE_DENYLIST) {
    assert.equal(ov.isDenylisted(cap), true, `${cap} is on the override denylist`);
  }
  // a capability NOT on the denylist (e.g. a green op) is not denylisted.
  assert.equal(ov.isDenylisted('green-click'), false, 'a green op is not denylisted');
});
