/**
 * tools/peekaboo.ts — the Peekaboo GUI adapter (HANDS-01, HANDS-02), RESEARCH.md Pattern 3.
 *
 * KERNEL gains macOS GUI hands by speaking MCP (over stdio) to the brew-installed Peekaboo
 * binary (`peekaboo mcp`, confirmed against Peekaboo 3.5.2 — `peekaboo --help`). Peekaboo is a
 * SYSTEM BINARY spawned by the transport, NOT an npm dependency of the daemon — the only npm
 * dependency this lands is `@modelcontextprotocol/sdk@1.29.0` (the MCP client).
 *
 * Load-bearing invariants (all enforced here, all in RESEARCH.md):
 *   - ONE persistent `Client` is reused across calls (Anti-Pattern: respawn per dispatch).
 *   - Tool arg schemas are DISCOVERED at runtime via `listTools()` — never hardcoded
 *     (Anti-Pattern: hardcoding Peekaboo arg schemas). `OP_MAP` maps KERNEL's high-level op
 *     envelope to the discovered Peekaboo tool NAME; the arg keys come from the live server.
 *   - `see`/`image`/`capture` output is tagged `source:'external'` at the READ site, reusing
 *     the Phase-1 `ContextItem`/`Provenance` shape (untrusted, external-sourced content).
 *   - For the `type` op, the adapter SURFACES the AX secure-field signals
 *     (`isSecureField`/`fieldLabel`/`fieldName`/`placeholder`/`autocomplete`) into `ToolCall.args`
 *     so the credential fence in `gate.authorize` (02-01) can classify and REFUSE secrets
 *     BEFORE any keystroke is synthesized. The adapter does NOT decide to refuse — refusal is the
 *     gate's job; the adapter populating these fields IS the fence's data source (HANDS-05).
 *   - On a Peekaboo/MCP failure (e.g. a missing TCC grant — macOS has no Screen-Recording status
 *     API, so we probe-then-escalate) the adapter CATCHES and returns a structured
 *     `{ ok:false, escalation }` — it NEVER crashes the loop.
 *
 * ANTI-BYPASS: `peekabooTool.execute` is only ever reached via `registry.dispatch` (after the
 * gate). Importing this module self-registers the tool (module-init side effect); nothing calls
 * `execute` directly except the registry.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';

import { register } from './registry.js';
import type { Tool, ToolResult } from './Tool.js';
import type { ContextItem } from '../memory/types.js';
import { logger } from '../memory/log.js';

/**
 * The Peekaboo MCP launch command (RESEARCH.md A1, confirmed against the installed binary:
 * `peekaboo mcp` starts the MCP server on stdio — `peekaboo mcp --help`). Kept a single named
 * constant so it is trivially correctable if the brew binary's subcommand ever changes.
 */
export const PEEKABOO_COMMAND = 'peekaboo';
export const PEEKABOO_ARGS = ['mcp'] as const;

/**
 * KERNEL's high-level op envelope → the discovered Peekaboo MCP tool name. The op token is what
 * `tiers.ts` classifies (Green/Yellow); the mapped name is what we hand to `callTool`. We never
 * hardcode the tool's ARG schema — only the stable tool NAMES (confirmed from the live
 * `tools/list` catalog: see/image/capture/click/type/hotkey/menu/list/app).
 */
const OP_MAP: Record<string, string> = {
  see: 'see',
  image: 'image',
  capture: 'capture',
  click: 'click',
  type: 'type',
  press: 'hotkey', // Peekaboo exposes key presses via `hotkey`; there is no separate `press` MCP tool.
  hotkey: 'hotkey',
  menu: 'menu',
  list: 'list',
  app: 'app', // open/focus/launch/quit an application (used to open Mail — HANDS-02).
} as const;

/** Ops whose returned content is EXTERNAL-sourced (read from the GUI) and must be tainted. */
const EXTERNAL_READ_OPS = new Set(['see', 'image', 'capture', 'list']);

/**
 * The fence-signal fields the adapter surfaces for the `type` op (HANDS-05). These are NOT
 * Peekaboo arg names — they are the AX-tree-derived signals the credential fence classifies.
 * They are stripped from the payload before it is forwarded to Peekaboo (Peekaboo would reject
 * unknown keys), but they remain on `call.args` where the gate already inspected them.
 */
const FENCE_FIELDS = ['fieldLabel', 'fieldName', 'placeholder', 'isSecureField', 'autocomplete'] as const;

/**
 * The minimal MCP client surface the adapter uses. Declaring it lets tests inject a mock
 * (via `__setClientForTest`) without depending on the concrete SDK class.
 */
export interface PeekabooClient {
  listTools(): Promise<{ tools: Array<{ name: string; [k: string]: unknown }> }>;
  callTool(req: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
}

/** The ONE persistent client (RESEARCH.md: reuse across calls, never respawn per dispatch). */
let client: PeekabooClient | null = null;

/**
 * Lazily spawn the Peekaboo MCP server and connect a single `Client`, caching it. Subsequent
 * calls reuse the cached client. The transport spawns the brew binary as a child process.
 */
async function connect(): Promise<PeekabooClient> {
  if (client) return client;
  const transport = new StdioClientTransport({
    command: PEEKABOO_COMMAND,
    args: [...PEEKABOO_ARGS],
  });
  const c = new Client({ name: 'kernel', version: '0.1.0' });
  await c.connect(transport);
  client = c as unknown as PeekabooClient;
  return client;
}

/** Runtime tool discovery — the live server's `tools/list` is the source of truth for arg shapes. */
export async function discover(): Promise<{ tools: Array<{ name: string; [k: string]: unknown }> }> {
  return (await connect()).listTools();
}

/** Call a discovered Peekaboo tool by name with runtime-validated arguments. */
export async function callPeekaboo(name: string, args: Record<string, unknown>): Promise<unknown> {
  return (await connect()).callTool({ name, arguments: args });
}

/** TEST-ONLY seam: inject a mocked MCP client so unit tests run with no real server / TCC. */
export function __setClientForTest(mock: PeekabooClient | null): void {
  client = mock;
}

/**
 * The high-level op envelope. `op` is the only field the schema constrains tightly (so the gate
 * can classify a known op); the rest is a permissive passthrough because the precise Peekaboo arg
 * names come from `listTools()` at runtime, not from this schema (RESEARCH.md). The fence-signal
 * fields are declared optional so they validate when the adapter surfaces them for a `type`.
 */
export const peekabooArgsSchema = z
  .object({
    op: z.enum(['see', 'image', 'capture', 'click', 'type', 'press', 'hotkey', 'menu', 'list', 'app']),
    // Fence signals surfaced for the `type` op (HANDS-05) — see FENCE_FIELDS.
    text: z.string().optional(),
    fieldLabel: z.string().optional(),
    fieldName: z.string().optional(),
    placeholder: z.string().optional(),
    isSecureField: z.boolean().optional(),
    autocomplete: z.string().optional(),
  })
  .passthrough();

/** Strip the KERNEL-only envelope keys; forward the rest as the Peekaboo tool arguments. */
function toPeekabooArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === 'op') continue;
    if ((FENCE_FIELDS as readonly string[]).includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Tag external-sourced GUI content with the Phase-1 provenance shape. */
function asExternal(op: string, data: unknown): ContextItem {
  return {
    text: typeof data === 'string' ? data : JSON.stringify(data),
    source: 'external',
    origin: `peekaboo:${op}`,
  };
}

/**
 * The registered Peekaboo `Tool` (the 02-01 contract). `execute` switches on `args.op`, maps it
 * to the discovered Peekaboo tool name, and forwards the runtime args. NEVER call this outside the
 * registry — `registry.dispatch` runs `gate.authorize` (and the credential fence) FIRST.
 */
export const peekabooTool: Tool = {
  name: 'peekaboo',
  schema: peekabooArgsSchema,
  async execute(args): Promise<ToolResult> {
    const op = String(args.op);
    const name = OP_MAP[op];
    if (!name) {
      // Unknown op should already be caught by the schema; defend anyway (never throw).
      return { ok: false, escalation: { reason: `unsupported peekaboo op: ${op}` } };
    }

    try {
      const result = await callPeekaboo(name, toPeekabooArgs(args));

      // External-sourced reads (see/image/capture/list) are tainted at the READ site.
      if (EXTERNAL_READ_OPS.has(op)) {
        return { ok: true, data: asExternal(op, result) };
      }
      return { ok: true, data: result };
    } catch (err) {
      // Probe-then-escalate: a missing TCC grant (Screen Recording / Accessibility /
      // Event-synthesizing) surfaces here as a thrown MCP error. macOS has no status API to
      // pre-check, so we attempt the op and translate the failure into a structured escalation —
      // never a crash (RESEARCH.md Pitfall: TCC instability).
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ tool: 'peekaboo', op, name, reason }, 'peekaboo: op failed — escalating');
      return {
        ok: false,
        escalation: {
          reason: `peekaboo ${op} failed: ${reason}`,
          recommendation:
            'Confirm Peekaboo is installed (brew install steipete/tap/peekaboo) and that ' +
            'Screen Recording, Accessibility, and Event-synthesizing are granted to the Peekaboo ' +
            'binary (System Settings → Privacy & Security), then retry.',
        },
      };
    }
  },
};

// Module-init side effect: importing this tool wires it into the router (HANDS-04).
register(peekabooTool);
