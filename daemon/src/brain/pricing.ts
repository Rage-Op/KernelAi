/**
 * Cloud pricing — the single source of truth for token→USD math.
 *
 * Local compute (Ollama) is free ($0). The cloud brain (claude-opus-4-8) is billed per token at
 * the list rates below. The same rates drive the "cloud-equivalent" figure the dashboards show for
 * a local turn (what this turn WOULD have cost on cloud), so a reader can weigh local vs. cloud.
 *
 * Kept dependency-free and importing nothing from the daemon graph so any module (the IPC server,
 * the session-usage accumulator, a command) can use it without an import cycle.
 */

/** opus-4-8 list price in USD per token. */
export const CLOUD_PRICE_PER_TOKEN = {
  input: 5 / 1_000_000,
  output: 25 / 1_000_000,
} as const;

/** USD a turn with these token counts costs (or WOULD cost) at cloud list price. */
export function cloudEquivUsd(promptTokens = 0, outputTokens = 0): number {
  return promptTokens * CLOUD_PRICE_PER_TOKEN.input + outputTokens * CLOUD_PRICE_PER_TOKEN.output;
}
