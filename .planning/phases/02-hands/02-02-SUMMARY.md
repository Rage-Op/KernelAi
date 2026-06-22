---
phase: 02-hands
plan: 02
subsystem: tools
tags: [peekaboo, mcp-client, gui-automation, credential-fence, runtime-discovery, provenance, stdio-transport, hands-01, hands-02, hands-05]

# Dependency graph
requires:
  - phase: 02-hands
    provides: "02-01: tools/Tool.ts (Tool/ToolResult contract), tools/registry.ts (register/dispatch — the single gate-first chokepoint), safety/gate.ts + safety/tiers.ts (detectCredentialField fence)"
  - phase: 01-foundation
    provides: "memory/types.ts (ContextItem/Provenance), memory/log.ts (logger)"
provides:
  - "tools/peekaboo.ts — MCP-client adapter (StdioClientTransport → brew Peekaboo binary); ONE persistent Client; runtime tool discovery via listTools(); op→callTool mapping; AX secure-field signals surfaced into ToolCall.args for the fence; see/image/capture/list output tagged source:'external'; self-registers peekabooTool into the router"
  - "tools/peekaboo.test.ts — 7 unit tests with a MOCKED MCP transport (no real server / TCC)"
  - "Exact pin @modelcontextprotocol/sdk@1.29.0 (no caret) in daemon/package.json + lockfile"
affects: [02-03-browser, 03-brain, 05-money-tier-gate]

# Tech tracking
tech-stack:
  added:
    - "@modelcontextprotocol/sdk@1.29.0 (exact pin, no caret) — MCP client (Client + StdioClientTransport)"
  patterns:
    - "MCP-client adapter over StdioClientTransport spawning a system binary (Peekaboo = brew binary, NOT an npm dep)"
    - "ONE persistent Client reused across calls (lazy connect(), cached; never respawn per dispatch)"
    - "Runtime tool discovery via listTools() — OP_MAP maps KERNEL ops to discovered Peekaboo tool NAMES; arg keys come from the live server, never hardcoded"
    - "Adapter surfaces AX secure-field signals (isSecureField/fieldLabel/fieldName/placeholder/autocomplete) into ToolCall.args at the READ site so the 02-01 fence is the data consumer; the adapter never decides to refuse"
    - "External-sourced GUI reads tagged source:'external' (Phase-1 ContextItem/Provenance) at the read site"
    - "Probe-then-escalate on TCC failure: attempt the op, catch the thrown MCP error, return a structured { ok:false, escalation } — never crash the loop"
    - "Test-only DI seam (__setClientForTest) to inject a mocked MCP client for the unit lane"

key-files:
  created:
    - daemon/src/tools/peekaboo.ts
    - daemon/src/tools/peekaboo.test.ts
  modified:
    - daemon/package.json
    - daemon/package-lock.json

key-decisions:
  - "Peekaboo binary WAS reachable in this environment (/opt/homebrew/bin/peekaboo, v3.5.2); did a LIVE end-to-end MCP listTools() discovery (27 tools) to confirm real arg schemas — but the adapter still discovers at runtime and is unit-tested against a MOCKED transport, never the live binary."
  - "OP_MAP maps op 'press' → Peekaboo 'hotkey' (live discovery confirmed Peekaboo has no separate 'press' MCP tool; key presses go through 'hotkey')."
  - "Fence-signal fields (isSecureField/fieldLabel/...) are stripped from the payload before forwarding to Peekaboo (Peekaboo would reject unknown keys) but remain on call.args where the gate already inspected them."
  - "Module-init register() side effect: importing peekaboo.ts wires the tool into the router (HANDS-04 pattern)."

patterns-established:
  - "MCP-client tool adapter behind the single gate (register on import; reached only via registry.dispatch)"
  - "Runtime listTools() discovery instead of hardcoded MCP arg schemas"
  - "Adapter-surfaces-signals / gate-decides split for the credential fence"

requirements-completed: [HANDS-01, HANDS-02, HANDS-05]

# Metrics
duration: ~9 min
completed: 2026-06-22
---

# Phase 2 Plan 02: Peekaboo MCP Adapter Summary

**A `tools/peekaboo.ts` MCP-client adapter that drives the brew-installed Peekaboo binary over stdio (one persistent `Client`, runtime `listTools()` discovery, op→`callTool` mapping) to capture/click/type/menu and open+drive Mail — registered into the 02-01 router so every GUI action passes the gate, with the `type` op surfacing AX secure-field signals so the credential fence refuses secrets before any keystroke.**

## Performance
- **Duration:** ~9 min
- **Completed:** 2026-06-22
- **Tasks:** 3 (1 pre-cleared checkpoint, 2 auto)
- **Files:** 4 (2 created, 2 modified)
- **Tests:** full suite 76/76 green (69 prior + 7 new Peekaboo unit tests)

## Peekaboo Binary Availability (notable)
The live Peekaboo binary **WAS reachable** in this environment: `/opt/homebrew/bin/peekaboo`, version **3.5.2**, launch command **`peekaboo mcp`** (confirmed via `peekaboo mcp --help` — "Start MCP server on stdio"). A one-shot LIVE end-to-end MCP `listTools()` discovery succeeded: the SDK `Client` connected over `StdioClientTransport`, listed **27 tools**, and returned real arg schemas. Confirmed live shapes (the adapter still discovers these at runtime, never hardcodes them):
- `type`: `text`, `on`, `app`, `clear`, `press_return`, `delay`, `wpm`, … (no `op` field — Peekaboo uses the tool NAME as the op)
- `click`: `on`, `query`, `coords`, `double`, `right`, `wait_for`, `foreground`
- `see`: `app_target`, `annotate`, `max_depth`, `max_elements`, `path`
- `image`/`capture`: capture targets/format/region
- `menu`: `action`, `app`, `path`, `item`
- `list`: `item_type`, `app`, `include_window_details`
- `app`: `action`, `name`, `to`, … (used to launch/focus Mail — HANDS-02)

This live reachability is informational; per the validation split the adapter is **unit-tested with a MOCKED transport only**. The real Mail open/drive and the fence on a real secure field remain documented MANUAL owner gates (see below).

## Accomplishments
- Installed and **exactly pinned** `@modelcontextprotocol/sdk@1.29.0` (stripped the `^` npm injects, re-resolved the lockfile — Phase-1 discipline). Verified both pinned subpaths resolve: `@modelcontextprotocol/sdk/client/index.js` (`Client`) and `@modelcontextprotocol/sdk/client/stdio.js` (`StdioClientTransport`).
- Built `tools/peekaboo.ts`: lazy `connect()` caches ONE `Client` over a `StdioClientTransport({ command:'peekaboo', args:['mcp'] })` (single named constant `PEEKABOO_COMMAND`/`PEEKABOO_ARGS`); `discover()` → `listTools()`; `callPeekaboo(name,args)` → `callTool({ name, arguments })`.
- Defined and exported `peekabooTool: Tool` (02-01 contract). zod envelope tightly constrains `op` (so the gate classifies a known op) and is permissive/passthrough on per-op args (the precise Peekaboo keys come from `listTools()` at runtime). `execute` maps `op` → discovered tool name via `OP_MAP`, strips KERNEL-only envelope keys, forwards runtime args.
- **HANDS-05 fence wiring (load-bearing):** for `type`, the adapter surfaces `isSecureField`/`fieldLabel`/`fieldName`/`placeholder`/`autocomplete` into `ToolCall.args` at the read site. The adapter does NOT decide to refuse — `gate.authorize`'s `detectCredentialField` (02-01) classifies what the adapter surfaces and denies before any keystroke.
- `see`/`image`/`capture`/`list` output tagged `source:'external'` (Phase-1 `ContextItem`/`Provenance`) — external GUI content tainted at the read site.
- **Probe-then-escalate:** any Peekaboo/MCP failure (e.g. a missing TCC grant) is caught and returned as `{ ok:false, escalation }` with a "grant Screen Recording / Accessibility / Event-synthesizing to the Peekaboo binary" recommendation — never a crash.
- Self-registers via a module-init `register(peekabooTool)` side effect (HANDS-04); `execute` is reachable only through `registry.dispatch`.
- 7 unit tests (mocked MCP transport, driven THROUGH `registry.dispatch`): runtime discovery (reads the fixture, not a literal); op→callTool mapping; `see` tagged external; **a derived-secure `type` is DENIED and `callTool` is NEVER invoked**; a non-secret `type` ("To") reaches `callTool`; a TCC failure escalates without throwing; `callPeekaboo` forwarding.

## Task Commits
1. **Task 1 (checkpoint, PRE-CLEARED):** package legitimacy + Peekaboo launch command — `@modelcontextprotocol/sdk@1.29.0` is canonical (slopcheck `[OK]`, official repo); Peekaboo binary confirmed installed (`peekaboo 3.5.2`, `peekaboo mcp`). No separate commit (verification step).
2. **Task 2: Peekaboo MCP adapter** — `4c6a05b` (feat) — `peekaboo.ts` + exact SDK pin + lockfile.
3. **Task 3: adapter unit tests (mocked transport)** — `a7db900` (test).

## Decisions Made
- **Live binary present but mock-tested.** The environment had a working Peekaboo 3.5.2 and a live MCP discovery succeeded, but the unit lane uses a MOCKED transport per the validation split (no TCC/live-app dependency in CI). Live reachability is recorded, not relied upon.
- **`op:'press'` → Peekaboo `hotkey`.** Live `listTools()` confirmed Peekaboo has no separate `press` MCP tool; key presses route through `hotkey`. Documented in `OP_MAP`.
- **Fence signals stripped before forwarding.** `isSecureField`/`fieldLabel`/etc. are KERNEL-side classifier inputs, not Peekaboo args, so they are removed from the forwarded payload (Peekaboo rejects unknown keys) while remaining on `call.args` for the gate.

## TDD Gate Compliance
Task 3 is `tdd="true"`. The adapter implementation (Task 2, `feat` commit `4c6a05b`) preceded the test file (Task 3, `test` commit `a7db900`) because the plan ordered Task 2 (build) before Task 3 (test) and the adapter is the larger surface. The 7 tests were authored against the 02-01 dispatch/fence contract and ran green on first execution (no implementation drift needed). Gate sequence note: a strict RED-before-GREEN ordering was not enforced (the `feat` landed before the `test`), matching the plan's explicit task ordering. The behavioral contract is fully covered — fence-denies-secure-type, op→callTool mapping, runtime discovery, external tagging, TCC escalation.

## Deviations from Plan
None — plan executed exactly as written. The pre-cleared Task-1 checkpoint resolved favorably (SDK canonical, Peekaboo binary present), so no brew-unavailable fallback or npm-`@steipete/peekaboo` gated decision was needed.

**Total deviations:** 0.
**Impact:** None. All three tasks landed as specified; the only adaptation was confirming `press → hotkey` from live discovery, which the runtime-discovery design already anticipated.

## Manual Owner Checks (documented — gate the phase, NOT this plan)
Per 02-VALIDATION.md and RESEARCH.md (TCC + live apps cannot run in CI). The Peekaboo binary is installed here, but these still require interactive TCC grants and a live Mail UI:
1. **Grant TCC to the Peekaboo binary** (NOT shared `node`): Screen Recording, Accessibility, Event-synthesizing — System Settings → Privacy & Security. Verify with `peekaboo permissions`.
2. **Real Mail open/drive (HANDS-02):** through `registry.dispatch`, run `app`(launch/focus Mail) → `see`(Mail) → `click`(compose) → `type`(To: a non-secret address) and confirm Mail responds.
3. **Fence on a REAL secure field (HANDS-05):** point the adapter at a real macOS password field; confirm `see` surfaces `isSecureField:true` and the gate refuses the `type` (no keystrokes synthesized).
4. **TCC survives a rebuild:** confirm grants bound to the stable brew Peekaboo path persist across a daemon rebuild (Pitfall 9).

## Threat Surface
No new security surface beyond the plan's `<threat_model>`.
- **T-02-03 (credential type):** mitigated — adapter surfaces AX secure-field signals; the 02-01 gate hard-denies before keystrokes. Unit test: a derived-secure `type` is denied and `callTool` is never reached.
- **T-02-07 (TCC over-grant):** mitigated — owner check binds TCC to the Peekaboo binary, not `node`; probe-then-escalate on missing grants (no crash, no silent over-privilege).
- **T-02-08 (confused-deputy misclick):** mitigated — element-ID/query targeting (`on`/`query`) over coordinates; runtime `listTools()` discovery so a Peekaboo update can't silently break arg shapes.
- **T-02-SC (npm install):** mitigated — `@modelcontextprotocol/sdk@1.29.0` slopcheck `[OK]`, official repo, pinned exactly; Peekaboo is the brew binary (no npm `@steipete/peekaboo` postinstall in node_modules).

## Known Stubs
None. No hardcoded empty values, placeholder text, or unwired data sources. The adapter is wired end-to-end against the live tool catalog (confirmed by the one-shot live discovery) and unit-tested via a mocked transport; the only runtime requirement is the TCC grants, carried as documented owner checks.

## Self-Check: PASSED
- Both key files exist on disk: `daemon/src/tools/peekaboo.ts`, `daemon/src/tools/peekaboo.test.ts`.
- Both task commits exist in git log: `4c6a05b` (feat), `a7db900` (test).
- Plan-level verification re-run: full suite **76/76 green**; `@modelcontextprotocol/sdk` pinned exactly `1.29.0` with no caret; both pinned subpaths present, wrong `@modelcontextprotocol/client` absent; `listTools` present (runtime discovery); `register(` present (self-registration); no `.execute(` call site outside the registry.
- key_links confirmed: `register(peekabooTool)` in `peekaboo.ts`; `isSecureField`/`fieldLabel` surfaced for the `type` op; imports from the pinned `/sdk/client/index.js` + `/sdk/client/stdio.js` subpaths.

## Next Phase Readiness
- KERNEL now has macOS GUI hands behind the single gate, with the credential fence's data source wired. Ready for **Plan 02-03 (Playwright browser)** which registers the same way and runs the same fence on `fill`.
- Manual owner checks (Mail open, fence-on-real-secure-field, TCC survival) gate the Phase-2 close-out, not this plan.

---
*Phase: 02-hands*
*Completed: 2026-06-22*
