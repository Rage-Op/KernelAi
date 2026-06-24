/**
 * specs.ts (WS-A4 / HANDS-06) — the tools ADVERTISED to the local model's autonomous loop, in Ollama's
 * native function-calling shape. This is a CURATED list (not the whole registry), kept SHORT with
 * one-line descriptions (small-model best practice — long tool docs degrade selection).
 *
 * Originally this was read-only/GREEN only, to keep a small model from driving risky actions on its
 * own. With the graduated tiered gate now in force (HANDS-06), it is SAFE to advertise the `fs` and
 * `shell` hands too: whatever the model proposes, classifyTier + gate.authorize enforce the tier on
 * EVERY call — reads run, writes proceed-and-notify, and destructive ops route through the live breaker
 * (owner cancel window) before anything happens. The model can therefore reach for real computer
 * control, while the chokepoint — not the model — decides what actually executes. Keep the count ≤ 8.
 */
import { WEB_TOOL_DESCRIPTION } from './web.js';
import { FS_TOOL_DESCRIPTION } from './fs.js';
import { SHELL_TOOL_DESCRIPTION } from './shell.js';

/** Ollama `/api/chat` native tool spec. */
export interface OllamaToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** The curated tool catalog advertised to LocalBrain's loop. Tiering is enforced by the gate on every
 *  call (see header), so this can include the graduated `fs`/`shell` hands as well as the read-only
 *  `web`/`finance` tools. Keep it SHORT (≤8). */
export function localToolSpecs(): OllamaToolSpec[] {
  return [
    {
      type: 'function',
      function: {
        name: 'web',
        description: WEB_TOOL_DESCRIPTION,
        parameters: {
          type: 'object',
          properties: {
            op: {
              type: 'string',
              enum: ['search', 'fetch'],
              description: "'search' the web for a query, or 'fetch' the text of one url",
            },
            query: { type: 'string', description: 'the search query (use with op=search)' },
            url: { type: 'string', description: 'the page url to read (use with op=fetch)' },
            max_results: { type: 'integer', description: 'how many results, 1-5 (default 3)' },
          },
          required: ['op'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'finance',
        description:
          "Read the owner's OWN bank data (read-only, safe). Use for any question about his money: " +
          "balances ('how much is in checking?'), recent transactions ('what did I buy?'), or spending " +
          "totals over a week/month/year ('how much did I spend this month?'). Never for general/web info.",
        parameters: {
          type: 'object',
          properties: {
            op: {
              type: 'string',
              enum: ['balances', 'transactions', 'aggregate'],
              description: "'balances' = account balances; 'transactions' = recent activity; 'aggregate' = spending total",
            },
            timeframe: {
              type: 'string',
              enum: ['W', 'M', 'Y'],
              description: 'for op=aggregate: this Week, Month, or Year (default M)',
            },
          },
          required: ['op'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'fs',
        description: FS_TOOL_DESCRIPTION,
        parameters: {
          type: 'object',
          properties: {
            op: {
              type: 'string',
              enum: ['read', 'list', 'stat', 'write', 'edit', 'mkdir', 'move', 'delete'],
              description: 'read/list/stat are safe reads; write/edit/mkdir/move change files; delete needs approval',
            },
            path: { type: 'string', description: 'the target file or directory path' },
            content: { type: 'string', description: 'full file contents (op=write)' },
            find: { type: 'string', description: 'exact text to replace (op=edit)' },
            replace: { type: 'string', description: 'replacement text (op=edit)' },
            dest: { type: 'string', description: 'destination path (op=move)' },
          },
          required: ['op'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'shell',
        description: SHELL_TOOL_DESCRIPTION,
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'the full shell command to run' },
            cwd: { type: 'string', description: 'optional working directory (defaults to the workspace)' },
          },
          required: ['command'],
        },
      },
    },
  ];
}
