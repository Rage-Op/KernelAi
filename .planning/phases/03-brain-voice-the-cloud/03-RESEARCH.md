# Phase 3: Brain + Voice + the Cloud - Research

**Researched:** 2026-06-22
**Domain:** Pluggable LLM brains (TS daemon) + on-device STT/TTS + Metal particle UI + TTS-boundary choreography (Swift Face). The highest-risk lynchpin phase — it closes the talk→reason→act→choreograph loop.
**Confidence:** HIGH on daemon-side brains, IPC, Claude Code invocation, manual tool loop, and toolchain facts (all verified against the live codebase + authoritative docs). MEDIUM on AVSpeechSynthesizer boundary-callback fidelity on this exact OS (a known-flaky API — hence the mandated spike) and on SwiftPM-vs-Xcode tradeoffs (verified pattern, but no on-device build yet).

## Summary

Phase 3 fills four seams that Phases 1–2 deliberately left open and adds one brand-new process (the Swift Face). On the daemon side, the `BrainProvider` swap-seam (`reason(prompt, context) → Decision`) already exists and the loop already routes every `decision.action` through `router.dispatch → gate.authorize` — so the three real brains (`ClaudeBrain`, `LocalBrain`, `ClaudeCodeBrain`) plus the always-on local-7B helper drop in behind the same interface with **zero changes to the loop, the router, or the gate**. The single most important architectural rule for this phase: the Claude tool loop stays **manual** — call `messages.create`, and on `stop_reason === "tool_use"` hand each `tool_use` block to KERNEL's `router.dispatch` (which runs the gate), then feed `tool_result` blocks back. This keeps the §8 gate physically between "decide" and "act" (BRAIN-06). Never use the SDK's auto tool-runner; it bypasses the chokepoint.

On the Face side, this phase creates the `face/` Swift app from scratch. The choreography contract is already frozen in `daemon/src/ipc/protocol.ts` (`SpeakSchema` with `cues[{atChar,action,widget,data}]` + `onFinish`) — the lynchpin work is (1) a daemon-side **cue assembler** that turns a reply + planned widget sequence into character-offset-keyed cues in a single `speak` frame, and (2) a Face-side `Stage` controller that fires those cues on `AVSpeechSynthesizerDelegate.willSpeakRangeOfSpeechString` with a **time-based sentence-level fallback** for when that callback misbehaves (it is documented-flaky). The daemon NEVER sends timing messages — it ships all cues up front and the Face's TTS clock is the metronome.

**The lynchpin discipline:** Run the boundary-callback spike FIRST (ROADMAP criterion 2 mandates it) — a tiny Swift app that speaks a fixed sentence on the target voice and logs every `willSpeakRangeOfSpeechString` range. Two known failure modes to confirm: (a) the callback never fires at all if the `AVSpeechSynthesizer` is a local variable instead of a retained property, and (b) ranges drift on numbers like "2020". Build the full Stage on top of the spike's verdict, not before it.

**Primary recommendation:** Daemon brains behind the existing seam with a manual Claude tool loop; an **Xcode project** (not pure SwiftPM) for the Face so Info.plist (LSUIElement, NSMicrophoneUsageDescription) + a stable signed identity survive rebuilds (TCC permanence); whisper.cpp and Ollama as **absent-tolerant subprocess/HTTP clients** that degrade to a typed escalation on this machine (which lacks both binaries); a Metal compute-shader particle system driven by Face-local mic RMS; and the cue-assembler + Stage dual-pacing as the choreography backbone. Gate the full build behind the boundary spike.

## User Constraints

> No `*-CONTEXT.md` exists for this phase (the phase directory was empty at research time). The binding constraints below are extracted from the authoritative project docs (`CLAUDE.md`, ROADMAP success criteria, REQUIREMENTS) and the owner directive, and the planner MUST honor them as if locked.

### Locked Decisions (from CLAUDE.md / ROADMAP / spec — treat as immovable)
- **Tech stack is pinned, not optional:** Daemon = TS/Node 24 ESM. Face = native Swift/SwiftUI, launch-at-login, menubar. Local model = Ollama serving `qwen2.5:7b-instruct-q4_K_M` over `http://localhost:11434`. STT = whisper.cpp (base.en/small.en) as a **subprocess** (no native bindings). TTS = AVSpeechSynthesizer. Brain default = Claude API (`claude-opus-4-8`), pluggable. Scheduler = launchd.
- **HTTP/subprocess boundary rule (§2):** the daemon NEVER embeds a model. Brains are reached over HTTP (Ollama, Claude API) or subprocess (whisper.cpp, Claude Code CLI). Swap a brain by changing a URL/transport, never by linking in a model.
- **Manual tool loop (BRAIN-06):** decision → safety gate → execution. Never an auto-runner that bypasses `gate.authorize`. This applies to ClaudeBrain's tool-use loop and to ClaudeCodeBrain.
- **Choreography contract (ARCHITECTURE.md + frozen `protocol.ts`):** the daemon ships character-offset-keyed `cues[]` inside ONE `speak` frame; the Face fires them on `willSpeakRangeOfSpeechString`. The daemon NEVER sends timing-estimate / "now show X" messages. Mic-RMS stays entirely Face-local — it never round-trips the daemon.
- **16GB ceiling:** one Ollama model loaded at a time; rely on idle-unload (`OLLAMA_KEEP_ALIVE` short, `OLLAMA_MAX_LOADED_MODELS=1`); never pin with `keep_alive: -1`; keyword retrieval, never embeddings. Don't run hot local inference + browser + Metal full-bloom concurrently — shed load under pressure.
- **Spike-before-Stage (ROADMAP criterion 2):** an on-device `willSpeakRangeOfSpeechString` spike on the target macOS version + voice MUST precede the full Stage build.
- **Design language (CLAUDE.md §15):** deep spatial black, hairline borders (white 6–8%), SF Pro, tabular numerals for money, spring motion (nothing snaps), ONE accent only (indigo `#7C8CFF` → cyan `#42E8E0`, reserved for the cloud + active states). *(Visual tokens are owned by the separate UI-SPEC.md DESIGN contract — this research owns the TECHNICAL how, not the design tokens.)*
- **No `/override`, no Red autonomy this phase.** The gate stays classify-only; Red = deny + escalate (LOCKED, carried from Phase 2). This phase adds no new Red-tier paths.

### Claude's Discretion
- Exact module layout under `daemon/src/brain/` (ClaudeBrain.ts / LocalBrain.ts / ClaudeCodeBrain.ts / helper.ts) and the Decision-mapping prompt design.
- The Stage controller's internal data structures and the exact easing curves (within the "nothing snaps" law).
- Particle count tuning (STACK pins ~100k as the ceiling; pick a budget that holds 60fps under the spike's measured GPU pressure).
- Whether to use `execa` or `node:child_process` for whisper.cpp/Claude Code spawning (STACK recommends `execa`; not yet a dependency).
- Settings-toggle frame shape for `brain = cloud | local` over IPC (must extend the frozen `FrameSchema` additively).

### Deferred Ideas (OUT OF SCOPE)
- Higher-quality TTS beyond AVSpeechSynthesizer (VOICE-V2-01) — only if boundary fidelity/naturalness forces it later.
- Embedding-based memory retrieval (MEM-V2-01) — keyword only until measured insufficient.
- Routines/morning-brief, email reply, finance, the Claude Code transparency corner-pill **transcript** flow — those are Phase 4. This phase builds the ClaudeCodeBrain *invocation seam* and the corner-pill *cloud state*, not the full Phase-4 bridge.
- Any `/override` / circuit-breaker / spend-ceiling code — Phase 5, gated.

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| BRAIN-02 | `ClaudeBrain` (Anthropic API, `claude-opus-4-8`) is the default brain | Standard Stack (`@anthropic-ai/sdk@0.105.0`, already installed); Pattern "Manual Claude tool loop"; Code Examples |
| BRAIN-03 | `LocalBrain` POSTs to Ollama `/api/chat` (`qwen2.5:7b-instruct-q4_K_M`), selectable from Settings | Pattern "LocalBrain over Ollama HTTP"; Ollama `/api/chat` shape verified; absent-Ollama degradation; Settings-toggle frame |
| BRAIN-04 | `ClaudeCodeBrain` routes code-heavy reasoning to Claude Code headless | Pattern "ClaudeCodeBrain via `claude -p`"; headless invocation verified (`claude` 2.1.185 installed); Code Examples |
| BRAIN-05 | Local 7B always runs as the cheap high-frequency helper (triage/classify/narrate) regardless of selected brain | Pattern "Always-on helper beside the providers"; `helper.ts` sits beside providers, not inside one |
| BRAIN-06 | Brain tool loop is manual (decision → gate → execution), never auto-runner | Pattern "Manual Claude tool loop"; loop already routes `decision.action`→`dispatch`→`gate.authorize`; Anti-Pattern "auto tool-runner" |
| VOICE-01 | whisper.cpp runs as a subprocess (Core ML/ANE build); mic in, transcript out | Pattern "whisper.cpp subprocess wrapper"; Environment Availability (absent here); Don't Hand-Roll |
| VOICE-02 | Pravin speaks to KERNEL and it reasons + responds | Data flow (Face mic → whisper → utterance frame → loop → speak frame); end-to-end |
| VOICE-03 | TTS via AVSpeechSynthesizer; `willSpeakRangeOfSpeechString` emits boundaries driving choreography | Pattern "TTS boundary choreography"; Pitfall "boundary-callback flakiness"; the mandated spike |
| VOICE-04 | Stage supports word-level (callback) AND sentence-level (time-based) pacing | Pattern "Dual-pacing Stage controller"; the time-based fallback |
| CLOUD-01 | Native SwiftUI menubar app launches at login (MenuBarExtra + SMAppService), connects over the socket | Pattern "Face app via Xcode project"; NWConnection NDJSON client; Open Question resolved (Xcode not SwiftPM) |
| CLOUD-02 | Deep spatial-black canvas, real GPU Metal particle cloud, idle drift | Pattern "Metal compute-shader particles"; compile-verifiable vs visual manual check |
| CLOUD-03 | Mic RMS pushes particles outward/brightens; color indigo↔cyan; computed in the Face | Pattern "Face-local mic RMS via AVAudioEngine tap"; never round-trips daemon |
| CLOUD-04 | Stage blooms a frosted-glass widget while a topic is spoken, disperses after; 1–2 widgets at a time | Pattern "Dual-pacing Stage controller" + cue assembler; `SpeakSchema` cues |
| CLOUD-05 | Two cloud states: full-screen (speaking/boot) + top-left corner pill (Claude Code session) | Pattern "Two window states, one element"; Open Question resolved (one app, two scene states) |
| CLOUD-06 | Design language holds (dark restraint, hairline, SF Pro, tabular numerals, spring, one accent) | Owned by UI-SPEC.md DESIGN contract; this phase wires the technical surfaces |

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| LLM reasoning (cloud/local/code) | API/Backend (daemon brain providers) | External services (Claude API HTTPS, Ollama HTTP, Claude Code subprocess) | The daemon owns the `reason()` seam; the model itself lives across an HTTP/subprocess boundary (§2). |
| Local-7B triage/classify/narrate helper | API/Backend (daemon `helper.ts`) | External (Ollama HTTP) | Always-on regardless of selected brain — must sit beside the providers, not inside one. |
| Tool dispatch + gate | API/Backend (daemon `registry.dispatch`→`gate.authorize`) | — | Single chokepoint; brains never call tools directly — they return a `Decision.action`. |
| Cue assembly (text → char-offset cues) | API/Backend (daemon, new module e.g. `ipc/cues.ts`) | — | The daemon decides *what* to say + *which widget* goes with *which phrase*; ships it in one `speak` frame. |
| STT (mic audio → transcript) | Client (Face captures mic) + API/Backend (daemon spawns whisper.cpp) | Subprocess (whisper-cli) | Mic access + low latency live in the Face per §7; transcription is a daemon-spawned subprocess. **See Open Question 2 — the read places the whisper subprocess in the daemon; the Face streams PCM to it.** |
| TTS playback + boundary clock | Client (Face — AVSpeechSynthesizer + delegate) | — | Only the Face knows real speech progress; it is the choreography metronome. |
| Particle simulation + render | Client (Face — Metal compute + draw) | GPU | 60fps GPU work; must never wait on the daemon. |
| Mic RMS amplitude reaction | Client (Face — AVAudioEngine tap, local) | — | High-frequency 60fps signal; round-tripping the daemon would add latency. Stays Face-local. |
| Window/scene state (full-screen ↔ corner pill) | Client (Face — SwiftUI scene/window controller) | — | Driven by a daemon `ui.intent`/state frame but rendered entirely in the Face. |
| Settings: brain = cloud \| local | Client (Face toggle) → API/Backend (daemon applies via `setBrain`) | IPC frame | Toggle surfaced in the Face; the daemon owns the actual brain swap. |

## Standard Stack

### Core (daemon — TS)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@anthropic-ai/sdk` | 0.105.0 (already installed) | ClaudeBrain — Messages API, streaming, tool use | Official TS SDK; already a dependency. Use `messages.create`/`.stream()` + a **manual** tool loop. `[VERIFIED: package.json]` |
| `zod` | 4.4.3 (already installed) | Validate Decision JSON, Ollama responses, IPC frames, the new Settings/cue frames | Already the contract backbone; `DecisionSchema` exists. `[VERIFIED: package.json]` |
| `pino` | 10.3.1 (already installed) | Structured logging of brain calls / boundary events | Already wired (`memory/log.ts` exports `logger`). `[VERIFIED: package.json]` |
| Node global `fetch` | Node 24 native | LocalBrain → Ollama `/api/chat`; no HTTP dep needed | Node 24 ships stable `fetch`; ARCHITECTURE.md LocalBrain example uses it directly. `[VERIFIED: Node 24.16 installed]` |

### Supporting (daemon)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `execa` | 9.6.1 | Spawn whisper.cpp / `claude -p` with clean streaming + error ergonomics | STACK recommends it; **not yet installed** — adds one dependency. `node:child_process.spawn` is a zero-dep fallback (Claude's discretion). `[VERIFIED: npm registry — see Package Legitimacy Audit]` |

### Core (Face — Swift, all first-party Apple frameworks; zero third-party deps)
| Framework | Purpose | Why Standard |
|-----------|---------|--------------|
| SwiftUI + `MenuBarExtra` | Menubar presence + the cloud window | First-party; CLOUD-01. Use `.menuBarExtraStyle(.window)` for the panel. `[CITED: developer.apple.com/documentation/SwiftUI/MenuBarExtra]` |
| `ServiceManagement.SMAppService` | Launch at login (user-toggled, default off) | Replaces deprecated `SMLoginItemSetEnabled`; CLOUD-01. `[CITED: STACK.md / Apple docs]` |
| `Network.NWConnection` | UDS client speaking NDJSON to the daemon socket | The daemon is a UDS NDJSON server (`server.ts`); the Face connects to the same `.sock` path. `[VERIFIED: server.ts is net.createServer UDS]` |
| `AVFoundation.AVSpeechSynthesizer` + `AVSpeechSynthesizerDelegate` | TTS + `willSpeakRangeOfSpeechString` boundary clock | VOICE-03; the choreography metronome. `[CITED: developer.apple.com/.../willspeakrangeofspeechstring]` |
| `AVFoundation.AVAudioEngine` | Mic capture (PCM to whisper) + Face-local RMS | VOICE-01 capture + CLOUD-03 amplitude. `[CITED: STACK.md]` |
| Metal (`MTKView` + compute shader) via `NSViewRepresentable` | GPU particle cloud | CLOUD-02/03; ~100k particles @ 60fps (SwiftUI Canvas chokes). `[CITED: STACK.md benchmarks — MEDIUM]` |

### External processes / binaries (reached over a boundary — NOT linked)
| Process | Transport | Purpose | Absent-on-this-machine behavior |
|---------|-----------|---------|---------------------------------|
| Ollama | HTTP `:11434` `/api/chat` | LocalBrain + always-on 7B helper | **Absent here.** `fetch` to `:11434` rejects → typed escalation; Settings shows "local unavailable". |
| whisper.cpp (`whisper-cli`) | subprocess (spawn, PCM in, transcript out) | STT | **Absent here.** Wrapper probes for the binary; if missing → typed escalation, no crash. Wrapper/parser are unit-testable without the binary. |
| Claude Code (`claude`) | subprocess `claude -p … --output-format json` | ClaudeCodeBrain | **Present here** (v2.1.185 at `~/.local/bin/claude`). `[VERIFIED: claude --version]` |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Xcode project for the Face | Pure SwiftPM executable target | SwiftPM builds the binary but Info.plist (LSUIElement, NSMicrophoneUsageDescription) + entitlements + a stable signed identity are awkward; TCC grants need a stable signature/path. **Choose Xcode** (resolves Open Question 1). `[CITED: Swift Forums — SwiftPM entitlements limitation]` |
| Manual Claude tool loop | SDK auto tool-runner | The auto-runner executes tools itself — it bypasses `gate.authorize`. **Forbidden** by BRAIN-06. `[CITED: anthropic-sdk-typescript Tool Runner docs]` |
| whisper.cpp subprocess | WhisperKit (in-Swift CoreML) | Breaks the §7 "spawned binary" pin and the subprocess boundary. Stay with whisper.cpp. `[CITED: STACK.md]` |
| Metal compute particles | SpriteKit `SKEmitterNode` | Lower ceiling, less control over the indigo→cyan field; acceptable fallback only if Metal threatens the timeline. Stage choreography is renderer-agnostic. `[CITED: STACK.md]` |
| `execa` | `node:child_process` | Zero-dep but more boilerplate for streaming/error handling. Either is fine (Claude's discretion). |

**Installation (daemon — only if `execa` is chosen):**
```bash
cd daemon && npm install execa@9.6.1
```
*(No other daemon deps needed — `@anthropic-ai/sdk`, `zod`, `pino` are already installed; `fetch` is native.)*

**Face:** create `face/Kernel.xcodeproj` (deployment target macOS 26 — see Toolchain note). No third-party Swift packages required.

**Toolchain note (verified on this machine):** `swift 6.3.2`, `xcodebuild 26.5` (Xcode 17F42), default target `arm64-apple-macosx26.0`, only the **macOS 26.5 SDK** is installed. STACK.md assumed a macOS 14/15 deployment target; that is stale for this machine. The Face's deployment target should be set conservatively (macOS 14+ is fine for MenuBarExtra/SMAppService/AVSpeech APIs — all Ventura+), but it will **build and run against the macOS 26.5 SDK** since that is the only SDK present. Plan accordingly: `xcodebuild -scheme Kernel -destination 'platform=macOS'` is the compile-verification command.

## Package Legitimacy Audit

> Only one *new* package is in scope this phase (`execa`); all other daemon deps are already vetted/installed. The Face uses only first-party Apple frameworks (no registry packages). slopcheck was **unavailable** at research time (pip install failed in the sandbox), so `execa` is verified by direct registry + repo inspection and tagged accordingly.

| Package | Registry | Age | Latest | Source Repo | slopcheck | Disposition |
|---------|----------|-----|--------|-------------|-----------|-------------|
| `execa` | npm | mature (sindresorhus, 9.x line; 9.6.1 published 2025-11-29) | 9.6.1 | github.com/sindresorhus/execa | unavailable | Approved — verified via `npm view` + canonical repo. Tag `[VERIFIED: npm registry]` only after the planner re-runs slopcheck; until then treat as `[ASSUMED]` and gate behind a `checkpoint:human-verify` if desired. |
| `@anthropic-ai/sdk` | npm | already installed (0.105.0) | — | github.com/anthropics/anthropic-sdk-typescript | n/a (already vetted Phase 1) | Approved |
| `zod` / `pino` | npm | already installed | — | — | n/a | Approved |

**Packages removed due to slopcheck [SLOP] verdict:** none.
**Packages flagged as suspicious [SUS]:** none.
*slopcheck was unavailable — per protocol, the planner should re-run `slopcheck install execa --json` before the install task, or gate the `execa` install behind a `checkpoint:human-verify`. `execa` is a well-known sindresorhus package (verified repo + maturity), so the risk is low; the conservative tag is procedural, not a real signal.*

## Architecture Patterns

### System Architecture Diagram

```
  Pravin speaks ──mic PCM──┐
                           ▼
  ┌─────────────────────── FACE (Swift app, new this phase) ───────────────────────┐
  │  AVAudioEngine tap ──┬──► RMS (Face-local) ──► CloudView (Metal particles) ────┐ │
  │                      └──► 16kHz mono PCM ───────────────────────┐             │ │
  │  Stage controller ◄── willSpeakRangeOfSpeechString (TTS clock)  │             │ │
  │     │ fires cues (present/dismiss/burst), dual-paced            │             │ │
  │     ▼                                                           │             │ │
  │  Widgets (glass bloom/dissolve)        AVSpeechSynthesizer.speak(reply) ◄──┐  │ │
  │  Scene state: full-screen ◄──► corner pill                                 │  │ │
  └──────────────┬───────────────────────────────────────────────────────────│──┘ │
                 │  NWConnection (UDS NDJSON, same .sock as the daemon server)  │     
   Face→daemon:  │  utterance(final STT), ui.intent, ping, settings(brain=…)   │     
   daemon→Face:  │  ready, reply, speak{cues,onFinish}, widget.data, ui.state  │     
                 ▼                                                              │     
  ┌──────────────────────── KERNEL DAEMON (existing TS) ─────────────────────┐ │     
  │  ipc/server.ts (UDS NDJSON, frozen FrameSchema) ──enqueue──► loop.ts      │ │     
  │  loop: perceive → recall(inject) → decide(brain.reason) → act(dispatch→  │ │     
  │        gate.authorize) → log ; reply via intent.reply callback ──────────┼─┘     
  │                         │ decide                  │ act (gated)                  
  │   ┌─────────────────────┴──────────┐    ┌─────────┴──────────┐                   
  │   │ BrainProvider (swap-seam)      │    │ registry.dispatch  │  (Phase 2 tools)  
  │   │  ClaudeBrain ─HTTPS─► Claude API (manual tool loop)│      │  → peekaboo/browser
  │   │  LocalBrain  ─HTTP──► Ollama :11434 /api/chat      │      └────────────────── 
  │   │  ClaudeCodeBrain ─subproc─► `claude -p --json`     │                          
  │   │  helper.ts (always-on 7B) ─HTTP──► Ollama          │                          
  │   └────────────────────────────────────────────────────┘                        
  │  ipc/cues.ts (NEW): reply + planned widgets → speak{cues[atChar→action]}         
  └──────────────────────────────────────────────────────────────────────────┘      
        whisper.cpp (subprocess, STT) ◄── PCM from Face / spawned by daemon (§7)      
```

### Recommended Project Structure
```
daemon/src/
├── brain/
│   ├── BrainProvider.ts      # EXISTS — the seam (do not change the signature)
│   ├── StubBrain.ts          # EXISTS — keep for tests/default
│   ├── ClaudeBrain.ts        # NEW — @anthropic-ai/sdk, manual tool loop, opus-4-8
│   ├── LocalBrain.ts         # NEW — fetch → Ollama /api/chat, qwen2.5:7b
│   ├── ClaudeCodeBrain.ts    # NEW — execa/spawn `claude -p --output-format json`
│   ├── helper.ts             # NEW — always-on 7B triage/classify/narrate (Ollama)
│   └── decision.ts           # NEW (optional) — shared prompt→Decision JSON mapping/parse
├── ipc/
│   ├── protocol.ts           # EXISTS — extend ADDITIVELY (settings frame, ui.state)
│   └── cues.ts               # NEW — assemble char-offset cues into a speak frame
├── settings.ts               # NEW — brain=cloud|local state; applied via loop.setBrain
face/                          # NEW — Xcode project (Kernel.xcodeproj)
├── Kernel/
│   ├── KernelApp.swift        # @main App + MenuBarExtra + SMAppService toggle
│   ├── IPC/KernelSocket.swift # NWConnection UDS NDJSON client mirroring FrameSchema
│   ├── Voice/Speaker.swift    # AVSpeechSynthesizer (RETAINED property) + delegate
│   ├── Voice/MicEngine.swift  # AVAudioEngine tap → RMS + PCM to whisper
│   ├── Stage/StageController.swift # dual-paced cue firing (callback + time fallback)
│   ├── CloudView/Particles.swift + Particles.metal # compute-shader cloud
│   └── Widgets/…              # glass widgets (events/mail/accounts/spending/preview)
├── Kernel/Info.plist          # LSUIElement=YES, NSMicrophoneUsageDescription, NSSpeechRecognition n/a
└── Kernel/Kernel.entitlements # mic, (App Sandbox decision — see Open Question 4)
```

### Pattern 1: Manual Claude tool loop (BRAIN-06 — the load-bearing rule)
**What:** `ClaudeBrain.reason()` calls `messages.create`. Claude either replies (→ `Decision.reply`) or returns `stop_reason === "tool_use"` with `tool_use` blocks. The brain does NOT execute tools — it returns ONE `Decision.action` (the loop dispatches it through the gate), or runs an internal loop that, for each `tool_use` block, calls KERNEL's `router.dispatch` (which runs `gate.authorize`) and feeds a `tool_result` block back.
**When to use:** Always for ClaudeBrain. The seam already routes `decision.action` → `dispatch` → `gate.authorize` in `loop.ts` lines 99–107, so the simplest correct shape is: ClaudeBrain returns `{ action }` for one tool step; the loop gates+executes; the result re-enters as the next turn. This keeps the gate physically between decide and act.
```typescript
// Source: docs.anthropic.com/en/docs/build-with-claude/tool-use (manual loop) + existing loop.ts seam
// ClaudeBrain.reason — single-step shape that defers execution to KERNEL's gated dispatch.
const msg = await client.messages.create({
  model: 'claude-opus-4-8',
  max_tokens: 4096,
  system: context,            // identity + memory injected by the loop's inject()
  messages: [{ role: 'user', content: prompt }],
  tools: kernelToolDefs,      // zod-described tools mirroring the registry
});
if (msg.stop_reason === 'tool_use') {
  const tu = msg.content.find(b => b.type === 'tool_use');
  return { thought: textOf(msg), action: { tool: tu.name, args: tu.input } }; // loop gates+runs it
}
return { thought: textOf(msg), reply: textOf(msg) };
// NEVER: client.beta...toolRunner() / the SDK auto-runner — it bypasses gate.authorize.
```

### Pattern 2: LocalBrain over Ollama `/api/chat` (BRAIN-03)
**What:** POST to `http://localhost:11434/api/chat` with role-structured messages; request `format: 'json'` to coerce a Decision-shaped object; parse + `DecisionSchema.safeParse`. Handle model-not-loaded (cold start) and Ollama-absent gracefully.
**When to use:** When Settings `brain = local`, and inside `helper.ts` always.
```typescript
// Source: docs.ollama.com/api/chat (verified field shape) + ARCHITECTURE.md LocalBrain
const res = await fetch('http://localhost:11434/api/chat', {
  method: 'POST',
  body: JSON.stringify({
    model: 'qwen2.5:7b-instruct-q4_K_M',
    messages: [{ role: 'system', content: context }, { role: 'user', content: prompt }],
    stream: false,            // or true → NDJSON chunks for live narration
    format: 'json',           // structured-output coercion (string 'json' or a JSON schema object)
    options: { temperature: 0.2, num_ctx: 8192 },
    // keep_alive: omit → default idle-unload (16GB feature). Never -1.
  }),
}).catch(() => null);
if (!res) return { thought: 'ollama unreachable', reply: 'Local brain is unavailable — Ollama isn’t running.' };
if (!res.ok) { /* 404-ish body when model not pulled → escalate "model not installed: ollama pull …" */ }
const body = await res.json();           // { message: { role, content }, done, done_reason, ... }
return parseDecision(body.message.content);
```
**Absent/cold-start handling:** a rejected `fetch` (ECONNREFUSED) ⇒ Ollama not running ⇒ typed escalation. A non-OK status whose body names a missing model ⇒ "run `ollama pull qwen2.5:7b-instruct-q4_K_M`". A successful-but-slow first call is the model cold-loading (~1–3s) — surface a "thinking" cloud state, do not treat as an error.

### Pattern 3: ClaudeCodeBrain via headless `claude -p` (BRAIN-04)
**What:** Spawn the installed `claude` CLI non-interactively for code-heavy reasoning; parse the JSON result.
**When to use:** When the brain/router decides a task is code-heavy. In this phase, build the *invocation seam* only — the full transparency corner-pill transcript flow is Phase 4.
```typescript
// Source: code.claude.com/docs/en/headless (verified) + `claude --help` (v2.1.185 installed)
// claude -p "<prompt>" --output-format json  →  { result, session_id, total_cost_usd, ... }
const { stdout } = await execa('claude', [
  '-p', prompt,
  '--output-format', 'json',
  '--bare',                              // skip auto-discovery of hooks/MCP/CLAUDE.md → deterministic, faster
  // Phase-4 gate seam: '--permission-mode', 'dontAsk'  (Green/Yellow read-only set)
  //                     or restrict with --allowedTools "Read,Edit"
], { input: undefined });
const out = JSON.parse(stdout);          // out.result = the text; out.session_id resumes via --resume
return { thought: 'claude-code', reply: out.result };
```
**Gate seam (BRAIN-06 / Phase-4-ready):** ClaudeCodeBrain MUST NOT grant Claude Code ambient money/irreversible rights. This phase runs it Green/Yellow-only. The Phase-4 bridge adds the re-submission shim that routes any Red-tier action *up* to KERNEL's gate. For now, restrict with `--allowedTools` / `--permission-mode dontAsk` (denies anything outside the read-only command set). `--bare` requires auth via `ANTHROPIC_API_KEY` (skips keychain/OAuth).

### Pattern 4: Always-on 7B helper beside the providers (BRAIN-05)
**What:** `helper.ts` is NOT a `BrainProvider` implementation and is NOT swapped — it is a standalone function (e.g. `triage()`, `classify()`, `narrate()`) that always hits Ollama regardless of which brain is selected. It lives beside the providers because it cannot belong to any one impl.
**When to use:** Cheap high-frequency turns — message tagging, short narration between cloud thinks, classification. Falls back gracefully when Ollama is absent (returns a neutral default, never blocks the loop).

### Pattern 5: Daemon cue assembler → single `speak` frame (CLOUD-04, the choreography producer)
**What:** A new `ipc/cues.ts` takes a reply string plus the planned widget sequence and produces `cues[]` keyed to **character offsets** in the reply text — `present` a widget at the char where its topic starts, `dismiss`/`burst` at later offsets, `onFinish` to dissolve the last widget. The daemon sends ONE `speak` frame. It NEVER sends timing.
**When to use:** Every spoken reply that has accompanying widgets. The frame schema already exists frozen in `protocol.ts` (`SpeakSchema`).
```typescript
// Source: existing daemon/src/ipc/protocol.ts SpeakSchema + ARCHITECTURE.md choreography contract
const speak = {
  type: 'speak', id: utteranceId,
  text: "You've got three events today, and your checking is at twelve hundred.",
  cues: [
    { atChar: 9,  action: 'stage.present', widget: 'events',   data: {/*…*/} },
    { atChar: 40, action: 'stage.dismiss', widget: 'events' },
    { atChar: 48, action: 'stage.present', widget: 'accounts', data: {/*…*/} },
  ],
  onFinish: [{ action: 'stage.dismiss', widget: 'accounts' }],
};   // validate with SpeakSchema before send()
```

### Pattern 6: Dual-paced Stage controller (VOICE-03 + VOICE-04, the choreography consumer + fallback)
**What:** The Face's `StageController` holds `pendingCues`. The PRIMARY path fires cues when `willSpeakRangeOfSpeechString` reports a range whose `location >= cue.atChar`. The FALLBACK path (when callbacks don't fire or drift) is a **sentence-level time schedule**: split the text into sentences, estimate each sentence's duration (chars × per-char ms calibrated from the spike, or `AVSpeechUtterance.rate`), and fire any not-yet-fired cues at the scheduled sentence boundary. Both paths are idempotent (a cue fires once).
```swift
// Source: developer.apple.com/.../willspeakrangeofspeechstring + Apple Forums (struct-property requirement)
final class Speaker: NSObject, AVSpeechSynthesizerDelegate {
  let synth = AVSpeechSynthesizer()          // RETAINED PROPERTY — local var = delegate never fires (Forums 683471)
  func speechSynthesizer(_ s: AVSpeechSynthesizer,
                         willSpeakRangeOfSpeechString range: NSRange,
                         utterance: AVSpeechUtterance) {
    stage.fireCuesUpTo(charOffset: range.location)  // primary clock
  }
  func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
    stage.fireOnFinish()                            // dissolve last widget
  }
}
// Fallback timer (armed at speak start): every sentence tick → stage.fireCuesUpTo(scheduledOffset)
```

### Pattern 7: The Face app as an Xcode project, one app two scene states (CLOUD-01, CLOUD-05)
**What:** A single SwiftUI app (Xcode project, not pure SwiftPM) with `MenuBarExtra` for menubar presence, `SMAppService.mainApp.register()` for launch-at-login (user-toggled, default off), and a main window that switches between **full-screen** (boot/speaking) and a **top-left corner pill** (Claude Code session). It is ONE window/scene that animates between two states, not two apps (resolves Open Question 5). Connects to the daemon via `NWConnection` to the UDS path (`~/Library/Application Support/Kernel/kernel.sock`), reading/writing NDJSON frames mirroring `FrameSchema`.

### Pattern 8: Metal compute-shader particle cloud, Face-local mic RMS (CLOUD-02/03)
**What:** Particle positions/velocities live in an `MTLBuffer`, advanced by a compute kernel each frame, drawn additively in an `MTKView` wrapped by `NSViewRepresentable`. Idle = gentle drift (low-amplitude noise field). Speaking = the Face-local RMS value (from the `AVAudioEngine` input tap) is pushed into the shader uniform → particles push outward + brighten toward cyan. The RMS computation NEVER leaves the Face (no daemon round-trip — it's a 60fps signal).

### Anti-Patterns to Avoid
- **SDK auto tool-runner / `toolRunner`:** executes tools without KERNEL's gate. Forbidden (BRAIN-06). Use the manual loop.
- **Daemon-driven choreography timing:** daemon sending "now show events" via `setTimeout` estimates. The daemon cannot know the synthesizer's real pacing; ship cues up front, fire on the Face's TTS clock (ARCHITECTURE.md Anti-Pattern 1).
- **`AVSpeechSynthesizer` as a local variable:** the delegate never fires — it must be a retained property (Apple Forums 683471). This is a top cause of "boundary callbacks don't fire."
- **Mic RMS round-tripping the daemon:** adds latency to a 60fps animation. Keep it Face-local (CLOUD-03 is explicit about this).
- **Pinning the local model resident (`keep_alive: -1`):** holds ~6GB on a 16GB machine, starving Metal + browser. Rely on idle-unload.
- **Embedding a model / vector DB in the daemon:** violates §2 and the 16GB ceiling.
- **Changing the frozen `FrameSchema` non-additively:** the Swift Face mirrors it; only extend it (new frame arms), never mutate existing arms.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Word/segment boundary timing for choreography | A custom phoneme/duration estimator | `AVSpeechSynthesizerDelegate.willSpeakRangeOfSpeechString` (primary) + a coarse sentence timer (fallback) | The engine's own clock is the only accurate "where are we now" signal; estimators drift. |
| Claude tool-use protocol | A bespoke "does the reply contain a tool?" parser | `msg.stop_reason === 'tool_use'` + `tool_use`/`tool_result` content blocks | The SDK already models this; hand-parsing is fragile and misses parallel/multiple tool blocks. |
| STT engine | A custom audio→text model or DSP | whisper.cpp subprocess (CoreML/ANE build) | Pinned (§7); state-of-the-art, no native bindings, ANE-accelerated. |
| TTS engine | Custom synthesis | `AVSpeechSynthesizer` | Pinned; built-in, gives boundary callbacks for free. |
| GPU particle simulation | CPU per-frame particle updates / SwiftUI `ForEach` | Metal compute shader in `MTKView` | SwiftUI `ForEach`/Canvas chokes (~12fps at 500 views); Metal does 100k @ 60fps. |
| UDS client framing | Raw byte parsing | `NWConnection` + a small NDJSON line-buffer mirroring the daemon's per-connection buffer | The daemon already does partial-frame-safe NDJSON (`server.ts`); mirror that exact discipline. |
| Headless Claude Code orchestration | Driving an interactive PTY | `claude -p --output-format json` + `jq`/`JSON.parse(.result)` | Official non-interactive contract; `--resume <session_id>` for continuity. |
| Launch-at-login | `SMLoginItemSetEnabled` / login-item helper bundle | `SMAppService.mainApp` | The old API is deprecated pre-Ventura. |

**Key insight:** Almost everything fragile in this phase has a first-party answer (Apple frameworks, the Anthropic SDK, whisper.cpp, the existing frozen IPC contract). The ONLY genuinely novel code is the cue assembler (daemon) and the dual-paced Stage controller (Face) — and the latter exists precisely because the first-party boundary API is unreliable. Build the spike before the Stage.

## Common Pitfalls

### Pitfall 1: AVSpeechSynthesizer boundary callbacks don't fire / drift (THE lynchpin risk)
**What goes wrong:** `willSpeakRangeOfSpeechString` never fires (widgets bloom out of sync or not at all), or returns wrong character ranges (notably on numbers like "2020", and drift on words like "use"). The product's signature choreography breaks.
**Why it happens:** (1) The `AVSpeechSynthesizer` is a local variable, not a retained property — the delegate is never called (Apple Forums 683471). (2) Apple's TTS engine has language/voice-specific range bugs. Behavior varies by macOS version + voice.
**How to avoid:** Retain the synthesizer as a property. Run the **mandated on-device spike FIRST** (ROADMAP criterion 2): speak a fixed sentence containing numbers on the target voice, log every range. Build the Stage's dual-pacing (callback primary, sentence-time fallback) regardless of the spike verdict. Sanitize numbers/abbreviations where ranges are known to misbehave. Keep particle amplitude on mic RMS (independent of callbacks) so the cloud stays alive even when word-sync degrades.
**Warning signs:** No callbacks in logs on the target OS; ranges land mid-word; works in a toy app but not the real one (local-var bug).

### Pitfall 2: Calling the SDK auto tool-runner (gate bypass)
**What goes wrong:** Tools execute without `gate.authorize` running — the §8 chokepoint is decorative; a future poisoned-content path could reach a tool ungated.
**Why it happens:** The SDK's Tool Runner is the "easy" path; it runs tools itself.
**How to avoid:** Manual loop only. The loop already gates `decision.action`; ClaudeBrain returns actions, the loop dispatches them. Verify with a test: a ClaudeBrain decision carrying an action reaches `gate.authorize` (mock the SDK; assert dispatch was called).
**Warning signs:** Any `toolRunner`/`runTools` call; a tool executing inside `ClaudeBrain.reason` rather than via `router.dispatch`.

### Pitfall 3: 16GB OOM under the contention peak (this phase IS the peak)
**What goes wrong:** Ollama 7B (~5.5–7GB) + whisper.cpp + Node daemon + SwiftUI/Metal app + macOS contend; memory pressure, swap, inference yo-yo, particle jank.
**Why it happens:** Each component fits alone; together they don't. This phase brings them all online simultaneously (PITFALLS.md Pitfall 8).
**How to avoid:** `OLLAMA_MAX_LOADED_MODELS=1`, short `OLLAMA_KEEP_ALIVE`, never pin. Prefer the cloud brain for hard reasoning so the 7B stays unloaded between triage bursts. Don't run hot local inference + full-bloom Metal + browser concurrently. Treat sustained memory pressure as a degraded state that sheds particle load.
**Warning signs:** FPS drops when the 7B is hot; memory pressure yellow/red during a spoken reply.

### Pitfall 4: TCC permission instability / signing identity churn
**What goes wrong:** The Face needs Microphone (whisper PCM) + (later) Accessibility/Screen-Recording for the broader app. Ad-hoc/unsigned dev builds get a new TCC identity each rebuild → macOS forgets mic grants → silent failures.
**Why it happens:** TCC grants are bound to code signature + bundle ID + on-disk path.
**How to avoid:** Use an Xcode project with a stable signing identity from the start (this is the decisive reason to choose Xcode over pure SwiftPM). Stable bundle ID + install path. Probe-then-prompt for mic. `NSMicrophoneUsageDescription` must be in Info.plist or the app crashes on first mic access.
**Warning signs:** Mic worked yesterday, silently fails after a rebuild; no permission prompt appears.

### Pitfall 5: whisper.cpp / Ollama absent on this machine (verified absent)
**What goes wrong:** Code assumes the binary/server exists; `reason()` or the STT wrapper throws and crashes the loop.
**Why it happens:** This machine has neither installed (owner installs runtime deps). `ollama` and `whisper-cli` both ABSENT (verified).
**How to avoid:** Both clients must be **absent-tolerant**: probe (binary on PATH? `:11434` reachable?), and on absence return a typed escalation ("Ollama not running — start it / `ollama pull …`"; "whisper.cpp not found — build it"), never throw across the loop boundary. Mirror the Peekaboo adapter's probe-then-escalate pattern (`tools/peekaboo.ts`). All wrapper/parser logic is unit-testable with the binary mocked.
**Warning signs:** ECONNREFUSED unhandled; `spawn ENOENT` crashing the daemon.

### Pitfall 6: STT/TTS latency makes the cloud feel dead
**What goes wrong:** whisper transcription + cloud RTT + TTS startup add up to seconds; the cloud feels laggy, breaking the "alive" feel.
**How to avoid:** Use base.en/small.en (low latency). Let the 7B helper produce instant short narration while the cloud thinks. Start TTS on the first ready sentence rather than waiting for the full reply. Keep a "thinking" particle state so latency reads as deliberation.
**Warning signs:** Long silent gap between utterance and first spoken word with no cloud reaction.

### Pitfall 7: Metal jank on the integrated GPU under inference
**What goes wrong:** ~100k particles @ 60fps while Ollama does GPU inference → dropped frames, the "nothing snaps" law breaks.
**How to avoid:** Budget particle count to the measured GPU headroom (profile with Instruments on-device under concurrent inference). GPU-side simulation only, no per-frame CPU updates, avoid overdraw. Shed particle count under memory/GPU pressure.

## Runtime State Inventory

> This is a greenfield-feature phase (adds new brains + a new Face app), not a rename/refactor. No existing runtime state is being renamed or migrated. Recorded explicitly per protocol:

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None — no datastore keys/IDs change. The new Settings (`brain=cloud\|local`) is new state, not a migration. | None |
| Live service config | None renamed. New external deps (Ollama, whisper.cpp) are *added*, owner-installed. | None (owner installs runtime deps) |
| OS-registered state | New `SMAppService` launch-at-login registration for the Face (additive). The Phase-1 launchd daemon agent is unchanged. | Register the Face at login (user-toggled) — new, not a migration |
| Secrets/env vars | `ANTHROPIC_API_KEY` already needed for ClaudeBrain + ClaudeCodeBrain `--bare`. No env var renamed. | Ensure the key is loaded (Node 24 `--env-file=.env`); never in the memory repo |
| Build artifacts | New `face/` Xcode build products (`.app`). Daemon `dist/` rebuilds. No stale artifacts from a rename. | None |

**Nothing found in the rename/migration sense — verified by inspecting the existing daemon source and the empty phase dir.**

## Code Examples

### Extending the frozen FrameSchema additively (Settings toggle + ui.state)
```typescript
// Source: existing daemon/src/ipc/protocol.ts (discriminated union on `type`)
// ADD new arms; never mutate existing ones. The Swift Face mirrors these.
export const SettingsSchema = z.object({         // Face → daemon
  type: z.literal('settings'),
  brain: z.enum(['cloud', 'local']),
});
export const UiStateSchema = z.object({          // daemon → Face (cloud full-screen ↔ corner pill)
  type: z.literal('ui.state'),
  state: z.enum(['fullscreen', 'cornerPill', 'idle']),
});
// then add SettingsSchema, UiStateSchema to the FrameSchema discriminatedUnion array.
```

### Daemon applying the brain swap (uses the EXISTING seam)
```typescript
// Source: existing daemon/src/loop.ts setBrain()
import { setBrain } from './loop.js';
function applySettings(brain: 'cloud' | 'local') {
  setBrain(brain === 'local' ? new LocalBrain() : new ClaudeBrain()); // helper.ts runs regardless
}
```

### Decision JSON parse shared by Local/Claude (reuse the existing schema)
```typescript
// Source: existing daemon/src/brain/BrainProvider.ts DecisionSchema
import { DecisionSchema } from './BrainProvider.js';
export function parseDecision(raw: string): Decision {
  const obj = JSON.parse(raw);
  const r = DecisionSchema.safeParse(obj);
  return r.success ? r.data : { thought: 'unparseable brain output', reply: raw.slice(0, 500) };
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `SMLoginItemSetEnabled` / login-item helper | `SMAppService.mainApp` | macOS Ventura | Use `SMAppService`; the old API is deprecated. |
| Anthropic SDK manual tool loop hand-rolled | `stop_reason==='tool_use'` + `tool_use`/`tool_result` blocks; optional Tool Runner exists but is forbidden here | Stable since tool-use GA | Manual loop is required for the gate; do not adopt the auto-runner. |
| Ollama `/api/generate` (raw prompt) | `/api/chat` (role messages, `format:'json'` structured output, `tools`) | Stable | Use `/api/chat` — parallels the Claude message shape. |
| STACK.md assumed macOS 14/15 SDK | This machine ships **only macOS 26.5 SDK**, target `arm64-apple-macosx26.0` | Verified 2026-06-22 | Build against macOS 26.5 SDK; set a conservative deployment target but expect 26-SDK behavior. |
| `claude -p` loads ambient context by default | `--bare` skips hooks/MCP/CLAUDE.md auto-discovery (recommended for SDK/scripted calls; becoming default for `-p`) | Recent Claude Code | Use `--bare` + explicit flags for deterministic ClaudeCodeBrain runs. |

**Deprecated/outdated:**
- `SMLoginItemSetEnabled`: replaced by `SMAppService`.
- STACK.md's macOS 14/15 deployment-target assumption: stale for this machine's toolchain (macOS 26.5 SDK only).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `qwen2.5:7b-instruct-q4_K_M` is the model tag the owner will `ollama pull` | Stack / LocalBrain | If the owner pulls a different tag, LocalBrain's model string is a one-line config fix; low risk. Keep the tag in config, not hardcoded. |
| A2 | `execa` is legitimate/current (slopcheck unavailable at research time) | Package Legitimacy Audit | Low — it's a well-known sindresorhus package (verified repo + 9.6.1 published 2025-11-29). Planner should re-run slopcheck or use `node:child_process` (zero-dep). |
| A3 | An Xcode project (not pure SwiftPM) is the right Face layout for TCC permanence + Info.plist/entitlements | Open Question 1 / Pattern 7 | Medium — if the owner strongly prefers SwiftPM, it's buildable but needs manual Info.plist/entitlements/signing scaffolding (Swift Bundler / a packaging script). The TCC-permanence argument is strong; recommend Xcode. |
| A4 | The Face is ONE app with two scene states (full-screen ↔ corner pill), not two apps | Open Question 5 / Pattern 7 | Low — spec §15 says "two states, one element"; this is the explicit design. |
| A5 | whisper.cpp subprocess is spawned by the DAEMON (Face streams PCM to it) per §7, vs spawned by the Face | Open Question 2 | Medium — STACK.md/§7 say the daemon spawns whisper-cli; ARCHITECTURE.md's data-flow diagram shows whisper as "subprocess of Face". This is a genuine ambiguity — see Open Question 2 for the resolution (prefer daemon-spawned per §7's explicit "spawn as subprocess, pipe mic audio in"; the Face owns mic capture and pipes PCM). Confirm with owner if it affects latency. |
| A6 | The macOS 26.5 SDK supports MenuBarExtra / SMAppService / AVSpeech APIs unchanged from Ventura+ | Toolchain note | Low — these are long-stable APIs; the SDK is forward-compatible. |
| A7 | ClaudeCodeBrain runs Green/Yellow-only via `--permission-mode dontAsk` / `--allowedTools` this phase; the Red re-submission shim is Phase 4 | Pattern 3 | Low — matches CC-03 ("chokepoint respected in P3; breaker enabled in P4") and the owner hard-stop. |

**Note:** Items A3, A5 are the two assumptions most worth a quick owner/discuss-phase confirmation; A1/A2/A4/A6/A7 are low-risk.

## Open Questions

1. **SwiftPM executable target vs `.xcodeproj` for the Face?**
   - What we know: Pure SwiftPM can compile a macOS binary, but Info.plist (LSUIElement, NSMicrophoneUsageDescription), entitlements (mic, App Sandbox), and a stable signed identity are awkward/manual in SwiftPM; TCC grants are bound to signature + bundle ID + path.
   - What's unclear: nothing blocking — it's a tradeoff, not a hard limit.
   - **Recommendation (resolved):** Use an **Xcode project** (`face/Kernel.xcodeproj`). It gives Info.plist/entitlements/signing first-class, which is exactly what TCC permanence and the mic-usage-description requirement need. Compile-verify with `xcodebuild -scheme Kernel -destination 'platform=macOS' build`.

2. **Does the daemon or the Face spawn whisper.cpp?**
   - What we know: §7 says "whisper.cpp: spawn as subprocess, pipe mic audio in, read transcript out" and STACK.md says "the **daemon** spawns `whisper-cli` on rolling chunks; keeps audio in Swift, transcription in the daemon." ARCHITECTURE.md's diagram labels whisper "subprocess of Face." These conflict.
   - What's unclear: which process owns the spawn.
   - **Recommendation (resolved):** Follow §7/STACK.md — the **daemon** spawns whisper-cli; the **Face** owns mic capture (AVAudioEngine) and streams 16kHz mono PCM to the daemon, which feeds it to the subprocess and returns the transcript (or the Face sends a temp WAV path). This keeps the §2 subprocess boundary clean and STT logic unit-testable in the daemon. The ARCHITECTURE diagram label is the looser of the two; defer to §7's explicit instruction. Flag to owner only if mic→daemon→whisper latency proves worse than Face-local whisper.

3. **How is ClaudeCodeBrain invoked — SDK package or the `claude` CLI?**
   - What we know: `claude` v2.1.185 is installed at `~/.local/bin/claude`. The headless contract is `claude -p "<prompt>" --output-format json` → `{ result, session_id, ... }`; `--bare` for determinism; `--resume <session_id>` for continuity; `--allowedTools`/`--permission-mode dontAsk` for the read-only fence.
   - What's unclear: whether to depend on the `@anthropic-ai/claude-agent-sdk` TS package vs spawning the CLI.
   - **Recommendation (resolved):** Spawn the installed CLI via `execa`/`spawn` — zero new heavy dependency, matches the §2 subprocess boundary, and the JSON contract is stable. Parse `JSON.parse(stdout).result`. This is also the Phase-4-ready seam (add `--permission-mode`/`--allowedTools` and the re-submission shim there).

4. **App Sandbox: on or off for the Face?**
   - What we know: A sandboxed app needs `com.apple.security.device.microphone` + a UDS path the sandbox allows; UDS under `~/Library/Application Support/Kernel/` may need a security-scoped exception or a temporary-exception entitlement. A non-sandboxed signed app avoids that friction but can't ship via the Mac App Store (not a goal here).
   - What's unclear: whether the owner wants App Sandbox.
   - **Recommendation:** Start **non-sandboxed** (Developer ID signed, not App Store) — this is a personal single-user app; non-sandboxed avoids UDS/mic sandbox exceptions and matches the launchd-managed daemon. Revisit only if distribution requirements change. Confirm with owner.

5. **One Face app with two window states, or two windows/apps?**
   - **Recommendation (resolved):** ONE app, ONE animated scene that transitions full-screen ↔ corner-pill (spec §15: "two states, one element"). Driven by a daemon `ui.state` frame; rendered/animated entirely in the Face.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Swift / swiftc | Face build | ✓ | 6.3.2 | — |
| xcodebuild / Xcode | Face build (compile-verify) | ✓ | 26.5 (17F42) | — |
| macOS SDK | Face build | ✓ | 26.5 (only SDK present) | — |
| Node.js | Daemon brains | ✓ | 24.16.0 | — |
| `claude` CLI | ClaudeCodeBrain | ✓ | 2.1.185 (`~/.local/bin/claude`) | — |
| `@anthropic-ai/sdk` | ClaudeBrain | ✓ (installed) | 0.105.0 | — |
| Ollama (`:11434`) | LocalBrain + 7B helper | ✗ | — | Absent-tolerant client → typed escalation; Settings shows "local unavailable"; ClaudeBrain remains default |
| whisper.cpp (`whisper-cli`) | STT (VOICE-01) | ✗ | — | Absent-tolerant wrapper → typed escalation; STT manual owner check; typed-text utterance path still works for dev |
| `ANTHROPIC_API_KEY` | ClaudeBrain + ClaudeCodeBrain `--bare` | ? (owner-provided) | — | Owner sets via `.env` / env; daemon should fail loud with a clear message if absent when cloud brain is selected |

**Missing dependencies with no fallback:** none that block *building/compiling*. The phase's automated work (brain mappers, Ollama client vs mock, whisper parser, cue assembler, IPC round-trips, `swift build`/`xcodebuild` compile) all complete without Ollama/whisper present.

**Missing dependencies with fallback:** Ollama and whisper.cpp — both degrade to typed escalations and are owner-installed runtime deps. Live local inference and live mic transcription are **manual owner checks**, not automated gates.

## Validation Architecture

> nyquist_validation is enabled (config.json `workflow.nyquist_validation: true`). This section is included.

### Test Framework
| Property | Value |
|----------|-------|
| Framework (daemon) | `node:test` run via `tsx --test` (Node 24 native test runner) |
| Config file (daemon) | none — `package.json` `test` script: `tsx --test "src/**/*.test.ts" "test/**/*.test.ts"` |
| Quick run command (daemon) | `cd daemon && npx tsx --test src/brain/ClaudeBrain.test.ts -- ` (per-file) |
| Full suite command (daemon) | `cd daemon && npm test` (currently 69/69 green) |
| Framework (Face) | XCTest in the Xcode project (`xcodebuild test`) for pure-logic units (cue parsing, NDJSON framing, Stage cue-firing math) |
| Compile-verify (Face) | `cd face && xcodebuild -scheme Kernel -destination 'platform=macOS' build` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| BRAIN-02 | ClaudeBrain maps a mocked SDK reply → Decision | unit (SDK mocked) | `npx tsx --test src/brain/ClaudeBrain.test.ts` | ❌ Wave 0 |
| BRAIN-02/06 | tool_use reply → Decision.action reaches gate via dispatch | unit (mock SDK + spy dispatch) | `npx tsx --test src/brain/ClaudeBrain.test.ts` | ❌ Wave 0 |
| BRAIN-03 | LocalBrain POSTs `/api/chat`, parses message.content → Decision (fetch mocked) | unit | `npx tsx --test src/brain/LocalBrain.test.ts` | ❌ Wave 0 |
| BRAIN-03 | Ollama-absent (ECONNREFUSED) → typed escalation, no throw | unit | `npx tsx --test src/brain/LocalBrain.test.ts` | ❌ Wave 0 |
| BRAIN-04 | ClaudeCodeBrain parses `claude -p --json` stdout → Decision (execa/spawn mocked) | unit | `npx tsx --test src/brain/ClaudeCodeBrain.test.ts` | ❌ Wave 0 |
| BRAIN-05 | helper.triage/classify returns a default when Ollama absent, never blocks | unit | `npx tsx --test src/brain/helper.test.ts` | ❌ Wave 0 |
| VOICE-01 | whisper wrapper: binary-absent → escalation; transcript stdout → parsed text | unit (spawn mocked) | `npx tsx --test src/voice/whisper.test.ts` | ❌ Wave 0 |
| VOICE-03/04 | Stage fires each cue exactly once; sentence-time fallback fires unfired cues | unit (XCTest, Swift) | `xcodebuild test -scheme Kernel` (StageControllerTests) | ❌ Wave 0 |
| CLOUD-04 | cue assembler: reply + widget plan → valid `speak` frame (SpeakSchema passes) | unit | `npx tsx --test src/ipc/cues.test.ts` | ❌ Wave 0 |
| CLOUD-01/IPC | new frames (settings, ui.state, speak with cues) round-trip through FrameSchema | unit | `npx tsx --test src/ipc/protocol.test.ts` (extend) | ⚠️ extend existing |
| CLOUD-02/03 | Metal shaders compile; app builds | compile | `xcodebuild -scheme Kernel build` | ❌ Wave 0 |
| VOICE-02 (e2e) | typed utterance → ClaudeBrain (mock) → reply + speak frame over IPC | integration | extend `test/skeleton.e2e.test.ts` | ⚠️ extend existing |

**Manual-only (owner checks — cannot be automated this session):**
- Live mic → whisper transcription accuracy (needs whisper.cpp built + mic + TCC grant).
- Live local inference via Ollama (needs `ollama pull` + running server).
- **The boundary-callback spike** (`willSpeakRangeOfSpeechString` firing/fidelity on the target voice) — run on-device FIRST; record the verdict.
- Particle visual quality + 60fps under inference (Instruments, on-device).
- Choreography visually in sync with speech.

### Sampling Rate
- **Per task commit:** the touched module's unit file (`npx tsx --test src/<area>/<file>.test.ts`) + `npm run build` (daemon) or `xcodebuild build` (Face).
- **Per wave merge:** `cd daemon && npm test` (full daemon suite) + Face `xcodebuild build` + `xcodebuild test`.
- **Phase gate:** full daemon suite green + Face compiles + the documented manual owner checks recorded (boundary spike verdict, live STT, live local inference, visual choreography).

### Wave 0 Gaps
- [ ] `daemon/src/brain/ClaudeBrain.test.ts` — covers BRAIN-02, BRAIN-06 (mock `@anthropic-ai/sdk`)
- [ ] `daemon/src/brain/LocalBrain.test.ts` — covers BRAIN-03 (mock `fetch`; absent + cold-start + parse cases)
- [ ] `daemon/src/brain/ClaudeCodeBrain.test.ts` — covers BRAIN-04 (mock spawn/execa stdout)
- [ ] `daemon/src/brain/helper.test.ts` — covers BRAIN-05 (absent-tolerant defaults)
- [ ] `daemon/src/voice/whisper.test.ts` — covers VOICE-01 wrapper/parser (mock spawn)
- [ ] `daemon/src/ipc/cues.test.ts` — covers CLOUD-04 cue assembly (SpeakSchema validation)
- [ ] Extend `daemon/src/ipc/protocol.test.ts` — new settings/ui.state arms round-trip
- [ ] Extend `daemon/test/skeleton.e2e.test.ts` — utterance → mock-ClaudeBrain → reply+speak over IPC
- [ ] Face: `Kernel.xcodeproj` + `StageControllerTests` (XCTest) — cue-firing idempotence + time fallback
- [ ] Test seam for ClaudeBrain: a mock-injection point for the SDK client (mirror `peekaboo.ts` `__setClientForTest`)

## Security Domain

> `security_enforcement: true`, `security_asvs_level: 1`. Included.

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | partial | `ANTHROPIC_API_KEY` via env/`.env`, never in the memory repo or logs; UDS is file-permission scoped (no network port). |
| V3 Session Management | no | Single local user; UDS connection, no web sessions. |
| V4 Access Control | yes | The gate chokepoint (`gate.authorize`) is the access-control boundary; brains never call tools directly. ClaudeCodeBrain runs Green/Yellow-only (`--permission-mode dontAsk`). |
| V5 Input Validation | yes | `zod` on every IPC frame (`FrameSchema`), every Decision (`DecisionSchema`), every Ollama response, and tool args. The Face must NOT auto-load remote images/markdown from model output (exfil — PITFALLS.md Pitfall 5) — render only structured widget data. |
| V6 Cryptography | no | No new crypto this phase (finance/SQLCipher is Phase 4). |

### Known Threat Patterns for {TS daemon + Swift Face + LLM brains}
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Indirect prompt injection (read content → tool call) | Tampering/EoP | Manual gated tool loop; external content stays tainted; Red = deny (Phase 2 lock holds). No new external-content→tool path added this phase. |
| Markdown/remote-image exfil via the Face | Info disclosure | Face renders only structured widget data; no auto-load of remote resources from model output (PITFALLS.md Pitfall 5). |
| Auto tool-runner bypassing the gate | EoP | Manual loop only (BRAIN-06); test that a ClaudeBrain action reaches `gate.authorize`. |
| Secret leak (API key in logs / memory repo) | Info disclosure | Key from env only; `pino` must not log the key; never persisted to `kernel-memory/`. |
| ClaudeCodeBrain ambient money/irreversible rights | EoP | Green/Yellow-only this phase; `--allowedTools`/`dontAsk`; Red re-submission shim deferred to Phase 4 (CC-03). |
| Untrusted IPC frame crashing the daemon | DoS | `safeParse` per line, error-frame on bad input (already implemented in `server.ts`); new frames added to the union keep this property. |

## Sources

### Primary (HIGH confidence)
- Live codebase: `daemon/src/ipc/protocol.ts` (frozen FrameSchema + SpeakSchema cues), `brain/BrainProvider.ts` (Decision + DecisionSchema), `brain/StubBrain.ts`, `loop.ts` (setBrain + gated dispatch seam), `tools/registry.ts` (dispatch→authorize order), `tools/peekaboo.ts` (probe-then-escalate + `__setClientForTest` mock pattern), `safety/gate.ts` (Verdict union), `config.ts` (socketPath/memoryDir), `package.json`/`tsconfig.json` — direct inspection.
- Phase summaries `01-03-SUMMARY.md`, `02-01-SUMMARY.md` — IPC contract, loop semantics, gate chokepoint, swap-seam.
- `docs/KERNEL_MASTER_BUILD_PROMPT.md` §6 (BrainProvider impls + Settings toggle + always-on 7B), §7 (Ollama/whisper/TTS wiring), §13 (Claude Code bridge), §15 (cloud/Stage/choreography sync mechanism), §16 (Phase 2).
- Toolchain probe (this machine): `swift 6.3.2`, `xcodebuild 26.5`, macOS 26.5 SDK only, `node 24.16.0`, `claude 2.1.185` present, `ollama`/`whisper` absent — verified via shell.
- code.claude.com/docs/en/headless — `claude -p`, `--output-format json` (`.result`/`.session_id`), `--bare`, `--allowedTools`, `--permission-mode dontAsk`, `--resume` — verified + cross-checked with local `claude --help`.
- docs.ollama.com/api/chat — `/api/chat` request (model/messages/stream/format/options/keep_alive/tools) + response (`message.content`, `done`, `done_reason`) shape.
- developer.apple.com — `MenuBarExtra`, `SMAppService`, `AVSpeechSynthesizerDelegate.willSpeakRangeOfSpeechString`.

### Secondary (MEDIUM confidence)
- Apple Developer Forums 683471 / 133104 — `willSpeakRangeOfSpeechString` not firing unless the synthesizer is a retained property; range drift on numbers like "2020". Cross-confirms PITFALLS.md Pitfall 11.
- docs.anthropic.com/en/docs/build-with-claude/tool-use — manual tool loop (`stop_reason==='tool_use'`, `tool_use`/`tool_result` blocks); Tool Runner exists but is the forbidden auto path.
- Swift Forums — SwiftPM entitlements/Info.plist limitation for app bundles (drives the Xcode-project recommendation).
- npm `npm view execa` — 9.6.1, published 2025-11-29, repo github.com/sindresorhus/execa.
- STACK.md / ARCHITECTURE.md / PITFALLS.md (project research) — pinned versions, transport decisions, contention/choreography pitfalls.

### Tertiary (LOW confidence)
- Metal "100k particles @ 60fps; SwiftUI ForEach ~12fps" benchmark figures (community sources via STACK.md) — directional, must be re-profiled on-device under concurrent inference.

## Metadata

**Confidence breakdown:**
- Standard stack (daemon brains, IPC, Claude Code, manual tool loop): **HIGH** — verified against live code + authoritative docs + installed-tool probes.
- Architecture / choreography contract: **HIGH** — the contract is already frozen in `protocol.ts`; the cue-assembler + dual-paced Stage are the only new pieces and follow ARCHITECTURE.md directly.
- AVSpeechSynthesizer boundary fidelity on this exact OS: **MEDIUM** — known-flaky API; the mandated on-device spike is the only way to resolve it; the time-based fallback de-risks it.
- SwiftPM-vs-Xcode + App-Sandbox decisions: **MEDIUM** — verified pattern/tradeoff, but no on-device Face build has happened yet.
- Metal performance budget: **LOW/MEDIUM** — community benchmark figures; profile on-device.

**Research date:** 2026-06-22
**Valid until:** ~2026-07-22 (30 days) for the daemon/Anthropic/Ollama facts; the boundary-callback spike verdict supersedes any AVSpeech assumption the moment it runs and should be treated as authoritative thereafter.
