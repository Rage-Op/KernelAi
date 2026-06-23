/**
 * Plain-text formatting helpers shared by the meta-commands.
 *
 * Meta-command output travels over the IPC `reply` frame as PLAIN text (no ANSI) so it renders
 * identically in the CLI today and the future Face. These helpers keep the reports terse and
 * column-aligned in a monospace terminal.
 */

/** ~4 chars per token — the same heuristic the CLI banner uses for the inject budget. */
export function estTokens(chars: number): number {
  return Math.round(chars / 4);
}

/** Thousands-separated integer (or em dash for non-numbers). */
export function commas(n: number | undefined | null): string {
  return typeof n === 'number' ? n.toLocaleString('en-US') : '—';
}

/** A unicode progress bar: `[████░░░░] 41%`. Empty string when total is unknown. */
export function bar(used: number, total: number, width = 18): string {
  if (!total || total <= 0) return '';
  const p = Math.max(0, Math.min(1, used / total));
  const fill = Math.round(p * width);
  return `[${'█'.repeat(fill)}${'░'.repeat(width - fill)}] ${Math.round(p * 100)}%`;
}

/** USD to 4 decimals. */
export function usd(n: number | undefined): string {
  return typeof n === 'number' ? `$${n.toFixed(4)}` : '—';
}

/** Human duration from milliseconds. */
export function ms(m: number | undefined): string {
  if (typeof m !== 'number' || m <= 0) return '—';
  if (m < 1000) return `${Math.round(m)}ms`;
  if (m < 60_000) return `${(m / 1000).toFixed(1)}s`;
  return `${Math.floor(m / 60_000)}m ${Math.round((m % 60_000) / 1000)}s`;
}

/** Coarse elapsed time since an ISO timestamp (for "session started N ago"). */
export function since(iso: string): string {
  const started = Date.parse(iso);
  if (Number.isNaN(started)) return '—';
  return ms(Date.now() - started);
}

/** A `key   value` row with the key left-padded to a fixed width. */
export function row(key: string, value: string, keyWidth = 18): string {
  return `  ${key.padEnd(keyWidth)} ${value}`;
}
