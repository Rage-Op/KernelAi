# Project Research Summary

**Project:** KERNEL — Persistent Local AI Orchestrator for macOS
**Domain:** Agentic OS / personal foreman daemon (TypeScript daemon + native Swift/SwiftUI face)
**Researched:** 2026-06-22
**Confidence:** HIGH

---

## Executive Summary

KERNEL is a persistent macOS AI orchestrator — a "foreman that never clocks out." Experts build systems in this class by keeping orchestration (TypeScript/Node daemon) strictly separated from inference (Ollama over HTTP, Claude API over HTTPS, whisper.cpp as a subprocess). The HTTP/subprocess boundary is the architectural keystone: it is what makes the brain swappable by changing a URL, keeps TypeScript viable despite MLX being Python-only, and provides the single insertion point for the safety gate. Three resident processes (daemon, SwiftUI face, Ollama) plus spawned children (whisper.cpp, Claude Code, Peekaboo, Playwright) communicate over explicit boundaries — the daemon and face joined by a WebSocket on localhost. The control loop (perceive → recall → decide → act → log) is event-driven, not a polling tick, which allows Ollama to idle-unload between calls — a load-bearing behavior on the M2 Pro 16GB target.

The recommended build approach follows five fixed phases: P0 (skeleton: daemon persistence, memory injection, BrainProvider interface, launchd heartbeat), P1 (hands: Peekaboo MCP, Playwright, tool router), P2 (brain + voice + UI: cloud/local brain, whisper STT, TTS with boundary callbacks, Metal particle cloud, Stage controller), P3 (routines + Claude Code bridge + finance: morning brief engine, email reply flow, Plaid-backed spending charts), and P4 (safety gate + self-maintenance — GATED, not built autonomously). Phase 2 is the highest-risk lynchpin: it closes the talk→reason→act→choreograph loop and depends on AVSpeechSynthesizerDelegate.willSpeakRangeOfSpeechString callbacks whose reliability on macOS is documented-flaky. An on-device spike validating those callbacks must precede the full Stage choreography build.

The dominant risk is not technical complexity but an existential security threat: "got robbed by a poisoned email." The system reads untrusted content (email, web), reasons over it with the same brain that can call tools, and holds durable memory that is re-injected every session. This creates three distinct attack surfaces — prompt injection into tool calls, memory poisoning into long-lived knowledge, and finance data leak into the git backup — and all three must be closed structurally in code, not in prompts. Three cross-phase seams must be built into early phases as acceptance criteria, not deferred: (1) provenance/taint schema on the BrainProvider context layer in P0, (2) the four-layer finance-leak prevention stack in P3 before any backup job exists, and (3) a single safety/gate.ts chokepoint through which every tool dispatch routes (P1–P3), so P4 only enables an already-correct gate rather than retrofitting it.

---

## Key Findings

### Recommended Stack

The stack is fully pinned by the master spec and verified against live registries (npm, nodejs.org, Ollama, Apple docs) as of June 2026. No significant version uncertainty exists. The dominant constraint is the M2 Pro 16GB ceiling: it drives the 7B Q4_K_M model choice, the Ollama idle-unload discipline, the keyword-retrieval-over-embeddings decision, and the prohibition on concurrent heavy tools.

**Pinned core technologies:**

- **Node.js 24 LTS** (Active LTS June 2026): daemon runtime — stable node:sqlite, native --env-file, ESM; use fnm/.nvmrc. Do NOT use odd releases or pm2/forever.
- **TypeScript 5.9.x**: daemon language; tsx for dev, tsc for builds; BrainProvider and Decision are the type backbone.
- **Swift 6 / SwiftUI** (macOS 14 min, 15 target): native face — MenuBarExtra, SMAppService, Metal MTKView, AVSpeechSynthesizer, AVAudioEngine, Network.framework.
- **Ollama 0.13.x+** at http://localhost:11434/api/chat (NOT /api/generate): local model server; OLLAMA_MAX_LOADED_MODELS=1, idle-unload is a feature.
- **qwen2.5:7b-instruct-q4_K_M**: local model (~5–6 GB resident) — best 7B structured-output/JSON adherence on 16GB; DO NOT use anything 13B or larger.
- **claude-opus-4-8**: primary cloud brain (1M ctx, hard reasoning, obstacle ladder); claude-sonnet-4-6 as cost-aware alt; claude-haiku-4-5 for cheap cloud classification. ALWAYS use versioned IDs — no -latest aliases; claude-opus-4-1 retires 2026-08-05.
- **@anthropic-ai/sdk 0.105.0**: Messages API, .stream() + .finalMessage(); manual tool loop so the gate sits between decision and execution.
- **@modelcontextprotocol/sdk 1.29.0**: MCP client driving Peekaboo via StdioClientTransport.
- **Peekaboo** (latest, brew install steipete/tap/peekaboo, canonical: github.com/openclaw/Peekaboo): GUI hands — screenshot, AX tree, click/type/scroll/drag/hotkeys/menus/dialogs.
- **Playwright 1.61.0**: browser hands — headful, launchPersistentContext with dedicated profile dir (NOT the user's real Chrome profile). No stealth plugins.
- **whisper.cpp** (ggml-org master, build with -DWHISPER_COREML=1 -DWHISPER_SDL2=ON): STT subprocess; base.en (low latency) or small.en (better accuracy). Core ML encoder runs on Apple Neural Engine, >3x CPU speed.
- **Metal MTKView + compute shader** (NSViewRepresentable): GPU particles — 100k @ 60fps verified; SwiftUI ForEach chokes at ~500 views/12fps. Fall back to SpriteKit only under severe timeline pressure.
- **AVSpeechSynthesizer + willSpeakRangeOfSpeechString**: TTS with per-word boundary callbacks driving Stage choreography. Known flaky on some macOS versions — on-device spike required before Stage build.
- **pino 10.3.1** (structured JSON logging), **zod 4.4.3** (schema validation throughout), **plaid 42.2.0** (read-only OAuth, Sandbox then Trial plan), **better-sqlite3-multiple-ciphers 12.11.1** (SQLCipher AES-256 for finance store, key in macOS Keychain), **execa 9.x** (subprocess spawning), **launchd** (login agent + timed wakes; NOT pm2/forever).
- **IPC transport**: WebSocket (ws on Node, URLSessionWebSocketTask on Swift) over localhost — bidirectional, push-capable, framed JSON. Minor ambiguity: STACK.md recommends Unix domain socket (lower latency, file-permission scoped); ARCHITECTURE.md diagrams show localhost WebSocket. Resolve in P0: Unix domain socket is the stronger choice; localhost WebSocket is the practical fallback if NWConnection-to-UDS proves awkward.

### Expected Features

**Must have — table stakes (missing = not this product):**
- Persistent daemon that survives sessions (P0) — without persistence there is no product
- Markdown + git memory store with session injection, priority-ordered, 16K char hard cap (P0)
- Pluggable BrainProvider interface (P0) — HTTP-boundary keystone; must exist before any impl hard-codes Claude
- launchd heartbeat / scheduler (P0) — the "never clocks out" promise is literally the scheduler
- GUI hands via Peekaboo MCP (P1) — "controls the Mac" is in the one-line pitch
- Browser hands via Playwright headful (P1) — most real-world tasks live in a browser
- Tool router with dispatch and obstacle planner / ladder (P1–P3) — routing IS the orchestration
- Cloud brain default + local 7B toggle (P2) — privacy mode is an expected baseline
- STT (whisper.cpp) + TTS (AVSpeechSynthesizer) completing the conversational loop (P2)
- Native SwiftUI menubar / launch-at-login presence (P2) — ambient availability is the expectation

**Should have — differentiators (why KERNEL exists):**
- Living GPU particle cloud (Metal) reacting to mic RMS amplitude (P2) — the product's visual signature
- Stage controller: speech-choreographed widget bloom/dissolve driven by TTS boundary callbacks (P2) — load-bearing prerequisite for P3
- Dual-register persona (terse to Pravin, register-shifting outward) from IDENTITY.md (P2/P3)
- Email reply flow: ~200-token voice profile + 2–3 few-shot past emails, preview-gate before send (P3)
- Morning-brief engine: YAML config, Workday/Weekend/Travel presets, per-step tier, choreographed to Stage (P3)
- Read-only finance aggregation (Plaid OAuth) + encrypted gitignored local W/M/Y spending charts (P3)
- Claude Code bridge: first-person prompting as Pravin, live transparency corner-pill, projects/registry.md (P3)
- Local 7B always-on cheap helper for triage/classification/narration regardless of brain mode (P2)

**Defer to P4 (gated — explicit approval required):**
- Tiered safety gate + circuit breaker + /override — enables money/rm -rf/irreversible; too dangerous unattended
- Nightly consolidation + cleanup + GitHub backup — depends on stable memory + scheduler
- Full memory-write quarantine promotion gate — completes the poisoning defense
- Self changelog + metrics

**Hard anti-features (never build):**
- Embedding a model in the daemon (violates HTTP-boundary keystone)
- Fine-tuning for email voice (profile + few-shot achieves ~90% at near-zero cost)
- Typing banking credentials / card numbers / SSN into any field (hard non-overridable rule)
- Embeddings for memory retrieval initially (keyword retrieval first; embeddings cost RAM the 16GB machine lacks)
- Static dashboard / grid-of-cards UI (kills visual identity and speech-choreography concept)
- Enabling /override or Red-tier before P4 is built and tested

### Architecture Approach

The architecture is driven by two process boundaries: (1) the daemon never embeds a model — thinking happens in other processes reached over HTTP or subprocess; (2) the daemon and the Face are separate processes joined by a localhost socket. Three resident processes (daemon, SwiftUI face, Ollama) plus spawned children. The control loop in loop.ts is event-driven (not a polling tick), draining a serial intent queue — one pass at a time — so the process falls genuinely idle between calls and Ollama can unload. The safety gate is mandatory middleware (gate.authorize(call)) wrapping every tool dispatch, including actions Claude Code wants to run mid-session; tools never self-classify their tier.

**Major components:**

1. **loop.ts** (daemon) — perceive → recall → decide → act → log; event-driven serial intent runner
2. **BrainProvider interface** — reason(prompt, context) → Decision; swap seam built first in P0 as StubBrain
3. **memory/** — inject.ts (session-start, priority + 16K cap, hot path), retrieve.ts (keyword + authority/recency reranker), consolidate.ts + prune.ts (launchd batch, P4), quarantine.ts (external-sourced writes, never auto-promoted)
4. **tools/** — registry.ts + adapters (peekaboo, browser, claude-code, mail, finance, local7b); every dispatch passes through safety/gate.ts
5. **safety/** — tiers.ts (classify ToolCall Green/Yellow/Red), gate.ts (authorize wrapper, hard rules), breaker.ts (dry-run → 10s cancel → spend ceiling → audit; P4)
6. **ipc/** — WebSocket server on localhost; protocol.ts defines all message types shared with Face; speak frames carry character-keyed cues for choreography
7. **Face / CloudView** — Metal compute shader particles in MTKView; idle drift + mic-RMS amplitude reactivity; mic RMS stays entirely within Face (never round-trips daemon)
8. **Face / Stage** — StageController: receives speak frame with cues keyed to character offsets; fires stage.present/dismiss on willSpeakRangeOfSpeechString boundary crossing; falls back to time-based pacing when callbacks don't fire
9. **Face / Voice** — WhisperBridge (mic → whisper.cpp subprocess → transcript → WS utterance), AVSpeechSynthesizer + delegate for boundary callbacks
10. **routines/** — YAML engine loading morning-brief.yaml (presets); each step a tiered module
11. **launchd plists** — heartbeat (P0), morning brief, nightly consolidation, cleanup, backup (P4)
12. **kernel-memory/** — separate git repo; finance/ gitignored + SQLCipher encrypted; IDENTITY.md never auto-edited

**The choreography contract (most novel, most fragile data path):** The daemon sends a speak frame to the Face containing the reply text plus cues[] keyed to character offsets (e.g., { atChar: 9, action: "stage.present", widget: "events" }). The Face's willSpeakRangeOfSpeechString delegate fires each cue when speech crosses the corresponding character position. The daemon decides what to say and which widgets accompany which phrases; the Face decides exactly when to fire, using the TTS engine's own word-boundary clock as the metronome. Never let the daemon drive timing via setTimeout estimates — that path guarantees desync.

### Critical Pitfalls

1. **Indirect prompt injection from read content reaching a tool call** — the canonical "robbed by a poisoned email." Mitigate with a dual-LLM split: the local 7B (quarantined reader, no tool access) ingests email/web and returns typed inert labels; the privileged cloud brain plans over labels, not attacker prose. Enforce provenance/taint tags (source: external | user | self) at the read site in code; block any tool call that is both tainted external and Red-tier at the router boundary. This is a P0 data-model decision, not a P4 feature.

2. **Memory poisoning — external content auto-promoted into durable memory** — a persistent backdoor across sessions. IDENTITY.md is never auto-edited (write-path guard + startup hash check). All external-sourced memory writes land only in working-memory/quarantine/; promotion to knowledge/ requires explicit Pravin confirmation via the safety gate. Nightly consolidation must filter on source: before promoting anything.

3. **Finance leak through the GitHub backup (gitignore failure)** — Pravin's complete financial history permanently in remote git history. Four-layer defense required: (a) broad gitignore for finance/ + sidecars, (b) pre-push hook scanning staged bytes and aborting on finance paths/patterns, (c) SQLCipher AES-256 encryption with key in macOS Keychain, (d) startup assertion that git ls-files | grep finance returns empty. All four layers are P3 acceptance criteria — the backup job (P4) must not be built until they are verified passing.

4. **AVSpeechSynthesizer boundary callbacks unreliable** — the choreography's word-sync clock is documented-flaky on some macOS versions; wrong character ranges for numbers; may not fire at all. Spike on the actual target macOS version and voice in P2 before building the Stage controller. Implement time-based pacing as the primary schedule with callbacks as correction signal; degrade gracefully.

5. **Circuit-breaker bypass via sub-session, TOCTOU, or spend-ceiling race** — Claude Code can execute shell/purchase actions that bypass KERNEL's breaker if the chokepoint is not a true kernel boundary. The gate must sit at safety/gate.ts wrapping the router, not inside individual tools. Claude Code actions re-enter the gate via an intercept shim. Re-verify at execution time (content hash bound to confirmed action). Atomic spend accounting (single-writer lock, debit-and-act in one critical section).

---

## Implications for Roadmap

The five phases from PROJECT.md are dependency-correct and non-negotiable. The implications below add acceptance criteria the researchers identified as cross-phase seams that must land in earlier phases than the spec text might suggest.

### Phase 0: Skeleton

**Rationale:** Lays the four foundations everything else depends on — process persistence, memory substrate with provenance schema, the swap-seam interface, and the scheduler. Nothing in P1–P4 works without these. Interface-first: BrainProvider must exist before any brain implementation.

**Delivers:** A daemon that starts via launchd on login; injects IDENTITY.md → current.md → retrieved knowledge (priority-ordered, 16K char cap) at session start; exposes BrainProvider returning a StubBrain; fires a heartbeat launchd job that writes a timestamped log entry.

**Addresses:** Persistent daemon, markdown+git memory, session injection, BrainProvider interface, launchd heartbeat.

**Cross-phase seam acceptance criteria (P0):**
- BrainProvider.reason() signature accepts a typed context object with source provenance on each item — retrofitting taint after P3 is a rewrite
- memory/inject.ts enforces priority order in code; hard 16K char truncation never drops IDENTITY.md
- working-memory/quarantine/ directory exists; memory/quarantine.ts stubs the write path
- IDENTITY.md hash check runs at startup; no automated write path can modify it
- safety/tiers.ts seed — ToolCall type and tier-classification schema exist even with no real tools; this is the data shape P1–P4 build on
- IPC WebSocket server skeleton (ipc/server.ts) opens on startup so the Face can attach in P2 without a daemon restart

**Pitfalls to avoid:** Context-injection budget blowout (Pitfall 14); provenance schema omission (Pitfall 1); launchd env/PATH failure (Pitfall 10) — absolute paths and explicit EnvironmentVariables in the heartbeat plist from the start.

**Research flag:** Standard patterns, well-documented. No research phase needed.

---

### Phase 1: Hands

**Rationale:** The loop must be able to act (open Mail, drive a browser) before voice is worth wiring in. Voice without hands is a demo, not a foreman. This phase also establishes the tool router chokepoint that P4 will later arm with the full gate.

**Delivers:** KERNEL opens Mail and drives a browser task end-to-end. Tool router with gate.authorize() wrapper around every dispatch (thin: classify-only, no breaker yet, no override). Peekaboo MCP integration. Playwright headful browser with dedicated profile dir. Obstacle planner/ladder stub.

**Addresses:** GUI hands (Peekaboo MCP), browser hands (Playwright headful), tool router, obstacle planner stub.

**Cross-phase seam acceptance criteria (P1):**
- gate.authorize(call) sits between the router and every tool invocation — ONE chokepoint; tools cannot invoke themselves
- Peekaboo type-tool wrapper includes secure-field detection (labels: password/card/cvv/ssn, autocomplete hints, secure text fields) and refuses to type, returning an escalation — this lands in P1, not P4, because the physical capability to type secrets lands here
- All browser navigations logged with full URL + provenance; no auto-load of remote images from model output
- Verify-after-act: post-click state checked before proceeding; mismatch triggers planner replan, not blind continue
- TCC permissions (Screen Recording, Accessibility, Automation) granted to a stable Apple Development-signed launcher identity at a fixed install path — NOT to the shared node binary

**Pitfalls to avoid:** Credential-entry trap (Pitfall 4) — fence in P1; tool self-classification (Architecture anti-pattern 3); TCC instability (Pitfall 9) — stable signing from P1; data exfil via egress/render (Pitfall 5) — egress controls land here.

**Research flag:** Standard patterns for Peekaboo + Playwright. TCC signing setup may need a short spike if unfamiliar; factor time for the peekaboo permissions runbook.

---

### Phase 2: Brain + Voice + the Cloud

**Rationale:** Closes the talk→reason→act→choreograph loop. P2 is the HIGHEST-RISK phase because it composes the most novel and technically fragile elements simultaneously: whisper STT, TTS boundary callbacks, Metal particles, Stage choreography, WebSocket choreography contract, and two brain impls all landing under 16GB RAM. P2 is also the first time memory-pressure contention is real. Stage controller (P2) is the lynchpin for all P3 UI surfaces.

**Delivers:** You speak to KERNEL; it reasons (cloud or local 7B); the particle cloud reacts to your voice amplitude; a widget blooms and dissolves in sync with the spoken reply. Full IPC protocol (speak/cues/widget.data/utterance/boundary frames) is live. Cloud and local brain switchable in config. Always-on 7B helper handles triage/classification/narration.

**Addresses:** Cloud brain + local toggle, STT (whisper.cpp), TTS (AVSpeechSynthesizer), living-cloud UI (Metal particles), Stage controller + speech-choreographed widgets, persona/dual-register (P2 half), local 7B always-on helper.

**MANDATORY SPIKE before Stage build:** Before writing the full Stage controller, spike AVSpeechSynthesizerDelegate.willSpeakRangeOfSpeechString on the actual target macOS version and chosen voice. If callbacks are unreliable or ranges are wrong: implement time-based pacing (estimated word durations) as the primary schedule; treat callbacks as a correction signal. Design the Stage controller for both word-level and sentence-level granularity from the start. Ship the Stage controller with BOTH paths.

**Cross-phase seam acceptance criteria (P2):**
- ipc/protocol.ts is a named shared file (not ad-hoc strings); Swift enum mirrors its message types — a typo is a compile error, not a silent dropped widget
- speak frames carry character-keyed cues[] assembled by the daemon; Face fires them on boundary crossing — daemon NEVER sends timing-estimate messages
- Mic RMS amplitude → particle expansion/brightness stays entirely within Face/CloudView; does not round-trip the daemon
- OLLAMA_KEEP_ALIVE short (5m or less), OLLAMA_MAX_LOADED_MODELS=1 verified; idle-unload tested by checking resident RAM after inactivity
- Particle FPS verified at 60fps on-device under concurrent 7B inference (Instruments GPU frame time) — full-screen cloud while model generates
- launchd Face launch-at-login: signed, hardened runtime, notarized; tested on a fresh user account
- Memory-pressure monitoring as a first-class metric; sustained pressure sheds particle count and stops pinging Ollama

**Pitfalls to avoid:** AVSpeechSynthesizer boundary callback unreliability (Pitfall 11) — spike first; 16GB OOM (Pitfall 8) — idle-unload + one model + keyword-only retrieval; Metal on integrated GPU under model load (Pitfall 12); choreography daemon-timing anti-pattern (Architecture anti-pattern 1); STT/TTS latency (Pitfall 16) — stream first sentence, local 7B narrates instantly; launchd/notarization (Pitfall 10).

**Research flag:** NEEDS RESEARCH-PHASE. AVSpeechSynthesizer boundary callback reliability on macOS 14/15 needs on-device characterization before Stage design. Metal compute shader particle choreography patterns need spike verification. IPC transport final choice (Unix domain socket vs localhost WebSocket) needs resolution.

---

### Phase 3: Routines + Claude Code + Finance

**Rationale:** P2's Stage controller and IPC choreography are the prerequisite for every P3 UI surface. The morning brief, spending charts, and email preview all render through bloom/dissolve choreography. Finance data must be fully protected before the P4 backup job exists — all four finance-leak prevention layers are P3 acceptance criteria, not P4 afterthoughts.

**Delivers:** A full morning-brief run choreographed to narration (greeting, weather, calendar, mail triage, balances, spending); email reply flow with voice fidelity (voice profile + few-shot retrieval, preview card, gated send); read-only finance aggregation via Plaid OAuth + encrypted gitignored SQLCipher store + W/M/Y spending chart widget; Claude Code bridge with first-person prompting, live corner-pill transcript, and projects/registry.md.

**Addresses:** Morning-brief engine (YAML + presets), email reply flow (voice profile + few-shot), finance aggregation + spending charts, Claude Code bridge + transparency + registry, persona outward register (P3 half).

**Cross-phase seam acceptance criteria (P3) — finance-leak prevention, all 4 layers before any backup job:**
- Layer 1: kernel-memory/.gitignore with finance/, **/finance/**, and all SQLCipher sidecar extensions (-wal, -shm, *.tmp, *.lock)
- Layer 2: pre-commit and pre-push hook scanning staged bytes for finance/ paths and account-number/dollar-amount patterns; aborts on any hit; verified with a deliberate test (stage a fake finance/test.txt, confirm push aborts)
- Layer 3: SQLCipher AES-256 encryption active; DB key stored in macOS Keychain (not in any file or env var in the memory repo)
- Layer 4: startup assertion — git ls-files | grep finance returns empty; daemon startup fails loud if not
- The P4 backup job MUST NOT be built until all 4 layers are verified passing — this is the P3→P4 transition gate
- Email send-gate: preview card + explicit "Send it?" works standalone in P3; never send to an externally-sourced address without showing it to Pravin
- Claude Code bridge: Red-tier actions route up to gate.authorize() via intercept shim; Claude Code runs without ambient money/irreversible rights; Green/Yellow-only sandbox until P4
- Finance outbound scan: outbound payloads (browser navigations, email draft bodies, Claude Code prompt text) scanned for finance-store content and credential patterns before they leave

**Pitfalls to avoid:** Finance leak via backup (Pitfall 3) — all 4 layers are P3 ACs; email auto-send (anti-feature); Claude Code sub-session bypass of the circuit breaker (Pitfall 6) — intercept shim lands here; data exfil outbound scan (Pitfall 5) — finance-content scan lands here.

**Research flag:** Plaid Sandbox → Trial plan onboarding needs verification of OAuth Link flow before committing to Trial enrollment. Claude Code headless CLI invocation may benefit from a short spike.

---

### Phase 4: Safety + Self-Maintenance (GATED — DO NOT BUILD WITHOUT EXPLICIT APPROVAL)

**HARD STOP. This phase enables money/rm -rf//override/Red-tier autonomy. Owner directive requires explicit approval before proceeding.**

**Rationale:** P0–P3 run autonomously but cannot reach Red-tier actions. P4 only enables an already-correct gate — one that has been the chokepoint since P1. Building hands (P1) and the Claude Code bridge (P3) with effect paths that bypass the future gate guarantees a P4 rewrite; the chokepoint architecture must be respected across P1–P3.

**Delivers:** Full tiered safety gate (gate.ts + tiers.ts + breaker.ts) active on all tool dispatches including Claude Code sub-session actions; /override scoped to Green/Yellow (never overrides credential-entry rule, external-content Red block, or daily spend ceiling); nightly consolidation + cleanup + GitHub backup launchd jobs; self changelog + metrics.

**Cross-phase seam acceptance criteria (P4):**
- Test-injection email cannot trigger a Red action even under active /override
- Each of the three "never-overridable" rules (credential entry, external-content Red, daily spend ceiling) refuses even under /override — verified by tests
- rm -rf/purchase action inside a Claude Code session routes through gate.authorize() and hits the breaker — not auto-run
- Re-verify-at-execution: confirmed action bound to content hash; state re-read immediately before acting; abort if changed (TOCTOU defense)
- Atomic spend accounting: single-writer lock; debit-and-act are one critical section
- Backup job uses explicit git add <paths> (never git add -A); finance/ verified gitignored by the P3 hook before first backup run
- IDENTITY.md and knowledge/ remain unchanged after any consolidation run that processed only external-sourced logs
- /override and Red-tier routes are unreachable in P0–P3 builds (feature-flagged off)

**Pitfalls to avoid:** /override scope creep (Pitfall 7); circuit-breaker bypass via sub-session/TOCTOU/race (Pitfall 6); distillation signal loss (Pitfall 13); confirmation fatigue — keep Red-only interrupts, high-context prompts.

**Research flag:** Circuit-breaker TOCTOU re-verify pattern and SQLite locking for atomic spend accounting may benefit from a brief spike.

---

### Phase Ordering Rationale

- BrainProvider interface before any brain implementation: the swap seam must exist before P0 ships a StubBrain so the loop runs before Claude/Ollama exist.
- Tools before voice (P1 before P2): the loop must act before speech is worth wiring in. Voice without hands is a demo, not a foreman.
- Thin tier classifier (P1) before the full gate + breaker (P4): the classifier (tiers.ts) and gate.authorize() chokepoint exist from P1 but only enforce Green/Yellow. Dangerous capabilities are what P4 gates — but the chokepoint must be correctly placed in P1–P3 or P4 has to rewrite tool routing.
- Choreography needs both a brain and the Face: it can only land in P2 after the WebSocket protocol exists and the brain can talk.
- Stage controller (P2) is the lynchpin for P3's visible features: the morning brief, spending charts, and email preview all render through bloom/dissolve. If Stage and TTS boundary callbacks don't land in P2, every P3 UI surface degrades to a static card — the explicitly-discarded anti-feature.
- Finance-leak prevention (all 4 layers) before the backup job: the backup job is P4; finance data exists from P3. The 4-layer fence is a P3 acceptance criterion to prevent the first nightly push from leaking financial history.
- Consolidation/quarantine promotion in P4: the system can run for days on raw logs; distillation and poisoning defenses matter once it is trusted with autonomy. But the quarantine bucket must exist from P0 so P1–P3 reads have somewhere safe to land.

### Research Flags

**Phases needing deeper research during planning:**

- **Phase 2 (Brain + Voice + Cloud) — CRITICAL:** AVSpeechSynthesizer willSpeakRangeOfSpeechString reliability on macOS 14/15 and the chosen voice family needs on-device characterization before Stage controller design. Metal compute shader particle choreography patterns (position/velocity buffers, additive blending, amplitude-reactive compute kernel) need spike verification. IPC transport final choice (Unix domain socket vs localhost WebSocket) needs resolution based on Network.framework NWConnection behavior.
- **Phase 3 (Routines + Finance):** Plaid Sandbox → Trial plan onboarding; verify OAuth Link flow works before committing to Trial enrollment. Claude Code headless CLI invocation and first-person prompting format may benefit from a short spike.

**Phases with standard, well-documented patterns (skip research-phase):**

- **Phase 0 (Skeleton):** launchd plist patterns, TypeScript ESM daemon, markdown git repo, priority-based context injection — well-documented; the agentic-os reference is a direct implementation to learn from.
- **Phase 1 (Hands):** Peekaboo MCP integration, Playwright launchPersistentContext, tool router pattern — well-documented.
- **Phase 4 (Safety):** The gate/breaker pattern is architecturally clear from research; SQLite locking primitives for atomic spend accounting may need a brief look but are not novel.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Versions verified against npm registry, nodejs.org, official docs June 2026. Model IDs verified against live anthropics/skills catalog. Only the IPC transport (UDS vs WebSocket) has a minor ambiguity between STACK.md and ARCHITECTURE.md; resolve in P0/P2. |
| Features | HIGH | Grounded in the authoritative spec (KERNEL_MASTER_BUILD_PROMPT.md) and the studied agentic-os reference. Feature set is definitive; phasing is well-justified by dependency analysis. |
| Architecture | HIGH | Pinned by the spec; transport/choreography mechanics verified against Apple and Node docs. Confidence drops to MEDIUM only for voice choreography timing specifics, which depend on callback reliability (hence the P2 spike requirement). |
| Pitfalls | HIGH (security/platform), MEDIUM (voice choreography) | Security pitfalls grounded in DeepMind CaMeL, Embrace The Red, Apple docs, agentic-os reference — strong sources. AVSpeechSynthesizer callback unreliability is MEDIUM: documented in Apple forums and NSHipster but behavior varies by macOS version and voice. |

**Overall confidence:** HIGH

### Gaps to Address

- **IPC transport ambiguity:** STACK.md recommends Unix domain socket; ARCHITECTURE.md diagrams show localhost WebSocket. Both are viable. Resolve in P0 before implementing the Face IPC client. Recommendation: Unix domain socket for the production path (lower latency, file-permission scoped, not exposed on any port); localhost WebSocket as a debugging shim.
- **AVSpeechSynthesizer callback reliability:** documented flaky behavior means the P2 spike result is unknown until run on the actual target device. If callbacks prove too unreliable for word-level sync, the Stage controller operates at sentence-level granularity, changing the choreography feel. Design the Stage controller for both modes from the start.
- **Plaid Trial plan access:** the research confirms Trial covers the required scope at $0, but real-account OAuth enrollment can hit verification friction. Run Sandbox integration to completion before applying for Trial; have a fallback plan (manual CSV import) if Trial is delayed.
- **Memory consolidation quality:** nightly consolidation (logs → reflections → knowledge promotion) is deferred to P4, but distillation quality is inherently non-deterministic. Plan for a human-review step in the first few consolidation cycles before trusting the output to auto-promote.

---

## Sources

### Primary (HIGH confidence)

- docs/KERNEL_MASTER_BUILD_PROMPT.md — authoritative spec (§1–§16: stack, memory, brain provider, speech, safety, planner, persona, morning brief, email, Claude Code bridge, finance, design, phases)
- .planning/PROJECT.md — Core Value, Out of Scope, Key Decisions, phase requirements
- anthropics/skills model catalog (raw GitHub, live) — model IDs, tiers, context/output limits, deprecations
- anthropics/skills claude-api SKILL.md — TS SDK package, streaming, zod tool use
- npm registry (npm view) — exact pinned versions: @anthropic-ai/sdk 0.105.0, @modelcontextprotocol/sdk 1.29.0, playwright 1.61.0, better-sqlite3-multiple-ciphers 12.11.1, plaid 42.2.0, pino 10.3.1, zod 4.4.3
- nodejs.org / endoflife.date — Node 24 Active LTS, Node 22 maintenance (June 2026)
- docs.ollama.com / ollama.com/library/qwen2.5 — install, launch-at-login, /api/chat, keep_alive
- github.com/ggml-org/whisper.cpp — Core ML build, Metal default, macOS 14 note
- peekaboo.sh + github.com/openclaw/Peekaboo — capabilities, brew install, permission requirements
- playwright.dev (1.61.0 release notes, BrowserType) — launchPersistentContext, default-profile caveat
- Apple Developer docs — MenuBarExtra, SMAppService, willSpeakRangeOfSpeechString, AVSpeechSynthesizerDelegate, URLSessionWebSocketTask
- plaid.com/docs + support.plaid.com — Sandbox free/unlimited, Trial personal-use 10 Production Items, read-only Transactions
- Rage-Op/agentic-os reference repo — CLAUDE.md, context/MEMORY.md, context/SOUL.md, context/USER.md, context/memory-config.json, AGENTS.md, cron/jobs/* — memory/distillation/backup/persona patterns
- DeepMind CaMeL dual-LLM pattern — simonwillison.net/2025/Apr/11/camel, arXiv 2601.09923
- Markdown/image data-exfiltration class — embracethered.com (Johann Rehberger), Microsoft MSRC 2025
- macOS TCC / code-signing / notarization / launchd — Apple Developer notarization docs, HackTricks macOS TCC, OpenClaw macOS permissions docs

### Secondary (MEDIUM confidence)

- Metal/SwiftUI particle benchmarks (100k @ 60fps; ForEach ~12fps at 500 views) — community-verified, multiple sources agree
- Node UDS vs TCP loopback latency (20–40% lower for UDS) — nodevibe/Medium
- AVSpeechSynthesizer boundary-callback unreliability — Apple Developer Forums threads 678287 & 133104, NSHipster
- Circuit-breaker bypass, TOCTOU in computer-using agents, confirmation fatigue — arXiv 2603.14707, OWASP AI Agent Security Cheat Sheet
- Indirect prompt injection & memory poisoning 2025–2026 — zylos.ai, atlan.com, arXiv 2602.15654 (Zombie Agents)
- Anti-bot realities for Playwright headful — community sources
- Ollama 16GB RAM / keep-alive / OOM — ollama/ollama issue #4151, InsiderLLM Mac guides

---
*Research completed: 2026-06-22*
*Ready for roadmap: yes*
