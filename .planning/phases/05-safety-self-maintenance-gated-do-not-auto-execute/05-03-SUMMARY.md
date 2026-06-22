---
phase: 05-safety-self-maintenance-gated-do-not-auto-execute
plan: 03
subsystem: infra
tags: [self-maintenance, consolidation, no-promote, provenance-taint, prune, retention, github-backup, explicit-add, finance-leak, launchd, gray-matter, changelog, metrics]

# Dependency graph
requires:
  - phase: 05 (SAFETY) plan 01
    provides: safety/leak-test-helpers.ts (temp-git-repo factory), safety/leakguard.ts assertFinanceNotTracked (ls-files layer d), the kernel-memory/.gitignore for spend-ledger/audit-log
  - phase: 01 (CORE)
    provides: memory/log.ts (logSession/logHeartbeat append-only), memory/identity.ts (assertNotIdentityPath + SHA-256 baseline), memory/types.ts (Provenance), memory/quarantine.ts + retrieve.ts (gray-matter front-matter + authority weights), index.ts --heartbeat job-mode + launchd plist pattern, daemon/scripts/hooks/kernel-memory-pre-push.sh
provides:
  - "memory/consolidate.ts: nightly consolidation — logs->reflections; promote ONLY source:user/self durable facts to knowledge/; external summarized-for-recall (unverified, from <origin>) but NEVER promoted; assertNotIdentityPath on every write"
  - "memory/prune.ts: cleanup — prune stale working-memory (quarantine/+reflections/) + old logs past a 30-day retention window; IDENTITY/knowledge/finance/current.md untouched; .gitkeep preserved"
  - "memory/backup.ts: finance-safe GitHub backup — explicit git add <allowlist> (never -A/-f/.); assertFinanceNotTracked before push; refuses (throws) without remote OR pre-push hook; injectable git runner for temp-repo/temp-bare-remote tests"
  - "self/changelog.ts (appendChangelog) + self/metrics.ts (writeMetrics): MAINT-02 writers, assertNotIdentityPath, no finance amounts"
  - "index.ts --consolidate/--cleanup/--backup short-lived job modes (mirror --heartbeat, run+exit)"
  - "launchd/com.kernel.{consolidation,cleanup,backup}.plist: StartCalendarInterval nightly 03:00/03:30/04:00; launchd/README.md GitHub-backup + maintenance-job runbook"
affects: [phase-5 verification, milestone-complete]

# Tech tracking
tech-stack:
  added: []  # ZERO new packages — node built-ins (fs/path/crypto/child_process) + shipped gray-matter
  patterns:
    - "The no-promote safety filter: consolidation splits facts on source !== 'external' BEFORE any knowledge/ write; promoteFact() asserts source !== 'external' as a final guard so an external fact is structurally unrepresentable in knowledge/ (Pitfall 4)"
    - "Byte-identical invariant test: read knowledge/ tree-hash + IDENTITY.md bytes before/after an external-only run and assert equal — proves the privilege-escalation pump is defused"
    - "Explicit-add allowlist with an argv guard: git add -- <paths>; assertExplicitAddArgv throws if the argv contains -A/-f/--all/--force/. (the greedy finance leak is unrepresentable)"
    - "Injectable git runner (GitRunner) + temp bare remote: the WHOLE backup flow (stage->finance-assert->commit->push) runs against a tmpdir repo + a bare 'remote' — no real GitHub, no real push"
    - "Fail-loud-or-nothing backup: refuses to push (throws) without a remote AND without the pre-push hook — no silent no-op that could later leak"
    - "Short-lived launchd job mode: argv.includes('--<job>') -> run -> process.exit(0), mirroring --heartbeat; default resident mode untouched"

key-files:
  created:
    - daemon/src/memory/consolidate.ts
    - daemon/src/memory/consolidate.test.ts
    - daemon/src/memory/prune.ts
    - daemon/src/memory/prune.test.ts
    - daemon/src/memory/backup.ts
    - daemon/src/memory/backup.test.ts
    - daemon/src/self/changelog.ts
    - daemon/src/self/changelog.test.ts
    - daemon/src/self/metrics.ts
    - daemon/src/self/metrics.test.ts
    - daemon/test/launchd-jobs.test.ts
    - launchd/com.kernel.consolidation.plist
    - launchd/com.kernel.cleanup.plist
    - launchd/com.kernel.backup.plist
    - .planning/phases/05-safety-self-maintenance-gated-do-not-auto-execute/05-USER-SETUP.md
  modified:
    - daemon/src/index.ts
    - launchd/README.md

key-decisions:
  - "Consolidation reads the shipped `## Session N` log blocks, parses the **source:** provenance line, and promotes ONLY source:user/self durable facts; external facts are summarized-for-recall in the reflection with an explicit 'unverified, from <origin>' marker and NEVER reach knowledge/ (Pitfall 4 — the no-promote filter is the whole safety point)."
  - "Promoted knowledge files carry reviewed:false (auto-promoted, distinct from the human-reviewed voice-profile) + kind:consolidated-fact so retrieval/inject treat them as self-authored durable facts without mistaking them for human-vetted entries."
  - "Default retention window = 30 days; cleanup enumerates ONLY working-memory/quarantine+reflections and logs/ — knowledge/ and finance/ are never enumerated (durable/forbidden), working-memory/current.md is a file outside those subdirs so it is never pruned."
  - "Backup stages an explicit allowlist (IDENTITY.md, working-memory, knowledge, tasks, projects, logs, self/changelog.md, self/metrics.md); self/spend-ledger.json + self/audit-log stay gitignored (05-01 decision); finance/ is never in the allowlist."
  - "Backup uses the leak-test-helpers.ts temp-git-repo factory (the actual shipped factory; the plan's reference to 'safety/test-helpers.ts' is the Wave-0 breaker harness, not the git factory) + a temp BARE repo as the push remote so the whole flow is exercised with no real GitHub."

patterns-established:
  - "No-promote consolidation: the source filter + the byte-identical invariant test together prove external content can never become permanent knowledge"
  - "Explicit-add backup: the allowlist + the argv guard + assertFinanceNotTracked + the required pre-push hook form the finance-leak stack at backup time"

requirements-completed: [MEM-07, MAINT-01, MAINT-02, MAINT-03]

# Metrics
duration: 14 min
completed: 2026-06-22
---

# Phase 5 Plan 03: Self-Maintenance Jobs (Consolidation / Cleanup / Finance-Safe Backup) Summary

**Built the nightly self-maintenance jobs as short-lived launchd modes — consolidation that distills logs into reflections and promotes ONLY source:user/self facts (external content is summarized-for-recall but NEVER promoted, IDENTITY.md NEVER auto-edited, proven byte-identical), cleanup that prunes stale working-memory + old logs leaving IDENTITY/knowledge/finance untouched, and a finance-safe GitHub backup that stages with an explicit `git add <allowlist>` (never -A/-f/.) and refuses to push without both a remote and the pre-push hook — all on the shipped `--heartbeat` job-mode + plist pattern, with zero new packages and the full 233-test suite green.**

## Performance

- **Duration:** ~14 min
- **Started:** 2026-06-22T17:30Z
- **Completed:** 2026-06-22T17:44Z
- **Tasks:** 2 auto (TDD) + 1 human-verify checkpoint (verifiable part done, manual steps documented)
- **Files modified:** 17 (15 created, 2 modified)

## Accomplishments

- **Consolidation no-promote (MEM-07, Pitfall 4):** `runConsolidation` reads the daily `## Session N` log blocks, distills each day into a `working-memory/reflections/{date}.md` (gray-matter front-matter), and promotes ONLY `source:user`/`source:self` durable facts into `knowledge/`. External facts are summarized in the reflection with an explicit "unverified, from <origin>" marker and NEVER promoted. The mandatory invariant test reads the `knowledge/` tree-hash AND `IDENTITY.md` bytes before/after a run over ONLY-external logs and asserts BYTE-IDENTICAL — the automated privilege-escalation pump is structurally defused.
- **Cleanup (MEM-07):** `runCleanup` prunes files under `working-memory/quarantine`, `working-memory/reflections`, and `logs/` older than a 30-day retention window via explicit per-file `fs.rmSync`. `IDENTITY.md`, `knowledge/`, `finance/`, and `working-memory/current.md` are never enumerated; `.gitkeep` is preserved so tracked dirs survive.
- **Finance-safe backup (MAINT-01, Pitfall 3/5):** `runBackup` stages an explicit allowlist via `git add -- <paths>` (an `assertExplicitAddArgv` guard throws if the argv ever contains `-A`/`-f`/`--all`/`--force`/`.`), runs `assertFinanceNotTracked` (ls-files layer d) before pushing, and refuses to push (throws, fail loud) unless BOTH a remote and the pre-push hook are present. A deliberately force-staged fake `finance/leak.txt` aborts the backup with NO push. The whole flow runs against a temp git repo + a temp bare remote — no real GitHub.
- **MAINT-02 writers:** `appendChangelog` (append-only `self/changelog.md`, seeds header) and `writeMetrics` (snapshot `self/metrics.md`) — both `assertNotIdentityPath`-guarded, plain markdown, no finance amounts.
- **MAINT-03 scheduling:** `index.ts` gained `--consolidate`/`--cleanup`/`--backup` short-lived modes (run+exit, mirroring `--heartbeat`); the default resident mode is untouched. Three `StartCalendarInterval` plists (03:00/03:30/04:00) `plutil -lint` clean; `launchd/README.md` documents the install + GitHub-backup owner setup.

## Task Commits

Each task was committed atomically:

1. **Task 1: Consolidation (no-promote) + cleanup + self changelog/metrics** — `01b209f` (feat)
2. **Task 2: Finance-safe backup (explicit-add, temp-remote) + index.ts job modes + launchd plists** — `14cac0d` (feat)
3. **Task 3 (checkpoint:human-verify):** verifiable part executed here (build clean, 233/233 green, 3 plists lint OK, all mandatory invariant tests pass); the owner-machine launchd install + GitHub-remote/deploy-key/hook setup + a real scheduled run / real push are documented (see 05-USER-SETUP.md + launchd/README.md) — NOT a blocker.

## Files Created/Modified

- `daemon/src/memory/consolidate.ts` — `runConsolidation(memoryDir?)`; the no-promote source filter + summarize-external + assertNotIdentityPath on every write. Exports `runConsolidation`, `ConsolidationResult`.
- `daemon/src/memory/prune.ts` — `runCleanup(memoryDir?, retentionDays?)`; explicit-path prune of stale working-memory + old logs. Exports `runCleanup`, `CleanupResult`, `DEFAULT_RETENTION_DAYS`.
- `daemon/src/memory/backup.ts` — `runBackup(memoryDir?, deps?)`; explicit-add allowlist + argv guard + finance assertion + required remote/hook; injectable `GitRunner`. Exports `runBackup`, `BackupResult`, `BackupDeps`, `GitRunner`, `defaultGitRunner`, `BACKUP_PATHS`.
- `daemon/src/self/changelog.ts` — `appendChangelog(entry, memoryDir?)` append-only writer.
- `daemon/src/self/metrics.ts` — `writeMetrics(metrics, memoryDir?)` snapshot writer; `Metrics` type.
- `daemon/src/index.ts` — added `--consolidate`/`--cleanup`/`--backup` short-lived job modes alongside `--heartbeat`.
- `launchd/com.kernel.{consolidation,cleanup,backup}.plist` — nightly StartCalendarInterval jobs invoking `dist/index.js --<job>`.
- `launchd/README.md` — five-job table; maintenance + GitHub-backup owner runbook; uninstall loop.
- `daemon/{src/memory,src/self,test}/*.test.ts` — the test files (consolidate/prune/changelog/metrics/backup/launchd-jobs).
- `.planning/.../05-USER-SETUP.md` — the owner-machine launchd + GitHub-backup setup checklist.

## Critical-Invariant Test Results (all GREEN)

| Invariant | Test | Result |
|-----------|------|--------|
| Consolidation no-promote (byte-identical) | `CRITICAL INVARIANT: a run over ONLY source:external logs leaves knowledge/ AND IDENTITY.md byte-identical` | PASS |
| Consolidation promotes only source-vetted facts | `consolidate distills source:user/self facts ... AND promotes them to knowledge/` + `only the source:user fact promotes from a mixed log` | PASS |
| Consolidation never targets IDENTITY.md | `consolidate NEVER targets IDENTITY.md even with a mixed log` | PASS |
| Cleanup prunes stale, preserves durable | `cleanup prunes stale ...` + `cleanup leaves IDENTITY.md, knowledge/, finance/, and current.md UNTOUCHED` + `.gitkeep preserved` | PASS |
| Backup explicit-add argv (never -A/-f/.) | `CRITICAL INVARIANT: the staged git argv uses explicit paths ONLY ... and never finance/` | PASS |
| Backup aborts on a staged fake finance file | `CRITICAL INVARIANT: a deliberately-staged fake finance/ file aborts the backup (no push)` | PASS |
| Backup fails loud without remote / hook | `backup FAILS LOUD when no remote is configured` + `... when the pre-push hook is absent` | PASS |
| Backup pushes only memory paths, never finance (temp bare remote) | `backup pushes to the TEMP bare remote and the remote contains the memory paths but NOT finance/` | PASS |
| changelog/metrics never target IDENTITY.md | `appendChangelog never targets IDENTITY.md` + `writeMetrics never targets IDENTITY.md` | PASS |
| 3 plists valid XML + correct --<job> | `launchd-jobs.test.ts` (plutil -lint + content asserts + distinct-flags) | PASS |

**Test totals:** 233 passed / 0 failed (204 prior + 29 new this plan). `npm run build` clean. `plutil -lint` OK for all three plists. Zero new package.json dependencies.

## Decisions Made
See `key-decisions` frontmatter. The load-bearing ones: (1) the no-promote filter on `source !== 'external'` with a final `promoteFact` guard makes an external fact unrepresentable in `knowledge/`; (2) the backup `assertExplicitAddArgv` guard makes a greedy `git add` unrepresentable in the argv; (3) backup uses the shipped `leak-test-helpers.ts` temp-git-repo factory + a temp bare remote (not a real GitHub push).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Used `safety/leak-test-helpers.ts` for the temp-git-repo factory instead of the named `safety/test-helpers.ts`**
- **Found during:** Task 2 (backup.test.ts setup)
- **Issue:** The plan + 05-01-SUMMARY refer to "the temp-git-repo factory from safety/test-helpers.ts", but `safety/test-helpers.ts` is the Wave-0 breaker harness (fakeClock/recordingExecutor/memoryLedger) — it has NO git-repo factory. The actual `makeTempGitRepo`/`cleanupTempRepo`/`writeRepoFile`/`git` factory lives in `safety/leak-test-helpers.ts` (the module `finance-leakguard.test.ts` already imports). Importing from the named-but-wrong module would not compile.
- **Fix:** `backup.test.ts` imports the factory from `../safety/leak-test-helpers.js` (the real, shipped, tested factory) and adds a local `makeBareRemote()` helper for the temp push target.
- **Files modified:** daemon/src/memory/backup.test.ts
- **Verification:** All 5 backup tests green against the temp repo + temp bare remote; no real push.
- **Committed in:** 14cac0d (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking).
**Impact on plan:** Cosmetic source-of-truth correction — the intended factory was used, just from its actual module path. No behavior change, no scope creep.

## Issues Encountered
- None. (The pre-existing untracked `daemon/test/helpers/temp-git-repo.js` from 05-01 is a compiled duplicate of the factory, out of this plan's scope; left untouched.)

## User Setup Required
**The nightly jobs + finance-safe GitHub backup need owner-machine configuration.** See [05-USER-SETUP.md](./05-USER-SETUP.md) for:
- Creating a private GitHub repo + adding it as the kernel-memory remote + an SSH deploy key.
- Installing the pre-push hook into `kernel-memory/.git/hooks/pre-push`.
- Filling the plist placeholders and `launchctl bootstrap`-ing the three maintenance jobs.
- Verification (a real consolidation/cleanup kickstart, one real `--backup` push with `ls-files | grep -i finance` EMPTY, and confirming the fail-loud guard without a remote/hook).

The backup is built to FAIL LOUD (refuse to push) until the remote AND hook exist — that is the designed behavior, so an unconfigured machine cannot leak.

## Next Phase Readiness
- This is the LAST plan of the project (Phase 5 / spec P4, gated). All four Phase-5 requirement families for this plan are complete: MEM-07, MAINT-01, MAINT-02, MAINT-03.
- Ready for `/gsd-verify-work 5` and `/gsd-complete-milestone`. The only outstanding work is the documented owner-machine setup (launchd install + GitHub remote/hook), which is human-only and cannot be automated.

---
*Phase: 05-safety-self-maintenance-gated-do-not-auto-execute*
*Completed: 2026-06-22*

## Self-Check: PASSED
- All 15 created files (10 source/test + 3 plists + USER-SETUP + ... ) verified present on disk via `[ -f ]`.
- Both task commits (01b209f, 14cac0d) verified in git log.
- `npm test` 233/233 green; `npm run build` clean; `plutil -lint` OK for all three plists; zero new package.json dependencies.
- All mandatory invariant tests pass: consolidation no-promote byte-identical, backup explicit-add (argv never -A/-f/.), staged-fake-finance aborts (no push), fail-loud without remote/hook, no real push (temp repo + temp bare remote).
