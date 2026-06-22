---
phase: 05-safety-self-maintenance-gated-do-not-auto-execute
plan: 01
subsystem: infra
tags: [safety, circuit-breaker, tiered-autonomy, override, spend-ledger, audit, provenance-taint, toctou, feature-flag, zod]

# Dependency graph
requires:
  - phase: 02 (HANDS)
    provides: classify-only gate.authorize with the reserved {kind:'gated',tier:'red'} Verdict arm + the credential fence + tiers.ts classification
  - phase: 02 (HANDS)
    provides: registry.dispatch single chokepoint with the designed-in 'gated' branch path
  - phase: 01 (CORE)
    provides: ToolCall/Provenance types, the serial loop.drain, the frozen FrameSchema additive-arm pattern, node:crypto SHA-256 pattern (identity.ts)
provides:
  - "Live Red-tier circuit breaker (safety/breaker.ts): pure injectable state machine dryRun->10s cancel->atomic ceiling->audit->TOCTOU->execute"
  - "Atomic single-writer daily spend ledger (safety/spend-ledger.ts) — no finance PII, day-boundary reset"
  - "Scoped /override capability (safety/override.ts) — Green/Yellow only, structurally incapable of unlocking Red, auto-expiry, audited"
  - "Append-only audit log (safety/audit.ts) — every Red verdict + content hash, finance amounts never logged"
  - "SAFE-07 feature flag (safety/flags.ts) gating the live 'gated' arm — flag OFF reproduces exact P1-P4 behaviour"
  - "Wave-0 shared safety test harness (safety/test-helpers.ts) — fakeClock/recordingExecutor/controllableCancel/memoryLedger/captureAudit"
  - "Activated gate.authorize: external-Red HARD-BLOCK above /override+breaker, flag-gated Red->gated, /override-threaded green/yellow allow"
  - "registry.dispatch wired: verdict.kind==='gated' -> breaker.run(call, breakerDeps) between the deny check and safeParse/execute"
  - "ToolCall.origin provenance taint stamped at the loop decision site; literal /override parse before brain.reason()"
  - "Three additive IPC frames: override (Face->daemon), breaker.preview (daemon->Face), breaker.cancel (Face->daemon)"
affects: [05-02 (CC Red shim re-enters breaker.run), 05-03 (obstacle ladder / self-maintenance), phase-5 verification]

# Tech tracking
tech-stack:
  added: []  # ZERO new packages — node built-ins (node:crypto/node:fs) + shipped zod only
  patterns:
    - "Pure injectable state machine: ALL side effects (clock/executor/cancel/ledger/audit/reReadState) injected via BreakerDeps so 100% unit-testable with no real timer/rm/spend"
    - "Scoped capability over global boolean: override.allows('red') returns {gated:true} ALWAYS — a Red bypass is unrepresentable in the return type (Pitfall 7)"
    - "Atomic single-writer critical section: checkAndReserve has no await between check and reserve (Pitfall 2)"
    - "Hard rules ABOVE override+breaker, enforced in code order in gate.authorize (Pitfall 1)"
    - "Feature-flag flip-on is behaviour-preserving: flag OFF == P1-P4 deny (SAFE-07)"
    - "Additive zod arms appended to the frozen FrameSchema union — existing arms never mutated"

key-files:
  created:
    - daemon/src/safety/test-helpers.ts
    - daemon/src/safety/flags.ts
    - daemon/src/safety/audit.ts
    - daemon/src/safety/spend-ledger.ts
    - daemon/src/safety/spend-ledger.test.ts
    - daemon/src/safety/breaker.ts
    - daemon/src/safety/breaker.test.ts
    - daemon/src/safety/override.ts
    - daemon/src/safety/override.test.ts
  modified:
    - daemon/src/safety/gate.ts
    - daemon/src/safety/gate.test.ts
    - daemon/src/tools/registry.ts
    - daemon/src/tools/registry.test.ts
    - daemon/src/brain/BrainProvider.ts
    - daemon/src/loop.ts
    - daemon/src/loop.test.ts
    - daemon/src/ipc/protocol.ts
    - kernel-memory/.gitignore

key-decisions:
  - "TOCTOU state read happens at BOTH preview and execute time via the SAME deps.reReadState source, so preview.stateHash and the execute-time hash compare apples-to-apples (a mismatch == the world changed). Resolves the underspecified preview.stateHash in the RESEARCH pseudocode."
  - "Cancel-window timeout = PROCEED after ceiling+audit (locked decision / Open Q1): the window is the owner's chance to CANCEL, not an approve prompt."
  - "Verdict.allow arm gained additive optional speed/notify friction hints (green full-speed, yellow proceed+notify) threaded from /override; existing consumers ignore them, contract unchanged."
  - "Spend ledger + audit log are gitignored as machine-local runtime state (like self/identity.hash); ledger stores ONLY {date,totalReserved,ceiling} — no finance PII."
  - "Unknown/absent origin on a Red action defaults to GATED (breaker, default-deny posture), not allowed; only an EXPLICIT origin==='external' hard-denies."

patterns-established:
  - "Wave-0 harness: every safety test imports test-helpers so no test ever performs a real irreversible action"
  - "breakerDeps injected into registry via setBreakerDeps (tests pass mocks; production builds real wiring lazily)"

requirements-completed: [SAFE-01, SAFE-02, SAFE-03, SAFE-04, SAFE-07]

# Metrics
duration: 18 min
completed: 2026-06-22
---

# Phase 5 Plan 01: Activate the Tiered-Autonomy Gate + Circuit Breaker + /override Summary

**Flipped the dormant `{kind:'gated',tier:'red'}` Verdict arm into a LIVE, pure-injectable Red circuit breaker (dry-run → 10s cancel → atomic spend ceiling → audit → TOCTOU re-verify → execute), behind a SAFE-07 feature flag, with the external-Red hard-block and credential fence sitting in code ABOVE both `/override` and the breaker — zero new packages, full 176-test prior suite still green.**

## Performance

- **Duration:** 18 min
- **Started:** 2026-06-22T17:07Z
- **Completed:** 2026-06-22T17:18:39Z
- **Tasks:** 3 (all TDD)
- **Files modified:** 18 (9 created, 9 modified incl. kernel-memory/.gitignore)

## Accomplishments
- Built the Red circuit breaker as a pure state machine with every side effect injected — proven via fake clock + recording mock executor that the executor is called EXACTLY ONCE on the proceed path and ZERO times on every abort path (cancel / ceiling / TOCTOU).
- Made `/override` structurally incapable of unlocking Red: `allows('red')` can only return `{gated:true}` — a Red bypass is unrepresentable in the type. Defense-in-depth: the gate ALSO ignores override for the Red decision.
- Enforced the three hard rules ABOVE `/override` and the breaker in `gate.authorize`, in this order: (1) credential fence (overridable=false, unchanged); (2) `tier==='red' && origin==='external'` → HARD-BLOCK (a poisoned-email fixture cannot trigger Red even under active `/override`); (3) atomic daily spend ceiling inside the breaker.
- Wired the `gated` arm into `registry.dispatch` BETWEEN the deny check and safeParse/execute, so a gated call routes to `breaker.run` and NEVER falls through to the plain execute path.
- Stamped `ToolCall.origin` provenance taint at the loop decision site; parsed a LITERAL `/override` command BEFORE `brain.reason()` so external content can never activate override.
- Flipped Red→gated behind `FLAGS.breakerEnabled`: flag OFF reproduces the exact P1-P4 deny (SAFE-07 regression intact); flag ON + user/self origin → gated.

## Task Commits

Each task was committed atomically:

1. **Task 1: Wave-0 harness + atomic spend ledger + audit + SAFE-07 flag** — `4677e78` (feat) + `31db875` in kernel-memory (chore: gitignore)
2. **Task 2: Scoped /override + pure injectable circuit breaker** — `1c799b3` (feat)
3. **Task 3: Activate gate + wire breaker into dispatch + /override IPC frames + origin taint** — `a2cbdd4` (feat)

## Files Created/Modified
- `daemon/src/safety/breaker.ts` - Pure injectable Red breaker state machine; exports `run`, `BreakerDeps`, `DryRunPreview`, `canonical`, `estimatedSpend`, `Clock`.
- `daemon/src/safety/spend-ledger.ts` - Atomic single-writer daily ledger; exports `SpendLedger`, `createSpendLedger`, `ReserveResult`, `defaultLedgerPath`. No finance PII.
- `daemon/src/safety/override.ts` - Scoped `/override`; exports `OverrideState`, `createOverride`, `OVERRIDE_DENYLIST`, `overrideSingleton`, `setOverrideSingleton`.
- `daemon/src/safety/audit.ts` - Append-only NDJSON audit; exports `appendAudit`, `AuditEntry`, `defaultAuditPath`. Finance amounts never logged.
- `daemon/src/safety/flags.ts` - `FLAGS.breakerEnabled` (env-read once, mutable for tests).
- `daemon/src/safety/test-helpers.ts` - Wave-0 harness: `fakeClock`, `recordingExecutor`, `controllableCancel`, `memoryLedger`, `captureAudit`.
- `daemon/src/safety/gate.ts` - External-Red hard block + flag-gated Red→gated + `/override`-threaded allow; Verdict.allow gained additive speed/notify hints.
- `daemon/src/tools/registry.ts` - `gated`→`breaker.run`; `setBreakerDeps`/`signalBreakerCancel`/`resetBreakerCancel` seams; lazy real-wiring `defaultBreakerDeps`.
- `daemon/src/brain/BrainProvider.ts` - Additive `origin?: Provenance` on ToolCall + `ToolCallSchema`.
- `daemon/src/loop.ts` - Literal `/override` parse before brain; origin stamping at the act site; exports `parseOverrideCommand`.
- `daemon/src/ipc/protocol.ts` - Additive `override`, `breaker.preview`, `breaker.cancel` frames into FrameSchema (no existing arm mutated).
- `kernel-memory/.gitignore` - Gitignore `self/spend-ledger.json` + `self/audit-log` (machine-local runtime state).

## Critical-Invariant Test Results (all GREEN)

| Invariant | Test | Result |
|-----------|------|--------|
| Red ALWAYS gated under /override | `override: allows(red) is STRUCTURALLY incapable of a bypass` + `SAFE-02 defense-in-depth: ACTIVE /override does NOT change the Red decision` | PASS |
| External-Red HARD-BLOCK under active /override (poisoned email) | `SAFE-04 ii: a Red action with origin=external is HARD-BLOCKED even under ACTIVE /override` | PASS |
| Credential fence denies under active /override | `SAFE-04 i: the credential fence DENIES even under ACTIVE /override` | PASS |
| Atomic spend ceiling (no race) | `spend-ledger: two near-simultaneous reserves CANNOT both pass` | PASS |
| Breaker cancel → executor NEVER called | `breaker: cancel during the window aborts + audits cancelled, executor NEVER called` | PASS |
| Breaker ceiling → executor NEVER called | `breaker: ceiling exceeded → audit ceiling-exceeded, escalate, executor NEVER called` | PASS |
| TOCTOU abort → executor NEVER called, reserve released | `breaker: TOCTOU — state hash changes ... toctou-abort, reserve released, executor NEVER called` | PASS |
| No real side effects in any path | `breaker: no real side effects — every abort path leaves the recording executor untouched` | PASS |
| /override is a literal command before the brain | `loop: a literal "/override" utterance activates override WITHOUT reaching the brain` + `parseOverrideCommand only fires for a USER utterance` | PASS |
| Flag OFF == P1-P4 (SAFE-07) | `SAFE-07: flag OFF → Red denies; flag ON + user/self origin → gated` + full 176 prior suite | PASS |
| gated → breaker.run, never falls through | `registry: a GATED (Red) verdict routes to breaker.run ... never plain execute` | PASS |

**Test totals:** 204 passed / 0 failed (176 prior + 28 new safety tests). `npm run build` clean. No new package.json dependencies.

## Decisions Made
See `key-decisions` frontmatter. The load-bearing one: the TOCTOU hash compares `sha256(canonical(call) + reReadState())` at preview vs execute time using the SAME state source, so the no-change case matches and any world mutation between the two reads aborts.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] TOCTOU preview-time state read added to make the hash comparison well-defined**
- **Found during:** Task 2 (breaker proceed-path test initially failed: `result.ok` false)
- **Issue:** The RESEARCH pseudocode set `preview.stateHash = sha256(canonical(call))` while the TOCTOU re-verify compared against `sha256(canonical(call) + reReadState())`. These two sources never match on the no-change path, so EVERY proceed would falsely abort as TOCTOU. The preview-time state and the execute-time state must come from the same `reReadState` source.
- **Fix:** `breaker.run` now reads `stateAtPreview = await deps.reReadState(call)` first, `dryRun` captures it into `preview.stateHash`, and the TOCTOU check re-reads the same source at execute time. No-change → match (proceed); mutation → mismatch (abort).
- **Files modified:** daemon/src/safety/breaker.ts (+ breaker.test.ts TOCTOU cases adjusted to mutate state between the two reads)
- **Verification:** All 6 breaker tests green, including proceed (executor called once) and TOCTOU (executor never called, reserve released).
- **Committed in:** 1c799b3 (Task 2 commit)

**2. [Rule 2 - Missing Critical] Gitignored the spend ledger + audit log (no-PII machine-local runtime state)**
- **Found during:** Task 1 (ledger/audit persistence paths)
- **Issue:** The plan referenced a "Task 4 .gitignore note" but Wave 1 has only 3 tasks; the ledger (`self/spend-ledger.json`) and audit log (`self/audit-log`) would otherwise be tracked, and the ledger is locked to be gitignored (Open Q2). Both are machine-local runtime state like `self/identity.hash`.
- **Fix:** Added both paths to `kernel-memory/.gitignore` (committed in the kernel-memory repo, which is its own git repo, separate from the main repo).
- **Files modified:** kernel-memory/.gitignore
- **Verification:** `git -C kernel-memory status` clean; the paths are ignored.
- **Committed in:** 31db875 (kernel-memory repo)

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 missing critical)
**Impact on plan:** Both were correctness/spec-compliance requirements, not scope creep. The TOCTOU fix is load-bearing for the entire breaker; the gitignore fix honors the locked no-finance-PII decision.

## Issues Encountered
- `kernel-memory/` is a separate git repo ignored by the parent repo, so the `gsd-sdk query commit` (which targets the main repo) could not stage its `.gitignore`. Resolved by committing that one file directly in the kernel-memory repo (`31db875`); all daemon source went through `gsd-sdk query commit` to the main repo as normal.

## User Setup Required
None for this plan. (Phase-5 launchd jobs + GitHub backup remote setup land in later Wave plans, not Wave 1.)

## Threat Flags
None — all new surface (the breaker, the ledger, the override, the audit, the three IPC frames, the origin taint) is in the plan's `<threat_model>` register (T-05-01..07). No new endpoints, auth paths, or trust-boundary schema changes beyond what was planned.

## Next Phase Readiness
- 05-02 (CC Red shim) can re-enter `breaker.run(call, breakerDeps)` — the seam (`setBreakerDeps`, `signalBreakerCancel`) and the gated arm are live.
- `KERNEL_BREAKER_ENABLED=true` activates the breaker; `KERNEL_DAILY_SPEND_CEILING` sets the ceiling for the real wiring (owner config surface for a later plan).
- The IPC server still needs to wire the `override`/`breaker.cancel` frames to `override.activate`/`signalBreakerCancel` and push `breaker.preview` (server-side wiring deferred to a later plan; the frames + seams exist).

---
*Phase: 05-safety-self-maintenance-gated-do-not-auto-execute*
*Completed: 2026-06-22*

## Self-Check: PASSED
- All 9 created files verified present on disk.
- All 3 task commits (4677e78, 1c799b3, a2cbdd4) + the kernel-memory commit (31db875) verified in git log.
- `npm test` 204/204 green; `npm run build` clean; zero new package.json dependencies.
