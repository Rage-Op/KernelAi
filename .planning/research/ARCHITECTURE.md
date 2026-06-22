# Architecture Research

**Domain:** Persistent local AI orchestrator — TypeScript daemon + native SwiftUI face, pluggable brain, tool router, markdown-git memory, tiered safety gate, speech-choreographed UI (macOS, M2 Pro, 16GB)
**Researched:** 2026-06-22
**Confidence:** HIGH (architecture is pinned by the spec §1–§16; transport/choreography mechanics verified against Apple + Node docs; memory design grounded in the agentic-os reference)

> This document is opinionated by design. The KERNEL spec already made the hard
> decisions (HTTP boundary, markdown memory, tiered gate). This file resolves the
> *structural* questions the spec left implicit: exact component boundaries, the
> transports between them, the direction data flows, the IPC contract for
> speech-synced choreography, and a concrete build order mapped to P0–P4.

---

## Standard Architecture

### The keystone constraint: two process boundaries

Every decision below descends from **§2's HTTP boundary rule** and the **16GB ceiling**:

1. **The daemon never embeds a model.** Thinking happens in *other processes* reached
   over HTTP (Ollama, Claude API) or subprocess (whisper.cpp, Claude Code CLI). This is
   why TypeScript is viable despite MLX being Python-only, and why the brain is swappable
   by changing a URL.
2. **The daemon and the Face are separate processes** (Node vs Swift) on one machine,
   joined by a localhost socket. Neither can call the other's functions directly; they
   exchange messages.

So the system is **three resident processes** (daemon, Face, Ollama) plus **spawned
children** (whisper.cpp, Claude Code, Peekaboo CLI, Playwright browser). Get the
boundaries right and the rest is just wiring.

### System Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│  FACE  (Swift / SwiftUI app — launch-at-login, menubar)                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────────────────────┐ │
│  │ CloudView│  │  Stage   │  │ Widgets  │  │ Voice                      │ │
│  │ (Metal   │  │ controller│ │ events / │  │ whisper bridge (mic→text)  │ │
│  │ particles)│ │ bloom/    │ │ mail /   │  │ AVSpeechSynthesizer (TTS)  │ │
│  │          │  │ dissolve  │ │ accounts │  │ willSpeakRange → boundaries│ │
│  └────┬─────┘  └────┬─────┘  │ spending │  └─────────────┬──────────────┘ │
│       │   Stage events       │ preview  │                │ mic RMS / text │ │
│       └──────────┬───────────┴──────────┘                │                │ │
└──────────────────┼───────────────────────────────────────┼────────────────┘
                   │            WebSocket (JSON frames) over localhost         
                   │   daemon→Face: stage.present/dismiss, particle.burst,     
                   │                speak, transcript, widget.data             
                   │   Face→daemon: utterance (final STT), boundary, cancel,   
                   │                ui.intent (tap "Send it?")                 
┌──────────────────┴────────────────────────────────────────────────────────┐
│  KERNEL DAEMON  (TypeScript / Node — the orchestrator, owns the loop)        │
│                                                                              │
│   ipc/  ── WebSocket server (ws) + message codec ─────────────────────────  │
│                              │                                               │
│   loop.ts:  perceive → recall → decide → act → log                          │
│      │          │        │       │       │      │                            │
│   ┌──┴───┐  ┌────┴───┐ ┌──┴───┐ ┌─┴────┐ ┌┴─────────┐ ┌──────────────────┐  │
│   │persona│ │ memory │ │brain │ │planner│ │ safety   │ │  tool router      │  │
│   │engine │ │manager │ │provider│ │ladder │ │ gate +   │ │ register/dispatch │  │
│   │IDENTITY│ │inject/ │ │(swap) │ │retry→ │ │ circuit  │ │ wraps every call  │  │
│   │.md     │ │consol. │ │       │ │replan │ │ breaker  │ │ in the gate       │  │
│   └───────┘  └───┬────┘ └──┬───┘ └──────┘ └──────────┘ └────────┬─────────┘  │
│                  │         │                                     │            │
│   routines/ (morning-brief.yaml engine, presets)                │            │
└──────────────────┼─────────┼─────────────────────────────────────┼──────────┘
                   │         │ HTTP                                 │
        file I/O   │         │ POST /api/chat                       │ subprocess / HTTP / MCP
                   ▼         ▼                                      ▼
        ┌──────────────┐  ┌────────────────┐   ┌───────────────────────────────────┐
        │ kernel-memory│  │ OLLAMA (proc)  │   │ TOOLS (spawned / external)         │
        │  git repo    │  │ :11434         │   │ • Claude API      (HTTPS)          │
        │ markdown+YAML│  │ Qwen2.5-7B Q4  │   │ • Claude Code CLI (subprocess)     │
        │ finance/ enc.│  │ idle-unloads   │   │ • Peekaboo        (MCP + CLI)       │
        │ (gitignored) │  └────────────────┘   │ • Playwright      (headful browser)│
        └──────────────┘                       │ • whisper.cpp     (subprocess)     │
                   ▲                            │ • finance aggreg. (HTTPS OAuth)    │
        launchd ───┘ heartbeat / consolidation  │ • mail / weather  (Peekaboo/HTTPS) │
        (.plist jobs) / cleanup / backup        └───────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility (what it owns) | Transport to neighbours |
|-----------|-------------------------------|-------------------------|
| **loop.ts** | The control loop: perceive → recall → decide → act → log. Event-driven, not a busy spin. | in-process calls to all daemon modules |
| **ipc/** | WebSocket server; encode/decode JSON frames; route Face↔daemon messages; correlate request/response by `id` | WebSocket to Face |
| **persona engine** | Holds `IDENTITY.md` + voice rules; selects register (terse-to-Pravin vs outward); injected every prompt | reads memory; feeds brain prompt |
| **memory manager** | Inject at session start (priority + 16K cap); keyword retrieval; consolidate/prune jobs; quarantine path for external writes | file I/O to `kernel-memory/`; git |
| **brain provider** | `reason(prompt, context) → Decision`; swappable impls (Claude / ClaudeCode / Local); the always-on 7B helper for triage | HTTP to Claude/Ollama; subprocess to Claude Code |
| **planner** | Obstacle ladder: retry → replan → decompose → backoff → escalate-with-recommendation | in-process; drives brain + tool router |
| **safety gate** | Tier classification (🟢🟡🔴); circuit breaker on Red; quarantine enforcement; hard non-overridable rules | wraps every tool-router dispatch |
| **tool router** | Register tools by name; validate args; dispatch; surface results; every call passes through the gate | subprocess / HTTP / MCP to tools |
| **routines** | Load `morning-brief.yaml` (presets); run each step as a tiered, narrated module | drives loop + Stage events |
| **Face / CloudView** | GPU particle nebula; idle drift; mic-RMS reactive brightness/expansion | renders; reads daemon WS events |
| **Face / Stage** | Choreography controller: present/dismiss widgets in sync with TTS boundaries | driven by boundary callbacks + WS |
| **Face / Voice** | whisper bridge (mic→text), AVSpeechSynthesizer TTS, `willSpeakRange` boundary emission | subprocess (whisper); WS to daemon |
| **Ollama** | Local 7B inference as its own process; idle-unloads to free RAM | HTTP `:11434` |

---

## Recommended Project Structure

The spec's §3 layout is correct. The additions below (italic) are the structural
glue the spec implies but does not name — without them the boundaries blur.

```
kernel/
├── daemon/                       # TypeScript orchestrator (resident process)
│   ├── src/
│   │   ├── loop.ts               # perceive → recall → decide → act → log
│   │   ├── brain/
│   │   │   ├── BrainProvider.ts   # interface (§6) — built FIRST, in P0
│   │   │   ├── ClaudeBrain.ts     # Claude API (default)
│   │   │   ├── ClaudeCodeBrain.ts # Claude Code headless
│   │   │   ├── LocalBrain.ts      # Ollama HTTP
│   │   │   └── helper.ts          # always-on 7B (triage/classify/narrate)
│   │   ├── tools/
│   │   │   ├── Tool.ts            # Tool interface + ToolCall/ToolResult types
│   │   │   ├── registry.ts        # name → Tool map; dispatch
│   │   │   ├── peekaboo.ts  browser.ts  claude-code.ts
│   │   │   ├── mail.ts  weather.ts  finance.ts  local7b.ts
│   │   ├── memory/
│   │   │   ├── inject.ts          # session-start assembly (priority + 16K cap)
│   │   │   ├── retrieve.ts        # keyword retrieval + reranker
│   │   │   ├── consolidate.ts     # logs → reflections → knowledge (nightly)
│   │   │   ├── prune.ts           # cleanup stale working-memory/logs
│   │   │   └── quarantine.ts      # external-sourced writes → gated promotion
│   │   ├── safety/
│   │   │   ├── tiers.ts           # classify a ToolCall → 🟢🟡🔴
│   │   │   ├── gate.ts            # the wrapper every dispatch passes through
│   │   │   └── breaker.ts         # dry-run → 10s cancel → ceiling → audit
│   │   ├── planner/ladder.ts      # obstacle control structure (§9)
│   │   ├── routines/engine.ts     # YAML loader + step runner
│   │   ├── ipc/
│   │   │   ├── server.ts          # ws server on localhost
│   │   │   ├── protocol.ts        # *shared message-type definitions (§ IPC)*
│   │   │   └── session.ts         # *correlate id↔reply; one Face connection*
│   │   └── config/                # *settings: brain=cloud|local, ceilings*
│   ├── routines/morning-brief.yaml
│   └── package.json
├── face/                         # SwiftUI app (resident process)
│   ├── Sources/
│   │   ├── CloudView/            # Metal/SceneKit particle system (§15)
│   │   ├── Stage/                # StageController + bloom/dissolve (§15)
│   │   ├── Widgets/              # events / mail / accounts / spending / preview
│   │   ├── Voice/                # WhisperBridge + Speaker(TTS) + boundary emit
│   │   └── IPC/                  # *KernelSocket: URLSessionWebSocketTask client*
│   └── ...
├── kernel-memory/                # git repo, own remote; finance/ gitignored
│   ├── IDENTITY.md  working-memory/  knowledge/  tasks/  projects/  logs/  self/
└── launchd/                      # *.plist: heartbeat, consolidation, cleanup, backup*
```

### Structure Rationale

- **`brain/BrainProvider.ts` is the very first file with real shape (P0).** Building the
  interface before any implementation forces the swap-by-URL property and lets P0 ship a
  stub. The 7B `helper.ts` sits *beside* the providers, not inside them — it is always
  available regardless of `brain=cloud|local`, so it cannot live under one impl.
- **`ipc/protocol.ts` is a named file, not ad-hoc strings.** The choreography contract
  (below) is the most fragile interface in the system; the daemon and Face must agree on
  message shapes. Generate a matching Swift `enum` from it (or hand-mirror) so a typo is a
  compile error, not a silent dropped widget.
- **`safety/gate.ts` wraps the tool router, it is not called by tools.** Tools never decide
  their own tier. The router calls `gate.authorize(toolCall)` before every dispatch — one
  choke point, including for actions Claude Code wants to run mid-session.
- **`memory/` splits inject/retrieve from consolidate/prune.** Injection runs on the hot
  path (session start, latency-sensitive); consolidation/prune are batch jobs invoked by
  launchd. Same data, two very different schedules — keep them in separate files.

---

## Architectural Patterns

### Pattern 1: Event-driven loop with an idle daemon (not a tick spinner)

**What:** `loop.ts` is a long-lived process that *sleeps* until woken by one of three
event sources, then runs one pass of perceive → recall → decide → act → log:

- **User event** — a final STT utterance or a UI intent arrives over the WebSocket.
- **Scheduled event** — launchd fires a `.plist` (heartbeat, morning brief, consolidation).
- **Tool callback** — a long-running tool (browser, Claude Code) reports progress/completion.

**When to use:** Always, for a persistent personal daemon. A polling tick wastes CPU and
battery and fights Ollama's idle-unload (which is a 16GB feature, not a bug).

**Trade-offs:** Event-driven needs a real reactor (Node's event loop gives this for free)
and careful "one task at a time" discipline so two events don't both drive the loop
concurrently. Use a simple in-process work queue: events enqueue *intents*; a single
runner drains them serially. Idle behaviour = process resident, sockets open, zero model
loaded, near-zero CPU.

```typescript
// loop.ts — serial intent runner, woken by events
type Intent = { source: 'user' | 'schedule' | 'tool'; payload: unknown };
const queue: Intent[] = [];
let running = false;

function enqueue(i: Intent) { queue.push(i); drain(); }

async function drain() {
  if (running) return;            // one pass at a time — no concurrent loops
  running = true;
  while (queue.length) {
    const intent = queue.shift()!;
    const ctx = await memory.inject();          // recall
    const decision = await brain.reason(prompt(intent), ctx);  // decide
    if (decision.action) await router.dispatch(decision.action); // act (gated)
    await memory.log(intent, decision);          // log
  }
  running = false;                // fall idle — Ollama unloads, CPU ~0
}
```

### Pattern 2: HTTP/subprocess boundary as the swap seam

**What:** Anything that "thinks" or "acts on the world" is reached over a process
boundary, never linked in. The `BrainProvider` interface is the seam for thinking; the
`Tool` interface is the seam for acting.

**When to use:** The non-negotiable rule of this system (§2). It is *why* a Python-only
model story doesn't poison the TypeScript daemon.

**Trade-offs:** You pay serialization + a hop on every call (acceptable — these are
human-speed interactions, not a hot inner loop). You gain: swap a brain by changing a URL,
restart a crashed tool without killing the daemon, and a clean place (the boundary) to
insert the safety gate and the transparency transcript.

```typescript
interface BrainProvider { reason(prompt: string, context: string): Promise<Decision>; }
interface Decision { thought: string; action?: ToolCall; reply?: string; }

// LocalBrain — the seam is literally a URL
class LocalBrain implements BrainProvider {
  async reason(prompt: string, context: string): Promise<Decision> {
    const r = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      body: JSON.stringify({ model: 'qwen2.5:7b', messages: [
        { role: 'system', content: context }, { role: 'user', content: prompt }] }),
    });
    return parseDecision(await r.text());
  }
}
```

### Pattern 3: The gate as a mandatory middleware around dispatch

**What:** The tool router never executes a `ToolCall` directly. It calls
`gate.authorize(call)`, which classifies the tier, enforces hard rules, and (for Red)
runs the circuit breaker before returning an allow/deny. The same wrapper protects
**Claude Code's mid-session actions**: the Claude Code tool adapter intercepts the
actions Claude wants to run and re-submits each through `gate.authorize` — so a `rm -rf`
inside a coding session hits the same breaker as one KERNEL proposes itself.

**When to use:** Every dispatch, always. This is the line between "helpful" and "robbed by
a poisoned email."

**Trade-offs:** A single choke point can become a bottleneck for parallel tool calls — but
human-speed orchestration doesn't need parallel dispatch, and serializing through the gate
is exactly the safety property you want.

```typescript
async function dispatch(call: ToolCall): Promise<ToolResult> {
  const verdict = await gate.authorize(call);   // tier + hard-rules + breaker
  if (verdict.kind === 'deny')  return escalate(verdict.reason);   // → planner/Pravin
  if (verdict.kind === 'gated') await breaker.run(verdict);        // dry-run→cancel→ceiling
  return registry.get(call.tool)!.invoke(call.args);
}
```

### Pattern 4: Provenance-tagged memory writes (the quarantine seam)

**What:** Every memory write carries a `source` tag: `internal` (Pravin, KERNEL's own
reasoning) or `external` (content read from mail/web). External-sourced writes land only
in `working-memory/quarantine/` and are **never** auto-promoted to `knowledge/` or
`IDENTITY.md`. Promotion requires passing the safety gate (a Yellow-ish review), so a
poisoned email cannot rewrite the persona or durable facts.

**When to use:** Always, the moment the system can both read external content and persist
memory — which is from P1 onward (Mail/browser). The tag must be set at the *read* site,
not inferred later.

**Trade-offs:** Slight bookkeeping cost; occasionally a genuinely useful external fact sits
in quarantine until reviewed. That's the correct default for an attack surface.

---

## Data Flow

### Primary request flow (a spoken interaction, end to end)

```
Pravin speaks
   │  mic audio (Face captures)
   ▼
whisper.cpp (subprocess of Face)  ── partial/final transcript ──▶ Face.Voice
   │
   │  WS: { type: "utterance", text, final: true }
   ▼
Daemon ipc/server → enqueue(user intent)
   │
   ├─ recall:  memory.inject()  → IDENTITY + current.md + retrieved (≤16K)
   ├─ decide:  brain.reason(prompt, context) → Decision{thought, action?, reply?}
   │             (helper 7B may pre-triage / classify before the cloud call)
   ├─ act:     router.dispatch(action) → gate.authorize → tool → ToolResult
   │             (planner ladder wraps this: retry/replan/decompose/backoff/escalate)
   └─ log:     append to logs/ + working-memory/current.md  (source: internal)
   │
   │  WS: { type: "speak", text: reply, cues: [...] }  +  widget.data frames
   ▼
Face.Voice → AVSpeechSynthesizer.speak(reply)
   │
   │  willSpeakRangeOfSpeechString(range)  ── per word/segment ──┐
   ▼                                                             │
Stage controller maps range → cue → present/dismiss widget + particle burst
   │
   ▼
CloudView (Metal) blooms the frosted widget; particles pulse on mic RMS
```

### The TTS-boundary → Stage event path (the choreography contract)

This is the most novel and most fragile data path. The principle: **the daemon decides
*what* to say and *which widgets* go with *which phrases*; the Face decides *exactly when*
to fire each one, using the TTS engine's own word-boundary clock as the metronome.**

Why the Face owns timing: only the Face knows the real-time progress of speech.
`AVSpeechSynthesizerDelegate.speechSynthesizer(_:willSpeakRangeOfSpeechString:utterance:)`
fires just before each word/segment with the `NSRange` being spoken (Apple docs, HIGH
confidence). That callback is the only accurate "we are HERE in the sentence now" signal —
it accounts for the synthesizer's actual pacing, which the daemon cannot predict.

So the contract is a **`speak` frame carrying cues keyed to character offsets**:

```jsonc
// daemon → Face
{ "type": "speak",
  "id": "u-1042",
  "text": "You've got three events today, and your checking is at twelve hundred.",
  "cues": [
    { "atChar": 9,  "action": "stage.present", "widget": "events",   "data": {...} },
    { "atChar": 28, "action": "particle.burst", "intensity": 0.6 },
    { "atChar": 40, "action": "stage.dismiss",  "widget": "events" },
    { "atChar": 48, "action": "stage.present",  "widget": "accounts","data": {...} }
  ],
  "onFinish": [ { "action": "stage.dismiss", "widget": "accounts" } ] }
```

```swift
// Face: Stage fires cues when speech crosses each offset
func speechSynthesizer(_ s: AVSpeechSynthesizer,
                       willSpeakRangeOfSpeechString range: NSRange,
                       utterance: AVSpeechUtterance) {
    for cue in pendingCues where range.location >= cue.atChar {
        stage.apply(cue)            // present/dismiss/burst — eased, never snapped
        pendingCues.remove(cue)
    }
}
func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
    onFinishCues.forEach(stage.apply)   // dissolve the last widget back into the cloud
}
```

**Direction summary of the contract:**

| Frame | Direction | Carries | Fired by |
|-------|-----------|---------|----------|
| `speak` (+`cues`,`onFinish`) | daemon → Face | text + char-keyed choreography | end of `decide`/`act` |
| `widget.data` | daemon → Face | data to populate a widget before it blooms | with/just before `speak` |
| `boundary` *(optional)* | Face → daemon | progress ticks, if daemon wants to know | each `willSpeakRange` |
| `utterance` | Face → daemon | final STT text | whisper final result |
| `ui.intent` | Face → daemon | taps (e.g. "Send it?", chip clicks) | user touch |
| `cancel` | either way | abort speech / abort action (breaker 10s window) | user / gate |
| `transcript` | daemon → Face | Claude Code live transcript line (corner pill) | Claude Code adapter |

**Mic RMS** is a separate, high-frequency Face-internal signal (mic amplitude → particle
expansion/brightness). It does **not** round-trip the daemon — that would add latency to a
60fps animation. Keep it local to CloudView.

### Memory injection flow (session start) — grounded in the agentic-os reference

The agentic-os reference's reusable logic, mapped onto KERNEL's files:

| agentic-os mechanism | What it does | KERNEL equivalent |
|----------------------|--------------|-------------------|
| `CLAUDE.md` "Returning Mode" silent startup (5 steps) | Read SOUL → USER → today's daily memory → MEMORY.md scratchpad → open a session block | `memory/inject.ts`: IDENTITY.md → working-memory/current.md → retrieved knowledge/+tasks/+projects/, then open a `## Session N` block in today's log |
| `SOUL.md` / `USER.md` injected every session, never auto-edited | Persona + user profile are privileged, stable | `IDENTITY.md` injected every session, never auto-edited (§5/§10) |
| `MEMORY.md` "frozen snapshot" scratchpad (2.5K cap) | Curated Active Threads / Environment / Pending; mid-session writes take effect *next* session | `working-memory/current.md` — same frozen-snapshot discipline; rolling live context |
| Daily memory `context/memory/{date}.md` with numbered `## Session N` blocks (Goal/Deliverables/Decisions/Open threads) | Append-only per-day log of what happened | `logs/` daily files, same session-block shape; pruned aggressively |
| Silent auto-tracking (file in projects/ → Deliverables; decision → Decisions; never announce) | Memory updates without narration noise | KERNEL writes logs/current.md silently; never says "logged to memory" |
| `memory-config.json` reranker: authority weights + 14-day half-life + 0.3 floor | Rank retrieved chunks by source authority × recency | KERNEL keyword retrieval reranker — same weights idea (IDENTITY=highest authority, recent reflections decay slower) |
| Nightly consolidation / wrap-up skill | Distill raw → durable; promote facts | `memory/consolidate.ts` launchd job: logs → reflections, promote durable facts → knowledge/ |
| GitHub backup check (once/day, first session) | Warn/commit-push so memory survives | launchd backup job: commit + push to private remote; finance/ gitignored |

**The deliberate divergence from the reference:** the *current* agentic-os has migrated to
BGE-M3 embeddings on PGLite/Postgres (1024-dim vectors, HNSW). **KERNEL must NOT follow
that path** — it costs RAM the 16GB machine doesn't have (§5, Out of Scope). KERNEL takes
the reference's *markdown + session-block + frozen-scratchpad + scheduled-consolidation +
authority/recency reranker* logic and runs it over **keyword retrieval**. The reference's
own reranker config (`half_life_days: 14`, `floor_ratio: 0.3`, authority weights per
source path) is directly reusable on top of keyword candidates — it needs no embeddings.
Add embeddings only if keyword recall proves poor (and even then, prefer a tiny on-disk
index over a resident vector DB).

```
session start
   │
   ├─ 1. IDENTITY.md            (always, full)                ─┐
   ├─ 2. working-memory/current.md (always, full)             │ assemble in
   ├─ 3. keyword-retrieve from knowledge/ + tasks/ + projects/│ priority order,
   │     → rerank: authority(path) × recency(14d half-life)   │ stop at ~16K chars
   └─ 4. open `## Session N` block in logs/{date}.md          ─┘
   │
   ▼  context string (≤16K) → brain.reason(prompt, context)
```

### Obstacle planner as a control structure (§9)

The ladder is not a loop with a counter; it's a **state machine wrapped around
`router.dispatch`**, escalating through strategies and only ever stopping with a
*specific recommendation*. Red-tier gates are the one thing that skips the ladder and
escalates immediately.

```
attempt(task):
  result = dispatch(task)
  if result.ok: return result
  ── RETRY:     dispatch(task) once more (transient failures)
  ── REPLAN:    brain.reason("approach A failed because X; propose approach B")
  ── DECOMPOSE: split into temp sub-tasks; attempt(each)
  ── BACKOFF:   exponential delay, then retry the best approach
  ── if still blocked AND critical:
       ESCALATE("X blocked by Y; I recommend Z. Approve?")   ← never "I'm stuck"
  ── if any step hit a Red-tier gate:
       ESCALATE immediately (skip remaining ladder)          ← §8 overrides §9
```

```typescript
async function pursue(task: Task): Promise<Outcome> {
  for (const strategy of [retry, replan, decompose, backoff]) {
    const r = await strategy(task);
    if (r.ok) return r;
    if (r.blockedBy === 'red-gate') return escalate(r.recommendation); // skip ladder
  }
  return escalate(await brain.recommend(task)); // specific Z, not "stuck"
}
```

---

## Build Order & Dependency Graph

The spec's §16 phase order is the build order, and it is dependency-correct: each phase's
components depend only on earlier ones. The graph below makes the edges explicit.

```
P0 ── Skeleton ───────────────────────────────────────────────────────────────
   loop.ts (event runner)           ← nothing
   BrainProvider interface + StubBrain  ← nothing  (the swap seam, built first)
   memory/inject.ts + IDENTITY.md   ← kernel-memory/ repo
   ipc/server.ts (ws) minimal       ← nothing  (so the Face can attach in P2)
   launchd heartbeat → writes a log ← memory/log
      DONE WHEN: daemon persists, injects memory, heartbeat fires.

        │ (loop, brain seam, memory, ipc skeleton all exist)
        ▼
P1 ── Hands ──────────────────────────────────────────────────────────────────
   tools/Tool.ts + registry.ts      ← loop.ts
   tools/peekaboo.ts (MCP+CLI)      ← registry
   tools/browser.ts (Playwright)    ← registry
   (thin gate stub: classify only,  ← registry   ← safety/tiers.ts seed
    no override, no breaker yet)
      DONE WHEN: KERNEL opens Mail + drives a browser task end-to-end.

        │ (router + real tools exist; loop can ACT)
        ▼
P2 ── Brain + voice + the cloud ──────────────────────────────────────────────
   brain/ClaudeBrain + LocalBrain   ← BrainProvider (P0)
   brain/helper.ts (always-on 7B)   ← Ollama running
   Face: IPC/KernelSocket (WS client) ← ipc/protocol.ts
   Face: Voice (whisper bridge + TTS + willSpeakRange) ← KernelSocket
   Face: CloudView (Metal particles) ← Voice (mic RMS)
   Face: Stage controller (1 widget bloom/dissolve on speech) ← Voice boundaries
   ipc/protocol.ts: speak/cues/widget.data/utterance frames  ← both sides
      DONE WHEN: you talk to KERNEL, it reasons, the cloud reacts,
                 a widget choreographs to its speech.

        │ (full talk→reason→act→choreograph loop closed)
        ▼
P3 ── Routines + Claude Code + finance ───────────────────────────────────────
   routines/engine.ts + morning-brief.yaml + presets ← loop, Stage, brain
   email reply flow (intent→voice profile→few-shot→preview→send) ← brain, mail tool
   tools/finance.ts + encrypted gitignored store + W/M/Y charts ← registry, Widgets
   tools/claude-code.ts bridge + transparency corner-pill + projects/registry.md
        ← registry, ipc (transcript frames), CloudView (shrink-to-pill state)
      DONE WHEN: a full morning brief runs choreographed, incl. a gated
                 email send and live spending charts.

        │ ░░░ HARD STOP — gate before P4 (owner directive; money/irreversible) ░░░
        ▼
P4 ── Safety + self-maintenance ──────────────────────────────────────────────
   safety/gate.ts (full) + tiers.ts + breaker.ts + /override ← router (P1)
   memory/quarantine.ts promotion-via-gate ← gate, memory
   memory/consolidate.ts + prune.ts (launchd) ← memory
   launchd: consolidation + cleanup + backup jobs
   self/{changelog,metrics}
      DONE WHEN: Red-tier actions gated end-to-end (incl. inside Claude Code)
                 and maintenance jobs run on schedule. Autonomy now safe to enable.
```

### Why this order is forced (not arbitrary)

1. **BrainProvider interface before any brain impl (P0).** Lock the swap seam first; P0
   ships a `StubBrain` so the loop runs before Claude/Ollama exist.
2. **Tools before voice (P1 before P2).** The loop must be able to *act* (open Mail, drive
   a browser) before it's worth wiring speech in. Voice without hands is a demo, not a
   foreman.
3. **A thin tier *classifier* in P1, the full *gate + breaker* in P4.** P1–P3 only ever do
   Green/Yellow work (draft, read, preview-then-send). The dangerous capabilities
   (`/override`, Red auto-paths, money, `rm -rf`) are exactly what P4 gates — which is why
   the owner directive hard-stops there. Don't front-load the breaker; do seed `tiers.ts`
   classification early so the data shape exists.
4. **Choreography needs both the brain (to produce `speak`+cues) and the Face (to fire on
   boundaries) — so it can only land in P2**, after the WS protocol exists and the brain
   can talk.
5. **Routines compose everything (P3).** The morning brief is the integration test of the
   whole stack: brain + tools + memory + Stage choreography + a gated send.
6. **Consolidation/quarantine in P4** because they protect *long-term* memory integrity —
   the system can run for days on raw logs; the distillation + poisoning defenses matter
   once it's trusted with autonomy.

### Component → Phase map

| Component | P0 | P1 | P2 | P3 | P4 |
|-----------|----|----|----|----|----|
| loop.ts (event runner) | ● build | | | | |
| BrainProvider interface | ● build | | | | |
| StubBrain / ClaudeBrain / LocalBrain / 7B helper | stub | | ● build | | |
| memory inject + IDENTITY.md | ● build | | | | quarantine, consolidate ● |
| ipc/ WebSocket + protocol | skeleton | | ● full | transcript frames | |
| tool router + Tool iface | | ● build | | claude-code, finance + | |
| Peekaboo / Playwright tools | | ● build | | | |
| safety tiers (classify) | | seed | | | full gate + breaker ● |
| planner ladder | | (used by router) | | ● exercised | |
| routines engine + YAML | | | | ● build | |
| Face CloudView / Stage / Voice / Widgets | | | ● build | preview widget, corner-pill | |
| launchd jobs | heartbeat ● | | | | consolidation/cleanup/backup ● |

---

## Scaling Considerations

This is single-user, single-machine software. "Scale" means *staying inside 16GB and
staying responsive*, not user count.

| Pressure | At rest / idle | Active session | Worst case (brief + Claude Code + browser) |
|----------|----------------|----------------|--------------------------------------------|
| RAM | daemon ~tens of MB; Ollama unloaded; Face idle | + Ollama 7B Q4 (~5–6GB) loaded on demand | Ollama + Playwright (Chromium ~hundreds MB) + Claude Code; **serialize heavy tools**, don't run browser + local inference + Claude Code concurrently |
| Latency | n/a (idle) | cloud brain network RTT dominates; 7B helper for cheap fast turns | keep choreography on the Face (boundary clock + local mic RMS) so it never waits on the daemon |
| Memory store size | logs grow daily | injection capped at 16K chars regardless | nightly prune + consolidation keep working-memory small; keyword index stays cheap |

### What breaks first, and the fix

1. **First bottleneck — RAM contention from running everything at once.** Fix: the gate /
   router serializes heavy tools; Ollama's idle-unload is load-bearing — never pin a model
   resident. Prefer the cloud brain for hard reasoning so the 7B can stay unloaded between
   triage calls.
2. **Second — memory injection bloat** (logs leaking into context). Fix: the 16K cap is a
   hard truncation in `inject.ts` *with priority order*, plus nightly consolidation that
   moves raw logs out of the retrieval path into distilled `reflections/`/`knowledge/`.
3. **Third — choreography jank if cues round-trip the daemon.** Fix: the daemon ships all
   cues up front in the `speak` frame; the Face fires them locally off the boundary clock.
   Mic-RMS particle reactivity never leaves the Face.

---

## Anti-Patterns

### Anti-Pattern 1: Daemon-driven choreography timing

**What people do:** Have the daemon send a stream of "now show events / now hide events"
messages timed by a `setTimeout` estimate of speech duration.
**Why it's wrong:** The daemon cannot know the synthesizer's real pacing; estimates drift,
and every message adds localhost latency to a 60fps animation. Widgets bloom out of sync
with the words.
**Do this instead:** Daemon sends cues *keyed to character offsets* once, inside the
`speak` frame. The Face fires them on `willSpeakRangeOfSpeechString`, the engine's own
clock. (See the choreography contract above.)

### Anti-Pattern 2: Embedding a model or a vector DB in the daemon

**What people do:** Pull in a Node ONNX/transformers binding for embeddings, or keep a
resident vector store, "for better recall."
**Why it's wrong:** Violates the §2 HTTP boundary and burns RAM the 16GB machine doesn't
have. It also re-couples TypeScript to a Python-shaped ML stack.
**Do this instead:** Keyword retrieval + the authority/recency reranker (reused from the
agentic-os `memory-config.json`). Thinking lives behind HTTP (Ollama/Claude). Revisit
embeddings only if recall is measurably poor, and even then prefer an on-disk index.

### Anti-Pattern 3: Tools that self-classify their own safety tier

**What people do:** Let each tool declare "I'm Green" and execute itself.
**Why it's wrong:** A compromised or buggy tool can lie; and an action's tier depends on
*context* (a browser form-fill might be Yellow, but typing a card number is a hard-no
regardless of which tool does it). It also gives no single audit point.
**Do this instead:** One `gate.authorize(call)` between the router and every tool,
including a re-submission shim for actions Claude Code wants to run mid-session. Tier is
decided centrally from the call's shape + provenance, never by the tool.

### Anti-Pattern 4: Auto-promoting externally-sourced memory

**What people do:** Read a useful fact from an email and write it straight to
`knowledge/` or, worse, tweak `IDENTITY.md`.
**Why it's wrong:** That is the poisoning surface (§5). A crafted email could rewrite the
persona or plant a "fact" that later authorizes a Red action.
**Do this instead:** Tag writes with provenance at the read site; external writes go to
`working-memory/quarantine/` and only reach `knowledge/`/`IDENTITY.md` by passing the
safety gate. IDENTITY.md is never auto-edited at all.

### Anti-Pattern 5: A polling tick loop

**What people do:** `setInterval(loop, 1000)` to "check for work."
**Why it's wrong:** Wastes CPU/battery, keeps the machine warm, and can repeatedly poke
Ollama out of its idle-unload. It also invites concurrent loop passes.
**Do this instead:** Event-driven — woken by WS messages, launchd `.plist` fires, and tool
callbacks. A single serial intent runner drains a queue, then the process falls genuinely
idle.

---

## Integration Points

### External Services & Tools

| Service / Tool | Integration Pattern | Boundary | Notes / Gotchas |
|----------------|---------------------|----------|-----------------|
| Ollama (local 7B) | HTTP POST `/api/chat` on `:11434` | HTTP | Idle-unloads — feature on 16GB. Launch at login; pull model on first run. Swap brain by changing this URL. |
| Claude API | HTTPS | HTTP | Default brain; costs per call. Used for hard reasoning + high-stakes email. |
| Claude Code | headless CLI subprocess | subprocess | Authored prompts in first-person-as-Pravin (§13). Live transcript → corner pill via `transcript` frames. **Its actions re-enter the gate.** |
| Peekaboo | MCP + CLI | MCP / subprocess | GUI hands: Mail, capture, click/type, menus. |
| Playwright | headful browser, driven by daemon | subprocess/IPC | Logins, scraping, form-fill. Heavy RAM — serialize against Ollama. Never type credentials/cards (hard rule). |
| whisper.cpp | spawned binary, mic→stdout | subprocess | Lives in the **Face**, not the daemon (mic access + low latency). No native bindings. |
| Finance aggregation (Plaid-style) | read-only OAuth, HTTPS | HTTP | Read-only tokens only; never type bank creds. Data → encrypted, gitignored `kernel-memory/finance/`, excluded from backup. |
| GitHub (memory backup) | git push to private remote | subprocess (git) | Nightly; finance/ gitignored so the backup never leaks money. |
| launchd | login + timed `.plist` wakes | OS scheduler | Drives heartbeat, morning brief, consolidation, cleanup, backup. The daemon's only "tick" source. |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| Face ↔ Daemon | **WebSocket (JSON frames) on localhost** | Bidirectional voice + UI events + choreography cues + transcript. Use Node `ws` server + Swift `URLSessionWebSocketTask` client (native, no third-party dep) — HIGH confidence. WebSocket over a raw Unix socket because the Face needs *push* (server→client) for cues, which WS gives natively and a request/response HTTP API does not. |
| Daemon loop ↔ brain | in-process call → HTTP/subprocess | `BrainProvider` interface is the seam. |
| Tool router ↔ tools | in-process dispatch → subprocess/HTTP/MCP | Every call wrapped by `gate.authorize`. |
| Memory manager ↔ disk | file I/O + git | `kernel-memory/` repo; finance/ encrypted + gitignored. |
| Stage ↔ Voice (within Face) | in-process delegate callbacks | `willSpeakRangeOfSpeechString` is the choreography clock; cues arrive pre-loaded from the daemon. |
| CloudView ↔ Voice (within Face) | in-process, high-frequency | Mic RMS → particle expansion/brightness; stays local, never round-trips daemon. |

**Transport decision — why WebSocket, not bare HTTP or a Unix domain socket:**
The Face↔daemon link is *bidirectional and push-heavy* — the daemon must push `speak`,
`stage.present`, `particle.burst`, and `transcript` frames to the Face unprompted, while
the Face pushes `utterance`, `boundary`, and `ui.intent` up. A request/response HTTP API
can't push; a raw Unix-domain socket works but means hand-rolling framing. `URLSessionWebSocketTask`
(Foundation, no dependency) on the Swift side and `ws` on the Node side give bidirectional
framed JSON over localhost with the least code. Confidence: HIGH (Apple Foundation docs +
common SwiftUI+Node pattern). One persistent connection per Face instance; `ipc/session.ts`
correlates request `id`s to replies for the few req/rep cases (e.g. `widget.data` fetch).

---

## Sources

- KERNEL Master Build Prompt §1–§16 (project spec, authoritative) — `docs/KERNEL_MASTER_BUILD_PROMPT.md`
- KERNEL PROJECT.md (context, key decisions) — `.planning/PROJECT.md`
- agentic-os reference: `CLAUDE.md` (Returning Mode startup, daily-memory session blocks, silent auto-tracking, GitHub backup check), `context/memory-config.json` (authority weights + 14-day half-life reranker), `context/MEMORY.md` (frozen-snapshot scratchpad), `context/SOUL.md`/`USER.md` (privileged injected files), `docs/memory/memory-schema.md` + `scripts/setup-memory.sh` (the embeddings/PGLite path KERNEL deliberately rejects for 16GB) — `/Users/pravinmaurya/Documents/downloads/agentic-os-reference/`
- AVSpeechSynthesizerDelegate `speechSynthesizer(_:willSpeakRangeOfSpeechString:utterance:)` — per-word `NSRange` callback (HIGH): https://developer.apple.com/documentation/avfoundation/avspeechsynthesizerdelegate/1619681-speechsynthesizer and https://www.hackingwithswift.com/example-code/media/how-to-highlight-text-to-speech-words-being-read-using-avspeechsynthesizer
- AVSpeechSynthesizer overview — https://developer.apple.com/documentation/avfaudio/avspeechsynthesizer
- SwiftUI ↔ Node WebSocket via URLSessionWebSocketTask (native, bidirectional, localhost) — https://bugfender.com/blog/ios-websockets/ and https://medium.com/@ios_guru/swiftui-and-websocket-connectivity-478aa5fddfc7
- Ollama HTTP API `/api/chat` on `:11434`, idle model unload — per spec §2/§7 (HIGH; standard Ollama behaviour)

---
*Architecture research for: persistent local AI orchestrator (macOS daemon + SwiftUI face)*
*Researched: 2026-06-22*
