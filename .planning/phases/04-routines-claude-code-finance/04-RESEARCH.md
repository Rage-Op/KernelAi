# Phase 4: Routines + Claude Code + Finance — Research

**Researched:** 2026-06-22
**Domain:** Composing the shipped daemon + Face into a working foreman — a YAML routine engine, an email reply flow, read-only Plaid finance with a 4-layer leak-prevention stack + SQLCipher store, and a Claude Code bridge with a transparency pill + project registry (spec Phase 3)
**Confidence:** HIGH (the entire stack is pinned in CLAUDE.md/STACK.md, every Phase 1–3 contract was read from the shipped source, packages verified on the npm registry + slopcheck `[OK]`, the `security` Keychain CLI and `claude --output-format stream-json` capabilities were exercised live on this machine)

## Summary

Phase 4 is almost entirely **composition, not invention**. Every primitive it needs already shipped and was read directly from source: the event-driven serial loop (`loop.ts` — `enqueue`/`drain`/`setBrain`), the cue assembler (`ipc/cues.ts` — `assembleSpeak(id, reply, widgetPlan)`), the frozen `FrameSchema` discriminated union (`ipc/protocol.ts`) and its byte-exact Swift mirror (`Frames.swift`), the single gate chokepoint (`registry.dispatch → gate.authorize → tiers.classifyTier`), the always-on 7B helper (`brain/helper.ts` — `triage`/`classify`/`narrate`, absent-tolerant), the keyword retrieval+rerank (`memory/retrieve.ts`), the Peekaboo Mail adapter, the `ClaudeCodeBrain` headless runner, and the Face `StageController` + `AppCoordinator` + `EventsWidget` bloom/dissolve pattern + the `CloudWindow` two-state cornerPill. Phase 4 wires these into four features.

The four features map cleanly onto the shipped seams. **Routines (ROUT):** a `routines/engine.ts` parses `routines/morning-brief.yaml` with `yaml` (already installed) into a zod-validated step list, runs steps serially, and per step emits a `speak` frame via `assembleSpeak` so the Stage blooms the matching widget — exactly the Phase 3 events-widget pattern repeated for mail/accounts/spending/email-preview. **Email reply (MAIL):** intent → voice-profile injection (a ~200-token markdown file in `kernel-memory/knowledge/`) + few-shot via the existing `retrieveAndRerank` → stakes routing (helper 7B vs ClaudeBrain) → the email-preview "Send it?" card → an explicit `ui.intent` Send that is the Yellow gate, dispatched through the Peekaboo Mail tool. **Finance (FIN):** `plaid@42.2.0` Sandbox read-only aggregation into a `better-sqlite3-multiple-ciphers@12.11.1` SQLCipher store under `kernel-memory/finance/` with the DB key in the macOS Keychain (via the `security` CLI — verified working, zero-dep), plus W/M/Y aggregation queries feeding the spending widget. **Claude Code (CC):** first-person prompt authoring, a transparency pill fed by `claude -p --output-format stream-json --include-partial-messages` events streamed over a new additive `transcript` IPC arm into the existing `cornerPill` cloud state, and a `projects/registry.md` append.

The one genuinely load-bearing, **gating** deliverable is the 4-layer finance-leak stack (ROADMAP criterion 4, FIN-04). Layers (a) gitignore and (d) `git ls-files` assertion are partly seeded already — the `kernel-memory/.gitignore` pre-ignores `finance/`, `**/finance/**`, and SQLCipher sidecars, and `daemon/test/finance-ignore.test.ts` already asserts both check-ignore and ls-files cleanliness. Phase 4 adds (b) the pre-push hook scanning staged bytes (proven by a deliberate-abort test) and (c) at-rest SQLCipher encryption with the Keychain key, then proves all four pass **before** the Phase 5 backup job exists. Critically, `kernel-memory/` is its **own git repo** (separate from the project root) with **no remote and no active hooks** today — the hook and the assertion both target that repo.

**Primary recommendation:** Build Phase 4 as four additive composition slices over the frozen seams — never mutate `FrameSchema` arms (append a `transcript` arm and reuse `widget.data`/`speak`/`ui.state`), never reach a tool except through `registry.dispatch`, classify every routine/email/finance/CC action through the existing `gate.authorize` (Red still = deny pre-Phase-5), and store finance encrypted with a Keychain key via the `security` CLI. Verify the 4 finance-leak layers as the phase gate before any backup work.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Morning-brief YAML parse + step ordering + preset switching | Daemon (`routines/engine.ts`) | — | Routines are orchestration; the daemon owns the loop, scheduling, and tier per step (spec §1, §11). Pure logic, fully unit-testable. |
| Per-step narration → widget choreography | Daemon produces (`cues.ts`) → Face fires | Face (`StageController`) owns the clock | Daemon decides *what* widget goes with *which phrase* (char-offset cues); the Face's TTS boundary clock decides *when* (ARCHITECTURE choreography contract — locked). |
| Mail triage tagging (log/reply/open/archive) | Daemon 7B helper (`helper.classify`) | — | BRAIN-05: the always-on 7B is the cheap classifier; absent-tolerant neutral default. Pure-mockable. |
| Calendar read + invitation reply | Face (EventKit) reads → daemon decides | Daemon (Yellow gate on reply) | EventKit needs the Face's app identity + Calendar TCC; the *reply write* is a Yellow-tier action that routes back through the daemon gate (ROUT-05). |
| Voice-profile distillation + injection | Daemon (`memory/` + brain prompt) | — | A ~200-token profile is durable knowledge stored in `kernel-memory/knowledge/`; injected into the rewrite prompt. Daemon-side. |
| Few-shot past-email retrieval | Daemon (`memory/retrieve.ts`) | — | Reuse the shipped keyword retrieval+rerank; no new retrieval engine (MAIL-02). |
| Email stakes routing (casual→7B / high-stakes→cloud) | Daemon (brain selection) | — | The daemon owns brain choice; helper for casual, `ClaudeBrain` for high-stakes (MAIL-03). |
| Email send + mark-read | Daemon dispatch → Peekaboo (Mail GUI) | Browser (Gmail) fallback | Send is a Yellow tool call through the gate; Peekaboo drives Mail.app (shipped in Phase 2). |
| Plaid OAuth link + token exchange | Owner (bank's own flow) → daemon stores token | — | FIN-01/FIN-02 hard rule: KERNEL never types bank creds; the OAuth happens in Plaid Link/the bank UI, KERNEL receives a read-only `access_token`. |
| Finance encrypted store + W/M/Y aggregation | Daemon (`tools/finance.ts` + SQLCipher) | — | Queryable aggregates need SQLCipher in-daemon; the DB key lives in the Keychain (FIN-03/FIN-05). |
| 4-layer finance-leak prevention | Daemon + `kernel-memory/` git repo | — | gitignore + pre-push hook + at-rest encryption + startup `git ls-files` assertion all sit on the daemon/memory-repo boundary (FIN-04). |
| Spending / accounts / mail / email-preview widget render | Face (`Widgets/`) | — | Visual contract fixed in 03-UI-SPEC; Phase 4 renders against it via `widget.data` + Stage cues (CLOUD-04/06). |
| Claude Code first-person prompting + run | Daemon (`ClaudeCodeBrain`/`tools/claude-code.ts`) | — | The daemon authors the prompt as Pravin and spawns the CLI (CC-01). |
| Transparency transcript pill | Daemon streams (`transcript` arm) → Face renders | Face (`cornerPill` state) | The daemon parses the CLI's `stream-json` events and pushes `transcript` frames; the Face renders them in the shipped cornerPill (CC-02, CLOUD-05). |
| Project registry cold-resume | Daemon (`projects/registry.md`) | — | Markdown append in the memory repo (CC-04). |

## Standard Stack

> The stack is pinned by CLAUDE.md / STACK.md. Phase 4 adds exactly **one** runtime dependency family (`plaid`, `better-sqlite3-multiple-ciphers`); everything else is already installed or native.

### Core (already installed — verified in `daemon/package.json`)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `yaml` | 2.9.0 | Parse `routines/morning-brief.yaml` (presets, steps) | Pinned over `js-yaml` (better TS types, comment preservation for an owner-editable file). Already a dep. [VERIFIED: daemon/package.json] |
| `zod` | 4.4.3 | Validate parsed YAML, Plaid responses, tool args, IPC arms | Used throughout; validate the routine schema and Plaid payloads. [VERIFIED: daemon/package.json] |
| `@anthropic-ai/sdk` | 0.105.0 | High-stakes email rewrite via `ClaudeBrain` (`claude-opus-4-8`) | Default brain; reused for MAIL-03 cloud route. [VERIFIED: daemon/package.json] |
| `gray-matter` | 4.0.3 | Front-matter on voice-profile / few-shot / registry markdown | Already used by `retrieve.ts`. [VERIFIED: daemon/package.json] |
| `pino` | 10.3.1 | Structured logs for every routine step / send / finance sync | Already wired (`memory/log.ts`). [VERIFIED: daemon/package.json] |

### Supporting (NEW this phase)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `plaid` | 42.2.0 | Read-only finance aggregation (Sandbox → Trial) | Finance balances/transactions. Official Plaid Node SDK. [VERIFIED: npm registry — `npm view plaid version` = 42.2.0, modified 2026-04-27; slopcheck `[OK]`] [CITED: plaid.com/docs/sandbox] |
| `better-sqlite3-multiple-ciphers` | 12.11.1 | SQLCipher AES-256 encrypted finance store | `kernel-memory/finance/finance.db`; synchronous API ideal for the single-process daemon. [VERIFIED: npm registry = 12.11.1, created 2021-07-25, repo m4heshd/...; slopcheck `[OK]`] |

### Native / zero-dependency (preferred over libraries — matches the shipped "no new dep" discipline)
| Mechanism | Purpose | Why preferred |
|-----------|---------|---------------|
| `security` CLI (`/usr/bin/security`) | Store/read the SQLCipher DB key in the macOS Keychain | **Verified working live this session:** `add-generic-password` → `find-generic-password -w` → `delete-generic-password` round-tripped a test key cleanly. Spawn it zero-dep via `node:child_process` exactly like `ClaudeCodeBrain` spawns `claude` — avoids a native keychain addon + its legitimacy checkpoint. [VERIFIED: live `security` round-trip on this machine] |
| `claude -p --output-format stream-json --include-partial-messages` | Live transcript event stream for the transparency pill | **Verified live:** `claude --help` lists `stream-json` as a valid `--output-format` and `--include-partial-messages` for realtime chunks. The daemon parses the NDJSON event stream and pushes `transcript` frames. [VERIFIED: `claude -p --help` on claude v2.1.185] |
| `node:child_process` `spawn` (git, security, claude) | Pre-push hook install/test, Keychain, Claude Code | Already the shipped pattern (`ClaudeCodeBrain.realRunner`). No `execa` dep. [VERIFIED: daemon/src/brain/ClaudeCodeBrain.ts] |
| EventKit (Swift, Face side) | Calendar read + invitation reply | Calendar lives behind the Face's app TCC identity; the daemon never reads the calendar directly. [CITED: developer.apple.com/documentation/eventkit] |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `security` CLI for the Keychain | `@napi-rs/keyring@1.3.0` (slopcheck `[OK]`, actively maintained) | A maintained native addon if a pure-CLI approach proves brittle under launchd env. But it adds a dependency + a native build; the CLI is verified working and zero-dep. Prefer the CLI; `@napi-rs/keyring` is the documented fallback. **Do NOT use `keytar`** — it is `atom/node-keytar`, the Atom project is archived/unmaintained (confirmed `prebuild-install` deprecation warning). |
| Plaid Sandbox `/sandbox/public_token/create` (no Link UI) for tests | Plaid Link (real OAuth UI) | Sandbox public-token create bypasses Link entirely — ideal for automated/integration tests with `user_good`/`pass_good`. Real linking uses Link in the bank's own flow (owner-only, manual). Use both: sandbox-create for tests, Link for live. [CITED: plaid.com/docs/sandbox] |
| SQLCipher (encrypt the DB) | age/libsodium-encrypted JSON blob | A flat blob can't be queried for W/M/Y aggregates without full decrypt-in-memory. SQLCipher keeps the data queryable while encrypted. SQLCipher wins (STACK.md §8). |
| Peekaboo (Mail.app GUI) for send | Gmail API (HTTP) | Gmail API is more robust but needs OAuth scope + a Google project; Peekaboo Mail already shipped in Phase 2 and drives Mail.app GUI. Default Peekaboo Mail; Gmail API is a documented v2 option (see Open Questions). |

**Installation:**
```bash
cd daemon
npm install plaid@42.2.0 better-sqlite3-multiple-ciphers@12.11.1
# native build: better-sqlite3-multiple-ciphers fetches a prebuilt arm64/darwin binary via
# prebuild-install; falls back to node-gyp (Xcode CLT present on this machine → compiles clean).
# No keytar / keychain npm dep — use the verified `security` CLI via node:child_process.
```

**Version verification (run this session):**
- `npm view plaid version` → `42.2.0` (dist-tags.latest = 42.2.0; modified 2026-04-27). [VERIFIED]
- `npm view better-sqlite3-multiple-ciphers version` → `12.11.1`. [VERIFIED]
- `npm view @napi-rs/keyring version` → `1.3.0` (fallback only). [VERIFIED]
- `npm view keytar version` → `7.9.0` — **REJECTED** (archived `atom/node-keytar`). [VERIFIED]

## Package Legitimacy Audit

> slopcheck 0.6.1 was available and run this session (`slopcheck install plaid better-sqlite3-multiple-ciphers keytar @napi-rs/keyring --json`): all four scanned `[OK]`.

| Package | Registry | Age | Source Repo | slopcheck | postinstall | Disposition |
|---------|----------|-----|-------------|-----------|-------------|-------------|
| `plaid` | npm | created pre-2020, latest 42.2.0 (2026-04-27) | (official Plaid org) | `[OK]` | none | **Approved** — official Plaid Node SDK |
| `better-sqlite3-multiple-ciphers` | npm | created 2021-07-25 | github.com/m4heshd/better-sqlite3-multiple-ciphers | `[OK]` | `prebuild-install \|\| node-gyp rebuild` (native build — expected, local-only) | **Approved** — SQLCipher fork of better-sqlite3, widely used |
| `@napi-rs/keyring` | npm | created 2023-02-25 | github.com/Brooooooklyn/keyring-node | `[OK]` | none | **Approved as FALLBACK only** — primary path is the zero-dep `security` CLI |
| `keytar` | npm | 7.9.0 | github.com/atom/node-keytar (ARCHIVED) | `[OK]` | `prebuild-install \|\| npm run build` | **REMOVED** — Atom project archived/unmaintained; do not use |

**Packages removed due to slopcheck [SLOP] verdict:** none.
**Packages flagged as suspicious [SUS]:** none. (`keytar` is removed for maintenance reasons, not a slopcheck flag.)
**postinstall note:** `better-sqlite3-multiple-ciphers` runs a native build postinstall (`prebuild-install || node-gyp rebuild`) — this is the standard better-sqlite3 mechanism, fetches a prebuilt binary or compiles locally with the (present) Xcode CLT. It makes no external network call beyond the GitHub release download for the prebuilt binary. Acceptable; not a `[SUS]` signal.

## Architecture Patterns

### System Architecture Diagram

```
                         routines/morning-brief.yaml (presets: Workday/Weekend/Travel)
                                          │ parse + zod-validate
                                          ▼
   launchd StartCalendarInterval ─► enqueue({source:'schedule'}) ─► loop.drain() (serial, shipped)
                                          │
                                          ▼
                         routines/engine.ts  (run steps in `order`, `enabled` only)
                                          │  per step, by step.id:
            ┌──────────────┬──────────────┼───────────────┬──────────────┬───────────────┐
            ▼              ▼               ▼               ▼              ▼               ▼
        greeting       weather         calendar        mail_triage     email_reply     balances/spending
        (helper       (HTTP)        (Face EventKit    (helper.classify  (§MAIL flow)    (tools/finance.ts
         narrate)                    → daemon)         log/reply/open/                    SQLCipher query)
            │              │               │            archive)            │               │
            └──────────────┴───────────────┴──────────────┬─────────────────┴───────────────┘
                                                           ▼
                              assembleSpeak(id, narration, widgetPlan)  ← shipped cues.ts
                                                           │  ONE speak frame, char-offset cues, no timing
                                                           ▼  (+ widget.data frames carrying real data)
                              ipc/server.ts  ──NDJSON over UDS──►  Face KernelSocket
                                                           │
                                                           ▼
                              StageController (dual-paced, shipped)  fires cues on TTS boundary
                                                           ▼
                              CloudWindow.widgetView(named:)  blooms mail/accounts/spending/email-preview

   EMAIL REPLY (Yellow gate):  intent ─► inject voice-profile (knowledge/voice-profile.md, ~200 tok)
        + retrieveAndRerank(recipient) few-shot ─► stakes route (helper 7B | ClaudeBrain)
        ─► email-preview "Send it?" widget ─► Face ui.intent{intent:'send-email'} ─► dispatch
        ─► gate.authorize (Yellow=allow) ─► Peekaboo Mail send + mark-read + log
        (NEVER auto-send; external-sourced To address shown before send)

   FINANCE:  plaid client (Sandbox) ─► /sandbox/public_token/create (test) | Link (live)
        ─► /item/public_token/exchange ─► read-only access_token (Keychain or env)
        ─► /accounts/balance/get + /transactions/sync ─► SQLCipher store (key from `security` CLI)
        ─► local W/M/Y aggregation queries ─► widget.data{widget:'spending'|'accounts'}

   CLAUDE CODE:  author first-person prompt ─► spawn `claude -p --output-format stream-json
        --include-partial-messages` ─► parse NDJSON events ─► transcript frames (NEW additive arm)
        ─► Face cornerPill (shipped ui.state=cornerPill) renders the live scroll
        ─► append project to projects/registry.md  (Red action → deny pre-Phase-5; shim is Phase 5)

   4-LAYER FINANCE LEAK PREVENTION (gates Phase 5, all in kernel-memory/ — its OWN git repo):
        (a) gitignore finance/ + **/finance/** + *.db-wal/-shm/-journal  [PARTLY SEEDED]
        (b) .git/hooks/pre-push scans STAGED BYTES for finance paths/$ patterns → abort  [NEW]
        (c) SQLCipher at-rest AES-256, key in Keychain  [NEW]
        (d) startup `git ls-files | grep finance` assertion → fail loud  [PARTLY SEEDED in test]
```

### Recommended Project Structure (additive over shipped tree)
```
daemon/src/
├── routines/
│   ├── engine.ts            # NEW: load + zod-validate YAML, run steps in order, per-step → cues
│   ├── steps.ts             # NEW: one handler per step id (greeting/weather/.../spending)
│   └── presets.ts           # NEW: Workday/Weekend/Travel preset selection (or a field in the YAML)
├── routines/morning-brief.yaml   # NEW: owner-editable config (presets + steps)
├── mail/
│   ├── reply.ts             # NEW: intent → voice profile + few-shot → stakes route → preview
│   └── voice-profile.ts     # NEW: distill-once + inject helpers (reads knowledge/voice-profile.md)
├── tools/
│   ├── finance.ts           # NEW: Plaid client + SQLCipher store + W/M/Y aggregation; registered tool
│   ├── mail.ts              # NEW or extend peekaboo: send/mark-read ops as a registered tool
│   └── claude-code.ts       # NEW: first-person prompt + stream-json runner + transcript frames + registry
├── finance/
│   ├── store.ts             # NEW: SQLCipher open (key from keychain.ts), schema, upsert, aggregate
│   ├── keychain.ts          # NEW: `security` CLI wrapper (get/set the DB key), absent-tolerant
│   └── plaid-client.ts      # NEW: thin Plaid SDK wrapper, mockable test seam
├── safety/leakguard.ts      # NEW: startup `git ls-files | grep finance` assertion (layer d)
└── ipc/protocol.ts          # EXTEND: append `transcript` arm (additive only — never mutate)

kernel-memory/                # SEPARATE git repo (own remote later; finance/ gitignored)
├── .gitignore               # EXTEND: already pre-seeds finance/ + sidecars (layer a, partly done)
├── finance/finance.db        # NEW (gitignored, SQLCipher) — never committed
├── knowledge/voice-profile.md# NEW: the ~200-token distilled email voice (durable, injected)
├── projects/registry.md      # EXTEND: append a row per Claude Code project (CC-04)
└── .git/hooks/pre-push       # NEW: staged-byte finance scanner (layer b)

face/Kernel/
├── Widgets/MailWidget.swift        # NEW: per 03-UI-SPEC §2 (count + chips Reply/Open/Archive/Log)
├── Widgets/AccountsWidget.swift    # NEW: per §3 (balances, tabular, count-up, total)
├── Widgets/SpendingWidget.swift    # NEW: per §4 (W/M/Y switcher + chart)
├── Widgets/EmailPreviewWidget.swift# NEW: per §5 ("Send it?" card; Send→ui.intent)
├── ClaudeCode/TranscriptPill.swift # NEW: scrollable transcript in the cornerPill (CC-02)
├── IPC/Frames.swift                # EXTEND: mirror the new `transcript` arm
├── Calendar/EventKitBridge.swift   # NEW: read events + write invitation reply (ROUT-05)
└── CloudView/CloudWindow.swift     # EXTEND: widgetView(named:) cases for the 4 new widgets
```

### Pattern 1: Additive IPC arm for the transparency transcript (never mutate FrameSchema)
**What:** Append a new `transcript` arm to the frozen `FrameSchema` discriminated union and mirror it in `Frames.swift`. This is the exact discipline used for `settings`/`ui.state` in Phase 3 (verified in `protocol.ts` + `Frames.swift`).
**When to use:** Streaming Claude Code `stream-json` events to the cornerPill (CC-02).
**Example:**
```typescript
// Source: pattern mirrors daemon/src/ipc/protocol.ts SettingsSchema/UiStateSchema (additive arms)
export const TranscriptSchema = z.object({
  type: z.literal('transcript'),
  id: z.string(),                       // correlate to the Claude Code session
  role: z.enum(['kernel', 'claude']),   // who spoke this line
  text: z.string(),
  partial: z.boolean().optional(),      // a streaming chunk vs a complete line
});
// APPEND to the discriminatedUnion array — existing arms are NEVER touched.
```
The Swift mirror adds one `case transcript(...)` to the `Frame` enum + its decode/encode arms (FrameCodecTests already prove the round-trip pattern).

### Pattern 2: Routine step → cue producer (reuse `assembleSpeak`)
**What:** A routine step produces a narration string + a `WidgetPlanItem[]`; `assembleSpeak` turns it into one `speak` frame with char-offset cues. The Face's StageController fires them on TTS boundaries. The daemon never sends timing.
**When to use:** Every narrated step (ROUT-03 — one/two widgets at a time, never a static grid).
**Example:**
```typescript
// Source: daemon/src/ipc/cues.ts (shipped) — assembleSpeak(id, reply, widgetPlan)
const narration = `You've got ${n} events today, and your checking is at ${bal}.`;
const speak = assembleSpeak(intent.id!, narration, [
  { widget: 'events',   phrase: `${n} events`, data: eventsData },
  { widget: 'accounts', phrase: `checking is`, data: accountsData },
]);
// push `widget.data` frames first (fill the widget), then the `speak` frame.
```

### Pattern 3: Finance store with the Keychain key via the `security` CLI (zero-dep)
**What:** Open the SQLCipher DB with a key read from the macOS Keychain. The key is created on first run and never written to disk in plaintext. The CLI is spawned exactly like `ClaudeCodeBrain` spawns `claude`.
**When to use:** Every finance store open (FIN-03).
**Example:**
```typescript
// Source: pattern mirrors ClaudeCodeBrain.realRunner spawn; `security` verified live this session
import Database from 'better-sqlite3-multiple-ciphers';
const key = getOrCreateKeychainKey('com.kernel.finance', 'db-key'); // spawns `security` CLI
const db = new Database(financeDbPath);
db.pragma(`key = '${key}'`);            // SQLCipher: keys the DB at open (AES-256)
db.pragma('cipher_compatibility = 4');  // SQLCipher 4 page format
// queries now operate on the encrypted DB transparently.
```
`security add-generic-password -a db-key -s com.kernel.finance -w <key> -U` / `find-generic-password -a db-key -s com.kernel.finance -w` — both verified working live.

### Pattern 4: The Yellow-tier email send gate (the preview + explicit Send IS the gate)
**What:** The email-preview widget renders To/Subject/body/signature read-only. Nothing sends until the Face emits `ui.intent{intent:'send-email', payload:{...}}` (the user tapped Send). That intent dispatches a `mail`/`peekaboo` send tool call which classifies Yellow and proceeds. There is no auto-send path.
**When to use:** MAIL-04/MAIL-05.
**Anti-bypass:** the send op must reach `registry.dispatch` (so `gate.authorize` runs). External-sourced recipient addresses (provenance `external`) must be surfaced in the preview before Send — render the To field prominently (03-UI-SPEC §5 already mandates this).

### Anti-Patterns to Avoid
- **Mutating an existing FrameSchema arm.** Always append. The Swift mirror is byte-exact; a mutated arm silently breaks the Face decode (T-03-13 pattern).
- **Daemon-sent timing messages for choreography.** The daemon sends char-offset cues once; the Face owns the clock (ARCHITECTURE Anti-Pattern 1 — locked).
- **A tool calling its own `execute` or self-classifying its tier.** Every finance/mail/claude-code action goes through `registry.dispatch → gate.authorize`. Finance reads are Green; sends/invitation-replies are Yellow; anything Red is `deny` until Phase 5.
- **Writing the SQLCipher DB key to a file / the memory repo.** Keychain only (it would otherwise leak via the future GitHub backup).
- **`git add -A`/`-f` anywhere near finance.** The backup job is Phase 5, but any Phase 4 commit helper in `kernel-memory/` must use explicit paths and never touch `finance/`.
- **Auto-promoting a Plaid response / email body into `knowledge/` or `IDENTITY.md`.** External/finance data is data, never instruction (memory-poisoning surface, PITFALLS 1+2).
- **Typing bank credentials anywhere.** Finance is read-only OAuth; the credential fence (shipped `detectCredentialField`) already refuses, but no finance flow should ever attempt a credential field.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| YAML parsing for the routine config | A custom parser/regex | `yaml@2.9.0` (installed) | Comment preservation + TS types for an owner-editable file; already pinned. |
| Encrypted queryable finance store | A hand-rolled AES wrapper over JSON | `better-sqlite3-multiple-ciphers` (SQLCipher) | W/M/Y aggregates need SQL; rolling your own crypto is a footgun. |
| Plaid OAuth + transactions sync | Hand-built HTTP calls to Plaid | `plaid@42.2.0` SDK | Official typed client; handles the `/transactions/sync` cursor pagination correctly. |
| macOS Keychain access | Reading/parsing the keychain DB directly | `security` CLI (verified) or `@napi-rs/keyring` | The `security` CLI is the supported, verified interface. |
| Live Claude Code transcript stream | Polling output files or parsing pretty-printed text | `claude -p --output-format stream-json --include-partial-messages` | First-class realtime NDJSON event stream (verified on v2.1.185). |
| Few-shot email retrieval | A new similarity engine | `memory/retrieve.ts` `retrieveAndRerank` (shipped) | Keyword + authority×recency rerank already exists; reuse it for "most similar to recipient" (MAIL-02). |
| Cue/choreography timing | `setTimeout`-driven widget show/hide | `assembleSpeak` + the Face `StageController` (shipped) | The TTS boundary clock is the only accurate metronome (locked contract). |
| Tier classification of any action | A per-feature tier check | `safety/gate.authorize` + `tiers.classifyTier` (shipped) | One chokepoint; finance/mail/CC all route through it. |
| Git ignore-cleanliness check | A bespoke file walker | `git ls-files \| grep finance` (already in `finance-ignore.test.ts`) | Git already knows what's tracked; trust it (layer d). |

**Key insight:** Phase 4's value is composition over the frozen seams. Nearly every "hard" sub-problem (choreography timing, retrieval, tier gating, brain selection, the cornerPill state, the bloom/dissolve widget pattern) was already solved and shipped in Phases 1–3 and verified in source. The only true new engineering is the routine engine, the Plaid+SQLCipher finance store, the Keychain wiring, and the 4-layer leak proof.

## Common Pitfalls

### Pitfall 1: Finance leaking via git despite the gitignore (the existential one — gates Phase 5)
**What goes wrong:** `finance/` ends up in `kernel-memory/` git history (a sidecar `.db-wal`/`.db-shm` missed by the ignore, a file tracked before the rule, a `git add -f`, or a refactor moving the dir). Once in history it's permanent.
**Why it happens:** gitignore only ignores *untracked* files; SQLCipher writes WAL/SHM/journal sidecars; backups are "set and forget."
**How to avoid:** all four layers, verified before any backup job. (a) The `kernel-memory/.gitignore` already pre-ignores `finance/`, `**/finance/**`, `*.db-wal`, `*.db-shm`, `*.db-journal`, `finance/*.db` — confirm it still does and that the actual DB filename matches. (b) Add a `.git/hooks/pre-push` in the `kernel-memory/` repo that scans **staged bytes** for finance paths and dollar/account patterns and exits non-zero. (c) SQLCipher at-rest so a leak yields ciphertext. (d) A startup assertion `git -C kernel-memory ls-files | grep -i finance` must be empty or the daemon refuses to start.
**Warning signs:** `git -C kernel-memory ls-files` lists anything finance-pathed; the DB's sidecar files appear in `git status`; `--no-verify` anywhere.
**Verify each (the deliberate test):** stage a fake `kernel-memory/finance/leak-test.txt` with a fake `$1,234.56` and an account-number-shaped string, attempt `git push` (or run the hook directly), confirm it **aborts**; confirm `git ls-files` is empty; round-trip the SQLCipher DB (write→close→reopen with the wrong key fails, right key succeeds); boot the daemon with a planted tracked finance file and confirm it fails loud.

### Pitfall 2: `kernel-memory/` is a separate repo — the hook and assertion target the WRONG repo
**What goes wrong:** The pre-push hook gets installed in the project-root `.git/hooks/` (where finance never lives) instead of `kernel-memory/.git/hooks/`, so it never fires on the repo that actually holds finance data.
**Why it happens:** `kernel-memory/` is its own git repo (`git -C kernel-memory rev-parse --show-toplevel` = the memory dir; **no remote, no active hooks today** — verified this session).
**How to avoid:** install the hook in `kernel-memory/.git/hooks/pre-push` and target `git -C <memoryDir>` in the assertion. The existing `daemon/test/finance-ignore.test.ts` already correctly uses `config.memoryDir` — follow that.
**Warning signs:** the hook test passes against the root repo but a finance file in `kernel-memory/` still pushes.

### Pitfall 3: Calendar lives in the Face (EventKit), not the daemon
**What goes wrong:** Planning a daemon-side calendar read; the daemon has no Calendar TCC and no EventKit.
**Why it happens:** EventKit + Calendar permission are bound to the Face app's signed identity (like the mic in Phase 3).
**How to avoid:** Face reads events via EventKit and pushes them to the daemon (e.g. as a `ui.intent` or a dedicated additive frame), or the daemon requests them and the Face answers. The invitation *reply* (accept/propose) is a Yellow write — route it back through the daemon gate (ROUT-05). Treat live calendar as a manual owner check (TCC + a real calendar).

### Pitfall 4: Voice profile / few-shot emails are external content — taint discipline
**What goes wrong:** The voice profile distilled "once from real sent mail" or the few-shot examples carry attacker-controllable text into the rewrite prompt; or a reply intent sourced from a poisoned thread drives an action.
**Why it happens:** Email bodies are `source:external` (PITFALLS 1).
**How to avoid:** the voice profile is a *style descriptor* (greeting, sign-off, sentence length, formality, emoji y/n — ~200 tokens), distilled once and stored as durable `knowledge/voice-profile.md` (treat its creation as a human-reviewed promotion, not an auto-write). Few-shot examples are injected as *data/examples*, never as instructions. The reply To address, if `external`-sourced, must be shown before Send (MAIL-05). No email content auto-promotes to `knowledge/`/`IDENTITY.md`.

### Pitfall 5: Plaid Sandbox vs live confusion in tests
**What goes wrong:** Tests hit live Plaid or require real bank creds.
**Why it happens:** Plaid Link needs a real OAuth flow; sandbox needs a different entry point.
**How to avoid:** Unit tests mock the Plaid client entirely (inject a fake via a `__setPlaidClientForTest` seam mirroring `__setClientForTest`). Integration tests (optional, owner) use Sandbox: `/sandbox/public_token/create` (no Link UI) with `user_good`/`pass_good`, then `/item/public_token/exchange`, then `/accounts/balance/get` + `/transactions/sync`. Live linking (Plaid Link in the bank flow) is a manual owner check. [CITED: plaid.com/docs/sandbox]

### Pitfall 6: Claude Code Red-tier — deferred, not absent
**What goes wrong:** Wiring the Red re-submission shim now (it's Phase 5) or letting Claude Code run with ambient money/irreversible rights.
**Why it happens:** CC-03 says Red routes through the breaker — but the breaker is Phase 5.
**How to avoid:** Phase 4 keeps `ClaudeCodeBrain`/the bridge **Green/Yellow-only** (the shipped `--permission-mode dontAsk --allowedTools Read` fence). Any Red action a CC session proposes hits `gate.authorize` and is **denied** (the shipped Phase-2 Red=deny behavior). The transparency pill + registry ship now; the re-submission shim is Phase 5 (CC-03 deferred, per 03-01-SUMMARY key-decisions).

### Pitfall 7: 16GB RAM contention during a full brief
**What goes wrong:** A morning brief runs the 7B (triage/narration) + ClaudeBrain (high-stakes email) + Peekaboo (Mail) + the Metal cloud + maybe a browser all at once → memory pressure, choreography jank.
**How to avoid:** serialize heavy tools (the loop is already serial); lean on the 7B for triage/narration (cheap) and reserve ClaudeBrain for high-stakes email only; rely on Ollama idle-unload between bursts; the spending/finance queries are local SQLite (cheap). (PITFALLS 8.)

## Runtime State Inventory

> Phase 4 is greenfield feature work, not a rename/refactor. This section is **N/A** — no existing runtime state is being renamed or migrated. The one stateful concern (finance data) is *created* this phase, not migrated, and is covered under the finance-leak section.

## Code Examples

### Routine YAML schema + load (the §11 shape, zod-validated)
```typescript
// Source: spec §11 morning-brief.yaml shape + yaml@2.9.0 (installed) + zod@4.4.3 (installed)
import { parse } from 'yaml';
import { z } from 'zod';

const StepSchema = z.object({
  id: z.enum(['greeting','weather','calendar','invitations','mail_triage',
              'unread_announce','email_reply','balances','spending']),
  order: z.number().int().positive(),
  enabled: z.boolean(),
  tier: z.enum(['green','yellow','red']),
  params: z.record(z.string(), z.unknown()).optional(),
});
const RoutineSchema = z.object({
  preset: z.enum(['Workday','Weekend','Travel']),
  steps: z.array(StepSchema),
});
// engine: load, validate, filter enabled, sort by order, run serially → assembleSpeak per step.
```

### Mail triage via the always-on 7B helper (absent-tolerant, ROUT-04)
```typescript
// Source: daemon/src/brain/helper.ts (shipped) — classify(text, labels)
import { classify } from '../brain/helper.js';
const tag = await classify(messageSubjectAndSnippet, ['log','reply','open','archive']);
// Ollama absent → neutral default = first label ('log'); never throws, never blocks the loop.
```

### W/M/Y spending aggregation (local SQL over the encrypted store, FIN-05)
```typescript
// Source: SQLCipher store; standard SQLite date bucketing
const since = { W: "-7 days", M: "-1 month", Y: "-1 year" }[timeframe];
const rows = db.prepare(
  `SELECT date(posted) AS day, SUM(amount) AS spent
     FROM transactions WHERE posted >= date('now', ?) AND amount < 0
   GROUP BY day ORDER BY day`).all(since);
// → widget.data { widget:'spending', data:{ timeframe, total, series: rows } }
```

### First-person Claude Code prompt + transcript stream (CC-01/CC-02)
```typescript
// Source: claude v2.1.185 — `claude -p --output-format stream-json --include-partial-messages` (verified live)
const argv = ['-p', firstPersonPrompt, '--output-format','stream-json',
              '--include-partial-messages','--bare','--permission-mode','dontAsk','--allowedTools','Read'];
// spawn (node:child_process), read stdout line-by-line (NDJSON), per event:
//   push a TranscriptSchema frame { role:'claude', text, partial } over IPC → cornerPill.
// firstPersonPrompt is authored AS Pravin: "I need you to refactor the auth module so that…"
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `keytar` for macOS Keychain | `security` CLI (zero-dep) or `@napi-rs/keyring` | keytar's `atom/node-keytar` archived | Don't add keytar; use the verified CLI. |
| Claude Code parse pretty text | `--output-format stream-json --include-partial-messages` | claude CLI 2.x | First-class realtime event stream for the transcript pill. |
| Plaid Link required for every test | `/sandbox/public_token/create` bypasses Link in Sandbox | current Plaid API | Automated finance tests need no UI. |
| `/transactions/get` (paginated) | `/transactions/sync` (cursor) | current Plaid API | Use the sync cursor for incremental transaction pulls. [CITED: plaid.com/docs] |

**Deprecated/outdated:**
- `keytar` (archived). `js-yaml` (use `yaml`). `claude-*-latest` aliases (use `claude-opus-4-8`). Plaid `/transactions/get` for ongoing sync (prefer `/transactions/sync`).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Plaid `/item/public_token/exchange` is the token-exchange endpoint (WebFetch couldn't surface the exact name; well-established API name) | Stack / Code | LOW — endpoint name is standard; confirm against the Plaid Node SDK method `itemPublicTokenExchange` when wiring. |
| A2 | The owner uses Mail.app (Peekaboo Mail send) rather than Gmail-API; spec says "Mail/Gmail" | MAIL | MEDIUM — if Gmail-only, the send path needs the Gmail API (OAuth scope). Surface as a discuss question. |
| A3 | The voice profile is stored as `kernel-memory/knowledge/voice-profile.md` and injected into the rewrite prompt | MAIL | LOW — location is a design choice consistent with the memory layout; alternative is `working-memory/`. |
| A4 | The transparency transcript streams over a NEW additive `transcript` IPC arm (not reusing `reply`/`widget.data`) | CC | LOW — additive arm is the established Phase-3 pattern; the exact field shape is a design call. |
| A5 | The DB key lives in the macOS Keychain via the `security` CLI (verified working), not `@napi-rs/keyring` | FIN | LOW — CLI verified live; fallback documented. |
| A6 | Pre-push (not pre-commit) is the hook layer, in the `kernel-memory/` repo | FIN | LOW — ROADMAP says "pre-commit/pre-push"; pre-push scans exactly the bytes about to leave the machine (PITFALLS 3 rationale). A pre-commit could be added as defense-in-depth. |
| A7 | Calendar invitation reply is a Yellow-tier write routed back through the daemon gate; EventKit read is Face-side | ROUT | LOW — consistent with the tier matrix + Face TCC identity. |
| A8 | Plaid Sandbox (free) covers all Phase-4 testing; live Production/Trial linking is an owner manual step | FIN | LOW — STACK.md confirms Sandbox is free/unlimited. |

## Open Questions

1. **Plaid client lib + sandbox flow** — RESOLVED. Use `plaid@42.2.0` (verified, slopcheck OK). Tests mock the client (`__setPlaidClientForTest`). Sandbox integration: `/sandbox/public_token/create` (no Link, `user_good`/`pass_good`) → `/item/public_token/exchange` → `/accounts/balance/get` + `/transactions/sync`. Live: Plaid Link in the bank's flow (owner manual). Read-only products: Balance + Transactions. [CITED: plaid.com/docs/sandbox]
2. **Mail send via Peekaboo vs Gmail API** — Recommendation: default to **Peekaboo Mail** (shipped Phase 2, drives Mail.app GUI; send is a Yellow tool call). Gmail API is a cleaner-but-heavier alternative needing a Google OAuth project + scope. **Needs owner confirmation** (A2) — does the owner live in Mail.app or Gmail web? If Gmail web, Peekaboo can still drive it via the browser tool, or use the Gmail API.
3. **Where the voice profile is stored** — Recommendation: `kernel-memory/knowledge/voice-profile.md` (durable, always-injected, ~200 tokens). Created via a human-reviewed promotion (not an auto-write from email). (A3.)
4. **Pre-push vs pre-commit hook** — Recommendation: **pre-push** in `kernel-memory/.git/hooks/` (scans staged bytes about to leave the machine; matches ROADMAP layer b). Optionally add a pre-commit as cheap defense-in-depth. The deliberate-abort test must target the correct repo (A6, Pitfall 2).
5. **How the transcript streams over IPC** — RESOLVED. A NEW additive `transcript` arm on `FrameSchema` (mirrors the Phase-3 `settings`/`ui.state` additive pattern), fed by the `claude --output-format stream-json --include-partial-messages` NDJSON events, rendered in the shipped `cornerPill` cloud state (A4).
6. **Keychain access method** — RESOLVED. The `security` CLI via `node:child_process` spawn (verified working live, zero-dep, matches the `ClaudeCodeBrain` pattern). `@napi-rs/keyring@1.3.0` is the documented fallback if the CLI proves brittle under launchd's minimal env (A5).
7. **EventKit calendar ownership** — RESOLVED. Face-side EventKit read (app TCC identity); invitation reply is a Yellow daemon-gated write (A7, Pitfall 3).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node | daemon runtime | ✓ | 24.16.0 | — |
| `claude` CLI | Claude Code bridge (CC) | ✓ | 2.1.185 (supports `stream-json` + `--include-partial-messages`) | — |
| `sqlite3` CLI | (reference only — NOT used; system sqlite is not SQLCipher) | ✓ | 3.51.0 | the SQLCipher store is opened ONLY by the native module in-daemon |
| `security` (Keychain CLI) | finance DB key (FIN-03) | ✓ | /usr/bin/security (round-trip verified live) | `@napi-rs/keyring@1.3.0` |
| `peekaboo` | Mail send + GUI (MAIL) | ✓ | 3.5.2 | browser tool / Gmail API |
| `git` | finance-leak layers b+d | ✓ | 2.50.1 | — |
| Xcode CLT | `better-sqlite3-multiple-ciphers` native build | ✓ (xcodebuild present) | — | prebuilt arm64 binary via prebuild-install |
| Plaid API keys | live finance link | ✗ (owner installs) | — | Sandbox (free) + mocked client for all automated tests |
| Ollama | 7B helper triage/narration | ✗ (owner installs) | — | helper.ts returns neutral defaults; the brief degrades gracefully |
| whisper.cpp | live STT | ✗ (owner provides) | — | typed-utterance dev path; STT is a manual owner check |

**Missing dependencies with no fallback:** none block automated Phase-4 verification — every external service (Plaid, Ollama, whisper, live Mail/Calendar/Claude-Code session) is mocked/absent-tolerant in the test lane and carried as a documented owner manual check.
**Missing dependencies with fallback:** Plaid keys → Sandbox + mock; Ollama → neutral helper defaults; whisper → typed utterances.

## Validation Architecture

> `workflow.nyquist_validation` is `true` — section included.

### Test Framework
| Property | Value |
|----------|-------|
| Framework (daemon) | Node built-in `node:test` run via `tsx --test` (no Jest/Vitest) |
| Config file (daemon) | none — `package.json` script: `"test": "tsx --test \"src/**/*.test.ts\" \"test/**/*.test.ts\""` |
| Framework (Face) | XCTest (`xcodebuild test -scheme Kernel`) |
| Quick run command | `cd daemon && npx tsx --test src/routines/engine.test.ts` (single file) |
| Full suite command | `cd daemon && npm test` (108 tests green at Phase 3 baseline) and `cd face && xcodebuild -scheme Kernel test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| ROUT-01 | YAML parses; each step has enabled/order/params/tier | unit | `npx tsx --test src/routines/engine.test.ts` | ❌ Wave 0 |
| ROUT-02 | Workday/Weekend/Travel presets switch the step set | unit | same | ❌ Wave 0 |
| ROUT-03 | Steps run in `order`, only `enabled`, produce ≤2-widget cues via assembleSpeak | unit | same | ❌ Wave 0 |
| ROUT-04 | mail_triage tags log/reply/open/archive via helper.classify (mocked Ollama) | unit | `npx tsx --test src/routines/steps.test.ts` | ❌ Wave 0 |
| ROUT-05 | Invitation reply classifies Yellow; EventKit read | unit (tier) + manual (live cal) | `npx tsx --test src/safety/...` / owner | ❌ Wave 0 |
| MAIL-01 | Voice profile (~200 tok) always injected into the rewrite prompt | unit | `npx tsx --test src/mail/voice-profile.test.ts` | ❌ Wave 0 |
| MAIL-02 | Few-shot selects 2–3 most-similar past emails (retrieveAndRerank) | unit | `npx tsx --test src/mail/reply.test.ts` | ❌ Wave 0 |
| MAIL-03 | Stakes route: casual→helper, high-stakes→ClaudeBrain | unit | same | ❌ Wave 0 |
| MAIL-04 | Preview card; no send without explicit Send ui.intent | unit + XCTest | reply.test.ts + `EmailPreviewWidget` XCTest | ❌ Wave 0 |
| MAIL-05 | Never auto-send; external-sourced To shown before send; send→mark-read→log | unit | `npx tsx --test src/mail/reply.test.ts` | ❌ Wave 0 |
| FIN-01/02 | Read-only token path; no credential-field type ever attempted | unit | `npx tsx --test src/tools/finance.test.ts` (mock Plaid) | ❌ Wave 0 |
| FIN-03 | SQLCipher round-trip: write→close→reopen wrong-key fails, right-key OK; key from Keychain (or mock) | integration | `npx tsx --test src/finance/store.test.ts` | ❌ Wave 0 |
| **FIN-04 (a)** | gitignore ignores finance/ + sidecars | unit | `npx tsx --test test/finance-ignore.test.ts` (EXISTS — extend for sidecars) | ✅ partial |
| **FIN-04 (b)** | pre-push hook aborts on a staged fake finance file (deliberate test) | integration | `npx tsx --test test/finance-leakguard.test.ts` | ❌ Wave 0 |
| **FIN-04 (c)** | at-rest AES-256 (SQLCipher) — ciphertext on disk, decrypt needs key | integration | `npx tsx --test src/finance/store.test.ts` | ❌ Wave 0 |
| **FIN-04 (d)** | startup `git ls-files \| grep finance` empty / fails loud if not | unit | `npx tsx --test test/finance-ignore.test.ts` (EXISTS) + `src/safety/leakguard.test.ts` | ✅ partial / ❌ Wave 0 |
| FIN-05 | W/M/Y aggregation correct over seeded transactions | unit | `npx tsx --test src/finance/store.test.ts` | ❌ Wave 0 |
| CC-01 | Prompt authored first-person as Pravin | unit | `npx tsx --test src/tools/claude-code.test.ts` (mock runner) | ❌ Wave 0 |
| CC-02 | stream-json events → transcript frames over IPC (additive arm) | unit + XCTest | claude-code.test.ts + FrameCodec round-trip | ❌ Wave 0 |
| CC-03 | Red action from CC → gate denies (no auto-run; shim deferred) | unit | `npx tsx --test src/safety/gate.test.ts` (extend) | ✅ partial |
| CC-04 | Every project appended to projects/registry.md (cold resume) | unit | `npx tsx --test src/tools/claude-code.test.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** the single touched test file (`npx tsx --test <file>`).
- **Per wave merge:** `cd daemon && npm test` (full daemon suite, must stay ≥108 green) + `cd face && xcodebuild -scheme Kernel test`.
- **Phase gate:** full daemon + Face suites green AND the 4-layer finance-leak verification (all four below proven) before `/gsd-verify-work` and before ANY Phase-5 backup work.

### The 4 Finance-Leak Layers — all in the TESTABLE column (ROADMAP criterion 4)
- **(a) gitignore** — `test/finance-ignore.test.ts` (`git check-ignore`) — EXISTS; extend to assert `*.db-wal`/`*.db-shm`/`*.db-journal` and the real DB filename are ignored.
- **(b) pre-push hook** — NEW `test/finance-leakguard.test.ts`: in a temp clone (or the `kernel-memory/` repo), stage a fake `finance/leak.txt` containing `$1,234.56` + an account-number-shaped string, run the hook (or `git push --dry-run` to a temp remote), assert non-zero exit + abort message.
- **(c) at-rest encryption** — NEW `src/finance/store.test.ts`: open with key, write a row, close; reopen with the WRONG key → throws/fails; reopen with the RIGHT key → row present; assert the raw file bytes are not plaintext-readable.
- **(d) startup assertion** — `test/finance-ignore.test.ts` (`git ls-files`) EXISTS + NEW `src/safety/leakguard.test.ts`: with a planted tracked finance path, the startup assertion throws/refuses-to-start (fail loud).

### Wave 0 Gaps
- [ ] `src/routines/engine.test.ts` + `src/routines/steps.test.ts` — ROUT-01..04
- [ ] `src/mail/reply.test.ts` + `src/mail/voice-profile.test.ts` — MAIL-01..05
- [ ] `src/tools/finance.test.ts` (mock Plaid via a `__setPlaidClientForTest` seam) — FIN-01/02/05
- [ ] `src/finance/store.test.ts` (SQLCipher round-trip + wrong-key + plaintext-scan; mock or real Keychain) — FIN-03, FIN-04(c)
- [ ] `src/finance/keychain.test.ts` (mock the `security` spawn) — FIN-03
- [ ] `test/finance-leakguard.test.ts` (deliberate pre-push abort) — FIN-04(b)
- [ ] `src/safety/leakguard.test.ts` (startup `git ls-files` assertion fails loud) — FIN-04(d)
- [ ] `src/tools/claude-code.test.ts` (mock stream-json runner; first-person prompt; registry append) — CC-01/02/04
- [ ] extend `src/ipc/protocol.test.ts` for the additive `transcript` arm — CC-02
- [ ] extend `src/safety/gate.test.ts` — CC-03 Red-from-CC denial
- [ ] Face XCTest: `MailWidgetTests`, `AccountsWidgetTests`, `SpendingWidgetTests`, `EmailPreviewWidgetTests`, `TranscriptPillTests`, `FrameCodec` extended for `transcript` — MAIL-04, FIN-05, CC-02
- [ ] Framework install: none — `tsx --test` + XCTest already in place; add `plaid` + `better-sqlite3-multiple-ciphers`.

### Documented MANUAL owner checks (NOT automatable on this machine)
- Live Plaid Link in the bank's own flow (real account) → balances/transactions appear.
- Live Mail/Gmail send of a previewed reply; source marked read.
- Live calendar read + an invitation accept/propose (EventKit + Calendar TCC).
- A live Claude Code session: transcript streams to the cornerPill, scroll/interject/pause, project lands in registry.md.
- Visual/choreography fidelity of the 4 new widgets (03-UI-SPEC §6 — owner runs and watches; nothing snaps).

## Security Domain

> `security_enforcement: true`, `security_asvs_level: 1` — section included.

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Plaid OAuth read-only tokens (the bank authenticates; KERNEL never types creds — FIN-02). Anthropic/Plaid API keys from env, never logged/committed. |
| V3 Session Management | partial | Plaid `access_token` is long-lived read-only; store it in the Keychain or env, never in the memory repo. |
| V4 Access Control | yes | Every action routes through `gate.authorize` (tier). Finance is read-only; sends/invitation-replies are Yellow; Red = deny pre-Phase-5. |
| V5 Input Validation | yes | `zod` validates routine YAML, Plaid responses, tool args, the new `transcript`/email-preview IPC arms (ASVS V5 — never trust the brain's or Plaid's shape). |
| V6 Cryptography | yes | SQLCipher AES-256 at rest (never hand-rolled); DB key in macOS Keychain (`security` CLI), never on disk. |
| V7 Errors & Logging | yes | `pino` structured logs per step/send/sync; NEVER log finance values, the DB key, the access_token, or credential content. |
| V8 Data Protection | yes (CRITICAL) | The 4-layer finance-leak stack (gitignore + pre-push byte scan + at-rest encryption + `git ls-files` assertion) — gates Phase 5. |
| V12 Files & Resources | yes | finance store path is gitignored + excluded from backup; CC `--allowedTools Read` fence; no remote-resource auto-load in widgets (T-03-12). |

### Known Threat Patterns for this stack
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Finance data committed to git history | Information Disclosure | 4-layer stack; pre-push byte scan; `git ls-files` assertion; encrypt at rest (PITFALLS 3) |
| Indirect prompt injection via email body / Plaid memo into a tool call | Tampering / EoP | Treat email + finance content as `external` data, not instruction; reply To shown before send; no auto-promote to knowledge (PITFALLS 1) |
| Memory poisoning via auto-promoted email "fact" / voice profile | EoP | Voice profile is human-reviewed durable knowledge; few-shot is examples only; IDENTITY.md never auto-edited (PITFALLS 2) |
| Credential entry into a bank form | Spoofing / Info Disclosure | Shipped `detectCredentialField` fence (read-only OAuth means no legitimate credential flow exists) |
| Data exfil via a widget rendering a remote URL/image | Info Disclosure | Widgets render ONLY typed structured fields; no `AsyncImage`/`URLRequest`/`WKWebView` (T-03-12, verified shipped) |
| Claude Code ambient money/irreversible action mid-session | EoP | Green/Yellow-only fence (`--permission-mode dontAsk --allowedTools Read`); Red → gate deny; Phase-5 shim deferred (CC-03) |
| DB key leakage via the GitHub backup | Info Disclosure | Key in Keychain only; finance/ gitignored; env keys never committed |
| Auto-send / send-to-external-address email abuse | Tampering | Explicit "Send it?" Yellow gate; never auto-send; show external-sourced To (MAIL-04/05) |

## Sources

### Primary (HIGH confidence)
- Shipped KERNEL source (read directly this session): `daemon/src/ipc/protocol.ts`, `ipc/cues.ts`, `loop.ts`, `safety/gate.ts`, `safety/tiers.ts`, `tools/registry.ts`, `tools/Tool.ts`, `brain/BrainProvider.ts`, `brain/helper.ts`, `brain/ClaudeBrain.ts`, `brain/ClaudeCodeBrain.ts`, `settings.ts`, `config.ts`, `memory/retrieve.ts`, `test/finance-ignore.test.ts`; Face: `IPC/Frames.swift`, `AppCoordinator.swift`, `CloudView/CloudWindow.swift`.
- KERNEL planning docs: ROADMAP.md (Phase 4 goal + 5 criteria), REQUIREMENTS.md (ROUT/MAIL/FIN/CC), STACK.md, PITFALLS.md, ARCHITECTURE.md, 03-UI-SPEC.md, 03-01/03-04/02-02-SUMMARY.md, KERNEL_MASTER_BUILD_PROMPT.md §11–§14/§16, CLAUDE.md.
- Live machine probes this session: `node --version` (24.16.0), `claude --version` (2.1.185) + `claude -p --help` (confirmed `--output-format stream-json` + `--include-partial-messages`), `sqlite3 --version` (3.51.0), `peekaboo --version` (3.5.2), `git --version` (2.50.1), `security` Keychain CLI add/find/delete round-trip (verified working), `kernel-memory/` is a separate git repo with no remote + no active hooks.
- npm registry: `npm view` for `plaid@42.2.0`, `better-sqlite3-multiple-ciphers@12.11.1`, `@napi-rs/keyring@1.3.0`, `keytar@7.9.0` (versions + repos + postinstall).
- slopcheck 0.6.1: `slopcheck install plaid better-sqlite3-multiple-ciphers keytar @napi-rs/keyring` → all `[OK]`.

### Secondary (MEDIUM confidence)
- Plaid docs (`plaid.com/docs/sandbox`) via WebFetch — `/sandbox/public_token/create`, `user_good`/`pass_good`, products list. Token-exchange endpoint name (`/item/public_token/exchange`) is the established API name (A1).
- Apple EventKit docs (calendar read + invitation reply, Face-side TCC) — [CITED, not re-fetched this session].

### Tertiary (LOW confidence)
- None relied upon. All recommendations trace to shipped source, live probes, the pinned stack docs, or verified registry/slopcheck results.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — pinned in CLAUDE.md/STACK.md; the two new packages verified on npm + slopcheck `[OK]`; Keychain CLI + claude stream-json verified live.
- Architecture / composition seams: HIGH — every reused contract (FrameSchema, cues, loop, gate, helper, retrieve, StageController, CloudWindow) read directly from shipped source.
- Finance-leak layers: HIGH — gitignore + ls-files test already exist; the separate-repo gotcha + the deliberate-abort test approach are concrete and verifiable.
- Pitfalls / security: HIGH — grounded in the shipped PITFALLS.md threat model + the actual repo layout.
- Plaid sandbox flow detail: MEDIUM — exact exchange endpoint name assumed (A1), to confirm against the SDK method when wiring.

**Research date:** 2026-06-22
**Valid until:** ~2026-07-22 (stable — pinned stack; re-verify `plaid`/`better-sqlite3-multiple-ciphers` versions and `claude` CLI flags if more than a month elapses).
