---
phase: 3
slug: brain-voice-the-cloud
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-22
---

# Phase 3 — Validation Strategy

> Two test lanes this phase: the daemon (TS, `node:test`+`tsx`, established) and the Face (Swift, `xcodebuild test`/XCTest, new). The highest-risk item — TTS word-boundary choreography — is de-risked by an on-device spike that runs BEFORE the Stage build.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Daemon framework** | `node:test` via `tsx` (existing) |
| **Face framework** | XCTest via `xcodebuild test` (Xcode project; Swift 6.3.2 / macOS 26 SDK present) |
| **Quick run (daemon)** | `cd daemon && npm test` |
| **Quick run (Face)** | `xcodebuild test -scheme Kernel -destination 'platform=macOS'` (structural/unit; visual is manual) |
| **Estimated runtime** | daemon ~15–30s; Face build+unit ~variable |

---

## Sampling Rate

- **After every task commit:** run the affected lane's quick command
- **After every plan wave:** run both lanes that exist
- **Before `/gsd-verify-work`:** daemon suite green + Face compiles + Face unit tests green
- **Max feedback latency:** ~60s

---

## Per-Task Verification Map

| Criterion | Requirement(s) | Secure/Observable Behavior | Test Type | Status |
|-----------|----------------|----------------------------|-----------|--------|
| Talk→reason→respond; brain swap | VOICE-01/02, BRAIN-02/03/04/05 | STT wrapper parses transcript; ClaudeBrain/LocalBrain/ClaudeCodeBrain reason() → Decision; 7B helper always-on; absent-tolerant | unit (mocked SDK/HTTP/binary) + manual (live mic/Ollama) | ⬜ |
| TTS-boundary choreography (LYNCHPIN) | VOICE-03/04, CLOUD-04 | daemon assembles char-offset `cues[]`; Face fires Stage.present/dismiss on boundary crossing; dual word/sentence pacing; on-device spike FIRST | unit (cue assembler, frame round-trip) + spike + manual (watch sync) | ⬜ |
| Manual tool loop preserves gate | BRAIN-06 | ClaudeBrain returns one action per turn; loop gates+executes; no SDK auto-runner | unit | ⬜ |
| SwiftUI menubar launches + attaches | CLOUD-01 | MenuBarExtra + SMAppService; NWConnection attaches to daemon UDS; NDJSON frames | compile + unit (frame codec) + manual (login launch) | ⬜ |
| Metal particle cloud + amplitude reactivity | CLOUD-02/03 | compute-shader particles; idle drift; mic-RMS push/brighten Face-local; indigo↔cyan | compiles + shaders compile + manual (visual) | ⬜ |
| Two states + design language | CLOUD-05/06 | full-screen ↔ corner pill; shadcn-dark tokens, SF Pro, tabular numerals, spring motion | structural (tokens/components present) + manual (visual fidelity) | ⬜ |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] Daemon: brain test fixtures — mock `@anthropic-ai/sdk` client, mock Ollama `/api/chat` HTTP, mock `claude` CLI spawn, whisper stdout fixture
- [ ] Face: Xcode project + `Kernel` scheme + an XCTest target (`KernelTests`) that builds
- [ ] **On-device TTS-boundary spike** (a tiny throwaway that retains an AVSpeechSynthesizer property and logs `willSpeakRangeOfSpeechString` callbacks for a sample utterance incl. a number) — gates the Stage design
- [ ] cue-assembler unit harness on the daemon side (text + topic markers → `cues[]` with charOffsets)

---

## Manual-Only Verifications (documented owner checks)

| Behavior | Requirement | Why Manual | Instructions |
|----------|-------------|------------|--------------|
| Live STT from mic | VOICE-01/02 | needs whisper.cpp built + mic TCC | Install whisper.cpp (CoreML); speak; confirm transcript reaches the loop |
| Live local brain | BRAIN-03 | needs Ollama + pulled model | `ollama pull qwen2.5:7b-instruct-q4_K_M`; flip brain=local; confirm a reply |
| Particle cloud visuals + amplitude reactivity | CLOUD-02/03 | GPU visual, subjective | Run the Face; speak; watch particles push out/brighten then settle |
| Choreography sync to speech | VOICE-03/04, CLOUD-04 | perceptual timing | Run a narrated topic; watch a widget bloom on the phrase and dissolve after |
| Two-state cloud + design fidelity | CLOUD-05/06 | visual | Trigger a Claude Code session; confirm shrink-to-corner-pill; eyeball tokens/motion |
| Launch-at-login | CLOUD-01 | needs login cycle | Enable SMAppService; log out/in; confirm the menubar app returns |
