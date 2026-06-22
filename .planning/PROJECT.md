# KERNEL

## What This Is

KERNEL is a persistent local AI orchestrator for macOS — a "foreman that never clocks out." It is not a smarter coding assistant; it is a long-lived daemon that persists across sessions, holds distilled memory, runs daily routines, controls the Mac through GUI and browser automation, and hires Claude Code as a sub-contractor when code needs writing. The owner is **Pravin Maurya**; in voice and judgment KERNEL is a digital copy of Pravin — direct and terse to him, register-shifting for outward content (email, posts, docs).

## Core Value

KERNEL persists and acts on Pravin's behalf without clocking out: it holds memory across sessions, runs the morning brief, and routes work to the right tool (Claude Code, Peekaboo, browser, local model) — always behind a safety gate that makes "got robbed by a poisoned email" structurally impossible.

## Requirements

### Validated

(None yet — ship to validate)

### Active

<!-- Mirrors the 5 build phases in the master spec (§16). Built Phase 0→3 autonomously; Phase 4 gated. -->

- [ ] **P0 — Skeleton**: TypeScript daemon that persists, injects markdown memory at session start, exposes the `BrainProvider` interface, and fires a launchd heartbeat that writes a log entry.
- [ ] **P1 — Hands**: Peekaboo MCP (capture/click/type/Mail) + Playwright headful browser tool + tool router; KERNEL can open Mail and drive a browser task end-to-end.
- [ ] **P2 — Brain + voice + the cloud**: pluggable brain (Claude cloud default, Ollama local toggle), whisper.cpp STT + AVSpeechSynthesizer TTS with `willSpeakRangeOfSpeechString` boundary callbacks, SwiftUI spatial-black canvas + Metal particle cloud + Stage controller blooming one widget on speech.
- [ ] **P3 — Routines + Claude Code + finance**: morning-brief engine (YAML, presets Workday/Weekend/Travel), email reply flow (intent→voice profile→few-shot→preview→send), finance aggregation + encrypted gitignored store + W/M/Y spending charts, Claude Code bridge with transparency corner-pill + project registry.
- [ ] **P4 — Safety + self-maintenance** *(GATED — do not build without explicit approval)*: tiered autonomy gate + `/override` + circuit breaker (Red-tier always gated, even under override and inside Claude Code), nightly consolidation + cleanup + GitHub backup, self changelog + metrics.

### Out of Scope

- **Embedding a model in the daemon** — violates the HTTP-boundary rule (§2); model runs as its own process (Ollama) behind HTTP so it stays swappable and TypeScript stays viable.
- **Fine-tuning for email voice** — profile + few-shot retrieval gets ~90% voice fidelity at near-zero cost (§12).
- **Typing banking/credential/card/SSN into fields** — hard rule, never overridable (§8); finance is read-only aggregation (Plaid-style OAuth) only.
- **Embeddings for memory retrieval (initially)** — keyword retrieval first; embeddings only if recall is poor, because they cost RAM the 16GB machine doesn't have (§5).
- **Static dashboard / grid-of-cards UI** — explicitly discarded (§15); the interface is a living particle cloud that choreographs widgets to speech.
- **Enabling `/override` / Red-tier autonomy before Phase 4 is built and tested** (§8).

## Context

- **Owner & persona**: Pravin Maurya. KERNEL speaks to Pravin in a direct, terse, reporting register (no bargaining, no filler). For outward content it shifts register (warm personal email, sharp posts, formal docs). Persona lives in `kernel-memory/IDENTITY.md`, injected every session, never auto-edited.
- **Target hardware**: MacBook Pro 16" · M2 Pro · **16GB RAM**. The 16GB ceiling drives every architectural decision (local model is Q4 7B, Ollama unloads idle models, keyword retrieval over embeddings).
- **Architectural keystone — the HTTP boundary**: the daemon never embeds a model. Ollama runs as its own process exposing HTTP; the daemon POSTs prompts and reads text. whisper.cpp is a spawned binary. This is *why* TypeScript is fine despite MLX being Python-only, and it makes the brain swappable by changing a URL.
- **Memory pattern (agentic-OS)**: markdown + YAML front-matter in a git repo, injected at session start, distilled on a schedule (distillation matters more than storage — raw logs are not memory). Reference implementation studied: `Rage-Op/agentic-os` (daily memory files with numbered session blocks, a curated `MEMORY.md` working scratchpad, `SOUL.md`/`USER.md` injection, silent auto-tracking, nightly consolidation, GitHub backup check). Session injection priority (hard cap ~16K chars): IDENTITY.md → working-memory/current.md → retrieved knowledge/+tasks/+projects/.
- **Memory as a poisoning surface**: persistent injected memory + web/mail reading is an attack surface. Memory writes that originate in external content (emails, web pages) are quarantined and never auto-promoted to `knowledge/` or `IDENTITY.md` without passing the safety gate.
- **Repo**: monorepo at `github.com/Rage-Op/KernelAi`. Full authoritative spec lives at `docs/KERNEL_MASTER_BUILD_PROMPT.md`.

## Constraints

- **Tech stack (pinned — decisions, not options)**: Daemon = TypeScript/Node. Face = native Swift/SwiftUI, launch-at-login, menubar presence. Local model = Ollama serving Qwen2.5-7B-Instruct (or Llama-3.1-8B) Q4_K_M over `http://localhost:11434`. STT = whisper.cpp (base.en/small.en) as subprocess. TTS = AVSpeechSynthesizer. Brain default = Claude API (pluggable). GUI hands = Peekaboo (MCP+CLI). Browser hands = Playwright (headful). Scheduler = launchd. Memory = markdown+YAML git repo, nightly push to private GitHub backup. Finance = read-only aggregation API (Plaid-style OAuth).
- **Memory/RAM**: 16GB ceiling — no embedded models, prefer keyword retrieval, lean on Ollama idle-unload.
- **Safety**: Tiered autonomy (🟢 reversible / 🟡 recoverable / 🔴 irreversible+financial). Red tier always gated even under `/override`: dry-run preview → 10s cancel → spend-ceiling check → audit log. Hard non-overridable rules: no credential entry, no Red action sourced from external content, daily spend ceiling. Red-tier gating applies inside Claude Code sessions too.
- **Working protocol**: build one phase at a time in §16 order; each phase independently working before the next; commit + push at every phase gate. (Owner directive for this build: Phases 0–3 run autonomously without approval; **hard stop before Phase 4**, the phase that enables money/`rm -rf`/`/override`.)
- **Design language**: Apple sleekness × shadcn precision × a living cloud. Deep spatial black, low-chroma zinc neutrals, hairline borders, one accent only (indigo `#7C8CFF` → cyan `#42E8E0`, reserved for the cloud and active states). SF Pro, tabular numerals for money. Motion law: nothing snaps — everything eases, drifts, settles. Real GPU particle system (Metal/SpriteKit/SceneKit); widgets bloom and dissolve in sync with TTS word boundaries.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Daemon in TypeScript, model over HTTP/subprocess | Separates orchestration from inference; keeps brain swappable; TS viable despite MLX being Python-only | — Pending |
| Cloud Claude as default brain, local 7B always-on helper | Cloud = hard reasoning; local 7B = cheap high-frequency triage/classification/narration (where cost savings actually come from) | — Pending |
| Markdown+git memory, distilled on a schedule | Distillation (logs→reflections→knowledge) is the "no junk, no degradation" guarantee — a cron job, not magic | — Pending |
| Keyword retrieval before embeddings | Embeddings cost RAM the 16GB machine doesn't have | — Pending |
| Tiered safety gate + circuit breaker, Red always gated | The line between "helpful" and "got robbed by a poisoned email" | — Pending |
| Build Phases 0–3 autonomously, gate before Phase 4 | Owner directive; Phase 4 flips on money/irreversible autonomy — too dangerous to enable unattended | — Pending |
| Quality (Opus) model profile for GSD planning agents | Large, intricate system; deep research/roadmap quality prioritized over cost | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-06-22 after initialization*
