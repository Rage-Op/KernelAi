# Phase 1: Skeleton (spec Phase 0) - Research

**Researched:** 2026-06-22
**Domain:** Persistent local macOS AI orchestrator — walking-skeleton TypeScript/Node daemon (ESM), markdown+git memory injection, BrainProvider swap-seam, Unix-domain-socket NDJSON IPC, launchd login agent + heartbeat, provenance/quarantine seam
**Confidence:** HIGH (stack pinned and version-verified against npm June 2026; memory mechanics ported from the agentic-os reference by direct source inspection; launchd + UDS framing confirmed against official docs)

## Summary

Phase 1 is the thinnest end-to-end vertical slice of KERNEL that proves the architecture: a long-lived TypeScript/Node daemon (ESM, Node 24 LTS) that launchd relaunches at login, that injects priority-ordered markdown memory under a hard 16K-char cap at session start, runs one event-driven `perceive → recall → decide → act → log` tick through a `StubBrain` behind the `BrainProvider` interface, exposes a Unix-domain-socket NDJSON IPC endpoint the Face will later attach to, and fires a timed launchd heartbeat that appends a dated entry to an append-only event log inside the `kernel-memory/` git repo. Three security seams are laid here as data-shape decisions (not full enforcement): the `source:` provenance tag on every context item, the `working-memory/quarantine/` bucket with a no-auto-promote rule, and the `IDENTITY.md`-never-auto-edited startup hash guard.

The entire stack is **pinned** by `docs/KERNEL_MASTER_BUILD_PROMPT.md` §2 and `STACK.md`. This research does not re-litigate those choices; it makes them implementation-ready for Phase 1 and resolves the implicit structural questions (exact scaffold, injection assembly order, retrieval rerank, IPC frame shapes, plist patterns). Everything that "thinks" or "acts on the world" lives behind an HTTP or subprocess boundary — in Phase 1 the only such boundary that materializes is the `BrainProvider` seam (satisfied by an in-process `StubBrain`); the Ollama/Claude/tool boundaries are designed-for but not built.

**Primary recommendation:** Build in this dependency order — (1) monorepo + `daemon/` ESM/TS scaffold, (2) `kernel-memory/` git repo with seeded `IDENTITY.md` + directory layout + `.gitignore` for `finance/`, (3) `BrainProvider.ts` interface + `StubBrain`, (4) `memory/inject.ts` (priority assembly + 16K cap + hash guard) and `memory/retrieve.ts` (keyword + authority×recency rerank ported from the reference `memory-config.json`), (5) `ipc/server.ts` (UDS NDJSON) with the frozen frame contract, (6) `loop.ts` serial intent runner, (7) launchd login-agent + heartbeat plists loaded via `launchctl bootstrap gui/$(id -u)`. Lock IPC transport to **Unix domain socket + NDJSON** per the spec pin (see Open Questions for the one documented divergence to resolve).

## User Constraints

> No `CONTEXT.md` exists for this phase (standalone research mode). The binding constraints below are extracted from the **pinned spec** (`KERNEL_MASTER_BUILD_PROMPT.md`), `STACK.md`, `ROADMAP.md` Phase 1 success criteria, and the phase-context brief. The planner MUST honor these exactly as if they were locked CONTEXT.md decisions.

### Locked Decisions (pinned — do not explore alternatives)

- **Runtime:** Node.js 24.x LTS, ESM (`"type": "module"`). `[CITED: STACK.md]` `[VERIFIED: this machine runs v24.16.0]`
- **Language:** TypeScript **5.9.x** (pin — do NOT auto-upgrade to TS 6.x `latest`). `[CITED: STACK.md]`
- **IPC transport:** **Unix domain socket, NDJSON frames** (newline-delimited JSON), NOT localhost HTTP, NOT WebSocket. Socket path under `~/Library/Application Support/Kernel/`. `[CITED: KERNEL_MASTER_BUILD_PROMPT §2; STACK.md "IPC to the Swift face"]`
- **Logging:** `pino` → JSON lines into `kernel-memory/logs/` (these ARE the append-only raw events). `[CITED: STACK.md]`
- **Validation:** `zod` for the `Decision` shape, IPC frames, config. `[CITED: STACK.md]`
- **Memory:** Markdown + YAML front-matter in a dedicated `kernel-memory/` git repo with the spec §5 layout. Keyword retrieval only — **no embeddings** (16GB ceiling). `[CITED: KERNEL_MASTER_BUILD_PROMPT §5]`
- **Injection priority order:** `IDENTITY.md` → `working-memory/current.md` → retrieved `knowledge/`+`tasks/`+`projects/`, hard ~16K-char cap, IDENTITY never truncated. `[CITED: §5; ROADMAP success criterion 2]`
- **`IDENTITY.md` is injected every session and NEVER auto-edited** — enforced by a startup hash check no automated path can modify. `[CITED: §5/§10; PITFALLS Pitfall 2]`
- **Provenance:** every context item / memory write carries `source: user | self | external`; external-sourced content lands only in `working-memory/quarantine/` and is never auto-promoted to `knowledge/` or `IDENTITY.md`. `[CITED: §5/§8; PITFALLS Pitfall 1/2; ARCHITECTURE Pattern 4]`
- **`kernel-memory/finance/` is gitignored** (broad ignore) and excluded from backup. `[CITED: §14; PITFALLS Pitfall 3]`
- **BrainProvider interface** `reason(prompt, context) → Promise<Decision>` with `interface Decision { thought: string; action?: ToolCall; reply?: string }` — built FIRST, satisfied by `StubBrain` in Phase 1. `[CITED: §6; ARCHITECTURE Pattern 2]`
- **Scheduler:** launchd LaunchAgent (`RunAtLoad` + `KeepAlive`) for the daemon; a separate timed plist (`StartCalendarInterval`) for the heartbeat. Loaded via `launchctl bootstrap` (not deprecated `load`). `[CITED: §7/§16; VERIFIED: launchd.info, Apple BPSystemStartup]`
- **Loop:** event-driven serial intent runner woken by IPC / launchd / tool callbacks — NOT a polling `setInterval` tick. Falls genuinely idle. `[CITED: ARCHITECTURE Pattern 1/5]`
- **Process management:** launchd ONLY — do NOT add pm2/forever/nodemon to production. `[CITED: STACK.md "What NOT to Use"]`

### Claude's Discretion (recommend, don't ask)

- Exact internal module file split inside `daemon/src/` (within the spec §3 top-level layout).
- Choice between `gray-matter` and hand-rolled front-matter parsing for `tasks/`/`knowledge/` (recommend `gray-matter`).
- Keyword tokenization strategy (recommend lowercase word-set intersection with a small stopword list — see Code Examples).
- Dev supervisor for the inner loop: `tsx watch` vs `node --watch` (recommend `tsx watch` for TS-native reload in dev; launchd owns prod).
- Exact `IDENTITY.md` seed prose (a recommended seed is provided below; persona facts are owner-confirmable).

### Deferred Ideas (OUT OF SCOPE for Phase 1)

- ClaudeBrain / LocalBrain / ClaudeCodeBrain / 7B helper **implementations** (Phase 3 — only the interface + stub land here).
- Tool router, Peekaboo, Playwright, `gate.authorize` chokepoint (Phase 2).
- Voice (whisper/TTS), the Metal cloud, the Stage controller, the Face app itself (Phase 3) — Phase 1 only defines the IPC frame contract the Face *will* attach to.
- Nightly consolidation / prune / GitHub backup, the full safety gate / circuit breaker / `/override`, finance store (encrypted SQLCipher) (Phase 4 / Phase 5).
- Embeddings-based retrieval (v2 only, gated on measured keyword-recall failure).
- **The quarantine PROMOTION GATE** — Phase 1 lays only the bucket + no-auto-promote rule; the gated promotion path is Phase 5.

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| CORE-01 | TS/Node daemon runs persistently, survives sessions, relaunched at login via launchd | Standard Stack (Node 24 ESM); launchd login-agent plist (`RunAtLoad`+`KeepAlive`); loop.ts long-lived process |
| CORE-02 | Core loop perceive→recall→decide→act→log, event-driven, idle when no work | Architecture Pattern 1 (serial intent runner); loop.ts example; the StubBrain closes decide→act→log |
| CORE-03 | launchd login agent starts daemon; timed launchd job fires heartbeat writing a dated log entry | Two plists: daemon agent + `StartCalendarInterval` heartbeat job; heartbeat writes to `logs/{date}.md` |
| CORE-04 | Daemon exposes localhost IPC endpoint (UDS, NDJSON) for the Face | IPC contract section (UDS path, NDJSON framing, frame shapes); `net.createServer` line-buffer split |
| CORE-05 | All daemon activity logged to an append-only event log under the memory repo | pino → `kernel-memory/logs/{date}.md` (or `.jsonl`); session-block format ported from reference |
| MEM-01 | Memory = Markdown+YAML in `kernel-memory/` git repo with spec layout | Memory Repo Layout section; `setup-memory`-style seeding; `gray-matter` for front-matter |
| MEM-02 | `IDENTITY.md` injected at session start, never auto-edited | inject.ts priority order; startup SHA-256 hash guard; write-path guard |
| MEM-03 | Injection priority order under hard ~16K-char cap | inject.ts assembler with budget enforcer, priority order, IDENTITY never dropped |
| MEM-04 | Keyword retrieval (no embeddings) + authority×recency rerank | retrieve.ts; ported `memory-config.json` reranker (authority_weights, 14-day half-life, 0.3 floor) |
| MEM-05 | External content carries `source:` tag → `quarantine/`, never auto-promoted | Provenance/Quarantine Seam section; ContextItem shape; quarantine bucket; no-promote rule |
| MEM-06 | `finance/` gitignored, excluded from backup | `.gitignore` with broad finance patterns; startup `git ls-files` assertion (laid here) |
| BRAIN-01 | `BrainProvider` interface defined before any implementation | BrainProvider Interface section; interface + Decision + ToolCall types; StubBrain |
| PERS-01 | To Pravin: direct, terse, reporting-style; vital details only | IDENTITY.md seed (Voice Rules → To Pravin); register selection note |
| PERS-02 | Outward content register dynamic (warm email / sharp posts / formal docs) | IDENTITY.md seed (Voice Rules → Outward); register field on persona |
| PERS-03 | On vocabulary mismatch, elaborate/clarify rather than guess | IDENTITY.md seed (Behaviour → Clarify-don't-guess rule) |

## Architectural Responsibility Map

KERNEL is a multi-tier system, but Phase 1 only materializes the **Daemon/Orchestrator** tier and the **Memory/Storage** tier. The Face (Client) tier is *designed for* (the IPC contract) but not built. There is no API/CDN tier — this is single-user, single-machine software.

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Process persistence / relaunch | OS Scheduler (launchd) | Daemon | launchd owns lifecycle; daemon is a managed long-lived process. Never a userland supervisor (pm2). |
| Core loop (perceive→recall→decide→act→log) | Daemon | — | The orchestrator owns the loop; thinking is delegated over a boundary (Phase 1: StubBrain in-process). |
| Reasoning (decide) | Brain (behind boundary) | Daemon | `BrainProvider` seam; Phase 1 satisfied by in-process `StubBrain`. Real brains are HTTP/subprocess later. |
| Memory injection / retrieval | Daemon (memory manager) | Storage (git repo) | Hot path; latency-sensitive; reads markdown files from `kernel-memory/`. |
| Memory persistence | Storage (`kernel-memory/` git repo) | — | Markdown+YAML on disk; git for history; finance/ gitignored. |
| Event log (append-only) | Daemon (pino) → Storage | — | pino writes JSON lines into `logs/`; these are the raw events. |
| IPC endpoint (Face attach) | Daemon (ipc/) | Client (Face, later) | Daemon owns the UDS server; Face is a client that connects. Push is daemon→Face over the duplex socket. |
| Heartbeat | OS Scheduler (launchd) | Daemon | A timed plist wakes a job that writes a dated log line; proves the scheduled-wake path. |
| Provenance / quarantine | Daemon (memory manager) | Storage | Tag at the write/read site; external writes land in `quarantine/` dir; enforcement is code-level, not prompt-level. |
| IDENTITY integrity | Daemon (startup guard) | Storage | SHA-256 hash check at startup; write-path guard refuses automated edits. |

## Standard Stack

> All versions verified against the npm registry on 2026-06-22. Phase 1 installs a **small** subset of the full project stack — only what the skeleton needs. The full stack (Playwright, MCP SDK, plaid, sqlcipher, etc.) is deferred to later phases.

### Core (Phase 1 runtime deps)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Node.js | 24.16.0 (24.x LTS) | Daemon runtime | Active LTS June 2026; stable sockets/child_process/native `--env-file`; ESM. `[VERIFIED: this machine v24.16.0; CITED: STACK.md]` |
| `@anthropic-ai/sdk` | 0.105.0 | Brain (Claude API) SDK — types only in P1 | Pinned. Lands now so the `BrainProvider`/`Decision` shape aligns with the real SDK; **no API calls in Phase 1**. `[VERIFIED: npm registry, modified 2026-06-18; CITED: STACK.md]` |
| `pino` | 10.3.1 | Structured JSON logging → `logs/` | Fast, low-overhead append-only event log; the raw events consolidation will later distill. `[VERIFIED: npm registry; CITED: STACK.md]` |
| `zod` | 4.4.3 | Schema validation (Decision, IPC frames, config) | Validate the brain JSON shape + IPC messages + config. `[VERIFIED: npm registry, latest=4.4.3; CITED: STACK.md]` |
| `gray-matter` | 4.0.3 | Markdown + YAML front-matter split | Cleanly separates front-matter (status/priority/source) from body for `tasks/`/`knowledge/`. `[VERIFIED: npm registry; CITED: STACK.md]` |
| `yaml` | 2.9.0 | YAML parsing (front-matter / future routine YAML) | Better TS types + comment preservation than `js-yaml`. `[VERIFIED: npm registry; CITED: STACK.md]` |

### Supporting (Phase 1 dev deps)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `typescript` | **5.9.3** (pin 5.9.x — NOT 6.x) | Daemon language / `tsc` build | Pinned to 5.9.x; TS 6.0.3 is `latest` but the project pins 5.9. `[VERIFIED: npm registry — 5.9.3 is latest in the 5.9 line; latest tag = 6.0.3]` |
| `tsx` | 4.22.4 | Run/reload TS in dev | `tsx watch daemon/src/loop.ts` for dev. launchd runs compiled JS (or `tsx`) in prod. `[VERIFIED: npm registry]` |
| `@types/node` | **24.x** (e.g. 24.13.2) — NOT 26.x | Node typings | Match the Node 24 runtime; `@types/node` latest is 26.0.0 but pin to 24 line. `[VERIFIED: npm registry — 24.13.2 exists in 24 line]` |
| `pino-pretty` | 13.1.3 | Pretty dev logs (dev only) | Human-readable logs in the dev terminal; never in the launchd-run prod path. `[VERIFIED: npm registry]` |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| UDS + NDJSON | localhost WebSocket | ARCHITECTURE.md proposes WS for native server-push. But the spec §2 + STACK.md pin UDS; a raw duplex socket already supports server→client push (see Open Questions). Honor the pin. |
| `tsx watch` (dev) | `node --watch` (Node 24 native) | `node --watch` works for compiled JS; `tsx watch` reloads `.ts` directly. Either fine; `tsx` is the STACK.md pick. |
| `gray-matter` | hand-rolled `---` split | gray-matter handles edge cases (BOM, CRLF, excerpts). Prefer the library. |
| pino file transport | manual `fs.appendFile` | pino's transport gives structured, low-overhead, rotation-friendly output. Use pino. |

**Installation (Phase 1 only):**
```bash
fnm use 24                       # or nvm; .nvmrc = "24"
npm init -y                      # then set "type":"module" in package.json
npm install @anthropic-ai/sdk@0.105.0 pino@10.3.1 zod@4.4.3 gray-matter@4.0.3 yaml@2.9.0
npm install -D typescript@5.9.3 tsx@4.22.4 @types/node@24 pino-pretty@13.1.3
```

## Package Legitimacy Audit

> slopcheck could not be installed in this environment (`pip install slopcheck` failed; no pipx). Per the legitimacy protocol's graceful-degradation rule, every package below is tagged `[ASSUMED]` and the planner SHOULD gate any first-time install behind a `checkpoint:human-verify` task. **Mitigating facts:** all six are canonical, multi-year, very-high-download packages identified from authoritative STACK.md research (which verified them against the npm registry), all resolve to well-known source repositories, and none declares a `postinstall` script (verified via `npm view scripts.postinstall` — all empty). Risk is LOW despite the `[ASSUMED]` tag.

| Package | Registry | Age (modified) | Source Repo | postinstall | slopcheck | Disposition |
|---------|----------|----------------|-------------|-------------|-----------|-------------|
| `@anthropic-ai/sdk` | npm | active (2026-06-18) | github.com/anthropics/anthropic-sdk-typescript | none | unavailable | Approved `[ASSUMED]` — official Anthropic SDK |
| `pino` | npm | active (2026-02-09) | github.com/pinojs/pino | none | unavailable | Approved `[ASSUMED]` — canonical Node logger |
| `zod` | npm | active (2026-05-04) | github.com/colinhacks/zod | none | unavailable | Approved `[ASSUMED]` — canonical validator |
| `gray-matter` | npm | stable (2023-07-12) | github.com/jonschlinkert/gray-matter | none | unavailable | Approved `[ASSUMED]` — ubiquitous front-matter parser |
| `yaml` | npm | active (2026-05-11) | github.com/eemeli/yaml | none | unavailable | Approved `[ASSUMED]` — canonical YAML lib |
| `typescript` | npm | active (2026-06-18) | github.com/microsoft/TypeScript | none | unavailable | Approved `[ASSUMED]` — pin 5.9.3 |
| `tsx` | npm | active (2026-05-31) | github.com/privatenumber/tsx | check at install | unavailable | Approved `[ASSUMED]` — dev-only; verify at install |
| `@types/node` | npm | active | DefinitelyTyped | none | unavailable | Approved `[ASSUMED]` — pin 24.x |
| `pino-pretty` | npm | active (2025-12-01) | github.com/pinojs/pino-pretty | none | unavailable | Approved `[ASSUMED]` — dev-only |

**Packages removed due to slopcheck [SLOP] verdict:** none (slopcheck unavailable)
**Packages flagged as suspicious [SUS]:** none

## Architecture Patterns

### System Architecture Diagram

The Phase 1 slice (solid boxes are built in P1; dashed are designed-for but built later):

```
   launchd (OS scheduler)
   ├─ com.kernel.daemon.plist     RunAtLoad + KeepAlive ──┐ starts/keeps alive
   └─ com.kernel.heartbeat.plist  StartCalendarInterval ──┼── wakes heartbeat
                                                          │   (node entry --heartbeat)
                                                          ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │  KERNEL DAEMON  (Node 24 / TS ESM — long-lived, idle when no work)     │
   │                                                                        │
   │  entry/index.ts                                                        │
   │    ├─ startup: IDENTITY hash guard ─┐ (verify SHA-256, fail loud)      │
   │    │           git ls-files finance ┘ (assert empty)                   │
   │    │                                                                   │
   │  ipc/server.ts  ── UDS @ ~/Library/Application Support/Kernel/         │
   │     (net.createServer, NDJSON line framing) ──── frames ────► (Face)╌╌╌┤
   │           │ enqueue(user intent)                            ◄──── push │
   │           ▼                                                            │
   │  loop.ts  serial intent runner (queue + drain, one pass at a time)     │
   │    perceive ─► recall ─────► decide ─────► act ─────► log              │
   │       │          │              │            │          │             │
   │       │     memory/inject.ts  brain/        (no real    pino ─► logs/  │
   │       │     (IDENTITY →        StubBrain     tools yet;  {date}.md      │
   │       │      current.md →      reason()      reply only) + ## Session N │
   │       │      retrieve, ≤16K)   →Decision                                │
   │       │          │                                                     │
   │       │     memory/retrieve.ts (keyword + authority×recency rerank)    │
   └───────┼──────────┼─────────────────────────────────────────────────────┘
           │          │ file I/O (read markdown / append log)
           │          ▼
   ┌───────┴──────────────────────────────────────────────────────────────┐
   │  kernel-memory/  (git repo, own remote later)                          │
   │   IDENTITY.md  working-memory/{current.md, quarantine/, reflections/}  │
   │   knowledge/  tasks/  projects/{registry.md}  logs/{date}.md  self/    │
   │   .gitignore → finance/  **/finance/**  (gitignored from day one)      │
   │  ╌╌ finance/ (does NOT exist in P1; ignore rule pre-seeded)            │
   └────────────────────────────────────────────────────────────────────────┘
        ╌╌ brain/{ClaudeBrain,LocalBrain,ClaudeCodeBrain,helper}.ts (P3)
        ╌╌ tools/, safety/, planner/, routines/ (P2–P4)
```

Trace the primary use case: a frame arrives on the UDS socket → `ipc/server.ts` decodes a complete NDJSON line → enqueues a `user` intent → `loop.drain()` runs one pass: `inject()` assembles context (IDENTITY first, never dropped, ≤16K) → `StubBrain.reason()` returns a `Decision` → no tool to dispatch in P1, so the `reply` is the output → `log()` appends a session-block entry to `logs/{date}.md` → daemon falls idle. Separately, launchd's heartbeat plist independently wakes a short-lived `node entry --heartbeat` that appends a dated heartbeat line to the same log.

### Recommended Project Structure (Phase 1 scope)

```
kernel/                              # monorepo root (git)
├── .nvmrc                           # "24"
├── daemon/                          # TypeScript orchestrator
│   ├── package.json                 # "type":"module", scripts: build/dev/start/heartbeat
│   ├── tsconfig.json                # NodeNext, ES2023+, strict, outDir dist/
│   ├── .env.example                 # ANTHROPIC_API_KEY (unused in P1), KERNEL_MEMORY_DIR
│   └── src/
│       ├── index.ts                 # entry: parse --heartbeat flag; startup guards; start ipc+loop
│       ├── config.ts                # zod-validated config (paths, socket path, cap)
│       ├── loop.ts                  # event-driven serial intent runner
│       ├── brain/
│       │   ├── BrainProvider.ts     # interface + Decision + ToolCall types  ← built FIRST
│       │   └── StubBrain.ts         # deterministic stub satisfying BrainProvider
│       ├── memory/
│       │   ├── types.ts             # ContextItem (source tag), MemoryRecord, front-matter shapes
│       │   ├── inject.ts            # priority assembly + 16K cap + IDENTITY hash guard
│       │   ├── retrieve.ts          # keyword candidates + authority×recency rerank
│       │   ├── identity.ts          # hash guard + write-path guard for IDENTITY.md
│       │   ├── quarantine.ts        # external-write landing (bucket + no-promote)
│       │   └── log.ts               # append session-block / heartbeat to logs/{date}.md
│       └── ipc/
│           ├── protocol.ts          # frame type definitions (zod) — the frozen contract
│           └── server.ts            # net.createServer UDS + NDJSON line framing
├── kernel-memory/                   # the memory git repo (own remote later)
│   ├── .gitignore                   # finance/ + **/finance/** + sidecars
│   ├── IDENTITY.md                  # seeded persona+voice (never auto-edited)
│   ├── working-memory/
│   │   ├── current.md               # rolling live scratchpad (frozen-snapshot discipline)
│   │   ├── quarantine/.gitkeep      # external-sourced writes land here
│   │   └── reflections/.gitkeep     # (consolidation writes here — P5)
│   ├── knowledge/.gitkeep
│   ├── tasks/.gitkeep
│   ├── projects/registry.md
│   ├── logs/.gitkeep                # logs/{date}.md append-only event log
│   └── self/{changelog.md,metrics.md}
└── launchd/
    ├── com.kernel.daemon.plist      # RunAtLoad + KeepAlive
    └── com.kernel.heartbeat.plist   # StartCalendarInterval
```

Rationale (from ARCHITECTURE.md "Structure Rationale," scoped to P1):
- `brain/BrainProvider.ts` is the first file with real shape — locks the swap-by-boundary property before any impl. `StubBrain` lives beside it.
- `ipc/protocol.ts` is a **named, typed file**, not ad-hoc strings — it is the most fragile cross-process interface and must be authored as the source of truth the Swift Face will mirror.
- `memory/` splits hot-path `inject`/`retrieve` from the (future) batch `consolidate`/`prune` — different schedules, different files.
- `kernel-memory/` is a **separate git repo** from the code monorepo (it has its own remote and backup lifecycle); in P1 it can be a subdirectory git repo or a sibling — recommend a sibling/nested repo with its own `.git` so the finance ignore + future backup never touch code history.

### Pattern 1: Event-driven serial intent runner (the loop)

**What:** `loop.ts` is a long-lived process that sleeps until woken by IPC frames, launchd wakes, or (later) tool callbacks, then drains a queue one intent at a time.
**When to use:** Always for this daemon — a polling tick wastes battery and (later) fights Ollama idle-unload.
**Example:**
```typescript
// Source: ARCHITECTURE.md Pattern 1 (adapted for Phase 1 StubBrain) [CITED: ARCHITECTURE.md]
type Intent = { source: 'user' | 'schedule' | 'tool'; payload: unknown };
const queue: Intent[] = [];
let running = false;

export function enqueue(i: Intent) { queue.push(i); void drain(); }

async function drain() {
  if (running) return;                 // one pass at a time — no concurrent loops
  running = true;
  try {
    while (queue.length) {
      const intent = queue.shift()!;
      const ctx = await inject();                         // recall (≤16K, IDENTITY first)
      const decision = await brain.reason(promptFor(intent), ctx); // decide (StubBrain)
      if (decision.action) { /* P2+: router.dispatch(decision.action) */ }  // act
      await log(intent, decision);                        // log (append session block)
    }
  } finally {
    running = false;                   // fall genuinely idle
  }
}
```

### Pattern 2: HTTP/subprocess boundary as the swap seam (Phase 1: only the interface)

**What:** Anything that thinks is reached over a boundary via `BrainProvider`. In Phase 1 the boundary is satisfied in-process by `StubBrain`; the shape is identical to what `ClaudeBrain`/`LocalBrain` will fill later.
**When to use:** The non-negotiable §2 rule. Build the interface first.
**Example:** see BrainProvider Interface section below.

### Pattern 3: Provenance-tagged context items (the quarantine seam)

**What:** Every context item and memory write carries `source: 'user' | 'self' | 'external'`. External writes land only in `working-memory/quarantine/` and are never auto-promoted.
**When to use:** From day one — the data model that makes the Phase 5 promotion gate possible must exist now, or retrofitting taint is a rewrite (PITFALLS Pitfall 1/2).
**Example:** see Provenance/Quarantine Seam section.

### Pattern 4: Priority injection under a hard budget (never drop IDENTITY)

**What:** `inject()` assembles context in fixed priority order and truncates *only* the lowest-priority retrieved items when the 16K cap is hit; IDENTITY.md and current.md are never truncated.
**When to use:** Every session start. Enforce the order in code, measure char count before assembling (PITFALLS Pitfall 14).

### Anti-Patterns to Avoid

- **Polling tick loop (`setInterval(loop, 1000)`):** wastes CPU/battery, invites concurrent passes. Use the event-driven runner. `[CITED: ARCHITECTURE Anti-Pattern 5]`
- **Auto-promoting external-sourced memory:** the poisoning surface. External writes → `quarantine/` only; IDENTITY never auto-edited. `[CITED: ARCHITECTURE Anti-Pattern 4]`
- **Daemon-side framing on raw socket without a line buffer:** TCP/UDS is a byte stream — a single `data` event may contain a partial line or multiple lines. Always buffer and split on `\n`. `[VERIFIED: nodejs.org net docs; JSON streaming framing]`
- **Hardcoding the loop's reply in the daemon instead of through the BrainProvider:** even the stub must go through `reason()` so the seam is real.
- **Granting Accessibility/TCC to the shared `node` binary** (relevant when launchd runs node): run the daemon through a dedicated signed launcher identity later; for P1 dev this is a no-op but note it for Phase 2. `[CITED: PITFALLS Pitfall 9]`
- **`launchctl load` (deprecated):** use `launchctl bootstrap gui/$(id -u) <plist>`. `[VERIFIED: launchd.info]`
- **pm2/forever/nodemon in prod:** launchd already supervises. `[CITED: STACK.md]`

## Memory Repo Layout & Mechanics (ported from agentic-os reference)

> The agentic-os reference's *current* runtime uses BGE-M3 embeddings on PGLite/Postgres (`docs/memory/memory-schema.md`). **KERNEL deliberately rejects that path** (16GB ceiling). What KERNEL ports is the reference's *earlier* markdown discipline: the `CLAUDE.md` "Returning Mode" 5-step silent startup, daily `## Session N` blocks, the `MEMORY.md` frozen-snapshot scratchpad, and the `memory-config.json` authority×recency reranker — all of which run over **keyword retrieval** with no embeddings. `[VERIFIED: direct inspection of agentic-os-reference]`

### Directory layout (spec §5, seeded in P1)

```
kernel-memory/
├── IDENTITY.md              # persona + voice rules. Injected EVERY session. Never auto-edited.
├── working-memory/
│   ├── current.md           # rolling live context (frozen-snapshot discipline; ~2.5K char cap recommended)
│   ├── quarantine/          # external-sourced writes land here (never auto-promoted)
│   └── reflections/         # daily distillations (consolidation writes — empty in P1)
├── knowledge/               # long-term distilled facts (empty in P1)
├── tasks/                   # one file/task: YAML front-matter (status/priority/due/source) + body
├── projects/
│   └── registry.md          # every Claude Code project (empty header in P1)
├── logs/                    # logs/{YYYY-MM-DD}.md append-only; pruned aggressively later
├── self/
│   ├── changelog.md
│   └── metrics.md
└── .gitignore               # finance/ (see Provenance/Finance section)
```

### Session-start injection assembly (the Returning-Mode mapping)

The reference's silent 5-step startup maps onto KERNEL's `inject.ts` (`[CITED: ARCHITECTURE.md "Memory injection flow"]`):

| Reference step (CLAUDE.md Returning Mode) | KERNEL equivalent (inject.ts) |
|-------------------------------------------|-------------------------------|
| 1. Read SOUL.md (persona, never auto-edited) | Read `IDENTITY.md` (full, always, priority 1) — **first verify its SHA-256 hash** |
| 2. Read USER.md (user profile) | (folded into IDENTITY.md for KERNEL — single owner) |
| 3. Read today's daily memory `{date}.md` | Read `working-memory/current.md` (full, always, priority 2) |
| 4. Read MEMORY.md frozen scratchpad (2.5K cap) | (current.md IS the frozen scratchpad — same discipline) |
| 5. Open/append `## Session N` block in today's file | Open a `## Session N` block in `logs/{date}.md` |
| (on demand) retrieve relevant knowledge | Keyword-retrieve from `knowledge/`+`tasks/`+`projects/`, rerank, fill remaining budget (priority 3) |

**Assembly algorithm (enforce in code):**
1. Read `IDENTITY.md`; verify hash; prepend (NEVER truncated).
2. Append `working-memory/current.md` (NEVER truncated).
3. Compute remaining budget = `16384 - len(identity) - len(current)`.
4. Keyword-retrieve candidates from `knowledge/`+`tasks/`+`projects/`; rerank by authority×recency; greedily add top items until the remaining budget is exhausted (skip items that would overflow).
5. Open/append a `## Session N` block in `logs/{date}.md`.
6. If `len(identity) + len(current) > 16384`, that is a fail-loud condition (IDENTITY+current must always fit) — surface a metric/warning, never silently drop IDENTITY. `[CITED: PITFALLS Pitfall 14]`

### Keyword retrieval + authority×recency rerank (ported reranker)

The reference's `context/memory-config.json` reranker is directly reusable on top of keyword candidates — **it needs no embeddings**:

```jsonc
// Source: agentic-os-reference/context/memory-config.json [VERIFIED: direct inspection]
{
  "reranker": {
    "half_life_days": 14,
    "floor_ratio": 0.3,        // recency multiplier never drops below 0.3
    "recency_floor": 0.7,
    "authority_weights": {     // KERNEL-adapted paths:
      "IDENTITY.md": 2.0,      // highest authority (but injected unconditionally, not retrieved)
      "knowledge/": 1.5,       // distilled durable facts
      "working-memory/current.md": 1.0,
      "tasks/": 1.0,
      "projects/": 0.8,
      "logs/": 0.5,
      "working-memory/quarantine/": 0.0   // NEVER surfaced into privileged context
    }
  }
}
```

**Score formula (recommended):**
```
keyword_score = |query_terms ∩ doc_terms| / |query_terms|         (Jaccard-ish overlap)
recency_mult  = max(floor_ratio, 0.5 ** (age_days / half_life_days))
authority     = authority_weights[longest matching path prefix]
final_score   = keyword_score * recency_mult * authority
```
Sort descending; take top-N that fit the budget. Quarantine items have authority 0.0 → never enter privileged context (the code-level enforcement of MEM-05, not a prompt instruction).

## Provenance / Quarantine Seam (MEM-05) + Finance gitignore (MEM-06)

### The `source:` tag shape

Every context item and every memory record carries provenance set **at the read/write site**, never inferred later (PITFALLS Pitfall 1):

```typescript
// daemon/src/memory/types.ts
export type Provenance = 'user' | 'self' | 'external';
//   user     = Pravin said/typed it
//   self     = KERNEL's own reasoning/decisions
//   external = read from mail/web/calendar (UNTRUSTED)

export interface ContextItem {
  text: string;
  source: Provenance;        // <-- the taint tag, carried into brain context
  origin?: string;           // e.g. "email:2026-06-22 from x@y.com" for external
  path?: string;             // source file path (for authority weighting)
}

// In tasks/knowledge front-matter (YAML):
//   ---
//   status: open
//   priority: 2
//   source: user            # <-- same tag persisted on disk
//   ---
```

### The quarantine bucket + no-auto-promote rule (Phase 1 scope)

- **Bucket:** `working-memory/quarantine/` exists from P1 (created + `.gitkeep`).
- **Landing rule:** any write whose `source === 'external'` goes ONLY to `quarantine/`. A `quarantine.ts` helper is the single write path for external content. `[CITED: ARCHITECTURE Pattern 4]`
- **No-promote rule:** there is **no code path** in Phase 1 that copies a `quarantine/` file into `knowledge/` or `IDENTITY.md`. The retrieval reranker gives `quarantine/` authority 0.0 so it is never injected into privileged context. The *promotion gate* (the reviewed path) is Phase 5 — Phase 1 deliberately ships the bucket with no promoter so Phase 5 only adds the gate. `[CITED: ROADMAP P5; PITFALLS Pitfall 2]`
- **Minimal-but-correct:** Phase 1 has no email/web reader yet (that is Phase 2), so no external content is actually produced. The seam is laid so that when Phase 2 hands ship, there is already a typed `source` field and a quarantine landing zone — retrofitting after P3 would be a rewrite.

### IDENTITY.md integrity (MEM-02)

```typescript
// daemon/src/memory/identity.ts — startup guard
// 1. On first install, record SHA-256 of IDENTITY.md to a stored baseline
//    (e.g. self/identity.hash, or a value the human commits).
// 2. At every startup, recompute SHA-256(IDENTITY.md). If it differs from the
//    baseline AND the change was not human-authored, FAIL LOUD (refuse to inject /
//    log a critical alert). [CITED: PITFALLS Pitfall 2 warning sign]
// 3. There is NO write path in the daemon that edits IDENTITY.md. The write-path
//    guard: memory writers reject any target === IDENTITY.md path.
```
The baseline-vs-current comparison must distinguish "human edited it (re-baseline on explicit human action)" from "an automated job changed it (alarm)." For P1, the simplest correct form: store the hash; assert match at startup; the only sanctioned way to change IDENTITY.md is a human edit followed by a human re-baseline command — no automated job ever writes the file.

### Finance gitignore (MEM-06) — laid in P1

```gitignore
# kernel-memory/.gitignore  — finance is NEVER backed up (spec §14)
finance/
**/finance/**
# SQLCipher sidecars (the store itself lands in P4, but pre-ignore the patterns):
*.db-wal
*.db-shm
*.db-journal
finance/*.db
```
Plus a **startup `git ls-files | grep -i finance` assertion** that fails loud if anything finance-pathed is ever tracked (the cheap fourth layer of the §14 defense-in-depth, laid early). In P1 `finance/` does not exist yet — the ignore rule and assertion are pre-seeded so the directory can never be accidentally committed when P4 creates it. `[CITED: PITFALLS Pitfall 3; FIN-04]`

## BrainProvider Interface + StubBrain (BRAIN-01)

```typescript
// daemon/src/brain/BrainProvider.ts — built FIRST [CITED: spec §6; ARCHITECTURE Pattern 2]
export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface Decision {
  thought: string;     // the brain's reasoning (logged, not spoken)
  action?: ToolCall;   // a tool to dispatch (no tools exist in P1 → usually undefined)
  reply?: string;      // text to surface to Pravin
}

export interface BrainContext {
  identity: string;            // IDENTITY.md (always present)
  current: string;             // working-memory/current.md
  retrieved: ContextItem[];    // reranked items, each carrying a `source` tag
  // Designed so the privileged brain can see provenance and treat external items as data.
}

export interface BrainProvider {
  // The spec signature is reason(prompt, context); `context` here is the assembled
  // string OR the structured BrainContext — recommend passing the assembled string
  // for the spec-literal signature, with the structured form available for future
  // dual-LLM splitting (PITFALLS Pitfall 1).
  reason(prompt: string, context: string): Promise<Decision>;
}
```

```typescript
// daemon/src/brain/StubBrain.ts — deterministic, no network, satisfies the interface
import type { BrainProvider, Decision } from './BrainProvider.js';

export class StubBrain implements BrainProvider {
  async reason(prompt: string, _context: string): Promise<Decision> {
    return {
      thought: `stub considered: ${prompt.slice(0, 80)}`,
      reply: `KERNEL skeleton online. (StubBrain echo) You said: ${prompt}`,
      // no action — no tools exist in Phase 1
    };
  }
}
```

**Design-for-later:** `ClaudeBrain` will use `@anthropic-ai/sdk` Messages API with a manual tool loop (so the safety gate sits between decide and act — PITFALLS Pitfall 6); `LocalBrain` will POST `http://localhost:11434/api/chat`. Both drop in by satisfying the same interface. The `Decision` shape is validated with a zod schema so any future brain's JSON output is checked. Validate with `zod` even for the stub so the contract is enforced from day one. `[CITED: STACK.md §9]`

## Unix-Domain-Socket NDJSON IPC Contract (CORE-04)

### Transport (locked: UDS + NDJSON)

- **Socket path:** `~/Library/Application Support/Kernel/kernel.sock` (create the directory; unlink a stale socket file before `listen`). `[CITED: STACK.md]`
- **Server:** Node `net.createServer((conn) => { ... })`; one persistent Face connection. `[VERIFIED: nodejs.org net docs]`
- **Framing:** newline-delimited JSON. Each frame is one `JSON.stringify(obj) + '\n'`. The reader MUST buffer bytes and split on `\n`, carrying a partial trailing line across `data` events (a `data` event can contain 0..n complete lines plus a partial). `[VERIFIED: JSON streaming framing — newline delimiter; partial-line carryover]`
- **Bidirectional push:** a raw duplex socket natively supports server→client push — the daemon simply `conn.write(frame)` at any time, unprompted. This is why a WebSocket is **not** required to push `speak`/`stage` frames (see Open Questions for the documented divergence from ARCHITECTURE.md).
- **Permissions:** the socket file is filesystem-permission scoped (not exposed on any TCP port) — chmod `0600`-equivalent via directory placement under the user's Application Support.

### Frame shapes (the frozen contract `ipc/protocol.ts` — Phase 1 defines the envelope + the P1-relevant frames; P2/P3 add `speak`/`cues`/`widget.data`)

```typescript
// daemon/src/ipc/protocol.ts — validated with zod; the Swift Face mirrors these.
// Phase 1 implements: hello/ready, utterance(in), reply(out), ping/pong, error.
// Phase 2/3 ADD (designed here so the contract is stable): speak{cues,onFinish},
// widget.data, boundary, transcript, ui.intent, cancel.

type Envelope = { type: string; id?: string };       // every frame has a type; id correlates req/rep

// Face → daemon
type Hello     = { type: 'hello'; client: 'face'; version: string };
type Utterance = { type: 'utterance'; id: string; text: string; final: boolean };  // final STT (P3) / typed input (P1 dev)
type Ping      = { type: 'ping'; id: string };
type UiIntent  = { type: 'ui.intent'; id: string; intent: string; payload?: unknown }; // P3+

// daemon → Face
type Ready     = { type: 'ready'; daemon: string; version: string };               // sent on connect
type Reply     = { type: 'reply'; id: string; text: string };                      // StubBrain reply (P1)
type Pong      = { type: 'pong'; id: string };
type Speak     = { type: 'speak'; id: string; text: string;                        // P3: choreography
                   cues: { atChar: number; action: string; widget?: string; data?: unknown }[];
                   onFinish?: { action: string; widget?: string }[] };
type WidgetData= { type: 'widget.data'; widget: string; data: unknown };           // P3
type ErrorFrame= { type: 'error'; id?: string; message: string };
```

**Phase 1 acceptance:** the daemon listens on the UDS, sends `ready` on connect, accepts a `utterance`/`ping` frame, runs it through the loop, and pushes a `reply`/`pong` — proving the Face *can attach without a daemon restart* (ROADMAP success criterion 5). A tiny test client (`nc -U` won't speak NDJSON cleanly; use a small Node script) verifies attach/detach/re-attach.

## launchd Plist Patterns (CORE-01, CORE-03)

### Daemon login agent — `~/Library/LaunchAgents/com.kernel.daemon.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.kernel.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/USERNAME/.local/bin/node</string>   <!-- ABSOLUTE path — launchd has minimal PATH -->
    <string>/ABSOLUTE/PATH/kernel/daemon/dist/index.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>                            <!-- restart on crash: "never clocks out" -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin</string>  <!-- explicit; do NOT assume shell profile -->
    <key>KERNEL_MEMORY_DIR</key><string>/ABSOLUTE/PATH/kernel/kernel-memory</string>
  </dict>
  <key>StandardOutPath</key><string>/ABSOLUTE/PATH/kernel/kernel-memory/logs/daemon.out.log</string>
  <key>StandardErrorPath</key><string>/ABSOLUTE/PATH/kernel/kernel-memory/logs/daemon.err.log</string>
</dict></plist>
```

### Heartbeat timed job — `~/Library/LaunchAgents/com.kernel.heartbeat.plist`

```xml
<plist version="1.0"><dict>
  <key>Label</key><string>com.kernel.heartbeat</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/USERNAME/.local/bin/node</string>
    <string>/ABSOLUTE/PATH/kernel/daemon/dist/index.js</string>
    <string>--heartbeat</string>                          <!-- short-lived: write a dated log line, exit -->
  </array>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Minute</key><integer>0</integer></dict>     <!-- e.g. top of every hour; pick a cadence -->
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>KERNEL_MEMORY_DIR</key><string>/ABSOLUTE/PATH/kernel/kernel-memory</string></dict>
  <key>StandardErrorPath</key><string>/ABSOLUTE/PATH/kernel/kernel-memory/logs/heartbeat.err.log</string>
</dict></plist>
```

### Loading (modern, not deprecated `load`)

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.kernel.daemon.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.kernel.heartbeat.plist
# kickstart for immediate test of the heartbeat:
launchctl kickstart -k gui/$(id -u)/com.kernel.heartbeat
# unload:
launchctl bootout gui/$(id -u)/com.kernel.daemon
```

**Gotchas (PITFALLS Pitfall 10):** `[CITED: PITFALLS.md; VERIFIED: launchd.info, Apple BPSystemStartup]`
- launchd runs with a **minimal environment** — `node` won't be on PATH unless you use an absolute path in `ProgramArguments` and set an explicit `EnvironmentVariables.PATH`.
- `bootstrap`/`bootout` require the target domain stated explicitly (`gui/$(id -u)`); the deprecated `load`/`unload` inferred it.
- `StartCalendarInterval` runs the job at the next wake if the Mac was asleep at the scheduled time.
- Test the daemon under launchd, not just from the terminal — "works from terminal, fails under launchd" is the classic env/PATH bug.
- Code-signing/TCC permanence is a Phase 2 concern (the Face app + Peekaboo perms); P1's node daemon needs no TCC grants for the skeleton.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Markdown + YAML front-matter parsing | Manual `---` splitting | `gray-matter` | Handles BOM/CRLF/excerpt edge cases; clean body/data split |
| Structured logging / append-only events | `fs.appendFile` + manual JSON | `pino` (+ file transport) | Low-overhead, structured, the raw events consolidation will distill |
| Schema validation of brain JSON / IPC frames | Hand-written type guards | `zod` | One source of truth; runtime validation of untrusted JSON shapes |
| Process supervision / relaunch | pm2 / forever / custom respawn | launchd `KeepAlive` | OS-native, pinned scheduler; pm2 duplicates it |
| NDJSON line framing | Ad-hoc string scanning | A small buffered split-on-`\n` reader (a few lines) OR `ndjson`-style helper | Partial-line carryover is the one subtle bug — keep the reader tiny and tested |
| YAML parsing | `js-yaml` | `yaml` | Better TS types + comment preservation for future editable routines |

**Key insight:** Phase 1's only genuinely subtle hand-rolled component is the **NDJSON line buffer** (partial frames across `data` events). Everything else is a thin call into a pinned library. Keep the socket reader small, deterministic, and unit-tested.

## Runtime State Inventory

> This is a **greenfield** phase — KERNEL has no prior runtime state, no existing daemon, no installed package, no datastore, no registered launchd jobs. The Runtime State Inventory categories are answered as "nothing yet," but each is noted because Phase 1 *creates* state that future phases (and reinstalls) must account for.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None — KERNEL has never run. Phase 1 *creates* `kernel-memory/` markdown files + `logs/{date}.md`. | None (greenfield). Future: the IDENTITY.md hash baseline is the one piece of state a reinstall must preserve/re-establish. |
| Live service config | None. Phase 1 *registers* two launchd plists (`com.kernel.daemon`, `com.kernel.heartbeat`) — these live in `~/Library/LaunchAgents/` AND must be `bootstrap`ed into the gui domain (registration is a runtime act, not just a file). | Document the `bootstrap`/`bootout` commands as install/uninstall steps. |
| OS-registered state | None yet. Phase 1 creates the two launchd jobs above (the heartbeat label/cadence is set at registration time). | A future rename of labels requires `bootout` + re-`bootstrap`, not just editing the plist file. |
| Secrets/env vars | None active in P1 (ANTHROPIC_API_KEY is referenced in `.env.example` but unused until Phase 3). `KERNEL_MEMORY_DIR` is a path env var, not a secret. | Keep secrets out of `kernel-memory/` (it backs up to GitHub later); use `--env-file=.env` + Keychain for real secrets in later phases. |
| Build artifacts | None. Phase 1 *produces* `daemon/dist/` (tsc output) and `node_modules/`. The launchd plist points at `dist/index.js`. | If the build output path changes, the plist `ProgramArguments` must be updated and the job re-`bootstrap`ed. |

**Nothing found in any category** — verified by the absence of any KERNEL install (STATE.md: "Status: Ready to plan", 0 plans complete, first phase, "Depends on: Nothing").

## Common Pitfalls

### Pitfall 1: Context-injection budget blowout (>16K cap drops IDENTITY)
**What goes wrong:** Naive retrieval overflows the 16K cap and silently truncates the tail — sometimes dropping IDENTITY or the user's actual instruction.
**Why it happens:** Retrieval returns "all relevant" with no budget enforcer; priority order isn't enforced on truncation.
**How to avoid:** Enforce priority order in code; IDENTITY + current.md are never truncated; measure char count before assembling; keyword retrieval is top-N and capped. Fail loud if IDENTITY+current alone exceed the cap.
**Warning signs:** Injected context near the cap; IDENTITY occasionally missing from the prompt. `[CITED: PITFALLS Pitfall 14]`

### Pitfall 2: Memory poisoning seam built wrong (no provenance field)
**What goes wrong:** Context items / memory records have no `source` tag, so external content is indistinguishable from user instruction — and retrofitting taint after later phases is a rewrite.
**Why it happens:** The skeleton ships a brain context that is one undifferentiated string with no provenance.
**How to avoid:** `ContextItem.source` exists from day one; external writes land only in `quarantine/` via a single `quarantine.ts` path; reranker gives quarantine authority 0.0; IDENTITY.md never auto-edited (hash guard).
**Warning signs:** The brain interface has no provenance field; consolidation (later) would read logs without filtering on source. `[CITED: PITFALLS Pitfall 1/2]`

### Pitfall 3: NDJSON partial-frame bug
**What goes wrong:** A `data` event delivers half a JSON line; `JSON.parse` throws; or two frames arrive concatenated and only the first parses.
**Why it happens:** UDS/TCP is a byte stream, not a message stream — newline framing must be reassembled by the reader.
**How to avoid:** Maintain a string buffer per connection; on `data`, append, split on `\n`, parse each complete line, keep the trailing partial in the buffer.
**Warning signs:** Intermittent `Unexpected end of JSON input`; frames lost under burst. `[VERIFIED: JSON streaming framing]`

### Pitfall 4: launchd minimal environment ("works in terminal, not under launchd")
**What goes wrong:** The agent can't find `node`, or `KERNEL_MEMORY_DIR` is unset, so the daemon dies silently at login.
**Why it happens:** launchd does not source the user's shell profile; PATH is minimal.
**How to avoid:** Absolute `node` path in `ProgramArguments`; explicit `EnvironmentVariables` (PATH + KERNEL_MEMORY_DIR); test under launchd with `StandardErrorPath` capturing failures.
**Warning signs:** Empty daemon, errors only in `*.err.log`, daemon runs fine when started by hand. `[CITED: PITFALLS Pitfall 10]`

### Pitfall 5: IDENTITY.md silently mutable
**What goes wrong:** Some helper writes to IDENTITY.md (or a future consolidation job promotes a poisoned line into it), permanently steering behavior.
**Why it happens:** No write-path guard, no startup hash check.
**How to avoid:** No daemon code path targets IDENTITY.md for writes; startup SHA-256 assertion fails loud on unexplained change; re-baseline only on explicit human action.
**Warning signs:** IDENTITY.md mtime/hash changes on a run with no human edit. `[CITED: PITFALLS Pitfall 2; "Looks Done But Isn't" checklist]`

### Pitfall 6: Polling tick instead of event-driven idle
**What goes wrong:** `setInterval` keeps the machine warm, wastes battery, and (later) repeatedly pokes Ollama out of idle-unload; risks concurrent loop passes.
**How to avoid:** Event-driven serial runner; single drain at a time; process resident but idle (sockets open, zero CPU) between events. `[CITED: ARCHITECTURE Anti-Pattern 5]`

## Code Examples

### NDJSON line-framed UDS server (the one subtle component)
```typescript
// Source: nodejs.org net docs + JSON streaming framing [VERIFIED]
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SOCK = path.join(os.homedir(), 'Library/Application Support/Kernel/kernel.sock');

export function startIpc(onFrame: (frame: unknown, conn: net.Socket) => void) {
  fs.mkdirSync(path.dirname(SOCK), { recursive: true });
  try { fs.unlinkSync(SOCK); } catch { /* no stale socket */ }

  const server = net.createServer((conn) => {
    conn.write(JSON.stringify({ type: 'ready', daemon: 'kernel', version: '0.1.0' }) + '\n');
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {       // process every COMPLETE line
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);                     // keep the partial remainder
        if (line.trim()) {
          try { onFrame(JSON.parse(line), conn); }
          catch { conn.write(JSON.stringify({ type: 'error', message: 'bad frame' }) + '\n'); }
        }
      }
    });
  });
  server.listen(SOCK, () => { /* log: listening on UDS */ });
  return server;
}

export function send(conn: net.Socket, frame: object) {
  conn.write(JSON.stringify(frame) + '\n');          // server→client push is just a write
}
```

### Priority injection with hard cap (never drop IDENTITY)
```typescript
// Source: ARCHITECTURE.md memory flow + PITFALLS Pitfall 14 [CITED]
const CAP = 16_384;
export async function inject(query: string): Promise<string> {
  const identity = await readIdentityVerified();          // throws/alerts if hash mismatch
  const current  = await readFile('working-memory/current.md');
  const fixed = `${identity}\n\n${current}`;
  if (fixed.length > CAP) logWarn('IDENTITY+current exceed cap');   // fail loud, never drop IDENTITY
  let budget = CAP - fixed.length;
  const ranked = await retrieveAndRerank(query);          // keyword + authority×recency
  const parts: string[] = [fixed];
  for (const item of ranked) {
    if (item.source === 'external') continue;             // quarantine never enters privileged ctx
    if (item.text.length + 2 > budget) continue;          // skip what won't fit (greedy, priority-ordered)
    parts.push(item.text); budget -= item.text.length + 2;
  }
  return parts.join('\n\n');
}
```

### Keyword retrieval + authority×recency rerank
```typescript
// Source: ported from agentic-os memory-config.json [VERIFIED: direct inspection]
const HALF_LIFE = 14, FLOOR = 0.3;
const AUTH: Record<string, number> = {
  'knowledge/': 1.5, 'working-memory/current.md': 1.0,
  'tasks/': 1.0, 'projects/': 0.8, 'logs/': 0.5,
  'working-memory/quarantine/': 0.0,
};
function tokenize(s: string) { return new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []); }
function score(query: Set<string>, doc: { text: string; path: string; ageDays: number }) {
  const dt = tokenize(doc.text);
  let hits = 0; for (const t of query) if (dt.has(t)) hits++;
  const keyword = query.size ? hits / query.size : 0;
  const recency = Math.max(FLOOR, Math.pow(0.5, doc.ageDays / HALF_LIFE));
  const authority = Object.entries(AUTH).find(([p]) => doc.path.startsWith(p))?.[1] ?? 0.5;
  return keyword * recency * authority;
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `launchctl load`/`unload` | `launchctl bootstrap`/`bootout gui/$(id -u)` | macOS 10.10+, enforced ~Catalina+ | Use bootstrap; load is deprecated/compat-only `[VERIFIED: launchd.info]` |
| `SMLoginItemSetEnabled` / login-item helper | `SMAppService` (Face, Phase 3) | macOS 13 Ventura | N/A in P1; relevant when the Face app ships |
| agentic-os markdown + reranker memory | agentic-os migrated to BGE-M3 embeddings on PGLite | reference's current state | KERNEL **rejects** the embeddings migration; ports the *earlier* markdown+reranker discipline (16GB ceiling) `[VERIFIED: docs/memory/memory-schema.md]` |
| CommonJS Node daemons | ESM (`"type":"module"`), NodeNext resolution | Node 20+/24 | Use ESM; `.js` extensions in TS import specifiers under NodeNext |

**Deprecated/outdated:**
- `launchctl load` — use `bootstrap`. `[VERIFIED]`
- `@types/node@26` and `typescript@6` are `latest` but the project pins Node 24 / TS 5.9 — do NOT take latest. `[VERIFIED: npm registry]`
- BGE-M3/PGLite embeddings path from the reference — explicitly out of scope.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | All Phase 1 packages are legitimate (slopcheck unavailable → tagged `[ASSUMED]`) | Package Legitimacy Audit | LOW — all canonical, high-download, no postinstall, official repos; planner may add a verify checkpoint |
| A2 | `kernel-memory/` is a separate git repo (own `.git`) nested/sibling to the code monorepo | Project Structure | MEDIUM — if it must be one repo, the finance-ignore + future backup design shifts; recommend separate repo per spec §5 "own remote" |
| A3 | Heartbeat cadence (e.g. hourly / top-of-hour) is owner discretion | launchd Plist Patterns | LOW — any cadence proves CORE-03; owner can tune |
| A4 | IPC remains UDS+NDJSON (not WebSocket) — resolving the ARCHITECTURE.md divergence in favor of the spec pin | IPC Contract; Open Questions | MEDIUM — if WS is later chosen, the Swift client + framing change, but the frame *shapes* are transport-agnostic |
| A5 | The IDENTITY.md persona seed prose (voice rules) reflects PERS-01..03 correctly | IDENTITY seed | LOW — persona facts are owner-confirmable; structure is spec-driven |
| A6 | `working-memory/current.md` adopts the reference's ~2.5K-char frozen-snapshot cap | Memory Mechanics | LOW — a recommended discipline, tunable |
| A7 | The reranker `authority_weights` paths/values (adapted from the reference) are a sensible default | Retrieval rerank | LOW — directly ported; tunable per measured recall |

## Open Questions

1. **IPC transport: UDS+NDJSON vs WebSocket — a documented internal divergence.**
   - What we know: The phase brief, `KERNEL_MASTER_BUILD_PROMPT` §2, and `STACK.md` all pin **Unix domain socket + NDJSON**. `ARCHITECTURE.md` "Internal Boundaries" instead proposes **localhost WebSocket** (Node `ws` + Swift `URLSessionWebSocketTask`), arguing WS is needed for server→client push of `speak`/`stage` frames.
   - What's unclear: only which document wins. STATE.md Blockers also flags "IPC transport ambiguity (UDS vs localhost WebSocket) must be resolved."
   - Recommendation: **Lock UDS+NDJSON for Phase 1** (it is the spec pin, and a raw duplex socket supports server-push natively via `conn.write` — WS is not required for push). Author `ipc/protocol.ts` so the frame *shapes* are transport-agnostic; if a later phase proves UDS+NDJSON insufficient for the Swift side, swapping the transport leaves the contract intact. Surface this to the owner only if they want to override the pin (it is an architecture decision, not a safety/money one — per §0 "make the smallest reasonable assumption and keep moving").

2. **Single repo vs separate `kernel-memory/` repo.**
   - What we know: Spec §5 says `kernel-memory/` has its "own remote." 
   - What's unclear: whether P1 initializes it as a distinct `.git` immediately or defers the remote.
   - Recommendation: initialize `kernel-memory/` as its own git repo in P1 (local only; remote deferred to P5 backup) so the finance `.gitignore` and `git ls-files` assertion operate on the correct repo from the start.

3. **Heartbeat cadence and what the heartbeat "does."**
   - What we know: CORE-03 requires a timed job that writes a dated log entry. 
   - Recommendation: a short-lived `node dist/index.js --heartbeat` that appends one `heartbeat {ISO timestamp}` line to `logs/{date}.md` and exits. Cadence is owner-tunable (hourly is a fine default to demonstrate firing).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Node.js 24 LTS | Daemon runtime | ✓ | v24.16.0 | — |
| npm | Dependency install | ✓ | 11.13.0 | — |
| git | `kernel-memory/` repo + finance assertion | ✓ | 2.50.1 (Apple Git-155) | — |
| launchctl | Login agent + heartbeat | ✓ | present | — |
| macOS | launchd / Application Support paths | ✓ | 26.5.1 (exceeds macOS 14+ min) | — |
| TypeScript 5.9.x | Build | install-time | 5.9.3 (npm) | — |

**Missing dependencies with no fallback:** none — the full Phase 1 toolchain is present on this machine.
**Missing dependencies with fallback:** none. (Ollama, whisper.cpp, Peekaboo, Playwright, Xcode are NOT required for Phase 1 — they belong to later phases.)

## Validation Architecture

> `workflow.nyquist_validation` is `true` in config.json — this section is required. KERNEL has **no test framework yet** (greenfield); Wave 0 must install one.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | **`node:test`** (built-in, Node 24) + `tsx` loader — zero extra deps; OR `vitest` if richer assertions/watch wanted. Recommend `node:test` for the skeleton. |
| Config file | none — `node:test` needs no config (run via `node --test` / `tsx --test`). If vitest: `vitest.config.ts` (Wave 0). |
| Quick run command | `node --import tsx --test daemon/src/**/*.test.ts` (single module: append the path) |
| Full suite command | `node --import tsx --test daemon/src/**/*.test.ts` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CORE-01 | Daemon process starts and stays resident | smoke | spawn `dist/index.js`, assert it does not exit, kill | ❌ Wave 0 |
| CORE-01 | launchd relaunch at login | manual | `launchctl bootstrap` + log out/in (fresh-account check) | manual-only (TCC/login) |
| CORE-02 | One loop tick: intent→inject→StubBrain→log | unit | `tsx --test memory/loop.test.ts` (enqueue a fake intent, assert a log entry + reply) | ❌ Wave 0 |
| CORE-02 | Falls idle (no busy spin) | unit | assert `running===false` and queue empty after drain; assert no timer set | ❌ Wave 0 |
| CORE-03 | Heartbeat writes a dated log entry | unit | run `index.ts --heartbeat`, assert `logs/{today}.md` contains a heartbeat line with today's date | ❌ Wave 0 |
| CORE-04 | Face can attach over UDS without restart | integration | start ipc server, connect a Node test client, assert `ready` frame, send `ping`, assert `pong`; reconnect a 2nd time | ❌ Wave 0 |
| CORE-04 | NDJSON partial-frame handling | unit | feed a split JSON line in two chunks, assert one parsed frame | ❌ Wave 0 |
| CORE-05 | Append-only event log under memory repo | unit | assert log writes append (never truncate) to `logs/{date}.md` | ❌ Wave 0 |
| MEM-01 | Memory layout exists with seeded files | unit | assert all spec §5 dirs/files present after setup | ❌ Wave 0 |
| MEM-02 | IDENTITY.md injected + never auto-edited | unit | inject() output starts with IDENTITY content; tamper IDENTITY → startup hash guard throws | ❌ Wave 0 |
| MEM-03 | Priority order + 16K cap, IDENTITY never dropped | unit | seed oversized knowledge/, assert IDENTITY present + total ≤16384 + retrieved truncated | ❌ Wave 0 |
| MEM-04 | Keyword retrieval + authority×recency rerank | unit | rank fixture docs; assert higher-authority/recent doc outranks stale/low | ❌ Wave 0 |
| MEM-05 | External content → quarantine, never promoted | unit | write a `source:external` record, assert it lands in `quarantine/` and is excluded from inject() | ❌ Wave 0 |
| MEM-06 | finance/ gitignored + assertion | unit/integration | `git check-ignore finance/x.db` passes; `git ls-files \| grep -i finance` empty | ❌ Wave 0 |
| BRAIN-01 | BrainProvider satisfied by StubBrain | unit | `new StubBrain().reason(...)` returns a zod-valid `Decision` | ❌ Wave 0 |
| PERS-01..03 | IDENTITY seed encodes the voice rules | unit (content assertion) | assert IDENTITY.md contains the "to Pravin terse / outward dynamic / clarify-don't-guess" sections | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** the relevant module's quick test (`tsx --test <module>.test.ts`).
- **Per wave merge:** full suite green (`node --import tsx --test daemon/src/**/*.test.ts`).
- **Phase gate:** full suite green + the manual launchd checks (relaunch-at-login on a clean login, heartbeat fires on schedule) before `/gsd-verify-work`.

### Wave 0 Gaps
- [ ] Framework install: `node:test` needs nothing; if vitest chosen → `npm i -D vitest` + `vitest.config.ts`.
- [ ] `daemon/src/memory/inject.test.ts` — covers MEM-02, MEM-03.
- [ ] `daemon/src/memory/retrieve.test.ts` — covers MEM-04.
- [ ] `daemon/src/memory/quarantine.test.ts` — covers MEM-05.
- [ ] `daemon/src/memory/identity.test.ts` — covers MEM-02 hash guard.
- [ ] `daemon/src/ipc/server.test.ts` + a tiny Node UDS test client — covers CORE-04.
- [ ] `daemon/src/loop.test.ts` — covers CORE-02, CORE-05.
- [ ] `daemon/src/brain/StubBrain.test.ts` — covers BRAIN-01.
- [ ] `daemon/test/finance-ignore.test.ts` — covers MEM-06 (`git check-ignore` + `git ls-files`).
- [ ] `daemon/test/heartbeat.test.ts` — covers CORE-03.
- [ ] Manual runbook: launchd `bootstrap` + fresh-login relaunch + heartbeat-fires checks (not automatable in CI).

## Security Domain

> `security_enforcement: true`, `security_asvs_level: 1`. Phase 1 has no network ingress beyond a filesystem-scoped local UDS and no external content reader yet — but it lays the security *seams* that the whole product's "robbed by a poisoned email" promise depends on.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | No network auth surface in P1 (local UDS, file-permission scoped). |
| V3 Session Management | no | No web sessions. |
| V4 Access Control | partial | The IDENTITY-never-auto-edited write-path guard + quarantine no-promote rule are access-control invariants enforced in code. |
| V5 Input Validation | yes | `zod` validates every IPC frame and the brain `Decision` shape; the NDJSON reader rejects malformed lines without crashing. |
| V6 Cryptography | partial | SHA-256 for the IDENTITY integrity check (use `node:crypto`, never hand-roll a hash). No secrets handled in P1. |
| V12 Files/Resources | yes | Socket file under user Application Support (not world-writable); finance/ gitignore + `git ls-files` assertion prevent accidental commit of (future) sensitive data. |
| V14 Configuration | yes | Secrets via `--env-file`/Keychain, never in `kernel-memory/` (which backs up to GitHub later). |

### Known Threat Patterns for this stack (Phase 1 seams)

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Indirect prompt injection (future, via external content) | Tampering / EoP | Provenance `source` tag on every ContextItem from P0; quarantine authority 0.0 so external never enters privileged context; code-level (not prompt) enforcement. `[CITED: PITFALLS Pitfall 1]` |
| Memory poisoning of durable memory | Tampering / Persistence | IDENTITY.md never auto-edited (hash guard + write-path guard); external writes only to `quarantine/`; no promotion path exists in P1. `[CITED: PITFALLS Pitfall 2]` |
| Finance data leak via git backup (future store) | Information Disclosure | Broad `finance/` + `**/finance/**` gitignore + sidecar patterns + startup `git ls-files` assertion laid in P1. `[CITED: PITFALLS Pitfall 3]` |
| Malformed IPC frame crashing the daemon | DoS | NDJSON reader catches parse errors per-line; `zod`-validate frame shape; never `JSON.parse` raw stream without buffering. |
| Local socket exposure | Information Disclosure | UDS (filesystem-permission scoped under user Application Support), not a TCP port; no remote attach surface. `[CITED: STACK.md]` |
| Secrets in the memory repo | Information Disclosure | Store env-var *names* only in memory; real secrets via `--env-file`/Keychain; `.env` gitignored. `[CITED: PITFALLS Security Mistakes]` |

## Sources

### Primary (HIGH confidence)
- `docs/KERNEL_MASTER_BUILD_PROMPT.md` §2/§3/§4/§5/§6/§7/§10/§16/§17 — authoritative pinned spec (stack, repo layout, loop, memory, BrainProvider, persona, phases).
- `.planning/research/STACK.md` — pinned versions, UDS IPC pin, launchd patterns, "What NOT to Use" (npm-verified June 2026).
- `.planning/research/ARCHITECTURE.md` — component boundaries, loop pattern, memory injection flow, anti-patterns, build order, the agentic-os→KERNEL mapping table (note: proposes WebSocket — divergence resolved in favor of the spec pin).
- `.planning/research/PITFALLS.md` — provenance/quarantine, IDENTITY immutability, 16K cap, launchd env, NDJSON, finance leak, "Looks Done But Isn't" checklist.
- `.planning/REQUIREMENTS.md` + `ROADMAP.md` Phase 1 — requirement IDs and the 5 success criteria.
- agentic-os reference (direct inspection): `context/memory-config.json` (reranker), `context/MEMORY.md` (frozen scratchpad), `context/SOUL.md`/`USER.md` (privileged injected files), `CLAUDE.md` (Returning Mode 5-step startup + daily session blocks + silent auto-tracking), `context/memory/2026-05-17.md` (session-block format), `docs/memory/memory-schema.md` (the embeddings path KERNEL rejects), `.gitignore` (tracked-vs-ignored discipline).
- npm registry via `npm view` (2026-06-22) — exact versions/publish dates/repos/postinstall for all Phase 1 packages.
- This machine probe — Node v24.16.0, npm 11.13.0, git 2.50.1, launchctl present, macOS 26.5.1.

### Secondary (MEDIUM confidence)
- launchd.info; Apple "Creating Launch Daemons and Agents" (BPSystemStartup) — `launchctl bootstrap gui/$(id -u)` replaces deprecated `load`; `RunAtLoad`/`KeepAlive`/`StartCalendarInterval` semantics. [VERIFIED via WebSearch + cross-referenced]
- nodejs.org `net` docs + JSON-streaming/NDJSON framing references — UDS server, byte-stream framing, newline delimiter, partial-line carryover.

### Tertiary (LOW confidence)
- None — every load-bearing claim is backed by the spec, the reference repo, official docs, or an npm registry probe.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — pinned by spec, every Phase 1 package version verified against npm + runtime present on this machine.
- Architecture (loop, memory, IPC, provenance): HIGH — pinned by spec §1–§16 and corroborated by ARCHITECTURE.md; the one divergence (IPC transport) is documented and resolved per the spec pin.
- Memory mechanics: HIGH — ported by direct inspection of the agentic-os reference's markdown+reranker pattern.
- launchd / NDJSON specifics: MEDIUM-HIGH — confirmed against official docs/WebSearch; on-device launchd-at-login relaunch is a manual phase-gate check.
- Pitfalls: HIGH — sourced from PITFALLS.md (Context-grade) and mapped to P0/P1.

**Research date:** 2026-06-22
**Valid until:** ~2026-07-22 (stable stack; re-verify package versions if planning slips a month, and re-confirm the TS 5.9 pin vs TS 6.x default).
