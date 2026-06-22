---
phase: 03-brain-voice-the-cloud
plan: 01
subsystem: api
tags: [anthropic-sdk, ollama, claude-code, brain-provider, ipc, zod, cue-assembler, tts-choreography, manual-tool-loop]

# Dependency graph
requires:
  - phase: 01-skeleton
    provides: "BrainProvider swap-seam + StubBrain, loop.setBrain + gated dispatch (decide→dispatch→gate.authorize), frozen FrameSchema (SpeakSchema with cues[]), UDS NDJSON server"
  - phase: 02-hands-safety
    provides: "registry.dispatch chokepoint, gate.authorize (classify-only, credential fence, Red=deny), tiers.ts Green/Yellow/Red matrix"
provides:
  - "ClaudeBrain — default brain (claude-opus-4-8) via @anthropic-ai/sdk with a MANUAL tool loop (stop_reason tool_use → ONE Decision.action; the loop gates+executes)"
  - "LocalBrain — Ollama /api/chat (qwen2.5:7b-instruct-q4_K_M), absent-tolerant typed escalations"
  - "ClaudeCodeBrain — headless `claude -p --output-format json --bare`, Green/Yellow-only, zero-dep node:child_process"
  - "helper.ts — always-on 7B helper (triage/classify/narrate) beside the providers, neutral defaults on absence"
  - "ipc/cues.ts — daemon-side cue assembler: reply + widget plan → SpeakSchema-valid speak frame with char-offset cues, no timing"
  - "settings.ts — brain=cloud|local applied via the existing loop.setBrain seam"
  - "Additive IPC arms: SettingsSchema (Face→daemon brain toggle) + UiStateSchema (daemon→Face cloud scene state)"
  - "decision.ts — shared parseDecision(raw) reusing the frozen DecisionSchema"
affects: [03-02, 03-03, 03-04, phase-04-routines-finance, phase-05-circuit-breaker]

# Tech tracking
tech-stack:
  added: []  # zero new dependencies — @anthropic-ai/sdk, zod, pino already installed; fetch + node:child_process are native
  patterns:
    - "Manual tool loop (BRAIN-06): brain returns ONE Decision.action, the loop's dispatch→gate.authorize executes it — never the SDK auto tool-runner"
    - "Absent-tolerant external clients: probe-then-escalate (rejected fetch / non-zero exit / garbled stdout → typed escalation, never throw across the loop boundary) — mirrors tools/peekaboo.ts"
    - "Test-injection seams: __setClientForTest (ClaudeBrain) / __setRunnerForTest (ClaudeCodeBrain) / globalThis.fetch swap (LocalBrain, helper) — every brain unit-tested with the SDK/HTTP/CLI mocked"
    - "Daemon-side choreography producer: char-offset cues shipped up front in one speak frame; the Face's TTS clock is the metronome (daemon never sends timing)"
    - "Additive-only FrameSchema extension: new arms appended to the discriminated union, existing arms never mutated (the Swift Face mirrors them)"

key-files:
  created:
    - daemon/src/brain/ClaudeBrain.ts
    - daemon/src/brain/LocalBrain.ts
    - daemon/src/brain/ClaudeCodeBrain.ts
    - daemon/src/brain/helper.ts
    - daemon/src/brain/decision.ts
    - daemon/src/ipc/cues.ts
    - daemon/src/settings.ts
    - daemon/src/brain/ClaudeBrain.test.ts
    - daemon/src/brain/LocalBrain.test.ts
    - daemon/src/brain/ClaudeCodeBrain.test.ts
    - daemon/src/brain/helper.test.ts
    - daemon/src/ipc/cues.test.ts
    - daemon/src/settings.test.ts
  modified:
    - daemon/src/ipc/protocol.ts
    - daemon/src/ipc/protocol.test.ts
    - daemon/src/ipc/server.ts
    - daemon/src/loop.ts
    - daemon/test/skeleton.e2e.test.ts

key-decisions:
  - "ClaudeCodeBrain uses zero-dep node:child_process spawn (NOT execa) — avoids a dependency + its legitimacy checkpoint"
  - "ClaudeCodeBrain fenced Green/Yellow-only via --permission-mode dontAsk + --allowedTools Read; the Red re-submission shim is deferred to Phase 4 (CC-03)"
  - "The NO-AUTO-RUNNER grep gate is a literal grep over src/brain/ — the ClaudeBrain doc comment was rephrased to avoid the forbidden identifiers while still documenting the prohibition"
  - "The BRAIN-06 anti-bypass e2e drives the loop directly (enqueue + runTick) instead of a second IPC server, avoiding socket-path contention with the prior test"
  - "Added a read-only getActiveBrain() test-seam to loop.ts so settings.test can assert which brain the toggle selected (no semantics change)"

patterns-established:
  - "Brain provider impl: implements BrainProvider, named model constant (CLAUDE_MODEL / OLLAMA_MODEL / CLAUDE_CLI), test-injection seam, parseDecision for JSON-text brains"
  - "Always-on helper sits BESIDE the providers (not a BrainProvider, never swapped) — neutral defaults on Ollama absence"
  - "Cue assembler: present cue per planned widget at its phrase offset, sorted ascending, onFinish dissolves the last-presented widget"

requirements-completed: [BRAIN-02, BRAIN-03, BRAIN-04, BRAIN-05, BRAIN-06, VOICE-02, CLOUD-04, CLOUD-01]

# Metrics
duration: 19 min
completed: 2026-06-22
---

# Phase 3 Plan 01: Daemon Brains + Cue Assembler + Brain-Swap Settings Summary

**Four pluggable brains (ClaudeBrain default with a manual gated tool loop, LocalBrain over Ollama, headless ClaudeCodeBrain, always-on 7B helper) plus a daemon-side TTS cue assembler and a brain=cloud|local Settings path — all behind the existing swap-seam, with zero new dependencies and the full daemon suite green at 105 tests.**

## Performance

- **Duration:** 19 min
- **Started:** 2026-06-22T11:09:00Z
- **Completed:** 2026-06-22T11:28:00Z
- **Tasks:** 3
- **Files modified:** 18 (13 created, 5 modified)

## Accomplishments
- **ClaudeBrain** (default, `claude-opus-4-8`): a text turn → `Decision.reply`; a `stop_reason:'tool_use'` turn → exactly ONE `Decision.action {tool,args}` and **no tool executed inside `reason()`** — the loop's `dispatch → gate.authorize` stays the chokepoint (BRAIN-02, BRAIN-06).
- **LocalBrain** (Ollama `/api/chat`, `qwen2.5:7b-instruct-q4_K_M`, `format:'json'`, `keep_alive` omitted): parses `message.content` → Decision; ECONNREFUSED → typed "Ollama not running" escalation; a "model not found" body → exact `ollama pull …` escalation — never throws (BRAIN-03).
- **ClaudeCodeBrain** (`claude -p --output-format json --bare`, zero-dep spawn): parses `.result` → `Decision.reply`; Green/Yellow-only via `--permission-mode dontAsk` + `--allowedTools Read`; non-zero exit / garbled stdout → typed escalation (BRAIN-04, T-03-05).
- **helper.ts** always-on 7B (`triage`/`classify`/`narrate`): neutral defaults when Ollama is absent, never blocks the loop, NOT a BrainProvider, unaffected by the toggle (BRAIN-05).
- **ipc/cues.ts** cue assembler: `assembleSpeak(id, reply, widgetPlan)` → a SpeakSchema-valid `speak` frame with char-offset cues sorted ascending, `onFinish` dissolving the last-presented widget, no timing ever emitted (CLOUD-04).
- **settings.ts** + IPC wiring: a `settings` frame swaps the active brain via `loop.setBrain`; additive `SettingsSchema` + `UiStateSchema` arms round-trip the frozen `FrameSchema` (CLOUD-01).
- Extended e2e proves utterance → mock ClaudeBrain → reply over IPC + a producible speak frame, and that a `Decision.action` reaches the gated dispatch (VOICE-02, BRAIN-06).

## Task Commits

Each task was committed atomically:

1. **Task 1 (Wave 0 + RED): test scaffolds, decision parser, additive IPC arms** — `597958f` (test)
2. **Task 2 (GREEN): brains + 7B helper + manual tool loop** — `7fb0c4a` (feat)
3. **Task 3 (GREEN): cue assembler, settings brain-swap wiring, e2e** — `557052e` (feat)

## Files Created/Modified
- `daemon/src/brain/ClaudeBrain.ts` — default brain, manual tool loop, `__setClientForTest` seam, `CLAUDE_MODEL='claude-opus-4-8'`
- `daemon/src/brain/LocalBrain.ts` — Ollama `/api/chat` client, absent-tolerant, `OLLAMA_MODEL` constant
- `daemon/src/brain/ClaudeCodeBrain.ts` — headless `claude -p` via `node:child_process`, `__setRunnerForTest` seam, Green/Yellow fence
- `daemon/src/brain/helper.ts` — standalone `triage`/`classify`/`narrate`, neutral defaults on absence
- `daemon/src/brain/decision.ts` — `parseDecision(raw)` reusing the frozen `DecisionSchema`
- `daemon/src/ipc/cues.ts` — `assembleSpeak` cue assembler + `WidgetPlanItem`
- `daemon/src/settings.ts` — `applySettings(brain)` via `loop.setBrain`
- `daemon/src/ipc/protocol.ts` — additive `SettingsSchema` + `UiStateSchema` arms + exported types
- `daemon/src/ipc/server.ts` — additive `settings` arm in `defaultFrameHandler` calling `applySettings`
- `daemon/src/loop.ts` — added read-only `getActiveBrain()` test seam (no semantics change)
- `daemon/test/skeleton.e2e.test.ts` — two new Phase-3 cases (reply + speak producible; action reaches gated dispatch)
- (+ the six brain/cue/settings `*.test.ts` files and the extended `protocol.test.ts`)

## Decisions Made
- **Zero new dependencies:** chose `node:child_process` over `execa` for ClaudeCodeBrain — avoids both a dependency and the `execa` slopcheck/legitimacy checkpoint flagged in the threat model (T-03-SC). `@anthropic-ai/sdk`, `zod`, `pino` were already installed; `fetch` is native.
- **Green/Yellow-only ClaudeCodeBrain:** `--permission-mode dontAsk` + `--allowedTools Read` this phase; the Red re-submission shim is deferred to Phase 4 (CC-03 / T-03-05).
- **BRAIN-06 anti-bypass e2e via the loop directly:** the action-reaches-dispatch proof uses `enqueue` + `runTick` rather than a second IPC server, which both removes socket-path contention and tightens the proof (the brain returns the action, the *loop* gates+executes it).
- **getActiveBrain() test seam:** a read-only getter added to `loop.ts` so `settings.test` can assert the selected brain class without changing queue/drain/gate semantics.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] NO-AUTO-RUNNER grep gate tripped by a doc-comment reference**
- **Found during:** Task 2 (brain implementations)
- **Issue:** The plan's verify gate is a literal `grep -RnE 'toolRunner|runTools|betaToolRunner' src/brain/`. The ClaudeBrain doc comment *named* the forbidden identifiers to document the prohibition, which tripped the gate (it cannot distinguish a comment from a call).
- **Fix:** Rephrased the comment to "the SDK's auto tool-execution helper is FORBIDDEN here" — the prohibition stays documented; the literal identifiers are gone. The brain never calls any auto-runner; it only returns a `Decision.action`.
- **Files modified:** `daemon/src/brain/ClaudeBrain.ts`
- **Verification:** grep gate prints `NO-AUTO-RUNNER-OK`; all 11 brain tests green.
- **Committed in:** `7fb0c4a` (Task 2 commit)

**2. [Rule 1 - Bug] Action-reaches-dispatch e2e timed out on a second IPC-server bind**
- **Found during:** Task 3 (extended e2e)
- **Issue:** The third e2e case stood up a second `startIpcServer()` on the same `config.socketPath` immediately after the prior test's `server.close()`; the socket teardown raced the new bind and `waitFor(ready)` hung to the 30s test timeout (the gate logic itself ran correctly — the log showed `screenshot` classified green + the session logged).
- **Fix:** Rewrote the case to drive the loop directly (`enqueue` + `runTick`) with a registered sentinel tool, asserting `execute` is reached only through `dispatch` (after `gate.authorize`) and that the brain's `action.args` arrive intact. No IPC server needed for this proof.
- **Files modified:** `daemon/test/skeleton.e2e.test.ts` (added `enqueue` import)
- **Verification:** e2e file EXIT=0, 3/3 pass; full suite 105/105 green.
- **Committed in:** `557052e` (Task 3 commit)

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 bug)
**Impact on plan:** Both fixes were necessary to clear the plan's own verify gates (the grep gate and the green suite). No scope creep — no schema arms mutated, no loop/router/gate semantics changed.

## TDD Gate Compliance
This is a `type: execute` plan with `tdd="true"` tasks, executed Wave-0-RED → GREEN:
- RED gate: `test(03-01): RED scaffolds…` — `597958f` (protocol.test green; five brain/cue/settings scaffolds fail only on missing modules).
- GREEN gates: `feat(03-01): brains…` — `7fb0c4a`; `feat(03-01): cue assembler, settings…` — `557052e`.
Gate sequence present and ordered (test → feat → feat).

## Issues Encountered
None beyond the two auto-fixed deviations above.

## Known Stubs
None. ClaudeBrain/LocalBrain/ClaudeCodeBrain are fully implemented against their real transports (SDK / Ollama HTTP / `claude` CLT); they are exercised in tests with those transports **mocked** by design (the Wave-0 strategy — no live key/Ollama/network this session). The absent-tolerant escalation replies are intended behavior, not stubs. Live cloud/local/Claude-Code runs are documented manual owner checks in `03-USER-SETUP.md`.

## User Setup Required
**External services require manual configuration.** See [03-USER-SETUP.md](./03-USER-SETUP.md) for:
- `ANTHROPIC_API_KEY` (ClaudeBrain default + ClaudeCodeBrain `--bare` auth)
- Ollama install + `ollama pull qwen2.5:7b-instruct-q4_K_M` (optional — LocalBrain + 7B helper degrade gracefully without it)
- Verification commands

Note: NONE of these are required for the automated phase gate — the daemon builds and the full 105-test suite passes with all transports mocked.

## Threat Flags
None. No new network endpoint, auth path, file-access pattern, or trust-boundary schema change was introduced beyond the additive IPC arms already covered by the plan's `<threat_model>` (T-03-04 — `safeParse`-per-line preserved, proven by the protocol round-trip tests).

## Next Phase Readiness
- The daemon half of talk→reason→respond is closed: utterance → brain → reply over IPC, with `Decision.action` reaching the gated dispatch (gate still the single chokepoint).
- Ready for **03-02/03-03/03-04** (the Swift Face: Xcode project, NWConnection NDJSON client, dual-paced Stage controller, Metal particle cloud). The Face mirrors the now-frozen-plus-additive `FrameSchema` (`settings`, `ui.state`, `speak{cues,onFinish}`).
- LYNCHPIN reminder for the Face waves: run the on-device `willSpeakRangeOfSpeechString` boundary spike FIRST (ROADMAP criterion 2) before building the full Stage.

## Self-Check: PASSED

- All 13 created files exist on disk (7 source modules + 6 test files).
- All 3 task commits exist in git history (`597958f`, `7fb0c4a`, `557052e`).
- `npm run build` compiles clean (BUILD_EXIT=0).
- `npm test` is green: **105 tests pass, 0 fail** (up from the 81/81 Phase-2 baseline).
- NO-AUTO-RUNNER grep gate over `src/brain/`: `NO-AUTO-RUNNER-OK`.

---
*Phase: 03-brain-voice-the-cloud*
*Completed: 2026-06-22*
