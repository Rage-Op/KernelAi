#!/usr/bin/env node
/**
 * kernel-status.mjs — the plug-and-play "is a daemon running, and is it ready?" one-liner.
 *
 *   npm run status         (or: node scripts/kernel-status.mjs)
 *
 * Connects to the UDS socket, collects the connect-burst frames the daemon pushes (ready,
 * capabilities, model.state, settings.state) for a moment, prints a clean report, and exits:
 *   exit 0 = a daemon is listening   ·   exit 1 = nothing is listening (safe to start one)
 *
 * No daemon dependency — pure socket client, mirrors scripts/chat.mjs. Designed to be the single
 * answer to "do I already have one running?" so you never start a second by accident.
 */
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const SOCK =
  process.env.KERNEL_SOCKET ??
  path.join(os.homedir(), 'Library', 'Application Support', 'Kernel', 'kernel.sock');

const C = (n) => (s) => `\x1b[${n}m${s}\x1b[0m`;
const dim = C(2), green = C(32), red = C(31), yellow = C(33), bold = C(1);

function dot(ok) {
  return ok === true ? green('●') : ok === false ? red('●') : yellow('●');
}

const frames = [];
const sock = net.createConnection(SOCK);
let buf = '';
let settled = false;

const finish = (alive) => {
  if (settled) return;
  settled = true;
  sock.removeAllListeners();
  sock.destroy();
  report(alive);
};

sock.once('connect', () => {
  // Give the daemon a beat to push its connect-burst (ready → capabilities → model.state → …).
  setTimeout(() => finish(true), 600);
});
sock.once('error', () => finish(false));
sock.setTimeout(2000, () => finish(frames.length > 0));

sock.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) {
      try { frames.push(JSON.parse(line)); } catch { /* skip */ }
    }
  }
});

function find(type) {
  return frames.filter((f) => f && f.type === type).pop();
}

function report(alive) {
  console.log('');
  if (!alive) {
    console.log(`${dot(false)} ${bold('KERNEL daemon')}: ${red('not running')}`);
    console.log(dim(`  socket: ${SOCK} (no listener)`));
    console.log(dim('  start it:  launchctl kickstart -k gui/$(id -u)/com.kernel.daemon'));
    console.log(dim('         or:  cd ~/KernelAi/daemon && npm start'));
    console.log('');
    process.exit(1);
  }

  const caps = find('capabilities');
  const model = find('model.state');
  const ready = model?.status === 'ready';

  console.log(`${dot(true)} ${bold('KERNEL daemon')}: ${green('running')} ${dim(`(${SOCK})`)}`);
  if (caps) {
    console.log(`  ${dim('brain   ')} ${caps.brain}  ${dim(`· ${caps.tools?.length ?? 0} tools · ${caps.integrations?.length ?? 0} integrations`)}`);
  }
  if (model) {
    const mdot = model.status === 'ready' ? dot(true) : model.status === 'error' ? dot(false) : dot(null);
    const color = model.status === 'ready' ? green : model.status === 'error' ? red : yellow;
    console.log(`  ${dim('model   ')} ${mdot} ${color(model.status)}${model.model ? dim(` (${model.model})`) : ''}`);
    if (model.detail) console.log(dim(`           ${model.detail}`));
  } else {
    console.log(`  ${dim('model   ')} ${dot(null)} ${yellow('unknown (older daemon — rebuild to report readiness)')}`);
  }
  console.log('');
  process.exit(ready || !model ? 0 : 0); // running is success even mid-load; readiness shown above
}
