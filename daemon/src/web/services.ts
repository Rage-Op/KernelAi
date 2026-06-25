/**
 * services.ts — the daemon-side control plane for the web Face's "background services" panel.
 *
 * Lets the owner see + stop the background pieces KERNEL leans on: Ollama, the LM Studio server, the
 * Playwright browser, and any STRAY duplicate KERNEL daemons (the old multi-instance footgun). This is
 * a CONTROL surface, not a model capability — it is reached only over the token-gated, loopback-bound
 * web server by the owner, never by the model's gated `shell` tool. Even so it is hard-allowlisted: only
 * the four known service names + the `stop` action are honored; anything else is refused. There is NO
 * path here to run an arbitrary command from the browser.
 */
import net from 'node:net';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { logger } from '../memory/log.js';
import { livePageOrNull, closeBrowser } from '../tools/browser.js';

/** One service row the web panel renders. */
export interface ServiceInfo {
  name: string;
  label: string;
  running: boolean;
  pid?: number;
  detail?: string;
  actions: string[];
}

const LMS = path.join(os.homedir(), '.lmstudio', 'bin', 'lms');

/** Quick loopback TCP probe (is something listening on this port?). Resolves false on any error/timeout. */
function probePort(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    const done = (v: boolean): void => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(v);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(timeoutMs, () => done(false));
  });
}

/** Run a fixed command (execFile — no shell, no injection). Resolves with exit code + combined output. */
function run(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, out: `${stdout ?? ''}${stderr ?? ''}` });
    });
  });
}

/** PIDs whose command line matches `pattern` (pgrep -f). Empty on no match / no pgrep. */
async function pgrepPids(pattern: string): Promise<number[]> {
  const { out } = await run('pgrep', ['-f', pattern]);
  return out
    .split('\n')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n));
}

/** Other KERNEL daemon PIDs (the multi-instance footgun) — `dist/index.js` processes that are not us. */
async function strayDaemonPids(): Promise<number[]> {
  return (await pgrepPids('dist/index.js')).filter((p) => p !== process.pid);
}

/** The live status of every controllable background service. */
export async function listServices(): Promise<ServiceInfo[]> {
  const [ollamaUp, lmsUp, ollamaPids, strays] = await Promise.all([
    probePort(11434),
    probePort(1234),
    pgrepPids('[o]llama'),
    strayDaemonPids(),
  ]);
  const page = livePageOrNull();
  let browserUrl = 'closed';
  if (page) {
    try {
      browserUrl = page.url() || 'open';
    } catch {
      browserUrl = 'open';
    }
  }
  return [
    {
      name: 'ollama',
      label: 'Ollama — local model server',
      running: ollamaUp,
      pid: ollamaPids[0],
      detail: ollamaUp ? 'listening on :11434' : 'not running',
      actions: ollamaUp ? ['stop'] : [],
    },
    {
      name: 'lmstudio',
      label: 'LM Studio — model server',
      running: lmsUp,
      detail: lmsUp ? 'listening on :1234' : 'not running',
      actions: lmsUp ? ['stop'] : [],
    },
    {
      name: 'browser',
      label: 'Playwright browser (Chromium)',
      running: !!page,
      detail: page ? browserUrl : 'closed',
      actions: page ? ['stop'] : [],
    },
    {
      name: 'stray-daemons',
      label: 'Stray KERNEL daemons',
      running: strays.length > 0,
      detail: strays.length ? `duplicate PIDs ${strays.join(', ')}` : 'none — single instance ✓',
      actions: strays.length ? ['stop'] : [],
    },
  ];
}

/**
 * Perform an allowlisted action on a service. Returns a short human-readable outcome. Hard-allowlisted:
 * unknown name or non-`stop` action is refused. Best-effort — a failure is reported, never thrown.
 */
export async function runServiceAction(name: string, action: string): Promise<string> {
  if (action !== 'stop') return `unsupported action: ${action}`;
  switch (name) {
    case 'ollama': {
      await run('pkill', ['-x', 'ollama']);
      await run('pkill', ['-f', 'ollama runner']);
      logger.info({ service: 'ollama' }, 'service stopped via web control');
      return 'Ollama stopped';
    }
    case 'lmstudio': {
      const { code, out } = await run(LMS, ['server', 'stop']);
      logger.info({ service: 'lmstudio', code }, 'lm studio server stop requested');
      return code === 0 ? 'LM Studio server stopped' : `LM Studio stop: ${out.trim().slice(0, 80) || 'failed'}`;
    }
    case 'browser': {
      try {
        await closeBrowser();
      } catch {
        /* best-effort */
      }
      logger.info({ service: 'browser' }, 'playwright browser closed via web control');
      return 'Browser closed';
    }
    case 'stray-daemons': {
      const strays = await strayDaemonPids();
      let killed = 0;
      for (const pid of strays) {
        try {
          process.kill(pid, 'SIGTERM');
          killed++;
        } catch {
          /* already gone */
        }
      }
      logger.info({ service: 'stray-daemons', killed }, 'stray daemons terminated via web control');
      return `Terminated ${killed} stray daemon${killed === 1 ? '' : 's'}`;
    }
    default:
      return `unknown service: ${name}`;
  }
}
