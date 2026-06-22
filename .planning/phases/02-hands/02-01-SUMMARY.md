---
phase: 02-hands
plan: 01
subsystem: infra
tags: [tool-router, safety-gate, access-control, credential-fence, tier-classification, zod, default-deny]

# Dependency graph
requires:
  - phase: 01-foundation
    provides: "ToolCall/Decision (brain/BrainProvider.ts), logger (memory/log.ts), the loop act-seam no-op, the safety/ README gate contract"
provides:
  - "tools/Tool.ts — the registry contract (Tool + ToolResult), with the documented anti-bypass rule (execute only via dispatch)"
  - "tools/registry.ts — register(tool) + dispatch(call): the single public path to a tool, gate-first, default-deny on unknown tools, zod-validated args"
  - "safety/tiers.ts — classifyTier (green/yellow/red, unknown→red default-deny) + detectCredentialField (the credential fence)"
  - "safety/gate.ts — authorize(call): the SINGLE classify-only chokepoint, Phase-5-ready Verdict union (allow|gated|deny)"
  - "loop.ts act seam wired to router.dispatch — a Blocked escalation is surfaced via intent.reply"
affects: [02-02-peekaboo, 02-03-browser, 05-money-tier-gate]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Single-chokepoint dispatch: registry.dispatch is the only public path to a tool and calls gate.authorize BEFORE execute"
    - "Default-deny: unknown tool name and unclassifiable op both deny, never throw, never execute"
    - "Central tier classification: a tool never self-classifies; tier is derived from call.tool + call.args in safety/tiers.ts"
    - "Phase-5-ready Verdict: the gated arm is reserved so Phase 5 is a pure-additive edit inside gate.authorize only"
    - "Credential fence as a hard, non-overridable code-level deny that fires before tier classification"

key-files:
  created:
    - daemon/src/tools/Tool.ts
    - daemon/src/tools/registry.ts
    - daemon/src/tools/registry.test.ts
    - daemon/src/safety/tiers.ts
    - daemon/src/safety/tiers.test.ts
    - daemon/src/safety/gate.ts
    - daemon/src/safety/gate.test.ts
  modified:
    - daemon/src/loop.ts
    - daemon/src/loop.test.ts

key-decisions:
  - "Red-tier in Phase 2 = deny + escalate (LOCKED, research Open Question 1) — no Red autonomy before Phase 5; the gated Verdict arm is kept UNUSED for Phase 5"
  - "tiers.ts/gate.ts were committed in Task 1 (not Task 2) because registry.ts imports gate.ts and the router cannot compile or be tested without them; their dedicated test files landed in Task 2"
  - "Credential fence is enforced inside gate.authorize BEFORE tier classification, so it denies even a call that would otherwise classify Yellow"

patterns-established:
  - "Single-chokepoint dispatch (registry.dispatch → gate.authorize → zod safeParse → tool.execute)"
  - "Default-deny on unknown tools and unclassifiable ops"
  - "Phase-5-ready Verdict discriminated union (allow | gated | deny) — only gate.authorize internals change in P5"

requirements-completed: [HANDS-04, HANDS-05, SAFE-01]

# Metrics
duration: ~12 min
completed: 2026-06-22
---

# Phase 2 Plan 01: Tool Router + Classify-Only Gate Summary

**A tool router whose single `dispatch` chokepoint runs `gate.authorize` before any `execute` — central green/yellow/red tier classification, a hard non-overridable credential fence, Red=deny+escalate in P2 (Phase-5-ready Verdict), and the loop's act seam wired to `router.dispatch`.**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-06-22T10:01Z (baseline suite green)
- **Completed:** 2026-06-22T10:06Z
- **Tasks:** 3
- **Files modified:** 9 (7 created, 2 modified)

## Accomplishments
- Built the tool registry contract (`Tool`/`ToolResult`) with an explicit anti-bypass rule: `execute` is only ever reached via `registry.dispatch`, after the gate.
- Built `registry.dispatch` as the single public entry — fixed, load-bearing order: lookup (default-deny unknown) → `await authorize(call)` → deny short-circuits before execute → zod `safeParse` of args → `execute`.
- Built `safety/tiers.ts`: central `classifyTier` (green/yellow/red, unknown op → red default-deny) and `detectCredentialField` (refuse-by-default on `isSecureField`, a credential label match, or a sensitive autocomplete hint; only `peekaboo`/`browser` `type`/`fill` ops in scope).
- Built `safety/gate.ts`: the classify-only `authorize` with the credential fence firing FIRST (before tier classification), Red = deny + escalate (LOCKED), and a Phase-5-ready `Verdict` union keeping the unused `gated` arm.
- Wired the loop's reserved Phase-1 act no-op to `router.dispatch(decision.action)` — a blocked/escalated result surfaces a `Blocked: <reason> — <recommendation>` reply via `intent.reply`. The loop imports only `dispatch`, never the gate or a tool (single-chokepoint invariant preserved).
- Full suite green: 69 tests (46 Phase-1 unchanged + 23 new: 5 registry, 11 tiers, 5 gate, 2 loop act-seam).

## Task Commits

1. **Task 1: Tool contract + router with the gate as the single chokepoint** — `bf53c2f` (feat) — includes `tiers.ts`/`gate.ts` because the router imports the gate (co-dependent; cannot compile/test the router without them).
2. **Task 2: Tier classifier + credential fence + classify-only gate tests** — `ffc1267` (feat) — the dedicated `tiers.test.ts` + `gate.test.ts`.
3. **Task 3: Wire router.dispatch into the loop act seam** — `f16d103` (feat).

## Files Created/Modified
- `daemon/src/tools/Tool.ts` - `Tool` + `ToolResult` interfaces; documents the anti-bypass contract (execute only via dispatch).
- `daemon/src/tools/registry.ts` - `register`/`dispatch`/`clearRegistry`; `dispatch` calls `authorize` first, default-denies unknown tools, zod-validates args, then executes.
- `daemon/src/tools/registry.test.ts` - 5 tests: dispatch reaches execute (green/valid), unknown→default-deny, gate-deny (fence) never executes, Red→deny never executes, invalid args rejected by zod before execute.
- `daemon/src/safety/tiers.ts` - `classifyTier` (extensible green/yellow/red op sets, unknown→red) + `detectCredentialField` (the credential fence detector).
- `daemon/src/safety/tiers.test.ts` - 11 tests: green/yellow/red matrix, unknown→red, fence positives (secure field / Password label / current-password autocomplete / CVV) and negatives (To label / click op / non-peekaboo-browser tool).
- `daemon/src/safety/gate.ts` - `authorize(call): Verdict`; fence-first hard deny, classify + log, Red→deny+escalate (LOCKED), green/yellow→allow; `gated` arm reserved for Phase 5.
- `daemon/src/safety/gate.test.ts` - 5 tests: fence denies before tier, secure-field denies, Red denies (not gated), green allows, yellow non-secret type allows.
- `daemon/src/loop.ts` - act seam filled: `await dispatch(decision.action)`; surfaces `Blocked: ...` via `intent.reply`. Imports `dispatch` only.
- `daemon/src/loop.test.ts` - 2 new tests: allowed green action reaches the tool through the gate; denied (fence) action surfaces `Blocked:` and never executes.

## Decisions Made
- **Red = deny + escalate in Phase 2** (LOCKED, research Open Question 1). No reachable Red autonomy; the `gated` arm of `Verdict` is kept unused so Phase 5 turns the Red branch into the real breaker (dry-run → cancel → ceiling → audit) without touching the router, the tools, or the loop.
- **`tiers.ts`/`gate.ts` committed in Task 1, their tests in Task 2.** `registry.ts` imports `gate.ts`; the modules are co-dependent and the router cannot compile or be unit-tested without them, so they landed with the router commit. The plan's Task-2-named test files (`tiers.test.ts`, `gate.test.ts`) landed in the Task 2 commit as written.
- **Fence fires before tier classification** so it denies even a call that would otherwise be Yellow (e.g. a `fill` into a `Password` field).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Corrected the Task-1 invalid-args test so the gate allows but zod rejects**
- **Found during:** Task 1 (registry.test.ts)
- **Issue:** The first draft of the invalid-args test dispatched `{ args: { wrong: 123 } }` with no `op`. With no `op`, `classifyTier` falls back to the tool name, which is unrecognized and therefore defaults to `red` (default-deny) — so the call was denied by the GATE, not by zod, and the test asserted the wrong escalation message.
- **Fix:** Changed the test to dispatch a GREEN op with a type-invalid field (`{ op: 'click', n: 'not-a-number' }` against a `{ op: string, n: number }` schema) so the gate ALLOWS and the rejection is isolated to the zod `safeParse` step — proving args are validated after the gate clears and before execute. Test-only change; no production code was altered for this.
- **Files modified:** `daemon/src/tools/registry.test.ts`
- **Verification:** `npx tsx --test src/tools/registry.test.ts` → 5/5 pass.
- **Committed in:** `bf53c2f` (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 test-correctness bug, test-only).
**Impact on plan:** No production-code deviation, no scope creep. The fix actually strengthened the test by isolating the zod-validation path from the gate path.

## Issues Encountered
None. Baseline suite was green (46) before starting and is green (69) after.

## Threat Surface
No new security surface beyond the plan's `<threat_model>`. This plan installed no packages (T-02-SC holds). T-02-01 through T-02-05 are each covered by a passing unit test (gate-first dispatch, default-deny unknown, credential fence hard-deny, Red deny, zod arg validation). T-02-06 (external→Red interlock) remains accepted for P2 per the plan — Red already denies, so an externally-sourced Red action cannot run.

## Known Stubs
None. No hardcoded empty values, placeholder text, or unwired data sources. The `gated` Verdict arm is intentionally unused (reserved for Phase 5, documented in `gate.ts`) — this is a planned forward-compatibility seam, not a stub.

## Self-Check: PASSED
- All 9 key files exist on disk (verified).
- All 3 task commits exist: `bf53c2f`, `ffc1267`, `f16d103` (verified in git log).
- Plan-level verification re-run: full suite 69/69 green; no `.execute(` production call site outside `registry.ts`; `loop.ts` imports `dispatch` not the gate; no breaker/override/spend-ceiling/dry-run CODE (only doc-comments stating they are Phase-5-only).
- key_links confirmed: `await authorize(call)` in `registry.ts`; `dispatch(decision.action)` in `loop.ts`.

## Next Phase Readiness
- The router contract (`Tool`/`ToolResult`) and the gate are ready for the two real adapters: **Plan 02-02 (Peekaboo over MCP)** and **Plan 02-03 (Playwright browser)** register against `tools/Tool.ts` and route every call through `registry.dispatch`. The adapters are responsible for surfacing `isSecureField`/`fieldLabel`/`autocomplete` from the AX tree (Peekaboo) or DOM (Playwright) at the read site so the fence can classify.
- Phase 5 is the ONLY edit site to enable Red autonomy: flip the gate's Red branch to `{ kind: 'gated' }` and hook the breaker inside `authorize`. The router, the tools, and the loop are untouched.

---
*Phase: 02-hands*
*Completed: 2026-06-22*
