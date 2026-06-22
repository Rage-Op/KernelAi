---
phase: 4
slug: routines-claude-code-finance
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-22
---

# Phase 4 — Validation Strategy

> Two lanes: daemon (`node:test`+`tsx`) and Face (`xcodebuild test`/XCTest). The 4-layer finance-leak prevention stack is in the TESTABLE column (it gates Phase 5) — including a deliberate-abort test of the pre-push hook against the `kernel-memory/` repo.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Daemon** | `node:test` via `tsx` (existing) — Plaid/Mail/claude-CLI MOCKED |
| **Face** | XCTest via `xcodebuild test -scheme Kernel -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO` |
| **New deps** | `plaid@42.2.0`, `better-sqlite3-multiple-ciphers@12.11.1` (exact pins); Keychain via the `security` CLI (zero-dep) |
| **Quick run (daemon)** | `cd daemon && npm test` |
| **Estimated runtime** | daemon ~20–40s; Face build+unit ~variable |

---

## Sampling Rate
- After every task commit: run the affected lane.
- After every wave: both lanes.
- Before `/gsd-verify-work`: daemon green + Face compiles + Face unit green + **all 4 finance-leak layers proven passing**.

---

## Per-Task Verification Map

| Criterion | Requirement(s) | Observable Behavior | Test Type | Status |
|-----------|----------------|---------------------|-----------|--------|
| Morning brief runs choreographed | ROUT-01/02/03/04/05 | YAML parse; step ordering; preset switch; 7B triage tags; steps bloom via Stage | unit + manual (live cal/mail) | ⬜ |
| Email reply flow gated | MAIL-01..05 | intent→voice-profile inject→few-shot select→stakes route→preview card→explicit Send only; never auto-send; external-addr shown | unit + manual (live send) | ⬜ |
| Finance read-only + encrypted store + charts | FIN-01/02/03/05 | Plaid read-only (mocked); SQLCipher round-trip with Keychain key; W/M/Y aggregation; never types bank creds | unit + manual (live Plaid link) | ⬜ |
| **4-layer finance-leak prevention (GATES P5)** | FIN-04 | (a) finance/ gitignored, (b) pre-push hook scans staged bytes & ABORTS — deliberate-abort test, (c) SQLCipher at-rest encryption, (d) startup `git ls-files\|grep finance` assertion fails loud — all against the kernel-memory/ repo | unit/integration (ALL testable) | ⬜ |
| Claude Code bridge + transparency + registry | CC-01/02/03/04 | first-person prompt authoring; stream-json transcript → cornerPill; projects/registry.md I/O; Red intercept DEFERRED to P5 (Green/Yellow only) | unit + manual (live session) | ⬜ |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements
- [ ] Daemon fixtures: mock Plaid client (`/sandbox/public_token/create` + exchange), mock Mail/Peekaboo send, mock `claude` stream-json transcript, sent-mail corpus fixture for voice profile + few-shot
- [ ] Install pinned `plaid@42.2.0` + `better-sqlite3-multiple-ciphers@12.11.1` (exact, no caret)
- [ ] A temp `kernel-memory/`-style git repo fixture for the leak-hook deliberate-abort test
- [ ] Face: spending/accounts/mail/email-preview widget XCTests + transcript-pill render test

---

## Manual-Only Verifications (documented owner checks)
| Behavior | Requirement | Why Manual | Instructions |
|----------|-------------|------------|--------------|
| Live Plaid link (sandbox→real) | FIN-01 | needs Plaid keys + OAuth | Add Plaid keys; run link; confirm read-only token + balances populate |
| Live email send | MAIL-05 | needs real Mail.app/Gmail + a recipient | Run reply flow; confirm preview; Send; confirm sent + source marked read |
| Live calendar | ROUT-05 | EventKit TCC + real calendar | Grant Calendar; run brief; confirm events + invitation reply (Yellow) |
| Live Claude Code session | CC-01/02 | needs a real task | Trigger a coding task; confirm first-person prompt + live transcript in the pill + registry entry |
| Choreographed brief fidelity | ROUT-03 | perceptual | Run a full morning brief; watch steps bloom/dissolve in sync with narration |
