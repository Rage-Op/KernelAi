---
phase: 01-skeleton
plan: 02
subsystem: infra
tags: [typescript, esm, node24, memory, sha256, crypto, gray-matter, provenance, quarantine, retrieval, rerank, injection, tdd, node-test]

# Dependency graph
requires:
  - phase: 01-01
    provides: "daemon ESM/TS scaffold + node:test/tsx harness, config.ts (config.memoryDir + INJECT_CAP=16384), memory/types.ts (ContextItem + Provenance), seeded kernel-memory/ repo (IDENTITY.md, working-memory/current.md, knowledge/tasks/projects/quarantine layout)"
provides:
  - "identity.ts — SHA-256 baseline (self/identity.hash) + startup verify (readIdentityVerified, fails loud, no auto-re-baseline) + write-path guard (assertNotIdentityPath)"
  - "quarantine.ts — quarantineWrite: the single write path for source:external content, confined to working-memory/quarantine/, stamps source:external front-matter"
  - "retrieve.ts — keyword retrieval (no embeddings) + authority×recency rerank (tokenize, score, retrieveAndRerank); quarantine authority 0.0"
  - "inject.ts — priority-order assembly (IDENTITY → current.md → reranked retrieval) under the hard 16384-char cap; IDENTITY never dropped/truncated; external excluded; fail-loud when IDENTITY+current exceed the cap"
affects: [01-03 (loop consumes inject()/retrieveAndRerank; startup baselines IDENTITY hash), brain implementations (Phase 3 receive injected context), safety gate (Phase 2/5 quarantine promotion gate)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "node:crypto SHA-256 integrity baseline (never hand-rolled) for durable persona files"
    - "memory-dir-as-parameter (default config.memoryDir) so every module is unit-testable against a temp dir"
    - "code-level provenance enforcement: authority 0.0 in retrieve + source!=='external' filter in inject (defense-in-depth, not a prompt rule)"
    - "greedy priority-ordered budget fill: skip (never truncate) overflowing items; fixed-priority items never dropped"
    - "TDD red→green per task (test commit then feat commit)"

key-files:
  created:
    - daemon/src/memory/identity.ts
    - daemon/src/memory/identity.test.ts
    - daemon/src/memory/quarantine.ts
    - daemon/src/memory/quarantine.test.ts
    - daemon/src/memory/retrieve.ts
    - daemon/src/memory/retrieve.test.ts
    - daemon/src/memory/inject.ts
    - daemon/src/memory/inject.test.ts
  modified: []

key-decisions:
  - "inject(query?, memoryDir?, opts?) — query is OPTIONAL (the e2e calls inject() with no args); when omitted, current.md text is the query basis. memoryDir defaults to config.memoryDir but is overridable for tests. opts.warn injects the fail-loud sink."
  - "baselineIdentityHash is idempotent (seeds self/identity.hash only when absent) and inject() calls it before readIdentityVerified() — first run auto-seeds the legitimate baseline; any later out-of-band change still fails loud. NO auto-re-baseline of an existing baseline."
  - "retrieveAndRerank returns RankedItem (ContextItem + numeric score) so callers/tests can assert ordering; quarantine/ is excluded from the gathered dirs AND scores 0.0 by authority (double safety)."
  - "fail-loud over-cap behavior returns the uncut IDENTITY+current block (IDENTITY first) and fires opts.warn — it never drops IDENTITY even when the fixed block alone exceeds 16384."

patterns-established:
  - "Persona integrity = node:crypto SHA-256 baseline + read-time verify + write-path guard (MEM-02)."
  - "External content has exactly one durable landing zone (quarantine.ts) and zero promotion paths in Phase 1 (MEM-05)."
  - "Injection enforces priority order in code with a hard char budget; lowest-priority retrieved items are skipped, never the persona (MEM-03)."

requirements-completed: [MEM-02, MEM-03, MEM-04, MEM-05, PERS-01]

# Metrics
duration: 5min
completed: 2026-06-22
---

# Phase 01 Plan 02: Memory Engine Summary

**KERNEL's recall half: a node:crypto SHA-256 IDENTITY integrity guard (fails loud, no auto-re-baseline) + write-path guard, a single quarantine write path for untrusted content, keyword-only retrieval with a 14-day-half-life authority×recency rerank (quarantine 0.0), and priority-order session injection under a hard 16384-char cap that never drops IDENTITY.**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-06-22T09:11:02Z
- **Completed:** 2026-06-22T09:15:33Z
- **Tasks:** 3 (all TDD: red → green)
- **Files created:** 8 (4 modules + 4 test files)

## Accomplishments
- `identity.ts` enforces MEM-02 at the code level: `computeIdentityHash` (SHA-256 hex via `node:crypto`), `baselineIdentityHash` (idempotent first-run seed of `self/identity.hash`, never overwrites), `readIdentityVerified` (returns text on hash match, throws `IdentityIntegrityError` on any out-of-band change — no silent return, no auto-re-baseline), and `assertNotIdentityPath` (the write-path guard rejecting any write to IDENTITY.md, even unnormalized spellings).
- `quarantine.ts` is the single sanctioned write path for `source: external` content (MEM-05): `quarantineWrite` confines writes to `working-memory/quarantine/`, refuses any out-of-bucket target, and stamps `source: external` + `origin` front-matter via gray-matter. No promoter exists in Phase 1.
- `retrieve.ts` ports the agentic-os reranker (MEM-04) with NO embeddings: `tokenize` (lowercase `[a-z0-9]+` Set), `score = keywordOverlap × recencyMult × authority` (HALF_LIFE 14, FLOOR 0.3, longest-prefix authority, default 0.5, quarantine 0.0), and `retrieveAndRerank` gathering knowledge/tasks/projects, gray-matter-splitting front-matter, computing ageDays from mtime, and returning score-sorted `RankedItem`s.
- `inject.ts` assembles in priority order (IDENTITY → current.md → reranked retrieval) under the hard 16384 cap (MEM-03 / PERS-01): IDENTITY (hash-verified) and current.md are never truncated, retrieved overflow is skipped (not cut mid-item), `source: external` items are excluded (defense-in-depth), and IDENTITY+current exceeding the cap fires a loud warning while still returning IDENTITY first.
- All 22 memory unit tests pass; `npm run build` (tsc) is clean. The Walking-Skeleton e2e stays intentionally RED (awaits ipc/server + loop in 01-03).

## Task Commits

Each task was committed atomically (parent code repo `/Users/pravinmaurya/Documents/KernelAi`), TDD red→green:

1. **Task 1: IDENTITY integrity guard + quarantine single-write path** — `d8bfe12` (test, RED) → `916ae6f` (feat, GREEN)
2. **Task 2: Keyword retrieval + authority×recency rerank** — `4125920` (test, RED) → `4b1925a` (feat, GREEN)
3. **Task 3: Priority-order injection under the hard 16K cap** — `c3aec1f` (test, RED) → `5124dc2` (feat, GREEN)

## Files Created/Modified
- `daemon/src/memory/identity.ts` — SHA-256 baseline + startup verify (fail loud) + write-path guard; exports `computeIdentityHash`, `baselineIdentityHash`, `readIdentityVerified`, `assertNotIdentityPath`, `IdentityIntegrityError`.
- `daemon/src/memory/identity.test.ts` — 8 behaviors: deterministic hash, first-run baseline, no-overwrite (no auto-re-baseline), verified read on match, fail-loud on tamper, throw on missing baseline, write-path guard accept/reject.
- `daemon/src/memory/quarantine.ts` — `quarantineWrite({text, origin}, memoryDir?)`; confines to quarantine/, stamps `source: external` front-matter; exports `quarantineWrite`, `QuarantineItem`.
- `daemon/src/memory/quarantine.test.ts` — 4 behaviors: lands in quarantine/, front-matter+origin+body, works without origin, distinct filenames.
- `daemon/src/memory/retrieve.ts` — keyword + authority×recency rerank, no embeddings; exports `retrieveAndRerank`, `score`, `tokenize`, `RankedItem`.
- `daemon/src/memory/retrieve.test.ts` — 6 behaviors: tokenize, score formula + recency floor, quarantine→0, recent-high-authority outranks stale-low, source carried + quarantine excluded, descending sort.
- `daemon/src/memory/inject.ts` — priority assembly + hard cap enforcer; exports `inject`, `InjectOptions`.
- `daemon/src/memory/inject.test.ts` — 5 behaviors: leads with IDENTITY + ≤cap, IDENTITY/current never truncated & overflow skipped, external excluded, fail-loud over-cap with IDENTITY present, no-arg signature.

## Decisions Made
- **`inject()` query is optional.** The Wave-1 e2e contract (`skeleton.e2e.test.ts:93`) calls `inject()` with no arguments. The signature is `inject(query?, memoryDir?, opts?)`; when `query` is omitted, `current.md` text becomes the retrieval query basis. This keeps the e2e contract satisfiable in 01-03 without changing the plan's intent.
- **First-run baseline is auto-seeded; an existing baseline is never auto-rewritten.** `inject()` calls the idempotent `baselineIdentityHash()` before verifying, matching RESEARCH.md's "On first install, record SHA-256" path. Out-of-band changes after the baseline still fail loud — the only sanctioned re-baseline is a human deleting/replacing `self/identity.hash`.
- **`retrieveAndRerank` returns `RankedItem` (ContextItem + score).** Plain `ContextItem` has no score field; exposing the numeric score lets callers and tests assert ordering. Quarantine is excluded both by being outside the gathered dirs and by authority 0.0 (double safety).
- **`memoryDir` is a defaulted parameter on every module function.** Defaults to `config.memoryDir`; overridable so tests run against `mkdtemp` dirs without mutating the resolved-at-load config.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] inject.test.ts "skipped item" assertion was mathematically wrong**
- **Found during:** Task 3 (GREEN run).
- **Issue:** My initial RED test counted overlapping `DDDD` substrings and compared against `30 * 100`, which a correct implementation legitimately exceeds (each surviving 1500-char doc contributes ~374 `DDDD` matches). The assertion failed against a correct `inject.ts`.
- **Fix:** Rewrote the assertion to count whole `D{1500}` runs — proving docs land intact (skipped, not truncated) and that fewer than all 30 survived under the cap. This tests the real invariant.
- **Files modified:** `daemon/src/memory/inject.test.ts`
- **Verification:** All 5 inject tests + full 22-test memory suite pass; build clean.
- **Committed in:** `5124dc2` (Task 3 GREEN commit).

---

**Total deviations:** 1 auto-fixed (1 test bug). No production-code deviations; all four modules implemented exactly as specified.
**Impact on plan:** None — the fix corrected a flawed test assertion to match the spec's real invariant (skip-not-truncate). No scope creep; only the plan's `files_modified` set was touched.

## Issues Encountered
None beyond the one auto-fixed test-assertion bug above. The `skeleton.e2e.test.ts` failure in the full suite is expected and intentional (it imports `../src/ipc/server.js` and `../src/loop.js`, which land in 01-03) — not forced green per the plan.

## User Setup Required
None — no external service configuration required in Phase 1.

## Known Stubs
None. All four modules are fully wired against real files. The quarantine seam has no Phase-1 caller producing external content (Phase 2 mail/web readers will use it) — this is the plan-mandated seam, not a stub: the single write path and no-promote rule are real and tested now.

## Verification Results
- `cd daemon && npm run build` (tsc) → **PASS** (clean).
- `cd daemon && npx tsx --test src/memory/{identity,quarantine,retrieve,inject}.test.ts` → **22 tests, 22 pass, 0 fail**.
- `cd daemon && npm test` (full suite) → **29 tests, 28 pass, 1 fail** — the single failure is the intentionally-RED `skeleton.e2e.test.ts` (imports 01-03 modules); all StubBrain (×4), finance-ignore (×2), and memory (×22) tests are GREEN.
- Threat register satisfied: T-01-05 (IDENTITY tamper → `IdentityIntegrityError`, write-path guard), T-01-06 (quarantine authority 0.0 + `source!=='external'` exclusion), T-01-07 (priority order, IDENTITY never truncated, fail-loud over cap), T-01-08 (node:crypto SHA-256, not hand-rolled).

## Next Phase Readiness
- 01-03 (loop + IPC server + session logging) can now consume `inject()` (priority context under the cap) and `retrieveAndRerank()`. Startup should call `baselineIdentityHash()` / `readIdentityVerified()` — `inject()` already does this idempotently.
- The `skeleton.e2e.test.ts` `inject()` assertion (begins with IDENTITY, ≤16384) is satisfiable once `ipc/server.ts` + `loop.ts` exist; the memory half of the tick is complete.
- No blockers.

## Self-Check: PASSED

All 8 created files verified on disk; all 6 task commits (`d8bfe12`, `916ae6f`, `4125920`, `4b1925a`, `c3aec1f`, `5124dc2`) verified present in git log.

---
*Phase: 01-skeleton*
*Completed: 2026-06-22*
