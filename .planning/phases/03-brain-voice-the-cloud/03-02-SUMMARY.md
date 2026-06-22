---
phase: 03-brain-voice-the-cloud
plan: 02
subsystem: voice
tags: [whisper, stt, subprocess, child_process, absent-tolerant, voice-01]

# Dependency graph
requires:
  - phase: 02-hands
    provides: "tools/peekaboo.ts probe-then-escalate pattern (the absent-tolerant seam mirrored here)"
  - phase: 03-brain-voice-the-cloud (plan 01)
    provides: "ClaudeCodeBrain zero-dep node:child_process runner-seam pattern; frozen Utterance frame in ipc/protocol.ts"
provides:
  - "Absent-tolerant whisper.cpp subprocess STT wrapper (transcribe) — binary-absent → typed escalation, never throws"
  - "parseTranscript(raw): whisper-cli stdout → single clean transcript string (timestamps stripped, segments joined, whitespace normalized)"
  - "__setSpawnForTest seam — wrapper/parser fully unit-testable with no binary and no mic"
affects: [phase-3-voice-live-path, phase-4-loop-utterance-wiring, face-mic-pcm-streaming]

# Tech tracking
tech-stack:
  added: []  # zero new dependencies — node:child_process is built-in
  patterns:
    - "Probe-then-escalate for absent subprocess binaries (mirrors tools/peekaboo.ts + ClaudeCodeBrain)"
    - "Runner seam (__setSpawnForTest) abstracting spawn → captured {code,stdout,stderr,error} for mockable, throw-free STT"
    - "Explicit argv array spawn (no shell string) so audio/model paths are never interpolated (T-03-07)"

key-files:
  created:
    - daemon/src/voice/whisper.ts
    - daemon/src/voice/whisper.test.ts
    - daemon/test/fixtures/whisper-stdout.txt
  modified:
    - .planning/phases/03-brain-voice-the-cloud/03-USER-SETUP.md

key-decisions:
  - "Used zero-dep node:child_process spawn (not execa) — consistent with 03-01 ClaudeCodeBrain; avoids a new dependency + its slopcheck/legitimacy checkpoint"
  - "Binary/model kept in env-overridable named constants (WHISPER_CLI / WHISPER_MODEL), not hardcoded-and-buried (RESEARCH A-series)"
  - "No new IPC frame added — a successful transcript is the text a future Utterance frame carries (Utterance is already frozen in ipc/protocol.ts)"

patterns-established:
  - "Absent-tolerant subprocess wrapper: spawn ENOENT / exit 127 / stderr ENOENT → typed { ok:false, escalation } (never throws across the loop boundary)"
  - "Runner-seam injection for spawn-based wrappers (mirrors peekaboo __setClientForTest, ClaudeCodeBrain __setRunnerForTest)"

requirements-completed: [VOICE-01]

# Metrics
duration: 10 min
completed: 2026-06-22
---

# Phase 3 Plan 02: Absent-Tolerant whisper.cpp STT Wrapper Summary

**Daemon-side `transcribe()` that spawns `whisper-cli` (explicit argv, zero-dep node:child_process), parses timestamped stdout into a clean transcript, and degrades to a typed escalation when the binary is absent — never crashing the loop. whisper.cpp is NOT installed here, so live mic transcription is a documented manual owner check.**

## Performance

- **Duration:** 10 min
- **Started:** 2026-06-22T11:18:00Z (approx)
- **Completed:** 2026-06-22T11:23:42Z
- **Tasks:** 2 (TDD: RED → GREEN)
- **Files modified:** 4 (3 created, 1 appended)

## Accomplishments
- `transcribe(input)` spawns `whisper-cli` as a subprocess (WAV path in, transcript out) per spec §7 — the daemon owns the spawn; the Face owns mic capture and streams 16kHz mono PCM / a temp WAV path.
- Binary-absent (spawn ENOENT / exit 127) returns a typed `{ ok:false, escalation:{ reason: "whisper.cpp not found — build it" } }`, never throwing across the loop boundary (T-03-06, Pitfall 5).
- `parseTranscript(raw)` strips `[hh:mm:ss --> hh:mm:ss]` segment scaffolding, joins segments, and normalizes whitespace to a single clean line — exercised on number-bearing segments (the known-flaky case: "4 PM", "250 dollars").
- All wrapper/parser logic verified with the binary mocked via `__setSpawnForTest` — no whisper.cpp and no mic required for the build or tests to pass.

## Task Commits

Each task was committed atomically (TDD RED → GREEN):

1. **Task 1 (RED): whisper wrapper tests + stdout fixture** - `df81569` (test)
2. **Task 2 (GREEN): absent-tolerant whisper.cpp subprocess wrapper (VOICE-01)** - `7b075f3` (feat)

**Plan metadata:** see final docs commit.

## Files Created/Modified
- `daemon/src/voice/whisper.ts` - Absent-tolerant whisper.cpp subprocess wrapper: `transcribe()`, `parseTranscript()`, `__setSpawnForTest` seam, env-overridable `WHISPER_CLI`/`WHISPER_MODEL` constants.
- `daemon/src/voice/whisper.test.ts` - Unit lane (spawn mocked): parse fixture, absent→escalation (no throw), clean stdout→{ok:true,transcript}.
- `daemon/test/fixtures/whisper-stdout.txt` - Realistic timestamped whisper-cli stdout fixture (includes number-bearing segments).
- `.planning/phases/03-brain-voice-the-cloud/03-USER-SETUP.md` - Appended a whisper.cpp service-setup section (build-from-source + WHISPER_CLI/WHISPER_MODEL overrides + the live-STT manual owner check).

## Decisions Made
- **Zero-dep `node:child_process` spawn (not execa):** consistent with the 03-01 ClaudeCodeBrain decision; avoids a new dependency and its slopcheck/legitimacy checkpoint. RESEARCH explicitly leaves this to Claude's discretion (A2/118).
- **Env-overridable named constants** (`WHISPER_CLI`, `WHISPER_MODEL`): configurable, not hardcoded-and-buried (RESEARCH A-series). Owner overrides via env; defaults are sensible.
- **No new IPC frame:** a successful transcript is the text the already-frozen `Utterance` frame (ipc/protocol.ts) carries — the wrapper produces the string, not a frame.
- **Explicit argv array spawn (no shell string):** the WAV/model paths are discrete args, never shell-interpolated (T-03-07 mitigation).

## Deviations from Plan

None - plan executed exactly as written.

The plan's threat-model mitigations were all satisfied in the GREEN implementation rather than as deviations: T-03-06 (probe-then-escalate, never throw) is proven by the absent test case; T-03-07 (no shell interpolation) is satisfied by the explicit `spawn(cmd, args[])` argv array; T-03-08 (transcript is external-sourced, still passes gate.authorize downstream) is preserved by adding no new frame and not bypassing the chokepoint — documented in the header comment.

## Issues Encountered
- The local `get-shit-done/bin/gsd-tools.cjs` path referenced in the workflow does not exist in this repo; the SDK is on PATH as `gsd-sdk` (`~/.local/bin/gsd-sdk`). Switched all SDK calls to `gsd-sdk`. No impact on the plan.

## Verification Results
- `cd daemon && npx tsx --test src/voice/whisper.test.ts` → 3 pass, 0 fail (parse + absent-escalation + success).
- `cd daemon && npm run build` (`tsc`) → compiles clean (exit 0).
- `cd daemon && npm test` (full suite) → **108 tests pass, 0 fail.**
- whisper.cpp confirmed absent (`command -v whisper-cli` → not found) — the absent path is the live behavior on this machine, exercised via the mocked spawn.

## User Setup Required
**whisper.cpp is absent on this machine.** See [03-USER-SETUP.md](./03-USER-SETUP.md) for the build-from-source steps and the `WHISPER_CLI`/`WHISPER_MODEL` overrides. None of it is required for the build or the automated suite (all wrapper/parser logic is mocked).

**Manual owner check (NOT automated):** build the Core ML/ANE whisper.cpp, put `whisper-cli` on PATH, supply a model, speak into the mic, and confirm a live transcript reaches the loop as an utterance (VOICE-01/02 live path).

## Next Phase Readiness
- The audio→text half of talk→reason (VOICE-01) is closed at the daemon seam; the loop-utterance wiring (Face PCM → daemon → whisper → Utterance frame) is the live integration deferred to the Face/loop work.
- Carried forward: live mic transcription accuracy + latency needs whisper.cpp built + mic + the Microphone TCC grant (manual owner check, already on the Phase-3 manual-check list).

## Self-Check: PASSED
- `daemon/src/voice/whisper.ts` — FOUND
- `daemon/src/voice/whisper.test.ts` — FOUND
- `daemon/test/fixtures/whisper-stdout.txt` — FOUND
- Commit `df81569` (test) — FOUND in git log
- Commit `7b075f3` (feat) — FOUND in git log

---
*Phase: 03-brain-voice-the-cloud*
*Completed: 2026-06-22*
