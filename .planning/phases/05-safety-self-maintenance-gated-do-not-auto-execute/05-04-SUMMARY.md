---
phase: 05-safety-self-maintenance-gated-do-not-auto-execute
plan: 04
subsystem: infra
tags: [safety, circuit-breaker, ipc-broadcast, breaker-preview, breaker-cancel, human-in-the-loop, face-card, gap-closure]

# Dependency graph
requires:
  - phase: 05 (SAFETY) plan 01
    provides: the pure injectable breaker (safety/breaker.ts) with emitPreview + cancelled deps; registry defaultBreakerDeps + setBreakerDeps/signalBreakerCancel seams; the additive breaker.preview/breaker.cancel/override IPC frames + their Swift mirror
  - phase: 01 (CORE)
    provides: the UDS NDJSON IPC server (ipc/server.ts startIpc/send) + the Face KernelSocket/FrameCodec + the EmailPreviewWidget glass-card pattern + Tokens/Motion design system
provides:
  - "ipc/server.ts broadcast(frame): fans a frame out to EVERY connected Face client; tracks the client set on connect/close/error; returns the delivered count (0 == headless)"
  - "Production breaker emitPreview REAL wiring: registry.defaultBreakerDeps now broadcasts breaker.preview over the live IPC server (no longer a no-op) with a correlation id"
  - "breaker.cancel server route: an inbound breaker.cancel{id} frame flips the breaker cancel latch ONLY when its id matches the active preview (stale-id cancels ignored)"
  - "override server route: an inbound override frame activates/deactivates the scoped /override capability (Green/Yellow only — never Red)"
  - "KERNEL_BREAKER_WINDOW_MS env override on the production window (default 10s, spec §8) — owner/test-configurable"
  - "Face BreakerPreviewCard: glass card (regular material, hairline, ONE accent control) rendering the dry-run summary + tier + spend impact, a visible 10s countdown, and a single accent Cancel CTA; auto-dismisses on cancel or window-elapse"
  - "AppCoordinator breaker wiring: handle(.breakerPreview) surfaces the card; cancelBreakerPreview emits breaker.cancel{id}; breakerPreviewElapsed auto-dismisses (proceed default)"
  - "CloudWindow overlay: the card overlays EVERY scene (incl. a live Claude Code cornerPill) — safety-critical surfacing"
affects: [phase-5 verification (closes WARNING + human-verify item #3)]

tech-stack:
  added: []  # ZERO new packages — node built-ins + zod (daemon), SwiftUI/Foundation (Face)
  patterns:
    - "Server→registry broadcast injection via setBreakerBroadcast (no server↔registry import cycle; the breaker stays pure)"
    - "Correlation-id discipline: each preview gets a fresh id; only the matching breaker.cancel id aborts the in-flight run"
    - "Card never decides: the only cancel path is the explicit onCancel callback; window-elapse = proceed (locked SAFE-03)"

key-files:
  created:
    - daemon/src/ipc/breaker-wiring.test.ts
    - face/Kernel/Widgets/BreakerPreviewCard.swift
    - face/KernelTests/BreakerPreviewCardTests.swift
  modified:
    - daemon/src/ipc/server.ts
    - daemon/src/tools/registry.ts
    - face/Kernel/IPC/Frames.swift
    - face/Kernel/AppCoordinator.swift
    - face/Kernel/CloudView/CloudWindow.swift
    - face/KernelTests/FrameCodecTests.swift
    - face/Kernel.xcodeproj/project.pbxproj

key-decisions:
  - "The breaker LOGIC is untouched — only the production deps were wired. emitPreview/cancelled stay injected; all 6 breaker unit tests + the 28 prior safety tests are unchanged and green."
  - "Server injects its broadcast into the registry (setBreakerBroadcast) rather than the registry importing the server — keeps the breaker pure and avoids an import cycle (server already imports loop)."
  - "Cancel correlation: a fresh preview id per gated run; signalBreakerCancel(id) only flips the latch when id matches the active preview, so a stale/duplicate cancel cannot abort a different action."
  - "Headless (no Face connected): broadcast delivers to 0 clients; the action stays gated by ceiling+audit and PROCEEDS after the window (locked SAFE-03 default) — a live cancel is simply not possible. Proven by a test."
  - "Window length is env-overridable (KERNEL_BREAKER_WINDOW_MS, default 10s) so tests run in ~300ms without faking the clock; production keeps the §8 10s."

requirements-completed: []  # gap closure on SAFE-03 (already SATISFIED at code level); closes verification WARNING + human-verify #3

duration: ~25 min
completed: 2026-06-22
---

# Phase 5 Plan 04: Breaker Preview IPC Broadcast + Face Cancel Card (gap closure) Summary

**Closed the one real Phase-5 verifier gap: the production breaker `emitPreview` no-op is replaced by a live IPC broadcast, so a Red action's dry-run PREVIEW now reaches the Face as a glass card with a 10-second countdown and an accent Cancel button, and a `breaker.cancel{id}` frame from the Face cancels the pending action within the window — the §8 human-in-the-loop cancel actually works end-to-end.**

## What was wired

### Daemon (production wiring; breaker logic untouched)
- `ipc/server.ts` gained `broadcast(frame)` (a client-set fan-out tracked on connect/close/error, returning the delivered count) and now wires `setBreakerBroadcast(...)` at `startIpc` so the production `defaultBreakerDeps.emitPreview` pushes a `breaker.preview{id,summary,estimatedSpend,tier:'red'}` to every connected Face. The default frame handler now routes inbound `breaker.cancel{id}` → `signalBreakerCancel(id)` and `override` → `overrideSingleton().activate/deactivate`.
- `tools/registry.ts`: the `emitPreview` no-op is replaced by `activePreviewId = breakerBroadcast(preview)`; `signalBreakerCancel(id?)` now honours a cancel ONLY when `id` matches the active preview (stale-id cancels ignored); a `KERNEL_BREAKER_WINDOW_MS` env override (default 10s) makes the window configurable.

### Face
- `IPC/Frames.swift`: additive `.breakerPreview(id,summary,estimatedSpend,tier)` (daemon→Face) and `.breakerCancel(id)` (Face→daemon) arms + a `BreakerTier` enum, with decode/encode + tolerant malformed handling — exact mirrors of the daemon schema.
- `Widgets/BreakerPreviewCard.swift`: a glass card (regular material, hairline, §15 ONE accent reserved for the Cancel CTA + the countdown dot) rendering the dry-run summary, the Red-action marker, the spend impact (only when > 0), a visible per-second 10s countdown, and a single accent Cancel button. No "proceed" button (proceed is the locked default). Auto-dismisses on cancel or window-elapse.
- `AppCoordinator.swift`: `handle(.breakerPreview)` surfaces the card via `activeBreakerPreview`; `cancelBreakerPreview` emits `breaker.cancel{id}` (guarded off under the XCTest host); `breakerPreviewElapsed` auto-dismisses.
- `CloudWindow.swift`: the card overlays EVERY scene (incl. a live Claude Code cornerPill) — the cancel window is never hidden behind the current scene.

## Test results (all green)

**Daemon — `npm run build` clean; `npm test` 237/237 (was 233; +4 new in `ipc/breaker-wiring.test.ts`):**
- emitPreview BROADCASTS a `breaker.preview` frame to a connected (mock) Face client — over a REAL UDS server with the REAL production breaker deps (not a mock transport).
- a `breaker.cancel{id}` frame WITHIN the window cancels — the tool executor is NEVER called (the cancel proof).
- a STALE cancel id does NOT abort the in-flight run (the action proceeds; executor runs once).
- NO Face connected → the Red action is STILL gated (proceeds via ceiling+audit), no crash (headless proof).

**Face — `xcodebuild test` SUCCEEDED, 51/51 (was 41; +10 new):**
- `FrameCodecTests` (+3): `breaker.preview` (financial + non-financial) and `breaker.cancel` round-trip; out-of-enum tier / missing fields decode to nil (tolerated).
- `BreakerPreviewCardTests` (+7): renders financial + non-financial previews; NO auto-cancel on construction/present; Cancel is the only cancel path and carries the preview id; the elapsed callback fires; the coordinator surfaces the card on a preview frame and clears it on cancel/elapse.

## Proofs vs. the verification gap
- **WARNING (registry.ts emitPreview no-op):** CLOSED — `emitPreview` now broadcasts; proven by the daemon broadcast test over a real socket.
- **Human-verify #3 (Face does not show the preview card):** CLOSED in code — the frame decodes, the card renders, and the cancel-within-window aborts (executor never called), all under automated tests. The REMAINING owner check is the live visual: run a real daemon + Face with `KERNEL_BREAKER_ENABLED=true`, drive a Red action, and SEE the card + countdown on the real Face and tap Cancel. That is a genuine live-machine observation (a real socket + a rendered window), not a code gap.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added `KERNEL_BREAKER_WINDOW_MS` env override on the production breaker window**
- **Found during:** writing the daemon wiring tests — the production `defaultBreakerDeps` hard-coded the 10s window, so the proceed/stale-cancel integration tests would have waited the full 10s each.
- **Fix:** `windowMs: Number(process.env.KERNEL_BREAKER_WINDOW_MS ?? 10_000)` in `defaultBreakerDeps`. Production keeps the §8 10s default; tests set 300ms. This is also a legitimate owner-config surface (the breaker already accepted an injectable `windowMs?`).
- **Files modified:** daemon/src/tools/registry.ts
- **Verification:** the integration tests run in ~300ms each; the breaker's own 10s default is unchanged for production.
- **Committed in:** a60e085

**2. [Rule 3 - Blocking] Routed the inbound `override` + `breaker.cancel` frames in the default IPC handler**
- **Found during:** wiring the cancel path — the 05-01 frames existed in the schema but the server's `defaultFrameHandler` had no arms for them, so a cancel frame would have been a silent no-op (handled, but ignored).
- **Fix:** added `case 'override'` (→ `overrideSingleton().activate/deactivate`) and `case 'breaker.cancel'` (→ `signalBreakerCancel(id)`) to `defaultFrameHandler`. The 05-01 summary explicitly noted this server-side wiring was deferred.
- **Files modified:** daemon/src/ipc/server.ts
- **Verification:** the cancel-within-window daemon test exercises the full inbound route (Face frame → server handler → registry latch → breaker abort).
- **Committed in:** a60e085

**Total deviations:** 2 auto-fixed (1 missing-critical config surface, 1 blocking wiring). Both are correctness/spec-completion, not scope creep. The breaker's own logic and all prior tests are untouched.

## Threat Flags
None — all new surface (broadcast fan-out, the two server frame routes, the Face card) is within the 05-01 threat register (the breaker.preview/cancel/override frames were already planned T-05 surface). No new endpoints, auth paths, or trust-boundary schema changes; `estimatedSpend` is shown to the owner but still never audit-logged (V7 preserved).

## Commits
1. `a60e085` — fix(05): wire production breaker preview broadcast + cancel over the live IPC server (daemon)
2. `db18b91` — fix(05): add Face BreakerPreviewCard + breaker.preview/cancel frame mirror + 10s cancel window wiring (Face)

---
*Phase: 05-safety-self-maintenance-gated-do-not-auto-execute*
*Completed: 2026-06-22*

## Self-Check: PASSED
- All 3 created files verified present (daemon/src/ipc/breaker-wiring.test.ts, face/Kernel/Widgets/BreakerPreviewCard.swift, face/KernelTests/BreakerPreviewCardTests.swift).
- Both commits (a60e085, db18b91) verified in git log.
- Daemon: `npm run build` clean, `npm test` 237/237 green. Face: `xcodebuild test` SUCCEEDED, 51/51 green.
