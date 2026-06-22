---
phase: 02-hands
plan: 03
subsystem: tools
tags: [playwright, headful-browser, dedicated-profile, navigation-logging, provenance, credential-fence, scrape-external, role-label-locators, hands-03, hands-05]

# Dependency graph
requires:
  - phase: 02-hands
    provides: "02-01: tools/Tool.ts (Tool/ToolResult contract), tools/registry.ts (register/dispatch — the single gate-first chokepoint), safety/gate.ts + safety/tiers.ts (detectCredentialField fence)"
  - phase: 01-foundation
    provides: "memory/types.ts (ContextItem/Provenance), memory/log.ts (logger)"
provides:
  - "tools/browser.ts — Playwright headful adapter on a DEDICATED persistent profile dir (never the real Chrome); ONE reused BrowserContext; navigate/scrape/fill with full-URL+provenance logging on every goto; scrape tagged source:'external'; fill surfaces DOM secure-field signals (type/autocomplete/label) into ToolCall.args via a pre-authorize surfaceSignals hook so the 02-01 fence refuses secrets before .fill(); self-registers browserTool into the router"
  - "tools/browser.test.ts — 5 unit tests against a file:// fixture (live headless Chromium injected via __setContextForTest, capability-gated to skip cleanly if the binary is absent)"
  - "test/fixtures/login-form.html — file://-loadable login page (labelled Email + type=password Password + a scrapeable heading)"
  - "tools/Tool.ts — OPTIONAL surfaceSignals(args) pre-authorize hook on the Tool contract (read-site signal surfacing for the fence; backward-compatible — Peekaboo/stub omit it)"
  - "tools/registry.ts — dispatch now runs tool.surfaceSignals(args) BEFORE authorize (still the single chokepoint; never executes the action)"
  - "Exact pin playwright@1.61.0 (no caret) in daemon/package.json + lockfile"
affects: [03-brain, 05-money-tier-gate]

# Tech tracking
tech-stack:
  added:
    - "playwright@1.61.0 (exact pin, no caret) — headful Chromium driver. The Chromium BINARY is downloaded out-of-repo by `npx playwright install chromium` (NOT an npm dep)."
  patterns:
    - "Playwright headful adapter via chromium.launchPersistentContext against a DEDICATED profile dir (never the real Chrome) — headful, no evasion plugins"
    - "ONE persistent BrowserContext reused across calls (lazy, cached at module scope; never respawn per dispatch — 16GB ceiling)"
    - "Pre-authorize surfaceSignals hook on the Tool contract: the registry calls it inside dispatch BEFORE the gate so the credential fence classifies the LIVE DOM truth (type/autocomplete/label) — the adapter surfaces, the gate decides"
    - "Every page.goto logs the full URL + provenance (the egress-logging seam) before navigating"
    - "Web reads tagged source:'external' (Phase-1 ContextItem/Provenance) at the read site"
    - "Role/label/text locators (getByRole/getByLabel/getByText), never brittle CSS or coordinates"
    - "Test-only DI seams (__setContextForTest / __getPageForTest / __resetForTest) to drive a file:// fixture with an injected headless context"

key-files:
  created:
    - daemon/src/tools/browser.ts
    - daemon/src/tools/browser.test.ts
    - daemon/test/fixtures/login-form.html
  modified:
    - daemon/package.json
    - daemon/package-lock.json
    - daemon/src/tools/Tool.ts
    - daemon/src/tools/registry.ts

key-decisions:
  - "Added an OPTIONAL surfaceSignals(args) pre-authorize hook to the Tool contract (and a call to it inside registry.dispatch BEFORE authorize). HANDS-05 for the browser requires the fence to classify LIVE DOM signals (type=password / current-password / accessible label) which only the adapter can read — and that read MUST happen before the gate. The hook keeps dispatch the single chokepoint (it runs within dispatch, never executes the action), and is backward-compatible: Peekaboo and the stub tools omit it. Without this seam the fence could only see brain-provided signals, not the live DOM — bypassing the credential fence for the browser tool."
  - "Chromium binary DOWNLOADED in this environment (`npx playwright install chromium` succeeded — Chrome for Testing 149.0.7827.55, playwright chromium v1228, to ~/Library/Caches/ms-playwright/, outside the repo). So the live-Chromium unit tests RAN (not skipped) here — all 5 green against the file:// fixture. The capability gate remains so CI without the binary still passes."
  - "Tests inject a HEADLESS Chromium (launchPersistentContext to a temp dir) via __setContextForTest rather than launching the adapter's real headful PROFILE_DIR — the unit lane never opens the owner's dedicated profile, and the file:// fixture drives without a window."
  - "PROFILE_DIR = ~/Library/Application Support/Kernel/browser-profile/ — dedicated, outside kernel-memory/ (asserted), so the GitHub backup never touches live session cookies (ASVS V12)."

patterns-established:
  - "Pre-authorize read-site signal surfacing for the credential fence (Tool.surfaceSignals → dispatch runs it before the gate)"
  - "Headful Playwright tool on a dedicated persistent profile behind the single gate (register on import; reached only via registry.dispatch)"
  - "file:// fixture unit lane with a capability-gated live-Chromium check (skip clean when the binary is absent)"

requirements-completed: [HANDS-03, HANDS-05]

# Metrics
duration: ~14 min
completed: 2026-06-22
---

# Phase 2 Plan 03: Playwright Headful Browser Tool Summary

**A `tools/browser.ts` Playwright adapter that opens ONE headful Chromium via `chromium.launchPersistentContext` against a DEDICATED profile dir (never the owner's real Chrome), exposes navigate/scrape/fill end-to-end with every navigation logged full-URL+provenance and scraped content tagged `source:'external'`, and — through a new pre-authorize `surfaceSignals` hook — surfaces DOM secure-field signals (`type=password` / sensitive `autocomplete` / accessible label) into the ToolCall args so the 02-01 credential fence REFUSES secrets before any keystroke; registered into the 02-01 router so every browser action passes the gate.**

## Performance
- **Duration:** ~14 min
- **Completed:** 2026-06-22
- **Tasks:** 3 (1 pre-cleared checkpoint, 1 auto, 1 auto+tdd)
- **Files:** 7 (3 created, 4 modified)
- **Tests:** full suite 81/81 green (76 prior + 5 new browser unit/fixture tests)

## Chromium Availability (notable)
The Chromium browser binary **WAS downloaded in this environment**: `npx playwright install chromium` succeeded — **Chrome for Testing 149.0.7827.55** (playwright chromium **v1228**) plus the headless shell, installed to `~/Library/Caches/ms-playwright/` (OUTSIDE the repo, gitignored-by-location). Because the binary is present, the live-Chromium unit tests **ran here (not skipped)** — all 5 green driving the `file://` fixture through a real (headless, injected) Chromium. The capability gate is retained so a CI host without the binary still passes the profile-dir + non-live assertions cleanly.

## Accomplishments
- Installed and **exactly pinned** `playwright@1.61.0` (stripped the `^` npm injects, re-resolved the lockfile — Phase-1 discipline). Downloaded the Chromium binary out-of-repo via `npx playwright install chromium`.
- Built `tools/browser.ts`: a module-scope `let ctx: BrowserContext | null` + lazy `context()` that opens ONE headful Chromium (`chromium.launchPersistentContext(PROFILE_DIR, { headless: false })`, plain Chromium, no evasion plugins) against `PROFILE_DIR = ~/Library/Application Support/Kernel/browser-profile/` — the DEDICATED dir, never the real Chrome profile, outside `kernel-memory/`. The context is cached and reused across calls (16GB ceiling — never respawn per dispatch).
- `navigate(url, provenance)`: logs `{ tool:'browser', url, provenance }` with the FULL URL on EVERY goto (the egress-logging seam — HANDS-03), then `page.goto(url, { waitUntil:'domcontentloaded' })`.
- `browserTool: Tool` (02-01 contract), `name:'browser'`, zod envelope constraining `op ∈ {navigate, scrape, fill}` (so the gate classifies a known op) with optional locator + fence-signal fields. `execute` switches on `op`: navigate → log+goto; scrape → role/label/text locator → `textContent` tagged `source:'external'`; fill → role/label locator `.fill()` (reached ONLY after the gate allowed). Playwright errors are caught → structured `{ ok:false, escalation }` (never crashes the loop).
- **HANDS-05 fence wiring (load-bearing):** added an OPTIONAL `surfaceSignals(args)` hook to the `Tool` contract and a call to it inside `registry.dispatch` BEFORE `authorize`. For a `fill`, `browser.ts`'s `surfaceFillSignals` reads the target field's DOM `type`/`autocomplete`/accessible-label and writes `fieldType`/`autocomplete`/`fieldLabel`/`isSecureField` onto `call.args` at the read site, so the 02-01 `detectCredentialField` fence (which checks exactly those keys) DENIES a `type="password"` field BEFORE `.fill()` types anything. The adapter surfaces; the gate decides.
- Locators are role/label/text (`getByRole`/`getByLabel`/`getByText`), never brittle CSS/coords (RESEARCH.md Pitfall 15).
- Self-registers via a module-init `register(browserTool)` side effect (HANDS-04); `execute` is reachable only through `registry.dispatch`.
- Built `test/fixtures/login-form.html` (self-contained `file://` page: labelled Email `type=email autocomplete=email`, labelled Password `type=password autocomplete=current-password`, a scrapeable heading) and `browser.test.ts` — 5 unit tests driven THROUGH `registry.dispatch`: PROFILE_DIR is the dedicated dir (never real Chrome, outside kernel-memory/); every navigation logs full URL+provenance+`tool:'browser'` (logger spy); scrape tagged `source:'external'`; the **Password field is FENCED (deny, not filled)** — verified the input stays empty; the **Email field FILLS**; all locators role/label-based.

## Task Commits
1. **Task 1 (checkpoint, PRE-CLEARED):** package legitimacy — `playwright@1.61.0` is canonical (`npm view playwright version` → 1.61.0; repo `github.com/microsoft/playwright`; RESEARCH.md slopcheck `[OK]`). No separate commit (verification step). Chromium binary download is the documented owner setup step (succeeded here).
2. **Task 2: Playwright headful adapter** — `4822e91` (feat) — `browser.ts` + exact pin + lockfile + the `Tool.surfaceSignals` hook + the `registry.dispatch` pre-authorize call.
3. **Task 3: browser unit lane (file:// fixture)** — `561ade3` (test) — `browser.test.ts` + `test/fixtures/login-form.html` + the `__getPageForTest` test seam in `browser.ts`.

## TDD Gate Compliance
Task 3 is `tdd="true"`. The adapter implementation (Task 2, `feat` `4822e91`) preceded the test file (Task 3, `test` `561ade3`) because the plan ordered Task 2 (build) before Task 3 (test) and the adapter is the larger surface. The 5 tests were authored against the 02-01 dispatch/fence contract and ran green on first execution against a real (injected headless) Chromium — no implementation drift was needed. A strict RED-before-GREEN ordering was not enforced (the `feat` landed before the `test`), matching the plan's explicit task ordering. The behavioral contract is fully covered — dedicated-profile assertion, full-URL+provenance navigation logging, scrape-external tagging, password-field-fenced (deny, not filled), email-field-fills, role/label locators.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking / Rule 2 - Missing critical] Added an OPTIONAL `surfaceSignals` pre-authorize hook to the Tool contract + a call to it in `registry.dispatch`**
- **Found during:** Task 2 (wiring HANDS-05)
- **Issue:** The 02-01 credential fence (`detectCredentialField`) classifies signals already present on `call.args`. Peekaboo's AX signals are surfaced by the caller, so they exist before dispatch. But the BROWSER's secure-field signals (`type=password`, sensitive `autocomplete`, accessible label) live in the live DOM — only the adapter can read them, and that read MUST happen BEFORE `gate.authorize` runs (the fence fires before `.fill()`). With no seam to surface live DOM signals before the gate, the browser `fill` op would bypass the credential fence — a HANDS-05 / T-02-03 correctness failure.
- **Fix:** Added an OPTIONAL `surfaceSignals?(args): Promise<void>` to the `Tool` interface and a `tool.surfaceSignals?.(call.args)` call inside `registry.dispatch` at step 2 — BEFORE `authorize` (step 3). The hook runs within dispatch (the single chokepoint is preserved), never executes the action, and is wrapped in try/catch so a failure can never crash dispatch (the gate still runs). `browserTool.surfaceSignals` reads the target field's DOM `type`/`autocomplete`/label and writes `fieldType`/`autocomplete`/`fieldLabel`/`isSecureField` onto `call.args` so the existing fence classifies the live DOM truth. Backward-compatible: Peekaboo and the stub tools omit the hook, so their dispatch path is unchanged (verified — all 76 prior tests still green).
- **Files modified:** `daemon/src/tools/Tool.ts`, `daemon/src/tools/registry.ts`, `daemon/src/tools/browser.ts`
- **Verification:** `browser.test.ts` "FENCE (HANDS-05)" — dispatching `{ op:'fill', label:'Password', text:'hunter2' }` returns `ok:false` with the `secure/credential field` escalation and the password input stays EMPTY (no keystroke). Full suite 81/81 green; `registry.test.ts` (5) and `peekaboo.test.ts` (7) unchanged and green.
- **Committed in:** `4822e91` (Task 2 commit)

**Total deviations:** 1 auto-fixed (1 blocking/missing-critical — a pre-authorize signal seam required for the browser credential fence).
**Impact on plan:** No scope creep. The change is the minimal seam that makes HANDS-05 enforceable for the browser without bypassing the single dispatch chokepoint, and it is backward-compatible with the 02-01/02-02 tools (all prior tests still green). It generalizes a pattern Peekaboo got "for free" (caller-surfaced signals) to a tool whose signals are only readable from the live DOM.

## Manual Owner Checks (documented — gate the phase, NOT this plan)
Per 02-VALIDATION.md and RESEARCH.md (live network + credentials cannot run in CI). The Chromium binary is installed here, but these still need a live site + the owner's credentials:
1. **Real site login + scrape + form-fill end-to-end (HANDS-03):** through `registry.dispatch`, run `navigate`(a real login page) → `fill`(a non-secret field, e.g. Email) → confirm the headful Chromium types into the real form, and that the navigation logged the full URL + provenance. Confirm the dedicated profile persists the session across daemon runs.
2. **Fence on a REAL site password field (HANDS-05):** point `fill` at a real site's password `<input>`; confirm the adapter surfaces `type=password` and the gate REFUSES (no keystroke synthesized) — the owner enters the credential manually.
3. **(Setup, completed here) `npx playwright install chromium`** — run from `daemon/` to download the Chromium binary out-of-repo. Already run in this environment; re-run on any fresh machine.

## Threat Surface
No new security surface beyond the plan's `<threat_model>`.
- **T-02-03 (fill typing a credential):** mitigated — the adapter surfaces DOM `type`/`autocomplete`/label into args at the read site (via the new `surfaceSignals` hook, BEFORE the gate); `gate.authorize` hard-denies before `.fill()`. Unit test: the password field is fenced and NOT filled.
- **T-02-09 (driving the real Chrome profile / cookies):** mitigated — DEDICATED `PROFILE_DIR` under app-support, never the real Chrome `User Data`/profile. Unit-asserted (and asserted outside `kernel-memory/`).
- **T-02-10 (exfil via an unlogged navigation):** mitigated — EVERY `page.goto` logs the full URL + provenance; scraped content tagged `external`. Full egress allowlist is a later phase; the logging seam landed here.
- **T-02-11 (brittle-CSS / coordinate misclick):** mitigated — `getByRole`/`getByLabel`/`getByText` locators, never CSS/coords.
- **T-02-12 (RAM — many Chromium contexts):** mitigated — ONE reused persistent context (lazy, cached; never respawned per call).
- **T-02-SC (npm install playwright@1.61.0):** mitigated — slopcheck `[OK]`, Microsoft repo (`github.com/microsoft/playwright`), pinned exactly; verified `npm view playwright version` → 1.61.0. The Chromium binary is downloaded outside the repo, not an npm dep.

## Known Stubs
None. No hardcoded empty values, placeholder text, or unwired data sources. The adapter is wired end-to-end (navigate/scrape/fill against the live `file://` fixture, all green) and the credential fence is enforced via the live-DOM `surfaceSignals` seam. The only runtime requirement beyond the unit lane is a live site + the owner's credentials, carried as documented owner checks.

## Self-Check: PASSED
- All 3 created key files exist on disk: `daemon/src/tools/browser.ts`, `daemon/src/tools/browser.test.ts`, `daemon/test/fixtures/login-form.html` (verified).
- Both task commits exist in git log: `4822e91` (feat), `561ade3` (test) (verified via `git log --grep="02-03"`).
- Plan-level verification re-run: full suite **81/81 green**; `playwright` pinned exactly `1.61.0` with no caret; `browser-profile` present and no real-Chrome `User Data`/`Google/Chrome`/`Default` path in `browser.ts`; `headless: false` present and no `stealth`/`headless: true`; navigation logs `url` + `provenance` via `logger`; `register(browserTool)` self-registration present; no `.execute(` call site outside `registry.ts`.
- key_links confirmed: `chromium.launchPersistentContext(PROFILE_DIR, { headless: false })`; `logger.info({ tool:'browser', url, provenance }, ...)` on every goto; the `fill` op surfaces `fieldType`/`autocomplete`/`fieldLabel`/`isSecureField` from the DOM into args for the fence; `register(browserTool)`.

## Next Phase Readiness
- KERNEL now has a web hand behind the single gate, with egress logging and the credential fence's live-DOM data source wired. Both real hands (Peekaboo GUI, Playwright browser) register the same way and run the same fence. Ready for Phase 2 close-out verification and the documented manual owner checks (real site login/scrape/fill, fence on a real password field).
- The new `Tool.surfaceSignals` pre-authorize hook is a general, backward-compatible seam any future tool can use to feed read-site signals to the gate without bypassing the chokepoint.

---
*Phase: 02-hands*
*Completed: 2026-06-22*
