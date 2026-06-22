---
phase: 01-skeleton
plan: 03
subsystem: infra
tags: [typescript, esm, node24, ipc, uds, ndjson, zod, pino, launchd, event-loop, append-only-log, heartbeat, node-test, tdd, walking-skeleton]

# Dependency graph
requires:
  - phase: 01-01
    provides: "daemon ESM/TS scaffold + node:test/tsx harness, config.ts (config.socketPath, config.memoryDir, INJECT_CAP), BrainProvider interface + StubBrain, ContextItem provenance shape, seeded kernel-memory/ repo, the RED skeleton.e2e.test.ts acceptance contract"
  - phase: 01-02
    provides: "memory engine — inject() (IDENTITY-first context ≤16K), retrieveAndRerank(), identity.ts (baselineIdentityHash/readIdentityVerified/assertNotIdentityPath), quarantine.ts"
provides:
  - "protocol.ts — frozen zod FrameSchema discriminated union: P1 frames (hello/utterance/ping/ready/reply/pong/error) + designed-for P2/P3 shapes (speak{cues,onFinish}/widget.data/ui.intent); exports FrameSchema, Frame, Envelope"
  - "server.ts — UDS net.createServer NDJSON server, ready-on-connect, per-connection partial-frame-safe line buffer, safeParse-per-line, error-frame on malformed/invalid (never crashes); exports startIpc(onFrame), startIpcServer(), send(conn,frame), defaultFrameHandler"
  - "loop.ts — event-driven serial intent runner (enqueue/drain/runTick), running-guard single-pass, awaits in-flight pass, falls genuinely idle (no setInterval); one tick perceive→recall(inject)→decide(StubBrain.reason)→act(P2+ seam)→log(logSession), reply via intent.reply callback; setBrain swap-seam"
  - "memory/log.ts — append-only logSession(## Session N blocks) + logHeartbeat(dated line) to logs/{date}.md; pino structured event lines (no pino-pretty on the launchd path); exports logSession, logHeartbeat, logger"
  - "heartbeat.ts — runHeartbeat(): short-lived append-one-dated-line-then-resolve for the --heartbeat launchd job"
  - "index.ts — entry: --heartbeat branch; runStartupGuards (IDENTITY baseline+verify fail-loud, finance git ls-files assertion fail-loud); startIpcServer + resident on open socket; exports main, runStartupGuards, assertFinanceNotTracked"
  - "launchd/com.kernel.daemon.plist (RunAtLoad+KeepAlive login agent) + com.kernel.heartbeat.plist (StartCalendarInterval --heartbeat) + README.md install/uninstall runbook (bootstrap/bootout/kickstart)"
  - "GREEN Walking-Skeleton skeleton.e2e.test.ts — the full perceive→recall→decide→act→log tick runs end to end"
affects: [Phase 2 (tool router + safety gate dispatch in the loop's act step; the Face attaches over the frozen UDS contract), Phase 3 (ClaudeBrain/LocalBrain swap in via setBrain; speak/widget.data frames become live), Phase 4/5 (consolidation distills the append-only logs; quarantine promotion gate)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Hand-rolled NDJSON line framing with per-connection partial-frame carryover (the one subtle component — kept tiny + unit-tested)"
    - "zod discriminated-union frame contract as the single transport-agnostic source of truth the Swift Face mirrors"
    - "Event-driven serial intent runner: enqueue→void drain(), running guard + in-flight promise (await, never double-pass), idle in finally — explicitly NOT setInterval"
    - "Brain swap-seam routed even for the stub (setBrain + brain.reason()); reply delivered via an injected callback so the loop never imports the server (no cycle)"
    - "Append-only event log: count-and-append ## Session N blocks, never truncate; pino plain-JSON (never pino-pretty) on the launchd-run path"
    - "Fail-loud startup guards before serving: IDENTITY SHA-256 verify + finance git ls-files assertion"
    - "launchd bootstrap/bootout/kickstart (NOT deprecated load/unload); absolute node path + explicit EnvironmentVariables.PATH + StandardOut/ErrorPath for the minimal-env launchd surface"

key-files:
  created:
    - daemon/src/ipc/protocol.ts
    - daemon/src/ipc/protocol.test.ts
    - daemon/src/ipc/server.ts
    - daemon/src/ipc/server.test.ts
    - daemon/src/memory/log.ts
    - daemon/src/memory/log.test.ts
    - daemon/src/loop.ts
    - daemon/src/loop.test.ts
    - daemon/src/heartbeat.ts
    - daemon/test/heartbeat.test.ts
    - daemon/src/index.ts
    - launchd/com.kernel.daemon.plist
    - launchd/com.kernel.heartbeat.plist
    - launchd/README.md
  modified:
    - kernel-memory/.gitignore

key-decisions:
  - "server.ts exports BOTH the plan's startIpc(onFrame)/send AND the e2e-required startIpcServer() (default loop-connected handler) — the RED skeleton.e2e.test.ts imports startIpcServer + runTick, so the e2e contract is authoritative and both surfaces are provided."
  - "loop.ts exports enqueue/drain plus runTick() (the e2e entry). drain() returns the in-flight promise when a pass is already running (callers await completion) rather than returning early — keeps test timing deterministic and matches 'await the tick' semantics while preserving the single-pass guard."
  - "The loop never imports the server: the reply is surfaced via an intent.reply callback the server supplies (a closure that pushes a reply frame). Avoids a server↔loop import cycle; the seam stays one-directional (server→loop via enqueue)."
  - "Heartbeat plist gained StandardOutPath (deviation): launchd leaves stdout unconnected without it; pino writes to fd 1 — mirroring the daemon plist's StandardOut/ErrorPath is the T-01-13 'dies silently under launchd' mitigation."
  - "kernel-memory/.gitignore now excludes runtime logs (logs/*.md, *.log) + the machine-local self/identity.hash baseline — they are raw runtime events / re-seedable state, not portable committed source; logs/.gitkeep preserves the dir."

patterns-established:
  - "Frozen IPC contract: a zod discriminated union is the one source of truth both daemon and Face validate against; malformed/invalid lines reply with an error frame and never crash the daemon (CORE-04, T-01-09)."
  - "The loop closes the full tick through real seams: inject() for recall, brain.reason() for decide (even the stub), logSession() for the append-only log; act is a documented P2+ dispatch seam (no tools in P1)."
  - "Daemon refuses to serve unless startup guards pass: IDENTITY hash verified + nothing finance-pathed tracked (fail loud to stderr/launchd err log)."

requirements-completed: [CORE-01, CORE-02, CORE-03, CORE-04, CORE-05]

# Metrics
duration: 11 min
completed: 2026-06-22
---

# Phase 01 Plan 03: Skeleton IPC + Loop + Heartbeat + launchd Summary

**Closed the Walking Skeleton: a partial-frame-safe UDS NDJSON IPC server (frozen zod frame contract), an event-driven serial intent runner that drains one intent at a time and falls genuinely idle, an append-only ## Session / heartbeat log writer, a short-lived --heartbeat job, a daemon entry with fail-loud IDENTITY + finance startup guards, and two launchd plists — turning the RED skeleton.e2e.test.ts GREEN with the full perceive→recall→decide→act→log tick running end to end.**

## Performance

- **Duration:** 11 min
- **Started:** 2026-06-22T09:19:19Z
- **Completed:** 2026-06-22T09:30:53Z
- **Tasks:** 4 (Task 1 + Task 2 TDD-style; Task 3 plists; Task 4 manual launchd gate — attempted non-interactively per owner directive)
- **Files created:** 14 (11 code/test + 3 launchd) + 1 modified (kernel-memory/.gitignore)

## Accomplishments
- **CORE-04 — UDS NDJSON IPC:** `server.ts` listens on `config.socketPath`, sends `ready` on connect, reassembles newline-delimited JSON with a per-connection buffer (a line split across two `data` events yields exactly one frame), `safeParse`s every line against the frozen `FrameSchema`, and replies with an `error` frame on malformed/invalid input without crashing. `protocol.ts` freezes the P1 frames plus the designed-for P2/P3 shapes the Swift Face will mirror.
- **CORE-02 — event-driven serial loop:** `loop.ts` `enqueue`/`drain`/`runTick` run one intent at a time under a `running` guard, await any in-flight pass instead of double-passing, and fall genuinely idle (`running=false`, queue empty, no timer) when drained. One tick runs perceive→recall (`inject()`)→decide (`StubBrain.reason()`)→act (P2+ dispatch seam)→log (`logSession`), surfacing the reply via the intent's callback. No `setInterval`.
- **CORE-05 — append-only log:** `memory/log.ts` `logSession` counts existing `## Session N` blocks and appends a new numbered block (intent + thought + reply + ISO timestamp), never truncating; `logHeartbeat` appends a dated line. `pino` writes structured JSON events alongside (plain pino, never `pino-pretty`, on the launchd path).
- **CORE-03 — heartbeat:** `heartbeat.ts` `runHeartbeat()` appends one dated line and resolves; `index.ts --heartbeat` runs it then `process.exit(0)`.
- **CORE-01 — daemon persistence + guards:** `index.ts` runs fail-loud startup guards (IDENTITY SHA-256 baseline+verify; `git -C <memdir> ls-files | grep finance` must be empty) before `startIpcServer()`, then stays resident on the open socket with graceful SIGTERM/SIGINT shutdown. `launchd/` ships the RunAtLoad+KeepAlive daemon agent + StartCalendarInterval heartbeat + a bootstrap/bootout/kickstart runbook.
- **Walking Skeleton GREEN:** `skeleton.e2e.test.ts` passes — ready frame on connect, `utterance`→`reply` carrying the StubBrain echo, a `## Session` block in today's log, and IDENTITY-first injected context ≤16K. Full suite: **46 tests, 46 pass, 0 fail**; `npm run build` clean.

## Task Commits

Atomic per-task commits in the code monorepo (`/Users/pravinmaurya/Documents/KernelAi`):

1. **Task 1: protocol + UDS NDJSON server + append-only log writer** — `61da294` (feat)
2. **Task 2: event-driven loop + heartbeat + entry with startup guards** — `d26df2b` (feat)
3. **Task 3: launchd plists + install runbook** — `ea11bd7` (feat)
4. **Task 3 follow-up (deviation): heartbeat plist StandardOutPath** — `16a3bfb` (fix)

_Separate kernel-memory repo: `8ff5a9f` (chore) — gitignore runtime logs + identity.hash baseline._

## Files Created/Modified
- `daemon/src/ipc/protocol.ts` — frozen zod `FrameSchema` discriminated union (P1 + designed-for P2/P3); exports `FrameSchema`, `Frame`, `Envelope`, per-frame type aliases.
- `daemon/src/ipc/server.ts` — UDS server, ready-on-connect, partial-frame-safe line framing, error-frame on bad input; exports `startIpc`, `startIpcServer`, `send`, `defaultFrameHandler`, `FrameHandler`, `IpcServer`.
- `daemon/src/memory/log.ts` — append-only `logSession`/`logHeartbeat` + `pino` `logger`.
- `daemon/src/loop.ts` — `enqueue`/`drain`/`runTick`/`setBrain`/`isRunning`/`queueDepth`; the serial tick.
- `daemon/src/heartbeat.ts` — `runHeartbeat()`.
- `daemon/src/index.ts` — entry + `runStartupGuards`/`assertFinanceNotTracked`/`main`.
- `daemon/src/ipc/protocol.test.ts` (5), `daemon/src/ipc/server.test.ts` (4), `daemon/src/memory/log.test.ts` (3), `daemon/src/loop.test.ts` (3), `daemon/test/heartbeat.test.ts` (2) — node:test files.
- `launchd/com.kernel.daemon.plist`, `launchd/com.kernel.heartbeat.plist`, `launchd/README.md` — the launchd agents + runbook.
- `kernel-memory/.gitignore` — added runtime-log + identity.hash ignores.

## Decisions Made
- **e2e contract is authoritative for export names.** The RED `skeleton.e2e.test.ts` imports `startIpcServer` and `runTick` (the plan's prose said `startIpc`/`enqueue`/`drain`). I provided BOTH: `startIpc(onFrame)`/`send` + a `startIpcServer()` convenience wired to the loop, and `enqueue`/`drain` + a `runTick()` e2e entry. No contract was weakened — the plan's named exports all exist alongside the e2e-required ones.
- **drain() awaits the in-flight pass.** When a pass is already running, `drain()`/`runTick()` return the in-flight promise (callers await completion) rather than returning early. This keeps the single-pass guard intact while giving deterministic "await the tick" semantics the e2e and loop tests rely on.
- **Loop→server decoupling via a reply callback.** The loop surfaces replies through `intent.reply(text)` (a closure the server provides that pushes a `reply` frame). The loop imports nothing from the server, so there is no import cycle; the only edge is server→loop via `enqueue`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2/3 - Missing Critical / Blocking under launchd] Heartbeat plist needed StandardOutPath**
- **Found during:** Task 4 (manual launchd gate).
- **Issue:** The heartbeat plist set only `StandardErrorPath`. Under launchd, stdout is left unconnected when `StandardOutPath` is unset; `pino` writes structured events to fd 1, so the launchd-run path needs an explicit stdout destination (the daemon plist already had both). This is the T-01-13 "dies silently under launchd" surface.
- **Fix:** Added `StandardOutPath` → `kernel-memory/logs/heartbeat.out.log` to `com.kernel.heartbeat.plist`, mirroring the daemon plist.
- **Files modified:** `launchd/com.kernel.heartbeat.plist`
- **Verification:** `plutil -lint` passes; `grep heartbeat.out.log` present.
- **Committed in:** `16a3bfb` (fix).

**2. [Rule 3 - Blocking, hygiene] kernel-memory runtime artifacts left untracked**
- **Found during:** Task 4 (after the test/gate runs seeded `self/identity.hash` and `logs/{today}.md`).
- **Issue:** Test/gate runs legitimately created the first-run IDENTITY baseline and appended log entries in the separate `kernel-memory` repo; these were untracked and would pollute that repo's history.
- **Fix:** Added `logs/*.md`, `logs/*.log`, and `self/identity.hash` to `kernel-memory/.gitignore` (the baseline is re-seeded on first run; logs are raw runtime events future phases distill). Removed the test-noise dated log. `logs/.gitkeep` preserves the dir. Finance assertion stays clean.
- **Files modified:** `kernel-memory/.gitignore`
- **Verification:** `git -C kernel-memory ls-files | grep -i finance` → empty; identity baseline hash matches the committed IDENTITY.md.
- **Committed in:** `8ff5a9f` (kernel-memory repo).

---

**Total deviations:** 2 auto-fixed (1 missing-critical/blocking launchd config, 1 blocking hygiene). No production-code behavior deviations — protocol/server/loop/log/heartbeat/index implemented as specified; the only added export surfaces (`startIpcServer`, `runTick`) were required by the pre-existing RED e2e contract.
**Impact on plan:** All within scope (the heartbeat fix is required for the launchd-run path; the gitignore keeps the memory repo clean). The frozen frame contract and the loop's idle/serial semantics match the plan and RESEARCH.md exactly.

## launchd Gate Results (Task 4)

Per the owner directive, the manual gate was attempted non-interactively. Verifiable results:

- **Build:** `cd daemon && npm run build` produced `daemon/dist/index.js` (the plists point at it). ✅
- **plutil -lint:** both `com.kernel.daemon.plist` and `com.kernel.heartbeat.plist` pass `OK` (template and the real-path installed copies). ✅
- **Daemon plist well-formed + points at the built dist:** `launchctl print` confirms `program = /usr/local/bin/node`, args include `…/daemon/dist/index.js`, env has the explicit `PATH` + `KERNEL_MEMORY_DIR`, and `StandardOut/ErrorPath` are set. ✅
- **`launchctl bootstrap` IS permitted:** `launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.kernel.heartbeat.plist` returned exit 0; the job registered in the `gui/501` domain with the correct environment. ✅
- **Heartbeat write contract verified:** running the heartbeat under a launchd-IDENTICAL environment (`env -i` with only `KERNEL_MEMORY_DIR` + `PATH`, stdin `/dev/null`, stdout/stderr to the real log files) exited code 0 and appended `heartbeat <ISO>` to `kernel-memory/logs/{today}.md` — verified 4×. ✅
- **Cleanup:** `launchctl bootout` removed the heartbeat registration; the installed plist copies in `~/Library/LaunchAgents/` were removed; no stuck node processes remain; both services deregistered. ✅

### Known launchd-runtime quirk (recorded, not a code defect)
When the heartbeat job is fired by launchd itself (`launchctl kickstart`), the spawned `node …/dist/index.js --heartbeat` process **hangs in node startup** (`node::LoadEnvironment → StartExecution`, per `sample`) and never reaches user code — so it does not append a line and does not exit. The SAME binary with the SAME environment (verified via `env -i`, including stdin `/dev/null` and file-redirected stdout/stderr) runs to completion in ~50 ms. The launchd-inherited environment is clean (only `SSH_AUTH_SOCK`; no `NODE_OPTIONS`/inspector triggers). This is a node-under-launchd startup quirk on this machine, not a defect in KERNEL — the heartbeat code path is proven correct. Three fix attempts were spent (added `StandardOutPath`; bootout+rebootstrap to pick up the plist change; kickstart with/without `-k` and extended polling) before recording it per the owner directive.

### Documented manual checks for the owner (cannot be done in this non-interactive run)
1. **Heartbeat fires on schedule under launchd.** Investigate the node-startup hang on this machine (try a different absolute node, e.g. an fnm/Homebrew node, or wrap the entry in a tiny shell launcher), then `launchctl kickstart -k gui/$(id -u)/com.kernel.heartbeat` and confirm a fresh `heartbeat …` line appends to `kernel-memory/logs/{today}.md`. The runbook (`launchd/README.md` §5) has the commands.
2. **Daemon relaunch-at-login.** Fill the daemon plist placeholders (`launchd/README.md` §1), `cp` into `~/Library/LaunchAgents/`, `launchctl bootstrap gui/$(id -u) …com.kernel.daemon.plist`, confirm `launchctl print` shows it running and the UDS exists at `~/Library/Application Support/Kernel/kernel.sock`; then log out/in (or `bootout` + `bootstrap`) and confirm it is running again (§6).
3. **Face attach/detach/re-attach over the UDS without a daemon restart.** With the daemon bootstrapped, run a small Node UDS client (the helper in `server.test.ts`/`skeleton.e2e.test.ts`), confirm `ready` + a `reply` to an `utterance`, disconnect and re-attach. (The automated e2e already proves attach + ready + reply against an in-process server; the manual check confirms it against the launchd-managed daemon.)
4. **IDENTITY tamper guard (recommended).** Edit `kernel-memory/IDENTITY.md` out of band, restart the daemon, confirm it FAILS LOUD on the hash mismatch in `kernel-memory/logs/daemon.err.log`, then restore the file (and delete `self/identity.hash` only if a deliberate human re-baseline is intended).

## Issues Encountered
- **loop test race (resolved during Task 2):** the first loop-test draft read the log before the background `void drain()` (triggered inside `enqueue`) had finished, causing an `ENOENT`/`0 !== 2`. Root-fixed by making `drain()` track and return an in-flight promise so `await drain()` awaits the active pass instead of returning early — a real semantics improvement, not just a test patch. Full suite green afterward.
- **launchd kickstart hang:** see "Known launchd-runtime quirk" above — recorded as a documented manual check per the owner directive; does not block the plan.

## User Setup Required
None for the automated skeleton (no external service config in Phase 1). The launchd install is an owner action documented in `launchd/README.md` and the manual checks above — not a blocking USER-SETUP item for this plan.

## Known Stubs
- `daemon/src/brain/StubBrain.ts` (from 01-01) remains the in-process brain behind `BrainProvider`; the loop routes through `brain.reason()` and exposes `setBrain()` so Phase 3 `ClaudeBrain`/`LocalBrain` drop in. By design, not a defect.
- The loop's **act** step is a documented P2+ dispatch seam (`if (decision.action) { /* P2+: router.dispatch */ }`) — no tools exist in P1, so a decision never carries an action. Intentional per the plan.

## Threat Flags
None new. The plan's threat register is satisfied: T-01-09 (partial-frame + safeParse + error-frame, never crash), T-01-10 (UDS under Application Support, no TCP), T-01-11 (IDENTITY verify at startup, fail loud), T-01-12 (finance ls-files assertion, fail loud), T-01-13 (absolute node + explicit PATH + StandardOut/ErrorPath; tested under a launchd-identical env). No new network endpoints, auth paths, or trust-boundary schema beyond the planned UDS contract.

## Verification Results
- `cd daemon && npm run build` (tsc) → **PASS** (clean).
- `cd daemon && npm test` (full suite) → **46 tests, 46 pass, 0 fail** — including `skeleton.e2e.test.ts` (now GREEN: ready frame, utterance→reply StubBrain echo, `## Session` log block, IDENTITY-first injection ≤16K).
- Task 1 verify: `npx tsx --test src/ipc/protocol.test.ts src/ipc/server.test.ts src/memory/log.test.ts` → 12/12.
- Task 2 verify: `npm run build && npx tsx --test src/loop.test.ts test/heartbeat.test.ts && npx tsx --test test/skeleton.e2e.test.ts` → loop+heartbeat 5/5; e2e GREEN.
- Task 3 verify: `plutil -lint` both plists OK; `RunAtLoad`+`KeepAlive` on daemon; `StartCalendarInterval`+`--heartbeat`+`KERNEL_MEMORY_DIR` on heartbeat.
- launchd gate: `launchctl bootstrap` permitted (exit 0); heartbeat write contract verified under a launchd-identical env; daemon plist well-formed and points at the built dist; login-relaunch + launchd-fired heartbeat recorded as documented manual checks (see launchd Gate Results).

## Next Phase Readiness
- ROADMAP success criteria 1 (daemon persists + event-driven loop idles), 3 (timed heartbeat appends a dated entry — code path verified; on-schedule firing is the recorded manual check), and 5 (UDS attach without restart) are satisfied at the code level; the full skeleton tick is GREEN.
- Phase 2 hooks are ready: the loop's `act` step is the `router.dispatch` + safety-gate seam; the frozen `protocol.ts` is the contract the Swift Face attaches to; `speak`/`widget.data` frames are pre-authored.
- Phase 3 hooks: `setBrain()` swaps `StubBrain` → `ClaudeBrain`/`LocalBrain` behind the same `reason()` seam.
- One owner action carried forward: resolve the node-under-launchd startup hang on this machine and run the 4 documented manual launchd checks before declaring the on-device daemon "live."

## Self-Check: PASSED

All 14 created files + the SUMMARY verified on disk. All 4 code-repo commits (`61da294`, `d26df2b`, `ea11bd7`, `16a3bfb`) and the kernel-memory repo commit (`8ff5a9f`) verified present in git log. Full suite re-run: 46/46 green including `skeleton.e2e.test.ts`.

---
*Phase: 01-skeleton*
*Completed: 2026-06-22*
