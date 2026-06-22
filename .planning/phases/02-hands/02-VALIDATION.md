---
phase: 2
slug: hands
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-22
---

# Phase 2 — Validation Strategy

> Per-phase validation contract. Test harness (`node:test` + `tsx`) already established in Phase 1; Wave 0 here adds tool fixtures (a `file://` login-form page, a mocked MCP transport).

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `node:test` (built-in) via `tsx` — established Phase 1 |
| **Config file** | none — `daemon/package.json` `test` script |
| **Quick run command** | `cd daemon && npm test` |
| **Full suite command** | `cd daemon && npm test` |
| **Estimated runtime** | ~10–25 seconds (Playwright fixture adds a few s) |

---

## Sampling Rate

- **After every task commit:** `cd daemon && npm test`
- **After every plan wave:** full suite
- **Before `/gsd-verify-work`:** full suite green
- **Max feedback latency:** ~25 seconds

---

## Per-Task Verification Map

| Criterion | Requirement(s) | Secure Behavior | Test Type | Status |
|-----------|----------------|-----------------|-----------|--------|
| Peekaboo GUI ops + open Mail | HANDS-01, HANDS-02 | capture/click/type/menu via MCP adapter | unit (mocked transport) + manual gate (real Mail) | ⬜ pending |
| Playwright headful end-to-end | HANDS-03 | dedicated profile, navigate/scrape/fill, full-URL+provenance logging | unit (`file://` fixture) + manual gate (real login) | ⬜ pending |
| Tool router registers + dispatches | HANDS-04 | registry + dispatch; default-deny on unknown tool | unit | ⬜ pending |
| Single gate.authorize chokepoint | HANDS-05 | every dispatch authorized first; no tool self-classifies; no bypass path | unit | ⬜ pending |
| Credential-entry fence | HANDS-01, HANDS-05 | secure/password/CVV/SSN field → refuse + escalate | unit | ⬜ pending |
| Red-tier = deny + escalate (P2) | HANDS-05 | no Red autonomy before Phase 5; gate denies Red | unit | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/fixtures/login-form.html` — `file://` page with a labelled password field for fence + Playwright fill tests
- [ ] mocked MCP transport helper for Peekaboo adapter unit tests
- [ ] install pinned deps: `@modelcontextprotocol/sdk@1.29.0`, `playwright@1.61.0` (+ `npx playwright install chromium`); Peekaboo via brew binary (not npm)

*Harness exists from Phase 1; Wave 0 only adds fixtures + tool deps.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Open + drive real Mail.app | HANDS-02 | Needs TCC Accessibility/Automation + live Mail | Grant perms; run the Peekaboo open-Mail flow; confirm a compose window opens |
| Real site login end-to-end | HANDS-03 | Needs live network + credentials | Run browser tool against a real login; confirm authenticated state in the dedicated profile |
| Credential fence on a real secure field | HANDS-01 | Needs a real password field's AX/DOM signals | Point the type-tool at a real password field; confirm it refuses + escalates |
| TCC grant survives rebuilds | HANDS-01 | macOS re-prompts on binary hash change | Rebuild daemon; confirm Accessibility/Screen-Recording grants persist or document re-grant |
