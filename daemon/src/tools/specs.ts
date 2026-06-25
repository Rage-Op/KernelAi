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

/** The curated tool catalog advertised to LocalBrain's loop — the FULL set of hands (the gate enforces
 *  the tier on every call, so it is safe to advertise them all): web, finance, fs, shell, peekaboo
 *  (screen/GUI), browser (headless web), mail. 7 tools, crisp one-liners (≤8 — small-model best practice).
 *  This list MUST stay in sync with the "Your tools" section of LocalBrain's SYSTEM_PROMPT — advertising
 *  a tool here without teaching the model it HAS it (there) is exactly why it used to deflect ("I can't"). */
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
            path: { type: 'string', description: 'the target file or directory path (omit for list/stat to use your workspace)' },
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
    {
      type: 'function',
      function: {
        name: 'peekaboo',
        description:
          "Your EYES and GUI HANDS on this Mac's screen. Use for any request to see/control the desktop: " +
          "find the focused/front app or list open apps (op=list), see what's on screen (op=see), open or " +
          "switch to an app (op=app, app=<name>), click something (op=click, target=<label>), type text into " +
          "the focused field (op=type, text=<text>), or press a keystroke (op=hotkey, keys=<e.g. cmd,t>).",
        parameters: {
          type: 'object',
          properties: {
            op: {
              type: 'string',
              enum: ['see', 'list', 'app', 'click', 'type', 'hotkey', 'menu'],
              description: 'see=screenshot+read screen; list=open apps/windows; app=open/switch app; click; type; hotkey; menu',
            },
            app: { type: 'string', description: 'application name (op=app/see), e.g. "Comet"' },
            text: { type: 'string', description: 'text to type (op=type)' },
            target: { type: 'string', description: 'what to click — a visible button/link/field label (op=click)' },
            keys: { type: 'string', description: 'keys to press, comma-separated (op=hotkey), e.g. "cmd,t"' },
          },
          required: ['op'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser',
        description:
          'A HEADLESS web browser you drive programmatically: open a url (op=navigate), read/scrape the ' +
          "page's text (op=scrape), or fill a field (op=fill). For web tasks that need a live page. " +
          '(To control the VISIBLE Comet/Safari app on screen, use peekaboo or shell instead.)',
        parameters: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: ['navigate', 'scrape', 'fill'], description: 'navigate to a url, scrape its text, or fill a field' },
            url: { type: 'string', description: 'the page url (op=navigate)' },
            label: { type: 'string', description: 'the field/control label to fill (op=fill)' },
            text: { type: 'string', description: 'the value to type (op=fill)' },
          },
          required: ['op'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'mail',
        description:
          "Act on the owner's email: reply to a message (op=reply), send a new one (op=send), or mark a " +
          'message read (op=mark-read). Drafts/sends are gated for approval before anything leaves.',
        parameters: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: ['reply', 'send', 'mark-read'], description: 'reply / send / mark-read' },
            to: { type: 'string', description: 'recipient address (op=send)' },
            subject: { type: 'string', description: 'subject line (op=send)' },
            body: { type: 'string', description: 'the message body (op=send/reply)' },
          },
          required: ['op'],
        },
      },
    },
  ];
}
