# Roadmap: KERNEL

## Overview

KERNEL is built in the spec's fixed, non-negotiable 5-phase order (§16). The journey moves from a persistent skeleton that holds memory and exposes the swap-seam (spec Phase 0), to hands that can act on the Mac and a browser behind a single gate chokepoint (spec Phase 1), to the conversational living-cloud face that closes the talk→reason→act→choreograph loop (spec Phase 2), to the routines, email reply flow, finance aggregation, and Claude Code bridge that make KERNEL a working foreman (spec Phase 3), and finally — GATED, owner approval required — to the tiered safety gate, circuit breaker, and self-maintenance that make autonomy safe to enable (spec Phase 4). Three cross-phase security seams are pulled forward as acceptance criteria: provenance/quarantine in Phase 1, the `gate.authorize` chokepoint in Phase 2, and the four-layer finance-leak prevention stack in Phase 4 (mapped to GSD numbering below). Phases 1–4 are built autonomously; the build HARD-STOPS before Phase 5.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work (GSD is 1-indexed; the spec is 0-indexed — each phase notes its spec-phase label)
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Skeleton** - Persistent TypeScript daemon, markdown memory injection, BrainProvider swap-seam, launchd heartbeat, provenance/quarantine seam (spec Phase 0)
- [ ] **Phase 2: Hands** - Peekaboo MCP + Playwright headful browser + tool router behind a single `gate.authorize` chokepoint with a thin tier-classifier (spec Phase 1)
- [ ] **Phase 3: Brain + Voice + the Cloud** - Pluggable cloud/local brain, whisper STT, AVSpeechSynthesizer TTS with boundary callbacks, Metal particle cloud, Stage controller choreographing widgets to speech (spec Phase 2)
- [ ] **Phase 4: Routines + Claude Code + Finance** - Morning-brief engine, email reply flow, finance aggregation + encrypted store + 4-layer leak prevention, Claude Code bridge (spec Phase 3)
- [ ] **Phase 5: Safety + Self-Maintenance** - GATED: tiered gate + `/override` + circuit breaker, nightly consolidation/cleanup/backup, self changelog + metrics (spec Phase 4)

## Phase Details

### Phase 1: Skeleton
**Goal**: (spec Phase 0) The daemon persists, injects memory, and the heartbeat fires — a TypeScript/Node daemon that survives across sessions, injects priority-ordered markdown memory at session start under the 16K-char cap, exposes the `BrainProvider` swap-seam returning a StubBrain, and fires a launchd heartbeat that writes a dated log entry. Provenance/quarantine seam is laid here.
**Mode:** mvp
**Depends on**: Nothing (first phase)
**Requirements**: CORE-01, CORE-02, CORE-03, CORE-04, CORE-05, MEM-01, MEM-02, MEM-03, MEM-04, MEM-05, MEM-06, BRAIN-01, PERS-01, PERS-02, PERS-03
**Success Criteria** (what must be TRUE):
  1. The daemon relaunches at login via launchd, runs the perceive→recall→decide→act→log loop event-driven, and falls genuinely idle when there is no work (CORE-01, CORE-02).
  2. At session start, memory is injected in priority order — IDENTITY.md → working-memory/current → retrieved knowledge/tasks/projects — under a hard ~16K-char cap that never drops IDENTITY.md, and IDENTITY.md passes a startup hash check that no automated path can modify (MEM-02, MEM-03, PERS-01).
  3. A timed launchd heartbeat fires and writes a dated entry to the append-only event log under the memory repo (CORE-03, CORE-05).
  4. The `BrainProvider` interface — `reason(prompt, context) → { thought, action?, reply? }` — exists and is satisfied by a StubBrain, with the context object carrying a `source:` provenance tag on each item (BRAIN-01, MEM-05).
  5. Externally-sourced content lands in `working-memory/quarantine/` and is never auto-promoted to knowledge/ or IDENTITY.md; the `kernel-memory/finance/` path is gitignored; the Face can attach over the localhost IPC socket without a daemon restart (MEM-05, MEM-06, CORE-04).
**Plans**: 3 plans
Plans:
- [ ] 01-01-PLAN.md — Scaffold + kernel-memory/ repo (IDENTITY persona, finance gitignore) + BrainProvider/StubBrain + provenance shape + test harness + failing e2e contract (MEM-01, MEM-06, BRAIN-01, MEM-05, PERS-01/02/03)
- [ ] 01-02-PLAN.md — Memory engine: IDENTITY hash guard, keyword retrieval + authority×recency rerank, quarantine write path, priority injection under 16K cap (MEM-02, MEM-03, MEM-04, MEM-05, PERS-01)
- [ ] 01-03-PLAN.md — UDS NDJSON IPC + event-driven loop + append-only log + heartbeat + launchd plists; closes the end-to-end tick (CORE-01, CORE-02, CORE-03, CORE-04, CORE-05)

### Phase 2: Hands
**Goal**: (spec Phase 1) Kernel can open Mail and drive a browser task end-to-end — Peekaboo MCP (capture/click/type/Mail) plus a Playwright headful browser tool on a dedicated profile, dispatched through a tool router where every call routes through a single `gate.authorize(call)` chokepoint (thin classify-only tier-classifier; no breaker, no `/override` yet).
**Mode:** mvp
**Depends on**: Phase 1
**Requirements**: HANDS-01, HANDS-02, HANDS-03, HANDS-04, HANDS-05
**Success Criteria** (what must be TRUE):
  1. KERNEL captures the screen, clicks, types, and drives GUI-only apps and menus via the Peekaboo MCP tool, and opens and drives Mail through it (HANDS-01, HANDS-02).
  2. KERNEL logs into a site, scrapes, and fills a form end-to-end using the Playwright headful browser on a dedicated persistent profile (not the user's real Chrome profile), with every navigation logged with full URL + provenance (HANDS-03).
  3. A tool router registers tools (Claude Code, Peekaboo, Playwright, local 7B, mail, weather, finance) and dispatches calls to them (HANDS-04).
  4. Every tool dispatch routes through one `gate.authorize(call)` chokepoint between the router and every tool invocation; no tool self-classifies its tier and no path bypasses the chokepoint (HANDS-05).
  5. The Peekaboo type-tool detects secure fields (password/card/cvv/ssn labels, autocomplete hints, secure text fields) and refuses to type secrets, returning an escalation — the credential-entry fence lands here because the physical capability to type secrets lands here (HANDS-01, HANDS-05).
**Plans**: TBD

### Phase 3: Brain + Voice + the Cloud
**Goal**: (spec Phase 2) You can talk to Kernel, it reasons, the cloud reacts, and a widget choreographs to its speech — pluggable brain (Claude cloud default, Ollama local toggle, Claude Code routing, always-on local 7B helper), whisper.cpp STT + AVSpeechSynthesizer TTS with `willSpeakRangeOfSpeechString` boundary callbacks, SwiftUI spatial-black canvas with a Metal particle cloud reacting to mic amplitude, and a Stage controller blooming/dissolving one widget on speech. This is the highest-risk lynchpin phase.
**Mode:** mvp
**Depends on**: Phase 2
**Requirements**: BRAIN-02, BRAIN-03, BRAIN-04, BRAIN-05, BRAIN-06, VOICE-01, VOICE-02, VOICE-03, VOICE-04, CLOUD-01, CLOUD-02, CLOUD-03, CLOUD-04, CLOUD-05, CLOUD-06
**Success Criteria** (what must be TRUE):
  1. Pravin speaks to KERNEL (whisper.cpp STT subprocess), it reasons via the selected brain, and responds — with ClaudeBrain (claude-opus-4-8) as default, LocalBrain (Ollama qwen2.5:7b) selectable from Settings, ClaudeCodeBrain for code-heavy reasoning, and the local 7B always running as the cheap triage/classification/narration helper regardless of selected brain (VOICE-01, VOICE-02, BRAIN-02, BRAIN-03, BRAIN-04, BRAIN-05).
  2. TTS-boundary choreography works (P2 lynchpin): `willSpeakRangeOfSpeechString` emits word/segment boundaries; the daemon sends `speak` frames carrying character-keyed `cues[]` assembled by the daemon and the Face fires them on boundary crossing — the daemon NEVER sends timing-estimate messages — and the Stage controller supports both word-level (callback-driven) and sentence-level (time-based) pacing so choreography survives flaky boundary callbacks. An on-device spike of `willSpeakRangeOfSpeechString` on the target macOS version and voice MUST precede the full Stage build (VOICE-03, VOICE-04, CLOUD-04).
  3. A native SwiftUI menubar app launches at login (MenuBarExtra + SMAppService), connects to the daemon over the localhost socket, and renders a deep spatial-black canvas with a real GPU Metal particle cloud that drifts when idle (CLOUD-01, CLOUD-02).
  4. While speaking, mic RMS amplitude (computed entirely within the Face, never round-tripping the daemon) pushes particles outward and brightens them between indigo #7C8CFF and cyan #42E8E0; a frosted-glass widget blooms forward while a topic is spoken then disperses back into the cloud, one or two widgets in focus at a time (CLOUD-03, CLOUD-04).
  5. The cloud holds two states — full-screen when speaking/at boot, shrunk top-left corner pill during a Claude Code session — and the design language holds: shadcn-grade dark restraint, hairline borders, SF Pro, tabular numerals, spring motion (nothing snaps), one accent only. The brain's tool loop stays manual (decision → gate → execution), never an auto-runner that bypasses the gate (CLOUD-05, CLOUD-06, BRAIN-06).
**Plans**: TBD
**UI hint**: yes

### Phase 4: Routines + Claude Code + Finance
**Goal**: (spec Phase 3) A full morning brief runs, choreographed, including a gated email send and live spending charts — morning-brief engine (YAML, presets Workday/Weekend/Travel), email reply flow (intent→voice profile→few-shot→preview→gated send), read-only finance aggregation + encrypted gitignored SQLCipher store + W/M/Y spending charts, and a Claude Code bridge with first-person prompting, transparency corner-pill, and project registry. The four-layer finance-leak prevention stack must be verified passing before any backup job exists.
**Mode:** mvp
**Depends on**: Phase 3
**Requirements**: ROUT-01, ROUT-02, ROUT-03, ROUT-04, ROUT-05, MAIL-01, MAIL-02, MAIL-03, MAIL-04, MAIL-05, FIN-01, FIN-02, FIN-03, FIN-04, FIN-05, CC-01, CC-02, CC-03, CC-04
**Success Criteria** (what must be TRUE):
  1. A full morning brief runs from `routines/morning-brief.yaml` (each step a module with enabled/order/params/tier), with Workday/Weekend/Travel presets switchable, running steps (greeting, weather, calendar, invitations, mail triage, unread announce, email reply, balances, spending) one or two at a time choreographed via the Stage controller — never a static grid; mail triage uses the local 7B to tag messages, and calendar reads via EventKit with Yellow-tier invitation replies (ROUT-01, ROUT-02, ROUT-03, ROUT-04, ROUT-05).
  2. Email reply flow works end-to-end: on "reply" KERNEL asks for one-line intent, rewrites it in Pravin's email voice via an always-injected ~200-token voice profile plus 2–3 few-shot past emails most similar to the recipient, routes stakes (casual→local 7B, high-stakes→cloud), renders a preview card, and sends nothing without an explicit "Send it?" Yellow-tier confirmation — never auto-sending and never sending to an externally-sourced address without showing it (MAIL-01, MAIL-02, MAIL-03, MAIL-04, MAIL-05).
  3. Finance is accessed only via read-only Plaid-style OAuth (KERNEL never types banking credentials/card numbers — hard rule), balances/transactions live in a local gitignored SQLCipher-encrypted store with the key in macOS Keychain, and W/M/Y switchable spending charts render from locally-aggregated transactions (FIN-01, FIN-02, FIN-03, FIN-05).
  4. The four-layer finance-leak prevention stack is verified passing before any backup job exists (gates Phase 5): (a) broad gitignore for finance/ + SQLCipher sidecars, (b) a pre-commit/pre-push hook scanning staged bytes for finance paths/patterns — verified by a deliberate test that confirms push aborts, (c) at-rest AES-256 encryption with the key in Keychain, (d) a startup `git ls-files | grep finance` assertion that fails loud (FIN-04).
  5. The Claude Code bridge authors prompts in first person as Pravin, shows a live scrollable transparency corner-pill transcript Pravin can read/interject/pause, records every project to `projects/registry.md` for cold resume, and routes any Red-tier action up to the `gate.authorize()` chokepoint via an intercept shim — Claude Code runs Green/Yellow-only with no ambient money/irreversible rights until Phase 5 (CC-01, CC-02, CC-03, CC-04).
**Plans**: TBD
**UI hint**: yes

### Phase 5: Safety + Self-Maintenance (GATED — DO NOT AUTO-EXECUTE)
**Goal**: (spec Phase 4) Red-tier actions are gated end-to-end (including inside Claude Code) and the maintenance jobs run on schedule — only now is autonomy safe to enable. Full tiered safety gate (tiers.ts + gate.ts + breaker.ts), `/override` scoped to Green/Yellow, circuit breaker (dry-run → 10s cancel → spend-ceiling check → audit), nightly consolidation + cleanup + GitHub backup, and self changelog + metrics. **HARD STOP: this phase enables money, `rm -rf`, and `/override`. The owner builds Phases 1–4 autonomously and HARD-STOPS before Phase 5; do not auto-execute — explicit owner approval is required to begin.**
**Mode:** mvp
**Depends on**: Phase 4 (all four finance-leak prevention layers verified passing) + explicit owner approval
**Requirements**: SAFE-01, SAFE-02, SAFE-03, SAFE-04, SAFE-05, SAFE-06, SAFE-07, MAINT-01, MAINT-02, MAINT-03, MEM-07
**Success Criteria** (what must be TRUE):
  1. Actions classify into 🟢 Green (reversible) / 🟡 Yellow (recoverable) / 🔴 Red (irreversible/financial); `/override` unlocks Green at full speed and Yellow proceed+log+notify; Red is always gated even under `/override` via dry-run preview → 10s cancel window → spend-ceiling check (no race on the counter) → audit log (SAFE-01, SAFE-02, SAFE-03).
  2. The three never-overridable rules hold even under `/override`, verified by tests: no entering credentials/passwords/cards/SSN (escalate), no Red action whose instruction originated in external content (a test-injection email cannot trigger a Red action under active `/override`), and a user-set daily spend ceiling forces escalation with atomic single-writer spend accounting (SAFE-04).
  3. Red-tier gating applies inside Claude Code sessions (a `rm -rf`/purchase action re-enters the same breaker via the re-submission shim and does not auto-run), and execution re-verifies the confirmed action against a content hash with state re-read immediately before acting (TOCTOU defense) (SAFE-05).
  4. The obstacle planner runs the ladder — try → replan → decompose → retry-with-backoff → escalate with a SPECIFIC recommendation ("X blocked by Y; I recommend Z. Approve?") — never a vague "I'm stuck"; only Red-tier gates skip the ladder and escalate immediately. `/override` and Red-tier routes were unreachable (feature-flagged off) in Phases 1–4 (SAFE-06, SAFE-07).
  5. Maintenance jobs run on schedule via launchd: a nightly consolidation distills logs → reflections and promotes only durable, source-vetted facts → knowledge (IDENTITY.md and knowledge/ unchanged after a consolidation run that processed only external-sourced logs), a cleanup prunes stale working-memory/logs, and a backup uses explicit `git add <paths>` (never `-A`) to push the memory repo to private GitHub never including finance/, with self/changelog.md and self/metrics.md maintained (MEM-07, MAINT-01, MAINT-02, MAINT-03).
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 (Phase 5 GATED — requires explicit owner approval before execution).

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Skeleton (spec P0) | 0/3 | Not started | - |
| 2. Hands (spec P1) | 0/TBD | Not started | - |
| 3. Brain + Voice + the Cloud (spec P2) | 0/TBD | Not started | - |
| 4. Routines + Claude Code + Finance (spec P3) | 0/TBD | Not started | - |
| 5. Safety + Self-Maintenance (spec P4) [GATED] | 0/TBD | Gated — owner approval required | - |
