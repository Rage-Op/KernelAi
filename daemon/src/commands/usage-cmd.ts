/**
 * `usage` meta-command — cumulative session telemetry, à la Claude Code's /usage.
 *
 * Reads the daemon-authoritative accumulator (session-usage.ts) fed by every measured turn, so the
 * same numbers answer a typed `/usage` AND a natural-language "how much have I used?". Reports
 * turns, tokens in/out, throughput, and cost — on the local brain that's $0 with the cloud-equivalent
 * shown alongside so the owner can see what the same work would have cost on cloud.
 *
 * `usage reset` zeroes the accounting window. Pure read otherwise (no memory writes).
 */
import { resetUsage, snapshot } from './session-usage.js';
import { GEN_NUM_CTX } from '../brain/persona.js';
import { bar, commas, ms, since, usd } from './format.js';

const SEP = '\n';
/** The local context window used for the last-turn fill bar — a generic local default; LM Studio's
 *  true window depends on how the model was loaded. */
const LOCAL_CTX_WINDOW = GEN_NUM_CTX;

/** Build the session usage report. `arg === 'reset'` clears the window first. */
export function runUsageReport(arg = ''): string {
  if (arg.trim().toLowerCase() === 'reset') {
    resetUsage();
    return 'KERNEL · usage — session counters reset to zero.';
  }

  const s = snapshot();
  const head = ['KERNEL · usage', '─'.repeat(54)];

  if (s.turns === 0) {
    return [
      ...head,
      `  no measured turns yet this session (started ${since(s.startedAt)} ago).`,
      `  Ask me something, then run "usage" again.`,
    ].join(SEP);
  }

  const brainLabel = s.lastBrain
    ? s.lastBrain === 'cloud'
      ? 'cloud'
      : s.lastBrain === 'claude-code'
        ? 'claude (sub, free)'
        : 'lmstudio (free)'
    : '—';
  const costLine =
    s.lastBrain === 'cloud'
      ? `${usd(s.costUsd)} billed`
      : s.lastBrain === 'claude-code'
        ? `${usd(0)} (subscription)   cloud-equivalent ≈ ${usd(s.cloudEquivUsd)}`
        : `${usd(0)} (local, free)   cloud-equivalent ≈ ${usd(s.cloudEquivUsd)}`;

  const lines = [
    ...head,
    `  window     since daemon start · ${since(s.startedAt)} ago · ${s.turns} turn${s.turns === 1 ? '' : 's'}`,
    `  brain      ${brainLabel}${s.lastModel ? ` · ${s.lastModel}` : ''}`,
    `  tokens     ${commas(s.promptTokens)} in  ·  ${commas(s.outputTokens)} out  ·  ${commas(s.totalTokens)} total`,
  ];

  if (s.avgTokensPerSec !== null) {
    lines.push(
      `  throughput ${s.avgTokensPerSec.toFixed(1)} tok/s avg  ·  ${ms(s.totalMs / s.turns)} / turn`,
    );
  }
  lines.push(`  cost       ${costLine}`);

  // A coarse model-window fill from the last turn (local context is the binding budget). Only the LOCAL
  // engine (LM Studio) gets it; the large Claude window (cloud / subscription) makes a fill bar meaningless.
  if (s.lastBrain === 'lmstudio' && typeof s.lastPromptTokens === 'number') {
    lines.push(`  last ctx   ${commas(s.lastPromptTokens)} prompt tok  ${bar(s.lastPromptTokens, LOCAL_CTX_WINDOW, 14)} of ${Math.round(LOCAL_CTX_WINDOW / 1024)}K window`);
  }

  return lines.join(SEP);
}
