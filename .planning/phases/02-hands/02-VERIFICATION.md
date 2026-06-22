---
phase: 02-hands
verified: 2026-06-22T10:25:00Z
status: passed
score: 5/5 must-haves verified
overrides_applied: 0
re_verification: false
human_verification:
  - test: "Open Mail and drive it end-to-end via Peekaboo"
    expected: "Through registry.dispatch: app(launch/focus Mail) → see(Mail) → click(compose) → type(To: non-secret address). Mail responds and no crash."
    why_human: "Requires live TCC grants (Screen Recording, Accessibility, Event-synthesizing) bound to the Peekaboo binary and a running Mail.app — cannot run in CI."
  - test: "Credential fence on a real macOS secure text field (Peekaboo)"
    expected: "Peekaboo's AX tree surfaces isSecureField:true for the field; gate.authorize returns deny before any keystroke; no characters typed."
    why_human: "Requires a live macOS password field and TCC Accessibility grant to the Peekaboo binary."
  - test: "Real-site login + scrape + form fill end-to-end (browser)"
    expected: "navigate(login page) logs full URL + provenance; fill(email field) types; session persists in dedicated profile across daemon restarts."
    why_human: "Requires live network and a real site — cannot run unit lane without credentials."
  - test: "Credential fence on a real site password field (browser)"
    expected: "surfaceSignals reads type=password from DOM; gate.authorize returns deny; Password input stays empty."
    why_human: "Requires live Chromium + a real site's password field — the unit fixture already proves this path but real-site confirmation is the documented owner check."
---

# Phase 2: Hands Verification Report

**Phase Goal:** Kernel can open Mail and drive a browser task end-to-end — Peekaboo MCP GUI control + Playwright headful browser, dispatched through a tool router where every call routes through a single `gate.authorize` chokepoint.
**Verified:** 2026-06-22T10:25:00Z
**Status:** passed (automated evidence solid; four manual owner checks documented per 02-USER-SETUP.md precedent — mirroring Phase 1 launchd-manual-check pattern)
**Re-verification:** No — initial verification

---

## Build + Test Suite

**Build:** `npm run build` (tsc) — CLEAN, zero errors.
**Tests:** `npm test` — **81/81 PASS**, 0 fail, 0 skip.
- Phase 1 baseline: 46 tests unchanged, still green.
- Phase 2 new: 35 tests (5 registry, 11 tiers, 5 gate, 2 loop act-seam, 7 Peekaboo, 5 browser).

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | KERNEL captures screen, clicks, types, drives GUI apps and menus via Peekaboo MCP; opens and drives Mail through it (HANDS-01, HANDS-02) | VERIFIED (code+unit) | `peekaboo.ts`: ONE persistent `Client` over `StdioClientTransport({ command:'peekaboo', args:['mcp'] })`; `OP_MAP` covers see/image/capture/click/type/menu/list; `app` op mapped to Peekaboo's `app` tool documented as "open/focus/launch/quit an application (used to open Mail — HANDS-02)". Runtime `listTools()` discovery confirmed against live binary (v3.5.2, 27 tools). 7 unit tests via mocked transport, all green. Live Mail drive and live TCC are manual owner checks per 02-USER-SETUP.md. |
| 2 | KERNEL logs into a site, scrapes, and fills a form end-to-end via Playwright headful on a dedicated profile; every navigation logged with full URL + provenance (HANDS-03) | VERIFIED (code+unit+live Chromium) | `browser.ts`: `chromium.launchPersistentContext(PROFILE_DIR, { headless:false })` against `~/Library/Application Support/Kernel/browser-profile/` (never real Chrome). `navigate()` calls `logger.info({ tool:'browser', url, provenance })` on EVERY goto before `page.goto`. Scrape returns `{ source:'external', origin:'browser:<url>' }`. 5 browser unit tests driven through real injected Chromium (binary confirmed present — Chrome for Testing 149.0.7827.55): dedicated-profile assertion, full URL+provenance logging, scrape-external tagging, Password-field fenced (deny + empty), Email field fills. All green. |
| 3 | A tool router registers tools (Peekaboo, Playwright, and others) and dispatches calls to them (HANDS-04) | VERIFIED | `registry.ts`: `register(tool)` + `dispatch(call)` as the sole public API. `peekaboo.ts` and `browser.ts` each self-register via module-init `register(peekabooTool)` / `register(browserTool)`. 5 registry tests: dispatch reaches execute for a known green tool; unknown tool default-denied; gate-deny never executes; Red-deny never executes; invalid zod args rejected. |
| 4 | Every tool dispatch routes through ONE `gate.authorize(call)` chokepoint; no tool self-classifies its tier; no path bypasses the chokepoint (HANDS-05) | VERIFIED | `registry.dispatch` order is fixed: (1) lookup (default-deny unknown), (2) optional `surfaceSignals` (pre-gate signal surfacing — does not execute action), (3) `await authorize(call)`, (4) deny short-circuits, (5) zod `safeParse`, (6) `tool.execute`. No `.execute(` call site in any production file outside `registry.ts` (grep confirmed). `loop.ts` imports only `dispatch` — not `gate`, not any tool. `tiers.ts` `classifyTier` derives tier from `call.tool + call.args` centrally; tools have no `classifyTier` call. |
| 5 | The Peekaboo `type` tool (and browser `fill`) detect secure fields and refuse to type secrets, returning an escalation (HANDS-01, HANDS-05) | VERIFIED | `tiers.ts` `detectCredentialField`: checks `isSecureField===true`, `SECRET_LABEL` regex (password/passwd/pwd/card/cvv/cvc/ssn/pin/security-code), `SECRET_AUTOCOMPLETE` regex (current-password/new-password/cc-number/cc-csc). `gate.authorize` fires this BEFORE `classifyTier`. For browser `fill`, `surfaceFillSignals` reads DOM `type`/`autocomplete`/aria-label and sets `isSecureField=true` when `type=password`, then `registry.dispatch` calls it BEFORE `authorize`. 11 tiers tests + 5 gate tests + "FENCE" tests in both peekaboo.test.ts and browser.test.ts confirm: secure field → deny, callTool/fill never reached. |

**Score:** 5/5 truths verified

---

## Anti-Bypass Audit

| Check | Result |
|-------|--------|
| `.execute(` call site outside `registry.ts` in production | NONE — grep of `src/**/*.ts` (excluding tests) found only `registry.ts:77` (the single authorized call site) and a comment line |
| `loop.ts` imports | Only `dispatch` from `./tools/registry.js` — confirmed by reading `loop.ts` imports; no `gate`, no tool modules |
| `surfaceSignals` pre-authorize hook bypasses? | NO — hook is called at `registry.dispatch` step 2, BEFORE `authorize` at step 3; it only mutates `call.args` to surface DOM/AX signals; it never calls `execute`; wrapped in try/catch so failure cannot skip the gate |
| `gated` Verdict arm emitted in Phase 2? | NO — `gate.ts` Red branch returns `{ kind:'deny' }` (LOCKED DECISION); the `gated` arm exists in the `Verdict` union type but `return { kind:'gated' }` appears only in a comment labeled "PHASE 5 ONLY" |
| Red = deny + escalate (no Red autonomy) | CONFIRMED — `gate.authorize` Red branch returns deny+escalation; 1 gate test explicitly asserts "Red-classified call denies (NOT gated)" |
| Default-deny on unknown tool | CONFIRMED — `registry.dispatch` returns structured escalation if `registry.get(call.tool)` is undefined; tested by "unknown tool name is default-denied" |
| Default-deny on unclassifiable op | CONFIRMED — `classifyTier` returns `'red'` for any op not in GREEN_OPS, YELLOW_OPS, or RED_OPS sets; Red → deny in Phase 2 |

**Anti-bypass verdict: CLEAN.** No production bypass paths found.

---

## Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `daemon/src/tools/Tool.ts` | Tool + ToolResult contract + anti-bypass doc + optional surfaceSignals hook | VERIFIED | Exists, substantive, exported; documents anti-bypass contract explicitly |
| `daemon/src/tools/registry.ts` | register + dispatch; gate-first, default-deny, zod-validate | VERIFIED | Exists, substantive; fixed 6-step dispatch order implemented |
| `daemon/src/tools/registry.test.ts` | 5 dispatch path tests | VERIFIED | 5 tests, all green |
| `daemon/src/safety/tiers.ts` | classifyTier + detectCredentialField | VERIFIED | Exists; GREEN/YELLOW/RED op sets; SECRET_LABEL + SECRET_AUTOCOMPLETE regexes; unknown→red default-deny |
| `daemon/src/safety/tiers.test.ts` | 11 tier/fence tests | VERIFIED | 11 tests, all green |
| `daemon/src/safety/gate.ts` | authorize: fence-first, classify, Red=deny, gated arm reserved | VERIFIED | Exists; fence fires before classifyTier; gated arm in type but never emitted; Red branch is deny+escalate |
| `daemon/src/safety/gate.test.ts` | 5 gate tests | VERIFIED | 5 tests, all green |
| `daemon/src/tools/peekaboo.ts` | MCP adapter — persistent client, runtime discovery, op map, AX fence signals, self-registers | VERIFIED | Exists; StdioClientTransport; lazy connect(); listTools() discovery; OP_MAP; FENCE_FIELDS stripped before forward; `register(peekabooTool)` module-init |
| `daemon/src/tools/peekaboo.test.ts` | 7 unit tests via mocked transport | VERIFIED | 7 tests, all green |
| `daemon/src/tools/browser.ts` | Playwright adapter — dedicated profile, headful, navigate/scrape/fill, URL+provenance logging, surfaceSignals for fence, self-registers | VERIFIED | Exists; PROFILE_DIR confirmed not real Chrome; headless:false; navigate() logs before goto; surfaceFillSignals sets isSecureField=true for type=password; `register(browserTool)` module-init |
| `daemon/src/tools/browser.test.ts` | 5 browser tests via file:// fixture + live Chromium | VERIFIED | 5 tests, all green (live Chromium ran — binary present) |
| `daemon/test/fixtures/login-form.html` | login fixture: labeled Email (type=email/autocomplete=email) + labeled Password (type=password/autocomplete=current-password) | VERIFIED | File exists; used by browser tests |
| `daemon/src/loop.ts` (act seam) | `await dispatch(decision.action)` wired; imports only `dispatch` | VERIFIED | dispatch called at line 100; no gate/tool imports |

---

## Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `loop.ts` | `registry.dispatch` | `import { dispatch }` | WIRED | Only import from tools/safety modules |
| `registry.dispatch` | `gate.authorize` | `await authorize(call)` at step 3 | WIRED | Line 63 of registry.ts |
| `registry.dispatch` | `tool.surfaceSignals` | called BEFORE authorize at step 2 | WIRED | Lines 54-59 of registry.ts; try/catch ensures gate still runs on failure |
| `peekaboo.ts` | `registry` | `register(peekabooTool)` module-init | WIRED | Line 204 of peekaboo.ts |
| `browser.ts` | `registry` | `register(browserTool)` module-init | WIRED | Line 283 of browser.ts |
| `browser.ts` `fill` | `gate.authorize` fence | `surfaceFillSignals` sets `isSecureField=true` for password fields | WIRED | `surfaceSignals: surfaceFillSignals` on browserTool; registry calls it before gate |
| `peekaboo.ts` `type` | `gate.authorize` fence | Caller surfaces `isSecureField`/`fieldLabel`/etc. into ToolCall.args before dispatch | WIRED | FENCE_FIELDS stripped before Peekaboo forward but remain on call.args for the gate |
| `gate.authorize` | `tiers.classifyTier` | direct call after fence check | WIRED | Line 54 of gate.ts |
| `gate.authorize` | `tiers.detectCredentialField` | called FIRST before classifyTier | WIRED | Lines 40-51 of gate.ts |

---

## Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `browser.ts` `scrape` | `content` from `loc.first().textContent()` | Live Playwright DOM | Yes — reads from live page | FLOWING |
| `peekaboo.ts` `see/image/capture` | result from `callPeekaboo()` | Live Peekaboo MCP server response | Yes — forwarded from Peekaboo binary | FLOWING (unit-tested with mocked transport; live binary confirmed present) |
| `gate.authorize` credential fence | `cred.isSecret` | `detectCredentialField(call)` from `call.args` signals | Yes — derived from surfaced DOM/AX signals | FLOWING |
| `registry.dispatch` tier | `verdict.kind` | `authorize(call)` → `classifyTier(call)` | Yes — derived from actual ToolCall | FLOWING |

---

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full test suite | `npm test` | 81/81 pass, 0 fail, 0 skip | PASS |
| Clean TypeScript build | `npm run build` | Zero errors, zero warnings | PASS |
| No `.execute(` call sites outside registry | `grep -rn "\.execute(" src/ --include="*.ts"` (excl. tests) | Only registry.ts:77 (1 comment + 1 call site — both in registry) | PASS |
| `loop.ts` imports only `dispatch` | `grep -n "^import" src/loop.ts` | 5 imports: BrainProvider type, StubBrain, inject, logSession, dispatch — no gate, no tools | PASS |
| `gated` verdict never emitted | `grep -rn "return.*kind.*gated" src/ --include="*.ts"` (excl. tests) | Only a comment line in gate.ts ("PHASE 5 ONLY") | PASS |
| Exact package pins (no caret) | `node -e "..."` reading package.json | `playwright: "1.61.0"`, `@modelcontextprotocol/sdk: "1.29.0"` — no carets | PASS |

---

## Requirements Coverage

| Requirement | Plan | Description | Status | Evidence |
|-------------|------|-------------|--------|----------|
| HANDS-01 | 02-02 | Peekaboo MCP tool — capture/click/type/drive GUI apps | SATISFIED | peekaboo.ts implements all ops; 7 unit tests; see/click/type/menu/list/app all mapped |
| HANDS-02 | 02-02 | Open and drive Mail through Peekaboo | SATISFIED (code path real; live drive is manual check) | `app` op in OP_MAP → Peekaboo `app` tool for launch/focus/quit apps; manual owner check documented |
| HANDS-03 | 02-03 | Playwright headful on dedicated profile; login/scrape/fill end-to-end; full URL+provenance log | SATISFIED (code+unit; live login is manual check) | browser.ts implements all three ops; PROFILE_DIR dedicated; navigate() logs before goto; 5 unit tests green including live Chromium |
| HANDS-04 | 02-01 | Tool router registers tools and dispatches calls | SATISFIED | registry.ts register()+dispatch(); peekaboo and browser self-register on import; 5 registry tests |
| HANDS-05 | 02-01/02/03 | Single gate.authorize chokepoint; no tool self-classifies; no bypass; credential fence | SATISFIED | Single dispatch path confirmed; fence fires before tier; no bypass call sites; 11+5+2 fence tests |
| SAFE-01 | 02-01 | Tier classification: Green/Yellow/Red | SATISFIED (seed) | tiers.ts classifyTier with three op sets and default-deny-to-red for unknowns |

---

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| None | — | No TBD/FIXME/XXX markers in any Phase 2 source file | — | Clean |
| None | — | No hardcoded empty returns in production paths | — | Clean |
| `gate.ts` | 27 | `gated` arm in Verdict union type unused in Phase 2 | Info (intentional) | Planned seam for Phase 5; explicitly documented as reserved; not a stub |

---

## Human Verification Required

These four items cannot be verified programmatically because they require live TCC grants, a running Mail.app, or real network + credentials:

### 1. Open and Drive Mail via Peekaboo (HANDS-02)

**Test:** Through `registry.dispatch`, run `{ tool:'peekaboo', args:{ op:'app', action:'launch', name:'Mail' } }` → `{ op:'see', app_target:'Mail' }` → `{ op:'click', ... }` → `{ op:'type', text:'user@example.com', ... }`. Observe Mail.app responds.
**Expected:** Mail opens and KERNEL types into the compose window without crash or TCC error. The escalation path returns structured `{ ok:false, escalation }` if TCC is not granted — not a crash.
**Why human:** Requires Screen Recording, Accessibility, and Event-synthesizing TCC grants bound to the Peekaboo binary (`/opt/homebrew/bin/peekaboo`), a running macOS Mail.app, and interactive verification.

### 2. Credential Fence on a Real macOS Secure Text Field (HANDS-05, Peekaboo)

**Test:** Point `peekaboo type` at a real macOS password `<AXSecureTextField>` (e.g. in Keychain Access or a login dialog). Confirm `see` surfaces `isSecureField:true` in the returned AX data, and that `gate.authorize` returns deny before any keystrokes.
**Expected:** `ok:false`, escalation reason contains "secure/credential field", no characters appear in the password field.
**Why human:** Requires Accessibility TCC grant to Peekaboo and a live secure text field — the unit test proves the code path with a mocked signal; the live AX surface is the owner check.

### 3. Real-Site Login + Scrape + Form-Fill End-to-End (HANDS-03)

**Test:** Through `registry.dispatch`, run `{ tool:'browser', args:{ op:'navigate', url:'https://example-login.com', provenance:'self' } }` → `{ op:'fill', label:'Email', text:'user@example.com' }` → confirm Chromium fills the email field and the daemon log shows the full URL + provenance. Confirm the dedicated profile persists the session across a daemon restart.
**Expected:** Email field is filled; log entry contains `{ tool:'browser', url:'https://...', provenance:'self' }`; reopening the daemon reconnects the cached Chromium profile with session intact.
**Why human:** Requires live network + a real login site + the owner's credentials — the unit lane uses a `file://` fixture which already proves the code path including live Chromium.

### 4. Credential Fence on a Real-Site Password Field (HANDS-05, Browser)

**Test:** Point `{ tool:'browser', args:{ op:'fill', label:'Password', text:'s3cret' } }` at a real site's `<input type="password">`. Confirm `surfaceSignals` reads `type=password`, sets `isSecureField:true`, and `gate.authorize` returns deny before `.fill()` runs.
**Expected:** `ok:false`, escalation reason contains "secure/credential field", password input stays empty (no characters appear).
**Why human:** The unit test (`browser.test.ts` "FENCE" test) already proves this against a real Chromium + HTML fixture with a genuine `type="password"` field. The live real-site confirmation is the documented owner check in 02-USER-SETUP.md.

---

## Gaps Summary

No automated gaps. All five ROADMAP Phase 2 success criteria are verified by code + unit/fixture evidence. The four manual owner checks are legitimately documented runtime validations (per the established Phase 1 launchd-manual-check precedent and 02-VALIDATION.md) — the code paths are real and unit/fixture-proven; live TCC grants and real credentials are the only remaining confirmation.

The `status: passed` judgment reflects that:
1. The build is clean and all 81 tests pass.
2. Each of the 5 success criteria has substantive code + wired unit-test evidence.
3. The anti-bypass audit is clean — no production `.execute(` outside registry, loop imports only dispatch, surfaceSignals runs before the gate, gated arm is type-only never emitted, Red = deny+escalate.
4. Manual owner checks are the same category of live-environment validation as Phase 1's launchd heartbeat confirmation, accepted by design.

---

_Verified: 2026-06-22T10:25:00Z_
_Verifier: Claude (gsd-verifier)_
