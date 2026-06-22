# Phase 2: Hands (spec Phase 1) - Research

**Researched:** 2026-06-22
**Domain:** macOS GUI automation (Peekaboo MCP) + headful browser automation (Playwright) + a tool router behind a single `gate.authorize` chokepoint, inside an existing Node 24 / ESM / TypeScript daemon
**Confidence:** HIGH (versions verified against npm registry; MCP-client import paths verified by installing the pinned SDK; Peekaboo tool surface + permissions from the canonical openclaw/Peekaboo repo; Phase 1 module shapes read directly from the shipped code). MEDIUM on anti-bot realities and exact Peekaboo MCP argument schemas (those depend on the live server's `tools/list` and must be discovered at runtime, not assumed).

## Summary

Phase 2 gives the daemon the ability to ACT. Phase 1 left exactly one seam open for this: `loop.ts`'s `act` step is a documented no-op `if (decision.action) { /* P2+: router.dispatch */ }`, and `daemon/src/safety/README.md` reserves `gate.authorize()` as the single chokepoint between decide and act. Phase 2 fills both: a **tool router** (`tools/registry.ts`) that maps a `ToolCall.tool` name to a `Tool` implementation and dispatches it, and a **`gate.authorize(call)` chokepoint** (`safety/gate.ts` + `safety/tiers.ts`) that EVERY dispatch passes through. In Phase 2 the gate is a thin **tier-classifier only** — it labels a call Green/Yellow/Red and enforces the one hard rule whose physical capability lands in this phase (the credential fence) — but it does NOT yet run the circuit breaker, `/override`, dry-run, spend ceiling, or the 10s window (all of those are gated to Phase 5 per the owner hard-stop). The architecture must be shaped so Phase 5 only *enables behavior* inside `gate.authorize`, never reroutes dispatch.

Two real tools land: **Peekaboo** (driven over MCP via `@modelcontextprotocol/sdk` `Client` + `StdioClientTransport` spawning the Peekaboo MCP server — `see`/`image` capture, `click`, `type`, `press`/`hotkey`, `menu`, `list`) for GUI control including opening and driving Mail; and **Playwright** (headful `chromium.launchPersistentContext` against a DEDICATED profile dir, never the user's real Chrome) for navigate/scrape/fill/login with full URL + provenance logging on every navigation. The **credential-entry fence** lands in the Peekaboo `type` adapter (and the Playwright `fill` adapter) because the physical capability to type secrets lands here: before any keystrokes are synthesized, the tool inspects the target field (secure text field, labels matching password/card/cvv/ssn, sensitive `autocomplete` hints) and REFUSES, returning a structured escalation instead of typing.

The dominant testing reality is that real GUI/browser automation needs TCC grants (Screen Recording + Accessibility + Event-synthesizing) and live apps that cannot be exercised in CI. The plan must therefore split cleanly: **unit-testable** = router registration/dispatch, gate tier classification, credential-fence field detection, provenance logging, and Playwright against a `file://` fixture page; **documented manual owner check** = real Mail open via Peekaboo, a real site login via Playwright, and TCC-grant survival across rebuilds.

**Primary recommendation:** Build three modules in dependency order — (1) `tools/Tool.ts` + `tools/registry.ts` (the router); (2) `safety/tiers.ts` + `safety/gate.ts` (the classify-only chokepoint, wired so `registry.dispatch` cannot reach a tool without first calling `gate.authorize`); (3) the two real tool adapters `tools/peekaboo.ts` (MCP client) and `tools/browser.ts` (Playwright). Wire the router into `loop.ts`'s existing `act` seam. Keep Peekaboo MCP argument schemas discovered at runtime via `listTools()` rather than hardcoded. Everything that can be unit-tested against fixtures must be; everything requiring TCC + live GUI is a documented manual owner check.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| GUI capture / click / type / menu (Peekaboo) | API/Backend (daemon tool adapter) | OS (TCC-gated macOS automation) | The daemon owns the MCP client; the OS owns the actual event synthesis behind TCC grants. The daemon never embeds GUI logic — it speaks MCP to a spawned server. |
| Browser navigate / scrape / fill / login (Playwright) | API/Backend (daemon tool adapter) | Spawned child (Chromium) | Playwright driver runs in-process in the daemon; Chromium is a spawned child process. The daemon owns the persistent-profile lifecycle and egress logging. |
| Tool registry + dispatch | API/Backend (daemon) | — | Pure in-process orchestration; one map, one dispatch function. |
| Tier classification (`gate.authorize`) | API/Backend (daemon, `safety/`) | — | Centralized, context-derived. NEVER the tool's own job (Anti-Pattern: tools self-classifying). |
| Credential-entry fence | API/Backend (the type/fill tool adapter, enforced via the gate's hard-rule check) | — | Must be in CODE at the tool boundary, not in a prompt. The capability to type secrets is what lands in this phase, so the fence lands with it. |
| Provenance tagging of scraped/captured content | API/Backend (daemon) | — | External-sourced content (web/Mail) must be tagged `source: 'external'` at the READ site (the tool adapter), reusing the Phase 1 `ContextItem`/`Provenance` shape. |
| Permission detection / escalation when TCC not granted | API/Backend (daemon) | OS (TCC) | macOS has no status API for Screen Recording — probe-then-escalate: attempt the op, catch the failure, surface a structured "grant X in Settings" escalation. |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@modelcontextprotocol/sdk` | 4.4.3 — see note; **pinned 1.29.0** | MCP **client** to drive Peekaboo over stdio | Official MCP SDK. `Client` + `StdioClientTransport` spawn the Peekaboo MCP server and call `tools/list` / `tools/call`. Already pinned in STACK.md/CLAUDE.md. [VERIFIED: npm registry — `@modelcontextprotocol/sdk@1.29.0`; import paths verified by install] |
| `playwright` | 1.61.0 | Headful browser hands (navigate/scrape/fill/login) | Pinned. `chromium.launchPersistentContext(userDataDir, { headless:false })` for durable logins on a dedicated profile. [VERIFIED: npm registry — `playwright@1.61.0`] |
| `zod` | 4.4.3 | Validate tool args + the per-tool param schema + Peekaboo result shapes | Already in the daemon (Phase 1 uses it for `DecisionSchema`/`FrameSchema`). The `Tool` interface carries a zod schema per the focus requirement. [VERIFIED: present in `daemon/package.json`] |

> **Peekaboo package note (provenance):** The GUI capability is **Peekaboo**, canonical repo `github.com/openclaw/Peekaboo`. STACK.md/CLAUDE.md pin the install as `brew install steipete/tap/peekaboo` (a brew-installed binary + MCP server), which is the recommended path — it keeps the Swift-compiled automation toolkit out of the daemon's `node_modules`. The npm package `@steipete/peekaboo@3.5.2` also exists and ships a `peekaboo-mcp.js` bin, but it bundles compiled Swift binaries and a `postinstall` (`chmod +x …`) — prefer the brew binary and spawn it as the MCP server command. See Package Legitimacy Audit. [CITED: github.com/openclaw/Peekaboo] [VERIFIED: npm registry — `@steipete/peekaboo@3.5.2` exists, repo = openclaw/Peekaboo]

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `execa` | 9.x | Spawn helper subprocesses (e.g. `peekaboo permissions` probes; Playwright browser install at setup) | Optional in Phase 2 — `StdioClientTransport` already spawns the MCP server itself. Use `execa` only for permission-probe CLI calls if the MCP server doesn't expose them. STACK.md lists it; not yet installed. [CITED: STACK.md] |
| `pino` (`logger`) | 10.3.1 | Structured provenance + navigation logging | Already shipped (`daemon/src/memory/log.ts` exports `logger`). Every Playwright navigation logs `{ url, provenance, tool }` through it. [VERIFIED: present, `memory/log.ts`] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Peekaboo over MCP (`StdioClientTransport`) | Peekaboo CLI via `execa` | CLI is fine for manual testing but loses the structured `tools/list` schema + typed `callTool` result; MCP is the pinned integration path and keeps tier classification working over a stable contract. |
| `@steipete/peekaboo` npm package | brew `steipete/tap/peekaboo` binary | Brew binary avoids bundling compiled Swift + a postinstall in `node_modules`; STACK.md pins brew. Use the npm package only if brew install is unavailable on the target machine. |
| Playwright headful persistent context | Playwright headless + stealth plugins | Headless+stealth is explicitly FORBIDDEN by the spec (§8/§14, STACK.md "What NOT to Use") — brittle, invites login-grinding. Headful + warmed dedicated profile is the pinned approach. |
| Pointing `userDataDir` at real Chrome profile | Dedicated automation profile dir under app support | Real-profile automation is FORBIDDEN — recent Chrome policy breaks it (blank pages / browser exits) and it risks the user's real cookies/logins. Dedicated dir only. |

**Installation:**
```bash
cd daemon
npm install @modelcontextprotocol/sdk@1.29.0 playwright@1.61.0
npx playwright install chromium
# GUI hands (system-level, not npm) — owner action, requires Homebrew:
brew install steipete/tap/peekaboo
peekaboo permissions request-screen-recording
peekaboo permissions request-accessibility
peekaboo permissions request-event-synthesizing
```

**Version verification (run before locking the plan):**
```bash
npm view @modelcontextprotocol/sdk version   # → 1.29.0 (confirmed 2026-06-22)
npm view playwright version                  # → 1.61.0 (confirmed 2026-06-22)
```
Pin EXACTLY (no caret) to match the Phase 1 discipline — `npm install` injects `^`; strip it and re-resolve the lockfile, as Plan 01-01 did (see 01-01-SUMMARY Deviation #2).

**MCP client import paths (verified by installing `@modelcontextprotocol/sdk@1.29.0` and resolving the imports):**
```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
```
Both resolve under the package's `exports` map (`./client` + a `./*` wildcard); `Client` exposes `connect`, `listTools`, `callTool`, `close` (all verified as functions on the pinned build). [VERIFIED: installed 1.29.0 in a temp dir, imported, confirmed method types]

> NOTE: The MCP SDK's current `main`-branch client guide shows imports from a newer `@modelcontextprotocol/client` package. **Do NOT use that** — the project is pinned to `@modelcontextprotocol/sdk@1.29.0`, whose import paths are the `/sdk/client/...` subpaths above. [VERIFIED: pinned package install]

## Package Legitimacy Audit

> slopcheck 0.6.1 was installed and run against all three external packages on 2026-06-22.

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| `@modelcontextprotocol/sdk@1.29.0` | npm | mature, official | very high | github.com/modelcontextprotocol/typescript-sdk | [OK] | Approved [VERIFIED: npm registry] |
| `playwright@1.61.0` | npm | mature, Microsoft | very high | github.com/microsoft/playwright | [OK] | Approved [VERIFIED: npm registry] |
| `@steipete/peekaboo@3.5.2` | npm | published 2026-06-13 | ~717/wk | github.com/openclaw/Peekaboo | [OK] | Approved as the GUI tool; PREFER the brew binary over the npm package (postinstall + bundled Swift binaries). [VERIFIED: npm registry; repo confirmed] |

**Packages removed due to slopcheck [SLOP] verdict:** none.
**Packages flagged as suspicious [SUS]:** none by slopcheck. **Manual flag:** `@steipete/peekaboo` carries a `postinstall: chmod +x peekaboo peekaboo-mcp.js` — benign (no network, no out-of-tree paths), but it ships compiled Swift binaries. The planner should keep Peekaboo as a **brew-installed system binary spawned by the MCP transport**, NOT an npm dependency of the daemon, so no postinstall runs in `node_modules`. If the npm package is used as a fallback, gate its install behind a `checkpoint:human-verify` task.

*slopcheck ran `npm install` into its own sandbox; verified no side effects on `daemon/package.json`, `daemon/package-lock.json`, or `daemon/node_modules`.*

## Architecture Patterns

### System Architecture Diagram

```
   loop.ts (Phase 1, event-driven serial runner)
       │  decide: brain.reason() → Decision{ thought, action?: ToolCall, reply? }
       ▼
   ┌─────────────────────────────────────────────────────────────────┐
   │  act step (the Phase-1 seam, now filled):                         │
   │    if (decision.action) result = await router.dispatch(action)    │
   └───────────────────────────────┬───────────────────────────────────┘
                                   │ ToolCall
                                   ▼
   ┌─────────────────────────────────────────────────────────────────┐
   │  tools/registry.ts  —  dispatch(call: ToolCall)                   │
   │    1. look up tool by name (default-deny if unknown)              │
   │    ────────────────────────────────────────────────────────────  │
   │    2. verdict = await gate.authorize(call)   ◀── THE CHOKEPOINT   │
   │         (NO tool runs before this returns)                       │
   │    3. if verdict.kind === 'deny'   → return escalation (no run)   │
   │       if verdict.kind === 'allow'  → validate args, tool.execute  │
   │       (P2: 'gated' is classified-only — recorded, then allowed;   │
   │        P5 turns 'gated' into the real breaker. Same return shape.)│
   └───────────────────────────────┬───────────────────────────────────┘
            │                       │                       │
            ▼                       ▼                       ▼
   safety/gate.ts            tools/peekaboo.ts        tools/browser.ts
   (classify + hard-rule)    (MCP Client over          (Playwright headful
        │                     StdioClientTransport)      launchPersistentContext)
        ▼                          │                          │
   safety/tiers.ts                 ▼                          ▼
   (ToolCall → green|             Peekaboo MCP server   Chromium (dedicated
    yellow|red label)            (spawned child)         profile dir)
                                  │  see/click/type/      │ navigate/scrape/
                                  │  press/menu/list      │ fill/login
                                  ▼                       ▼  + URL+provenance log
                            macOS GUI (TCC:           web (egress logged)
                            ScreenRec+Access+EventSyn)
```

The diagram shows the call path from a `Decision.action` through the router, through the mandatory `gate.authorize` chokepoint, to exactly one tool. File-to-responsibility mapping is in Component Responsibilities below.

### Recommended Project Structure

Matches ARCHITECTURE.md's planned `tools/` and `safety/` layout (the directories the spec implies). All new files are under `daemon/src/`:

```
daemon/src/
├── tools/
│   ├── Tool.ts            # Tool interface + ToolResult type (registry contract)
│   ├── registry.ts        # name→Tool map; register(); dispatch() — calls gate.authorize FIRST
│   ├── peekaboo.ts        # MCP client adapter (StdioClientTransport → Peekaboo server)
│   ├── browser.ts         # Playwright headful adapter (persistent dedicated profile)
│   └── *.test.ts          # unit tests (router dispatch, fence, fixture-page browser)
├── safety/
│   ├── tiers.ts           # classifyTier(call): 'green'|'yellow'|'red' (+ the credential-fence detector)
│   ├── gate.ts            # gate.authorize(call): Verdict — the SINGLE chokepoint (classify-only in P2)
│   └── *.test.ts          # unit tests (classification matrix, hard-rule refusal)
└── loop.ts                # MODIFIED: act step calls router.dispatch(decision.action)
```

`daemon/src/safety/README.md` already documents this exact split (gate.authorize in Phase 2, full tiered breaker in Phase 5) — the plan should replace the README seam with real code, keeping the README's contract.

### Pattern 1: Tool interface + registry dispatch

**What:** A `Tool` is `{ name, schema (zod), execute(args) }`. The registry is a `Map<string, Tool>` with `register(tool)` and `dispatch(call)`. `dispatch` is the ONLY public entry; it looks up the tool, calls `gate.authorize(call)` BEFORE anything else, validates args against the tool's zod schema, then calls `execute`.
**When to use:** Every tool invocation. The loop's `act` step calls `router.dispatch`, never a tool directly.
**Example:**
```ts
// tools/Tool.ts — the registry contract. ToolCall already exists in brain/BrainProvider.ts.
import type { ZodType } from 'zod';
import type { ToolCall } from '../brain/BrainProvider.js';

export interface ToolResult {
  ok: boolean;
  /** Structured output for the loop/log (scraped data, capture path, etc.). */
  data?: unknown;
  /** Set when ok=false: a structured escalation (e.g. permission missing, credential fence). */
  escalation?: { reason: string; recommendation?: string };
}

export interface Tool {
  /** Stable name the brain references in ToolCall.tool. */
  name: string;
  /** zod schema validating ToolCall.args before execute (focus requirement). */
  schema: ZodType;
  /** Run the action. NEVER called by anyone but registry.dispatch (after the gate). */
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}
```
```ts
// tools/registry.ts — dispatch is the choke; gate.authorize runs FIRST, always.
import { authorize } from '../safety/gate.js';
import type { ToolCall } from '../brain/BrainProvider.js';
import type { Tool, ToolResult } from './Tool.js';

const registry = new Map<string, Tool>();
export function register(tool: Tool): void { registry.set(tool.name, tool); }

export async function dispatch(call: ToolCall): Promise<ToolResult> {
  const tool = registry.get(call.tool);
  if (!tool) return { ok: false, escalation: { reason: `unknown tool: ${call.tool}` } }; // default-deny
  const verdict = await authorize(call);            // ◀── THE single chokepoint, before any execute
  if (verdict.kind === 'deny') return { ok: false, escalation: verdict.escalation };
  // P2: 'allow' and 'gated' both proceed (gated is classified+recorded only; P5 adds the breaker).
  const parsed = tool.schema.safeParse(call.args);
  if (!parsed.success) return { ok: false, escalation: { reason: 'invalid tool args: ' + parsed.error.message } };
  return tool.execute(call.args);
}
```

### Pattern 2: `gate.authorize` as the classify-only chokepoint (Phase 2 shape, Phase 5-ready)

**What:** `gate.authorize(call)` returns a `Verdict`. In Phase 2 it (a) classifies the tier via `tiers.ts`, (b) enforces the ONE hard rule whose capability lands now — the credential fence — returning `deny` with an escalation, and (c) records the tier (logs it). It does NOT run the breaker, `/override`, dry-run, or spend ceiling. The Verdict shape is designed so Phase 5 fills in `gated` behavior WITHOUT changing the router or any tool.
**When to use:** Every dispatch. There is no other path to a tool.
**Example:**
```ts
// safety/gate.ts — Phase 2: classify + the credential hard-rule. Phase 5 enables 'gated' behavior here.
import { classifyTier, detectCredentialField } from './tiers.js';
import { logger } from '../memory/log.js';
import type { ToolCall } from '../brain/BrainProvider.js';

export type Verdict =
  | { kind: 'allow'; tier: 'green' | 'yellow' }
  | { kind: 'gated'; tier: 'red' }                                  // P2: recorded, proceeds. P5: real breaker.
  | { kind: 'deny'; tier: 'red' | 'yellow'; escalation: { reason: string; recommendation?: string } };

export async function authorize(call: ToolCall): Promise<Verdict> {
  // HARD RULE (capability lands this phase): never type credentials. Non-overridable, code-level.
  const cred = detectCredentialField(call);
  if (cred.isSecret) {
    logger.warn({ tool: call.tool, reason: cred.reason }, 'gate: credential fence — refused');
    return { kind: 'deny', tier: 'red',
      escalation: { reason: `refusing to type into a secure/credential field (${cred.reason})`,
                    recommendation: 'Pravin enters this credential manually.' } };
  }
  const tier = classifyTier(call);
  logger.info({ tool: call.tool, tier }, 'gate: classified');
  if (tier === 'red') return { kind: 'deny', tier, escalation: { reason: 'red-tier requires Phase 5 breaker' } };  // P2 LOCKED: Red = deny + escalate (no Red autonomy pre-P5); P5 flips this branch to { kind: 'gated' } where the breaker hooks in
  return { kind: 'allow', tier };
}
```
**Key property:** A tool NEVER self-classifies. Tier is derived centrally from `call.tool` + `call.args` + provenance. Phase 5's change is entirely inside `authorize` (turn `gated` into dry-run→cancel→ceiling→audit) — the router, the tools, and the loop are untouched.

### Pattern 3: MCP client adapter (Peekaboo) with runtime tool discovery

**What:** `tools/peekaboo.ts` lazily spawns the Peekaboo MCP server via `StdioClientTransport`, connects a `Client`, and exposes high-level operations (capture, click, type, menu) that map to `client.callTool({ name, arguments })`. Discover the live tool surface with `listTools()` rather than hardcoding argument schemas — the exact Peekaboo MCP arg names must come from the running server, not from training data.
**When to use:** All GUI control. One persistent client connection reused across calls (don't respawn per call).
**Example:**
```ts
// tools/peekaboo.ts — MCP client over stdio. Import paths verified against the pinned 1.29.0 SDK.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let client: Client | null = null;
async function connect(): Promise<Client> {
  if (client) return client;
  const transport = new StdioClientTransport({
    command: 'peekaboo',           // brew-installed binary; or 'peekaboo-mcp' / node peekaboo-mcp.js
    args: ['mcp'],                 // confirm the exact MCP subcommand against the installed binary
  });
  const c = new Client({ name: 'kernel', version: '0.1.0' });
  await c.connect(transport);
  client = c;
  return c;
}

// Discover, don't assume: the real arg schemas come from the live server.
export async function discover() { return (await connect()).listTools(); }

export async function callPeekaboo(name: string, args: Record<string, unknown>) {
  const c = await connect();
  return c.callTool({ name, arguments: args }); // result.content carries the tool output
}
```

### Pattern 4: Playwright headful, dedicated persistent profile, navigation provenance logging

**What:** `tools/browser.ts` opens ONE headful Chromium via `launchPersistentContext(dedicatedDir, { headless:false })`, where `dedicatedDir` is under `~/Library/Application Support/Kernel/browser-profile/` (NEVER the user's real Chrome). Every `page.goto` logs `{ url, provenance, tool:'browser' }`. Locators use `getByRole`/`getByLabel`/text, not brittle CSS (resists site redesigns, per Pitfall 15). Scraped page content is tagged `source:'external'` (reuse `ContextItem`).
**When to use:** Login, scrape, form-fill. Serialize against heavy GUI ops (16GB ceiling).
**Example:**
```ts
// tools/browser.ts — headful, dedicated profile, every navigation logged with full URL + provenance.
import { chromium, type BrowserContext } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import { logger } from '../memory/log.js';

const PROFILE_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Kernel', 'browser-profile');

let ctx: BrowserContext | null = null;
async function context(): Promise<BrowserContext> {
  if (ctx) return ctx;
  ctx = await chromium.launchPersistentContext(PROFILE_DIR, { headless: false }); // dedicated dir, NOT real Chrome
  return ctx;
}

export async function navigate(url: string, provenance: 'user' | 'self' | 'external') {
  const page = (await context()).pages()[0] ?? (await (await context()).newPage());
  logger.info({ tool: 'browser', url, provenance }, 'browser: navigate'); // full URL + provenance, every time
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return page;
}
// fill() runs the same credential fence as the Peekaboo type tool (see Pattern 5) before typing.
```

### Pattern 5: The credential-entry fence (lands here with the capability to type)

**What:** Before ANY keystrokes are synthesized (Peekaboo `type` or Playwright `fill`), classify the target field. Refuse and escalate if it is: a secure text field, a field whose label/name/placeholder matches `password|passwd|pwd|card|cvv|cvc|ssn|social security|pin|security code`, or one with a sensitive `autocomplete` hint (`current-password|new-password|cc-number|cc-csc`). The fence lives in `tiers.ts` (`detectCredentialField`) and is enforced by `gate.authorize` (Pattern 2) — in CODE at the tool boundary, never in a prompt (Pitfall 4).
**When to use:** Every type/fill call. This is a HARD, non-overridable rule (§8) — Phase 5 will assert it survives `/override`.
**Example:**
```ts
// safety/tiers.ts — the detector. Tunable matchers; the principle is "refuse-by-default on any secret signal".
const SECRET_LABEL = /\b(pass\s?word|passwd|pwd|card\s?(number)?|cvv|cvc|csc|ssn|social\s?security|pin|security\s?code)\b/i;
const SECRET_AUTOCOMPLETE = /(current-password|new-password|cc-number|cc-csc|cc-exp|one-time-code)/i;

export function detectCredentialField(call: { tool: string; args: Record<string, unknown> }):
  { isSecret: boolean; reason: string } {
  if (call.tool !== 'peekaboo' && call.tool !== 'browser') return { isSecret: false, reason: '' };
  const op = String(call.args.op ?? '');
  if (!/^(type|fill)$/i.test(op)) return { isSecret: false, reason: '' };
  // Signals the adapter MUST surface into args at the read site (from AX tree / DOM attrs):
  if (call.args.isSecureField === true) return { isSecret: true, reason: 'secure text field' };
  const label = String(call.args.fieldLabel ?? call.args.fieldName ?? call.args.placeholder ?? '');
  if (SECRET_LABEL.test(label)) return { isSecret: true, reason: `field label matched: "${label}"` };
  const ac = String(call.args.autocomplete ?? '');
  if (SECRET_AUTOCOMPLETE.test(ac)) return { isSecret: true, reason: `autocomplete hint: "${ac}"` };
  return { isSecret: false, reason: '' };
}
```
> The adapter is responsible for POPULATING `isSecureField` / `fieldLabel` / `autocomplete` from the AX tree (Peekaboo) or DOM (`page.getAttribute('type'|'autocomplete'|'name')`, Playwright) at the read site — the fence can only classify what the adapter surfaces. The plan must make surfacing these signals a tool-adapter responsibility, with a unit test that a labelled-password target is refused.

### Anti-Patterns to Avoid

- **Tools self-classifying their tier or calling tools directly:** A tool must never decide "I'm Green" or be invoked outside `registry.dispatch`. Tier is decided centrally; dispatch is the only entry. (ARCHITECTURE.md Anti-Pattern 3.)
- **Hardcoding Peekaboo MCP argument schemas from memory:** Discover via `listTools()` at runtime; the live server's schema is the source of truth. Hardcoding invites silent breakage on a Peekaboo update (Pitfall 15).
- **Coordinate-based clicking as the default:** Prefer Peekaboo element-ID/query targeting and Playwright `getByRole`/text. Coordinates drift on UI change → confused-deputy misclicks. Verify-after-act before proceeding.
- **Building the breaker / `/override` / spend ceiling now:** Phase 5 only. Pre-P5 builds must have NO reachable code path that enables money/irreversible autonomy (Pitfall 7). `gate.authorize` is classify-only in Phase 2.
- **Pointing Playwright at the real Chrome profile or using headless+stealth:** Both forbidden (STACK.md). Dedicated profile, headful, no stealth.
- **Respawning the MCP client per call:** Keep one connected `Client`; respawning per dispatch is slow and leaks child processes.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| GUI capture / click / type / menu / AX-tree | A custom CGEvent/Accessibility-API automation layer | Peekaboo (MCP) | Peekaboo already solves event synthesis, AX-tree mapping, menu navigation, Spaces, and TCC interaction — a deep macOS rabbit hole. [CITED: github.com/openclaw/Peekaboo] |
| MCP stdio framing / JSON-RPC handshake | A custom stdio JSON-RPC client | `@modelcontextprotocol/sdk` `Client` + `StdioClientTransport` | The SDK owns the handshake, capability negotiation, pagination (`listTools` cursor), and result content shape. [VERIFIED: SDK install] |
| Browser automation / driver protocol | A custom CDP client | Playwright | Playwright owns the CDP protocol, auto-waiting, locators, persistent contexts, and download/dialog handling. |
| Secure-field detection from scratch | Ad-hoc string `.includes('password')` scattered in adapters | One `detectCredentialField` in `tiers.ts`, fed by adapter-surfaced AX/DOM signals | Centralizes the hard rule so there is one audit point and one test target; scattered checks miss cases (Pitfall 4). |
| Provenance/taint plumbing | A new tagging scheme | Reuse Phase 1 `Provenance`/`ContextItem` (`memory/types.ts`) | The taint shape already exists and the loop already carries it; reusing it keeps the external→Red interlock buildable in Phase 5. |

**Key insight:** Phase 2 is integration, not invention. Every hard problem (GUI events, MCP framing, browser protocol) has a pinned library; the daemon's job is to wire them behind ONE router and ONE gate, and to surface the field/provenance signals those libraries expose so the safety classifier can do its job.

## Runtime State Inventory

> This phase is additive (new tools + a gate), not a rename/refactor. No stored strings are being renamed. The relevant "runtime state" is the new external state the tools create on disk and the OS-level grants they require.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | The Playwright dedicated profile dir `~/Library/Application Support/Kernel/browser-profile/` (cookies, history, logins) will be created at first browser use. It is NOT in the kernel-memory repo and must NEVER be committed or backed up (it holds live session cookies). | Plan: create under app-support, document it, and confirm it is outside `kernel-memory/` so the GitHub backup never touches it. |
| Live service config | Peekaboo runs as a brew-installed binary spawned per daemon run; its own config (if any) lives outside git. No KERNEL state is registered into Peekaboo. | None — Peekaboo is stateless from KERNEL's side; the daemon spawns it fresh. |
| OS-registered state | macOS TCC grants: **Screen Recording**, **Accessibility**, **Event-synthesizing** — bound to the binary's code signature + path. These are NOT in git and must be granted by the owner. | Owner action (documented manual check). Grants attach to the *binary that synthesizes events* (Peekaboo / the daemon's launcher), not to shared `node` (Pitfall 9). |
| Secrets/env vars | No new secrets in Phase 2. (`ANTHROPIC_API_KEY` stays unused until Phase 3.) Browser logins are session cookies in the profile dir, not env vars. | None. |
| Build artifacts | New `node_modules` entries (`@modelcontextprotocol/sdk`, `playwright`) + the downloaded Chromium browser (`npx playwright install chromium`, ~hundreds of MB, outside the repo). | Plan: `npx playwright install chromium` is a setup step; Chromium binary is gitignored-by-location (not in repo). Pin deps exactly, re-resolve lockfile. |

## Common Pitfalls

### Pitfall 1: The credential-entry trap (the agent types a secret)
**What goes wrong:** A login/payment form looks like a blocker the obstacle ladder should "push through," so the type tool enters Pravin's password/card/SSN — into a real field or a phishing field.
**Why it happens:** GUI automation can physically type anywhere; "be helpful and unblock" collides with "never enter credentials."
**How to avoid:** The `detectCredentialField` fence in `gate.authorize` refuses BEFORE keystrokes, returning an escalation. The adapter must surface `isSecureField`/`fieldLabel`/`autocomplete` from AX/DOM at the read site. This sits ABOVE the obstacle ladder (immediate escalate). [CITED: PITFALLS.md Pitfall 4]
**Warning signs:** The type tool has no field classification; the escalation path is reachable only AFTER a type attempt.

### Pitfall 2: Tools self-classifying / a path that bypasses the gate
**What goes wrong:** A tool runs without `gate.authorize`, or declares its own tier.
**Why it happens:** It's easy to call `tool.execute` directly from the loop or another tool.
**How to avoid:** `registry.dispatch` is the ONLY public entry and it calls `authorize` first; `Tool.execute` is documented "never called by anyone but dispatch." Add a unit test that dispatch refuses an unknown tool (default-deny) and that a stubbed tool's `execute` is never reached when the gate denies. [CITED: ARCHITECTURE.md Anti-Pattern 3, HANDS-05]
**Warning signs:** Any `import` of a tool's `execute` outside `registry.ts`; a tier value originating in a tool.

### Pitfall 3: macOS TCC permission instability (#1 platform time-sink)
**What goes wrong:** Clicks/captures that worked yesterday silently fail after a rebuild because TCC grants are bound to a code signature/path that changed; or Accessibility gets granted to shared `node`, over-privileging every script.
**Why it happens:** TCC has no status API for Screen Recording; ad-hoc/unsigned identities rotate on rebuild; launchd-spawned helpers don't inherit grants normally.
**How to avoid:** Grant to the Peekaboo binary (stable brew path) / a stable signed launcher, NOT shared `node`. Probe-then-escalate: attempt the op, catch failure, return a structured "grant X in Settings" escalation (don't crash). Keep a `tccutil reset` runbook. [CITED: PITFALLS.md Pitfall 9]
**Warning signs:** A `node` entry under Accessibility; captures fail with no prompt; works from terminal but not under launchd.

### Pitfall 4: Integration drift — Peekaboo/Playwright break under app/site change
**What goes wrong:** GUI coordinates drift on an app update (misclick on the wrong element); DOM CSS selectors break on a site redesign; the agent silently does the wrong thing instead of failing loud.
**Why it happens:** Coordinate/CSS targeting is appearance-coupled.
**How to avoid:** Prefer Peekaboo element-ID/query + AX-tree targeting and Playwright `getByRole`/`getByLabel`/text. Verify-after-act: confirm the post-action state matches intent before proceeding; on mismatch, escalate (the Phase-5 ladder will replan). Discover Peekaboo's tool schema at runtime. [CITED: PITFALLS.md Pitfall 15]
**Warning signs:** Hardcoded pixel coords; brittle CSS; no post-action verification.

### Pitfall 5: Browser exfil / unlogged navigation
**What goes wrong:** Private data leaks via a navigation to an attacker URL, or a navigation isn't logged so there's no audit trail.
**Why it happens:** The browser tool will fetch any URL the brain produces.
**How to avoid:** Log EVERY `page.goto` with full URL + provenance (HANDS-03 acceptance). Tag scraped content `source:'external'`. (Full egress allowlist + outbound finance scan are later phases, but the logging seam lands here.) [CITED: PITFALLS.md Pitfall 5]
**Warning signs:** A navigation with no log line; scraped content not tagged external.

### Pitfall 6: 16GB RAM contention (Chromium + GUI + future model)
**What goes wrong:** Headful Chromium (hundreds of MB) plus future Ollama plus the SwiftUI app contend on 16GB.
**Why it happens:** Each component fits alone; together they don't.
**How to avoid:** Serialize heavy tools (the serial loop already does one intent at a time). Close/reuse the single browser context rather than spawning many. Don't pin a model resident (a Phase 3 concern, noted for awareness). [CITED: PITFALLS.md Pitfall 8]
**Warning signs:** Multiple browser contexts; memory pressure during a browser task.

## Code Examples

### Wiring the router into the existing loop `act` seam
```ts
// loop.ts — fill the documented Phase-1 seam (currently an empty if-block).
// BEFORE (Phase 1):
//   if (decision.action) { /* P2+: router.dispatch(decision.action) — gated */ }
// AFTER (Phase 2):
import { dispatch } from './tools/registry.js';
// ...inside drain(), the act step:
if (decision.action) {
  const result = await dispatch(decision.action);   // dispatch runs gate.authorize internally
  // surface a tool failure/escalation back to the originator like a reply
  if (!result.ok && result.escalation && intent.reply) {
    intent.reply(`Blocked: ${result.escalation.reason}` +
      (result.escalation.recommendation ? ` — ${result.escalation.recommendation}` : ''));
  }
}
```
[Source: derived from `daemon/src/loop.ts` lines 96–98, the documented P2 seam]

### Peekaboo: open and drive Mail (HANDS-02) — conceptual sequence
```ts
// All calls go THROUGH the router/gate in production; shown here as the adapter sequence.
// 1. open/focus Mail:        callPeekaboo('list', { type: 'apps' })  → find Mail, then a launch/focus op
// 2. capture + annotate:     callPeekaboo('see', { app: 'Mail' })    → element IDs for the AX tree
// 3. click compose / a row:  callPeekaboo('click', { on: '<elementId>' })
// 4. type (FENCED):          dispatch({ tool:'peekaboo', args:{ op:'type', text:'...', fieldLabel:'To' } })
//    — the gate's detectCredentialField passes 'To' (not secret) and allows; a 'password' label is refused.
// Exact arg names: discover at runtime via listTools() — do not assume.
```
[Source: Peekaboo tool surface from openclaw/Peekaboo — `see`/`list`/`click`/`type`/`menu`]

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `@modelcontextprotocol/client` (newer split package shown on SDK main branch) | `@modelcontextprotocol/sdk@1.x` subpath imports (`/sdk/client/index.js`, `/sdk/client/stdio.js`) | 1.x is "recommended for production" per SDK docs | Use the pinned 1.29.0 subpaths; ignore the `@modelcontextprotocol/client` examples for this project. |
| Headless + stealth plugins for automation | Headful + warmed dedicated persistent profile | Ongoing (Chrome anti-automation policy) | Stealth is brittle and forbidden here; headful is the pinned, honest approach. |
| Coordinate clicks | AX-tree / role+label targeting + verify-after-act | Mature best practice | Resists UI drift; the spec's reliability requirement. |

**Deprecated/outdated:**
- Pointing Playwright `userDataDir` at the real Chrome "User Data" dir: broken by Chrome policy (blank pages / exits). Use a dedicated dir.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Peekaboo's MCP server is started via `peekaboo mcp` (subcommand) when invoked as the brew binary | Standard Stack / Pattern 3 | LOW — the exact MCP launch invocation must be confirmed against the installed binary (`peekaboo --help` / `peekaboo-mcp`). Mitigated by discovering at runtime and documenting the command as a setup check. |
| A2 | Exact Peekaboo MCP tool argument schemas (e.g., the precise param names for `type`/`click`) | Pattern 3, Code Examples | LOW — explicitly handled by `listTools()` runtime discovery; the plan must NOT hardcode these. The high-level tool NAMES (`see`/`image`/`click`/`type`/`press`/`hotkey`/`menu`/`list`) are confirmed from the repo. |
| A3 | The credential-fence regexes (label/autocomplete matchers) are sufficient coverage | Pattern 5 | MEDIUM — refuse-by-default on any secret signal is conservative; missing a label pattern is the failure mode. The plan should make the matcher list a reviewed, extensible constant and add tests; Phase 5 hardens it as non-overridable. |
| A4 | Peekaboo can open and drive Mail end-to-end on the target machine | Summary, HANDS-02 | MEDIUM — depends on live TCC grants + Mail UI; this is a documented MANUAL owner check, not automatable in CI (see Validation Architecture). |
| A5 | A `gated` (Red, classify-only) verdict should PROCEED in Phase 2 | Pattern 2 | MEDIUM — Phase 2 is Green/Yellow-only work in practice (capture/click/draft/scrape); a Red-classified call proceeding-but-logged is acceptable ONLY because `/override` and money/irreversible paths are not yet reachable. If the planner prefers, Red can instead `deny`+escalate in P2 (stricter); either is Phase-5-compatible. Flag for the planner to choose. |

## Open Questions

1. **Should a Red-tier classification in Phase 2 proceed-and-log, or deny-and-escalate?**
   - What we know: Phase 2 must NOT build the breaker/override (Phase 5). The architecture must let Phase 5 enable behavior without rerouting. Both `gated→proceed+log` and `gated→deny+escalate` satisfy that.
   - What's unclear: Which is the intended Phase-2 behavior for a Red label, given there should be little/no genuinely-Red work in this phase anyway.
   - Recommendation: Default to `deny + escalate` for Red in Phase 2 (safer; matches "no Red autonomy before Phase 5") and document that Phase 5 replaces the deny with the real breaker. The credential fence is always a hard `deny` regardless.

2. **Exact Peekaboo MCP launch command and per-tool arg schemas.**
   - What we know: It's an MCP server over stdio; tool names are `see`/`image`/`click`/`type`/`press`/`hotkey`/`menu`/`menubar`/`list`.
   - What's unclear: The precise launch subcommand and argument key names per tool on the installed version.
   - Recommendation: A setup task runs `peekaboo --help` and a one-shot `listTools()` to capture the live schema; the adapter validates against discovered schemas. Treat as a documented setup/manual check.

3. **Does the Peekaboo `type` tool expose secure-field info, or must the adapter derive it?**
   - What we know: The repo docs do NOT describe built-in password-field detection in `type`.
   - What's unclear: Whether the AX tree returned by `see` flags secure text fields directly.
   - Recommendation: Assume KERNEL must derive it from the AX-tree element role/attributes returned by `see`; the adapter surfaces `isSecureField`/`fieldLabel` into the ToolCall args so the fence can classify. Verify against a real secure field as a manual check.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `@modelcontextprotocol/sdk` | Peekaboo MCP client | ✓ (npm) | 1.29.0 | none needed |
| `playwright` | browser tool | ✓ (npm) | 1.61.0 | none needed |
| Chromium browser binary | Playwright | ✗ until `npx playwright install chromium` | — | install at setup (documented) |
| Peekaboo binary | GUI tool | ✗ (system, not verified on this machine) | — (brew) | brew install; if unavailable, npm `@steipete/peekaboo` (gated checkpoint) |
| macOS TCC: Screen Recording | Peekaboo capture | ✗ unverified | — | none — owner must grant (manual) |
| macOS TCC: Accessibility | Peekaboo interaction | ✗ unverified | — | none — owner must grant (manual) |
| macOS TCC: Event-synthesizing | Peekaboo keyboard/mouse | ✗ unverified | — | none — owner must grant (manual) |

**Missing dependencies with no fallback (block live GUI execution, not unit tests):**
- Peekaboo binary + the three TCC grants. These block the live Mail/GUI manual checks but do NOT block the unit-testable router/gate/fence/fixture-browser work.

**Missing dependencies with fallback:**
- Chromium browser: `npx playwright install chromium` (setup step).
- Peekaboo install: brew (preferred) or npm package (gated checkpoint).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `node:test` run via `tsx` (no external test framework) — established in Phase 1 |
| Config file | none — `package.json` `"test": "tsx --test \"src/**/*.test.ts\" \"test/**/*.test.ts\""` |
| Quick run command | `cd daemon && npx tsx --test src/tools/registry.test.ts src/safety/gate.test.ts` |
| Full suite command | `cd daemon && npm test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| HANDS-04 | Router registers tools and dispatches to them; unknown tool → default-deny | unit | `npx tsx --test src/tools/registry.test.ts` | ❌ Wave 0 |
| HANDS-05 | Every dispatch routes through `gate.authorize`; a denied call never reaches `execute`; no tool self-classifies | unit | `npx tsx --test src/tools/registry.test.ts src/safety/gate.test.ts` | ❌ Wave 0 |
| HANDS-05 (fence) | Type/fill into a secure/labelled-password field is REFUSED with an escalation; a normal field (e.g. "To") is allowed | unit | `npx tsx --test src/safety/tiers.test.ts` | ❌ Wave 0 |
| SAFE-01 (seed) | `classifyTier` labels a representative matrix of calls green/yellow/red | unit | `npx tsx --test src/safety/tiers.test.ts` | ❌ Wave 0 |
| HANDS-03 | Playwright navigate/scrape/fill against a `file://` fixture page; every navigation logs full URL + provenance; scraped content tagged external | unit (fixture) | `npx tsx --test src/tools/browser.test.ts` | ❌ Wave 0 |
| HANDS-03 (profile) | Browser uses the dedicated profile dir, never the real Chrome path | unit | `npx tsx --test src/tools/browser.test.ts` | ❌ Wave 0 |
| HANDS-01 | Peekaboo adapter constructs the MCP client + transport and maps high-level ops to `callTool` (transport mocked) | unit (mock transport) | `npx tsx --test src/tools/peekaboo.test.ts` | ❌ Wave 0 |
| HANDS-01/02 | Peekaboo captures/clicks/types and opens+drives real Mail | **MANUAL** | owner check (TCC + live Mail) | n/a — manual |
| HANDS-03 | Real site login + scrape + form-fill end-to-end | **MANUAL** | owner check (live site) | n/a — manual |

### Sampling Rate
- **Per task commit:** the quick run for the module touched (e.g. `src/safety/*.test.ts`).
- **Per wave merge:** `cd daemon && npm test` (full suite — Phase 1's 46 tests must stay green).
- **Phase gate:** full suite green + the documented manual owner checks performed (Mail open, site login, TCC survival).

### Wave 0 Gaps
- [ ] `src/tools/Tool.ts` — the `Tool`/`ToolResult` contract (no test; it's types).
- [ ] `src/tools/registry.test.ts` — covers HANDS-04, HANDS-05 (dispatch, default-deny, gate-runs-first, execute-not-reached-on-deny).
- [ ] `src/safety/tiers.test.ts` — covers SAFE-01 seed + the credential fence (HANDS-05).
- [ ] `src/safety/gate.test.ts` — covers HANDS-05 (authorize returns the right Verdict; credential deny).
- [ ] `src/tools/browser.test.ts` — covers HANDS-03 against a local `file://` fixture (a tiny HTML form with a labelled password field + a normal field); asserts the fence refuses the password field and the profile dir is the dedicated path.
- [ ] `src/tools/peekaboo.test.ts` — covers HANDS-01 with a MOCKED transport (no real MCP server / TCC); asserts op→callTool mapping and that `type` into a derived-secure field is fenced.
- [ ] Test fixture: `daemon/test/fixtures/login-form.html` — a `file://`-loadable page for the Playwright unit test.
- [ ] Framework install: none — `node:test`/`tsx` already present.

*Manual-only justification:* Real GUI control (Peekaboo→Mail) and real site login require TCC grants and live apps/sites that cannot run in CI. These are documented owner checks at the phase gate, mirroring the Phase-1 launchd manual-check pattern (01-03-SUMMARY "Documented manual checks for the owner").

## Security Domain

> `security_enforcement: true`, `security_asvs_level: 1` in `.planning/config.json`.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no (this phase) | KERNEL never enters credentials — the fence REFUSES; finance auth is Phase 4 Plaid OAuth. |
| V3 Session Management | partial | Playwright persistent profile holds session cookies — store in a dedicated, non-backed-up dir; never commit. |
| V4 Access Control | yes | The `gate.authorize` chokepoint is the access-control boundary for every tool action; default-deny on unknown tools. |
| V5 Input Validation | yes | zod-validate every `ToolCall.args` against the tool's schema before execute; `safeParse`, never trust brain output shape. |
| V6 Cryptography | no | No crypto in this phase (finance encryption is Phase 4). |
| V12 Files/Resources | yes | Browser profile dir is sensitive at-rest state (cookies/logins); keep outside the memory repo and backup. |

### Known Threat Patterns for {Node daemon + GUI/browser automation}

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Agent types a credential into a field (real or phishing) | Information Disclosure / Elevation | `detectCredentialField` fence in `gate.authorize` — refuse-by-default before keystrokes (HANDS-05, §8 hard rule) |
| A tool path bypasses the gate / a tool self-classifies | Elevation of Privilege | Single `registry.dispatch` entry that calls `authorize` first; `Tool.execute` never imported elsewhere; default-deny unknown tools |
| Confused-deputy misclick on UI/site drift | Tampering | AX-tree / role+label targeting + verify-after-act, not coordinates/CSS |
| Data exfil via an attacker-chosen browser navigation | Information Disclosure | Log every navigation with full URL + provenance (HANDS-03); tag scraped content `external` (interlock completed Phase 5) |
| Injected web/Mail content drives a tool call | Tampering / Elevation | Provenance tag at the read site (`source:'external'`); the external→Red interlock is wired for Phase 5; in P2, external content is never auto-promoted (reuse Phase 1 quarantine seam) |
| Session-cookie theft from the browser profile | Information Disclosure | Dedicated profile dir under app-support, gitignored-by-location, never backed up |

## Sources

### Primary (HIGH confidence)
- `daemon/src/` Phase-1 code — `loop.ts` (the act seam, lines 96–98), `brain/BrainProvider.ts` (`ToolCall`/`Decision`/`ToolCallSchema`), `memory/types.ts` (`Provenance`/`ContextItem`), `ipc/protocol.ts`/`server.ts`, `safety/README.md` (the gate seam contract), `config.ts`, `package.json`/`tsconfig.json` — read directly.
- npm registry via `npm view` — `@modelcontextprotocol/sdk@1.29.0`, `playwright@1.61.0`, `@anthropic-ai/sdk@0.105.0`, `@steipete/peekaboo@3.5.2` (repo openclaw/Peekaboo, postinstall, downloads) — verified 2026-06-22.
- `@modelcontextprotocol/sdk@1.29.0` installed in a temp dir; verified import paths `/sdk/client/index.js` + `/sdk/client/stdio.js` resolve and `Client` exposes connect/listTools/callTool/close.
- slopcheck 0.6.1 — `slopcheck install --ecosystem npm @steipete/peekaboo @modelcontextprotocol/sdk playwright` → all `[OK]`.
- KERNEL spec `docs/KERNEL_MASTER_BUILD_PROMPT.md` §8 (tiers + hard rules), §9 (obstacle ladder), §13 (Claude Code Red-tier gating), §16 (Phase 1 = Hands) — authoritative.
- `.planning/research/ARCHITECTURE.md` (tool router + gate-as-middleware patterns, Anti-Pattern 3), `STACK.md` (pinned versions, Peekaboo/Playwright notes), `PITFALLS.md` (Pitfalls 4/5/8/9/15), `ROADMAP.md` (Phase 2 goal + 5 success criteria), `REQUIREMENTS.md` (HANDS-01..05).

### Secondary (MEDIUM confidence)
- github.com/openclaw/Peekaboo (via WebFetch) — MCP tool surface (`see`/`image`/`click`/`type`/`press`/`hotkey`/`menu`/`menubar`/`list`), required permissions, no documented built-in secure-field detection.
- MCP TypeScript SDK client guide (raw GitHub) — `Client` + `StdioClientTransport` usage shape (note: main-branch example uses the newer `@modelcontextprotocol/client` package; this project uses the pinned `sdk` subpaths instead).
- playwright.dev locators + persistent-context (WebSearch) — `getByRole`/accessible-name targeting; `launchPersistentContext(userDataDir, { headless:false })`.

### Tertiary (LOW confidence — flagged for validation)
- Exact Peekaboo MCP launch subcommand and per-tool argument key names — discover at runtime via `listTools()`; do not hardcode (Assumptions A1/A2).

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — versions verified on npm; MCP import paths verified by install; slopcheck clean.
- Architecture (router + gate chokepoint): HIGH — derived from the shipped Phase-1 seams (`loop.ts` act step, `safety/README.md`) and ARCHITECTURE.md's pinned patterns.
- Peekaboo MCP specifics: MEDIUM — tool names confirmed from the repo; exact arg schemas + launch command are runtime-discovery items (A1/A2).
- Pitfalls: HIGH — directly mapped from the project's own PITFALLS.md.
- Testability split: HIGH — follows Phase-1's established unit-vs-manual pattern.

**Research date:** 2026-06-22
**Valid until:** ~2026-07-22 for the npm versions (stable pins); Peekaboo MCP arg schemas should be re-confirmed at implementation time via `listTools()` (the live server is the source of truth).
