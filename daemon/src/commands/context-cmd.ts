/**
 * `context` meta-command — "what's in your head right now", à la Claude Code's /context.
 *
 * Renders the exact breakdown of the context KERNEL assembles each turn: IDENTITY.md and the
 * current.md scratchpad (the never-truncated fixed block), then the reranked retrieval that
 * greedily fills the rest of the 16K-char budget — included items and the ones skipped for
 * overflow or because they're external (quarantined). The numbers come from `injectReport`, which
 * shares inject()'s code path, so this is the ground truth, not an estimate of an estimate.
 *
 * Read-only. Also surfaces the active model's real context window (local 8K / cloud 1M) and how
 * full the last turn's prompt left it, so "memory budget" vs. "model window" are both legible.
 */
import { config } from '../config.js';
import { injectReport, type InjectReport } from '../memory/inject.js';
import { currentBrainSelection } from '../settings.js';
import { OLLAMA_MODEL, OLLAMA_NUM_CTX } from '../brain/LocalBrain.js';
import { CLAUDE_MODEL } from '../brain/ClaudeBrain.js';
import { snapshot } from './session-usage.js';
import { bar, commas, estTokens } from './format.js';

const SEP = '\n';
/** claude-opus-4-8 context window (tokens). */
const CLOUD_CONTEXT_WINDOW = 1_000_000;
/** How many included/skipped items to list before collapsing to a count. */
const MAX_LIST = 6;

function chars(n: number): string {
  return `${commas(n).padStart(7)} chars  ~${commas(estTokens(n))} tok`;
}

function renderModelWindow(): string[] {
  const brain = currentBrainSelection();
  const snap = snapshot();
  const lines: string[] = [];
  if (brain === 'local') {
    const model = snap.lastModel ?? OLLAMA_MODEL;
    lines.push(`Model window — local · ${model} · ${commas(OLLAMA_NUM_CTX)} tok`);
    if (typeof snap.lastPromptTokens === 'number') {
      lines.push(
        `  last turn used ${commas(snap.lastPromptTokens)} prompt tok  ` +
          bar(snap.lastPromptTokens, OLLAMA_NUM_CTX, 14),
      );
    } else {
      lines.push('  (no turn measured yet this session)');
    }
  } else {
    const model = snap.lastModel ?? CLAUDE_MODEL;
    lines.push(`Model window — cloud · ${model} · ${commas(CLOUD_CONTEXT_WINDOW)} tok`);
    if (typeof snap.lastPromptTokens === 'number') {
      lines.push(`  last turn used ${commas(snap.lastPromptTokens)} prompt tok`);
    }
  }
  return lines;
}

/** Build the human-readable context report for the current memory state. */
export async function runContextReport(memoryDir: string = config.memoryDir): Promise<string> {
  const r: InjectReport = await injectReport(undefined, memoryDir);

  const head = [
    'KERNEL · context',
    '─'.repeat(54),
    `Memory injection — assembled IDENTITY-first each turn, hard cap ${commas(r.cap)} chars (~${commas(estTokens(r.cap))} tok)`,
    '',
  ];

  if (r.overCap) {
    return [
      ...head,
      `  !! IDENTITY + current.md = ${chars(r.fixedChars)}`,
      `     This EXCEEDS the ${commas(r.cap)}-char cap. IDENTITY is never dropped; current.md must be`,
      `     trimmed (try "compact"). Retrieval is suspended until the fixed block fits.`,
      '',
      ...renderModelWindow(),
    ].join(SEP);
  }

  const included = r.retrieved.filter((s) => s.included);
  const skipped = r.retrieved.filter((s) => !s.included);
  const retrievedChars = included.reduce((a, s) => a + s.chars, 0);

  const lines: string[] = [
    ...head,
    `  IDENTITY.md        ${chars(r.identityChars)}    always first · never truncated`,
    `  working memory     ${chars(r.currentChars)}    current.md scratchpad · never truncated`,
    `  retrieved          ${chars(retrievedChars)}    ${included.length} of ${r.retrieved.length} candidates fit`,
  ];

  if (included.length) {
    lines.push('', '    included:');
    for (const s of included.slice(0, MAX_LIST)) {
      lines.push(`      • ${s.path.padEnd(34)} ${chars(s.chars)}  ${s.source}`);
    }
    if (included.length > MAX_LIST) lines.push(`      … and ${included.length - MAX_LIST} more`);
  }
  if (skipped.length) {
    lines.push('', `    skipped (${skipped.length}):`);
    for (const s of skipped.slice(0, MAX_LIST)) {
      lines.push(`      • ${s.path.padEnd(34)} ${commas(s.chars).padStart(7)} chars  ${s.reason ?? 'skipped'}`);
    }
    if (skipped.length > MAX_LIST) lines.push(`      … and ${skipped.length - MAX_LIST} more`);
  }

  lines.push(
    '',
    `  ── assembled total  ${commas(r.totalChars)} / ${commas(r.cap)} chars  ${bar(r.totalChars, r.cap)}  (~${commas(estTokens(r.totalChars))} tok)`,
    '',
    ...renderModelWindow(),
  );

  return lines.join(SEP);
}
