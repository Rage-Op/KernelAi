---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: verifying
last_updated: "2026-06-22T12:48:07.542Z"
last_activity: 2026-06-22
progress:
  total_phases: 5
  completed_phases: 3
  total_plans: 14
  completed_plans: 11
  percent: 60
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-06-22)

**Core value:** KERNEL persists and acts on Pravin's behalf without clocking out — holding memory across sessions, running routines, and routing work to the right tool, always behind a safety gate that makes "got robbed by a poisoned email" structurally impossible.
**Current focus:** Phase 1 — Skeleton (spec Phase 0)

## Current Position

Phase: 1 of 5 (Skeleton — spec Phase 0)
Plan: 3 of 3 in current phase
Status: Phase complete — ready for verification
Last activity: 2026-06-22

Progress: [████████░░] 79%

## Performance Metrics

**Velocity:**

- Total plans completed: 0
- Average duration: — min
- Total execution time: 0.0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

**Recent Trend:**

- Last 5 plans: —
- Trend: —

*Updated after each plan completion*
| Phase 01 P01 | 6 min | 4 tasks | 20 files |
| Phase 01-skeleton P02 | 5min | 3 tasks | 8 files |
| Phase 01-skeleton P03 | 11 min | 4 tasks | 15 files |
| Phase 02-hands P01 | 12 min | 3 tasks | 9 files |
| Phase 02-hands P03 | ~14 min | 3 tasks | 7 files |
| Phase 03 P01 | 19 min | 3 tasks | 18 files |
| Phase 03-brain-voice-the-cloud P02 | 10 min | 2 tasks | 4 files |
| Phase 03-brain-voice-the-cloud P03 | 10 min | 3 tasks | 10 files |
| Phase 03-brain-voice-the-cloud P04 | 26 min | 3 tasks | 17 files |
| Phase 04-routines-claude-code-finance P01 | 38 min | 3 tasks | 16 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Roadmap]: Phase structure mirrors the spec's fixed §16 build order exactly — one GSD phase per spec phase (GSD 1-indexed, spec 0-indexed). Do not invent decomposition.
- [Roadmap]: Three cross-phase security seams pulled forward as acceptance criteria — provenance/quarantine (Phase 1), `gate.authorize` chokepoint (Phase 2), 4-layer finance-leak prevention (Phase 4, verified before any backup).
- [Roadmap]: Phase 5 (spec Phase 4) is GATED — enables money/`rm -rf`/`/override`. Build Phases 1–4 autonomously; HARD-STOP before Phase 5.
- [Phase 01]: Pinned all Phase-1 npm deps exactly (no caret); kernel-memory/ kept as a separate git repo via parent .gitignore
- [Phase ?]: inject() query is optional (e2e calls inject() no-arg); current.md is the query basis when omitted
- [Phase ?]: IDENTITY baseline auto-seeds on first run (idempotent) but never auto-re-baselines; out-of-band change fails loud
- [Phase ?]: External content excluded from injection by BOTH retrieve authority 0.0 AND inject source filter (defense-in-depth)
- [Phase ?]: Memory modules take memoryDir as a defaulted param (config.memoryDir) for temp-dir unit testing
- [Phase 01-skeleton]: Loop never imports the IPC server: replies surface via an intent.reply callback the server supplies (server->loop via enqueue only, no cycle)
- [Phase 01-skeleton]: drain() returns the in-flight promise when a pass is running (callers await completion) rather than returning early — keeps the single-pass guard while giving deterministic tick semantics
- [Phase 01-skeleton]: Heartbeat launchd job hangs in node startup on this machine (node-under-launchd quirk, not a code defect); heartbeat write path verified under a launchd-identical env — recorded as a documented manual owner check
- [Phase 02-hands]: Red-tier in Phase 2 = deny + escalate (LOCKED); the gated Verdict arm is reserved so Phase 5 only edits gate.authorize internals, never the router/tools/loop — No Red autonomy before the Phase-5 breaker; single-chokepoint dispatch with central tier classification and a hard credential fence
- [Phase 02-hands]: Added an OPTIONAL Tool.surfaceSignals pre-authorize hook (run by registry.dispatch BEFORE the gate) so the browser fill op surfaces live DOM secure-field signals (type/autocomplete/label) into ToolCall.args for the credential fence — the fence can refuse a password field before .fill() without bypassing the single dispatch chokepoint; backward-compatible (Peekaboo/stub omit it) — HANDS-05 for the browser needs the fence to classify live-DOM signals only the adapter can read, and that read must precede gate.authorize
- [Phase 03]: ClaudeCodeBrain uses zero-dep node:child_process (not execa) — Avoids a new dependency and its slopcheck/legitimacy checkpoint (T-03-SC); the claude -p JSON contract is stable
- [Phase 03]: ClaudeCodeBrain fenced Green/Yellow-only (--permission-mode dontAsk + --allowedTools Read) — BRAIN-04/T-03-05: no ambient money/irreversible rights this phase; Red re-submission shim deferred to Phase 4 (CC-03)
- [Phase 03]: Face is an Xcode project (NOT pure SwiftPM) maintained via XcodeGen (face/project.yml); committed .xcodeproj is the reproducible source of truth — TCC permanence needs Info.plist/entitlements + a stable signed identity (Pitfall 4); hand-writing a .pbxproj is fragile
- [Phase 03]: Boundary spike verdict on macOS 26.5 + Samantha: willSpeakRangeOfSpeechString callbacks FIRE and ranges are accurate including on numbers (2020 did NOT drift); word-level pacing is PRIMARY-viable, sentence-time fallback ships anyway (VOICE-04) — ROADMAP criterion 2 mandates the on-device spike precede the Stage; recorded in face/SPIKE-VERDICT.md which gates 03-04
- [Phase 03]: Automated xcodebuild gate runs CODE_SIGNING_ALLOWED=NO (no signing identity in the build env); owner's signed local build supplies the stable Developer-ID identity — security find-identity reports 0 identities; bundle id com.kernel.face stays stable regardless, which is the Pitfall-4-relevant part
- [Phase 03-brain-voice-the-cloud]: Face wiring uses a single @MainActor AppCoordinator owning cloud/stage/speaker/mic/socket + inbound-frame routing; runtime services (mic/socket) are guarded off under the XCTest host so CoreAudio doesn't hang the headless runner — Keeps the talk->reason->speak->choreograph loop auditable in one place; the CoreAudio HAL blocks with no audio device which otherwise hangs xcodebuild test
- [Phase 04-routines-claude-code-finance]: Routine presets use a presets: map (name -> step-id list) + full steps catalogue; a step runs when enabled AND listed by the active preset
- [Phase 04-routines-claude-code-finance]: email_reply only fills the email-preview widget; the Yellow send gate (ui.intent dispatch) lands in 04-02 — no auto-send path exists

### Pending Todos

[From .planning/todos/pending/ — ideas captured during sessions]

None yet.

### Blockers/Concerns

[Issues that affect future work]

- Phase 3 (spec P2) is the highest-risk lynchpin: an on-device spike of `AVSpeechSynthesizerDelegate.willSpeakRangeOfSpeechString` on the target macOS version and chosen voice MUST precede the full Stage controller build; ship both word-level and sentence-level pacing.
- Phase 3: IPC transport ambiguity (Unix domain socket vs localhost WebSocket) must be resolved — UDS is the recommended production path, localhost WebSocket the fallback.
- Phase 4 → Phase 5 transition gate: all four finance-leak prevention layers must be verified passing before any backup job (Phase 5) is built.
- Phase 5 is GATED: do not auto-execute. Explicit owner approval required before it begins.
- Owner manual launchd gate carried forward: (1) resolve node-under-launchd heartbeat startup hang + confirm on-schedule firing, (2) daemon relaunch-at-login, (3) Face UDS attach/detach/re-attach against the launchd-managed daemon, (4) IDENTITY tamper fail-loud check. Runbook: launchd/README.md + 01-03-SUMMARY.md.

## Deferred Items

Items acknowledged and carried forward from previous milestone close:

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| *(none)* | | | |

## Session Continuity

Last session: 2026-06-22T12:48:07.259Z
Stopped at: Completed 04-01-PLAN.md
Resume file: None
