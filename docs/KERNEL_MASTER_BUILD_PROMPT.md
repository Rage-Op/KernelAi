KERNEL — Master Build Prompt
Paste this whole document into Claude Code as the project brief. It is self-contained.


0. WORKING PROTOCOL — read this first, follow it for the entire build
This is how you must run this project. It overrides any default working style.

	•	Keep me updated. As you work, narrate what you're doing in short status lines ("scaffolding the daemon", "wiring the brain provider", "tests passing"). I want to follow along, not be surprised.
	•	Phase gate (mandatory). At the end of every phase: commit and push at least once — always — no matter how many times you already pushed during the phase. Then STOP and ask me exactly: "Save memory and pause here, or continue to the next phase?" Wait for my answer before continuing. Do not roll into the next phase on your own.
	•	No open questions. This document is meant to answer everything. If something is genuinely ambiguous, make the smallest reasonable assumption, note it in one line, and keep moving — don't block to ask unless it's a safety-tier or money decision.
	•	One phase at a time. Build in the phase order in §16. Each phase must be independently working before the next begins.
	•	Memory discipline. Treat the memory repo (§5) as the project's source of truth about itself. Update it at each phase gate when I say "save memory".


1. What you're building
Kernel — a persistent local AI orchestrator for macOS. It is not a smarter coding assistant. It is a foreman that never clocks out: it persists across sessions, holds memory, runs daily routines, controls the Mac, and hires Claude Code as a sub-contractor when there is code to write.

The owner is Pravin Maurya. Kernel is, in voice and judgment, a digital copy of Pravin. To Pravin it speaks direct, terse, reporting-style — no bargaining, no filler. For outward content (emails, posts, docs) it shifts register to fit the medium.

Guiding rule for where capabilities live: Kernel owns the loop, memory, persona, the safety gate, tool-routing, scheduling. Tools (Claude Code, Peekaboo, browser, the local model) do the work Kernel directs.


2. Tech stack (pinned — these are decisions, not options)
Target machine: MacBook Pro 16" · M2 Pro · 16GB. The 16GB ceiling drives everything.

Layer
Choice
Daemon / orchestrator
TypeScript / Node
Face (UI)
Native Swift / SwiftUI, launch-at-login, menubar presence
Local model
Ollama serving Qwen2.5-7B-Instruct (or Llama-3.1-8B), Q4_K_M, over http://localhost:11434
Speech-to-text
whisper.cpp (base.en/small.en) run as a subprocess
Text-to-speech
AVSpeechSynthesizer (macOS built-in) to start
Brain (default)
Claude via API; pluggable (see §6)
Hands — GUI
Peekaboo (MCP + CLI): Mail, recording, GUI-only apps, menus
Hands — browser
Playwright (headful): logins, scraping, form-fill
Scheduler
launchd (login + timed wakes)
Memory
Markdown + YAML front-matter in a git repo, nightly push to a private GitHub backup
Finance data
Read-only aggregation API (Plaid-style OAuth) — see §14

Key architectural rule — the HTTP boundary: the daemon never embeds a model. Ollama runs as its own process and exposes HTTP; the daemon just POSTs prompts and reads text. whisper.cpp is a spawned binary. This is why TypeScript is fine despite MLX being Python-only — the thing that thinks and the thing that orchestrates are separated by HTTP/subprocess boundaries. It also makes the model swappable: anything that speaks HTTP (Ollama, LM Studio, llama.cpp server, a cloud endpoint) drops in by changing a URL.


3. Repository structure
A monorepo:

kernel/

├── daemon/                  # TypeScript orchestrator

│   ├── src/

│   │   ├── loop.ts          # perceive → recall → decide → act → log

│   │   ├── brain/           # BrainProvider interface + impls (§6)

│   │   ├── tools/           # peekaboo, browser, claude-code, mail, weather, finance

│   │   ├── memory/          # inject / consolidate / prune (§5)

│   │   ├── safety/          # tier gate + circuit breaker (§8)

│   │   ├── planner/         # obstacle ladder (§9)

│   │   ├── routines/        # routine engine + loaders

│   │   └── ipc/             # localhost socket/HTTP to the Face

│   ├── routines/morning-brief.yaml

│   └── package.json

├── face/                    # SwiftUI app

│   ├── Sources/

│   │   ├── CloudView/       # particle system (§15)

│   │   ├── Stage/           # choreography controller (§15)

│   │   ├── Widgets/         # event / mail / accounts / spending / email-preview

│   │   └── Voice/           # whisper bridge + TTS + boundary callbacks

├── kernel-memory/           # the memory git repo (own remote; finances gitignored)

└── launchd/                 # .plist jobs: heartbeat, consolidation, cleanup, backup


4. Architecture (the loop)
FACE (SwiftUI) ── voice in (whisper) / voice out (TTS) ──┐

                                                         │  localhost socket/HTTP

KERNEL daemon ───────────────────────────────────────────┘

  loop: perceive → recall → decide → act → log

  ├─ Persona engine     (IDENTITY.md + voice rules)

  ├─ Brain provider     (pluggable: cloud default / local toggle)

  ├─ Planner            (retry → replan → subtask → escalate)

  ├─ Safety gate        (tiered autonomy + circuit breaker)

  ├─ Memory manager     (inject at start / consolidate + prune nightly)

  └─ Tool router → Claude Code · Peekaboo · Playwright · local 7B · finance API

launchd heartbeat drives: morning brief · nightly consolidation · cleanup · GitHub backup


5. Memory system (agentic-OS pattern)
Markdown-first, injected at session start, distilled on a schedule (the distillation matters more than the storage — raw logs are not memory).

kernel-memory/

├── IDENTITY.md              # persona + voice rules. Injected EVERY session. Never auto-edited.

├── working-memory/

│   ├── current.md           # rolling live context

│   └── reflections/         # daily distillations (consolidation job writes these)

├── knowledge/               # long-term distilled facts (preferences, stack, people)

├── tasks/                   # one file/task: YAML front-matter (status/priority/due) + body

├── projects/

│   └── registry.md          # every Claude Code project ever started (survives across sessions)

├── logs/                    # append-only raw events; pruned aggressively

└── self/{changelog.md,metrics.md}

# .gitignore: anything under finance/ — never backed up (see §14)

Session injection (priority order, hard cap ~16K chars): IDENTITY.md → working-memory/current.md → retrieved relevant knowledge/+tasks/+projects/. Start with keyword retrieval; only add embeddings if recall is poor (embeddings cost RAM you don't have).

Scheduled hygiene (launchd): nightly consolidation (logs → reflections, promote durable facts → knowledge), cleanup (prune stale working-memory/logs), backup (commit + push). This is the "no junk, no degradation" guarantee — it's a cron job, not magic.

Security: memory writes that originate in external content (emails, web pages) must be quarantined and never auto-promoted to knowledge/ or IDENTITY.md without passing the safety gate. Persistent injected memory + web/mail reading is a poisoning surface; treat memory writes as privileged.


6. Brain provider (pluggable)
Build this interface in Phase 0 so the brain is swappable from Settings.

interface Decision { thought: string; action?: ToolCall; reply?: string; }

interface BrainProvider {

  reason(prompt: string, context: string): Promise<Decision>;

}

// Implementations:

//   ClaudeBrain     -> Claude API (DEFAULT) — hard planning, recovery, judgment

//   ClaudeCodeBrain -> Claude Code headless for code-heavy reasoning

//   LocalBrain      -> POST http://localhost:11434/api/chat (Ollama)

Settings toggle: brain = cloud | local. cloud is default (smart, costs per call). local is private + free but visibly dumber on 16GB — surface that in the UI when flipped. The local 7B always runs regardless of brain choice as the cheap high-frequency helper (triage, classification, short narration). That's where cost savings actually come from — not from making the 7B do hard reasoning.


7. Local model + speech wiring
	•	Ollama: ensure installed and launched at login; pull the model on first run; daemon talks to it via HTTP. Ollama unloads idle models to return RAM — a feature on 16GB.
	•	whisper.cpp: spawn as subprocess, pipe mic audio in, read transcript out. No native bindings.
	•	TTS: AVSpeechSynthesizer. Critical for §15: use the willSpeakRangeOfSpeechString delegate to get word/segment boundaries — these callbacks drive the on-screen choreography (widgets bloom/dissolve and particles pulse in sync with what Kernel is saying right now).


8. Safety model — tiered autonomy + circuit breaker
/override (typed or voice) unlocks autonomy, but autonomy is tiered, and the irreversible tier keeps a circuit breaker even under override. This is the line between "helpful" and "got robbed by a poisoned email."

Tier
Examples
Behavior under /override
🟢 Green — reversible
open apps, draft (not send), browse, read mail, read-only commands, create files
Full speed, zero friction.
🟡 Yellow — recoverable
send email/DM, post publicly, change a setting, install software, mark read
Proceed + log + brief notify.
🔴 Red — irreversible / financial
purchases, trades, signing, money transfer, rm -rf, permission/access changes, deleting data
Always gated, even in override: dry-run preview → 10-second cancel window → spend-ceiling check → audit log. Never auto-executes from externally-retrieved content.

Hard rules (never overridable): no entering credentials/passwords/card numbers/SSN into any field (escalate to Pravin); no Red action whose instruction originated in external content (quarantine + escalate); daily spend ceiling (user-set) forces escalation when exceeded. Red-tier gating applies inside Claude Code sessions too (§13).

Do not enable /override / Red tier until Phase 4 is built and tested.


9. Obstacle planner — "no bargaining"
When blocked, Kernel does not stop and ask. It runs the ladder:

try → fail? → re-plan (new approach) → fail? → decompose into temp sub-tasks

     → fail? → retry w/ backoff → still blocked AND critical?

     → ESCALATE with a SPECIFIC recommendation

        ("X blocked by Y; I recommend Z. Approve?" — never a vague "I'm stuck")

The only obstacles that skip the ladder and escalate immediately are Red-tier safety gates (§8).


10. Persona & voice (IDENTITY.md)
	•	To Pravin: direct, terse, reporting-style. No bargaining once a task is stated. Vital details only in notifications.
	•	Outward content: dynamic register — warm for personal email, sharp for posts, formal for docs.
	•	Vocabulary mismatch: when Pravin's wording doesn't match Kernel's, Kernel elaborates/clarifies rather than guessing.
	•	Stance: the "mentor / well-wisher" energy shows up as reliability and follow-through, not chattiness.


11. Morning brief — a modifiable routine, not hardcoded
The brief is a config file (routines/morning-brief.yaml), editable per "morning needs." Support presets: Workday, Weekend, Travel. Each step is a module with enabled, order, params, tier.

preset: Workday

steps:

  - id: greeting        order: 1  enabled: true  tier: green   # date + day of week, narrated

  - id: weather         order: 2  enabled: true  tier: green   # hourly, flags rain windows

  - id: calendar        order: 3  enabled: true  tier: green   # EventKit / Google Cal

  - id: invitations     order: 4  enabled: true  tier: yellow  # accept/propose = writes a reply

  - id: mail_triage     order: 5  enabled: true  tier: green   # 7B tags: log/reply/open/archive

  - id: unread_announce order: 6  enabled: true  tier: green   # on "elaborate": read + mark read

  - id: email_reply     order: 7  enabled: true  tier: yellow  # see §12

  - id: balances        order: 8  enabled: true  tier: green   # read-only aggregation

  - id: spending        order: 9  enabled: true  tier: green   # W/M/Y switchable charts

Each step is rendered one or two at a time, in sync with narration (§15), not as a static grid.


12. Email reply flow (budget-but-good)
unread thread → Pravin says "reply"

  → Kernel asks INTENT (one line)

  → rewrite intent into PRAVIN'S EMAIL VOICE:

      • inject a small VOICE PROFILE distilled once from real sent mail

        (greeting, sign-off, sentence length, formality range, emoji y/n — ~200 tokens, always injected)

      • FEW-SHOT RETRIEVAL: pull 2–3 of Pravin's past emails most similar to this recipient, include as live examples

      • ROUTE BY STAKES: casual/short → local 7B (free); high-stakes (new client, money, sensitive) → cloud brain

  → render PREVIEW CARD (To / Subject / body / signature)

  → "Send it?"  ──Edit──► re-preview   └─Send──► send via Mail/Gmail, mark source read, log

No fine-tuning — profile + few-shot gets ~90% of voice fidelity for near-zero cost. Yellow tier: the preview + explicit Send is the gate; never auto-send; never send to an address that came from external content without showing it.


13. Claude Code bridge — talk as Pravin + live transparency
	•	Voice: Kernel authors prompts to Claude Code in first person, as Pravin Maurya — personal, direct register, the way Pravin talks to his own coding tool.
	•	Transparency UI: the cloud shrinks to a top-left corner pill showing a live, scrollable transcript of Kernel ↔ Claude (what Kernel asks, what Claude does). Pravin can read along, interject, or pause.
	•	Safety overlay (separate from transparency): transparency is info; the gate is safety. Any Claude Code action that hits Red tier (rm -rf, system installs, anything irreversible) routes through Kernel's circuit breaker — it does not auto-run mid-session.
	•	Memory: every project is written to projects/registry.md so Kernel resumes cold across sessions.


14. Financial data — safe by construction
	•	Access via read-only aggregation API (Plaid-style OAuth) only. Pravin authorizes once in the bank's own flow; Kernel receives read-only tokens. Kernel NEVER types banking credentials into a field (hard rule, §8).
	•	Balances + spending live in a local, gitignored, encrypted store under kernel-memory/finance/. This path is excluded from the GitHub backup — the backup must never leak finances.
	•	Spending charts: W/M/Y switchable timeframes, computed locally from aggregated transactions.


15. Design language — Apple sleekness × shadcn precision × a living cloud
The earlier static-dashboard mock was wrong. Discard that direction. The soul of this interface is motion and choreography, not a grid of cards. Build toward this:

Foundation — Apple + shadcn (dark):

	•	Deep spatial black canvas with real depth: faint volumetric haze, subtle parallax, a sense of infinite space — never a flat screen.
	•	shadcn-grade restraint, dark: near-black base; low-chroma neutral surfaces (zinc family); hairline borders (~white 6–8%); consistent radius scale (cards 16–20, controls 9–10, pills 999); generous spacing on a 4-pt grid. Clean, quiet, exact.
	•	Type: SF Pro Display (headings) / SF Pro Text (body); tabular numerals for all money.
	•	One accent only: indigo #7C8CFF → cyan #42E8E0, reserved for the cloud and active/focus states. Everything else is neutral.
	•	Materials: .ultraThinMaterial / .regularMaterial frosted glass; depth-blur on whatever isn't in focus.
	•	Motion law: nothing ever snaps. Everything eases, drifts, settles (springs). Numbers count up.

The cloud — the centerpiece and the conductor:

	•	A real GPU particle system (Metal / SpriteKit / SceneKit): thousands of soft particles forming a breathing nebula at center. Idle = gentle drift. Speaking = voice amplitude (mic RMS) pushes particles outward and brightens them; quiet pulls them calm. Color lives between indigo and cyan, not a fixed gradient.
	•	Two states, one element: full-screen at boot / when speaking; shrunk to the corner pill during a Claude Code session (§13).

Choreography — widgets bloom and dissolve with speech:

	•	A Stage controller the routine engine drives. When Kernel narrates a topic ("you've got 3 events"), particles coalesce into a frosted-glass widget that blooms forward (scale 0.96→1, opacity in, forward-blur clears), holds while spoken about, then disperses back into the cloud as Kernel moves on.
	•	One or two widgets in focus at a time — content follows attention; never a wall of cards. The cloud is the conductor; widgets are instruments that play only when pointed to.
	•	Sync mechanism: the TTS willSpeakRangeOfSpeechString boundaries (§7) trigger Stage.present(widget) / Stage.dismiss() and particle bursts, so the UI is choreographed to the actual words being spoken.

Widgets to build: events, mail (with suggested-action chips), accounts (balances), spending (W/M/Y chart), email preview ("Send it?"). All glass, all bloom-and-dissolve.


16. Build phases (build in this order; gate after each per §0)
Phase 0 — Skeleton. Daemon + stub cloud brain. Memory repo + IDENTITY.md injection. BrainProvider interface (§6). launchd heartbeat that writes a log entry. Done when: daemon persists, injects memory, and the heartbeat fires.

Phase 1 — Hands. Peekaboo MCP (capture/click/type/Mail) + Playwright browser tool + tool router. Done when: Kernel can open Mail and drive a browser task end-to-end.

Phase 2 — Brain + voice + the cloud. Brain provider (cloud default, local toggle via Ollama HTTP). whisper STT + TTS with boundary callbacks. Face: spatial black canvas + living particle cloud + Stage controller with one widget blooming/dissolving on speech. Done when: you can talk to Kernel, it reasons, and the cloud reacts + a widget choreographs to its speech.

Phase 3 — Routines + Claude Code + finance. Morning-brief engine + YAML + presets. Email reply flow (§12). Finance aggregation + encrypted store + spending charts. Claude Code bridge + transparency corner + project registry. Done when: a full morning brief runs, choreographed, including a gated email send and live spending charts.

Phase 4 — Safety + self-maintenance. Tiered gate + /override + circuit breaker. Nightly consolidation + cleanup + GitHub backup. Self changelog + metrics. Done when: Red-tier actions are gated end-to-end (including inside Claude Code) and the maintenance jobs run on schedule. Only now is autonomy safe to enable.


17. Start here
Begin Phase 0. Set up the monorepo (§3), the BrainProvider interface (§6), the memory repo with IDENTITY.md (§5, §10), and a launchd heartbeat. Give me status updates as you go. At the end of Phase 0, commit and push, then ask me: "Save memory and pause here, or continue to Phase 1?"

