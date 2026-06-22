#!/usr/bin/env node
/**
 * chat.mjs — a text "mission control" REPL for the running KERNEL daemon. No Face / Mac app needed.
 *
 * Connects to the daemon's UDS socket, sends each line you type as an `utterance`, and renders the
 * reply plus rich telemetry:
 *   - a dashboard header (brain, model, context window, resident memory, tools, integrations) built
 *     from the daemon's `capabilities` frame + a direct read of Ollama's /api/ps,/show,/tags;
 *   - a per-turn stats line (tokens in/out, tokens/sec, latency, context use, cost) from the
 *     daemon's `stats` frame;
 *   - running session totals.
 *
 * Slash commands: /help /stats /tools /models /memory /brain [cloud|local] /clear /quit
 *
 * Usage:  node daemon/scripts/chat.mjs      (or: npm run chat)
 * Env:    KERNEL_SOCKET, OLLAMA_HOST (default http://localhost:11434), KERNEL_MEMORY_DIR
 */
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOCK =
  process.env.KERNEL_SOCKET ??
  path.join(os.homedir(), 'Library', 'Application Support', 'Kernel', 'kernel.sock');
const OLLAMA = (process.env.OLLAMA_HOST ?? 'http://localhost:11434').replace(/\/$/, '');
const MEM_DIR = process.env.KERNEL_MEMORY_DIR ?? path.resolve(__dirname, '..', '..', 'kernel-memory');

// opus-4-8 list price, for the local "cloud-equivalent" cost comparison (USD per token).
const CLOUD_PRICE = { input: 5 / 1_000_000, output: 25 / 1_000_000 };

// ── tiny ANSI helpers (dependency-free) ────────────────────────────────────────
const C = (n) => (s) => `\x1b[${n}m${s}\x1b[0m`;
const dim = C(2), bold = C(1), cyan = C(36), green = C(32), yellow = C(33), red = C(31), mag = C(35), blue = C(34);
const rule = (w = 62) => dim('─'.repeat(w));

// ── formatting ─────────────────────────────────────────────────────────────────
const int = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '—');
const ms = (m) => (typeof m !== 'number' ? '—' : m < 1000 ? `${Math.round(m)}ms` : `${(m / 1000).toFixed(1)}s`);
const usd = (n) => (typeof n === 'number' ? `$${n.toFixed(4)}` : '—');
function bytes(n) {
  if (typeof n !== 'number') return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}
function pctBar(used, total, width = 14) {
  if (!total) return '';
  const p = Math.max(0, Math.min(1, used / total));
  const fill = Math.round(p * width);
  return `${dim('[')}${green('█'.repeat(fill))}${dim('░'.repeat(width - fill))}${dim(']')} ${Math.round(p * 100)}%`;
}

// ── state ───────────────────────────────────────────────────────────────────────
let caps = null; // last capabilities frame
let ollama = null; // { ps, show, tags } snapshot for the active model
let lastStats = null;
const session = { turns: 0, inTok: 0, outTok: 0, cost: 0, cloudEquiv: 0, evalMs: 0, wallMs: 0 };
const pending = new Map(); // utterance id → send timestamp (wall-clock latency)

// ── Ollama direct reads (graceful: returns null if Ollama is off / cloud brain) ──
async function ollamaGet(p, body) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3500);
    const res = await fetch(`${OLLAMA}${p}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function refreshOllama(model) {
  const [ps, tags] = await Promise.all([ollamaGet('/api/ps'), ollamaGet('/api/tags')]);
  ollama = { ps, tags, show: null };
  // The capabilities frame carries no model name, so derive it: prefer the resident model (/api/ps),
  // else the active stats model, else the first installed (/api/tags). Then fetch its details.
  const name = model ?? lastStats?.model ?? ps?.models?.[0]?.name ?? tags?.models?.[0]?.name ?? null;
  if (name) ollama.show = await ollamaGet('/api/show', { model: name });
}

/** Pull the running entry for the active model out of /api/ps. */
function runningModel() {
  const list = ollama?.ps?.models ?? [];
  return list.find((m) => m.name === modelName()) ?? list[0] ?? null;
}
function modelName() {
  return lastStats?.model ?? caps?.model ?? ollama?.ps?.models?.[0]?.name ?? null;
}
/** Best-effort context_length from /api/show model_info (key varies by family). */
function modelCtxLen() {
  const info = ollama?.show?.model_info;
  if (!info) return null;
  const k = Object.keys(info).find((x) => x.endsWith('.context_length'));
  return k ? info[k] : null;
}

// ── rendering ────────────────────────────────────────────────────────────────────
function banner() {
  if (!caps) return;
  const brain = caps.brain;
  const rows = [];
  const name = modelName() ?? (brain === 'cloud' ? 'claude-opus-4-8' : 'unknown');
  rows.push(['brain', `${brain === 'local' ? green('local') : blue('cloud')}  ${bold(name)}`]);

  if (brain === 'local') {
    const det = ollama?.show?.details;
    const detail = det ? `${det.parameter_size ?? '?'} · ${det.quantization_level ?? '?'}` : dim('(start a turn to load)');
    const ctx = modelCtxLen();
    rows.push(['model', `${detail}${ctx ? ` · max ctx ${int(ctx)} tok` : ''}`]);
    const rm = runningModel();
    if (rm) {
      const exp = rm.expires_at ? ` · unloads ${new Date(rm.expires_at).toLocaleTimeString()}` : '';
      rows.push(['memory', `${bytes(rm.size_vram ?? rm.size)} resident${rm.size_vram && rm.size && rm.size_vram < rm.size ? ` (${bytes(rm.size)} total)` : ''}${exp}`]);
    } else {
      rows.push(['memory', dim('not resident (loads on first turn)')]);
    }
    const caps2 = ollama?.show?.capabilities;
    if (Array.isArray(caps2) && caps2.length) {
      rows.push(['can', caps2.join(' · ') + (caps2.includes('tools') ? `  ${green('✓ tool-calling')}` : '')]);
    }
  } else {
    rows.push(['pricing', `${usd(CLOUD_PRICE.input * 1e6)}/1M in · ${usd(CLOUD_PRICE.output * 1e6)}/1M out`]);
  }

  rows.push(['context', `working window ~${int(Math.round(caps.injectCap / 4))} tok ${dim(`(memory inject cap ${int(caps.injectCap)} chars)`)}`]);
  rows.push(['tools', caps.tools.length ? caps.tools.join(', ') : dim('none registered')]);
  rows.push(['hands', caps.integrations.map((s) => s.replace(/\s*\(.*\)$/, '')).join(' · ')]);
  if (brain === 'local' && ollama?.tags?.models) {
    rows.push(['models', `${ollama.tags.models.length} installed: ${ollama.tags.models.map((m) => m.name).slice(0, 4).join(', ')}`]);
  }

  out(`\n${dim('╭─')} ${bold('KERNEL')} ${dim('· ' + caps.daemon + ' v' + caps.version)} ${rule(40)}`);
  for (const [k, v] of rows) out(`  ${cyan(k.padEnd(8))} ${v}`);
  out(`${dim('╰')}${rule(61)}`);
  out(dim('  commands: /stats /tools /models /memory /brain [cloud|local] /clear /help /quit\n'));
}

function statsLine(s) {
  const tps = typeof s.tokensPerSec === 'number' ? `${s.tokensPerSec.toFixed(1)} tok/s` : '—';
  const wall = pending.has(s.id) ? Date.now() - pending.get(s.id) : undefined;
  const ctx = s.promptTokens && s.contextWindow ? `ctx ${pctBar(s.promptTokens, s.contextWindow, 10)}` : '';
  let cost;
  if (s.brain === 'local') {
    const eq = (s.promptTokens ?? 0) * CLOUD_PRICE.input + (s.outputTokens ?? 0) * CLOUD_PRICE.output;
    cost = `${green('$0 local')} ${dim(`(cloud≈${usd(eq)})`)}`;
  } else {
    cost = yellow(usd(s.estCostUsd));
  }
  const parts = [
    `${int(s.promptTokens)}${dim('→')}${int(s.outputTokens)} tok`,
    bold(tps),
    `${ms(s.evalMs)}${s.loadMs ? dim(` +${ms(s.loadMs)} load`) : ''}${wall ? dim(` · ${ms(wall)} wall`) : ''}`,
    ctx,
    cost,
  ].filter(Boolean);
  out(dim('  ⟐ ') + parts.join(dim('  ·  ')));
}

function sessionTotals() {
  out(`\n${dim('╭─')} ${bold('session')} ${rule(48)}`);
  out(`  ${cyan('turns'.padEnd(8))} ${session.turns}`);
  out(`  ${cyan('tokens'.padEnd(8))} ${int(session.inTok)} in ${dim('·')} ${int(session.outTok)} out ${dim('·')} ${int(session.inTok + session.outTok)} total`);
  if (session.evalMs > 0) out(`  ${cyan('avg'.padEnd(8))} ${(session.outTok / (session.evalMs / 1000)).toFixed(1)} tok/s ${dim('·')} ${ms(session.wallMs / Math.max(1, session.turns))} / turn`);
  out(`  ${cyan('cost'.padEnd(8))} ${green('$0.0000 (local, free)')} ${dim('· cloud-equivalent ≈')} ${yellow(usd(session.cloudEquiv))}`);
  out(`${dim('╰')}${rule(57)}\n`);
}

function showTools() {
  if (!caps) return out(dim('  (no capabilities yet)'));
  out(`\n  ${bold('Registered tools')} ${dim('(every call passes the §8 gate chokepoint)')}`);
  for (const t of caps.tools) out(`    ${green('•')} ${t}`);
  out(`\n  ${bold('Integrations / hands')}`);
  for (const i of caps.integrations) out(`    ${blue('•')} ${i}`);
  out('');
}

function showModels() {
  const models = ollama?.tags?.models;
  if (!models) return out(dim('  (Ollama not reachable — cloud brain or Ollama stopped)'));
  out(`\n  ${bold('Installed Ollama models')}`);
  for (const m of models) {
    const d = m.details ?? {};
    const active = m.name === modelName() ? green('  ◀ active') : '';
    out(`    ${m.name.padEnd(34)} ${dim(`${bytes(m.size)} · ${d.parameter_size ?? '?'} · ${d.quantization_level ?? '?'}`)}${active}`);
  }
  out('');
}

function showMemory() {
  out(`\n  ${bold('KERNEL memory')} ${dim(MEM_DIR)}`);
  if (!fs.existsSync(MEM_DIR)) return out(red('    (memory dir not found)'));
  const subdirs = ['logs', 'working-memory', 'knowledge', 'self', 'inbox', 'quarantine'];
  let totalFiles = 0, totalBytes = 0;
  for (const sub of subdirs) {
    const dirp = path.join(MEM_DIR, sub);
    if (!fs.existsSync(dirp)) continue;
    let files = 0, size = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const fp = path.join(d, e.name);
        if (e.isDirectory()) walk(fp);
        else { files++; size += fs.statSync(fp).size; }
      }
    };
    try { walk(dirp); } catch { /* ignore */ }
    totalFiles += files; totalBytes += size;
    out(`    ${cyan((sub + '/').padEnd(16))} ${String(files).padStart(4)} files ${dim('·')} ${bytes(size)}`);
  }
  const identity = path.join(MEM_DIR, 'IDENTITY.md');
  out(`    ${cyan('IDENTITY.md'.padEnd(16))} ${fs.existsSync(identity) ? green('present (SHA-guarded)') : red('missing')}`);
  out(`    ${dim('─'.repeat(40))}`);
  out(`    ${bold('total'.padEnd(16))} ${String(totalFiles).padStart(4)} files ${dim('·')} ${bytes(totalBytes)}\n`);
}

function showHelp() {
  out(`\n  ${bold('KERNEL chat — commands')}`);
  const cmds = [
    ['/stats', 'session token/cost/throughput totals'],
    ['/tools', 'registered tools + integrations'],
    ['/models', 'installed Ollama models'],
    ['/memory', 'KERNEL memory store breakdown'],
    ['/brain cloud|local', 'switch the active brain (persists)'],
    ['/clear', 'redraw the dashboard'],
    ['/quit', 'exit'],
  ];
  for (const [c, d] of cmds) out(`    ${green(c.padEnd(20))} ${dim(d)}`);
  out('');
}

// ── socket ─────────────────────────────────────────────────────────────────────
let buf = '';
let seq = 0;
const conn = net.createConnection({ path: SOCK });

/** Print without clobbering the readline prompt the user is typing on. */
function out(text) {
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  process.stdout.write(text + '\n');
  rl.prompt(true);
}

conn.on('connect', () => process.stdout.write(dim(`connecting to ${SOCK} …\n`)));

conn.on('data', async (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let f;
    try { f = JSON.parse(line); } catch { continue; }
    await onFrame(f);
  }
});

async function onFrame(f) {
  switch (f.type) {
    case 'ready':
      break;
    case 'capabilities':
      caps = f;
      if (f.brain === 'local') await refreshOllama(f.model ?? null);
      banner();
      break;
    case 'reply':
      out(`${mag('kernel ›')} ${f.text}`);
      break;
    case 'stats': {
      lastStats = f;
      session.turns += 1;
      session.inTok += f.promptTokens ?? 0;
      session.outTok += f.outputTokens ?? 0;
      session.evalMs += f.evalMs ?? 0;
      session.cost += f.estCostUsd ?? 0;
      session.cloudEquiv += (f.promptTokens ?? 0) * CLOUD_PRICE.input + (f.outputTokens ?? 0) * CLOUD_PRICE.output;
      if (pending.has(f.id)) { session.wallMs += Date.now() - pending.get(f.id); }
      statsLine(f);
      pending.delete(f.id);
      break;
    }
    case 'error':
      out(`${red('[error]')} ${f.message}`);
      break;
    default:
      break; // speak/ui.state/transcript/breaker.* — Face concerns, ignored here
  }
}

conn.on('error', (err) => {
  process.stderr.write(
    `\n${red('[socket error]')} ${err.message}\n` +
      dim(`Is the daemon running?  launchctl print gui/$(id -u)/com.kernel.daemon | grep -E 'state|pid'\n`),
  );
  process.exit(1);
});
conn.on('close', () => { process.stdout.write(dim('\n[connection closed]\n')); process.exit(0); });

// ── REPL ──────────────────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: bold('you › ') });

rl.on('line', async (input) => {
  const text = input.trim();
  if (!text) return rl.prompt();

  if (text.startsWith('/')) {
    const [cmd, arg] = text.slice(1).split(/\s+/);
    switch (cmd) {
      case 'quit': case 'exit': return rl.close();
      case 'help': showHelp(); break;
      case 'stats': sessionTotals(); break;
      case 'tools': showTools(); break;
      case 'models': if (caps?.brain === 'local') await refreshOllama(modelName()); showModels(); break;
      case 'memory': showMemory(); break;
      case 'clear':
        if (caps?.brain === 'local') await refreshOllama(modelName());
        process.stdout.write('\x1b[2J\x1b[H');
        banner();
        break;
      case 'brain': {
        const b = (arg || '').toLowerCase();
        if (b !== 'cloud' && b !== 'local') { out(dim('  usage: /brain cloud|local')); break; }
        conn.write(JSON.stringify({ type: 'settings', brain: b }) + '\n');
        out(`  ${green('✓')} switched brain to ${bold(b)} ${dim('(persisted; reconnect to refresh the dashboard)')}`);
        if (caps) caps.brain = b;
        break;
      }
      default: out(dim(`  unknown command: /${cmd}  — try /help`));
    }
    rl.prompt();
    return;
  }

  const id = `cli-${++seq}`;
  pending.set(id, Date.now());
  conn.write(JSON.stringify({ type: 'utterance', id, text, final: true }) + '\n');
  rl.prompt();
});

rl.on('close', () => { conn.end(); process.stdout.write(dim('\nbye.\n')); process.exit(0); });
