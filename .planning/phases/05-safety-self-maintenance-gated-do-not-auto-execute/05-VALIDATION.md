---
phase: 5
slug: safety-self-maintenance-gated-do-not-auto-execute
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-22
---

# Phase 5 — Validation Strategy

> The most safety-critical phase. Daemon lane only (`node:test`+`tsx`); no new packages. The breaker is a pure state machine with an INJECTABLE clock/executor/cancel/ledger/audit, so EVERY irreversible path is tested with mocks/dry-runs. **No test may ever perform a real `rm -rf`, purchase, spend, or push to a real remote.**

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `node:test` via `tsx` (existing) — all transports/clock/executor MOCKED |
| **New deps** | none (zod, gray-matter, pino, @anthropic-ai/sdk + node built-ins only) |
| **Quick run** | `cd daemon && npm test` |
| **Estimated runtime** | ~30–50s |

---

## Sampling Rate
- After every task commit: `cd daemon && npm test`.
- Before `/gsd-verify-work`: full daemon suite green; the critical-invariant tests (Red-always-gated, external-Red-hard-block, no-real-side-effects) all green.

---

## Per-Task Verification Map

| Criterion | Requirement(s) | Observable Behavior | Test Type | Status |
|-----------|----------------|---------------------|-----------|--------|
| Tiered gate + breaker live | SAFE-01/02/03 | Green allow; Yellow proceed+log+notify; Red → dry-run preview → 10s cancel (fake clock) → spend-ceiling → audit → execute (mock executor) | unit | ⬜ |
| Non-overridable hard rules | SAFE-04 | credential fence non-overridable; **Red+external instruction HARD-BLOCKED even under /override** (test-injection email cannot trigger Red); spend ceiling atomic single-writer | unit | ⬜ |
| Red gating inside Claude Code | SAFE-05 | CC Red action (rm -rf/purchase) re-enters the breaker via deny-rules + permission_denials, does not auto-run; TOCTOU: content-hash re-verify + state re-read before execute | unit (mock stream) | ⬜ |
| Obstacle ladder | SAFE-06 | try→replan→decompose→backoff→escalate-with-specific-recommendation; Red gates skip ladder, escalate immediately | unit (injected failures) | ⬜ |
| Override flag-flip safe | SAFE-07 | enabling gate/override doesn't change P1–P4 behavior except intended; was unreachable before | unit + full-suite regression | ⬜ |
| Nightly consolidation | MEM-07, MAINT-03 | logs/ → reflections/ distillation; durable facts → knowledge/; **external/quarantine-sourced facts NEVER auto-promoted; IDENTITY.md never auto-edited** | unit | ⬜ |
| Cleanup + backup | MAINT-01/03 | prune stale working-memory/logs; backup uses explicit `git add <paths>` (NEVER -A/-f), finance/ excluded, pre-push hook + ls-files assertion hold; dry-run push to a TEMP repo | unit | ⬜ |
| Self changelog + metrics | MAINT-02 | self/changelog.md + self/metrics.md maintained | unit | ⬜ |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements
- [ ] Breaker test harness: injectable `clock` (fake timers for the 10s window), mock `executor`, mock `cancel` source, in-memory `ledger`, capture `audit` sink
- [ ] A test-injection "poisoned email" fixture whose instruction maps to a Red ToolCall with `origin: external` — asserts HARD-BLOCK under active /override
- [ ] Mock `claude` stream-json with a Red tool-use/permission event for the SAFE-05 shim
- [ ] Temp git repo + temp "remote" (bare repo) for the backup dry-run — never a real GitHub remote
- [ ] logs/ fixtures (incl. external-sourced entries) for consolidation no-promote test

---

## Manual-Only Verifications (documented owner checks)
| Behavior | Requirement | Why Manual | Instructions |
|----------|-------------|------------|--------------|
| launchd runs consolidation/cleanup/backup on schedule | MAINT-03 | needs real login + StartCalendarInterval | Install the new plists; confirm jobs fire and write reflections/changelog |
| Live GitHub backup push | MAINT-01 | needs an SSH deploy key + private remote | Add the kernel-memory remote + deploy key; install the pre-push hook; confirm a push succeeds and finance/ is absent |
| Live Claude Code Red action is gated | SAFE-05 | needs a real `claude` session attempting a Red op | Run a CC task that tries `rm -rf`; confirm it is denied/re-gated, not auto-run |
| /override end-to-end incl. a real (reversible) Red dry-run | SAFE-02/03 | perceptual + needs the Face | Type `/override`; trigger a Red action; confirm the 10s cancel preview appears and the audit entry is written |
