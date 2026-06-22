---
phase: 4
slug: routines-claude-code-finance
status: draft
design_system: none (native SwiftUI/Metal; extends 03-UI-SPEC)
created: 2026-06-22
---

# Phase 4 — UI Design Contract (extends Phase 3)

> The foundation tokens, motion law, the cloud, and the bloom/dissolve Stage choreography are **already defined and locked** in `../03-brain-voice-the-cloud/03-UI-SPEC.md`. That contract is authoritative and unchanged. This document adds only the **Phase-4-specific** widget data-states and interactions: the remaining four widgets rendered with real data, the morning-brief step choreography, the email-preview send-gate, and the Claude Code transparency pill. All widgets are glass, bloom-and-dissolve, one-or-two-in-focus, terse reporting register, accent reserved for active/focus only.

## Inherited (do not redefine — see 03-UI-SPEC)
- Color (near-black `#08080A`, zinc neutrals, the single indigo `#7C8CFF`↔cyan `#42E8E0` accent reserved list), hairline borders white 6–8%.
- Typography: Display 28 / Heading 20 / Body 16 / Label 14; Regular 400 / Semibold 600; SF Pro Display vs Text; **tabular numerals mandatory on all money/counts**.
- Motion springs (bloom ≈0.5/0.8, dissolve ≈0.45/0.85, cloud-state ≈0.6/0.8, count-up ease); nothing snaps.
- Stage: bloom (0.96→1, opacity in, forward-blur clears) → hold → disperse, fired on character-keyed cues / boundary crossings; max 2 widgets in focus.

## Phase-4 widget data-states & interactions

### 1. Morning-brief step choreography (ROUT)
- The routine engine narrates each step; as a topic is spoken, the matching widget blooms via the existing cue→Stage path, holds while spoken about, disperses as the brief moves on. Never a static grid — one/two at a time.
- Greeting/weather are narration-only (no card or a minimal glass line). Steps map: calendar→events widget, mail_triage/unread→mail widget, balances→accounts widget, spending→spending widget, email_reply→email-preview card.
- Preset (Workday/Weekend/Travel) is owner-set config; no in-brief preset switcher UI required this phase (config file is the source of truth).

### 2. Mail widget + suggested-action chips (ROUT-04, MAIL)
- Glass card: sender, subject, one-line snippet (terse). Below, **suggested-action chips** (min 28px height, 44px hit target): `Log` / `Reply` / `Open` / `Archive` — the 7B triage tag is pre-highlighted (chip uses the accent ring only when it is the active/focused suggestion). Tapping/speaking a chip dispatches through the gate.
- Empty: "No unread." Error: "Mail unavailable — {reason}." (escalation copy).

### 3. Email-preview "Send it?" card (MAIL-04/05) — the Yellow-tier gate
- Glass card showing **To / Subject / body / signature** exactly as it will send; body in Body 16, addresses in Label 14. If the To address came from external content, show a subtle accent-ringed "external" marker next to it (never silently send to it).
- Two controls only: **Edit** (re-opens intent → re-preview) and **Send** (the single CTA — accent-filled). NOTHING sends without an explicit Send. No auto-send path exists in the UI.
- On Send: card dissolves, a one-line confirmation count-up ("Sent. Marked read."). Nothing about credentials ever appears.

### 4. Accounts (balances) widget (FIN)
- Glass card: account rows (name + masked tail), balance right-aligned with **tabular numerals**, count-up on appear. Read-only — no action chips. Never shows full account/card numbers.

### 5. Spending widget with W/M/Y toggle (FIN-05)
- Glass card: a segmented **W / M / Y** control (pill segments, accent only on the active segment); switching animates the chart with a spring (bars/line ease between timeframes, numbers count up — nothing snaps). Totals in tabular numerals.
- Data computed locally from the encrypted store; the widget never touches Plaid directly. Empty: "No transactions yet."

### 6. Claude Code transparency corner-pill (CC-02)
- Reuses the shipped `cornerPill` cloud state. When a Claude Code session runs, the cloud shrinks to the top-left pill showing a **live, scrollable transcript** of Kernel↔Claude (what Kernel asks in first person; what Claude does). Monospace-ish Label text, newest at bottom, auto-scroll with manual scrollback. A subtle accent live-pulse dot indicates streaming.
- Owner can read along / interject / pause (pause control in the pill). Returns to full-screen cloud when the session ends.

## 6-Pillar quality gate (same split as 03-UI-SPEC)
- **Structurally verifiable (checker/XCTest):** widgets exist and render the data fields; W/M/Y toggle switches series; email-preview exposes To/Subject/body/signature + Edit/Send and has NO auto-send path; tabular numerals on money; transcript pill renders streamed events; chips dispatch through the gate.
- **Manual owner check (run & watch):** real choreography sync during a live brief, chart spring feel, transcript readability during a real Claude Code session, overall fidelity over the moving cloud. Live Plaid link, live Mail/Gmail send, live calendar, live Claude Code session are owner manual checks.
