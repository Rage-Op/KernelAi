---
phase: 04-routines-claude-code-finance
plan: 03
subsystem: finance
tags: [plaid, sqlcipher, better-sqlite3-multiple-ciphers, keychain, security-cli, git-hooks, finance-leak, pre-push, encryption]

# Dependency graph
requires:
  - phase: 02-hands
    provides: "registry.dispatch → gate.authorize → classifyTier single chokepoint + credential fence + Tool contract"
  - phase: 01-skeleton
    provides: "config.memoryDir, kernel-memory/ as a separate git repo, pino logger, the seeded gitignore + finance-ignore test + index.ts assertFinanceNotTracked guard"
provides:
  - "Read-only Plaid finance aggregation (mocked in tests) into a SQLCipher-encrypted store under kernel-memory/finance/"
  - "macOS Keychain DB-key wrapper via the zero-dep security CLI (absent-tolerant, key never on disk)"
  - "W/M/Y local spending aggregation over the encrypted store"
  - "The complete 4-layer finance-leak prevention stack, all proven by automated tests — the hard gate before any Phase-5 backup"
  - "A real, installed + executable kernel-memory/.git/hooks/pre-push byte-scanning hook"
affects: [phase-05-gated-backup, finance, security, backup]

# Tech tracking
tech-stack:
  added: [plaid@42.2.0, better-sqlite3-multiple-ciphers@12.11.1]
  patterns:
    - "Read-only-by-construction tool schema (strict enum with no write/credential op) so classifyTier yields Green"
    - "Zero-dep security CLI spawn for the Keychain (mirrors ClaudeCodeBrain.__setRunnerForTest), with __setSecuritySpawnForTest seam"
    - "__setPlaidClientForTest mock seam (mirrors peekaboo __setClientForTest) — no live Plaid / no Link UI in tests"
    - "Pre-push hook scans the pushed commit-range BYTES (not just working-tree filenames) per the git pre-push stdin protocol"
    - "Temp-git-repo fixture isolates all leak tests from the real kernel-memory repo (Pitfall 2)"

key-files:
  created:
    - daemon/src/finance/keychain.ts
    - daemon/src/finance/plaid-client.ts
    - daemon/src/finance/store.ts
    - daemon/src/tools/finance.ts
    - daemon/src/safety/leakguard.ts
    - daemon/src/safety/leak-test-helpers.ts
    - daemon/src/finance/keychain.test.ts
    - daemon/src/finance/store.test.ts
    - daemon/src/tools/finance.test.ts
    - daemon/src/safety/leakguard.test.ts
    - daemon/test/finance-leakguard.test.ts
    - kernel-memory/.git/hooks/pre-push
  modified:
    - daemon/package.json
    - daemon/src/safety/tiers.ts
    - daemon/src/index.ts
    - daemon/test/finance-ignore.test.ts
    - kernel-memory/.gitignore

key-decisions:
  - "DB key in the macOS Keychain via the zero-dep `security` CLI (NOT keytar/keytar-archived, NOT @napi-rs/keyring) — verified live, absent-tolerant, key never written to disk or the memory repo"
  - "Finance tool schema is .strict() with op enum ['balances','transactions','aggregate'] only — no type/fill/credential op can exist (FIN-02 enforced structurally, not by runtime check)"
  - "Extended GREEN_OPS with balances/transactions/aggregate so the central classifyTier yields Green for finance reads (no per-tool self-classification)"
  - "index.ts now delegates assertFinanceNotTracked to the directly-tested safety/leakguard.ts (single source of truth) with identical fail-loud behavior"
  - "Pre-push hook accumulates findings in a temp file (not a shell variable) because a POSIX sh pipe runs its RHS in a subshell whose variable writes are lost — the abort decision is the file's non-emptiness"

patterns-established:
  - "4-layer finance-leak stack proven layer-by-layer with one automated test per layer; no layer weakened to make a test pass"
  - "Plaid amount sign normalization: Plaid positive=spending → stored as amount<0 (store convention amount<0 = spending)"

requirements-completed: [FIN-01, FIN-02, FIN-03, FIN-04, FIN-05]

# Metrics
duration: 10 min
completed: 2026-06-22
---

# Phase 4 Plan 03: Read-only Plaid Finance + 4-Layer Leak Stack Summary

**Read-only Plaid aggregation (fully mocked) into a SQLCipher AES-256 store keyed from the macOS Keychain, with local W/M/Y spending aggregation, gated behind the complete 4-layer finance-leak prevention stack — all four layers proven by automated tests and the real kernel-memory pre-push byte-scanning hook installed + executable.**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-06-22T12:49:50Z
- **Completed:** 2026-06-22T12:59:53Z
- **Tasks:** 3 (TDD: RED → GREEN → GREEN)
- **Files modified:** 17 (12 created, 5 modified) across the daemon + kernel-memory repos

## The 4-Layer Finance-Leak Stack — Per-Layer Test Results (the PHASE GATE)

All four layers run GREEN. No layer was weakened to pass.

| Layer | What it proves | Test | Result |
|-------|----------------|------|--------|
| **(a) gitignore + sidecars** | `finance/`, the real `finance/finance.db` filename, and every SQLCipher sidecar (`-wal/-shm/-journal`) are ignored in the kernel-memory repo | `test/finance-ignore.test.ts` (`git check-ignore`) | **PASS** (4/4 incl. literal DB filename + 3 sidecars) |
| **(b) pre-push hook** | The installed `kernel-memory/.git/hooks/pre-push` scans the pushed commit-RANGE bytes (fed the real `<local ref> <local sha> <remote ref> <remote sha>` on stdin) and EXITS NON-ZERO on a finance PATH **and** on a finance-shaped VALUE ($ amount / account-number string) in a non-finance path; a clean commit exits zero | `test/finance-leakguard.test.ts` (deliberate-abort) | **PASS** (5/5: finance-path abort, value-in-non-finance-path abort, clean push, hook installed+executable, no `--no-verify`/blanket-add policy check) |
| **(c) at-rest encryption** | Open with the key → write a row with a known plaintext memo → close; reopen WRONG key FAILS; reopen RIGHT key returns the row; raw DB bytes scanned for the seeded plaintext memo → ABSENT; no plaintext `SQLite format 3` header | `src/finance/store.test.ts` | **PASS** (4/4, gold-standard at-rest byte scan) |
| **(d) startup assertion** | `git -C <memoryDir> ls-files \| grep -i finance` — a planted TRACKED finance path makes `assertFinanceNotTracked` THROW (refuse to start); a clean repo passes; a non-git dir is tolerated | `src/safety/leakguard.test.ts` + `test/finance-ignore.test.ts` ls-files | **PASS** (clean live: nothing finance tracked in the real kernel-memory repo) |

Live cross-checks: the real `kernel-memory/.git/hooks/pre-push` is present + executable; `git -C kernel-memory ls-files | grep -i finance` is empty; the hook contains no `--no-verify` and no blanket `git add -A/-f`.

## Accomplishments
- Read-only Plaid finance Tool (`finance`): `.strict()` schema with op enum `['balances','transactions','aggregate']` only — structurally no credential surface (FIN-01/02). Registers on import; reachable only through `registry.dispatch → gate.authorize` (classifies Green).
- SQLCipher AES-256 encrypted store under `kernel-memory/finance/finance.db` with the DB key read from the macOS Keychain via the zero-dep `security` CLI (FIN-03). Wrong-key open fails; raw bytes are ciphertext.
- W/M/Y spending aggregation computed locally over the encrypted store (income excluded, spending=amount<0), correct over seeded transactions: W=52.5, M=152.5, Y=652.5 (FIN-05).
- The complete 4-layer leak stack proven (above) — the hard gate before any Phase-5 backup job exists.
- Full daemon suite: **147 tests pass / 0 fail** (up from the 124 baseline; +23 new). `npm run build` clean.

## Task Commits

1. **Task 1: Install pinned deps + RED-first tests + mock seams** — `cdecc46` (test)
2. **Task 2: Keychain + SQLCipher store + read-only Plaid tool (GREEN)** — `1f16ca1` (feat)
3. **Task 3: The 4-layer leak stack — leakguard + pre-push proof (GREEN)** — `31e07a5` (feat); kernel-memory `.gitignore` committed in its own repo as `ddcbf7a` (chore)

## Files Created/Modified
- `daemon/src/finance/keychain.ts` — `security` CLI wrapper, `getOrCreateKeychainKey`, absent-tolerant, `__setSecuritySpawnForTest` seam; key never on disk.
- `daemon/src/finance/store.ts` — SQLCipher open (`key=` + `cipher_compatibility=4`), accounts/transactions schema + upserts, W/M/Y `aggregate`, key-shape guard against pragma injection.
- `daemon/src/finance/plaid-client.ts` — read-only Plaid wrapper (Balance + Transactions only) + `__setPlaidClientForTest` mock seam; live path unwraps `.data`.
- `daemon/src/tools/finance.ts` — registered Green read-only Tool; syncs mocked/live Plaid → store; returns `{widget:'accounts'|'spending', data}`; logs sync events only (never amounts/key/token).
- `daemon/src/safety/leakguard.ts` — layer (d) `assertFinanceNotTracked` (fail loud), directly tested.
- `daemon/src/safety/leak-test-helpers.ts` — temp-git-repo fixture (isolates leak tests from the real repo).
- `daemon/src/safety/tiers.ts` — `GREEN_OPS` += balances/transactions/aggregate.
- `daemon/src/index.ts` — delegates `assertFinanceNotTracked` to leakguard; dropped now-unused `execFileSync` import.
- `daemon/test/finance-ignore.test.ts` — extended for the literal DB filename + each sidecar.
- `daemon/test/finance-leakguard.test.ts` — deliberate-abort proof against a temp kernel-memory repo + real-hook presence/executability + policy guard.
- `kernel-memory/.git/hooks/pre-push` — the byte-scanning hook (installed + executable).
- `kernel-memory/.gitignore` — explicit `finance/finance.db` + sidecars.
- `daemon/package.json` — `plaid@42.2.0`, `better-sqlite3-multiple-ciphers@12.11.1` (exact pins).

## Decisions Made
See `key-decisions` frontmatter. Headline: the Keychain is reached via the zero-dep `security` CLI (verified live, absent-tolerant); the finance tool's read-only-ness is enforced structurally by a `.strict()` schema (no credential op can be smuggled); the pre-push hook scans the pushed commit RANGE bytes, not working-tree filenames.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Pre-push abort exit-code lost to a POSIX sh subshell**
- **Found during:** Task 3 (pre-push deliberate-abort test)
- **Issue:** The first hook draft set an `ABORT=1` flag inside `printf ... | scan` and `... | while read` pipes. Under POSIX `sh` the RHS of a pipe runs in a SUBSHELL, so the variable writes were lost — the hook correctly printed the abort messages but exited 0, so the deliberate-abort test failed.
- **Fix:** Accumulate findings in a `mktemp` file (`note()` appends; the abort decision is `[ -s "$FINDINGS" ]`); removed all pipes into the loop/detector by using command substitution.
- **Files modified:** `kernel-memory/.git/hooks/pre-push`
- **Verification:** `finance-leakguard.test.ts` 5/5 pass; manual hook invocation exits non-zero on both a finance path and a finance-shaped value.
- **Committed in:** hook is in `.git/hooks` (not version-controlled); the fix is reflected in `31e07a5`'s test results.

**2. [Rule 3 - Blocking] Hook comment matched the `--no-verify` policy grep**
- **Found during:** Task 3 (policy guard test)
- **Issue:** The hook header literally contained the strings `--no-verify` and `git add -A/-f` in its policy explanation, tripping the `grep -E` policy guard that asserts the hook references neither.
- **Fix:** Reworded the comments ("bypassing it at push time", "blanket add") so the literal forbidden tokens never appear in the hook source.
- **Files modified:** `kernel-memory/.git/hooks/pre-push`
- **Verification:** policy-guard test passes; `grep -RnE "git add (-A|-f|--all|--force)"` and `grep no-verify` on the hook return nothing.
- **Committed in:** reflected in `31e07a5`.

**3. [Rule 3 - Blocking] `tsc` rootDir + redundant-spread build errors**
- **Found during:** Task 3 (`npm run build`)
- **Issue:** (a) `src/safety/leakguard.test.ts` imported the fixture from `test/helpers/`, outside the build `rootDir: src`; (b) `store.ts` `upsertTransaction` used `{ memo:'', ...t }` where `t` already has a required `memo`, which `tsc` flagged as an overwritten property (TS2783).
- **Fix:** (a) Relocated the fixture to `src/safety/leak-test-helpers.ts` (git tracked the move as a rename) and updated both importers; (b) changed the spread to `{ ...t, memo: t.memo ?? '' }`.
- **Files modified:** `src/safety/leak-test-helpers.ts` (renamed from `test/helpers/temp-git-repo.ts`), `src/safety/leakguard.test.ts`, `test/finance-leakguard.test.ts`, `src/finance/store.ts`, `src/index.ts` (dropped unused import).
- **Verification:** `npm run build` clean; full suite 147/147 green.
- **Committed in:** `31e07a5`.

**4. [Rule 2 - Missing Critical] GREEN_OPS did not recognize finance read ops**
- **Found during:** Task 2 (finance tool GREEN classification)
- **Issue:** `classifyTier` default-denies unrecognized ops as Red; `balances/transactions/aggregate` were not in any op set, so finance reads would have been denied at the gate.
- **Fix:** Added the three read ops to `GREEN_OPS` (central classifier, no per-tool self-classification — preserves the locked single-classification invariant).
- **Files modified:** `daemon/src/safety/tiers.ts`
- **Verification:** finance tool tests + gate/tiers regression (16/16) green.
- **Committed in:** `1f16ca1`.

---

**Total deviations:** 4 auto-fixed (3 blocking, 1 missing-critical).
**Impact on plan:** All four were necessary for correctness/security; no scope creep. The leak stack was NOT weakened — the subshell fix made the hook abort *correctly* (it was already detecting leaks, just losing the exit code).

## Issues Encountered
None beyond the auto-fixed deviations above. The native `better-sqlite3-multiple-ciphers` build fetched its arm64/darwin prebuilt binary cleanly (a `prebuild-install` deprecation warning is informational, not a failure).

## Known Stubs
None. The finance tool is fully wired: mocked Plaid in tests, real `security` Keychain + Plaid Sandbox on the live owner path. No empty/placeholder data flows to a UI.

## User Setup Required
None automated this plan. Documented MANUAL owner checks (carried, not blocking automated verification):
- Live Plaid Link in the bank's own OAuth flow (real account) → balances/transactions appear. Requires owner-installed `PLAID_CLIENT_ID`/`PLAID_SECRET` + `PLAID_ACCESS_TOKEN` (env or Keychain; never the memory repo). All automated tests mock the Plaid client (Sandbox needs no Link UI).

## Next Phase Readiness
- **PHASE GATE CLEARED for the finance-leak criterion:** all four layers are proven passing and the real kernel-memory pre-push hook is installed + executable. This was the locked hard gate before any Phase-5 backup job.
- Phase 5 remains GATED — explicit owner approval required before it begins (per ROADMAP).
- Other Phase-4 plans (routines engine, email reply, Claude Code bridge/transcript, Face widgets) are independent of this plan and unaffected.

## Self-Check: PASSED
- All `key-files.created` exist on disk (verified below).
- Task commits `cdecc46`, `1f16ca1`, `31e07a5` exist in `git log` (+ `ddcbf7a` in the kernel-memory repo).
- Plan `<verification>` re-run: full daemon suite 147/147 green; `npm run build` clean; `test -x kernel-memory/.git/hooks/pre-push` true; policy greps clean; all four leak layers green.

---
*Phase: 04-routines-claude-code-finance*
*Completed: 2026-06-22*
