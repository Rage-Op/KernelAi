# Requirements: KERNEL

**Defined:** 2026-06-22
**Core Value:** KERNEL persists and acts on Pravin's behalf without clocking out — holding memory across sessions, running routines, and routing work to the right tool, always behind a safety gate that makes "got robbed by a poisoned email" structurally impossible.

> Scope note: KERNEL's "user" is its owner, **Pravin**. Requirements are phrased as owner-facing or system capabilities. The build runs in 5 fixed phases (spec P0→P4, GSD Phase 1→5). Per owner directive, **GSD Phases 1–4 (spec P0–P3) are built autonomously; GSD Phase 5 (spec P4: SAFE-full + MAINT) is GATED** — its requirements are in v1 scope but execution stops before it begins.

## v1 Requirements

### Core / Daemon (CORE) — Phase 1 (spec P0)

- [x] **CORE-01**: A TypeScript/Node daemon runs as a persistent process and survives across sessions (relaunched at login via launchd).
- [x] **CORE-02**: The daemon runs the core loop — perceive → recall → decide → act → log — as an event-driven runner (woken by input, launchd, or tool callbacks), falling genuinely idle when there is no work.
- [x] **CORE-03**: A launchd login agent starts the daemon at login; a timed launchd job fires a heartbeat that writes a dated log entry.
- [x] **CORE-04**: The daemon exposes a localhost IPC endpoint (Unix domain socket, NDJSON frames) for the Face to connect to.
- [x] **CORE-05**: All daemon activity is logged to an append-only event log under the memory repo.

### Memory (MEM) — Phase 1 (base, spec P0), Phase 5 (consolidation/prune, spec P4)

- [x] **MEM-01**: Memory lives as Markdown + YAML front-matter in a dedicated git repo (`kernel-memory/`) with the spec's directory layout (IDENTITY, working-memory, knowledge, tasks, projects, logs, self).
- [x] **MEM-02**: `IDENTITY.md` (persona + voice rules) is injected at the start of every session and is never auto-edited.
- [x] **MEM-03**: Session injection follows priority order (IDENTITY → working-memory/current → retrieved knowledge/tasks/projects) under a hard ~16K-char cap.
- [x] **MEM-04**: Relevant memory is retrieved by keyword (no embeddings) and reranked by an authority×recency signal.
- [x] **MEM-05**: Externally-sourced content (email/web) carries a `source:` provenance tag through the context layer and lands in a `working-memory/quarantine/` bucket; it is never auto-promoted to `knowledge/` or `IDENTITY.md`. *(P0 seam; promotion gate completes in P4.)*
- [x] **MEM-06**: The `kernel-memory/finance/` path is gitignored and excluded from any backup.
- [ ] **MEM-07**: A nightly consolidation job distills logs → reflections and promotes durable facts → knowledge; a cleanup job prunes stale working-memory/logs. *(Phase 5 / spec P4.)*

### Brain (BRAIN) — Phase 1 (interface + stub, spec P0), Phase 3 (impls, spec P2)

- [x] **BRAIN-01**: A `BrainProvider` interface — `reason(prompt, context) → { thought, action?, reply? }` — is defined in Phase 1, before any implementation.
- [x] **BRAIN-02**: `ClaudeBrain` (Anthropic API, `claude-opus-4-8`) is the default brain for hard planning, recovery, and judgment.
- [x] **BRAIN-03**: `LocalBrain` POSTs to Ollama `/api/chat` (`qwen2.5:7b-instruct-q4_K_M`) and is selectable from Settings (`brain = cloud | local`); the UI surfaces that local is private/free but visibly weaker on 16GB.
- [x] **BRAIN-04**: A `ClaudeCodeBrain` routes code-heavy reasoning to Claude Code headless.
- [x] **BRAIN-05**: The local 7B always runs as the cheap high-frequency helper (triage, classification, short narration) regardless of the selected brain.
- [x] **BRAIN-06**: The brain's tool loop is manual (decision → safety gate → execution), never an auto-runner that bypasses the gate.

### Hands — GUI & Browser & Routing (HANDS) — Phase 2 (spec P1)

- [x] **HANDS-01**: A Peekaboo MCP tool lets KERNEL capture the screen, click, type, and drive GUI-only apps and menus.
- [x] **HANDS-02**: KERNEL can open and drive Mail through Peekaboo.
- [x] **HANDS-03**: A Playwright (headful) browser tool, using a dedicated persistent profile, can log in, scrape, and fill forms end-to-end.
- [x] **HANDS-04**: A tool router registers tools (Claude Code, Peekaboo, Playwright, local 7B, mail, weather, finance) and dispatches calls to them.
- [x] **HANDS-05**: Every tool dispatch routes through a single `gate.authorize(call)` chokepoint (thin tier-classifier in P1; full gate in P4) — no tool self-classifies its tier and no path bypasses the chokepoint.

### Voice (VOICE) — Phase 3 (spec P2)

- [x] **VOICE-01**: whisper.cpp runs as a subprocess (Core ML/ANE build); mic audio is piped in and a transcript is read out (STT).
- [x] **VOICE-02**: Pravin can speak to KERNEL and it reasons and responds.
- [x] **VOICE-03**: TTS uses AVSpeechSynthesizer; the `willSpeakRangeOfSpeechString` delegate emits word/segment boundaries that drive on-screen choreography.
- [x] **VOICE-04**: The Stage controller supports both word-level (callback-driven) and sentence-level (time-based) pacing so choreography survives flaky boundary callbacks.

### The Cloud — Face / UI (CLOUD) — Phase 3 (spec P2)

- [x] **CLOUD-01**: A native SwiftUI menubar app launches at login (MenuBarExtra + SMAppService) and connects to the daemon over the localhost socket.
- [x] **CLOUD-02**: A deep spatial-black canvas renders a real GPU particle cloud (Metal compute-shader particles) that drifts when idle.
- [x] **CLOUD-03**: While speaking, mic RMS amplitude pushes particles outward and brightens them; quiet pulls them calm — color lives between indigo `#7C8CFF` and cyan `#42E8E0`.
- [x] **CLOUD-04**: A Stage controller, driven by the routine engine and TTS boundaries, makes a frosted-glass widget bloom forward (0.96→1, opacity in, forward-blur clears) while a topic is spoken, then disperses it back into the cloud — one or two widgets in focus at a time.
- [x] **CLOUD-05**: The cloud has two states: full-screen when speaking/at boot, and a shrunk top-left corner pill during a Claude Code session.
- [x] **CLOUD-06**: The design language holds — shadcn-grade dark restraint, hairline borders, SF Pro, tabular numerals for money, spring motion (nothing snaps), one accent only.

### Routines / Morning Brief (ROUT) — Phase 4 (spec P3)

- [x] **ROUT-01**: The morning brief is a config file (`routines/morning-brief.yaml`), not hardcoded; each step is a module with `enabled`, `order`, `params`, `tier`.
- [x] **ROUT-02**: Presets Workday / Weekend / Travel are supported and switchable.
- [x] **ROUT-03**: The brief runs its steps (greeting, weather, calendar, invitations, mail triage, unread announce, email reply, balances, spending) one or two at a time, choreographed to narration via the Stage controller — never a static grid.
- [x] **ROUT-04**: Mail triage uses the local 7B to tag messages (log / reply / open / archive).
- [x] **ROUT-05**: Calendar reads via EventKit; invitations that accept/propose write a reply (Yellow tier).

### Email Reply Flow (MAIL) — Phase 4 (spec P3)

- [x] **MAIL-01**: On "reply", KERNEL asks Pravin for one-line intent, then rewrites it into Pravin's email voice using a ~200-token voice profile distilled once from real sent mail (greeting, sign-off, sentence length, formality range, emoji y/n), always injected.
- [x] **MAIL-02**: Few-shot retrieval pulls 2–3 of Pravin's past emails most similar to the recipient as live examples.
- [x] **MAIL-03**: Stakes routing — casual/short replies use the local 7B (free); high-stakes (new client, money, sensitive) use the cloud brain.
- [x] **MAIL-04**: A preview card (To / Subject / body / signature) is rendered; nothing sends without an explicit "Send it?" confirmation (Yellow-tier gate).
- [x] **MAIL-05**: KERNEL never auto-sends and never sends to an address that came from external content without showing it; on send it dispatches via Mail/Gmail, marks the source read, and logs.

### Finance (FIN) — Phase 4 (spec P3)

- [x] **FIN-01**: Financial data is accessed only via a read-only aggregation API (Plaid-style OAuth); Pravin authorizes once in the bank's own flow and KERNEL receives read-only tokens.
- [x] **FIN-02**: KERNEL never types banking credentials/card numbers into any field (hard rule).
- [x] **FIN-03**: Balances and transactions live in a local, gitignored, encrypted store (SQLCipher, DB key in macOS Keychain) under `kernel-memory/finance/`.
- [x] **FIN-04**: Finance-leak prevention has all four layers verified passing before any backup job exists: broad gitignore, a pre-push hook scanning staged bytes, at-rest encryption, and a startup `git ls-files` assertion. *(P3 acceptance criterion — gates P4 backup.)*
- [x] **FIN-05**: Spending charts render with W/M/Y switchable timeframes, computed locally from aggregated transactions.

### Claude Code Bridge (CC) — Phase 4 (spec P3)

- [x] **CC-01**: KERNEL authors prompts to Claude Code in first person, as Pravin — personal, direct register.
- [x] **CC-02**: A transparency corner-pill shows a live, scrollable transcript of Kernel ↔ Claude; Pravin can read along, interject, or pause.
- [x] **CC-03**: Any Claude Code action that hits Red tier routes through KERNEL's circuit breaker and does not auto-run mid-session. *(Chokepoint respected in P3; breaker enabled in P4.)*
- [x] **CC-04**: Every Claude Code project is written to `projects/registry.md` so KERNEL resumes cold across sessions.

### Safety — Tiered Autonomy & Circuit Breaker (SAFE) — Phase 2 (chokepoint, spec P1), Phase 5 (full, spec P4) — GATED

- [x] **SAFE-01**: Actions are classified into tiers — 🟢 Green (reversible), 🟡 Yellow (recoverable), 🔴 Red (irreversible/financial).
- [x] **SAFE-02**: `/override` (typed or voice) unlocks autonomy: Green runs at full speed, Yellow proceeds + logs + briefly notifies.
- [x] **SAFE-03**: Red tier is always gated even under `/override`: dry-run preview → 10-second cancel window → spend-ceiling check → audit log, with no race on the spend counter.
- [x] **SAFE-04**: Hard non-overridable rules hold: no entering credentials/passwords/cards/SSN (escalate); no Red action whose instruction originated in external content (quarantine + escalate); a user-set daily spend ceiling forces escalation when exceeded.
- [x] **SAFE-05**: Red-tier gating applies inside Claude Code sessions too (re-submission shim re-enters the same breaker).
- [x] **SAFE-06**: The obstacle planner runs the ladder — try → replan → decompose → retry-with-backoff → escalate with a SPECIFIC recommendation ("X blocked by Y; I recommend Z. Approve?") — never a vague "I'm stuck"; only Red-tier gates skip the ladder and escalate immediately.
- [x] **SAFE-07**: `/override` and the Red tier are not enabled until Phase 5 (spec P4) is built and tested.

### Self-Maintenance (MAINT) — Phase 5 (spec P4) — GATED

- [ ] **MAINT-01**: A nightly launchd job commits and pushes the memory repo to a private GitHub backup (never including `finance/`).
- [ ] **MAINT-02**: KERNEL maintains `self/changelog.md` and `self/metrics.md`.
- [ ] **MAINT-03**: The maintenance jobs (consolidation, cleanup, backup) run on schedule via launchd.

### Persona & Voice (PERS) — Phase 1 (IDENTITY, spec P0), refined through Phase 4 (spec P3)

- [x] **PERS-01**: To Pravin, KERNEL is direct, terse, reporting-style — no bargaining once a task is stated; only vital details in notifications.
- [x] **PERS-02**: For outward content, register is dynamic — warm for personal email, sharp for posts, formal for docs.
- [x] **PERS-03**: On vocabulary mismatch, KERNEL elaborates/clarifies rather than guessing.

## v2 Requirements

### Retrieval

- **MEM-V2-01**: Add embedding-based retrieval *only if* keyword recall proves insufficient (measured in P3/P4), within the RAM budget.

### Routines

- **ROUT-V2-01**: Additional routine presets and step modules beyond Workday/Weekend/Travel.

### Voice

- **VOICE-V2-01**: Higher-quality TTS voice beyond AVSpeechSynthesizer if boundary-callback fidelity or naturalness demands it.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Embedding a model inside the daemon | Violates the HTTP-boundary rule; model runs as its own process (Ollama) over HTTP to stay swappable |
| Fine-tuning for email voice | Profile + few-shot gets ~90% fidelity at near-zero cost |
| Typing banking/credential/card/SSN into fields | Hard safety rule, never overridable; finance is read-only aggregation only |
| Embeddings-first memory retrieval | Costs RAM the 16GB machine doesn't have; keyword first |
| Static dashboard / grid-of-cards UI | Explicitly discarded; the interface is a living cloud choreographing widgets to speech |
| Enabling `/override` / Red tier before Phase 5 (spec P4) | Safety: autonomy isn't safe until the gate + breaker are built and tested |
| Auto-promoting externally-sourced memory writes | Memory poisoning — turns a one-shot injection into a permanent backdoor |

## Traceability

GSD phases are 1-indexed; the spec (§16) is 0-indexed. The mapping is one GSD phase per spec phase: GSD Phase 1 = spec P0, Phase 2 = spec P1, Phase 3 = spec P2, Phase 4 = spec P3, Phase 5 = spec P4.

| Requirement | Phase | Status |
|-------------|-------|--------|
| CORE-01..05 | Phase 1 (spec P0) | Pending |
| MEM-01..06 | Phase 1 (spec P0) | Pending |
| MEM-07 | Phase 5 (spec P4; gated) | Pending |
| BRAIN-01 | Phase 1 (spec P0) | Complete |
| BRAIN-02..06 | Phase 3 (spec P2) | Pending |
| PERS-01..03 | Phase 1 (spec P0; refined through Phase 4) | Pending |
| HANDS-01..05 | Phase 2 (spec P1) | Pending |
| VOICE-01..04 | Phase 3 (spec P2) | Pending |
| CLOUD-01..06 | Phase 3 (spec P2) | Pending |
| ROUT-01..05 | Phase 4 (spec P3) | Pending |
| MAIL-01..05 | Phase 4 (spec P3) | Pending |
| FIN-01..05 | Phase 4 (spec P3) | Pending |
| CC-01..04 | Phase 4 (spec P3) | Pending |
| SAFE-01..07 | Phase 5 (spec P4; gated; chokepoint lands Phase 2) | Pending |
| MAINT-01..03 | Phase 5 (spec P4; gated) | Pending |

**Coverage:**
- v1 requirements: 53 total across 13 categories
- Mapped to phases: 53
- Unmapped: 0 ✓

---
*Requirements defined: 2026-06-22*
*Last updated: 2026-06-22 after roadmap creation (traceability re-mapped to GSD 1-indexed phases)*
