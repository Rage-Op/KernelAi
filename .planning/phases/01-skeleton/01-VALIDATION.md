---
phase: 1
slug: skeleton
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-22
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Phase 1 is greenfield — Wave 0 installs the test framework before any feature task runs.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `node:test` (built-in) run through `tsx` — no extra runtime deps, matches Node 24 ESM |
| **Config file** | none — Wave 0 wires the `test` script in `daemon/package.json` |
| **Quick run command** | `cd daemon && npm test` |
| **Full suite command** | `cd daemon && npm test` |
| **Estimated runtime** | ~5–15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd daemon && npm test`
- **After every plan wave:** Run the full suite
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** ~15 seconds

---

## Per-Task Verification Map

> Populated by the planner to match PLAN.md task IDs. Each Phase-1 requirement maps to at least one observable test or a documented manual phase-gate check. The five ROADMAP success criteria are the acceptance backbone.

| Criterion | Requirement(s) | Secure Behavior | Test Type | Status |
|-----------|----------------|-----------------|-----------|--------|
| Daemon persists + event loop idles | CORE-01, CORE-02 | Loop runs one tick then idles; relaunch via launchd | unit + manual gate | ⬜ pending |
| Memory injection priority + 16K cap | MEM-02, MEM-03, MEM-04, PERS-01 | IDENTITY.md never dropped; cap enforced; keyword rerank | unit | ⬜ pending |
| Heartbeat writes dated log entry | CORE-03, CORE-05 | launchd timed job appends one dated line to append-only log | unit + manual gate | ⬜ pending |
| BrainProvider + StubBrain + provenance | BRAIN-01, MEM-05 | `reason()` returns Decision; ContextItem carries `source:` tag | unit | ⬜ pending |
| Quarantine no-promote + finance gitignored + IPC attach | MEM-05, MEM-06, CORE-04 | external never auto-promoted; `finance/` untracked; Face attaches to UDS | unit + manual gate | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `daemon/package.json` — add `"test": "tsx --test test/**/*.test.ts"` (or `node --import tsx --test`)
- [ ] First smoke test asserting the build/import graph loads
- [ ] No external test framework — `node:test` is built in

*Greenfield: Wave 0 establishes the test harness this phase's per-requirement tests run against.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| launchd relaunches daemon at login | CORE-01, CORE-03 | Requires a real login session / `launchctl bootstrap` | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.kernel.daemon.plist`, then confirm process is alive and the heartbeat plist appended a dated line |
| IDENTITY.md integrity guard | MEM-02 | Tamper test against the on-disk file | Modify IDENTITY.md out-of-band; confirm startup hash check flags it |
