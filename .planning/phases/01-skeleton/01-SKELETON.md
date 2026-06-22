# Walking Skeleton — KERNEL

**Phase:** 1 (spec Phase 0)
**Generated:** 2026-06-22

## Capability Proven End-to-End

> One sentence: the smallest user-visible capability that exercises the full stack.

A frame sent to KERNEL's Unix-domain socket runs one full `perceive → recall → decide → act → log` tick — memory is injected in priority order under the 16K cap, the StubBrain (behind the BrainProvider seam) returns a `Decision`, a `reply` frame is pushed back to the client, a `## Session N` block is appended to the append-only event log, and a launchd-fired heartbeat independently appends a dated line to that same log — proving the daemon persists, injects memory, exposes the Face attach point, and the heartbeat fires.

## Architectural Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Runtime | Node.js 24.x LTS, ESM (`"type":"module"`), NodeNext resolution | Pinned by spec §2 / STACK.md; verified `v24.16.0` on this machine; `.js` import specifiers under NodeNext. Do NOT use 23/25/26 (odd = non-LTS). |
| Language / build | TypeScript **5.9.3** (pin 5.9.x — NOT 6.x `latest`); `tsc` for prod build, `tsx` for dev | Project pins TS 5.9; launchd runs compiled `dist/index.js`. `@types/node` pinned to **24.x** (NOT 26.x). |
| Test harness | `node:test` built-in, run via `tsx` (`tsx --test`) — zero extra runtime deps | Matches Node 24 ESM; greenfield Wave 0 wires the `test` script. `nyquist_validation=true`. |
| Brain seam | `BrainProvider` interface (`reason(prompt, context) → Promise<Decision>`) built FIRST, satisfied in-process by `StubBrain` | Spec §6 non-negotiable: anything that "thinks" sits behind a boundary. `Decision` validated with `zod` from day one so real brains drop in unchanged (Phase 3). |
| Memory | Markdown + YAML front-matter in a dedicated `kernel-memory/` git repo (own `.git`, local-only; remote deferred to Phase 5) with spec §5 layout. Keyword retrieval only — NO embeddings (16GB ceiling). | Spec §5 / STACK.md. `gray-matter` splits front-matter; `yaml` for parsing. Embeddings rejected (RAM). |
| Memory injection | Priority order IDENTITY.md → working-memory/current.md → reranked retrieved knowledge/tasks/projects, hard ~16,384-char cap, IDENTITY + current NEVER truncated; fail loud if IDENTITY+current alone exceed cap. | Spec §5 / ROADMAP success criterion 2 / PITFALLS Pitfall 14. |
| Retrieval rerank | Keyword overlap × recency (14-day half-life, 0.3 floor) × authority-weight (longest path-prefix match) | Ported from agentic-os `memory-config.json`; `quarantine/` authority = 0.0 so external content never enters privileged context. |
| IPC transport | Unix domain socket + NDJSON frames at `~/Library/Application Support/Kernel/kernel.sock`; NOT localhost HTTP, NOT WebSocket | Spec §2 / STACK.md pin. Raw duplex socket supports server→client push natively via `conn.write` — WS not required. Resolves the documented ARCHITECTURE.md divergence in favor of the spec pin. `ipc/protocol.ts` is the frozen, transport-agnostic frame contract the Swift Face will mirror. |
| Logging | `pino` → JSON lines + a markdown session-block writer into `kernel-memory/logs/{YYYY-MM-DD}.md` (append-only) | Spec §5 / STACK.md. These ARE the raw events later phases distill. `pino-pretty` dev-only, never in the launchd path. |
| Scheduler / process mgmt | launchd ONLY — `com.kernel.daemon.plist` (`RunAtLoad`+`KeepAlive`) + `com.kernel.heartbeat.plist` (`StartCalendarInterval`), loaded via `launchctl bootstrap gui/$(id -u)` (NOT deprecated `load`) | Spec §7 / STACK.md "What NOT to Use". No pm2/forever/nodemon in prod. Absolute `node` path + explicit `EnvironmentVariables.PATH` (launchd has minimal env). |
| Loop | Event-driven serial intent runner (queue + single drain) woken by IPC / launchd / tool callbacks — NOT a polling `setInterval` | ARCHITECTURE Pattern 1 / Anti-Pattern 5. Falls genuinely idle (zero CPU) between events. |
| Security seams (data-shape only) | (1) `source: 'user' \| 'self' \| 'external'` provenance tag on every `ContextItem` / write; (2) `working-memory/quarantine/` bucket + single `quarantine.ts` write path + no promoter; (3) `IDENTITY.md` SHA-256 startup hash guard + write-path guard; (4) `finance/` gitignore + startup `git ls-files` assertion | Spec §5/§8/§14, PITFALLS 1/2/3. Phase 1 lays the seams; enforcement gates (promotion gate, full safety gate, finance store) are Phases 2/4/5. |
| Directory layout | Monorepo root with `daemon/` (TS source under `src/`, split brain/ memory/ ipc/, plus `safety/` stub seam), `kernel-memory/` (separate git repo), `launchd/` | Spec §3. Module split inside `daemon/src/` is Claude's discretion within the §3 top-level layout. |

## Stack Touched in Phase 1

- [x] Project scaffold — monorepo root, `daemon/` (Node 24 ESM + TS 5.9 + tsconfig NodeNext), `node:test`+`tsx` test runner, pinned deps (`@anthropic-ai/sdk` 0.105.0, `pino` 10.3.1, `zod` 4.4.3, `gray-matter` 4.0.3, `yaml` 2.9.0; dev: `typescript` 5.9.3, `tsx` 4.22.4, `@types/node` 24.x, `pino-pretty` 13.1.3)
- [x] Routing / endpoint — one real UDS NDJSON IPC server (`ipc/server.ts`) that the Face attaches to; sends `ready`, answers `ping`→`pong`, routes `utterance` through the loop, pushes `reply`
- [x] Storage — at least one real read (inject reads IDENTITY.md + current.md + retrieves from knowledge/tasks/projects) AND one real write (log appends a `## Session N` block + heartbeat appends a dated line to `logs/{date}.md`)
- [x] "UI" element wired to the endpoint — a tiny Node UDS test client (the Face stand-in) connects, sends a frame, receives `reply`/`pong` — proving attach/detach/re-attach without daemon restart
- [x] Deployment — documented local full-stack run command (`cd daemon && npm run build && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.kernel.daemon.plist`) plus the manual launchd phase-gate runbook

## Out of Scope (Deferred to Later Slices)

> Explicit so future phases do not re-litigate Phase 1's minimalism.

- Real brains: `ClaudeBrain` / `LocalBrain` / `ClaudeCodeBrain` / 7B helper implementations (Phase 3) — only the interface + `StubBrain` land here. No Anthropic/Ollama network calls in Phase 1.
- Tool router, Peekaboo MCP, Playwright, the `gate.authorize` chokepoint and tier-classifier (Phase 2). `daemon/src/safety/` is a stub seam only (no enforcement).
- Voice (whisper STT / AVSpeechSynthesizer TTS), the Metal particle cloud, the Stage controller, the SwiftUI Face app itself (Phase 3) — Phase 1 only defines the IPC frame contract (`speak`/`cues`/`widget.data` shapes authored but not exercised).
- Nightly consolidation / prune / GitHub backup, `self/` distillation jobs (Phase 5).
- The quarantine PROMOTION GATE (Phase 5) — Phase 1 ships the bucket + no-auto-promote rule (no promoter code path exists), not the reviewed promotion path.
- Full tiered safety gate, circuit breaker, `/override` (Phase 5 — GATED).
- Finance store (encrypted SQLCipher under `finance/`) — Phase 4. Phase 1 pre-seeds only the gitignore + `git ls-files` assertion; `finance/` does not exist yet.
- Embeddings-based retrieval (v2 only, gated on measured keyword-recall failure).
- `kernel-memory/` git remote / push (Phase 5 backup) — Phase 1 inits a local-only repo.

## Subsequent Slice Plan

Each later phase adds one vertical slice on top of this skeleton without altering its architectural decisions:

- **Phase 2 — Hands:** Peekaboo MCP + Playwright headful browser behind a tool router whose every dispatch passes one `gate.authorize(call)` chokepoint (thin tier-classifier). Fills `daemon/src/safety/` and `daemon/src/tools/`; the loop's `act` step finally dispatches `decision.action`.
- **Phase 3 — Brain + Voice + the Cloud:** Real `ClaudeBrain`/`LocalBrain`/`ClaudeCodeBrain` swap in behind the unchanged `BrainProvider` seam; whisper STT + AVSpeechSynthesizer TTS; the SwiftUI Face attaches to the frozen IPC contract and exercises the `speak`/`cues`/`widget.data` frames; Metal particle cloud + Stage controller.
- **Phase 4 — Routines + Claude Code + Finance:** Morning-brief YAML engine, email reply flow, read-only Plaid finance aggregation into the (now-created, still-gitignored) encrypted `finance/` store, Claude Code bridge + project registry. The four-layer finance-leak stack completes on top of the Phase 1 gitignore + assertion seam.
- **Phase 5 — Safety + Self-Maintenance (GATED):** Full tiered gate + `/override` + circuit breaker; the quarantine promotion gate completes on top of the Phase 1 provenance/quarantine seam; nightly consolidation/cleanup/backup; `self/` changelog + metrics.
