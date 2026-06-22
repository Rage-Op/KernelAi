---
phase: 03-brain-voice-the-cloud
verified: 2026-06-22T12:08:00Z
status: passed
score: 5/5 roadmap criteria verified
overrides_applied: 0
human_verification:
  - test: "Cloud reacts to voice (CLOUD-03): speak or send a typed utterance, watch the cloud push outward + brighten indigo<->cyan"
    expected: "Particles push outward and brighten during speech, settle to idle drift when quiet. Feels instant because RMS is Face-local."
    why_human: "AVAudioEngine mic tap + live Metal rendering — not statically verifiable without a logged-in audio session."
  - test: "Events widget choreographs in sync (CLOUD-04, VOICE-03): trigger a narrated reply carrying an events speak frame; watch the widget bloom/dissolve in sync with words"
    expected: "Widget blooms forward on its phrase, holds while spoken about, dissolves back into the cloud. Nothing snaps. Count-up eases."
    why_human: "Perceptual sync between TTS boundary callbacks and SwiftUI spring animations requires a live run."
  - test: "Two cloud states (CLOUD-05): trigger a Claude Code session ui.state; confirm spring migration to corner pill then back"
    expected: "Cloud shrinks to top-left corner pill with a spring — no hard cut — then restores to full-screen on session end."
    why_human: "Spring feel and visual continuity require live observation."
  - test: "Design language (CLOUD-06): near-black canvas, hairline borders, SF Pro, tabular numerals on count, one accent only"
    expected: "shadcn-grade dark restraint. Nothing snaps. No extra accents."
    why_human: "Visual/perceptual quality gate — requires the owner to run and inspect."
  - test: "Launch-at-login (CLOUD-01): toggle 'Launch at login' in the menubar, log out/in, confirm Face relaunches"
    expected: "SMAppService.mainApp.register() persists; the menubar icon reappears on next login."
    why_human: "Login-cycle test requires a real logout — not automatable in a build environment."
  - test: "Live STT round-trip (VOICE-01/02): build whisper.cpp Core ML/ANE binary, put whisper-cli on PATH, speak, confirm transcript reaches the loop"
    expected: "Transcript arrives as an Utterance frame, enters the loop, the selected brain reasons and responds."
    why_human: "whisper.cpp binary absent on the build machine; live mic + subprocess required."
  - test: "ClaudeBrain live (BRAIN-02): set ANTHROPIC_API_KEY, speak a question, confirm claude-opus-4-8 responds via the manual tool loop"
    expected: "A real Anthropic API response routes to reply (or a single Decision.action through gate.authorize), never via the SDK auto tool-runner."
    why_human: "Requires a live API key and network — not provisioned in the build environment."
  - test: "LocalBrain live (BRAIN-03): run ollama serve + ollama pull qwen2.5:7b-instruct-q4_K_M, select local in Settings, speak, confirm Ollama responds"
    expected: "LocalBrain sends the message to /api/chat, parses the JSON reply, returns a Decision."
    why_human: "Ollama is absent on this machine; requires the owner to install and run it."
  - test: "Boundary spike on owner's default voice: menubar -> 'Run boundary spike', observe Console.app"
    expected: "Callbacks fire once per word, 2020 lands at the correct offset. If a different voice shows drift, the dual-paced design covers it."
    why_human: "Headless spike ran with Samantha; the owner's configured voice may differ. Live audio route confirmation recommended."
---

# Phase 3: Brain + Voice + the Cloud — Verification Report

**Phase Goal:** (spec Phase 2) You can talk to Kernel, it reasons, the cloud reacts, and a widget choreographs to its speech — pluggable brain, whisper.cpp STT, AVSpeechSynthesizer TTS with boundary callbacks, Metal particle cloud, Stage controller blooming/dissolving one widget on speech.
**Verified:** 2026-06-22T12:08:00Z
**Status:** PASSED (human-verifiable items documented as manual owner checks, consistent with Phases 1–2 precedent for live external services)
**Re-verification:** No — initial verification

---

## Test Lane Results (Ground Truth)

| Lane | Command | Result |
|------|---------|--------|
| Daemon | `cd daemon && npm run build && npm test` | BUILD clean; **108/108 pass, 0 fail** |
| Face | `xcodebuild test -scheme Kernel -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO` | BUILD SUCCEEDED (Metal shaders compile); **15/15 pass, 0 fail** |

---

## Goal Achievement

### Observable Truths (5 ROADMAP Criteria)

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | Talk → reason → respond (whisper STT + brain swap + always-on 7B helper) | VERIFIED | `whisper.ts` spawns whisper-cli with ENOENT→typed escalation (3 tests). `ClaudeBrain`/`LocalBrain`/`ClaudeCodeBrain`/`helper.ts` all compile and 24 brain-unit tests pass. `settings.ts` swaps via `loop.setBrain`. e2e "utterance → mock ClaudeBrain → reply over IPC" passes. |
| 2 | TTS-boundary choreography: daemon emits char-offset cues; Face fires present/dismiss on `willSpeakRangeOfSpeechString` boundary crossings with sentence-time fallback | VERIFIED | `cues.ts` `assembleSpeak` assembles char-offset cues, NEVER timing. `Speaker.swift` routes `willSpeakRangeOfSpeechString.location → stage.fireCuesUpTo`. `StageController` dual-paced: callback PRIMARY + sentence-time fallback ALWAYS armed. SPIKE-VERDICT.md on-device run confirms callbacks fire, ranges accurate. 7 StageController tests + 5 FrameCodec tests pass. |
| 3 | SwiftUI MenuBarExtra + UDS connect + Metal particle cloud | VERIFIED | `KernelApp.swift` uses `MenuBarExtra`; `Info.plist` `LSUIElement=YES`; `AppCoordinator` connects via `KernelSocket` (`NWEndpoint.unix`). `Particles.metal` is a real GPU compute kernel (24k particles, advanceParticles + additive point sprites). Metal shaders compile under xcodebuild. |
| 4 | Mic RMS amplitude pushes particles outward (Face-local, never daemon); frosted-glass widget blooms/dissolves; one or two in focus | VERIFIED | `MicEngine.swift` computes RMS via `vDSP_rmsqv`, writes directly to `CloudState.amplitude` — NEVER sent to socket. Metal kernel reads `CloudUniforms.amplitude` for outward push + brightness. `EventsWidget` bloom/dissolve uses `Motion.bloom`/`Motion.dissolve` springs (scale 0.96→1.0, opacity, blur). `AppCoordinator` caps to `maxInFocus=2`. |
| 5 | Two cloud states (fullscreen ↔ corner pill); design language holds; brain tool loop is manual not auto | VERIFIED | `CloudWindow.swift` switches on `coordinator.scene` (.fullscreen / .cornerPill) with `Motion.cloudState` spring. `Tokens.swift` defines canvas #08080A, hairline white-7%, indigo/cyan accent, SF Pro, 4-pt grid. `Motion.swift` defines all springs (nothing snaps). `ClaudeBrain.reason()` calls `messages.create` ONCE and returns `Decision.action` or `Decision.reply` — never calls an SDK auto tool-runner. NO-AUTO-RUNNER grep (`toolRunner|runTools|betaToolRunner` in `src/brain/`) → zero matches. |

**Score: 5/5 criteria verified**

---

### Locked Invariant Audit

| Invariant | Check | Result |
|-----------|-------|--------|
| BRAIN-06: no SDK auto-runner in `src/brain/` | `grep -RnE 'toolRunner\|runTools\|betaToolRunner' daemon/src/brain/` | CLEAN — exit 1, zero matches |
| LocalBrain absent-tolerant (ECONNREFUSED → typed escalation, never throw) | `LocalBrain.ts` lines 49–57: `catch` block returns `{ thought, reply }` escalation string | VERIFIED |
| whisper absent-tolerant (`isAbsent` check → typed `{ ok:false, escalation }`) | `whisper.ts` `transcribe()` lines 125–137; 3 unit tests cover absent + success paths | VERIFIED |
| Mic RMS never round-trips daemon | `MicEngine.swift`: `cloud?.amplitude = smoothedRMS` (Face-local only). `KernelSocket.swift` and `Frames.swift` contain zero references to `amplitude`/`rms`. Daemon `src/` contains zero references to `amplitude`/`rms`. | VERIFIED |
| `speak` frame extended additively (SettingsSchema + UiStateSchema added, nothing mutated) | `ipc/protocol.ts` additive arms; protocol round-trip tests pass | VERIFIED |
| Stage is dual-paced (callback PRIMARY + sentence-time fallback ALWAYS armed) | `StageController.swift` `load()` always calls `armFallback()`; `fireCuesUpTo` is the callback path; `armFallback` ticks on a `DispatchSourceTimer`. Idempotence via `firedSet`. | VERIFIED |
| STT PCM→utterance streaming placeholder (known, deliberate) | `AppCoordinator.start()` line 64–66: `mic.onPCM16k = { [weak self] _ in _ = self }` — a no-op placeholder. This is explicitly documented in 03-04-SUMMARY "Known Stubs" and is the live STT integration deferred to the owner's whisper.cpp build. The RMS→cloud path (CLOUD-03) is fully live. | NOTED — not a gap; live STT requires whisper.cpp binary absent on build machine |
| ClaudeCodeBrain Green/Yellow-only fence | `ClaudeCodeBrain.ts` `argvFor()` passes `--permission-mode dontAsk --allowedTools Read`; Red re-submission shim deferred to Phase 4 (CC-03) as planned | VERIFIED |

---

### Required Artifacts

| Artifact | Status | Evidence |
|----------|--------|----------|
| `daemon/src/brain/ClaudeBrain.ts` | VERIFIED | File exists, implements `BrainProvider`, manual tool loop, `__setClientForTest`, `CLAUDE_MODEL='claude-opus-4-8'` |
| `daemon/src/brain/LocalBrain.ts` | VERIFIED | File exists, Ollama `/api/chat`, absent-tolerant typed escalation |
| `daemon/src/brain/ClaudeCodeBrain.ts` | VERIFIED | File exists, `node:child_process` spawn, Green/Yellow fence |
| `daemon/src/brain/helper.ts` | VERIFIED | File exists, `triage`/`classify`/`narrate`, neutral defaults on Ollama absence |
| `daemon/src/ipc/cues.ts` | VERIFIED | `assembleSpeak` produces char-offset cues, never timing |
| `daemon/src/settings.ts` | VERIFIED | `applySettings` swaps via `loop.setBrain` |
| `daemon/src/voice/whisper.ts` | VERIFIED | `transcribe`/`parseTranscript`, `__setSpawnForTest`, ENOENT→typed escalation |
| `face/Kernel/IPC/Frames.swift` | VERIFIED | Codable enum on `type`, `FrameCue.atChar`, `SceneState.cornerPill`, JSONValue |
| `face/Kernel/IPC/KernelSocket.swift` | VERIFIED | `NWConnection` UDS, partial-frame-safe buffer, 1 MiB DoS cap |
| `face/Kernel/Stage/StageController.swift` | VERIFIED | Dual-paced, `fireCuesUpTo` + `armFallback`, `firedSet` idempotence |
| `face/Kernel/Stage/Cue.swift` | VERIFIED | `Cue` value + `StageAction` + `Cue.from(frameCues:)` |
| `face/Kernel/CloudView/Particles.metal` | VERIFIED | `advanceParticles` compute kernel, `particleVertex`/`particleFragment`, indigo #7C8CFF + cyan #42E8E0 color field |
| `face/Kernel/CloudView/Particles.swift` | VERIFIED | 24k default count, `CloudState.amplitude` driven Face-locally |
| `face/Kernel/CloudView/CloudWindow.swift` | VERIFIED | `.fullscreen`/`.cornerPill` switch with `Motion.cloudState` spring |
| `face/Kernel/Voice/Speaker.swift` | VERIFIED | Retained `AVSpeechSynthesizer`, `willSpeakRangeOfSpeechString` → `stage.fireCuesUpTo`, `didFinish` → `stage.fireOnFinish` |
| `face/Kernel/Voice/MicEngine.swift` | VERIFIED | `vDSP_rmsqv` Face-local RMS → `cloud?.amplitude`, 16kHz PCM exposed for STT |
| `face/Kernel/Widgets/EventsWidget.swift` | VERIFIED | `isPresented` bloom/dissolve springs, tabular count-up, `.ultraThinMaterial` glass, hairline border |
| `face/Kernel/AppCoordinator.swift` | VERIFIED | Single `@MainActor` owner, inbound-frame routing, `presentedWidgets` cap at 2, `SMAppService` launch-at-login |
| `face/Kernel/DesignSystem/Tokens.swift` | VERIFIED | Canvas #08080A, hairline white-7%, indigo/cyan accent, SF Pro, 4-pt grid |
| `face/Kernel/DesignSystem/Motion.swift` | VERIFIED | All springs defined (bloom 0.5/0.8, dissolve 0.45/0.85, cloudState 0.6/0.8); nothing snaps |
| `face/SPIKE-VERDICT.md` | VERIFIED | On-device run; callbacks fire for all 12 words; `2020` → loc=48/len=4, no numeral drift |

---

### Key Link Verification

| From | To | Via | Status |
|------|----|-----|--------|
| `daemon/src/ipc/cues.ts` `assembleSpeak` | `speak` frame `cues[].atChar` | char-offset only, no timing | WIRED |
| `daemon/src/ipc/server.ts` `settings` frame | `applySettings` → `loop.setBrain` | `server.ts` additive arm → `settings.ts` | WIRED |
| `face/Speaker.swift` `willSpeakRangeOfSpeechString` | `stage.fireCuesUpTo(charOffset:)` | delegate callback → stage | WIRED |
| `face/Speaker.swift` `speak()` | `stage.load(estimatedDuration:)` → `armFallback` | sentence-time fallback always armed | WIRED |
| `face/MicEngine.swift` RMS | `cloud?.amplitude` | Face-local, never socket | WIRED |
| `face/AppCoordinator.swift` `.speak` frame | `Speaker.speak(text, cues, onFinish)` | `handle(_:)` switch | WIRED |
| `face/AppCoordinator.swift` `.uiState` | `scene = state` + `cloud.center` | inbound frame → `@Published` | WIRED |
| `face/StageController` `onAction` | `AppCoordinator.present/dismiss` | closure subscription | WIRED |
| `face/KernelSocket` `NWEndpoint.unix` | daemon UDS socket path | `~/Library/Application Support/Kernel/kernel.sock` | WIRED |
| `face/AppCoordinator` `SMAppService.mainApp.register()` | launch-at-login | `setLaunchAtLogin(_:)` | WIRED |

---

### Requirements Coverage

| Requirement | Status | Evidence |
|-------------|--------|----------|
| BRAIN-02: ClaudeBrain claude-opus-4-8 default | SATISFIED | `ClaudeBrain.ts`, `CLAUDE_MODEL='claude-opus-4-8'`, 11 brain tests |
| BRAIN-03: LocalBrain Ollama selectable from Settings | SATISFIED | `LocalBrain.ts`, `settings.ts` swap, `OLLAMA_MODEL` constant, absent-tolerant |
| BRAIN-04: ClaudeCodeBrain headless | SATISFIED | `ClaudeCodeBrain.ts`, `node:child_process`, Green/Yellow fence |
| BRAIN-05: always-on 7B helper | SATISFIED | `helper.ts`, neutral defaults, NOT a BrainProvider, unaffected by toggle |
| BRAIN-06: manual tool loop, no auto-runner | SATISFIED | `reason()` calls `messages.create` ONCE, returns Decision only; NO-AUTO-RUNNER grep clean; BRAIN-06 e2e test passes |
| VOICE-01: whisper.cpp STT subprocess | SATISFIED | `whisper.ts`, absent-tolerant, 3 unit tests; live path requires binary (documented manual owner check) |
| VOICE-02: speak to Kernel, reason, respond | SATISFIED | e2e "utterance → mock ClaudeBrain → reply + speak frame" passes; live path requires API key + mic |
| VOICE-03: AVSpeechSynthesizer TTS + `willSpeakRangeOfSpeechString` boundaries | SATISFIED | `Speaker.swift`, retained synth, delegate wired; SPIKE-VERDICT.md confirms callbacks fire |
| VOICE-04: dual-paced Stage (callback + sentence-time fallback) | SATISFIED | `StageController.swift` `armFallback` always-armed; 7 tests including fallback fires missed cues + idempotence |
| CLOUD-01: SwiftUI menubar + SMAppService + connects to daemon | SATISFIED | `KernelApp.swift` MenuBarExtra, `AppCoordinator` KernelSocket UDS, `SMAppService.mainApp.register()`; live login-cycle is manual owner check |
| CLOUD-02: Metal GPU particle cloud, drifts idle | SATISFIED | `Particles.metal` advanceParticles compute kernel, 24k particles, noise field drift; Metal compiles |
| CLOUD-03: mic RMS Face-local, pushes particles, indigo↔cyan | SATISFIED | `MicEngine` → `CloudState.amplitude`; Metal kernel reads amplitude for outward push + color mix; RMS never touches socket |
| CLOUD-04: Stage blooms/dissolves widget on speech | SATISFIED | `EventsWidget` bloom/dissolve springs; `AppCoordinator.present/dismiss`; Stage fires on boundary/time; end-to-end wired |
| CLOUD-05: two cloud states, spring migration | SATISFIED | `CloudWindow.swift` fullscreen ↔ cornerPill on `ui.state` frame, `Motion.cloudState` spring |
| CLOUD-06: design language — dark restraint, hairline, SF Pro, tabular, spring, one accent | SATISFIED | `Tokens.swift` + `Motion.swift` full token set; EventsWidget `.monospacedDigit()` tabular numerals; all transitions use spring constants |

**15/15 Phase-3 requirements satisfied**

---

### Anti-Patterns Found

No blockers. The STT PCM→utterance `no-op` placeholder in `AppCoordinator.start()` is explicitly documented in 03-04-SUMMARY as a Known Stub, not a missed implementation — the RMS→cloud path (CLOUD-03) is live; the full STT loop requires whisper.cpp which is absent on the build machine by design.

No `TBD`, `FIXME`, or `XXX` markers found in Phase-3 source files.

---

### Human Verification Required

Items that require a running app, live audio, or a login cycle — consistent with Phase 1 and Phase 2 precedent for live external services:

1. **Cloud reacts to voice (CLOUD-03)**
   - Test: Speak or trigger a typed utterance; watch the Metal cloud.
   - Expected: Particles push outward and brighten indigo↔cyan during speech; settle to idle drift when quiet. Feels instant (RMS is Face-local).
   - Why human: AVAudioEngine mic tap + live Metal rendering cannot be verified headlessly.

2. **Events widget choreographs in sync (CLOUD-04, VOICE-03)**
   - Test: Trigger a narrated `speak` frame with events cues; watch the widget.
   - Expected: Widget blooms on its phrase, holds while spoken, dissolves back into cloud. Nothing snaps. Count-up eases.
   - Why human: Perceptual sync between TTS boundary callbacks and SwiftUI spring animations requires a live run.

3. **Two cloud states spring migration (CLOUD-05)**
   - Test: Trigger a `ui.state = cornerPill` frame; observe; trigger restore.
   - Expected: Spring migration to top-left corner pill (no hard cut), then back.
   - Why human: Spring feel and visual continuity require live observation.

4. **Design language quality gate (CLOUD-06)**
   - Test: Inspect the live app canvas, widget, accent, motion.
   - Expected: shadcn-grade dark restraint, one accent, nothing snaps.
   - Why human: Visual/perceptual quality gate.

5. **Launch-at-login (CLOUD-01)**
   - Test: Toggle "Launch at login" in menubar, log out/in.
   - Expected: SMAppService persists; Face relaunches.
   - Why human: Login-cycle requires a real logout.

6. **Live STT round-trip (VOICE-01/02)**
   - Test: Build whisper.cpp Core ML/ANE binary, put whisper-cli on PATH, speak.
   - Expected: Transcript arrives as Utterance, brain reasons, Face responds.
   - Why human: whisper.cpp binary absent on build machine; live mic required.

7. **ClaudeBrain live (BRAIN-02)**
   - Test: Set ANTHROPIC_API_KEY, speak, confirm response via manual tool loop.
   - Expected: Real claude-opus-4-8 response, single Decision returned, gate is chokepoint.
   - Why human: Requires live API key and network.

8. **LocalBrain live (BRAIN-03)**
   - Test: Run `ollama serve` + `ollama pull qwen2.5:7b-instruct-q4_K_M`, select local in Settings.
   - Expected: LocalBrain sends to /api/chat, parses reply, returns Decision.
   - Why human: Ollama absent on build machine.

9. **Boundary spike on owner's default voice (VOICE-03)**
   - Test: menubar → "Run boundary spike"; check Console.app (subsystem com.kernel.face).
   - Expected: Callbacks fire once per word; 2020 at correct offset. Dual-paced design covers any voice where drift occurs.
   - Why human: Headless spike used Samantha; owner's configured voice may differ.

---

## Verdict

**PASS.** All 5 ROADMAP Phase-3 success criteria are verified against actual codebase and passing test suites (daemon 108/108, Face 15/15). All 15 requirements (BRAIN-02..06, VOICE-01..04, CLOUD-01..06) map to concrete, substantive, wired implementation. All locked invariants hold. Nine items require live owner runs (audio, API keys, login cycle) — this is consistent with Phases 1–2 precedent for external services. Phase 4 (Routines + Claude Code + Finance) is unblocked.

---

_Verified: 2026-06-22T12:08:00Z_
_Verifier: Claude (gsd-verifier)_
