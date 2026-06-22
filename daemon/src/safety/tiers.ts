/**
 * Tier classification (SAFE-01 seed) + the credential-entry fence (RESEARCH.md Pattern 5).
 *
 * Tier is derived CENTRALLY here from `call.tool` + `call.args` — a tool NEVER self-classifies
 * (RESEARCH.md Anti-Pattern). The matrix is grounded in spec §8:
 *
 *   🟢 Green  = reversible        (open/focus, capture/see/image, click, read, list, menu nav,
 *                                  browser navigate/scrape, draft-not-send, read-only)
 *   🟡 Yellow = recoverable       (type/fill of non-secret text, mark read, change a setting,
 *                                  send, post, install)
 *   🔴 Red    = irreversible/$    (purchase, transfer, sign, rm -rf, delete data,
 *                                  permission/access change)
 *
 * UNKNOWN / unclassifiable ops default to the SAFEST escalating tier (`red`) so they DENY in
 * Phase 2 (default-deny). The matchers are reviewed, extensible top-level constants.
 */
import type { ToolCall } from '../brain/BrainProvider.js';

export type Tier = 'green' | 'yellow' | 'red';

/** Reversible ops (no lasting world change): label `green`. Reviewed + extensible. */
const GREEN_OPS = new Set<string>([
  'open',
  'focus',
  'launch',
  'see',
  'image',
  'capture',
  'screenshot',
  'click',
  'read',
  'list',
  'menu',
  'menubar',
  'navigate',
  'goto',
  'scrape',
  'draft',
  'press',
  'hotkey',
  'scroll',
]);

/** Recoverable ops (a lasting but reversible change): label `yellow`. */
const YELLOW_OPS = new Set<string>([
  'type',
  'fill',
  'send',
  'post',
  'reply',
  'mark-read',
  'markread',
  'setting',
  'set-setting',
  'install',
  'move',
  'rename',
]);

/** Irreversible / financial ops: label `red`. Also the default for anything unrecognized. */
const RED_OPS = new Set<string>([
  'purchase',
  'buy',
  'pay',
  'transfer',
  'sign',
  'delete',
  'rm',
  'rm-rf',
  'remove',
  'wipe',
  'erase',
  'revoke',
  'grant',
  'permission',
  'access-change',
]);

/** Normalize the conventional operation token: `args.op` (preferred), else the tool name. */
function operationOf(call: ToolCall): string {
  const op = call.args?.op;
  const raw = typeof op === 'string' && op.length > 0 ? op : call.tool;
  return raw.toLowerCase().trim();
}

/**
 * Classify a ToolCall into a tier. Central, context-derived — never the tool's own job.
 * `rm -rf` and similar destructive text in the op normalize to a Red match.
 */
export function classifyTier(call: ToolCall): Tier {
  const op = operationOf(call);

  // explicit Red signals (including destructive shell-ish text like "rm -rf").
  if (RED_OPS.has(op) || /\brm\b/.test(op) || op.includes('rm -rf')) return 'red';
  if (GREEN_OPS.has(op)) return 'green';
  if (YELLOW_OPS.has(op)) return 'yellow';

  // default-deny: anything unclassifiable is treated as the safest escalating tier.
  return 'red';
}

/** A minimal call shape the fence can classify (tool + args). */
interface FenceCall {
  tool: string;
  args: Record<string, unknown>;
}

/**
 * The credential-entry fence. Refuse-by-default on ANY secret signal. Only `peekaboo`/`browser`
 * tools and only `type`/`fill` ops are in scope (everything else is not-secret).
 *
 * The ADAPTER is responsible for surfacing `isSecureField` / `fieldLabel` / `fieldName` /
 * `placeholder` / `autocomplete` from the AX tree (Peekaboo `see`) or the DOM (Playwright
 * `getAttribute`) at the READ site — this detector can only classify what the adapter surfaces.
 */
const SECRET_LABEL =
  /\b(pass\s?word|passwd|pwd|card\s?(number)?|cvv|cvc|csc|ssn|social\s?security|pin|security\s?code)\b/i;
const SECRET_AUTOCOMPLETE =
  /(current-password|new-password|cc-number|cc-csc|cc-exp|one-time-code)/i;

export function detectCredentialField(call: FenceCall): { isSecret: boolean; reason: string } {
  if (call.tool !== 'peekaboo' && call.tool !== 'browser') return { isSecret: false, reason: '' };

  const op = String(call.args?.op ?? '');
  if (!/^(type|fill)$/i.test(op)) return { isSecret: false, reason: '' };

  // secure text field surfaced by the adapter (AX `AXSecureTextField` / DOM type=password).
  if (call.args.isSecureField === true) {
    return { isSecret: true, reason: 'secure text field' };
  }

  // label / name / placeholder matching a known credential pattern.
  const label = String(call.args.fieldLabel ?? call.args.fieldName ?? call.args.placeholder ?? '');
  if (SECRET_LABEL.test(label)) {
    return { isSecret: true, reason: `field label matched: "${label}"` };
  }

  // sensitive autocomplete hint.
  const ac = String(call.args.autocomplete ?? '');
  if (SECRET_AUTOCOMPLETE.test(ac)) {
    return { isSecret: true, reason: `autocomplete hint: "${ac}"` };
  }

  return { isSecret: false, reason: '' };
}
