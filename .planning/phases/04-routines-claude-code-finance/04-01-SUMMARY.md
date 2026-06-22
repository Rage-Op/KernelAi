---
phase: 04-routines-claude-code-finance
plan: 01
subsystem: routines
tags: [yaml, zod, choreography, eventkit, swiftui, mail-triage, 7b-helper, widgets]

# Dependency graph
requires:
  - phase: 01-skeleton
    provides: "frozen FrameSchema (speak/widget.data/ui.intent), serial loop, ToolCall envelope + registry.dispatch chokepoint"
  - phase: 02-hands
    provides: "registry.dispatch → gate.authorize single chokepoint; tiers.classifyTier (central tier derivation)"
  - phase: 03-brain-voice-the-cloud
    provides: "assembleSpeak cue producer, always-on 7B helper.classify (absent-tolerant), EventsWidget bloom/dissolve pattern, CloudWindow.widgetView + AppCoordinator present/dismiss, Tokens/Motion design system"
provides:
  - "Morning-brief routine engine: YAML load + zod validation + ordered/enabled step runner producing one speak frame per narrated step via assembleSpeak (≤2 widgets, never a grid)"
  - "Workday/Weekend/Travel preset switching via a presets: map in morning-brief.yaml"
  - "Nine step handlers (greeting/weather/calendar/invitations/mail_triage/unread_announce/email_reply/balances/spending) behind an injected deps provider seam"
  - "mail_triage tagging via the always-on 7B helper.classify (neutral-default when Ollama absent)"
  - "Invitation reply emitted as a Yellow-classified ToolCall envelope (never self-classified)"
  - "Four Face glass widgets (Mail/Accounts/Spending/EmailPreview) wired into CloudWindow.widgetView(named:)"
  - "Face-side EventKitBridge: typed events payload + Yellow invitation-reply ui.intent"
affects: [04-02 email-reply, 04-03 finance, 04-04 claude-code-pill, finance/email data providers]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Routine step → cue producer: handler returns { narration, widgetPlan } → assembleSpeak → ONE speak frame (Pattern 2)"
    - "Provider deps seam: finance/email data injected via StepDeps so the engine is unit-testable in isolation"
    - "Preset map shape: YAML presets: { name -> [step ids] } + full steps catalogue; a step runs when enabled AND in the active preset"
    - "Anti-bypass: steps emit plain ToolCall envelopes; engine/steps never import safety/gate or safety/tiers"
    - "Face widget gate-routing: chip/Send/invitation actions emit ui.intent via AppCoordinator.emitIntent; no local action"

key-files:
  created:
    - daemon/src/routines/engine.ts
    - daemon/src/routines/steps.ts
    - daemon/src/routines/presets.ts
    - daemon/src/routines/morning-brief.yaml
    - daemon/src/routines/engine.test.ts
    - daemon/src/routines/steps.test.ts
    - face/Kernel/Widgets/MailWidget.swift
    - face/Kernel/Widgets/AccountsWidget.swift
    - face/Kernel/Widgets/SpendingWidget.swift
    - face/Kernel/Widgets/EmailPreviewWidget.swift
    - face/Kernel/Calendar/EventKitBridge.swift
    - face/KernelTests/MailWidgetTests.swift
    - face/KernelTests/WidgetRenderTests.swift
  modified:
    - face/Kernel/CloudView/CloudWindow.swift
    - face/Kernel/AppCoordinator.swift
    - face/Kernel.xcodeproj/project.pbxproj

key-decisions:
  - "Preset shape: a presets: MAP (name -> step-id list) in morning-brief.yaml plus the full steps: catalogue. A step runs only when step.enabled AND the active preset lists its id. Per-step order/tier/params stay in ONE place; presets re-shape the brief without duplicating step blocks. Empty/absent preset entry falls back to all-enabled."
  - "engine.run is async (returns a Promise) because mail_triage awaits helper.classify; it returns { sequence, frames, widgetData, toolCalls } so tests can assert run order, ≤2-cue speak frames, and emitted envelopes."
  - "email_reply only FILLS the email-preview widget — it emits no auto-send ToolCall. The Send gate (the Yellow dispatch) lands in 04-02; the Face Send control exists and emits ui.intent{intent:'send-email'} but no code path sends without it."
  - "EventKit read lives Face-side (EventKitBridge) behind the app TCC identity, guarded under XCTest exactly like AppCoordinator.isUnderXCTest; the invitation reply is a ui.intent that routes the Yellow write back to the daemon gate."

patterns-established:
  - "Provider deps seam (StepDeps): the routine engine accepts injected balances/spending/emailPreview/events so it runs without the finance/mail plans"
  - "Gate-routed widget actions: every chip/Send/invitation action becomes a ui.intent; the Face never classifies a tier or acts locally"

requirements-completed: [ROUT-01, ROUT-02, ROUT-03, ROUT-04, ROUT-05]
duration: 38 min
completed: 2026-06-22
---

# Phase 4 Plan 01: Morning-Brief Routine Engine + Phase-4 Widgets Summary

A config-driven morning-brief engine that loads `routines/morning-brief.yaml` (zod-validated steps + Workday/Weekend/Travel presets), runs the enabled steps in order, and emits ONE `assembleSpeak` frame per narrated step (≤2 widgets, never a grid) — with 7B mail triage, Yellow invitation-reply envelopes routed through the shipped gate, and the four glass widgets (mail/accounts/spending/email-preview) wired into CloudWindow.

## What Was Built

- **Task 1 (RED, `244e8d1`):** `engine.test.ts` + `steps.test.ts` (16 tests) and the `morning-brief.yaml` fixture. Tests import `./engine.js`/`./steps.js` (absent) → confirmed failing-to-import RED.
- **Task 2 (GREEN, `f26bc36`):** `engine.ts` (yaml parse + zod `RoutineSchema`, typed `RoutineConfigError`, ordered/enabled async runner producing speak + widget.data frames + collected ToolCall envelopes), `steps.ts` (nine handlers; `mail_triage` → `helper.classify`; `invitations` → Yellow ToolCall envelope), `presets.ts` (`stepsForPreset`). All 16 tests green; anti-bypass grep clean.
- **Task 3 (Face, `642a6a1`):** `MailWidget`, `AccountsWidget`, `SpendingWidget`, `EmailPreviewWidget`, `EventKitBridge`, four `widgetView(named:)` cases in `CloudWindow`, `AppCoordinator.emitIntent`, and `MailWidgetTests` + `WidgetRenderTests` (13 tests). Project regenerated via XcodeGen; `xcodebuild test` green.

## Test Results

- **Daemon routine tests:** `npx tsx --test src/routines/engine.test.ts src/routines/steps.test.ts` → 16/16 pass.
- **Full daemon suite:** `npm test` → 124/124 pass (108 baseline + 16 new — no regression to shipped seams).
- **Daemon typecheck:** `npm run build` (tsc) → clean.
- **Face suite:** `xcodebuild -scheme Kernel -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO test` → 28/28 pass (15 baseline + 13 new: 6 MailWidgetTests + 7 WidgetRenderTests).
- **Anti-bypass guard:** `grep -nE "from '\.\./safety/(gate|tiers)" src/routines/engine.ts src/routines/steps.ts` → empty (engine/steps never self-classify).

## Requirements Coverage

- **ROUT-01:** Steps load from `morning-brief.yaml` (config, not hardcoded); every step zod-validated (enabled/order/tier/params?); malformed config → typed `RoutineConfigError`.
- **ROUT-02:** `preset:` switches the enabled-step set; Weekend trims work steps (no calendar), Travel keeps travel-relevant steps — proven by `notDeepEqual` on the run sequence.
- **ROUT-03:** Enabled steps run in ascending `order`, disabled skipped; each narrated step → ONE speak frame with ≤2 cues; greeting/weather are narration-only (empty widgetPlan).
- **ROUT-04:** `mail_triage` tags each message log/reply/open/archive via `helper.classify`; with Ollama mocked-absent every tag is the neutral default (`log`) and the handler never throws.
- **ROUT-05:** Invitation reply emits a `{tool:'mail', args:{op:'reply'}}` envelope that `classifyTier` classifies `yellow` centrally (a `delete` op would classify `red`); EventKit read is Face-side; the Face invitation-reply ui.intent carries no tier.

## Deviations from Plan

None - plan executed exactly as written.

The only design specifics the plan left open (and that the SUMMARY was asked to document): (1) the preset shape — chosen as a `presets:` map; (2) `engine.run` is async to accommodate `helper.classify`. Both are documented in key-decisions above.

## Known Stubs

The engine accepts finance/email/events data via an injected `StepDeps` provider seam; `balances`/`spending`/`email_reply`/`calendar` handlers do NOT fetch data themselves (by design — the finance plan 04-03 and email plan 04-02 supply the real providers). This is the intentional seam the plan specifies ("accept a provider seam so it is unit-testable in isolation"), not an unresolved stub. The email-preview Send control emits `ui.intent{intent:'send-email'}` but has no send code path — the gated send lands in 04-02 (MAIL-05 no-auto-send invariant, asserted in MailWidgetTests).

## Threat Flags

None — no new network endpoints, auth paths, or trust-boundary surface beyond the plan's `<threat_model>`. The invitation-reply write is the planned Yellow boundary (T-04-03) and routes through the existing gate; widgets render typed fields only (T-04-04).

## Manual Owner Checks (not automatable on this machine)

- Live calendar read + an invitation accept/propose (EventKit + Calendar TCC, owner's signed build).
- Visual/choreography fidelity of the four new widgets during a live brief (04-UI-SPEC §6 — owner runs and watches).

## Next

Ready for 04-02 (email reply flow — wires the Send Yellow gate behind the email-preview widget) and 04-03 (finance providers feeding accounts/spending). Both consume the `StepDeps` provider seam established here.

## Self-Check: PASSED

- All 14 key files verified on disk (`[ -f ]`).
- All three task commits verified in git log: `244e8d1` (RED tests + YAML), `f26bc36` (GREEN engine/steps/presets), `642a6a1` (Face widgets + bridge + wiring).
- Plan verification commands re-run green: 16 routine tests, 124 full daemon suite (≥108), 28 Face tests, anti-bypass grep empty, tsc clean.
