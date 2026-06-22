---
phase: 05-safety-self-maintenance-gated-do-not-auto-execute
plan: 02
subsystem: safety
tags: [claude-code, red-gating, permission-denials, disallowed-tools, obstacle-ladder, replan, decompose, backoff, escalation, toctou, provenance-taint]

# Dependency graph
requires:
  - phase: 05 (plan 01)
    provides: the live Red circuit breaker (safety/breaker.ts), gate.authorize (external-Red hard block + flag-gated Red->gated), registry.dispatch gated arm, ToolCall.origin taint, the Wave-0 test harness (safety/test-helpers.ts)
  - phase: 04 (HANDS/Claude Code bridge)
    provides: tools/claude-code.ts (the stream-json CC bridge, __setRunnerForTest seam, first-person prompt, registry append)
  - phase: 03 (CORE brain)
    provides: ClaudeBrain (claude-opus-4-8 versioned model id) reused via the injected ladder brain seam
provides:
  - "CC Red re-submission shim (tools/claude-code.ts): argv carries --disallowedTools RED_DENY (Bash(rm *), Bash(rmdir *), Bash(*install*), Bash(*git push*), Bash(sudo *)) enforced even under bypass, alongside the retained Green/Yellow read-only fence"
  - "permission_denials -> gate re-entry: each denial maps (mapDenialToToolCall) to a {tool:'shell', args:{op,command}, origin:'self'} ToolCall that RE-ENTERS the injected dispatch (registry.dispatch) once per denial — the Red action routes to the SAME breaker (05-01) and NEVER auto-runs"
  - "Obstacle planner ladder (planner/ladder.ts): runLadder state machine TRY->REPLAN->DECOMPOSE->RETRY-WITH-BACKOFF->ESCALATE with a SPECIFIC recommendation ('X blocked by Y; I recommend Z. Approve?')"
  - "SAFE-06 Red-skip: a Red gate verdict (result.gated) makes the ladder SKIP every rung and escalate immediately — only Red gates skip the ladder"
  - "Additive ToolResult.gated marker (tools/Tool.ts) stamped by registry.dispatch on a non-success breaker outcome, so the ladder can unambiguously detect a Red gate"
affects: [05-03 (self-maintenance / loop integration may call runLadder for non-Red obstacles), phase-5 verification]

# Tech tracking
tech-stack:
  added: []  # ZERO new packages — node built-ins + shipped zod only
  patterns:
    - "Deny-rules + permission_denials re-entry over the canUseTool callback: the disallowedTools deny rules are bypass-proof and the result-event permission_denials re-enter the gate, sidestepping the documented stream-json --permission-prompt-tool gap"
    - "origin:'self' re-entry: a CC sub-contractor's Red action is KERNEL's OWN action (NOT external content) so it is GATED by the breaker, not external-hard-blocked"
    - "Async re-entry harvested synchronously, dispatched after the run resolves: denials are collected during the line callback then re-submitted to dispatch after run() resolves so the async dispatch never races the synchronous line parser"
    - "Pure injectable ladder state machine: dispatch, brain (replan/decompose/recommend), clock all injected so the whole ladder is unit-testable with a fake clock + mock brain — no real cloud call, no real timer"
    - "Additive optional ToolResult.gated marker: a backward-compatible discriminator the ladder reads to skip Red gates; existing consumers ignore it"

key-files:
  created:
    - daemon/src/planner/ladder.ts
    - daemon/src/planner/ladder.test.ts
  modified:
    - daemon/src/tools/claude-code.ts
    - daemon/src/tools/claude-code.test.ts
    - daemon/src/tools/Tool.ts
    - daemon/src/tools/registry.ts

key-decisions:
  - "The Red-gate signal the ladder reads is an ADDITIVE optional ToolResult.gated boolean stamped by registry.dispatch on a non-success breaker outcome (result.ok ? result : {...result, gated:true}). A successful breaker proceed is NOT marked. This is unambiguous and avoids fragile escalation-text matching."
  - "permission_denials are harvested synchronously during the stream line callback, then re-submitted to dispatch AFTER run() resolves — the async re-entry must not race the synchronous NDJSON line parser inside the runner."
  - "mapDenialToToolCall maps to {tool:'shell'} with the blocked command on args.op (so the breaker dry-run previews exactly what would run) and args.command (raw, for the audit). origin:'self' always — a CC denial is KERNEL's own sub-contractor, never external."
  - "The shim relies on --disallowedTools + permission_denials, NOT canUseTool/--permission-prompt-tool (a documented gap in stream-json print mode). The checkpoint confirmed --disallowedTools is the correct flag spelling at the installed version."

patterns-established:
  - "A CC sub-session's Red surface re-enters the KERNEL chokepoint via the result event; the shim itself executes NOTHING — it re-submits to dispatch"
  - "The obstacle ladder wraps dispatch, never bypasses the gate (BRAIN-06 preserved); Red gates leave the ladder immediately and belong to the breaker/Pravin"

requirements-completed: [SAFE-05, SAFE-06]

# Metrics
duration: 5 min
completed: 2026-06-22
---

# Phase 5 Plan 02: Claude Code Red Re-submission Shim + Obstacle Planner Ladder Summary

**A Claude Code session now runs with bypass-proof `--disallowedTools` Red deny rules whose `permission_denials` each re-enter the SAME 05-01 breaker (origin:'self', gated — never auto-run), and a pure injectable obstacle ladder (try → replan → decompose → backoff → escalate-with-a-specific-recommendation) where only a Red gate skips straight to escalate — zero new packages, full 212-test suite green.**

## Performance

- **Duration:** 5 min
- **Started:** 2026-06-22T17:22:55Z
- **Completed:** 2026-06-22T17:27:49Z
- **Tasks:** 2 (both TDD) + 1 pre-cleared checkpoint
- **Files modified:** 6 (2 created, 4 modified)

## Accomplishments
- **SAFE-05 — CC Red shim:** `argvFor` now carries `--disallowedTools` with `RED_DENY` (`Bash(rm *)`, `Bash(rmdir *)`, `Bash(*install*)`, `Bash(*git push*)`, `Bash(sudo *)`) — enforced even under a `--dangerously-skip-permissions` bypass — WHILE retaining the shipped Green/Yellow read-only fence (`--permission-mode dontAsk --allowedTools Read --bare`). Each `permission_denials` entry in the final result event maps to a `{tool:'shell', args:{op,command}, origin:'self'}` ToolCall and RE-ENTERS the injected `dispatch` (registry.dispatch) exactly once per denial, so a mid-session `rm -rf`/`npm install`/purchase routes to the SAME breaker (05-01) and is owner-gated — the shim itself executes NOTHING.
- **SAFE-06 — obstacle ladder:** `runLadder` climbs TRY → REPLAN (brain proposes approach B) → DECOMPOSE (brain splits into sub-steps, each dispatched) → RETRY-WITH-BACKOFF (exponential `base, base*2, base*4…` on the injected clock) → ESCALATE with a SPECIFIC recommendation of the shape `"<goal> blocked by <reason>; I recommend <recommendation>. Approve?"` — never the vague "I'm stuck".
- **SAFE-06 — Red-skip:** a dispatch result carrying `gated:true` (a Red gate the breaker escalated) makes the ladder SKIP every rung and escalate immediately — proven: dispatch called exactly once, zero replan/decompose, zero backoff sleeps.
- The ladder WRAPS dispatch and never bypasses the gate (BRAIN-06 invariant preserved); every impure dep (dispatch, brain, clock) is injected so the state machine is 100% unit-testable with no real cloud call and no real timer.

## Task Commits

Each task was committed atomically (TDD: test → feat):

1. **Task 1 (RED): failing SAFE-05 tests** — `cbc30ec` (test)
2. **Task 1 (GREEN): CC Red shim — disallowedTools + permission_denials re-entry** — `ee85639` (feat)
3. **Task 2 (GREEN): obstacle ladder + Red-skip** — `dee459e` (feat)

_Task 2's RED state was the absent `ladder.ts` module (import failure); GREEN added the module + the additive `ToolResult.gated` discriminator together._

## Files Created/Modified
- `daemon/src/planner/ladder.ts` - NEW. The obstacle ladder state machine; exports `runLadder`, `LadderDeps`, `LadderOutcome`, `LadderBrain`, `LadderClock`. Wraps dispatch; Red gates skip the ladder.
- `daemon/src/planner/ladder.test.ts` - NEW. Injected-failure/mock-brain/fake-clock tests asserting every rung, growing backoff, the specific escalation shape, and the Red-skip.
- `daemon/src/tools/claude-code.ts` - Added `RED_DENY`, exported `argvFor` (now appends `--disallowedTools`), `PermissionDenial`/`mapDenialToToolCall`, `dispatch` seam on `RunSessionDeps`, `permission_denials` harvest + per-denial re-entry with a transcript line.
- `daemon/src/tools/claude-code.test.ts` - Added 4 SAFE-05 tests (argv deny rules + fence retention; mapDenialToToolCall origin:self; per-denial re-entry never-auto-run; absent/malformed tolerance).
- `daemon/src/tools/Tool.ts` - Added the additive optional `ToolResult.gated` marker (SAFE-06 Red-gate discriminator).
- `daemon/src/tools/registry.ts` - The gated arm now stamps `gated:true` on a non-success breaker outcome so the ladder can detect a Red gate.

## SAFE-05 + SAFE-06 Proofs (all GREEN)

| Invariant | Test | Result |
|-----------|------|--------|
| SAFE-05: argv carries the Red deny rules under bypass + retains the read-only fence | `SAFE-05: argvFor carries the --disallowedTools Red deny rules AND retains the Green/Yellow read-only fence` | PASS |
| SAFE-05: a denial maps to origin:'self' (gated, not hard-blocked) | `SAFE-05: mapDenialToToolCall builds a {tool, args:{op,...}, origin:"self"} ToolCall` | PASS |
| SAFE-05: each permission_denial RE-ENTERS dispatch once, never auto-runs | `SAFE-05: a permission_denials result event RE-ENTERS the injected dispatch once per denial (origin:self), never auto-runs` | PASS |
| SAFE-05: absent/malformed permission_denials tolerated | `SAFE-05: an absent/malformed permission_denials field is tolerated (no dispatch, no throw)` | PASS |
| SAFE-06: first-try success short-circuits at TRY | `SAFE-06: a call that succeeds on the first try returns success with NO escalation` | PASS |
| SAFE-06: full ladder climbs to a SPECIFIC recommendation (growing backoff) | `SAFE-06: injected transient failures climb TRY->REPLAN->DECOMPOSE->BACKOFF->ESCALATE with a SPECIFIC recommendation` | PASS |
| SAFE-06: a Red gate SKIPS the ladder, escalates immediately | `SAFE-06: a Red gate/deny verdict SKIPS the ladder and escalates immediately (no retry, no backoff)` | PASS |
| SAFE-06: a transient obstacle that clears on retry recovers | `SAFE-06: a transient obstacle that clears on a backoff retry returns success` | PASS |

**Test totals:** 212 passed / 0 failed (204 prior + 4 SAFE-05 + 4 SAFE-06). `npm run build` clean. Zero new package.json dependencies.

## Decisions Made
See `key-decisions` frontmatter. The load-bearing ones: (1) the ladder's Red-gate signal is an additive `ToolResult.gated` boolean stamped by `registry.dispatch` on a non-success breaker outcome — unambiguous, no fragile text matching; (2) `permission_denials` are harvested synchronously during the line callback then re-submitted after `run()` resolves so the async re-entry never races the NDJSON parser.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added an additive `ToolResult.gated` marker for an unambiguous Red-gate signal**
- **Found during:** Task 2 (the ladder's Red-skip rung needed to distinguish a Red gate from a transient failure)
- **Issue:** `ToolResult` had no field distinguishing a Red gate/deny verdict (which must SKIP the ladder) from a plain transient `{ok:false, escalation}` (which must be retried). The breaker returns the same `{ok:false, escalation}` shape for both cancel/ceiling/TOCTOU escalations and there was no marker to key the ladder's skip on. Matching escalation text would be fragile.
- **Fix:** Added an additive optional `gated?: boolean` to `ToolResult` (tools/Tool.ts) and stamped it in `registry.dispatch`'s gated arm: `return result.ok ? result : { ...result, gated: true }`. A successful breaker proceed is NOT marked. The ladder reads `result.gated === true` to skip.
- **Files modified:** daemon/src/tools/Tool.ts, daemon/src/tools/registry.ts
- **Verification:** The SAFE-06 Red-skip test passes (dispatch once, zero retries/backoff); the full 212-test suite stays green (the field is optional + ignored by every existing consumer).
- **Committed in:** dee459e (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking).
**Impact on plan:** The marker was required for the SAFE-06 Red-skip to be correct and unambiguous — it is a backward-compatible discriminator (optional, ignored by existing consumers), not scope creep. No architectural change.

## Issues Encountered
- The initial `ladder.test.ts` mock brain used `Object.assign(brain, state, {getters})` which froze the counters at 0 (object-literal getters are copied as evaluated values by `Object.assign`). Replaced with a plain object whose methods increment its own counter fields — a test-only fix, no production impact.

## Checkpoint (pre-cleared)
The plan's `checkpoint:human-verify` (confirm the installed `claude` permission-flag spelling) was **pre-cleared** in the runtime facts. Confirmed at execution time: `claude --help` reports `--disallowedTools, --disallowed-tools <tools...>` and `--allowedTools, --allowed-tools <tools...>`; `claude` is present at `/Users/pravinmaurya/.local/bin/claude`. Task 1 uses `--disallowedTools` accordingly. Per the runtime facts the shim does NOT rely on the `canUseTool`/`--permission-prompt-tool` callback (documented stream-json print-mode gap) and instead surfaces `permission_denials` back into `gate.authorize` via dispatch (origin:'self').

## Threat Flags
None — all new surface (the `--disallowedTools` deny rules, the `permission_denials` re-entry, `mapDenialToToolCall`, the ladder, the additive `ToolResult.gated` marker) is in the plan's `<threat_model>` register (T-05-08..T-05-11, T-05-SC). No new endpoints, auth paths, or trust-boundary schema changes beyond what was planned. No new packages (T-05-SC: nothing to slopcheck).

## Next Phase Readiness
- 05-03 (self-maintenance / loop polish) can call `runLadder` for non-Red obstacles; the unit-tested state machine is the deliverable and loop.ts integration is optional polish (not done in this plan, per the plan's note).
- The CC Red shim's `dispatch` seam defaults to the real `registry.dispatch`; the IPC server wiring that surfaces a re-gated CC action's breaker.preview to the Face is the same server-side wiring deferred from 05-01.
- `KERNEL_BREAKER_ENABLED=true` is still the activation flag the re-entered Red calls reach.

---
*Phase: 05-safety-self-maintenance-gated-do-not-auto-execute*
*Completed: 2026-06-22*

## Self-Check: PASSED
- All 2 created files (planner/ladder.ts, planner/ladder.test.ts) + the 4 modified files verified present on disk.
- All 3 task commits (cbc30ec, ee85639, dee459e) verified in git log.
- `npm test` 212/212 green; `npm run build` clean; zero new package.json dependencies.
