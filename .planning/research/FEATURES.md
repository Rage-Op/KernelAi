# Feature Research

**Domain:** Persistent personal-AI / agentic-OS / "Jarvis"-class assistant for macOS (always-on local orchestrator)
**Researched:** 2026-06-22
**Confidence:** HIGH

> Scope note: This is grounded in the KERNEL spec (`docs/KERNEL_MASTER_BUILD_PROMPT.md`) and the studied
> `Rage-Op/agentic-os` reference, not generic chatbot feature lists. "Table stakes" here means
> *table stakes for a product in the persistent-foreman class* — the bar a real "always-on AI that
> holds memory and acts on your Mac" must clear before it is recognizably this product, not the bar
> for a chat window. Phase tags (P0–P4) map to the spec's §16 build phases.

---

## Feature Landscape

### Table Stakes (Defines the Product Class — Missing = Not This Product)

These are the capabilities without which KERNEL collapses back into "a chat window" or "a smarter coding
assistant." Each is the floor for the persistent-foreman class.

| Feature | Why Expected (class-defining) | Complexity | Phase | Notes |
|---------|-------------------------------|------------|-------|-------|
| **Persistent daemon (survives sessions)** | A foreman that "never clocks out" must be a long-lived process, not a request/response chat. Without persistence there is no product. | MEDIUM | **P0** | TypeScript/Node, launch-at-login. The loop: perceive → recall → decide → act → log. |
| **Markdown+git memory store** | An assistant that forgets everything between sessions is a chatbot. Durable, versioned, human-readable memory is the substrate. | MEDIUM | **P0** | `kernel-memory/` repo, YAML front-matter. IDENTITY.md / working-memory / knowledge / tasks / projects / logs / self. Mirrors agentic-os layout. |
| **Session injection at startup (priority-ordered, capped)** | Memory only matters if it's *loaded*. Injecting IDENTITY → current → retrieved knowledge each session is what makes it feel continuous. | MEDIUM | **P0** | Hard cap ~16K chars. Order: IDENTITY.md → working-memory/current.md → retrieved knowledge/+tasks/+projects/. |
| **Pluggable BrainProvider interface** | The HTTP-boundary keystone. Decouples orchestration from inference so the brain is swappable by URL. Must exist day one or every later layer hard-codes Claude. | LOW | **P0** | `reason(prompt, context) → Decision{thought, action?, reply?}`. Implementations: ClaudeBrain (default), ClaudeCodeBrain, LocalBrain. |
| **launchd heartbeat / scheduler** | Daily routines, nightly consolidation, backups — none exist without a wake mechanism. The "never clocks out" promise is literally the scheduler. | LOW | **P0** | launchd .plist jobs: heartbeat, consolidation, cleanup, backup. P0 ships heartbeat-writes-a-log only. |
| **GUI control hands (Peekaboo MCP)** | "Controls the Mac" is in the one-line pitch. Capture/click/type/drive Mail is the minimum for an agent that *acts*. | HIGH | **P1** | MCP + CLI: screenshot, click, type, app menus, Mail. GUI-only apps where no API exists. |
| **Browser control hands (Playwright headful)** | Most real-world tasks (logins, scraping, form-fill) live in a browser. Headful so the owner can watch/intervene. | HIGH | **P1** | Headful, not headless — transparency + login flows. |
| **Tool router** | An orchestrator that can't route work to the right tool (Claude Code vs Peekaboo vs browser vs local model) is just one tool. Routing *is* the orchestration. | MEDIUM | **P1** | Dispatch layer over tools/. Decides which hand does the work. |
| **Cloud brain default + local toggle** | A personal AI must reason well (cloud) but also offer a private/free mode (local). Both being present is the expected baseline for a privacy-conscious local assistant. | MEDIUM | **P2** | Claude API default; Ollama Qwen2.5-7B over `http://localhost:11434`. Surface "visibly dumber on 16GB" in UI when flipped. |
| **Speech-to-text (whisper.cpp)** | A "Jarvis" is talked to. Voice-in is table stakes for the class, not a nice-to-have. | MEDIUM | **P2** | whisper.cpp base.en/small.en spawned as subprocess; mic audio in, transcript out. No native bindings. |
| **Text-to-speech (AVSpeechSynthesizer)** | A foreman that reports back must speak. Voice-out completes the conversational loop. | LOW | **P2** | macOS built-in to start. The `willSpeakRangeOfSpeechString` boundary callbacks are load-bearing for the UI (see differentiators). |
| **Native menubar / launch-at-login presence** | An always-on assistant must have a persistent OS presence, not a window you open. Ambient availability is the expectation. | MEDIUM | **P2** | SwiftUI app, menubar, launch-at-login. |
| **Scheduled memory consolidation + cleanup + backup** | Distillation is the "no junk, no degradation" guarantee. Raw logs are not memory; without nightly distill+prune the store rots. Agentic-os treats this as core. | MEDIUM | **P4** | logs→reflections, promote durable facts→knowledge, prune stale working-memory/logs, commit+push to private GitHub. *Spec defers to P4* but it is class-table-stakes long-term. |
| **Obstacle planner ("no bargaining")** | A foreman that stops and asks at every block is an employee, not a foreman. Retry→replan→decompose→escalate-with-recommendation is the expected autonomy texture. | MEDIUM | **P1–P3** | Ladder: try→fail→replan→subtask→backoff→escalate with SPECIFIC recommendation. Only Red-tier gates skip the ladder. |

### Differentiators (Where KERNEL Wins — Not Required, But the Reason It Exists)

These are the features that separate KERNEL from off-the-shelf assistants (ChatGPT desktop, Siri, generic
agent frameworks). They align directly with the Core Value in PROJECT.md.

| Feature | Value Proposition | Complexity | Phase | Notes |
|---------|-------------------|------------|-------|-------|
| **The living-cloud UI (GPU particle nebula)** | The interface *is* the differentiator. Not a grid of cards — a breathing Metal particle cloud that reacts to voice amplitude. This is the product's visual signature and the spec explicitly discards the static dashboard. | HIGH | **P2** | Metal/SpriteKit/SceneKit, thousands of particles. Idle drift; speaking = mic RMS pushes particles out + brightens. Color lives between indigo `#7C8CFF` and cyan `#42E8E0`. Full-screen at boot/speaking; shrinks to corner pill in Claude Code sessions. |
| **Speech-choreographed widgets (Stage controller, bloom/dissolve)** | Content follows attention: widgets coalesce from the cloud and bloom *in sync with the words being spoken*, then disperse. One or two in focus at a time — the cloud conducts, widgets play. Nothing else does this. | HIGH | **P2** | Driven by TTS `willSpeakRangeOfSpeechString` boundaries → `Stage.present(widget)` / `Stage.dismiss()`. Hard dependency on the TTS boundary callbacks. Widgets: events, mail, accounts, spending, email-preview. |
| **Tiered autonomy safety gate + circuit breaker** | The line between "helpful" and "got robbed by a poisoned email." 🟢 reversible / 🟡 recoverable / 🔴 irreversible+financial. Red always gated (dry-run→10s cancel→spend-ceiling→audit) even under `/override`. This *structural* safety is the trust differentiator. | HIGH | **P4** | Hard non-overridable rules: no credential entry, no Red action from external content, daily spend ceiling. Gating applies inside Claude Code sessions too. GATED — do not build before P4. |
| **Email voice fidelity (profile + few-shot, no fine-tuning)** | ~90% of Pravin's voice at near-zero cost: a ~200-token voice profile distilled once from sent mail (greeting, sign-off, sentence length, formality, emoji y/n) + 2–3 retrieved similar past emails as live few-shot. Replies sound like the owner, not like an AI. | MEDIUM | **P3** | Route by stakes: casual→local 7B (free); high-stakes→cloud. Preview card → explicit "Send it?" gate. Never auto-send; never send to an externally-sourced address without showing it. |
| **Persona / dual-register voice (digital copy of the owner)** | KERNEL is, in voice and judgment, a digital copy of Pravin: terse/reporting to him, register-shifting outward (warm email, sharp posts, formal docs). Most assistants have one generic voice. | MEDIUM | **P2** (persona) / **P3** (outward register) | IDENTITY.md injected every session, never auto-edited. Vocabulary-mismatch → elaborate/clarify, don't guess. "Mentor/well-wisher" energy = reliability, not chattiness. |
| **Claude Code bridge (first-person prompting + live transparency)** | KERNEL "hires" Claude Code as a sub-contractor and authors prompts in first person *as Pravin*. The cloud shrinks to a corner pill streaming a live, scrollable Kernel↔Claude transcript the owner can read/interject/pause. Transparency-as-feature. | HIGH | **P3** | Distinct from safety: transparency is info, the gate is safety. Red-tier Claude Code actions route through the circuit breaker (needs P4). Every project → `projects/registry.md` for cold resume. |
| **Modifiable morning brief (editable YAML, presets, per-step tier)** | The brief is config, not hardcoded: `morning-brief.yaml` with Workday/Weekend/Travel presets; each step a module with `enabled/order/params/tier`. Owner reshapes their morning without code. | MEDIUM | **P3** | Steps: greeting, weather, calendar, invitations, mail_triage, unread_announce, email_reply, balances, spending. Rendered 1–2 at a time choreographed to narration (depends on Stage controller). |
| **Local 7B as always-on cheap helper** | The 7B runs regardless of brain choice for high-frequency triage/classification/short narration — *where the cost savings actually come from*. Cloud does hard reasoning; local does the cheap-and-often work. | MEDIUM | **P2** | Ollama idle-unload returns RAM (a feature on 16GB). Mail triage tags (log/reply/open/archive), casual email drafting, narration. |
| **Memory write quarantine (poisoning defense)** | Persistent injected memory + web/mail reading is an attack surface. Writes originating in external content are quarantined and never auto-promoted to knowledge/ or IDENTITY.md without passing the safety gate. Treats memory writes as privileged — most memory systems don't. | MEDIUM | **P4** (full gate) / partial **P0** | Quarantine bucket exists from the start of memory writes; promotion-gating ties to the P4 safety gate. |
| **Read-only finance aggregation + local encrypted spending charts** | Money insight without the money risk: Plaid-style OAuth read-only tokens, balances + transactions in a gitignored encrypted local store, W/M/Y switchable spending charts computed locally. Safe by construction. | MEDIUM | **P3** | `kernel-memory/finance/` gitignored — never in the GitHub backup. KERNEL never types banking credentials (hard rule). |
| **`/override` autonomy unlock** | Lets the owner trade friction for speed on Green/Yellow tiers while Red stays gated. The graduated-trust control surface. | LOW | **P4** | Typed or voice. Do not enable before P4 built + tested. |
| **Self-maintenance (changelog + metrics, nightly jobs)** | The system reports on itself and keeps its own house clean — `self/changelog.md`, `self/metrics.md`, nightly consolidation/cleanup/backup. A system that maintains itself is the "never clocks out" promise made literal. | MEDIUM | **P4** | Pairs with consolidation. GATED to P4. |

### Anti-Features (Deliberately NOT Built — From the Spec's "Out of Scope")

Documenting these prevents scope creep and protects the architecture. Each has an explicit alternative.

| Anti-Feature | Why It Seems Appealing | Why Problematic | Alternative (what KERNEL does) |
|--------------|------------------------|-----------------|--------------------------------|
| **Embedding a model in the daemon** | "Simpler — one process, no HTTP hop, lower latency." | Violates the HTTP-boundary keystone (§2). Locks the brain in, breaks TypeScript viability (MLX is Python-only), kills swappability. | Model runs as its own process (Ollama) behind HTTP; daemon POSTs prompts. Swap brain by changing a URL. |
| **Fine-tuning for email voice** | "Highest-fidelity voice cloning." | Expensive, slow to iterate, RAM/infra cost, overkill for the gain. | Voice profile (~200 tokens) + few-shot retrieval of 2–3 past emails = ~90% fidelity at near-zero cost (§12). |
| **Typing banking / credential / card / SSN into fields** | "Then it could do *everything* a human can." | This is exactly the "got robbed" failure mode. A hard, *never-overridable* rule. | Read-only aggregation API (Plaid-style OAuth) only; escalate credential needs to Pravin. |
| **Embeddings-first memory retrieval** | "Semantic recall, smarter than keyword match." | Embeddings cost RAM the 16GB machine doesn't have (§5). Premature optimization. | Keyword retrieval first; add embeddings *only if* recall proves poor. (Agentic-os keeps cross-encoder off and pgvector optional for the same reason.) |
| **Static dashboard / grid-of-cards UI** | "Conventional, predictable, easy to build." | Explicitly the wrong direction (§15) — kills the product's entire visual identity and the speech-choreography concept. | Living particle cloud + bloom/dissolve widgets choreographed to speech; 1–2 widgets in focus, never a wall. |
| **Enabling `/override` / Red-tier autonomy before Phase 4** | "Get to full autonomy faster." | Flips on money / `rm -rf` / irreversible actions before the circuit breaker exists and is tested. Owner directive: hard stop before P4. | Build & test the gate in P4 *first*; Phases 0–3 run autonomously but cannot reach Red. |
| **Auto-promoting externally-sourced memory writes** *(implicit anti-feature)* | "Learn automatically from everything it reads." | Direct memory-poisoning vector — a malicious email/web page rewrites IDENTITY.md or knowledge/. | Quarantine external-origin writes; promote only through the safety gate. |
| **Proactive greeting / chatty preamble** *(persona anti-feature)* | "Feels friendly." | Contradicts the terse reporting register; "mentor energy = reliability, not chattiness." Agentic-os reference also enforces silent startup. | Wait for the owner; report only vital details; begin tasks with no preamble. |

---

## Feature Dependencies

```
[Persistent daemon] (P0)
    └──requires──> [BrainProvider interface] (P0)
    └──requires──> [Markdown+git memory] (P0)
                       └──requires──> [Session injection] (P0)
    └──requires──> [launchd heartbeat] (P0)

[Tool router] (P1)
    └──requires──> [Persistent daemon] (P0)
    └──enables──> [Peekaboo GUI hands] (P1)
    └──enables──> [Playwright browser hands] (P1)
    └──enables──> [Claude Code bridge] (P3)
    └──enables──> [Finance aggregation] (P3)

[Voice I/O: STT + TTS] (P2)
    └──requires──> [Brain provider live] (P2)
    └── TTS boundary callbacks ──enable──> [Speech-choreographed widgets / Stage] (P2)

[Living-cloud UI] (P2)
    └──requires──> [Native SwiftUI face] (P2)
    └── Stage controller ──requires──> [TTS willSpeakRangeOfSpeechString] (P2)

[Morning brief engine] (P3)
    └──requires──> [Stage controller / choreography] (P2)
    └──requires──> [Local 7B helper] (P2, for mail_triage)
    └──requires──> [Email reply flow] (P3, for email_reply step)
    └──requires──> [Finance aggregation] (P3, for balances/spending steps)
    └──requires──> [Calendar/EventKit access] (P3)

[Email reply flow] (P3)
    └──requires──> [Peekaboo Mail control] (P1)
    └──requires──> [Voice profile + few-shot retrieval] (P3)
    └──requires──> [Local 7B] (P2, casual routing) + [Cloud brain] (high-stakes)
    └── full send-gate ──enhanced by──> [Safety gate] (P4)

[Finance aggregation + spending charts] (P3)
    └──requires──> [Encrypted gitignored local store] (P3)
    └──requires──> [Spending chart widget] (P3, depends on Stage controller P2)

[Claude Code bridge] (P3)
    └──requires──> [First-person persona prompting] (P3)
    └── transparency pill ──requires──> [Cloud → corner-pill state] (P2)
    └── Red-tier actions ──require──> [Circuit breaker] (P4)
    └──writes──> [projects/registry.md] (P0 memory layout)

[Safety gate + circuit breaker + /override] (P4)
    └──gates──> [Email send], [Claude Code Red actions], [any financial action]
    └──enforces──> [Memory write quarantine promotion]

[Scheduled consolidation/cleanup/backup + self-maintenance] (P4)
    └──requires──> [Markdown+git memory] (P0)
    └──requires──> [launchd scheduler] (P0)
    └──protects──> [finance/ gitignored exclusion]
```

### Dependency Notes

- **Stage controller (P2) is the lynchpin for P3's visible features.** The morning brief, spending charts, and email preview all render *through* the bloom/dissolve choreography. If the Stage controller and TTS boundary callbacks don't land in P2, every P3 UI surface degrades to a static card — the explicitly-discarded anti-feature. Treat P2's Stage+TTS-boundary wiring as the highest-risk P3 prerequisite.
- **TTS `willSpeakRangeOfSpeechString` is load-bearing, not cosmetic.** It is the *sync mechanism* between speech and UI. The choreography differentiator has a hard dependency on these callbacks firing reliably — flag for deeper research/spike in P2 (AVSpeechSynthesizer boundary-callback reliability and timing).
- **Email reply flow (P3) ships its own send-gate before the full safety gate (P4) exists.** The preview-card + explicit "Send it?" is a Yellow-tier gate that must work in P3 standalone; P4 later generalizes it into the tiered system. Don't block P3 email on P4.
- **Claude Code bridge (P3) needs the circuit breaker (P4) for Red-tier safety, but transparency works without it.** Build transparency + first-person prompting + registry in P3; the Red-tier routing into the breaker completes in P4. Until P4, the bridge must run in a Green/Yellow-only sandbox (no irreversible actions).
- **Memory quarantine spans P0 and P4.** The quarantine *bucket* and the rule "external-origin writes don't auto-promote" should exist as soon as memory writes do (P0/P1), but the *promotion gate* is the P4 safety gate. Partial in early phases, completed in P4.
- **Local 7B (P2) is a prerequisite for cheap P3 routing.** Mail triage tagging and casual-email drafting route to the 7B; without it, P3 either gets expensive (everything to cloud) or loses the cost-savings rationale.
- **`/override` and Red-tier conflict with the "autonomous Phases 0–3" directive by design.** They are deliberately *absent* until P4 — this is an enforced ordering constraint, not just a dependency.

---

## MVP Definition

> The build is phased (P0→P4), so "MVP" maps to phase milestones rather than a single v1 cut.
> Phases 0–3 run autonomously; P4 is gated behind explicit approval.

### Launch With (P0–P2 — the demonstrable core)

Minimum to validate "this is a persistent, voice-driven, acting assistant with a living interface."

- [ ] **Persistent daemon + memory injection + heartbeat (P0)** — without persistence + memory it's not the product.
- [ ] **BrainProvider interface (P0)** — must exist before anything hard-codes Claude.
- [ ] **Peekaboo + Playwright hands + tool router (P1)** — proves it can *act* on the Mac, not just chat.
- [ ] **Voice I/O + cloud/local brain (P2)** — proves the conversational loop.
- [ ] **Living cloud + Stage controller with one widget choreographing to speech (P2)** — proves the signature interface. This is the differentiator that makes the demo land.

### Add After Core Works (P3 — the daily-driver value)

Features that turn the demo into a thing the owner actually uses every morning.

- [ ] **Morning-brief engine + YAML presets (P3)** — trigger: P2 choreography is stable enough to render brief steps.
- [ ] **Email reply flow with voice fidelity (P3)** — trigger: Peekaboo Mail control + voice profile distilled from sent mail.
- [ ] **Finance aggregation + spending charts (P3)** — trigger: OAuth aggregation token obtained + encrypted store in place.
- [ ] **Claude Code bridge + transparency + registry (P3)** — trigger: tool router stable; run Green/Yellow-only until P4.

### Future / Gated (P4 — autonomy + self-maintenance, explicit approval required)

Deferred until the safety substrate is built and tested — the spec's hard stop.

- [ ] **Tiered safety gate + circuit breaker + `/override` (P4)** — defer: enables money/`rm -rf`/irreversible; too dangerous unattended.
- [ ] **Nightly consolidation + cleanup + GitHub backup (P4)** — defer: depends on stable memory + scheduler; the "no degradation" guarantee.
- [ ] **Self changelog + metrics (P4)** — defer: self-maintenance, lowest urgency.
- [ ] **Full memory-write quarantine promotion gate (P4)** — defer: completes the poisoning defense via the safety gate.

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Phase | Priority |
|---------|------------|---------------------|-------|----------|
| Persistent daemon + memory injection | HIGH | MEDIUM | P0 | P1 |
| BrainProvider interface | HIGH | LOW | P0 | P1 |
| launchd heartbeat/scheduler | MEDIUM | LOW | P0 | P1 |
| Peekaboo GUI hands | HIGH | HIGH | P1 | P1 |
| Playwright browser hands | HIGH | HIGH | P1 | P1 |
| Tool router | HIGH | MEDIUM | P1 | P1 |
| Obstacle planner | MEDIUM | MEDIUM | P1–P3 | P2 |
| Voice I/O (STT + TTS) | HIGH | MEDIUM | P2 | P1 |
| Cloud/local brain toggle + local 7B helper | HIGH | MEDIUM | P2 | P1 |
| Living-cloud particle UI | HIGH | HIGH | P2 | P1 |
| Stage controller / speech-choreographed widgets | HIGH | HIGH | P2 | P1 |
| Persona / dual-register voice | HIGH | MEDIUM | P2/P3 | P1 |
| Morning-brief engine (YAML + presets) | HIGH | MEDIUM | P3 | P1 |
| Email reply flow (voice profile + few-shot) | HIGH | MEDIUM | P3 | P1 |
| Finance aggregation + spending charts | MEDIUM | MEDIUM | P3 | P2 |
| Claude Code bridge + transparency + registry | HIGH | HIGH | P3 | P1 |
| Tiered safety gate + circuit breaker | HIGH | HIGH | P4 | P1 (gated) |
| `/override` autonomy unlock | MEDIUM | LOW | P4 | P2 (gated) |
| Memory-write quarantine (full promotion gate) | HIGH | MEDIUM | P4 | P1 (gated) |
| Scheduled consolidation/cleanup/backup | HIGH | MEDIUM | P4 | P1 (gated) |
| Self changelog + metrics | LOW | MEDIUM | P4 | P3 (gated) |

**Priority key:** P1 = must-have for that phase's gate · P2 = should-have · P3 = nice-to-have.
(Note: "P1/P2/P3" priority is distinct from the "P0–P4" build phases.)

---

## Competitor / Reference Feature Analysis

| Feature | Generic AI assistant (ChatGPT desktop / Siri) | `Rage-Op/agentic-os` (studied reference) | KERNEL's approach |
|---------|-----------------------------------------------|------------------------------------------|-------------------|
| Persistent memory | Session-scoped or shallow "memories" | Markdown daily files + numbered session blocks, curated `MEMORY.md` scratchpad, `SOUL.md`/`USER.md` injection, nightly distill | Same markdown+git+injection pattern, adapted to `kernel-memory/` with IDENTITY.md, working-memory, knowledge, tasks, projects |
| Memory distillation | Opaque / none | Daily distill cron, weekly curator, monthly learnings-health, SHA-keyed capture, authority-weighted reranker | Nightly consolidation (logs→reflections→knowledge), cleanup, GitHub backup — deferred to P4 |
| Persona / voice | One generic assistant voice | `SOUL.md` "have opinions, be terse, no performative help" | Dual-register digital copy of owner: terse to owner, register-shifting outward; injected, never auto-edited |
| Acting on the machine | Limited (Siri shortcuts) / none | Skills + cron dispatch, but not GUI/browser actuation | Peekaboo GUI + Playwright browser + tool router — real actuation |
| Voice-driven UI | Text bubbles / static Siri orb | None (CLI/Claude Code) | Living GPU particle cloud + speech-choreographed bloom/dissolve widgets |
| Safety for irreversible actions | Coarse confirmations | Gitignored secrets, never-read `.env`, backup-source separation | Tiered autonomy + circuit breaker, Red always gated even under override, hard non-overridable rules |
| Sub-agent / code delegation | None / inline tool calls | Claude Code is the host, not a sub-contractor | KERNEL *hires* Claude Code, prompts first-person as owner, live transparency pill, project registry |
| Finance | None | None | Read-only OAuth aggregation, encrypted gitignored store, local W/M/Y charts |

---

## Sources

- `docs/KERNEL_MASTER_BUILD_PROMPT.md` — authoritative spec (§2 tech stack, §5 memory, §6 brain provider, §7 speech, §8 safety, §9 planner, §10 persona, §11 morning brief, §12 email, §13 Claude Code bridge, §14 finance, §15 design, §16 phases). **HIGH confidence — primary source.**
- `.planning/PROJECT.md` — Core Value, Out of Scope, Key Decisions. **HIGH confidence.**
- `Rage-Op/agentic-os` reference (`CLAUDE.md`, `context/MEMORY.md`, `context/SOUL.md`, `context/USER.md`, `context/memory-config.json`, `context/learnings.md`, `AGENTS.md`, `cron/jobs/*`) — memory/distillation/backup/persona feature patterns. **HIGH confidence — studied reference implementation.**

---
*Feature research for: persistent personal-AI / agentic-OS orchestrator (KERNEL)*
*Researched: 2026-06-22*
