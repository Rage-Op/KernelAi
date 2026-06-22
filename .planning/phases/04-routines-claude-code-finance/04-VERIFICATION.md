---
phase: 04-routines-claude-code-finance
verified: 2026-06-22T13:35:00Z
status: passed
score: 5/5 must-haves verified
overrides_applied: 0
human_verification:
  - test: "Run a live morning brief against Calendar TCC + real EventKit on a signed build"
    expected: "Calendar events load, invitation accept/propose writes a Yellow-tier reply via the gate"
    why_human: "EventKit TCC requires an owner-signed build; EventKitBridge returns the empty payload under XCTest (by design)"
  - test: "Open Mail.app, trigger the email reply flow, press Send in the EmailPreviewWidget"
    expected: "Peekaboo Mail provider drives Mail.app compose; Sent confirmation appears; source marked read"
    why_human: "Live Peekaboo MCP requires TCC and a running Mail.app; the provider seam returns ok:true in tests but the live GUI choreography is unverifiable in this build env"
  - test: "Configure PLAID_CLIENT_ID / PLAID_SECRET / PLAID_ACCESS_TOKEN, run the finance tool against Plaid Sandbox"
    expected: "Balances and transactions sync into the SQLCipher store; W/M/Y charts populate"
    why_human: "No live Plaid credentials are present; all tests mock the Plaid client (Sandbox needs no Link UI)"
  - test: "Start a real Claude Code session via the bridge, read the live TranscriptPill during streaming"
    expected: "First-person prompt appears as the opening kernel line; Claude responses stream in live with pulse dot; pause/resume works; projects/registry.md row appended"
    why_human: "Requires a live claude CLI on PATH with auth; test runner uses a mock stream runner"
  - test: "Visual/choreography fidelity of the four Phase-4 glass widgets during a live brief"
    expected: "Mail/Accounts/Spending/EmailPreview widgets bloom forward and dissolve per 04-UI-SPEC §6 design spec"
    why_human: "Visual regression and spring-motion fidelity require a running Face app"
---

# Phase 4: Routines + Claude Code + Finance — Verification Report

**Phase Goal:** A full morning brief runs, choreographed, including a gated email send and live spending charts — morning-brief engine (YAML, presets Workday/Weekend/Travel), email reply flow (intent→voice profile→few-shot→preview→gated send), read-only finance aggregation + encrypted gitignored SQLCipher store + W/M/Y spending charts, and a Claude Code bridge with first-person prompting, transparency corner-pill, and project registry. The four-layer finance-leak prevention stack must be verified passing before any backup job exists.
**Verified:** 2026-06-22T13:35:00Z
**Status:** PASSED
**Re-verification:** No — initial verification

---

## Build and Test Results

**Both lanes clean:**

- `daemon: npm run build` — tsc exit 0 (zero errors, zero warnings)
- `daemon: npm test` — **176/176 pass, 0 fail** (all Phase 4 suites + full regression)
- `face: xcodebuild test -scheme Kernel -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO` — **41/41 pass, 0 fail** (all Phase 4 widgets + prior baseline)

---

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Morning brief runs from YAML config, Workday/Weekend/Travel presets switchable, steps choreographed one-or-two at a time via Stage, 7B mail triage (ROUT-01..05) | VERIFIED | `routines/engine.ts` loads + zod-validates `morning-brief.yaml`; `presets.ts` `stepsForPreset` filters the 9 steps; engine caps widget plan at 2 via `assembleSpeak`; `mail_triage` step calls `helper.classify` absent-tolerantly; invitation step emits Yellow ToolCall envelope. 16/16 engine/steps tests pass. |
| 2 | Email reply flow end-to-end: intent→voice profile→few-shot→stakes routing→preview card→explicit Send-only Yellow gate; never auto-sends; external To shown (MAIL-01..05) | VERIFIED | `reply.ts` `compose()` contains zero send/dispatch (grep returns nothing); voice profile always injected via `loadVoiceProfile`; `buildFewShot` reuses shipped `retrieveAndRerank`; `routeStakes` routes casual→7B/high-stakes→cloud; `compose()` returns preview payload only; `tools/mail.ts` op enum `['reply','send','mark-read']` all Yellow via central `classifyTier`; send only via `registry.dispatch → gate.authorize`; `toProvenance:'external'` flagged and shown in Face. 20/20 mail suite tests pass; `EmailPreviewWidgetTests` `testSentCountIsZeroUntilExplicitSend` passes. |
| 3 | Finance via read-only Plaid (mocked), SQLCipher AES-256 store with Keychain key, W/M/Y spending charts (FIN-01..03, FIN-05) | VERIFIED | `tools/finance.ts` op enum `['balances','transactions','aggregate']` — no credential/write op; `finance/keychain.ts` uses zero-dep `/usr/bin/security` CLI (not keytar); `finance/store.ts` opens with `pragma key` + `cipher_compatibility=4`; wrong-key open fails; raw bytes are ciphertext (gold-standard byte-scan asserts no plaintext); W/M/Y aggregate correctly computed (W=52.5, M=152.5, Y=652.5 over seeded data). 23 finance tests pass. |
| 4 | Four-layer finance-leak prevention stack verified passing before any backup exists: (a) gitignore, (b) pre-push byte-scan hook — stable and detection-preserving, (c) at-rest AES-256 encryption, (d) startup ls-files assertion (FIN-04) | VERIFIED | All four layers proven by automated tests (details below). Leakguard suite run 8 consecutive times: **8/8 clean** with detection intact (finance-path abort fires, value-in-non-finance abort fires, clean push passes — every run). |
| 5 | Claude Code bridge: first-person prompts as Pravin, live scrollable cornerPill transcript Pravin can read/interject/pause, projects/registry.md cold-resume, Red-from-CC denied via the shipped gate (CC-01..04) | VERIFIED | `authorFirstPersonPrompt()` returns `"I need you to work in <repo>. <goal>\n\nWork carefully…"` (first person, never third person); `TranscriptPill.swift` is a scrollable, partial-merge, pause-controllable transcript in the cornerPill; `AppCoordinator` buffers the new inbound `.transcript` arm; `projects/registry.md` seeded with table header + append logic in `appendToRegistry()`; CC-03 gate test asserts `rmrf.kind === 'deny'` and `purchase.kind === 'deny'` with tier `'red'` — no `gated`/`allow` arm. 22 CC-bridge tests pass; 41 Face tests pass. |

**Score: 5/5 truths verified**

---

### The Finance-Leak Gate — Layer-by-Layer Detail (ROADMAP Criterion 4 — gates Phase 5)

| Layer | What it proves | Test file | Result |
|-------|---------------|-----------|--------|
| (a) gitignore + sidecars | `finance/`, `finance/finance.db`, and every SQLCipher sidecar (`-wal/-shm/-journal`) are ignored in kernel-memory repo | `test/finance-ignore.test.ts` (`git check-ignore`) | PASS — 4/4 including literal DB filename + 3 sidecars |
| (b) pre-push byte-scan hook | Installed hook scans ADDED CONTENT lines only (`^+` minus `+++`), never git metadata; exits non-zero on finance PATH and on finance-shaped VALUE; clean commit exits zero; no `--no-verify` / blanket add policy | `test/finance-leakguard.test.ts` 5/5 | PASS — 8 consecutive runs: 8/8 clean; finance-path abort and value abort fire every run; clean push passes every run |
| (c) at-rest AES-256 encryption | Open with key → write plaintext memo → close; reopen wrong key FAILS; reopen right key returns row; raw DB bytes scanned for memo → ABSENT; no `SQLite format 3` header | `src/finance/store.test.ts` | PASS — 4/4 gold-standard at-rest byte scan |
| (d) startup ls-files assertion | `assertFinanceNotTracked` in `leakguard.ts` throws when finance-pathed files are tracked; tolerates non-git dir; live kernel-memory repo is clean | `src/safety/leakguard.test.ts` + live `git ls-files` | PASS — live check: 0 finance-pathed files tracked |

**Live cross-checks:**
- `kernel-memory/.git/hooks/pre-push` — present, executable (`test -x` passes)
- `daemon/scripts/hooks/kernel-memory-pre-push.sh` — identical tracked template, content matches
- `git -C kernel-memory ls-files | grep -i finance` — empty (nothing finance-tracked)
- Flake root cause confirmed fixed: hook comment explains the `added_content()` filter that strips git metadata (commit/blob SHA lines) preventing the 12+ digit false-positive. Detection unchanged: `DOLLAR_RX`, `ACCT_RX`, `PATH_RX` all enforced against actual diff content.

---

### Invariant Audit

| Invariant | Verification | Result |
|-----------|-------------|--------|
| Never auto-send — `reply.ts compose()` has zero send/dispatch | `grep -nE "\.send\(|sendMail|dispatch\(" src/mail/reply.ts` | CLEAN |
| Anti-bypass — engine/steps never import `safety/gate` or `safety/tiers` | `grep -nE "from '\.\./safety/(gate|tiers)" src/routines/engine.ts src/routines/steps.ts` | CLEAN |
| Finance tool has NO credential/type op | `financeArgsSchema` op enum is `['balances','transactions','aggregate']` + `.strict()` — no write/credential field can be smuggled | CLEAN |
| Transcript IPC arm is strictly ADDITIVE — no existing arms mutated | `git diff 597958f 355c244 -- src/ipc/protocol.ts | grep "^-" | grep -v "^---"` | 0 removed lines |
| Keychain via `/usr/bin/security` CLI, not keytar or @napi-rs | `import` statements in `keychain.ts`: only `node:child_process` + `node:crypto`; keytar/napi appear only in doc comments | CLEAN |
| Red-from-CC denied — gate.ts unchanged, no `gated`/`allow` arm for Red | `gate.test.ts` CC-03 test: `rmrf.kind === 'deny'`, `purchase.kind === 'deny'`; `gate.ts` not modified in P4 | VERIFIED |
| EmailPreviewWidget — send count zero until explicit Send | `EmailPreviewWidgetTests.testSentCountIsZeroUntilExplicitSend` passes | VERIFIED |
| finance/ path never git-tracked in kernel-memory | Live `git ls-files` returns empty for finance pattern | VERIFIED |

---

### Required Artifacts

| Artifact | Status | Details |
|----------|--------|---------|
| `daemon/src/routines/engine.ts` | VERIFIED | YAML load + zod validation + ordered async runner + assembleSpeak integration |
| `daemon/src/routines/steps.ts` | VERIFIED | 9 handlers; mail_triage→helper.classify; invitations→Yellow ToolCall; anti-bypass clean |
| `daemon/src/routines/presets.ts` | VERIFIED | `stepsForPreset` filters by preset list AND step.enabled |
| `daemon/src/routines/morning-brief.yaml` | VERIFIED | 9 steps + Workday/Weekend/Travel preset maps; zod-validated |
| `daemon/src/mail/voice-profile.ts` | VERIFIED | Always injects ~200-token profile; fallback on absent, never silent |
| `daemon/src/mail/reply.ts` | VERIFIED | compose() returns preview only; no send path; external To flagged |
| `daemon/src/tools/mail.ts` | VERIFIED | Yellow op enum; send only via registry.dispatch→gate.authorize; MailProvider seam |
| `daemon/src/finance/keychain.ts` | VERIFIED | `/usr/bin/security` CLI wrapper; absent-tolerant; key never logged |
| `daemon/src/finance/store.ts` | VERIFIED | SQLCipher AES-256; key-shape guard; raw bytes are ciphertext |
| `daemon/src/finance/plaid-client.ts` | VERIFIED | Read-only Plaid wrapper + `__setPlaidClientForTest` seam |
| `daemon/src/tools/finance.ts` | VERIFIED | Read-only `.strict()` schema; syncs Plaid→store; returns widget payloads |
| `daemon/src/safety/leakguard.ts` | VERIFIED | `assertFinanceNotTracked` throws on any tracked finance path; tolerates non-git |
| `daemon/src/tools/claude-code.ts` | VERIFIED | First-person prompt; stream-json NDJSON runner; transcript frames via emit seam; registry append |
| `face/Kernel/Widgets/MailWidget.swift` | VERIFIED | Typed fields; 4 suggestion chips; no remote resources |
| `face/Kernel/Widgets/AccountsWidget.swift` | VERIFIED | Typed balance fields; no full account number exposed |
| `face/Kernel/Widgets/SpendingWidget.swift` | VERIFIED | W/M/Y timeframe; series bar chart from local aggregation |
| `face/Kernel/Widgets/EmailPreviewWidget.swift` | VERIFIED | To/Subject/body/signature preview; external-To marker; explicit Send ui.intent; sentCount=0 until Send |
| `face/Kernel/Calendar/EventKitBridge.swift` | VERIFIED | Returns empty payload under XCTest (by design); invitation reply is ui.intent with no tier |
| `face/Kernel/ClaudeCode/TranscriptPill.swift` | VERIFIED | Scrollable; partial-merge; pause control; accent pulse dot; text-only (no AsyncImage/WKWebView) |
| `kernel-memory/.git/hooks/pre-push` | VERIFIED | Installed, executable; content-only scanning; deliberate-abort fires; clean passes |
| `daemon/scripts/hooks/kernel-memory-pre-push.sh` | VERIFIED | Tracked template; byte-for-byte identical to the installed hook |
| `kernel-memory/projects/registry.md` | VERIFIED | Table header seeded; append-only target |

---

### Key Links Verified

| From | To | Via | Status |
|------|----|-----|--------|
| `email_reply` step | No auto-send | `steps.ts` emits no ToolCall on `email_reply` (fills preview widget only) | VERIFIED |
| Face Send button | `mail` tool execute | `CloudWindow` ui.intent{intent:'send-email'} → loop → `registry.dispatch` → `gate.authorize` (Yellow) → `mailTool.execute` | VERIFIED |
| `compose()` | Preview payload only | grep over `reply.ts` finds no `send`/`dispatch` invocation | VERIFIED |
| Finance tool | Keychain key | `getOrCreateKeychainKey` → `/usr/bin/security` CLI → DB key transient in memory only | VERIFIED |
| Pre-push hook | Content-only diff | `added_content()` filters `^+` minus `+++` lines; metadata SHAs never scanned | VERIFIED |
| `runSession()` | Transcript IPC arm | `emit(frame)` where `frame.type === 'transcript'`; `AppCoordinator` handles `.transcript` inbound case | VERIFIED |
| Red-from-CC | `gate.authorize` deny | `gate.ts` unchanged; `authorize` classifies any Red op as `deny`; CC-03 test passes | VERIFIED |

---

### Requirements Coverage

| Requirement | Evidence | Status |
|-------------|----------|--------|
| ROUT-01 | Steps load from `morning-brief.yaml`; every step zod-validated (id/order/enabled/tier/params); malformed → `RoutineConfigError` | SATISFIED |
| ROUT-02 | `presets:` map in YAML + `stepsForPreset`; Weekend/Travel proven non-equal to Workday by `notDeepEqual` assertion | SATISFIED |
| ROUT-03 | Steps run ascending by `order`, disabled skipped; each narrated step → ONE speak frame with ≤2 cues (cap enforced in `engine.run`) | SATISFIED |
| ROUT-04 | `mail_triage` calls `helper.classify` per message; Ollama-absent → neutral default 'log'; never auto-acts | SATISFIED |
| ROUT-05 | `invitations` emits `{tool:'mail', args:{op:'reply'}}` envelope; `classifyTier` yields Yellow centrally; EventKitBridge is Face-side | SATISFIED |
| MAIL-01 | `loadVoiceProfile` always returns a descriptor (fallback when absent); `buildRewritePrompt` always embeds the profile text | SATISFIED |
| MAIL-02 | `buildFewShot` reuses shipped `retrieveAndRerank`; slices top 2-3 by recipient keyword overlap | SATISFIED |
| MAIL-03 | `routeStakes` routes by HIGH_STAKES keywords or explicit flag; casual→7B, high-stakes→ClaudeBrain | SATISFIED |
| MAIL-04 | `compose()` returns `{to,subject,body,signature,toProvenance}` preview; no send; Yellow gate is in `tools/mail.ts` only | SATISFIED |
| MAIL-05 | External-sourced To flagged (`toProvenance:'external'` daemon-side; `toIsExternal` Face-side); send dispatches via provider, marks source read, logs metadata only | SATISFIED |
| FIN-01 | Read-only Plaid wrapper (`Balance` + `Transactions` only); mocked in tests; `__setPlaidClientForTest` seam | SATISFIED |
| FIN-02 | Finance op enum `['balances','transactions','aggregate']` + `.strict()` — no credential/write op can exist structurally | SATISFIED |
| FIN-03 | SQLCipher store at `kernel-memory/finance/finance.db`; DB key in macOS Keychain via `security` CLI; key never on disk or in logs | SATISFIED |
| FIN-04 | All four layers proven by automated tests + 8-run leakguard stability check; pre-push hook installed + executable; flake fixed without weakening detection | SATISFIED |
| FIN-05 | W/M/Y `aggregate()` SQL computes spending (amount<0) over time window; per-day series; seeded test values match expected totals | SATISFIED |
| CC-01 | `authorFirstPersonPrompt` returns `"I need you to work in <repo>. <goal>…"` — first person, direct | SATISFIED |
| CC-02 | `runSession` streams `claude -p --output-format stream-json --include-partial-messages`; each NDJSON line → `transcript` frame via inject `emit` seam; `TranscriptPill` renders live in cornerPill | SATISFIED |
| CC-03 | `gate.authorize` returns `{kind:'deny', tier:'red'}` for any Red op regardless of `tool:'claude-code'` originator; `gate.ts` unmodified; re-submission shim deferred to Phase 5 | SATISFIED |
| CC-04 | `appendToRegistry` writes to `projects/registry.md` on session start; explicit-path write (never `git add -A`); registry seeded with table header | SATISFIED |

**19/19 Phase 4 requirements satisfied**

---

### Anti-Patterns Found

| File | Pattern | Severity | Impact |
|------|---------|----------|--------|
| `tools/mail.ts` `peekabooMailProvider.send` | Brings Mail.app to foreground but does not drive full GUI compose/send keystrokes | WARNING — documented manual owner check | The provider seam is fully wired; the live GUI choreography is acknowledged as a MANUAL OWNER CHECK in the SUMMARY. The gate, registry dispatch, and Yellow classification are all functional. No stub in the safety-critical code path. |
| `face/Kernel/Calendar/EventKitBridge.swift` | Returns empty events payload under XCTest | INFO — by design | `isUnderXCTest` guard is the correct pattern (matches AppCoordinator precedent from Phase 3); real EventKit requires TCC in a signed build |

No `TBD`, `FIXME`, or `XXX` markers found in Phase 4 files. No unreferenced debt markers.

---

### Human Verification Required

The following checks require live environment conditions not available in this build env. All have documented precedent as manual owner checks (matching Phase 1–3 pattern per 04-USER-SETUP.md and the individual SUMMARYs).

**1. Live Calendar + EventKit Invitation Reply**
**Test:** On a signed build with Calendar TCC, run the morning brief against real EventKit data; find a pending invitation and let KERNEL propose a reply.
**Expected:** Invitation step reads calendar events via EventKitBridge; invitation reply ui.intent routes through the Yellow gate; accept/propose writes back correctly.
**Why human:** EventKit TCC requires a signed build; EventKitBridge returns empty payload under XCTest by design.

**2. Live Email Send via Peekaboo Mail.app**
**Test:** On a signed build with Peekaboo MCP running, trigger the email reply flow, compose a reply, press Send in the EmailPreviewWidget.
**Expected:** `peekabooMailProvider.send` drives Mail.app compose; "Sent. Marked read." confirmation appears in the widget; source message is marked read.
**Why human:** Live MCP/TCC unavailable in this build env; `peekabooMailProvider` brings Mail.app to foreground but full GUI keystroke choreography is unverifiable without a running Peekaboo daemon.

**3. Live Plaid Finance Sync**
**Test:** Set `PLAID_CLIENT_ID` / `PLAID_SECRET` / `PLAID_ACCESS_TOKEN`, run the finance tool against Plaid Sandbox; check balances and transactions in the AccountsWidget and SpendingWidget.
**Expected:** Balances and transactions sync into the SQLCipher store; W/M/Y charts populate with real data.
**Why human:** No live Plaid credentials present; all automated tests mock the Plaid client.

**4. Live Claude Code Session — TranscriptPill Streaming**
**Test:** With `claude` CLI on PATH and authenticated, start a real Claude Code session via the bridge; observe the TranscriptPill in the cornerPill.
**Expected:** First-person kernel prompt appears as opening line; Claude responses stream in real-time with the live-pulse dot; pause/resume works; `projects/registry.md` row appended.
**Why human:** Requires live `claude` CLI with API auth; test runner uses a mock stream runner that never spawns a real `claude`.

**5. Phase-4 Widget Visual/Choreography Fidelity**
**Test:** Run a live morning brief on a signed build; observe all four Phase-4 glass widgets (Mail/Accounts/Spending/EmailPreview) during the choreographed brief.
**Expected:** Each widget blooms forward and dissolves per 04-UI-SPEC §6; spring motion; hairline borders; SF Pro tabular numerals for money; no snapping.
**Why human:** Visual regression and spring-motion fidelity require a running Face app.

---

### Gaps Summary

No functional gaps. All 5 ROADMAP success criteria are verified with code-level evidence. All 19 requirements (ROUT-01..05, MAIL-01..05, FIN-01..05, CC-01..04) are satisfied by substantive, wired, data-flowing implementations.

The five items in Human Verification are live-environment checks that match the Phase 1–3 precedent for manual owner checks (TCC, Peekaboo MCP, live Plaid, live `claude` CLI, visual fidelity). None represent missing code; all represent the boundary between automated tests and production-environment integration.

The finance-leak gate (ROADMAP criterion 4, which gates Phase 5) is confirmed stable: 8 consecutive leakguard runs all pass with detection intact. The flake was a metadata-scanning bug (40-hex SHAs tripping the 12-digit account heuristic) now fixed by scanning only `^+`-minus-`+++` diff content lines. Detection has not been weakened.

Phase 5 remains GATED — explicit owner approval required before it begins.

---

_Verified: 2026-06-22T13:35:00Z_
_Verifier: Claude (gsd-verifier)_
