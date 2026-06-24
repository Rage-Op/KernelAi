/**
 * specs.ts (WS-A4) — the tools ADVERTISED to the local model's autonomous loop, in Ollama's native
 * function-calling shape. This is deliberately a CURATED list, NOT the whole registry: only SAFE,
 * read-only (GREEN) capabilities the small model may drive on its own without a gate prompt. Kept
 * short with one-line descriptions (small-model best practice — long tool docs degrade selection).
 *
 * Anything riskier (send mail, fill forms, finance writes — none exist read-only) stays OFF this
 * list; those route through the owner-in-the-loop paths, never the model's autonomous tool loop.
 * Extend deliberately, and keep the count ≤ 8.
 */
import { WEB_TOOL_DESCRIPTION } from './web.js';

/** Ollama `/api/chat` native tool spec. */
export interface OllamaToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** The curated tool catalog advertised to LocalBrain's loop. Keep it SHORT (≤8) and read-only/GREEN
 *  so the small model can drive these autonomously without a gate prompt. Riskier capabilities
 *  (sending mail, filling forms, finance writes) are NOT here — they route through owner-in-the-loop. */
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
  ];
}
