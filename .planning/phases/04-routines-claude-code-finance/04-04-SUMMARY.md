---
phase: 04-routines-claude-code-finance
plan: 04
subsystem: ipc
tags: [claude-code, stream-json, ndjson, ipc, zod, swiftui, transcript, safety-gate, registry]

# Dependency graph
requires:
  - phase: 04-01
    provides: the cornerPill cloud state + the four widget cases + the frozen FrameSchema seam
  - phase: 03-brain-voice-the-cloud
    provides: ClaudeCodeBrain claude-CLI spawn discipline + __setRunnerForTest seam
  - phase: 02-hands
    provides: gate.authorize single chokepoint + central tier classification (Red=deny)
provides:
  - additive TranscriptSchema arm on the frozen FrameSchema (TS) mirrored byte-exact in Frames.swift (Swift)
  - daemon/src/tools/claude-code.ts — first-person prompt authoring + stream-json NDJSON runner + transcript-frame emit + registry append
  - TranscriptPill.swift — live scrollable Kernel↔Claude transcript in the cornerPill with a streaming pulse + pause control
  - AppCoordinator transcript buffer (partial-merge + pause) handling the new inbound arm
  - projects/registry.md cold-resume registry (append target seeded with a table header)
  - proof that a Red-tier Claude Code action is DENIED by the shipped gate (shim deferred to Phase 5)
affects: [phase-05-gated-actions, claude-code-resubmission-shim, cold-resume]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Additive IPC arm (Pattern 1): append a schema to the discriminatedUnion; never mutate an existing arm; assert no removed lines"
    - "stream-json NDJSON line-buffered parsing with an injected emit() seam (server supplies real emitter; tests capture)"
    - "partial-merge transcript buffer: a streaming claude chunk updates the in-progress line in place; a non-partial finalizes it"
    - "explicit-path registry write (never git add -A near the memory repo) for cold-resume metadata"

key-files:
  created:
    - daemon/src/tools/claude-code.ts
    - daemon/src/tools/claude-code.test.ts
    - face/Kernel/ClaudeCode/TranscriptPill.swift
    - face/KernelTests/TranscriptPillTests.swift
  modified:
    - daemon/src/ipc/protocol.ts
    - daemon/src/ipc/protocol.test.ts
    - daemon/src/safety/gate.test.ts
    - face/Kernel/IPC/Frames.swift
    - face/KernelTests/FrameCodecTests.swift
    - face/Kernel/AppCoordinator.swift
    - face/Kernel/CloudView/CloudWindow.swift
    - face/Kernel.xcodeproj/project.pbxproj
    - kernel-memory/projects/registry.md

key-decisions:
  - "First-person prompt authored as Pravin ('I need you to … in <repo>. <goal>') — direct register, never third-person 'Kernel'/'the user'"
  - "claude-code.ts reuses ClaudeCodeBrain's CLAUDE_CLI constant + __setRunnerForTest discipline but adds a line-buffered NDJSON StreamRunner with a per-line onLine callback"
  - "transcript merge model is role+partial aware: distinct frame ids per event, so a partial claude line is updated/finalized by replacing the last in-progress claude line rather than merging by id"
  - "registry write resolves its path lazily (KERNEL_MEMORY_DIR → sibling kernel-memory) instead of importing config.ts, so unit tests never require a present memory repo"
  - "Red-from-CC denial is proven via gate.test.ts coverage only — gate.ts is UNCHANGED (the shipped Red=deny already holds regardless of originator); the re-submission shim stays deferred to Phase 5"

patterns-established:
  - "Pattern 1 (additive IPC): TranscriptSchema appended to FrameSchema + a byte-exact Swift case transcript; FrameCodec + protocol tests prove existing arms unchanged"
  - "Defensive NDJSON: a malformed stream-json line is dropped, never thrown across the boundary (T-04-20)"
  - "TranscriptPill renders ONLY typed transcript text — no AsyncImage/URLRequest/WKWebView (T-04-19)"

requirements-completed: [CC-01, CC-02, CC-03, CC-04]

# Metrics
duration: 7min
completed: 2026-06-22
---

# Phase 4 Plan 4: Claude Code Bridge Summary

**First-person Claude Code prompting as Pravin, a stream-json NDJSON transcript over a new additive `transcript` IPC arm rendered in the cornerPill (scrollable, streaming pulse, pause), a cold-resume project registry, and a proven Red-from-CC gate denial — the last plan of Phase 4.**

## Performance

- **Duration:** 7 min
- **Started:** 2026-06-22T13:17:06Z
- **Completed:** 2026-06-22T13:23:42Z
- **Tasks:** 3
- **Files modified:** 13 (4 created, 9 modified; across 2 repos: main + kernel-memory)

## Accomplishments
- Added a strictly-additive `TranscriptSchema` arm to the frozen daemon `FrameSchema` and mirrored it byte-exact as `case transcript` in `Frames.swift` — existing arms provably unchanged (no removed lines; all prior protocol + FrameCodec tests still green).
- Built `daemon/src/tools/claude-code.ts`: authors a first-person prompt as Pravin (CC-01), runs `claude -p --output-format stream-json --include-partial-messages` behind the shipped Green/Yellow fence (`--permission-mode dontAsk --allowedTools Read`), parses NDJSON line-by-line, and pushes a transcript frame per event through an injected `emit()` seam (CC-02). Each session appends a row to `projects/registry.md` for cold resume (CC-04).
- Shipped `TranscriptPill.swift` in the cornerPill: a live, scrollable Kernel↔Claude transcript (newest at bottom, auto-scroll with manual scrollback), an accent live-pulse dot while streaming, and an owner pause control. `AppCoordinator` buffers the new inbound arm with partial-merge semantics.
- Proved CC-03: a Red-tier action proposed by a `claude-code` session classifies `red` and is DENIED by the shipped `gate.authorize` (no `gated`/`allow` arm); the re-submission shim stays deferred to Phase 5. `gate.ts` was not modified — only coverage added.

## Task Commits

Each task was committed atomically:

1. **Task 1 (RED): failing tests for the transcript arm + CC bridge + Red-from-CC deny** - `3cb56eb` (test)
2. **Task 1 (GREEN): additive transcript IPC arm + first-person CC bridge + stream-json runner + registry** - `355c244` (feat) + kernel-memory `f26284a` (registry seed)
3. **Task 2: mirror the transcript arm in Frames.swift + FrameCodec round-trip** - `4846171` (feat)
4. **Task 3: TranscriptPill in the cornerPill + AppCoordinator transcript buffer + pause** - `fd0bc20` (feat)

_Note: this is a `type: tdd` plan — Task 1 split into a test (RED) commit then an implementation (GREEN) commit._

## Files Created/Modified
- `daemon/src/ipc/protocol.ts` - appended `TranscriptSchema` + the FrameSchema union entry + a `Transcript` type export (append-only)
- `daemon/src/tools/claude-code.ts` - first-person prompt authoring, stream-json NDJSON runner, transcript-frame emit seam, registry append
- `daemon/src/tools/claude-code.test.ts` - CC-01/02/04 coverage via a mock stream runner (never spawns a real claude)
- `daemon/src/ipc/protocol.test.ts` - transcript safeParse + malformed-rejection coverage
- `daemon/src/safety/gate.test.ts` - CC-03 Red-from-CC denial coverage
- `face/Kernel/IPC/Frames.swift` - `case transcript` + `TranscriptRole` enum + `role`/`partial` CodingKeys (byte-exact mirror)
- `face/KernelTests/FrameCodecTests.swift` - transcript round-trip (both roles, partial true/false/absent) + malformed-tolerated
- `face/Kernel/ClaudeCode/TranscriptPill.swift` - the scrollable cornerPill transcript view (pulse + pause)
- `face/Kernel/AppCoordinator.swift` - `.transcript` inbound case, `transcriptLines` buffer (partial-merge), `transcriptStreaming`/`transcriptPaused` flags, `toggleTranscriptPause()`
- `face/Kernel/CloudView/CloudWindow.swift` - hosts the `TranscriptPill` inside the existing `pillBody`
- `kernel-memory/projects/registry.md` - seeded the cold-resume table header (append target)

## Decisions Made
- See `key-decisions` frontmatter. Notably: `gate.ts` is unchanged — the Red-from-CC denial is the shipped behavior; this plan only adds proving coverage. The registry path resolves lazily (env → sibling) so tests never require a live memory repo.

## Deviations from Plan

None - plan executed exactly as written. No bugs, missing-critical functionality, or blockers required auto-fixes. The additive-only and Red-deny invariants held as designed.

**Total deviations:** 0
**Impact on plan:** None — all four requirements (CC-01..CC-04) met as specified; the threat register dispositions (T-04-17..T-04-21) are all satisfied.

## TDD Gate Compliance
- Task 1 (`tdd="true"`): RED commit `3cb56eb` (tests fail — no arm / no module), then GREEN commit `355c244` (implementation passes). Gate sequence satisfied.
- Task 3 (`tdd="true"`): the TranscriptPillTests assertions encode the merge/pulse/pause semantics and drove the implementation, but the test + source landed in one commit (`fd0bc20`) because Swift compiles the whole test target — a test referencing a not-yet-existing `TranscriptPill`/`AppCoordinator` member cannot compile to produce a clean RED. The behavior is still test-driven (the tests define the contract); the single-commit shape is a Swift-target compilation constraint, not a skipped gate.

## Issues Encountered
- One non-deterministic failure surfaced once in a full `npm test` run (a leakguard/git-touching test under concurrent execution). Two subsequent clean back-to-back runs returned 176/176. This is a pre-existing test-infrastructure flake unrelated to this plan's changes (out of scope per the scope boundary) — not a regression introduced here.

## Manual Owner Check (documented, deferred to the owner)
- A LIVE Claude Code session (real `claude` CLI, real repo) is an owner manual check per 04-UI-SPEC: transcript readability over the moving cloud, real streaming cadence, pause feel, and scrollback during a real session. The automated proof uses a mock stream runner (never spawns a real `claude`).

## Next Phase Readiness
- Phase 4 is COMPLETE (all four plans summarized). The Claude Code bridge ships Green/Yellow-only with a proven Red denial.
- **Phase 5 is GATED** (money / `rm -rf` / `/override`): explicit owner approval required before it begins. The Red re-submission shim (routing a Red CC action UP to KERNEL's gate for owner approval) is the deferred Phase-5 work this plan set up but intentionally did not build.
- Carried-forward gate: all four finance-leak prevention layers must be verified passing before any backup job (Phase 5) is built; owner launchd manual checks remain open.

## Self-Check: PASSED

- Created files exist on disk: `daemon/src/tools/claude-code.ts`, `daemon/src/tools/claude-code.test.ts`, `face/Kernel/ClaudeCode/TranscriptPill.swift`, `face/KernelTests/TranscriptPillTests.swift` — all FOUND.
- Commits exist: `3cb56eb` (test), `355c244` (feat), `4846171` (feat), `fd0bc20` (feat), plus kernel-memory `f26284a` (registry) — all FOUND.
- Verification re-run: daemon focused 22/22, daemon full 176/176 (≥108), Face 41/41, additive-only guard NONE removed, CC-03 Red-from-CC deny test green.

---
*Phase: 04-routines-claude-code-finance*
*Completed: 2026-06-22*
