---
phase: 03-brain-voice-the-cloud
plan: 03
subsystem: ui
tags: [swift, swiftui, xcode, xcodegen, menubarextra, avspeechsynthesizer, tts, metal, macos, tcc, xctest]

# Dependency graph
requires:
  - phase: 03-brain-voice-the-cloud (03-01)
    provides: frozen FrameSchema + SpeakSchema cues contract the Face will mirror in 03-04
provides:
  - "face/Kernel.xcodeproj — TCC-stable Xcode project (stable bundle id com.kernel.face, Info.plist, entitlements, non-sandboxed Developer-ID)"
  - "MenuBarExtra app shell (CLOUD-01 surface, menubar-only LSUIElement app)"
  - "KernelTests XCTest target (3 passing tests) — proven build+run test lane"
  - "BoundarySpike — retained-synth willSpeakRangeOfSpeechString spike, owner-triggerable"
  - "SPIKE-VERDICT.md — recorded boundary verdict that gates the 03-04 Stage design"
  - "Tokens.swift — UI-SPEC design tokens (spatial-black canvas, indigo->cyan accent, spring motion)"
affects: [03-04, stage-controller, cloud-window, nwconnection-client, smappservice-launch-at-login, metal-particles]

# Tech tracking
tech-stack:
  added: [Xcode project (face/Kernel.xcodeproj), XcodeGen (project.yml generator), SwiftUI MenuBarExtra, AVSpeechSynthesizer, XCTest, os.Logger]
  patterns:
    - "Face = Xcode project (NOT pure SwiftPM) for TCC permanence + Info.plist/entitlements (RESEARCH Open Question 1, Pitfall 4)"
    - "XcodeGen project.yml as the reproducible source of truth; committed .xcodeproj is canonical"
    - "AVSpeechSynthesizer retained as a stored property (never a local var) so the delegate fires (Apple Forums 683471)"
    - "Dual-paced Stage strategy locked: callback PRIMARY + sentence-time FALLBACK (always present)"

key-files:
  created:
    - face/project.yml
    - face/Kernel.xcodeproj/project.pbxproj
    - face/Kernel/KernelApp.swift
    - face/Kernel/Tokens.swift
    - face/Kernel/Info.plist
    - face/Kernel/Kernel.entitlements
    - face/Spike/BoundarySpike.swift
    - face/KernelTests/BootstrapTests.swift
    - face/SPIKE-VERDICT.md
  modified:
    - .gitignore

key-decisions:
  - "Face is an Xcode project generated/maintained via XcodeGen (project.yml) — committed .xcodeproj is the reproducible source of truth; chosen over hand-writing a fragile .pbxproj"
  - "Automated xcodebuild gate runs CODE_SIGNING_ALLOWED=NO (no signing identity provisioned in the build env); the owner's signed local build supplies the stable Developer-ID identity for TCC permanence"
  - "Boundary spike verdict: willSpeakRangeOfSpeechString callbacks FIRE and ranges are accurate including on numbers (no '2020' drift) on macOS 26.5 + Samantha — word-level pacing is PRIMARY-viable"
  - "Dual-paced Stage (callback PRIMARY + sentence-time FALLBACK) is mandatory regardless of the clean verdict (VOICE-04 requires both)"

patterns-established:
  - "Retained-synth-property discipline for any AVSpeechSynthesizer delegate work (Pitfall 1)"
  - "Out-of-bounds NSRange guard on every substring extraction from a boundary range (T-03-10)"
  - "Stable bundle id com.kernel.face asserted by a unit test so TCC identity cannot silently churn"

requirements-completed: [VOICE-03, CLOUD-01]

# Metrics
duration: 10 min
completed: 2026-06-22
---

# Phase 3 Plan 03: Native SwiftUI Face Bootstrap + Boundary Spike Summary

**An XcodeGen-backed, TCC-stable, non-sandboxed Kernel.xcodeproj with a MenuBarExtra shell, a passing XCTest lane, and a resolved on-device `willSpeakRangeOfSpeechString` verdict (callbacks fire, ranges accurate including on numbers) that gates the 03-04 Stage.**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-06-22T11:25Z (approx)
- **Completed:** 2026-06-22T11:35Z
- **Tasks:** 2 auto + 1 gating checkpoint (run non-interactively per owner directive) = 3
- **Files created:** 9 (+1 modified)

## Accomplishments
- **Xcode project bootstrap (CLOUD-01):** `face/Kernel.xcodeproj` is a real Xcode app (not pure SwiftPM), generated from `face/project.yml` via XcodeGen. Stable bundle id `com.kernel.face`, `Info.plist` with `LSUIElement=YES` + `NSMicrophoneUsageDescription`, mic/audio-input entitlements, non-sandboxed Developer-ID, macOS 14 deployment target building against the macOS 26.5 SDK (the only SDK present).
- **MenuBarExtra shell (CLOUD-01 surface):** `@main KernelApp` with `MenuBarExtra(.menuBarExtraStyle(.window))`, an indigo->cyan accent dot, and the owner-triggerable "Run boundary spike" control. The full cloud window + NWConnection client + SMAppService launch-at-login are deliberately deferred to 03-04 (this is the shell).
- **XCTest lane proven:** `KernelTests/BootstrapTests.swift` — 3 tests pass under `xcodebuild test` (asserts the stable bundle id, display name, and the spike's number-containing sentence).
- **Boundary spike (VOICE-03):** `BoundarySpike` retains the `AVSpeechSynthesizer` as a property, conforms to the delegate, speaks a fixed number-containing sentence, logs every range, and guards against an out-of-bounds NSRange.
- **SPIKE-VERDICT recorded (the gating deliverable):** on-device run shows callbacks fire cleanly and ranges are accurate even on numbers — word-level pacing is PRIMARY-viable; the sentence-time fallback ships anyway. This gates 03-04.

## xcodebuild result
- `xcodebuild -scheme Kernel -destination 'platform=macOS' build CODE_SIGNING_ALLOWED=NO` → **BUILD SUCCEEDED** (macOS 26.5 SDK).
- `xcodebuild test -scheme Kernel -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO` → **TEST SUCCEEDED**, 3/3 tests passed.

## SPIKE verdict (the headline)
Run on **macOS 26.5**, voice **com.apple.voice.compact.en-US.Samantha**, retained-synth property, fixed sentence `"You have 3 events today and your checking is at 2020 dollars."`:

| Question | Answer |
|----------|--------|
| Callbacks fire? | **YES** — 12 callbacks for 12 words, then `didFinish`. |
| Ranges accurate / numeral drift? | **ACCURATE** — `3` -> loc9/len1, `2020` -> loc48/len4. **No drift on numbers** (the documented Pitfall-1 risk did not materialize on this OS+voice). |
| Per-char timing? | Word-granular coalescing at default rate; precise wall-clock left to the owner re-run if exact fallback calibration is wanted. |
| PRIMARY pacing? | **Word-level callbacks usable as PRIMARY**; sentence-time fallback ships regardless (VOICE-04). |

> The verdict came from a headless in-context run of an identical replica (same retention, delegate, sentence, voice, rate, guard). A manual owner re-run on the logged-in session (real audio route + the owner's default voice) is documented in `SPIKE-VERDICT.md` as confirmation; the dual-paced design already covers any voice where callbacks behave differently.

## Task Commits

1. **Task 1: Xcode project + MenuBarExtra shell + XCTest target** — `5a9a86c` (feat)
2. **Task 2: on-device willSpeakRangeOfSpeechString boundary spike** — `bdb234f` (feat)
3. **Task 3 (gating checkpoint): record SPIKE-VERDICT.md** — `94f895a` (feat) — run non-interactively per owner directive

**Plan metadata:** committed separately (this SUMMARY + STATE/ROADMAP/REQUIREMENTS).

## Files Created/Modified
- `face/project.yml` - XcodeGen spec (reproducible project source of truth)
- `face/Kernel.xcodeproj/...` - the generated Xcode project (committed, canonical)
- `face/Kernel/KernelApp.swift` - @main App + MenuBarExtra shell + spike trigger
- `face/Kernel/Tokens.swift` - UI-SPEC design tokens (canvas, accent, spacing, spring)
- `face/Kernel/Info.plist` - LSUIElement=YES, NSMicrophoneUsageDescription
- `face/Kernel/Kernel.entitlements` - mic/audio-input, non-sandboxed
- `face/Spike/BoundarySpike.swift` - retained-synth boundary spike (deletable post-verdict)
- `face/KernelTests/BootstrapTests.swift` - 3 passing XCTest cases
- `face/SPIKE-VERDICT.md` - the recorded verdict that gates 03-04
- `.gitignore` - added Swift/Xcode per-user state + DerivedData ignores

## Decisions Made
- **XcodeGen over hand-written .pbxproj:** `xcodegen` 2.45.4 is installed; `project.yml` makes the project reproducible and reviewable. The committed `.xcodeproj` is the canonical build input (no xcodegen needed at build time).
- **Signing disabled for the automated gate:** no code-signing identity is provisioned in this build context (`security find-identity` = 0 identities). The compile/test gate runs with `CODE_SIGNING_ALLOWED=NO`; the owner's signed local build supplies the stable Developer-ID identity that delivers TCC permanence. The bundle id stays stable regardless, which is the part that matters for Pitfall 4.
- **Ran the gating checkpoint non-interactively** (owner directive) and produced `SPIKE-VERDICT.md` rather than stopping. The verdict was decisive (clean callbacks, no numeral drift).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Generated the .xcodeproj via XcodeGen + disabled signing for the headless gate**
- **Found during:** Task 1
- **Issue:** A valid `.xcodeproj` cannot be hand-authored reliably, and `xcodebuild` cannot sign (no identity in this environment) — both would block the compile-verify gate.
- **Fix:** Added `face/project.yml` and generated the project with the installed `xcodegen`; ran the build/test gate with `CODE_SIGNING_ALLOWED=NO`. Committed `.xcodeproj` as the canonical source.
- **Files modified:** face/project.yml, face/Kernel.xcodeproj/*
- **Verification:** BUILD SUCCEEDED + TEST SUCCEEDED (3/3) against macOS 26.5 SDK.
- **Committed in:** 5a9a86c

**2. [Rule 2 - Missing Critical] Added Swift/Xcode .gitignore entries**
- **Found during:** Task 1
- **Issue:** The repo `.gitignore` was Node-only; committing Xcode per-user state / DerivedData would pollute history.
- **Fix:** Added a Swift/Xcode section ignoring `xcuserdata`, `DerivedData`, `.build`, `*.xcuserstate`.
- **Files modified:** .gitignore
- **Verification:** `git status` shows only intended source files staged.
- **Committed in:** 5a9a86c

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 missing-critical).
**Impact on plan:** Both were necessary to make the compile-verify gate runnable and keep history clean. No scope creep — the plan's artifacts were delivered exactly.

## Issues Encountered
- macOS has no `timeout` binary; the headless spike probe used an internal `DispatchQueue.asyncAfter` watchdog instead. Resolved; no impact.

## Threat Flags
None — no new security surface beyond the plan's threat_model. The spike speaks + logs locally only (T-03-11 accept). The mic entitlement is declared but unused this plan (TCC permanence groundwork, T-03-09 mitigate). Out-of-bounds NSRange guard implemented (T-03-10 mitigate).

## Known Stubs
- SMAppService launch-at-login wiring and the NWConnection UDS client are intentionally NOT in this plan — explicitly deferred to 03-04 (the plan scopes this as "the shell"). The MenuBarExtra "Quit" works; brain toggle / connection state land in 03-04. No stub renders fake data to the user.

## User Setup Required
**Manual owner checks (documented, not automated):**
1. **Boundary spike on the logged-in session:** build + launch `Kernel.app`, click menubar -> "Run boundary spike", confirm in Console.app (subsystem `com.kernel.face`) that callbacks fire and `2020` lands correctly on the owner's default voice. (See `SPIKE-VERDICT.md`.)
2. **Live menubar presence + (later) launch-at-login:** owner verifies the menubar icon appears with no Dock icon; SMAppService launch-at-login is wired in 03-04.
3. **Mic TCC grant:** declared now; first actual mic use is 03-04.

(No `{phase}-USER-SETUP.md` regenerated here — the `user_setup` services are owner-runtime checks captured above and in SPIKE-VERDICT.md.)

## Next Phase Readiness
- **03-04 is unblocked:** `SPIKE-VERDICT.md` exists with a clean, decisive verdict (callbacks fire, ranges accurate, no numeral drift) and the locked dual-paced strategy (callback PRIMARY + sentence-time FALLBACK).
- The Face compiles + tests pass; the TCC-stable identity + design tokens are in place for the Stage, CloudView, NWConnection client, and SMAppService work in 03-04.
- **Concern (carried, low risk):** the verdict was produced headlessly in the build context; the owner's logged-in re-run on their default voice is the final confirmation. The dual-paced design already covers any voice where callbacks misbehave, so this does not block 03-04.

## Self-Check: PASSED

All declared artifacts exist on disk and all task commits exist in history:
- FOUND: face/Kernel.xcodeproj/project.pbxproj, face/Kernel/KernelApp.swift, face/Kernel/Info.plist, face/Kernel/Kernel.entitlements, face/Spike/BoundarySpike.swift, face/KernelTests/BootstrapTests.swift, face/SPIKE-VERDICT.md
- FOUND commits: 5a9a86c, bdb234f, 94f895a
- xcodebuild build: BUILD SUCCEEDED; xcodebuild test: 3/3 passed (macOS 26.5 SDK)

---
*Phase: 03-brain-voice-the-cloud*
*Completed: 2026-06-22*
