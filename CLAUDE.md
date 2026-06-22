<!-- GSD:project-start source:PROJECT.md -->
## Project

**KERNEL**

KERNEL is a persistent local AI orchestrator for macOS — a "foreman that never clocks out." It is not a smarter coding assistant; it is a long-lived daemon that persists across sessions, holds distilled memory, runs daily routines, controls the Mac through GUI and browser automation, and hires Claude Code as a sub-contractor when code needs writing. The owner is **Pravin Maurya**; in voice and judgment KERNEL is a digital copy of Pravin — direct and terse to him, register-shifting for outward content (email, posts, docs).

**Core Value:** KERNEL persists and acts on Pravin's behalf without clocking out: it holds memory across sessions, runs the morning brief, and routes work to the right tool (Claude Code, Peekaboo, browser, local model) — always behind a safety gate that makes "got robbed by a poisoned email" structurally impossible.

### Constraints

- **Tech stack (pinned — decisions, not options)**: Daemon = TypeScript/Node. Face = native Swift/SwiftUI, launch-at-login, menubar presence. Local model = Ollama serving Qwen2.5-7B-Instruct (or Llama-3.1-8B) Q4_K_M over `http://localhost:11434`. STT = whisper.cpp (base.en/small.en) as subprocess. TTS = AVSpeechSynthesizer. Brain default = Claude API (pluggable). GUI hands = Peekaboo (MCP+CLI). Browser hands = Playwright (headful). Scheduler = launchd. Memory = markdown+YAML git repo, nightly push to private GitHub backup. Finance = read-only aggregation API (Plaid-style OAuth).
- **Memory/RAM**: 16GB ceiling — no embedded models, prefer keyword retrieval, lean on Ollama idle-unload.
- **Safety**: Tiered autonomy (🟢 reversible / 🟡 recoverable / 🔴 irreversible+financial). Red tier always gated even under `/override`: dry-run preview → 10s cancel → spend-ceiling check → audit log. Hard non-overridable rules: no credential entry, no Red action sourced from external content, daily spend ceiling. Red-tier gating applies inside Claude Code sessions too.
- **Working protocol**: build one phase at a time in §16 order; each phase independently working before the next; commit + push at every phase gate. (Owner directive for this build: Phases 0–3 run autonomously without approval; **hard stop before Phase 4**, the phase that enables money/`rm -rf`/`/override`.)
- **Design language**: Apple sleekness × shadcn precision × a living cloud. Deep spatial black, low-chroma zinc neutrals, hairline borders, one accent only (indigo `#7C8CFF` → cyan `#42E8E0`, reserved for the cloud and active states). SF Pro, tabular numerals for money. Motion law: nothing snaps — everything eases, drifts, settles. Real GPU particle system (Metal/SpriteKit/SceneKit); widgets bloom and dissolve in sync with TTS word boundaries.
<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->
## Technology Stack

## Recommended Stack
### Core Technologies
| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| **Node.js** | **24.x LTS** (Active LTS) | Daemon runtime | Node 24 is the Active LTS line in June 2026; Node 22 is in maintenance. 24 gives stable `node:sqlite`, modern `--watch`, native `.env`, fetch, and a long support runway (LTS until ~2027). Use `nvm`/`fnm` pinned via `.nvmrc`. Run as ESM (`"type":"module"`). Do not use 23/25/26 (odd = non-LTS, unstable for a long-lived daemon). |
| **TypeScript** | **5.9.x** | Daemon language | Current stable. Compile with `tsc` for builds; run dev with `tsx`. `BrainProvider` interface (§6) and `Decision` types are the type backbone. |
| **Swift / SwiftUI** | Swift 6.x, SwiftUI for **macOS 15 Sequoia+** (deployment target macOS 14 Sonoma min) | Native "face" UI | Pinned. macOS 14 min because whisper.cpp docs flag transcription hallucinations on pre-Sonoma. Use Swift 6 strict concurrency for the audio/Metal/IPC actors. |
| **Ollama** | **0.13.x+** (latest stable) | Local model HTTP server | Pinned. Runs as its own process behind `http://localhost:11434` — the HTTP boundary that keeps TS viable (§2). Native macOS app installs a launch-at-login background server and unloads idle models (RAM feature on 16GB). |
| **whisper.cpp** | **ggml-org/whisper.cpp** latest (`master`, build from source) | STT subprocess | Pinned. Build with Core ML (`-DWHISPER_COREML=1`) → encoder runs on Apple Neural Engine, >3x faster than CPU. Metal is on by default on Apple Silicon. Spawned binary, no native Node bindings. |
| **Peekaboo** | latest (`brew install steipete/tap/peekaboo`) | GUI hands (MCP + CLI) | Pinned. macOS automation toolkit: pixel/window/menubar capture, AX tree maps, click/type/scroll/drag/hotkeys/menus/dialogs/windows/Spaces. Ships as CLI **and** MCP server with identical tools. Canonical repo is now **`github.com/openclaw/Peekaboo`** (author @steipete; old `steipete/Peekaboo` redirects). |
| **Playwright** | **1.61.0** | Browser hands (headful) | Pinned. Current stable (published June 2026). Use `chromium.launchPersistentContext(userDataDir)` for durable logins. Headful (`headless: false`) for human-visible automation and to reduce anti-bot friction. |
| **launchd** | macOS native | Scheduler (login agent + timed wakes) | Pinned. `LaunchAgents` plist: `RunAtLoad` + `KeepAlive` for the daemon; `StartCalendarInterval` for morning brief / nightly jobs. |
| **@anthropic-ai/sdk** | **0.105.0** | Brain (default) — Claude API | Pinned. Official TS SDK. Use Messages API with `.stream()` + `.finalMessage()`. Model IDs below. |
### Claude model IDs (the Brain) — verified June 2026
| Role in KERNEL | Model ID | Context / Max out | Why |
|----------------|----------|-------------------|-----|
| **Hard reasoning / planning / recovery** (`ClaudeBrain` default) | **`claude-opus-4-8`** | 1M / 128K | Current Opus flagship — most capable for long-horizon agentic work, judgment, the obstacle ladder (§9). |
| **Default balanced brain** (cost-aware alt to Opus) | **`claude-sonnet-4-6`** | 1M / 64K | Best speed/intelligence balance; good default for routine decisions if Opus cost is a concern. |
| **High-stakes email rewrite** (§12 cloud route) | `claude-sonnet-4-6` or `claude-opus-4-8` | — | New-client / money / sensitive mail routes to cloud per §12. |
| **Cheap cloud classification** (if not using local 7B) | **`claude-haiku-4-5`** | 200K / 64K | Fastest/cheapest; fallback for triage when local 7B is unloaded. |
### Local model selection (Ollama, 16GB ceiling) — the forced choice
| Model tag | RAM (Q4_K_M) | Verdict |
|-----------|--------------|---------|
| **`qwen2.5:7b-instruct-q4_K_M`** | ~5–6 GB resident | **RECOMMENDED.** Strong instruction-following + tool/JSON formatting at 7B, the workhorse for triage/classification/short narration (§6). Fits comfortably alongside whisper.cpp, the SwiftUI app, Mail, and a browser on 16GB. |
| `llama3.1:8b-instruct-q4_K_M` | ~6–7 GB resident | Acceptable alternative; slightly larger footprint, marginally weaker structured-output adherence than Qwen2.5 in practice. Use if you specifically prefer Llama tooling. |
| anything ≥ 13B | 10GB+ | **Do NOT.** Leaves no headroom for the browser + SwiftUI + system; thrashing on 16GB. |
### Supporting Libraries (daemon)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| **@modelcontextprotocol/sdk** | **1.29.0** | MCP **client** to drive Peekaboo | Phase 1. `Client` + `StdioClientTransport` spawning `npx @steipete/peekaboo mcp` (or the brew binary). This is how the daemon calls capture/click/type. |
| **playwright** | 1.61.0 | Browser tool | Phase 1. Driver + Chromium. `npx playwright install chromium`. |
| **pino** | **10.3.1** | Structured JSON logging | Phase 0. Fast, low-overhead, structured logs → `logs/` (§5). Pair with `pino-pretty` (dev only) and a file transport. Logs are the raw events that nightly consolidation distills. |
| **zod** | **4.4.3** | Schema validation | Throughout. Validate brain JSON `Decision` output, tool args, routine YAML, IPC messages, Plaid responses. Pairs with `@anthropic-ai/sdk` tool definitions. |
| **yaml** | 2.x | Routine + front-matter parsing | Phase 3 (morning-brief.yaml presets) and §5 memory front-matter. Use `yaml` over `js-yaml` (better TS types, comment preservation). |
| **gray-matter** | 4.x | Markdown + YAML front-matter | §5 memory files (tasks/, knowledge/). Splits front-matter from body cleanly. |
| **execa** | 9.x | Subprocess spawning | whisper.cpp binary, `ollama`, `git`, Claude Code bridge (§13). Better ergonomics/streaming than raw `child_process`. |
| **simple-git** | 3.x | Memory repo + nightly backup | §5 commit/push to private GitHub backup. Or just shell `git` via execa if you prefer fewer deps. |
| **chokidar** | 4.x | File watching | Optional — watch `kernel-memory/` for external edits to re-inject. |
| **plaid** | **42.2.0** | Finance aggregation (read-only) | Phase 3. Official Plaid Node SDK. Sandbox first, then Trial (personal-use) plan. |
| **better-sqlite3-multiple-ciphers** | **12.11.1** | Encrypted finance store | Phase 3. SQLCipher-compatible encrypted SQLite for `kernel-memory/finance/` (gitignored). Synchronous API is ideal for a single-process daemon. |
### Supporting frameworks (Swift "face")
| Framework | Purpose | Notes |
|-----------|---------|-------|
| **SwiftUI `MenuBarExtra`** | Menubar presence | Use for the menubar item; `.menuBarExtraStyle(.window)` for the popover panel. Falls back to `NSStatusItem` + `NSPopover` only if you need window sizing beyond ~half-screen (MenuBarExtra `.window` is size-constrained). |
| **ServiceManagement `SMAppService`** | Launch at login | `SMAppService.mainApp.register()` / `.unregister()`. Must be a user-toggled setting, default off (App Review rule). Replaces the deprecated `SMLoginItemSetEnabled`. |
| **Metal (`MTKView` + compute shader)** | GPU particle cloud (§15) | **RECOMMENDED** for thousands of soft particles. Position/velocity in a `MTLBuffer`, advanced by a compute kernel, drawn with additive blending. Verified: Metal handles 100k particles @ 60fps; SwiftUI `ForEach`/Canvas chokes (~12fps at 500 views). Embed via `NSViewRepresentable`. |
| **AVFoundation `AVSpeechSynthesizer`** | TTS (§7, §15) | Conform a delegate to `AVSpeechSynthesizerDelegate`; implement `speechSynthesizer(_:willSpeakRangeOfSpeechString:utterance:)` — the `NSRange` per word/segment drives `Stage.present/dismiss` choreography and particle bursts. Known quirk: range can occasionally be off — guard against out-of-bounds. |
| **AVFoundation `AVAudioEngine`** | Mic capture + RMS | Install a tap on `inputNode`; compute RMS per buffer for the cloud's amplitude reaction (§15). Same engine feeds raw PCM to the whisper.cpp subprocess (write WAV/PCM to its stdin or a temp pipe). |
| **EventKit** | Calendar (morning brief) | `calendar` step (§11). Requests Calendar permission. |
### Development Tools
| Tool | Purpose | Notes |
|------|---------|-------|
| **tsx** | Run/reload TS in dev | `tsx watch src/loop.ts` for the daemon dev loop. |
| **fnm** or **nvm** | Pin Node 24 | `.nvmrc` = `24`. |
| **Xcode 16+** | Build the Swift face | Required for Swift 6 + macOS 15 SDK. |
| **cmake** | Build whisper.cpp | `cmake -B build -DWHISPER_COREML=1 -DWHISPER_SDL2=ON`. |
| **Homebrew** | Peekaboo, ollama (optional), cmake, sdl2 | `brew install cmake sdl2 steipete/tap/peekaboo`. |
## Installation
# --- Node toolchain (daemon) ---
# Core daemon deps
# Dev deps
# Browser binary (headful Chromium)
# --- Local model (Ollama) ---
# Install the macOS app from https://ollama.com (DMG -> /Applications),
# enable "Launch at Login" from the menubar icon. Then:
# --- STT (whisper.cpp, Core ML + Metal + mic streaming) ---
# (Core ML encoder model is generated/downloaded per repo instructions)
# --- GUI hands (Peekaboo) ---
## Layer-by-layer implementation notes
### 1. TypeScript/Node daemon
- **Runtime:** Node 24 LTS, ESM. Single long-lived process; the loop (`perceive → recall → decide → act → log`) is an async event loop, not a polling `while(true)` — drive it from IPC messages, launchd-triggered routine runs, and timers.
- **Process management:** `launchd` LaunchAgent owns the daemon lifecycle (`RunAtLoad` + `KeepAlive`). **Do NOT use pm2/forever** — they duplicate what launchd does natively and add a dependency; launchd is the pinned scheduler anyway.
- **IPC to the Swift face:** **Unix domain socket** (`net.createServer` on a `.sock` path under `~/Library/Application Support/Kernel/`) with newline-delimited JSON, **not** localhost HTTP. UDS is ~20–40% lower latency than TCP loopback, file-permission scoped (not exposed on any port), and ideal for the bidirectional, low-latency voice/choreography stream. If you ever need to debug with `curl`, add a localhost HTTP shim — but the primary channel is UDS. Swift side: `Network.framework` `NWConnection` to the same socket path.
- **Config:** Node 24 native `--env-file=.env` for secrets (Anthropic key, Plaid keys) + a typed `config.ts` validated with zod. Keep secrets out of the memory repo.
- **Logging:** `pino` → JSON lines into `kernel-memory/logs/`. These are the append-only raw events §5 prunes/distills.
- **MCP client for Peekaboo:** `@modelcontextprotocol/sdk` `Client` + `StdioClientTransport` spawning the Peekaboo MCP server; call `tools/list` then `tools/call`.
### 2. Local model (Ollama)
- **Endpoint:** use **`POST /api/chat`** (role-structured messages, matches the `BrainProvider`/Claude shape) — not `/api/generate` (raw prompt completion, legacy-feeling, harder to keep parallel with the cloud brain).
- **Streaming:** `"stream": true` returns NDJSON chunks; parse line-by-line for live narration.
- **Idle unload:** rely on default `keep_alive: 5m`. Set per-request `keep_alive` only if a routine needs back-to-back calls. Avoid `-1` on 16GB.
- **Launch at login:** the Ollama macOS app handles this (menubar → Launch at Login). A custom launchd agent is the fallback if you want host/port control via `OLLAMA_HOST`.
### 3. whisper.cpp
- **Build:** `-DWHISPER_COREML=1` (ANE encoder, >3x) + Metal (default) + `-DWHISPER_SDL2=ON` (for the `whisper-stream` mic tool).
- **Model:** **`base.en`** for low latency on M2 Pro; bump to **`small.en`** if accuracy on accented/technical speech matters more than the ~2x latency. English-only `.en` models are faster and sufficient (owner is English-speaking).
- **Streaming invocation:** `./build/bin/whisper-stream -m ./models/ggml-base.en.bin -t 8 --step 500 --length 5000` for naive real-time. For production, prefer: SwiftUI captures mic via `AVAudioEngine`, writes 16kHz mono PCM, and the **daemon** spawns `whisper-cli` on rolling chunks via `execa`, reading the transcript off stdout. Keeps audio in Swift, transcription in the daemon, per the subprocess boundary (§7).
### 4. Peekaboo
- **Drives:** screenshot/window/menubar capture, AX-tree element maps, click (by element ID/query/coords), type + control keys, scroll, drag, hotkeys, menu navigation, dialog/window/Spaces control. Covers the §2 "Mail, recording, GUI-only apps, menus" requirement.
- **Permissions (System Settings → Privacy & Security):**
- **Integration:** MCP server for the daemon; the CLI is handy for manual testing of the same primitives.
### 5. Playwright (headful)
- **Persistent logins:** `chromium.launchPersistentContext('<dataDir>', { headless: false })`. **Do NOT point `userDataDir` at the user's real Chrome "User Data"** — recent Chrome policy breaks automation of the default profile (blank pages / browser exits). Use a dedicated dir under app support.
- **Anti-bot reality:** headful + a persistent, warmed profile (real cookies, real history) defeats most basic bot checks. Hard CAPTCHA / aggressive fingerprinting (banks, ticketing) will still block — that's by design and aligns with KERNEL's safety model: finance is **read-only Plaid OAuth, never credential entry** (§8, §14). Treat browser automation as best-effort with human handoff on block, per the obstacle ladder (§9). Do NOT reach for `playwright-extra`/stealth plugins as a crutch — they break across versions and invite exactly the brittle, login-grinding behavior the spec forbids.
### 6. Swift / SwiftUI
- **Menubar + launch-at-login:** `MenuBarExtra` (style `.window`) + `SMAppService.mainApp` toggle (default off). The app is the persistent menubar "face"; the TS daemon is a separate launchd-managed process they connect over UDS.
- **Particle cloud:** Metal compute shader in an `MTKView` wrapped by `NSViewRepresentable`. SpriteKit is a viable middle ground (less boilerplate, `SKEmitterNode`) but caps out lower and gives less control over the indigo→cyan field and amplitude response; SceneKit is overkill (3D scene graph for a 2D nebula). **Recommend Metal**, fall back to SpriteKit only if Metal timeline pressure is high in Phase 2.
- **TTS boundaries:** `AVSpeechSynthesizerDelegate.speechSynthesizer(_:willSpeakRangeOfSpeechString:utterance:)` → emit boundary events over UDS / call `Stage` controller to bloom/dissolve widgets in sync (§15).
- **Mic RMS:** `AVAudioEngine` input tap → RMS per buffer → particle outward-push + brighten when speaking, calm when quiet.
### 7. launchd
- **Daemon agent** (`~/Library/LaunchAgents/com.kernel.daemon.plist`): `ProgramArguments` = node + entry; `RunAtLoad: true`; `KeepAlive: true` (restart on crash — appropriate for a "never clocks out" daemon); `StandardOutPath`/`StandardErrorPath` to log files.
- **Timed jobs:** separate plists for morning brief (`StartCalendarInterval` with `Hour`/`Minute`), nightly consolidation, cleanup, GitHub backup. `StartCalendarInterval` wakes the job on schedule; if the Mac is asleep it runs at next wake. Use `launchctl bootstrap gui/$(id -u) <plist>` to load (not the deprecated `launchctl load`).
### 8. Finance (Plaid, read-only, encrypted local store)
- **Plaid:** start in **Sandbox** (free, unlimited test Items, full API + Link). For real accounts, the **Trial plan / "Personal use"** signup is auto-approved for most and allows up to **10 Production Items** with Auth + **Transactions** + Balance + Identity + Investments + Liabilities included — sufficient for a single owner's accounts at $0. Use Plaid Link for the one-time OAuth; KERNEL stores only the read-only `access_token`. **Never types banking credentials** (hard rule §8/§14).
- **Encrypted local store:** **`better-sqlite3-multiple-ciphers`** (SQLCipher-compatible, AES-256) for `kernel-memory/finance/` — gitignored, excluded from backup. ~5–15% encryption overhead, trivial at this volume. Store the DB key in the **macOS Keychain** (via a tiny Swift helper exposed to the daemon, or `cross-keychain`), not in a file. age/libsodium are fine for encrypting a flat export blob, but SQLCipher is better because spending charts need queryable W/M/Y aggregates locally — encrypt the database, not a dump.
- **Alternatives:** MX / Finicity are Plaid competitors; not worth the integration switch for a single-user app — Plaid's free Trial tier covers it.
### 9. Brain (Claude API)
- **SDK:** `@anthropic-ai/sdk@0.105.0`, Messages API. Stream with `client.messages.stream({...})` and await `.finalMessage()` when you need the assembled result; consume `text` deltas live for narration.
- **Tool use:** define tools with zod schemas (SDK `betaZodTool` helper) so the brain's `ToolCall` maps onto KERNEL's tool router. Use a **manual tool loop** (not the auto runner) so the **safety gate** (§8) sits between decision and execution — Red-tier actions must hit the circuit breaker before running.
- **Model pinning:** default `claude-opus-4-8`; expose `claude-sonnet-4-6` as the cost-aware brain and `claude-haiku-4-5` for cheap cloud classification. Versioned IDs only.
## Alternatives Considered
| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| Node 24 LTS | Bun | If you want faster startup/native TS — but it adds risk for a long-lived daemon needing rock-solid `child_process`, sockets, and `better-sqlite3` native addons. Stay on Node 24. |
| Unix domain socket IPC | localhost HTTP/WebSocket | If the face ever becomes a separate device/web client. For same-machine Swift↔Node, UDS wins on latency + security. |
| `qwen2.5:7b` Q4_K_M | `llama3.1:8b` Q4_K_M | If you prefer Llama tooling/ecosystem; accept slightly higher RAM + weaker JSON adherence. |
| Metal compute particles | SpriteKit `SKEmitterNode` | If Metal shader work threatens the Phase 2 timeline; accept lower particle ceiling and less control. |
| whisper.cpp subprocess | WhisperKit (Swift, CoreML/ANE) | If you'd rather keep STT fully in-Swift with no subprocess. But it breaks the §7 "spawned binary" pin and the HTTP/subprocess-boundary architecture; stay with whisper.cpp. |
| Plaid Trial (personal) | MX / Finicity | High-volume / multi-tenant. Not this single-user app. |
| `MenuBarExtra` | `NSStatusItem` + `NSPopover` | When you need a panel larger than ~half-screen or precise window control. |
| `better-sqlite3-multiple-ciphers` | age/libsodium-encrypted JSON | If finance data were write-once/read-rarely. Charts need queries → SQLCipher. |
## What NOT to Use
| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `claude-*-latest` aliases | Silently re-point to new models — dangerous for a daemon with a safety gate | Versioned IDs (`claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5`) |
| `claude-opus-4-1` / `4-0`, `sonnet-4-0`, `haiku-3` | Deprecated; 4-1 retires 2026-08-05 | Current active IDs above |
| 13B+ local models, or `keep_alive: -1` | Blow the 16GB budget; starve browser + Metal + system | Single 7B Q4_K_M, default idle-unload |
| pm2 / forever / nodemon (prod) | Duplicate launchd; extra deps for a process launchd already supervises | launchd LaunchAgent (`RunAtLoad`+`KeepAlive`) |
| Embedding a model in the daemon (any node-llama-cpp / transformers.js path) | Violates the HTTP-boundary keystone (§2); makes brain non-swappable; costs RAM | Ollama over HTTP; whisper.cpp subprocess |
| Playwright `headless: true` + stealth plugins | Spec wants visible, honest automation; stealth plugins are brittle and invite login-grinding the safety model forbids | Headful `launchPersistentContext` + human handoff on block |
| Pointing Playwright `userDataDir` at real Chrome "User Data" | Chrome policy breaks default-profile automation (blank pages/exit) | Dedicated automation profile dir |
| Ollama `/api/generate` | Legacy raw-prompt shape; diverges from the message-based cloud brain | `/api/chat` |
| `SMLoginItemSetEnabled` / login-item helper bundles | Deprecated pre-Ventura API | `SMAppService` |
| Embeddings for memory retrieval (initially) | Cost RAM the 16GB machine doesn't have (§5) | Keyword retrieval first |
| Storing secrets/DB keys in the memory repo | Memory repo pushes to GitHub; would leak finance keys | macOS Keychain; finance/ gitignored |
| `js-yaml` | Weaker TS types, no comment preservation for editable routines | `yaml` |
## Stack Patterns by Variant
- Route `BrainProvider.reason()` to `POST http://localhost:11434/api/chat` with `qwen2.5:7b-instruct-q4_K_M`.
- Surface "local = visibly dumber on 16GB" in the UI when flipped (spec requirement).
- Expect a cold-start reload if the model idle-unloaded; show a brief spinner.
- Drop to SpriteKit `SKEmitterNode` for the nebula; keep the `Stage`/boundary-callback choreography identical (it's TTS-driven, renderer-agnostic).
- Fall back to `base.en`; rely on the cloud brain's quality to compensate for minor transcription errors.
- Set the default brain to `claude-sonnet-4-6`; reserve `claude-opus-4-8` for the obstacle ladder's "replan/escalate" and high-stakes email. Keep the local 7B doing triage/classification (where the real savings are, §6).
## Version Compatibility
| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| Node 24 LTS | better-sqlite3-multiple-ciphers 12.x | Native addon — confirm prebuilt binary for Node 24 / arm64 (darwin); else needs Xcode CLT to compile. |
| @anthropic-ai/sdk 0.105 | Node 24, zod 4 | SDK ≥0.60 supports current Opus/Sonnet/Haiku + streaming + tool use. |
| @modelcontextprotocol/sdk 1.29 | Node 24, Peekaboo MCP | `StdioClientTransport` spawns Peekaboo; both speak current MCP spec. |
| playwright 1.61 | Chromium (bundled), macOS 14+ | `npx playwright install chromium` pins the matching browser build. |
| whisper.cpp (master) | macOS 14+, Core ML, Metal, SDL2 | Pre-Sonoma risks transcription hallucination; build needs cmake + (for mic) sdl2. |
| Swift 6 / SwiftUI | macOS 14 min, 15 target | `MenuBarExtra` (Ventura+), `SMAppService` (Ventura+) both fine. |
| Ollama 0.13+ | qwen2.5 / llama3.1 tags | `/api/chat` + `keep_alive` stable. |
## Sources
- `anthropics/skills` model catalog (raw GitHub, live) — model IDs, tiers, context/output, deprecations — **HIGH**
- `anthropics/skills` claude-api SKILL.md — TS SDK package, streaming `.finalMessage()`, zod tool use — **HIGH**
- npm registry (`npm view`) — exact versions: @anthropic-ai/sdk 0.105.0, @modelcontextprotocol/sdk 1.29.0, playwright 1.61.0, better-sqlite3-multiple-ciphers 12.11.1, plaid 42.2.0, pino 10.3.1, zod 4.4.3 — **HIGH**
- nodejs.org / endoflife.date — Node 24 Active LTS, 22 maintenance (June 2026) — **HIGH**
- docs.ollama.com/macos + ollama.com/library/qwen2.5 — install, launch-at-login, `keep_alive`, `/api/chat` — **HIGH**
- github.com/ggml-org/whisper.cpp — Core ML build, Metal default, `whisper-stream`, macOS 14 note — **HIGH**
- peekaboo.sh + github.com/openclaw/Peekaboo + docs/permissions.md — capabilities, brew/npx install, Screen Recording/Accessibility/event-synthesizing — **HIGH**
- playwright.dev (release notes, BrowserType) — 1.61.0, `launchPersistentContext`, default-profile caveat — **HIGH** (version), **MEDIUM** (anti-bot realities, from community sources)
- Apple Developer docs — `MenuBarExtra`, `SMAppService`, `willSpeakRangeOfSpeechString` — **HIGH**
- Metal/SwiftUI particle benchmarks (Medium/GitHub, 100k @ 60fps; ForEach ~12fps) — **MEDIUM** (community-verified, multiple sources agree)
- plaid.com/docs + support.plaid.com — Sandbox free/unlimited, Trial "Personal use" 10 Production Items, Transactions read-only — **HIGH**
- Node UDS vs TCP loopback latency (nodevibe/Medium, 20–40% slower TCP) — **MEDIUM**
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->
## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
