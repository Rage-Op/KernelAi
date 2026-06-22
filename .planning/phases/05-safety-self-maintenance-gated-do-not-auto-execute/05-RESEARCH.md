# Phase 5: Safety + Self-Maintenance (GATED) - Research

**Researched:** 2026-06-22
**Domain:** Tiered-autonomy safety gate + circuit breaker + obstacle planner + nightly self-maintenance jobs, on a shipped persistent TypeScript daemon (macOS, launchd)
**Confidence:** HIGH — this is almost entirely an upgrade of code that already exists in the repo (read directly this session). The one genuine external unknown (how to gate Claude Code's mid-session tool use) was verified against official Anthropic agent-SDK permission docs. No new third-party packages are required.

## Summary

Phase 5 is the LAST phase and the most safety-critical. It does **not** introduce new architecture — it *activates* a chokepoint that Phases 2–4 deliberately built and left dormant. The decisive structural fact: `safety/gate.ts` already returns a discriminated-union `Verdict` with a reserved `{ kind: 'gated'; tier: 'red' }` arm, and `tools/registry.ts` already has a `verdict.kind === 'gated' → await breaker.run(...)` branch path designed in (the dispatch comment says "the `gated` branch is kept so Phase 5 enables the breaker INSIDE `gate.authorize` without touching this file, the tools, or the loop"). So the breaker is added by (a) writing `safety/breaker.ts`, (b) flipping the Red branch in `gate.ts` from `deny` to `gated` (under an active-`/override`-and-breaker feature flag), and (c) wiring the `gated` arm in `registry.dispatch` to run the breaker. The router, the tools, the loop, and the IPC server stay structurally intact — new IPC frames are *additive* to the frozen `FrameSchema` union, exactly as P3/P4 added theirs.

Three things are genuinely greenfield: the **circuit breaker** (`safety/breaker.ts` — dry-run preview → 10s cancel → atomic spend-ceiling → audit log), the **obstacle planner ladder** (`planner/ladder.ts` — does not exist yet; the loop currently escalates inline), and the **self-maintenance jobs** (`memory/consolidate.ts`, `memory/prune.ts`, `memory/backup.ts` + three launchd plists + `self/changelog.md`/`self/metrics.md` writers). The most subtle new requirement is **provenance taint reaching the gate** (SAFE-04 rule ii): today `ToolCall` carries only `{ tool, args }` with no `origin` field, so the gate cannot currently tell that a Red action's instruction traced to `source:external` content. The `ContextItem`/`Provenance` type and the quarantine seam already exist (`memory/types.ts`), so this is a propagation problem, not a new data model: add an optional `origin?: Provenance` to `ToolCall`, set it at the brain-decision site, and hard-block `tier==='red' && origin==='external'` in the gate *above* the breaker and *above* `/override`.

**Primary recommendation:** Build `safety/breaker.ts` as a pure, injectable state machine (mock executor + injectable clock + injectable confirm/cancel signal + single-writer spend ledger) so 100% of the safety logic is unit-testable with zero real side effects; wire it into the existing `gated` arm; gate Claude Code's Red actions with `disallowedTools` scoped deny rules (`Bash(rm *)`, etc.) that the CLI enforces *even under bypass* and that remove the action from Claude's reach entirely, surfacing any `permission_denials` back up to KERNEL's gate as an escalation; and ship the maintenance jobs as short-lived `node dist/index.js --<job>` modes mirroring the existing `--heartbeat` plist pattern. NEVER execute a real `rm -rf`, purchase, spend, or live `git push` in any test.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Tier classification (Green/Yellow/Red) | Daemon `safety/tiers.ts` | — | Already central; tools never self-classify (shipped, Anti-Pattern enforced) |
| Circuit breaker (dry-run→cancel→ceiling→audit) | Daemon `safety/breaker.ts` (new) | Daemon `safety/gate.ts` | The breaker is a kernel chokepoint, never per-tool (PITFALLS #6) |
| `/override` state | Daemon (session flag in `safety/`) | Face (surfaces active state, voice/typed trigger) | Authority must live where the gate is; the Face only *requests* it |
| Credential fence (hard rule i) | Daemon `safety/tiers.ts` `detectCredentialField` | Tool adapters surface AX/DOM signals | Shipped in P2; confirm `overridable=false`. Physical capability is in the type-tool |
| External-content Red interlock (hard rule ii) | Daemon `safety/gate.ts` | Brain decision site (sets `origin`) + quarantine seam | Code-level block at the chokepoint, never a prompt rule (PITFALLS #1) |
| Daily spend ceiling (hard rule iii) | Daemon `safety/breaker.ts` (single-writer ledger) | — | Atomic check-and-reserve in one critical section (PITFALLS #6) |
| Red gating inside Claude Code (SAFE-05) | Daemon (`disallowedTools` deny rules + `permission_denials` → gate) | `tools/claude-code.ts` | CC has no ambient Red rights; a Red action re-enters the same breaker |
| Obstacle planner ladder | Daemon `planner/ladder.ts` (new) | Brain (replan/recommend) + router (dispatch) | A control structure wrapping dispatch; Red gates skip it (ARCHITECTURE §9) |
| Nightly consolidation (logs→reflections, promote facts) | Daemon `memory/consolidate.ts` (new) | launchd `StartCalendarInterval` | Batch job, not hot path; reuses the shipped reranker authority weights |
| Cleanup / prune | Daemon `memory/prune.ts` (new) | launchd | Same schedule family as consolidation |
| GitHub backup (explicit-add push) | Daemon `memory/backup.ts` (new) | launchd + shipped pre-push hook + ls-files assertion | finance/ never leaves the machine; 4-layer stack already verified |
| Self changelog + metrics | Daemon (writers under `self/`) | consolidation job | Honest record of changes/metrics |

## User Constraints

> No `CONTEXT.md` exists for this phase yet (standalone research run). The binding constraints below are extracted from the owner-approval context, ROADMAP Phase 5 success criteria, REQUIREMENTS SAFE-01..07/MAINT-01..03/MEM-07, CLAUDE.md, and the master build prompt §8/§9/§13. Treat them with the same authority as locked decisions.

### Locked Decisions (from owner approval + spec §8 hard rules)
- **Owner has EXPLICITLY APPROVED enabling `/override` and Red-tier autonomy.** The gate goes LIVE this phase. [CITED: objective + owner_approval_context]
- **CRITICAL INVARIANT — Red is ALWAYS GATED even under `/override`.** `/override` unlocks Green (full speed) and Yellow (proceed + log + notify) only. Red ALWAYS runs: dry-run preview → 10-second cancel window → spend-ceiling check → audit log, and NEVER auto-executes from externally-sourced content. "Enabling Red autonomy" = the breaker is ACTIVE and permits *gated* Red actions; it does NOT mean bypassing the breaker. [CITED: spec §8; CLAUDE.md Safety]
- **Three never-overridable hard rules (spec §8):** (i) never enter credentials/passwords/cards/SSN — escalate; (ii) no Red action whose instruction originated in external content — quarantine + escalate; (iii) user-set daily spend ceiling forces escalation when exceeded. These hold *even under active `/override`*, verified by tests. [CITED: spec §8; SAFE-04]
- **All build/test of irreversible paths MUST use MOCKS / dry-runs.** Never a real `rm -rf`, purchase, spend, or live `git push` during the build. [CITED: owner_approval_context]
- **Pinned stack, no new heavy deps.** Daemon = TypeScript/Node 24 ESM; subprocess via zero-dep `node:child_process` (the shipped convention — NOT execa, despite the STACK.md suggestion); git via shelling `git` (NOT simple-git); scheduler = launchd; test runner = `node:test` via `tsx --test`. [VERIFIED: daemon/package.json; existing claude-code.ts/leakguard.ts use node:child_process + execFileSync git]
- **The classify-only gate, the chokepoint, the credential fence, the quarantine seam, the 4-layer finance-leak stack, the kernel-memory pre-push hook, and the launchd heartbeat plist pattern are SHIPPED.** Phase 5 upgrades them; it does not rebuild them. [VERIFIED: read this session]
- **IDENTITY.md is NEVER auto-edited** — including by consolidation. The SHA-256 baseline + `assertNotIdentityPath` write-path guard enforce this. [VERIFIED: memory/identity.ts]
- **Externally-sourced content is NEVER auto-promoted** to knowledge/ or IDENTITY.md by consolidation. [CITED: spec §5; MEM-05; MEM-07]

### Claude's Discretion (research recommends; planner/owner confirm)
- Exact storage location + format of the daily spend ledger (recommendation below: `self/spend-ledger.json` under the memory repo, single-writer, gitignored or committed — see Open Question 2).
- Cancel-window default behavior on timeout: proceed vs cancel (recommendation below: **proceed after ceiling+audit checks pass**, since the window is the owner's chance to CANCEL — see Open Question 1).
- Audit-log format + location (recommendation: append-only `self/audit-log.md` or NDJSON under `logs/`, with the action's content hash).
- Exact launchd schedule times for consolidation/cleanup/backup (recommendation: nightly, staggered).
- How `/override` is triggered by voice (recommendation: a new IPC `override` frame; voice path reuses the existing utterance→intent path with a command parse — see Open Question 3).

### Deferred Ideas (OUT OF SCOPE)
- Embedding-based retrieval (16GB ceiling; MEM-V2-01 is v2).
- Any write-scope finance access (read-only OAuth only, by construction).
- Auto-promoting external memory writes (permanent backdoor — explicitly out of scope in REQUIREMENTS).
- A single global `/override` boolean (PITFALLS #7 — must be a scoped capability, not a master switch).

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SAFE-02 | `/override` (typed or voice) unlocks Green full-speed, Yellow proceed+log+notify | §"/override state" below — scoped session capability with timeout + audit, new IPC frame, surfaced in Face |
| SAFE-03 | Red always gated even under `/override`: dry-run→10s cancel→spend-ceiling (no race)→audit | §"The circuit breaker" — `safety/breaker.ts` state machine; atomic single-writer ledger; injectable clock |
| SAFE-04 | Three never-overridable rules (creds / external-sourced Red / spend ceiling) | §"Hard non-overridable rules" — fence (shipped, confirm overridable=false), `origin` taint propagation, atomic ceiling |
| SAFE-05 | Red gating inside Claude Code (re-submission shim re-enters the same breaker) | §"Red gating inside Claude Code" — `disallowedTools` deny rules + `permission_denials` → gate; TOCTOU content-hash re-verify |
| SAFE-06 | Obstacle ladder: try→replan→decompose→retry-backoff→escalate-with-recommendation; Red skips ladder | §"Obstacle planner ladder" — new `planner/ladder.ts` state machine wrapping dispatch |
| SAFE-07 | `/override` + Red tier were unreachable (flagged off) in P1–P4; enabled+tested only now | §"SAFE-07 — flip-on is behavior-preserving" — feature flag, additive change, P1–P4 tests unchanged |
| SAFE-01 | (shipped seed) tier classification Green/Yellow/Red | `safety/tiers.ts` shipped; confirm matrix coverage vs phase ops |
| MEM-07 | Nightly consolidation distills logs→reflections, promotes durable facts→knowledge; cleanup prunes | §"Self-maintenance jobs" — `consolidate.ts`/`prune.ts`; external-sourced facts NOT promoted |
| MAINT-01 | Nightly launchd job commits+pushes the memory repo to private GitHub (never finance/) | §"GitHub backup" — explicit `git add <paths>`, never `-A`/`-f`; pre-push hook + ls-files guard |
| MAINT-02 | KERNEL maintains self/changelog.md + self/metrics.md | §"Self changelog + metrics" |
| MAINT-03 | Maintenance jobs (consolidation/cleanup/backup) run on schedule via launchd | §"launchd jobs" — `--consolidate`/`--cleanup`/`--backup` modes + plists mirroring heartbeat |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

CLAUDE.md is authoritative and reinforces the spec. Directives the planner must honor:
- **Safety (verbatim):** "Tiered autonomy. Red tier always gated even under `/override`: dry-run preview → 10s cancel → spend-ceiling check → audit log. Hard non-overridable rules: no credential entry, no Red action sourced from external content, daily spend ceiling. Red-tier gating applies inside Claude Code sessions too." → exactly this phase.
- **Working protocol:** build one phase at a time; each independently working; commit + push at every phase gate. The owner hard-stop before this phase is satisfied by explicit approval.
- **Stack pinned:** Node 24 LTS ESM, TypeScript 5.9, launchd scheduler, markdown+YAML git memory with nightly push to private GitHub, finance read-only.
- **Versioned model IDs only** (no `*-latest` aliases) — relevant if the breaker/ladder calls the brain for a recommendation; reuse the shipped `ClaudeBrain` (`claude-opus-4-8`).
- **GSD workflow enforcement:** edits go through a GSD command; no direct repo edits outside the workflow.
- **16GB ceiling:** no embedded models; keep maintenance jobs short-lived (they spawn, do work, exit — like `--heartbeat`).
- **`pino-pretty` is dev-only**, never on the launchd-run path (the maintenance plists run plain pino).

## Standard Stack

**No new third-party packages are required for Phase 5.** Every capability is built from the shipped dependency set + Node built-ins. This is the safest possible answer for the most safety-critical phase: zero new supply-chain surface.

### Core (all already installed — versions verified in daemon/package.json this session)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `node:crypto` (built-in) | Node 24 | SHA-256 content hash for TOCTOU re-verify + audit | Already used by `memory/identity.ts`; never hand-roll a hash (ASVS V6) |
| `node:child_process` (built-in) | Node 24 | Spawn `git` for backup; spawn `claude` for the CC shim | The shipped convention (`claude-code.ts`, `leakguard.ts`) — NOT execa |
| `zod` | 4.4.3 | Validate new IPC frames (override/breaker-preview/audit), ledger shape, job config | Already the project-wide validator [VERIFIED: npm registry] |
| `gray-matter` | 4.0.3 | Read/write front-matter on reflections + knowledge files in consolidation | Already used by `quarantine.ts`/`retrieve.ts` [VERIFIED: npm registry] |
| `pino` | 10.3.1 | Structured audit/event logging on the launchd-run path (plain, not pretty) | Already the logger [VERIFIED: npm registry] |
| `launchd` (macOS native) | — | Schedule consolidation/cleanup/backup via `StartCalendarInterval` | Pinned scheduler; heartbeat plist is the template |

### Supporting (already installed; reused, not newly added)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@anthropic-ai/sdk` (via shipped `ClaudeBrain`) | 0.105.0 | The obstacle ladder's replan/recommend step calls the cloud brain | Only for "propose approach B" / "recommend Z" (ladder REPLAN/ESCALATE) |
| shipped `ClaudeCodeBrain` / `tools/claude-code.ts` | — | The CC bridge the Red shim attaches to | SAFE-05 |
| shipped `safety/leakguard.ts` (`assertFinanceNotTracked`) | — | Re-run before/around backup as the ls-files assertion | MAINT-01 |
| shipped pre-push hook `daemon/scripts/hooks/kernel-memory-pre-push.sh` | — | Layer (b) — aborts a push containing finance bytes | MAINT-01 (must be installed in the kernel-memory repo's `.git/hooks/`) |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `node:child_process` git | `simple-git` (3.x, in STACK.md) | Adds a dep + a legitimacy checkpoint; the shipped code already shells git via `execFileSync`. Stay zero-dep. |
| `node:child_process` spawn | `execa` (9.x, in STACK.md) | Same — STACK.md suggested it but the codebase deliberately avoided it ("NOT execa, avoiding a dependency + its legitimacy checkpoint"). Honor the established convention. |
| `disallowedTools` deny rules for CC Red gating | `canUseTool` callback / `--permission-prompt-tool` stdio | The callback path has a **documented gap in raw stream-json print mode** (no inbound `can_use_tool` control_request surfaces) — see Open Question 4. Deny rules are enforced even under bypass and are strictly safer. |

**Installation:** None. `npm install` is a no-op for this phase — confirm with `cd daemon && npm ci` produces no new entries.

**Version verification (run before planning, confirms nothing drifted):**
```bash
cd /Users/pravinmaurya/Documents/KernelAi/daemon && npm view zod version && npm view gray-matter version && npm view pino version
```

## Package Legitimacy Audit

> Phase 5 installs **no external packages**. All capabilities use Node built-ins + already-installed, already-audited dependencies. The legitimacy gate is therefore trivially satisfied: there is nothing new to slopcheck.

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| (none — no new installs) | — | — | — | — | — | N/A |

**Packages removed due to slopcheck [SLOP] verdict:** none.
**Packages flagged as suspicious [SUS]:** none.

All reused packages (`zod`, `gray-matter`, `pino`, `@anthropic-ai/sdk`) were vetted in prior phases and are `[VERIFIED: npm registry]` per STACK.md's `npm view` audit. No new install means no new gate.

## Architecture Patterns

### System Architecture Diagram

The breaker upgrade keeps the SINGLE chokepoint. Data flow through the gate (arrows = control flow):

```
                       brain.reason() → Decision{ action: ToolCall{ tool, args, origin? } }
                                              │
                                              ▼
loop.drain() ──────────────────────► router.dispatch(call)
                                              │
                                  (1) surfaceSignals(args)   ── read-site AX/DOM creds (shipped)
                                              │
                                  (2) gate.authorize(call) ◄──────────── THE ONE CHOKEPOINT
                                              │
        ┌─────────────────────────────────────┼───────────────────────────────────────┐
        │ HARD RULES (never overridable, checked FIRST, above /override + breaker):     │
        │   i.  detectCredentialField → deny + escalate           (shipped)             │
        │   ii. tier===red && origin===external → deny + escalate (NEW: taint block)    │
        │   iii.(spend ceiling enforced inside the breaker, atomic)                     │
        └─────────────────────────────────────┬───────────────────────────────────────┘
                                              ▼
                              classifyTier(call)  ─────────────┐
                                              │                 │
                  ┌───────────── green ───────┤                 │
                  │              yellow ───────┤                 │
                  │                 red ───────┘                 │
                  ▼                  │                            │
            /override ON?            │  /override ON?             │  (Red ignores /override
          green: allow full-speed    │  yellow: allow + log+notify│   for the allow decision)
          green OFF: allow           │  yellow OFF: allow         │
                                     ▼                            ▼
                              return {allow}            return { kind:'gated', tier:'red' }   ◄── NEW (flag-gated)
                                              │                            │
        registry.dispatch: verdict.kind===   │                            ▼
          'allow' → execute              ─────┘             breaker.run(call):               ◄── NEW safety/breaker.ts
          'gated' → await breaker.run() ──────────────────►  a. dryRun(call) → preview frame → Face
          'deny'  → return escalation                        b. 10s cancel window (injectable clock + cancel signal)
                                                             c. atomic spend-ceiling check+reserve (single-writer ledger)
                                                             d. audit-log (action + content hash)
                                                             e. TOCTOU: re-hash + re-read state; abort if changed
                                                             f. on confirm/timeout-proceed → tool.execute()

Claude Code mid-session Red action ─► claude runs with disallowedTools=[Bash(rm *), Bash(*install*), ...]
                                       → CLI removes/denies it (even under bypass)
                                       → permission_denials surfaces in final result event
                                       → tools/claude-code.ts maps it to a ToolCall and RE-ENTERS gate.authorize
                                       → classifies Red → breaker (same path above). Never auto-runs.

launchd nightly ─► node dist/index.js --consolidate  → memory/consolidate.ts (logs→reflections, promote source-vetted facts)
                ─► node dist/index.js --cleanup       → memory/prune.ts (prune stale working-memory + old logs)
                ─► node dist/index.js --backup        → memory/backup.ts (git add <explicit paths>; commit; push) + pre-push hook
```

### Recommended Project Structure (additions only; italic = new file)
```
daemon/src/
├── safety/
│   ├── tiers.ts          # SHIPPED — confirm matrix; add `origin` awareness if needed
│   ├── gate.ts           # EDIT — flip Red→gated under flag; add external-Red hard block; thread /override
│   ├── breaker.ts        # NEW — dry-run→10s cancel→atomic ceiling→audit→TOCTOU re-verify→execute
│   ├── override.ts       # NEW — scoped /override capability (flag, scope allowlist, timeout, audit)
│   ├── spend-ledger.ts   # NEW — single-writer atomic daily spend accounting
│   └── audit.ts          # NEW — append-only audit log writer (action + content hash)
├── planner/
│   └── ladder.ts         # NEW — obstacle ladder state machine wrapping dispatch (§9)
├── memory/
│   ├── consolidate.ts    # NEW — logs→reflections; promote durable, source-vetted facts→knowledge
│   ├── prune.ts          # NEW — prune stale working-memory + old logs
│   └── backup.ts         # NEW — explicit-add git commit + push (never -A/-f)
├── self/                 # writers for changelog.md + metrics.md (NEW, under memory repo)
├── tools/
│   ├── registry.ts       # EDIT — wire `gated` arm → breaker.run() (path already designed in)
│   └── claude-code.ts    # EDIT — add disallowedTools deny rules + permission_denials → gate re-entry
├── brain/
│   └── BrainProvider.ts  # EDIT — add optional `origin?: Provenance` to ToolCall
├── ipc/
│   └── protocol.ts       # EDIT — APPEND override / breaker-preview / cancel / audit frames to FrameSchema
└── index.ts              # EDIT — add --consolidate / --cleanup / --backup short-lived modes
launchd/
├── com.kernel.consolidation.plist   # NEW — StartCalendarInterval nightly (mirror heartbeat)
├── com.kernel.cleanup.plist         # NEW
└── com.kernel.backup.plist          # NEW
```

### Pattern 1: The breaker as a pure, injectable state machine
**What:** `safety/breaker.ts` runs the Red flow as a deterministic sequence with every side-effecting dependency injected (executor, clock, cancel signal, ledger, audit sink, preview emitter). No real timer, no real `rm`, no real spend in the logic itself.
**When to use:** Always for Red. This is what makes the most dangerous code 100% unit-testable with a fake clock and a mock executor.
**Example (shape grounded in the shipped `Verdict`/`dispatch` contract — verify against `safety/gate.ts` + `tools/registry.ts`):**
```typescript
// Source: derived from shipped gate.ts Verdict + registry.ts dispatch comment (this session)
export interface BreakerDeps {
  clock: { now(): number; sleep(ms: number): Promise<void> };   // fake clock in tests
  cancelled: () => boolean;                                       // owner cancel signal (IPC)
  emitPreview: (preview: DryRunPreview) => void;                 // → Face breaker-preview frame
  ledger: SpendLedger;                                            // atomic single-writer
  audit: (entry: AuditEntry) => void;                            // append-only audit sink
  execute: (call: ToolCall) => Promise<ToolResult>;              // the real tool, mocked in tests
  reReadState: (call: ToolCall) => Promise<string>;              // TOCTOU: state hash NOW
}
export async function run(call: ToolCall, deps: BreakerDeps): Promise<ToolResult> {
  const preview = dryRun(call);                 // describe; NO side effects
  const hashAtPreview = sha256(canonical(call) + preview.stateHash);
  deps.emitPreview(preview);
  const deadline = deps.clock.now() + 10_000;   // 10s cancel window
  while (deps.clock.now() < deadline) {
    if (deps.cancelled()) { deps.audit({ call, outcome: 'cancelled' }); return cancelled(); }
    await deps.clock.sleep(100);
  }
  // spend ceiling — atomic check+reserve in ONE critical section (no race)
  const reserve = deps.ledger.checkAndReserve(estimatedSpend(call));
  if (!reserve.ok) { deps.audit({ call, outcome: 'ceiling-exceeded' }); return escalateCeiling(reserve); }
  // TOCTOU: re-read state, re-hash, abort if the previewed action ≠ what would now run
  const hashNow = sha256(canonical(call) + (await deps.reReadState(call)));
  if (hashNow !== hashAtPreview) { deps.ledger.release(reserve); deps.audit({ call, outcome: 'toctou-abort' }); return escalateChanged(); }
  deps.audit({ call, outcome: 'executed', hash: hashNow });
  return deps.execute(call);
}
```

### Pattern 2: `/override` as a scoped capability, never a global boolean (PITFALLS #7)
**What:** `safety/override.ts` holds an explicit allowlist of what override touches (Green friction off, Yellow notify-vs-block) and a denylist it can NEVER touch (the three hard rules + the Red breaker). Activation is audit-logged with scope + duration and auto-expires.
**When to use:** Always. A global boolean is an explicit anti-pattern (PITFALLS #7, "Never").
**Anti-pattern:** `let override = true;` consulted ad-hoc in the gate. Instead: `override.allows(tier)` returns the *behavior* (full-speed / notify) for Green/Yellow only and is structurally incapable of returning a Red bypass.

### Pattern 3: Provenance taint propagation to the gate (SAFE-04 ii)
**What:** Add `origin?: Provenance` to `ToolCall` (the `Provenance = 'user'|'self'|'external'` type already exists in `memory/types.ts`). The brain decision site sets `origin` based on whether the instruction that produced the action traced to a `source:external` context item. The gate hard-blocks `tier==='red' && origin==='external'` *above* `/override` and *above* the breaker.
**When to use:** The single most important new control. A test-injection email must NOT trigger a Red action even under active `/override`.
**Note:** Default `origin` to the safest value when unknown. Recommendation: treat absent/unknown `origin` on a Red action as suspect → escalate (default-deny posture, consistent with the shipped `classifyTier` "unknown → red" default).

### Anti-Patterns to Avoid
- **Per-tool breaker:** never put the breaker inside individual tool functions — it must be the kernel chokepoint or Claude Code / uncategorized actions bypass it (PITFALLS #6, "Never").
- **Single global `/override`:** disables safety wholesale (PITFALLS #7).
- **Check-then-act spend:** separate unlocked check and debit statements race (PITFALLS #6). Use one atomic critical section.
- **Preview-time-only verification:** the previewed action must be re-verified at execution time against a content hash with state re-read (TOCTOU; PITFALLS #6).
- **Consolidation reading logs/ without filtering on `source`:** auto-promotes poisoned facts (PITFALLS #2, the "automated privilege-escalation pump").
- **`git add -A` / `git add .` / `git add -f` in backup:** greedy add risks finance leak (PITFALLS #3). Explicit paths only.
- **Trusting `--allowedTools` under `bypassPermissions` for CC:** allowedTools does NOT constrain bypass; use `disallowedTools` deny rules (verified against Anthropic docs).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Content hash for TOCTOU + audit | A custom checksum | `node:crypto` `createHash('sha256')` | Already the project pattern (identity.ts); never hand-roll crypto (ASVS V6) |
| Claude Code Red interception | A regex over CC's stdout to "catch" rm -rf after the fact | `disallowedTools` scoped deny rules (`Bash(rm *)`, `Bash(*install*)`) + `permission_denials` in the result event | The CLI enforces deny rules *before* execution, even under bypass; post-hoc stdout scanning is racy and bypassable |
| Daily spend atomicity | Two-statement check then debit | One single-writer critical section (synchronous, in-process; the daemon is single-process serial) | The daemon already serializes work (one drain pass at a time, loop.ts); exploit that — check+reserve synchronously |
| Git plumbing for backup | A bespoke commit/push wrapper with many flags | Shell `git -C <repo> add <explicit paths>` then `commit`/`push`, reusing the `execFileSync` pattern from leakguard.ts | Zero-dep, matches shipped convention; explicit-add is the whole safety point |
| Frame transport for override/preview/cancel | A new socket or protocol | APPEND zod arms to the frozen `FrameSchema` discriminated union | P3/P4 added arms additively; the contract is designed for it |
| Scheduling the jobs | A `setInterval` inside the resident daemon | launchd `StartCalendarInterval` + short-lived `--<job>` modes | Resident-timer scheduling fights idle-unload + duplicates launchd (Anti-Pattern 5) |

**Key insight:** In this domain the dangerous move is *building a new control surface*. Almost everything here is "activate the dormant arm" or "append to a frozen contract." The breaker, ladder, and jobs are new *logic*, but they ride existing *seams*. Resist any urge to refactor the router, the loop, or the IPC framing.

## Runtime State Inventory

> This is an *activation* phase, not a rename. There is no string-rename surface. But "flipping the gate on" has runtime-state implications that a code grep won't surface, so each category is answered explicitly.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | **Daily spend ledger (NEW)** — where the running daily total persists across the day and resets at the day boundary. No such store exists yet. | Create `self/spend-ledger.json` (single-writer). Decide commit-vs-gitignore (Open Q2). **Audit log (NEW)** — append-only record of every Red verdict. Create under `self/` or `logs/`. |
| Live service config | **Three NEW launchd plists** (consolidation/cleanup/backup) must be loaded via `launchctl bootstrap gui/$(id -u) <plist>` — they live on disk in `launchd/` but the *loaded* state is OS-registered, NOT in git. **The GitHub backup remote** must be configured on the kernel-memory repo (`git remote add origin <private url>`) — this is owner machine state, not code (Open Q5). | Document the `launchctl bootstrap` step + remote setup as owner manual steps; the plists themselves are committed. |
| OS-registered state | The shipped `com.kernel.heartbeat.plist` + `com.kernel.daemon.plist` are the pattern; the three new plists register the same way. **The pre-push hook** must be physically installed into `kernel-memory/.git/hooks/pre-push` (a `.git/hooks/` file is NOT tracked by git) — `daemon/scripts/hooks/kernel-memory-pre-push.sh` is the source; the README documents installation. | Confirm the hook is installed in the kernel-memory repo before the first backup push; the backup job should refuse to push if the hook is absent (defense-in-depth). |
| Secrets/env vars | `ANTHROPIC_API_KEY` (env, used by ClaudeBrain/ClaudeCodeBrain for ladder replan + CC). The GitHub backup needs push auth — a deploy key or a PAT, which is owner machine state (NOT in the repo; `.env` is gitignored in kernel-memory). The finance DB key stays in Keychain (unchanged). | No code-level secret rename. Document the GitHub push-auth setup (SSH deploy key recommended over a PAT) as an owner step. |
| Build artifacts | `daemon/dist/` — the launchd plists run `dist/index.js`, so the new `--consolidate`/`--cleanup`/`--backup` modes require `npm run build` before the plists work. | Add a build step to the deploy runbook; the plists reference `dist/index.js`, not `src/`. |

**The canonical question — after every file is updated, what runtime systems still need action?** (a) launchd must be told to load the 3 new plists; (b) the kernel-memory repo needs a remote + push auth + the pre-push hook installed; (c) `dist/` must be rebuilt; (d) the spend ledger + audit log files get created on first run. None of these are code edits — they are the manual owner-machine steps the planner must list as checkpoints.

## Common Pitfalls

### Pitfall 1: External-content Red bypass (the existential one)
**What goes wrong:** A poisoned email/web page induces a Red action; if `origin` taint doesn't reach the gate, the gate can't tell, and `/override` (now LIVE) lets it through.
**Why it happens:** `ToolCall` currently has no `origin` field — the gate is blind to provenance. The brain that *reads* the email is the same brain that *decides* the action.
**How to avoid:** Add `origin?: Provenance` to `ToolCall`; set it at the decision site; hard-block `red && external` in the gate *above* `/override` and the breaker. Default unknown-origin Red to escalate. Verify with a test-injection email that cannot move KERNEL to a Red action even under active `/override`.
**Warning signs:** A tool-call's args trace byte-for-byte to external text; any test "injection" changes behavior.

### Pitfall 2: Spend-ceiling race (TOCTOU on the counter)
**What goes wrong:** Two near-simultaneous Red purchases each pass the "under ceiling" check before either debits.
**Why it happens:** Check and debit are separate statements.
**How to avoid:** Single-writer atomic `checkAndReserve()` in one synchronous critical section. The daemon's serial drain (one intent at a time) already prevents true concurrency, but the breaker can `await` (the 10s window) — so reserve BEFORE the await-to-execute gap, and release on cancel/abort.
**Warning signs:** Two Red actions both pass while the running total should have blocked the second.

### Pitfall 3: Confirmation fatigue
**What goes wrong:** The breaker prompts so often that the owner reflexively approves.
**Why it happens:** Prompting on Green/Yellow too.
**How to avoid:** Reserve interrupts for Red ONLY — Green full-speed, Yellow proceed+notify. Make the Red preview high-context (what, how much, to whom, why). The 10s window is a *cancel* opportunity, not an *approve* prompt (reduces decision load — see Open Q1).
**Warning signs:** Owner reports "it asks constantly."

### Pitfall 4: Consolidation as a privilege-escalation pump (memory poisoning)
**What goes wrong:** Nightly consolidation promotes an external-sourced "fact" into knowledge/, making a one-shot injection a permanent backdoor.
**Why it happens:** Reading logs/ without filtering on `source`.
**How to avoid:** Consolidation may promote ONLY records tagged `source:user` or `source:self`. External-tagged records can be summarized for recall but never promoted, and are surfaced with an "unverified, from email dated X" marker. NEVER touch IDENTITY.md (the hash guard + write-path guard enforce this — but the consolidation code must also never *target* it). Verify: a consolidation run that processed ONLY external-sourced logs leaves knowledge/ and IDENTITY.md byte-identical.
**Warning signs:** knowledge/ or IDENTITY.md mtime changes on a night with no human edit and external content processed.

### Pitfall 5: Finance leak on the first nightly push
**What goes wrong:** The backup job's first push includes finance/.
**Why it happens:** `git add -A`, an uninstalled pre-push hook, or a finance sidecar outside the ignored path.
**How to avoid:** Explicit `git add <paths>` (never `-A`/`-f`); the backup job runs `assertFinanceNotTracked` (ls-files layer d) before pushing AND refuses to push if the pre-push hook is absent; the shipped hook scans pushed bytes (layer b). Verify: a deliberately-staged fake `finance/test.txt` aborts the push.
**Warning signs:** `git ls-files | grep -i finance` is non-empty; `--no-verify` anywhere.

### Pitfall 6: Claude Code Red sub-session leak (SAFE-05)
**What goes wrong:** A `rm -rf`/install/purchase runs *inside* a CC session and never routes through KERNEL's breaker.
**Why it happens:** The breaker only watches KERNEL's own tool calls; CC has its own tool surface.
**How to avoid:** Run `claude` with `disallowedTools` scoped deny rules (`Bash(rm *)`, `Bash(*install*)`, `Bash(*git push*)`, etc.) — the CLI removes/denies them *before* execution, *even under bypass*. Surface `permission_denials` from the final result event back to KERNEL, map each to a `ToolCall`, and RE-ENTER `gate.authorize` so the owner can approve via the same breaker (it does not auto-run). See Open Q4 for why the `canUseTool`/`--permission-prompt-tool` callback path is NOT relied on.
**Warning signs:** CC executes a destructive op with no KERNEL audit entry.

## Code Examples

### Wiring the gated arm (the path already designed into dispatch)
```typescript
// Source: tools/registry.ts shipped comment — "the `gated` branch is kept so Phase 5
// enables the breaker INSIDE gate.authorize without touching this file" (read this session)
const verdict = await authorize(call);
if (verdict.kind === 'deny')  return { ok: false, escalation: verdict.escalation };
if (verdict.kind === 'gated') return breaker.run(call, breakerDeps);   // ← NEW wire-up
const parsed = tool.schema.safeParse(call.args);                       // (shipped) ASVS V5
if (!parsed.success) return { ok: false, escalation: { reason: `invalid tool args: ${parsed.error.message}` } };
return tool.execute((parsed.data as Record<string, unknown>) ?? call.args);
```

### The gate Red branch flip (under the SAFE-07 flag)
```typescript
// Source: safety/gate.ts shipped "PHASE 5 ONLY" comment (read this session)
// Hard rule i (shipped): credential fence → deny (above everything). KEEP overridable=false.
// Hard rule ii (NEW): external-sourced Red → deny, ABOVE /override and the breaker.
if (tier === 'red' && call.origin === 'external') {
  return { kind: 'deny', tier, escalation: {
    reason: 'Red action whose instruction originated in external content — never auto-executed (spec §8).',
    recommendation: 'Quarantined; Pravin must initiate this action directly.' } };
}
if (tier === 'red') {
  if (!FLAGS.breakerEnabled) return { kind: 'deny', tier, escalation: { /* P1–P4 behavior */ } };
  return { kind: 'gated', tier };   // ← the live breaker takes over in registry.dispatch
}
```

### Claude Code Red gating (deny rules + denial re-entry)
```typescript
// Source: Anthropic agent-SDK permission docs (verified this session) — disallowedTools
// scoped deny rules are enforced even under bypassPermissions and remove/deny the action.
const RED_DENY = ['Bash(rm *)', 'Bash(rmdir *)', 'Bash(*install*)', 'Bash(*git push*)', 'Bash(sudo *)'];
// argv: ... '--disallowedTools', RED_DENY.join(','), '--allowedTools', 'Read', '--permission-mode', 'dontAsk'
// After the run, the final result event carries permission_denials[]; for each, build a ToolCall
// (origin: 'self' — it came from KERNEL's own sub-contractor, not external content) and re-enter:
for (const denial of result.permission_denials ?? []) {
  const reentry = mapDenialToToolCall(denial);            // e.g. { tool:'shell', args:{op:'rm -rf', path} }
  await dispatch(reentry);                                 // → gate → Red → breaker (owner approves, never auto-runs)
}
```

### Self-maintenance launchd job mode (mirrors --heartbeat)
```typescript
// Source: index.ts shipped --heartbeat pattern (read this session)
if (argv.includes('--consolidate')) { await runConsolidation(); process.exit(0); }
if (argv.includes('--cleanup'))     { await runCleanup();       process.exit(0); }
if (argv.includes('--backup'))      { await runBackup();        process.exit(0); }
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Gate denies all Red (classify-only) | Gate gates Red via live breaker; `/override` scopes Green/Yellow | This phase | Autonomy becomes safe to enable |
| CC runs Green/Yellow with `--allowedTools Read` only | + `disallowedTools` scoped deny rules; `permission_denials` re-enter the breaker | This phase | CC Red actions route to KERNEL's gate |
| Loop escalates inline (`Blocked: ...` reply) | Obstacle ladder: retry→replan→decompose→backoff→escalate-with-recommendation | This phase | No vague "I'm stuck"; Red gates skip the ladder |
| Logs grow append-only forever | Nightly consolidation + cleanup distill/prune | This phase | "No junk, no degradation" |

**Deprecated/outdated:**
- The `canUseTool` / `--permission-prompt-tool stdio` approach for gating CC tool use in **raw stream-json print mode** is unreliable (documented gap — no inbound `can_use_tool` control_request surfaces in headless print contexts; anthropics/claude-code issue #34046). Prefer `disallowedTools` deny rules + `permission_denials`. [CITED: code.claude.com/docs/en/agent-sdk/permissions; github.com/anthropics/claude-code/issues/34046]
- `git add -A`/`-f` in any backup automation — forbidden (PITFALLS #3).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The spend ledger lives at `self/spend-ledger.json`, single-writer, reset at the local-day boundary | Runtime State / Open Q2 | Wrong location/format → minor refactor; atomicity is the real requirement, location is discretionary |
| A2 | Cancel-window timeout default = PROCEED (after ceiling+audit), since the window is a cancel opportunity | Pitfall 3 / Open Q1 | If owner wants default-cancel, flip one branch; both are 1-line in the state machine |
| A3 | Audit log is append-only under `self/` (or `logs/`) carrying the action + content hash | Runtime State | Format is discretionary; the *content hash* is the load-bearing part |
| A4 | `/override` is triggered by a NEW additive IPC `override` frame; voice reuses utterance→intent with a command parse | Open Q3 | If voice trigger is wired differently, only the trigger path changes; the scoped capability is unaffected |
| A5 | The GitHub backup remote uses an SSH deploy key (owner-configured machine state), pushed over `git push` shelled via child_process | MAINT-01 / Open Q5 | Auth method is owner's choice; code just calls `git push` |
| A6 | `disallowedTools` deny rules are the chosen CC Red-gating mechanism (not `canUseTool`) | Standard Stack / Open Q4 | Verified against official docs; if the CLI's flag names differ at the installed version, confirm with `claude --help` before planning the exact argv |
| A7 | No new npm packages are needed | Standard Stack | If the planner finds a genuine gap, run the full Package Legitimacy Gate before adding anything |
| A8 | The shipped `classifyTier` matrix covers the Red ops this phase exercises (rm/purchase/transfer/etc.) | SAFE-01 | If a phase op is unclassified it defaults to Red (safe); only a *false-green* misclassification is dangerous — audit the GREEN/YELLOW sets |

**If this table looks long:** every entry is a *discretionary* implementation detail flagged for owner confirmation in discuss-phase, not an unverified safety claim. The safety-critical claims (breaker flow, hard rules, taint block, atomic ceiling, CC deny rules, no-auto-promote) are all CITED to the spec or verified against the code/docs.

## Open Questions

1. **Cancel-window default on timeout: proceed or cancel?**
   - What we know: spec §8 says "dry-run preview → 10-second cancel window → spend-ceiling check → audit log." The window is framed as a *cancel* opportunity.
   - What's unclear: if the owner does nothing for 10s, does the Red action proceed (after ceiling+audit) or cancel?
   - Recommendation: **PROCEED after the ceiling check passes and the action is audit-logged** — the window exists for the owner to CANCEL, and a Red action KERNEL itself proposed (not external-sourced, ceiling-OK, dry-run shown) is the autonomy the owner explicitly enabled. Absent cancel → proceed, but ONLY after ceiling + audit. Confirm in discuss-phase. (This is a 1-line branch either way.)

2. **Where does the daily spend ledger live, and is it committed or gitignored?**
   - What we know: it must be atomic, single-writer, and reset at the day boundary. Finance amounts must never be logged or leaked.
   - What's unclear: file location + whether it's part of the backed-up memory or machine-local.
   - Recommendation: `self/spend-ledger.json` containing only `{ date, totalReserved, ceiling }` (no transaction detail, no memos) — safe to commit because it carries no finance PII, but gitignore it to be conservative (machine-local runtime state, like `self/identity.hash` already is). Confirm.

3. **How is `/override` triggered by voice?**
   - What we know: spec §8 says "typed or voice." Typed is easy (a new IPC frame or a parsed utterance).
   - What's unclear: the exact voice path.
   - Recommendation: add an additive `override` IPC frame for the typed/Face path; for voice, reuse the existing utterance→intent path and parse a literal "/override" / "override" command in the loop before brain dispatch (so the brain can't be tricked into "activating override" from external content). Confirm.

4. **How exactly to intercept Claude Code permission requests at the installed CLI version?**
   - What we know (verified): the agent-SDK permission model evaluates hooks → deny rules → mode → allow rules → `canUseTool`. `disallowedTools` scoped deny rules (`Bash(rm *)`) are enforced even under bypass and remove the action from Claude's reach. In **raw stream-json print mode**, `canUseTool`/`--permission-prompt-tool stdio` has a documented gap (no inbound `can_use_tool` control_request), and denials surface in the final result event's `permission_denials[]`.
   - What's unclear: the exact flag names/availability at the *installed* `claude` version on this machine (the shipped bridge uses `--permission-mode dontAsk --allowedTools Read --bare`).
   - Recommendation: use `disallowedTools` deny rules + `permission_denials` re-entry (robust, bypass-proof). Before planning the exact argv, run `claude --help` / check the installed version to confirm `--disallowedTools` (or `--disallowed-tools`) spelling. Treat the deny-rule list as the primary control and `permission_denials` re-entry as the escalation path. [CITED: code.claude.com agent-sdk/permissions; anthropics/claude-code#34046]

5. **GitHub backup remote setup.**
   - What we know: the kernel-memory repo is its own git repo with the pre-push hook source in `daemon/scripts/hooks/`; finance/ is gitignored.
   - What's unclear: the private remote URL + push auth are owner machine state, not in the repo.
   - Recommendation: document as owner manual steps — `git remote add origin <private repo>`, install an SSH deploy key with push access, and physically install the pre-push hook into `kernel-memory/.git/hooks/pre-push`. The backup job should refuse to push (fail loud) if no remote is configured or the hook is absent. Confirm.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | All daemon code | ✓ (shipped daemon runs) | 24.x LTS (CLAUDE.md pin) | — |
| `git` CLI | backup job + leakguard ls-files + pre-push hook | ✓ (leakguard.ts shells it) | system | — (hard requirement; backup fails loud if absent) |
| `claude` CLI | CC Red shim (SAFE-05) | likely ✓ (P4 bridge shipped) | confirm with `claude --help` | bridge is absent-tolerant (exit 127 → typed escalation) |
| launchd | scheduling the 3 maintenance jobs | ✓ (heartbeat plist shipped) | macOS native | — |
| private GitHub remote | backup push | ✗ (owner machine state, not configured in repo) | — | backup fails loud + escalates; consolidation/cleanup still run |
| pre-push hook installed in kernel-memory/.git/hooks/ | finance-leak layer (b) at push time | ✗ (source exists; install state unknown) | — | backup job refuses to push if hook absent (defense-in-depth) |

**Missing dependencies with no fallback:** none that block the *code* phase. The backup job is the only thing that needs owner-machine setup (remote + auth + hook install) — and it is designed to fail loud rather than leak.

**Missing dependencies with fallback:** the GitHub remote and the installed pre-push hook are owner setup steps; their absence makes the backup job escalate, it does not break consolidation/cleanup or the gate.

## Validation Architecture

> `workflow.nyquist_validation` is `true` in config.json — this section is REQUIRED. Test runner = `node:test` via `tsx --test "src/**/*.test.ts" "test/**/*.test.ts"`. **NEVER execute a real irreversible action in any test** — every Red path uses a mock executor, a fake clock, and an injected cancel signal.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `node:test` (built-in) run via `tsx --test` |
| Config file | none — globs in `package.json` `test` script |
| Quick run command | `cd daemon && npx tsx --test "src/safety/*.test.ts"` |
| Full suite command | `cd daemon && npm test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SAFE-03 | Red breaker flow: dry-run preview emitted, 10s cancel honored (fake clock), proceed on no-cancel | unit | `npx tsx --test src/safety/breaker.test.ts` | ❌ Wave 0 |
| SAFE-03 | Cancel during the 10s window aborts + audits, never executes (mock executor never called) | unit | same | ❌ Wave 0 |
| SAFE-03 | TOCTOU: state hash changes between preview and execute → abort + audit | unit | same | ❌ Wave 0 |
| SAFE-04 i | Credential fence denies even under active `/override` (overridable=false) | unit | `npx tsx --test src/safety/gate.test.ts` | ⚠️ extend shipped |
| SAFE-04 ii | `red && origin==='external'` denied even under active `/override` (test-injection email cannot trigger Red) | unit | same | ❌ Wave 0 |
| SAFE-04 iii | Atomic spend ceiling: two near-simultaneous reserves can't both pass; exceeding forces escalate | unit | `npx tsx --test src/safety/spend-ledger.test.ts` | ❌ Wave 0 |
| SAFE-02 | `/override` scope: Green full-speed, Yellow proceed+notify; Red unaffected; auto-expires | unit | `npx tsx --test src/safety/override.test.ts` | ❌ Wave 0 |
| SAFE-05 | CC argv carries `disallowedTools` Red deny rules; `permission_denials` map to a ToolCall that re-enters the gate (mock stream) | unit | `npx tsx --test src/tools/claude-code.test.ts` | ⚠️ extend shipped |
| SAFE-06 | Ladder: injected failures drive retry→replan→decompose→backoff→escalate-with-recommendation; Red gate skips to immediate escalate | unit | `npx tsx --test src/planner/ladder.test.ts` | ❌ Wave 0 |
| SAFE-07 | Flag OFF reproduces P1–P4 behavior (Red → deny); flag ON enables gated. Shipped gate/registry tests still pass unchanged | unit | `npm test` (regression) | ⚠️ verify shipped suite green |
| MEM-07 | Consolidation: logs in → reflections out; a run over ONLY external-sourced logs leaves knowledge/ + IDENTITY.md byte-identical | unit | `npx tsx --test src/memory/consolidate.test.ts` | ❌ Wave 0 |
| MAINT-01 | Backup: explicit `git add <paths>` only (assert argv never contains `-A`/`-f`); a staged fake finance file aborts (temp repo, no real remote) | unit | `npx tsx --test src/memory/backup.test.ts` | ❌ Wave 0 |
| MAINT-02 | changelog.md + metrics.md writers append correctly; never touch IDENTITY.md | unit | `npx tsx --test src/self/*.test.ts` | ❌ Wave 0 |
| MAINT-03 | The 3 plists parse as valid plist XML and reference `dist/index.js --<job>` (lint, not execution) | unit | `npx tsx --test test/launchd-jobs.test.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npx tsx --test src/safety/*.test.ts` (the safety core — fast, < 5s).
- **Per wave merge:** `npm test` (full suite — must be green).
- **Phase gate:** Full suite green before `/gsd-verify-work`, PLUS the documented manual owner checks below.

### Wave 0 Gaps
- [ ] `src/safety/breaker.test.ts` — covers SAFE-03 (fake clock, mock executor, injected cancel, ledger, audit, TOCTOU)
- [ ] `src/safety/override.test.ts` — covers SAFE-02 (scope allowlist/denylist, timeout/expiry, audit)
- [ ] `src/safety/spend-ledger.test.ts` — covers SAFE-04 iii (atomic check+reserve, no race, day reset)
- [ ] `src/planner/ladder.test.ts` — covers SAFE-06 (injected-failure ladder; Red skip-to-escalate)
- [ ] `src/memory/consolidate.test.ts` — covers MEM-07 (logs→reflections; external NOT promoted; IDENTITY untouched)
- [ ] `src/memory/backup.test.ts` — covers MAINT-01 (explicit-add argv; finance-abort; temp repo, no real remote/push)
- [ ] `src/self/changelog.test.ts` + `src/self/metrics.test.ts` — covers MAINT-02
- [ ] extend `src/safety/gate.test.ts` — add `/override`-active credential-fence-still-denies + external-Red-still-denies cases (SAFE-04 i/ii)
- [ ] extend `src/tools/claude-code.test.ts` — add disallowedTools-argv + permission_denials-re-entry cases (SAFE-05)
- [ ] shared test helper: a fake clock (`now()`/`sleep()`), a recording mock executor, a temp git repo factory, a controllable cancel signal
- [ ] `test/launchd-jobs.test.ts` — plist XML validity + correct `--<job>` argv (MAINT-03)

### Manual owner checks (documented, NOT automated — never run a real irreversible action)
- Load the 3 plists via `launchctl bootstrap gui/$(id -u) <plist>`; confirm a nightly consolidation/cleanup/backup actually fires.
- Configure the private GitHub remote + SSH deploy key; install the pre-push hook; confirm a real backup push succeeds and `git ls-files | grep -i finance` on the remote is empty.
- A single, owner-supervised live Claude Code session that proposes a Red action, confirming it routes to the breaker and does NOT auto-run.

## Security Domain

> `security_enforcement: true`, ASVS level 1, `security_block_on: high`. This phase IS the security phase.

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V1 Architecture | yes | Single chokepoint preserved; breaker is a kernel boundary, never per-tool |
| V2 Authentication | no | No new auth surface (GitHub push auth is owner machine state, not in-code) |
| V3 Session Management | yes | `/override` is a scoped, auto-expiring session capability with audit (not a global flag) |
| V4 Access Control | yes | Tier-based authorization; three never-overridable deny rules enforced in code above `/override` |
| V5 Input Validation | yes | zod validates every new IPC frame + ledger shape; `disallowedTools` deny rules sanitize CC's tool surface; brain Decision already zod-validated |
| V6 Cryptography | yes | `node:crypto` SHA-256 for TOCTOU content hash + audit; never hand-rolled; finance key stays in Keychain (unchanged) |
| V7 Error Handling/Logging | yes | Append-only audit log of every Red verdict; backup/consolidation fail loud; finance amounts NEVER logged |
| V12 Files/Resources | yes | Backup uses explicit `git add <paths>` (never `-A`/`-f`); consolidation never writes IDENTITY.md; quarantine never auto-promoted |

### Known Threat Patterns for this stack
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Indirect prompt injection → Red action | Tampering / Elevation | `origin==='external' && red` hard-block above `/override`; dual provenance taint (PITFALLS #1) |
| Memory poisoning via consolidation auto-promote | Tampering | Promote only `source:user`/`source:self`; never IDENTITY.md (PITFALLS #2) |
| Spend-ceiling race | Elevation | Atomic single-writer check+reserve (PITFALLS #6) |
| TOCTOU between preview and execute | Tampering | Re-hash + re-read state immediately before executing; abort on mismatch (PITFALLS #6) |
| CC sub-session ambient Red | Elevation | `disallowedTools` deny rules (bypass-proof) + `permission_denials` → gate re-entry (PITFALLS #6, SAFE-05) |
| Finance leak via backup | Information Disclosure | 4-layer stack: gitignore + pre-push hook + at-rest encryption + ls-files assertion; explicit-add (PITFALLS #3) |
| `/override` scope creep to master switch | Elevation | Scoped capability with explicit denylist; tests attempting to override each hard rule must fail (PITFALLS #7) |
| Confirmation fatigue → rubber-stamp | (human factor) | Red-only interrupts; high-context preview; cancel-window not approve-prompt (PITFALLS #6) |

## Sources

### Primary (HIGH confidence)
- KERNEL repo source, read this session (authoritative — this phase upgrades it): `daemon/src/safety/{gate,tiers,leakguard}.ts`, `tools/{registry,Tool,claude-code}.ts`, `brain/{BrainProvider,ClaudeCodeBrain}.ts`, `memory/{types,quarantine,log,inject,identity,retrieve}.ts`, `loop.ts`, `index.ts`, `ipc/{protocol,server}.ts`, `config.ts`, `settings.ts`, `finance/store.ts`, `daemon/package.json`, `daemon/scripts/hooks/kernel-memory-pre-push.sh`, `launchd/*.plist`, `kernel-memory/.gitignore`, `safety/README.md`, `CLAUDE.md`
- KERNEL spec `docs/KERNEL_MASTER_BUILD_PROMPT.md` §5/§8/§9/§13/§16 (read this session) — the safety model, tier table, obstacle ladder, CC Red gating, memory hygiene
- `.planning/ROADMAP.md` Phase 5, `.planning/REQUIREMENTS.md` SAFE/MAINT/MEM-07, `.planning/research/PITFALLS.md` (#1-7), `.planning/research/ARCHITECTURE.md` (gate-as-middleware, ladder control structure, CC re-submission shim) — read this session
- Anthropic agent-SDK permission docs — `disallowedTools` deny rules enforced under bypass, evaluation order, modes — https://code.claude.com/docs/en/agent-sdk/permissions (verified this session)

### Secondary (MEDIUM confidence)
- anthropics/claude-code issue #34046 — `can_use_tool` control_request gap in stdio/stream-json print mode — https://github.com/anthropics/claude-code/issues/34046 (informs Open Q4; the deny-rule path is the recommended workaround)

### Tertiary (LOW confidence)
- None relied upon. Every safety claim traces to the spec, the shipped code, or the official permission docs.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new packages; everything is shipped deps + Node built-ins, versions verified in package.json.
- Architecture: HIGH — the gated arm, additive IPC, and short-lived job mode are explicit, designed-in seams read directly from the code (gate.ts/registry.ts/index.ts comments literally describe the Phase 5 edit site).
- Pitfalls: HIGH — sourced from the project's own PITFALLS.md (#1-7) cross-referenced to the shipped code.
- CC Red gating (SAFE-05): HIGH on the mechanism (official docs), MEDIUM on the exact installed-CLI flag spelling (flagged Open Q4 — confirm with `claude --help` before planning argv).
- Discretionary details (ledger location, cancel default, audit format, schedule times, voice trigger, remote setup): flagged as Open Questions / Assumptions for discuss-phase.

**Research date:** 2026-06-22
**Valid until:** 2026-07-22 for the stable in-repo facts; ~2026-06-29 for the Claude Code CLI permission-flag specifics (fast-moving — re-confirm `claude --help` at plan time).
