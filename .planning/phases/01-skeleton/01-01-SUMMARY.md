---
phase: 01-skeleton
plan: 01
subsystem: infra
tags: [typescript, esm, node24, nodenext, zod, pino, gray-matter, yaml, node-test, tsx, git, provenance, brain-provider]

# Dependency graph
requires:
  - phase: none
    provides: greenfield — first plan of the project
provides:
  - "Monorepo + daemon/ TypeScript-ESM scaffold (Node 24, NodeNext, strict) that builds with tsc"
  - "node:test + tsx test harness (no external test framework)"
  - "zod-validated config.ts exporting `config` (memoryDir, socketPath) + `INJECT_CAP` constant"
  - "BrainProvider interface + Decision/ToolCall/BrainContext types + zod DecisionSchema/ToolCallSchema (the brain swap-seam, built FIRST)"
  - "StubBrain — deterministic in-process brain satisfying BrainProvider with a zod-valid Decision"
  - "ContextItem + Provenance ('user'|'self'|'external') data shape (the MEM-05 quarantine seam)"
  - "kernel-memory/ as its own git repo seeded with the full spec §5 layout"
  - "IDENTITY.md persona + three voice rules (terse to Pravin / dynamic outward / clarify-don't-guess)"
  - "finance/ gitignore (broad) + finance-ignore.test.ts asserting nothing finance-pathed is tracked (MEM-06)"
  - "Failing skeleton.e2e.test.ts — the Walking-Skeleton acceptance contract naming the full tick"
affects: [01-02 (memory inject/retrieve + IPC server), 01-03 (loop + log), brain implementations (Phase 3), safety gate (Phase 2/5)]

# Tech tracking
tech-stack:
  added: ["@anthropic-ai/sdk@0.105.0", "pino@10.3.1", "zod@4.4.3", "gray-matter@4.0.3", "yaml@2.9.0", "typescript@5.9.3", "tsx@4.22.4", "@types/node@24.13.2", "pino-pretty@13.1.3"]
  patterns: ["ESM NodeNext with .js import specifiers", "interface-first brain swap-seam", "provenance tag at the data shape", "zod runtime validation of contracts", "separate kernel-memory git repo", "TDD red→green for the brain seam"]

key-files:
  created:
    - .nvmrc
    - daemon/package.json
    - daemon/tsconfig.json
    - daemon/.env.example
    - daemon/.gitignore
    - daemon/src/config.ts
    - daemon/src/safety/README.md
    - daemon/src/brain/BrainProvider.ts
    - daemon/src/brain/StubBrain.ts
    - daemon/src/brain/StubBrain.test.ts
    - daemon/src/memory/types.ts
    - daemon/test/finance-ignore.test.ts
    - daemon/test/skeleton.e2e.test.ts
    - kernel-memory/IDENTITY.md
    - kernel-memory/.gitignore
    - kernel-memory/working-memory/current.md
    - kernel-memory/projects/registry.md
    - kernel-memory/self/changelog.md
    - kernel-memory/self/metrics.md
  modified:
    - .gitignore

key-decisions:
  - "Pinned deps EXACTLY (no caret) — npm injects ^ on install, so package.json was rewritten and the lockfile re-resolved to lock TS 5.9.3 / @types/node 24.13.2 / zod 4.4.3 etc."
  - "kernel-memory/ added to the parent .gitignore so the code monorepo never tracks the nested memory repo — keeps the finance ignore + future GitHub backup off code history (spec §5/§14)."
  - "tsconfig excludes test/ from the build so the intentionally-RED skeleton.e2e.test.ts (imports not-yet-built modules) never breaks `npm run build`."

patterns-established:
  - "Brain swap-seam built interface-first: BrainProvider + zod DecisionSchema exist before any implementation (BRAIN-01)."
  - "Provenance lives in the data shape from day one: ContextItem.source ∈ {user, self, external} (MEM-05)."
  - "Finance defense pre-seeded before finance/ exists: broad gitignore + a git ls-files assertion test (MEM-06)."
  - "A failing e2e test is the executable acceptance contract for the rest of the phase (Walking Skeleton)."

requirements-completed: [MEM-01, MEM-06, BRAIN-01, MEM-05, PERS-01, PERS-02, PERS-03]

# Metrics
duration: 6 min
completed: 2026-06-22
---

# Phase 01 Plan 01: Skeleton Foundation Summary

**Monorepo + Node 24 ESM/NodeNext daemon scaffold with the node:test+tsx harness, an interface-first BrainProvider swap-seam (StubBrain returns a zod-valid Decision), the provenance ContextItem shape, a self-contained kernel-memory git repo seeded with the spec §5 layout + IDENTITY persona/voice rules + finance gitignore, and a deliberately-RED Walking-Skeleton e2e contract.**

## Performance

- **Duration:** 6 min
- **Started:** 2026-06-22T08:54:45Z
- **Completed:** 2026-06-22T09:00:04Z
- **Tasks:** 4 (1 pre-cleared checkpoint + 3 auto, one TDD)
- **Files created:** 19 (13 in daemon/code repo, 6 in kernel-memory repo) + 1 modified (.gitignore)

## Accomplishments
- `daemon/` builds clean with `tsc` (Node 24, ESM, NodeNext, strict); `node:test` runs via `tsx` with no external test framework.
- All Phase-1 deps installed at EXACT pins (TS 5.9.3, @types/node 24.13.2, zod 4.4.3, pino 10.3.1, gray-matter 4.0.3, yaml 2.9.0, @anthropic-ai/sdk 0.105.0, tsx 4.22.4, pino-pretty 13.1.3).
- `BrainProvider` interface + `Decision`/`ToolCall`/`BrainContext` types + zod `DecisionSchema`/`ToolCallSchema` built FIRST; `StubBrain` satisfies the interface and returns a zod-valid Decision.
- `ContextItem` carries the `source: 'user'|'self'|'external'` provenance tag — the MEM-05 quarantine seam data shape.
- `kernel-memory/` is its own git repo seeded with the full spec §5 layout; `IDENTITY.md` (60 lines) encodes the three voice rules under a `## Voice Rules` heading.
- `finance/` gitignored broadly + `finance-ignore.test.ts` proving `git ls-files` tracks nothing finance-pathed (MEM-06).
- `skeleton.e2e.test.ts` authored as the RED Walking-Skeleton acceptance contract naming the full perceive→recall→decide→act→log tick.

## Task Commits

Each task was committed atomically (parent code repo `/Users/pravinmaurya/Documents/KernelAi`):

1. **Task 1: Package-legitimacy gate** — no commit (PRE-CLEARED by owner; see Deviations / Checkpoints).
2. **Task 2: Scaffold monorepo + daemon ESM/TS + harness** — `2037b2e` (feat)
3. **Task 3: BrainProvider + StubBrain + ContextItem + DecisionSchema (TDD)** — `ef2e95e` (test, RED) → `3ce0af1` (feat, GREEN)
4. **Task 4: Seed kernel-memory + finance test + failing e2e** — `62ebc19` (feat, daemon side) + `e50521e` (kernel-memory repo seed, committed in its own repo)

_The kernel-memory seed (`e50521e`) lives in the separate `kernel-memory/.git` repo, not the code monorepo._

## Files Created/Modified
- `daemon/package.json` / `package-lock.json` — Node 24 ESM project, exact-pinned deps, build/dev/start/heartbeat/test scripts.
- `daemon/tsconfig.json` — NodeNext + strict + ES2023 + outDir dist/; excludes test/ from the build.
- `daemon/src/config.ts` — zod-validated `config` (memoryDir, socketPath) + `INJECT_CAP = 16384`; fails loud on a missing memory dir.
- `daemon/src/safety/README.md` — gate-chokepoint seam stub (empty in P1; Phase 2/5 fill it).
- `daemon/src/brain/BrainProvider.ts` — interface + Decision/ToolCall/BrainContext + zod DecisionSchema/ToolCallSchema.
- `daemon/src/brain/StubBrain.ts` — deterministic, no-network brain through the real `reason()` seam.
- `daemon/src/memory/types.ts` — `Provenance` + `ContextItem` (the source-tag data shape).
- `daemon/src/brain/StubBrain.test.ts` — 4 behaviors (echo reply, zod-valid Decision, schema rejects malformed, ContextItem source).
- `daemon/test/finance-ignore.test.ts` — git check-ignore + ls-files assertions (MEM-06).
- `daemon/test/skeleton.e2e.test.ts` — RED Walking-Skeleton acceptance contract.
- `kernel-memory/IDENTITY.md` — persona + three voice rules (never auto-edited).
- `kernel-memory/.gitignore` — broad finance ignore + SQLCipher sidecars.
- `kernel-memory/{working-memory/{current.md,quarantine,reflections},knowledge,tasks,projects/registry.md,logs,self/{changelog,metrics}.md}` — spec §5 layout.
- `.gitignore` (root) — added `kernel-memory/` so the parent repo never tracks the nested memory repo.

## Decisions Made
- **Exact pins enforced manually.** `npm install` rewrites versions with `^` carets, violating the plan's no-caret requirement. Rewrote `daemon/package.json` to strip carets and re-ran `npm install` to re-resolve the lockfile to the exact pins (TS 5.9.3, @types/node 24.13.2, etc.). Verified via `npm ls --depth=0`.
- **kernel-memory/ kept fully separate** from the code monorepo via a parent `.gitignore` entry, so the finance ignore + future GitHub backup never touch code history (research §5/§14 rationale).
- **test/ excluded from the tsc build** so the intentionally-RED e2e test (which imports modules that land in 01-02/01-03) cannot break `npm run build`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] zod 4 `.refine()` API mismatch in config.ts**
- **Found during:** Task 2 (scaffold — first `npm run build`).
- **Issue:** The initial `config.ts` used the zod 3 `.refine(fn, (val) => ({ message }))` signature; zod 4.4.3's `.refine()` takes an options object with an `error` callback, so `tsc` failed with TS2345 + TS7006.
- **Fix:** Rewrote the refine to `.refine((p: string) => ..., { error: (issue) => \`...${String(issue.input)}\` })`.
- **Files modified:** `daemon/src/config.ts`
- **Verification:** `npm run build` passes clean.
- **Committed in:** `2037b2e` (Task 2 commit).

**2. [Rule 3 - Blocking] npm caret-injection vs exact-pin requirement**
- **Found during:** Task 2 (dependency install).
- **Issue:** `npm install <pkg>@<ver>` writes `^<ver>` into package.json, contradicting the plan's "EXACT versions (no `^`)" pin rule (which guards against TS 6.x / @types/node 26.x drift).
- **Fix:** Edited `daemon/package.json` to strip all carets, re-ran `npm install` to re-resolve `package-lock.json` to the exact pins.
- **Files modified:** `daemon/package.json`, `daemon/package-lock.json`
- **Verification:** `npm ls --depth=0` shows every dep at its exact pinned version; `grep '"typescript": "5.9.3"'` passes.
- **Committed in:** `2037b2e` (Task 2 commit).

---

**Total deviations:** 2 auto-fixed (1 bug, 1 blocking).
**Impact on plan:** Both were necessary to satisfy the plan's own constraints (clean build + exact pins). No scope creep — no files beyond the plan's `files_modified` set were touched except the root `.gitignore`, which is the documented mechanism for keeping kernel-memory/ a separate repo.

## Checkpoints

**Task 1 — `checkpoint:human-verify` (package legitimacy, gate="blocking-human"):** PRE-CLEARED by the owner before execution. The owner confirmed all nine Phase-1 packages (@anthropic-ai/sdk@0.105.0, pino@10.3.1, zod@4.4.3, gray-matter@4.0.3, yaml@2.9.0, typescript@5.9.3, tsx@4.22.4, @types/node@24.x, pino-pretty@13.1.3) are canonical official packages with no postinstall scripts (RESEARCH.md Package Legitimacy Audit + STACK.md npm-registry verification). The gate was treated as PASSED; installs proceeded with exact pins as instructed. No live human stop occurred.

## Known Stubs

These are intentional, plan-mandated stubs for the Walking Skeleton (not defects):
- **`daemon/src/brain/StubBrain.ts`** — deterministic in-process brain. By design (BRAIN-01): real brains (ClaudeBrain/LocalBrain) drop in behind the same interface in Phase 3. The stub still routes through `reason()` so the seam is real.
- **`daemon/test/skeleton.e2e.test.ts`** — intentionally RED. Imports `../src/ipc/server.js`, `../src/loop.js`, `../src/memory/inject.js`, which land in Plans 01-02 and 01-03. The red state IS the acceptance contract; documented in the file's top comment. Do not force green.
- **`daemon/src/safety/README.md`** — documented empty seam; filled in Phase 2 (`gate.authorize`) and Phase 5 (tiered gate + breaker).

## Issues Encountered
None beyond the two auto-fixed deviations above.

## User Setup Required
None - no external service configuration required in Phase 1 (`ANTHROPIC_API_KEY` is referenced in `.env.example` but unused; no API calls are made).

## Verification Results
- `cd daemon && npm run build` → **PASS**.
- `cd daemon && npm test` → **7 tests, 6 pass, 1 fail** — StubBrain (×4) and finance-ignore (×2) GREEN; `skeleton.e2e.test.ts` RED (intentional, modules land in 01-02/01-03).
- `kernel-memory/` is its own git repo; `git -C kernel-memory ls-files | grep -i finance` → empty (0).
- `IDENTITY.md` contains the three voice rules under `## Voice Rules`; `BrainProvider.ts` exports `DecisionSchema` (contract before any implementation).

## Next Phase Readiness
- The fixed contracts are in place for 01-02 (memory inject/retrieve + UDS NDJSON IPC server) and 01-03 (loop + session-block logging): `BrainProvider`/`StubBrain`, `ContextItem`, `config`/`INJECT_CAP`, and the seeded `kernel-memory/` repo.
- `skeleton.e2e.test.ts` enumerates exactly what "online" means — the four assertions (ready frame, reply echo, `## Session` log block, IDENTITY-first injection ≤16K) are the executable acceptance bar for the rest of Phase 1.
- No blockers.

## Self-Check: PASSED

All 15 key files + 5 `.gitkeep` directory markers verified on disk. All 4 parent-repo commits (`2037b2e`, `ef2e95e`, `3ce0af1`, `62ebc19`) and the kernel-memory repo seed commit (`e50521e`) verified present.

---
*Phase: 01-skeleton*
*Completed: 2026-06-22*
