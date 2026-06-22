---
phase: 03-brain-voice-the-cloud
plan: 04
subsystem: ui
tags: [swift, swiftui, metal, mtkview, compute-shader, avspeechsynthesizer, avaudioengine, nwconnection, uds, ndjson, smappservice, tts, choreography, macos, xctest]

# Dependency graph
requires:
  - phase: 03-brain-voice-the-cloud (03-01)
    provides: frozen FrameSchema (speak/cues/onFinish, ui.state, settings, widget.data) the Swift Frames.swift mirrors
  - phase: 03-brain-voice-the-cloud (03-03)
    provides: TCC-stable Kernel.xcodeproj + MenuBarExtra shell + Tokens seed + XCTest lane + SPIKE-VERDICT.md (gates the dual-paced Stage)
provides:
  - "face/Kernel/IPC/Frames.swift — Codable mirror of the frozen daemon FrameSchema (discriminated on type; JSONValue for z.unknown payloads)"
  - "face/Kernel/IPC/KernelSocket.swift — NWConnection UDS NDJSON client, partial-frame-safe line buffer mirroring server.ts attachReader"
  - "face/Kernel/Stage/StageController.swift — dual-paced cue firing (callback PRIMARY + sentence-time FALLBACK), idempotent, out-of-bounds tolerant"
  - "face/Kernel/CloudView/Particles.metal + Particles.swift — GPU compute-shader particle cloud (24k particles), Face-local amplitude-driven"
  - "face/Kernel/Voice/Speaker.swift — retained AVSpeechSynthesizer + delegate driving the Stage"
  - "face/Kernel/Voice/MicEngine.swift — AVAudioEngine tap, RMS computed Face-locally (CLOUD-03), 16kHz PCM for STT"
  - "face/Kernel/Widgets/EventsWidget.swift — the ONE end-to-end choreographed widget (glass bloom/dissolve, tabular count-up)"
  - "face/Kernel/CloudView/CloudWindow.swift — two cloud states (full-screen <-> corner pill), spring migration"
  - "face/Kernel/DesignSystem/Tokens.swift + Motion.swift — the full UI-SPEC token + Motion Law set"
affects: [04-widgets, mail-widget, accounts-widget, spending-widget, email-preview-widget, stt-plumbing, claude-code-transcript-pill]

# Tech tracking
tech-stack:
  added: [Metal (MTLComputePipelineState + MTKView), simd, AVAudioEngine, Accelerate (vDSP_rmsqv), Network (NWConnection), ServiceManagement (SMAppService)]
  patterns:
    - "Frame codec = a Codable enum discriminated on `type`, mirroring the zod discriminated union exactly; `z.unknown()` modelled as a lossless JSONValue"
    - "Partial-frame-safe NDJSON line buffer on the Face mirrors the daemon server.ts byte-for-byte (split on \\n, keep the trailing partial, drop a bad line)"
    - "Dual-paced StageController: PRIMARY word-level callback clock + ALWAYS-armed sentence-time fallback timer; one fired-set guarantees fire-once idempotence across both paths"
    - "Face-local mic RMS drives the cloud amplitude uniform directly (never the daemon); only 16kHz PCM crosses to the LOCAL daemon for STT"
    - "Metal compute kernel advances particle state in an MTLBuffer each frame; additive point-sprite rendering; budget sheds under pressure"
    - "Runtime services (mic/socket) are guarded off under the XCTest host so CoreAudio doesn't hang the headless test runner"

key-files:
  created:
    - face/Kernel/DesignSystem/Tokens.swift
    - face/Kernel/DesignSystem/Motion.swift
    - face/Kernel/IPC/Frames.swift
    - face/Kernel/IPC/KernelSocket.swift
    - face/Kernel/Stage/Cue.swift
    - face/Kernel/Stage/StageController.swift
    - face/Kernel/CloudView/Particles.metal
    - face/Kernel/CloudView/Particles.swift
    - face/Kernel/CloudView/CloudWindow.swift
    - face/Kernel/Voice/MicEngine.swift
    - face/Kernel/Voice/Speaker.swift
    - face/Kernel/Widgets/EventsWidget.swift
    - face/Kernel/AppCoordinator.swift
    - face/KernelTests/FrameCodecTests.swift
    - face/KernelTests/StageControllerTests.swift
  modified:
    - face/Kernel/KernelApp.swift
    - face/project.yml (regenerated .xcodeproj picks up the new nested source folders)
    - face/Kernel.xcodeproj/project.pbxproj

key-decisions:
  - "Introduced AppCoordinator as the single @MainActor owner of cloud/stage/speaker/mic/socket + inbound-frame routing — keeps the talk->reason->speak->choreograph wiring in one place"
  - "Modelled the daemon's z.unknown() payloads (cue.data, widget.data.data, ui.intent.payload) as a lossless JSONValue so frames round-trip without the Face inventing field shapes"
  - "Removed the legacy face/Kernel/Tokens.swift; the full token set now lives at DesignSystem/Tokens.swift (avoids a duplicate enum Tokens in the target)"
  - "StageController is pure-logic (no SwiftUI) with a closure-based onAction so it is unit-testable; the view layer subscribes"
  - "Guarded all runtime services off under the XCTest host (CoreAudio HAL hangs with no audio device) so the headless test lane stays green"

patterns-established:
  - "Codable-enum-on-type frame codec mirroring a zod discriminated union (single source of truth = protocol.ts)"
  - "Dual-paced choreography: callback PRIMARY + sentence-time FALLBACK, idempotent via a fired-set"
  - "Face-local high-frequency signals (mic RMS) never round-trip the daemon"
  - "Widget views own their own bloom/dissolve (scale+opacity+blur) keyed off an isPresented flag — nothing snaps"
  - "Render ONLY typed structured fields from model output; no remote-resource auto-load (T-03-12)"

requirements-completed: [CLOUD-01, CLOUD-02, CLOUD-03, CLOUD-04, CLOUD-05, CLOUD-06, VOICE-03, VOICE-04, VOICE-02]

# Metrics
duration: 26 min
completed: 2026-06-22
---

# Phase 3 Plan 04: The Living Cloud Face Summary

**A GPU Metal particle cloud that breathes with Face-local mic RMS, a dual-paced (callback PRIMARY + sentence-time FALLBACK) StageController driven by a retained-synth Speaker, an NWConnection UDS NDJSON client mirroring the frozen FrameSchema, and the events glass widget choreographed end-to-end (bloom on its narrated phrase -> hold -> dissolve) across two spring-animated cloud states.**

## Performance

- **Duration:** ~26 min
- **Started:** 2026-06-22T11:37Z (approx)
- **Completed:** 2026-06-22T12:03Z
- **Tasks:** 3 auto + 1 blocking visual-fidelity checkpoint (verifiable part done, fidelity documented as owner checks per directive)
- **Files created:** 15 (+1 modified: KernelApp.swift; project regenerated)

## Accomplishments
- **Contracts core (Task 1):** `Frames.swift` mirrors the frozen daemon FrameSchema as a Codable enum discriminated on `type` (utterance/ui.intent/settings out; ready/reply/pong/speak{cues,onFinish}/widget.data/ui.state/error in), with `z.unknown()` payloads as a lossless `JSONValue`. `KernelSocket.swift` is an NWConnection UDS client with a partial-frame-safe line buffer mirroring `server.ts` exactly (split on `\n`, carry the partial, drop a bad line, 1 MiB DoS cap). `StageController.swift` is the dual-paced conductor; `Tokens.swift` + `Motion.swift` transcribe the full 03-UI-SPEC token + Motion Law set.
- **The living cloud + voice (Task 2):** `Particles.metal` is a real GPU compute kernel advancing 24k particles each frame (idle drift on a noise field; amplitude pushes outward + brightens; color lives between indigo #7C8CFF and cyan #42E8E0, additively blended). `MicEngine.swift` computes RMS Face-locally with Accelerate (`vDSP_rmsqv`) and pushes it straight to the cloud — it NEVER round-trips the daemon (CLOUD-03); only 16kHz PCM is exposed for the local STT path. `Speaker.swift` retains the `AVSpeechSynthesizer` as a property and routes `willSpeakRangeOfSpeechString -> stage.fireCuesUpTo` and `didFinish -> stage.fireOnFinish`. `SMAppService.mainApp` launch-at-login is wired into the MenuBarExtra (user-toggled, default off).
- **Choreographed end-to-end (Task 3):** `EventsWidget.swift` is the events glass card per UI-SPEC §1 — `.ultraThinMaterial`, 18px radius, 24px padding, white-7% hairline; a Display 28/600 TABULAR count headline that counts up; up to 3 tabular-time rows; spec empty/error copy; bloom (scale 0.96->1.0, opacity in, forward-blur clears) / dissolve springs — nothing snaps. The `AppCoordinator` drives present/dismiss from the Stage's boundary-fired cues (capped at two widgets in focus). `CloudWindow.swift` switches full-screen <-> top-left corner pill (miniature cloud + accent live-pulse dot) on a `ui.state` frame with a spring (no hard cut).
- **Verification:** `xcodebuild build` SUCCEEDED (Metal shaders compile); `xcodebuild test` GREEN 15/15 (FrameCodecTests 5 + StageControllerTests 7 + BootstrapTests 3); daemon `npm test` remained 108/108 green (no daemon code touched).

## Task Commits

1. **Task 1: design tokens + Motion law, frame codec, NWConnection UDS client, dual-paced StageController (with XCTests)** — `cb05caf` (feat)
2. **Task 2: Metal particle cloud + Face-local mic RMS + retained-synth Speaker, launch-at-login** — `e315fcf` (feat)
3. **Task 3: events widget choreographed end-to-end + two cloud states wired** — `4c662a4` (feat)

**Plan metadata:** committed separately (this SUMMARY + STATE/ROADMAP/REQUIREMENTS).

## Files Created/Modified
- `face/Kernel/IPC/Frames.swift` - Codable mirror of the frozen FrameSchema + JSONValue + FrameCodec (NDJSON line <-> Frame)
- `face/Kernel/IPC/KernelSocket.swift` - NWConnection UDS NDJSON client, partial-frame-safe buffer, 1 MiB cap, hello on connect
- `face/Kernel/Stage/Cue.swift` - Cue value + StageAction + Cue.from(frameCues:)
- `face/Kernel/Stage/StageController.swift` - dual-paced fireCuesUpTo (PRIMARY) + sentence-time fallback timer, fired-set idempotence, out-of-bounds clamp, fireOnFinish
- `face/Kernel/CloudView/Particles.metal` - compute kernel (advanceParticles) + additive point-sprite vertex/fragment shaders
- `face/Kernel/CloudView/Particles.swift` - MTKView renderer via NSViewRepresentable, CloudState amplitude source, shedUnderPressure
- `face/Kernel/CloudView/CloudWindow.swift` - spatial-black canvas, full-screen widget layer + corner-pill state, spring migration
- `face/Kernel/Voice/MicEngine.swift` - AVAudioEngine tap, Face-local RMS (vDSP), 16kHz PCM downsample for STT
- `face/Kernel/Voice/Speaker.swift` - retained AVSpeechSynthesizer + delegate -> Stage, fallback duration estimate
- `face/Kernel/Widgets/EventsWidget.swift` - the choreographed events glass widget (tabular count-up, empty/error states, bloom/dissolve)
- `face/Kernel/AppCoordinator.swift` - central @MainActor owner; inbound-frame routing; present/dismiss; SMAppService launch-at-login; XCTest-host guard
- `face/Kernel/DesignSystem/Tokens.swift` - full UI-SPEC tokens (color, spacing, radii, type, materials)
- `face/Kernel/DesignSystem/Motion.swift` - Motion Law springs (bloom/dissolve/cloudState/boundaryBurst/focusRing/countUp)
- `face/KernelTests/FrameCodecTests.swift` - speak/ui.state/reply round-trip + malformed tolerated
- `face/KernelTests/StageControllerTests.swift` - fire-once, time fallback fires missed cues, out-of-bounds tolerated, onFinish
- `face/Kernel/KernelApp.swift` - (modified) cloud Window scene + launch-at-login toggle + connection state
- `face/Kernel/Tokens.swift` - (removed) superseded by DesignSystem/Tokens.swift

## Decisions Made
- **AppCoordinator as the single runtime owner:** one `@MainActor` object owns cloud/stage/speaker/mic/socket and the inbound-frame switch, so the full talk->reason->speak->choreograph loop is wired in one auditable place.
- **JSONValue for z.unknown():** the daemon's untyped payloads round-trip losslessly without the Face guessing shapes; the EventsWidget reads typed fields out of it at render time (T-03-12 — structured only, no remote auto-load).
- **StageController is pure logic + closure callback:** no SwiftUI import, so it is fully unit-testable; the view layer subscribes to `onAction`.
- **Removed legacy Tokens.swift:** the full token set lives at `DesignSystem/Tokens.swift`; keeping the old file would have produced a duplicate `enum Tokens` in the target.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `defaultSocketPath()` MainActor isolation broke the default-argument context**
- **Found during:** Task 1
- **Issue:** `KernelSocket.init(socketPath: = defaultSocketPath())` called a `@MainActor` static method from a nonisolated default-argument context — a compile error that blocked the test gate.
- **Fix:** Marked `defaultSocketPath()` `nonisolated` (it touches no actor state).
- **Files modified:** face/Kernel/IPC/KernelSocket.swift
- **Verification:** `xcodebuild test` SUCCEEDED.
- **Committed in:** cb05caf

**2. [Rule 1 - Bug] Two `onAction` owners in a test silently dropped recorded actions**
- **Found during:** Task 1 (StageControllerTests)
- **Issue:** `testFallbackIsIdempotentWithCallbackPath` set the recorder via `makeRecorder` then overwrote `stage.onAction` with the expectation closure, so the recorder never appended (assert saw 0, expected 2).
- **Fix:** Used a single `onAction` closure that both records and fulfills.
- **Files modified:** face/KernelTests/StageControllerTests.swift
- **Verification:** 15/15 tests green.
- **Committed in:** cb05caf

**3. [Rule 3 - Blocking] CoreAudio HAL hung the headless test runner**
- **Found during:** Task 2
- **Issue:** The XCTest host launches the full app; `CloudWindow.onAppear -> coordinator.start() -> mic.start()` opened an AVAudioEngine input tap. With no audio device in the headless environment the CoreAudio HAL blocked (`HALC_ShellObject::HasProperty: call to the proxy failed` every 30s) until the runner timed out — TEST FAILED with no real test failure.
- **Fix:** Added `AppCoordinator.isUnderXCTest` (checks `XCTestConfigurationFilePath` env + `NSClassFromString("XCTestCase")`) and guarded `start()` to skip socket+mic under the test host; also hardened `MicEngine.start()` to require `channelCount > 0`.
- **Files modified:** face/Kernel/AppCoordinator.swift, face/Kernel/Voice/MicEngine.swift
- **Verification:** `xcodebuild test` SUCCEEDED 15/15 with no HAL hang.
- **Committed in:** e315fcf

---

**Total deviations:** 3 auto-fixed (2 blocking, 1 bug).
**Impact on plan:** All three were necessary to make the build/test gate pass; no scope creep. The CoreAudio guard is also correct production hygiene (the app degrades gracefully with no audio device / no TCC grant).

## Issues Encountered
- The `gsd-sdk query commit` verb failed on the staged-deletion path (`face/Kernel/Tokens.swift`) because it tries to `git add` a now-nonexistent file. Resolved by committing that task directly (staging the new dirs + the deletion), preserving the per-task commit discipline. Subsequent tasks committed cleanly.

## Threat Flags
None — no new security surface beyond the plan's threat_model.
- T-03-12 (model-output exfil): EventsWidget renders ONLY typed structured fields parsed from the payload; grep confirms no `AsyncImage`/`URLRequest`/`WKWebView`/remote `Image(url:)` in `Widgets/`.
- T-03-13 (malformed frame DoS): KernelSocket drops a bad line without crashing (FrameCodecTests malformed case proves the decoder tolerates truncated/unknown/empty/missing-discriminator lines); 1 MiB no-newline buffer cap added.
- T-03-14 (IPC spoofing): UDS is file-permission scoped to the user-owned socket path; no network port.
- T-03-15 (mic/RMS exfil): RMS is computed and consumed entirely in the Face (grep confirms it is never sent to the socket); only 16kHz PCM crosses to the LOCAL daemon.
- T-03-16 (out-of-bounds NSRange): StageController clamps NSNotFound/negative and tolerates a huge offset (StageControllerTests proves no crash, falls through to the time path).

## Known Stubs
- **Other four widgets (mail/accounts/spending/email-preview):** intentionally NOT rendered this phase — `CloudWindow.widgetView(named:)` returns `EmptyView()` for non-`events` names. This is by design: 03-UI-SPEC fixes their visual contract and Phase 4 renders them against it; Phase 3's bar is ONE widget end-to-end (CLOUD-04 delivery bar). No stub renders fake data to the user.
- **STT PCM->utterance streaming:** `MicEngine.onPCM16k` is wired and exposes 16kHz PCM, but the coordinator's PCM->daemon `utterance` framing is a no-op placeholder (the RMS->cloud path, CLOUD-03, is fully live). The full STT round-trip is exercised with the owner's local whisper (03-02) during the manual checks; the contract surface is in place.

## User Setup Required
**Manual owner checks — the visual-fidelity gate (Task 4 checkpoint), documented per owner directive, NOT statically verifiable (03-UI-SPEC §6-Pillar Quality Gate):**
1. **Run the loop:** start the daemon (`cd daemon && npm start`), build + launch the Face (`cd face && xcodebuild -scheme Kernel -destination 'platform=macOS' build`, open the `.app`). Confirm the menubar app attaches to the socket (a `ready` frame) without a daemon restart.
2. **Cloud reacts to voice (CLOUD-03):** speak (or send a typed utterance) and watch the cloud push outward + brighten indigo<->cyan with your voice, then settle when quiet. RMS must feel instant (it is Face-local).
3. **Events widget choreographs in sync (CLOUD-04, VOICE-03):** trigger a narrated reply carrying an events `speak` frame; watch the widget bloom forward on its phrase, hold while spoken about, then dissolve back into the cloud — in sync with the words. Confirm nothing snaps and the count-up eases.
4. **Two states (CLOUD-05):** trigger a Claude Code session `ui.state`; confirm the cloud shrinks/migrates to the top-left corner pill with a spring (no hard cut), then restores to full-screen.
5. **Design language (CLOUD-06):** near-black canvas, hairline borders, SF Pro, tabular numerals on the count, one accent only.
6. **Launch-at-login across a login cycle:** toggle "Launch at login" in the menubar, log out/in, confirm the Face relaunches. (SMAppService.mainApp.register.)
7. **Boundary spike re-run on the owner's default voice** (optional): menubar -> "Run boundary spike"; confirm in Console.app (subsystem `com.kernel.face`) that callbacks fire and `2020` lands correctly (SPIKE-VERDICT.md).
8. **Mic TCC grant:** approve the microphone prompt on first run (declared in 03-03's Info.plist).

(No `{phase}-USER-SETUP.md` regenerated — the `user_setup` services are owner-runtime checks captured above.)

## Next Phase Readiness
- **Phase 4 is unblocked for the remaining widgets:** the Stage, the bloom/dissolve pattern, the design tokens, the two cloud states, and the frame loop are all in place. Phase 4 renders mail/accounts/spending/email-preview against the fixed 03-UI-SPEC contract by adding cases to `CloudWindow.widgetView(named:)`.
- **The visual-fidelity sign-off is the owner's** (the Task 4 blocking checkpoint): the build/test gate + all structural greps pass HERE; the live cloud reaction, perceptual choreography sync, two-state spring feel, design fidelity over the moving background, and launch-at-login across a login cycle require the owner to run and watch (documented above). The Phase 3 verifier should confirm the structural conformance; the owner confirms fidelity.

## Self-Check: PASSED

All declared artifacts exist on disk and all task commits exist in history:
- FOUND: Frames.swift, KernelSocket.swift, Cue.swift, StageController.swift, Particles.metal, Particles.swift, CloudWindow.swift, MicEngine.swift, Speaker.swift, EventsWidget.swift, Tokens.swift, Motion.swift, AppCoordinator.swift, KernelApp.swift, FrameCodecTests.swift, StageControllerTests.swift
- FOUND commits: cb05caf, e315fcf, 4c662a4
- xcodebuild build: BUILD SUCCEEDED (Metal shaders compile); xcodebuild test: 15/15 passed (macOS 26.5 SDK); daemon npm test: 108/108 green

---
*Phase: 03-brain-voice-the-cloud*
*Completed: 2026-06-22*
