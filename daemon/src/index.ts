/**
 * KERNEL daemon entry point (CORE-01).
 *
 * Two modes:
 *   - `--heartbeat`  → run the short-lived heartbeat job (append a dated line) and exit.
 *   - default        → run startup guards, then start the daemon-hosted WEB face transport (HTTP+SSE)
 *                      + the loop and stay resident (the listening HTTP server keeps the process alive —
 *                      NO polling timer). launchd (RunAtLoad + KeepAlive) owns relaunch-at-login.
 *
 * Startup guards (fail loud — the daemon refuses to serve if either trips):
 *   1. IDENTITY integrity: baseline the SHA-256 on first run, then verify on every start;
 *      an out-of-band change throws IdentityIntegrityError (T-01-11 / MEM-02).
 *   2. Finance assertion: `git -C <memoryDir> ls-files | grep -i finance` must be empty;
 *      anything finance-pathed being tracked fails loud (T-01-12 / MEM-06).
 */
import { config } from './config.js';
import { logger } from './memory/log.js';
import { bootBuildStamp } from './build-stamp.js';
import { baselineIdentityHash, readIdentityVerified } from './memory/identity.js';
import {
  wireBroadcasts,
  broadcastBrowser,
  anyBrowserViewers,
  setBrowserViewSync,
} from './ipc/server.js';
import { startWebServer } from './web/http-server.js';
import { configureBrowserView, syncScreencast } from './tools/browser-view.js';
import { acquireSingleInstanceLock, lockPath } from './ipc/single-instance-lock.js';
import { applySettings, loadPersistedBrain, currentBrainSelection } from './settings.js';
import { restoreOwnerConfig } from './safety/owner-config.js';
import { warmupActiveBrain } from './brain/readiness.js';
import { conversation } from './memory/conversation.js';
import { registerBuiltinTools } from './tools/register-builtins.js';
import { runHeartbeat } from './heartbeat.js';
import { runConsolidation } from './memory/consolidate.js';
import { runCleanup } from './memory/prune.js';
import { runBackup } from './memory/backup.js';
import { assertFinanceNotTracked as leakguardAssert } from './safety/leakguard.js';

/**
 * IDENTITY integrity guard. On first run records the SHA-256 baseline; thereafter any
 * out-of-band edit makes readIdentityVerified throw (fail loud). Returns the verified text.
 */
function guardIdentity(memoryDir: string = config.memoryDir): string {
  baselineIdentityHash(memoryDir); // idempotent: seed only when absent
  return readIdentityVerified(memoryDir); // throws IdentityIntegrityError on tamper
}

/**
 * Finance assertion (MEM-06): refuse to start if anything finance-pathed is git-tracked
 * in the memory repo. Cheap fourth layer of the §14 defense — the directory cannot be
 * accidentally committed when Phase 4 creates it. A non-git memory dir is tolerated
 * (greenfield/test); only an ACTUAL tracked finance path fails loud.
 */
export function assertFinanceNotTracked(memoryDir: string = config.memoryDir): void {
  // Delegate to the directly-tested safety/leakguard module (single source of truth, FIN-04d).
  // Behavior is identical: throws on a real tracked finance path; tolerates a non-git dir.
  leakguardAssert(memoryDir);
}

/** Run all startup guards. Throws (fail loud) if any guard trips. */
export function runStartupGuards(memoryDir: string = config.memoryDir): void {
  guardIdentity(memoryDir);
  assertFinanceNotTracked(memoryDir);
  logger.info({ memoryDir }, 'startup guards passed: IDENTITY verified, finance untracked');
}

/**
 * Boot the resident daemon: run guards, start the IPC server (which wires inbound frames
 * to the loop), and stay alive on the open socket. No setInterval — the loop falls idle.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes('--heartbeat')) {
    await runHeartbeat();
    process.exit(0);
  }

  // Short-lived self-maintenance job modes (MAINT-03) — each runs the job and exits, exactly
  // like --heartbeat. The default resident mode below is untouched (SAFE-07 behavior-preserving).
  if (argv.includes('--consolidate')) {
    await runConsolidation();
    process.exit(0);
  }
  if (argv.includes('--cleanup')) {
    await runCleanup();
    process.exit(0);
  }
  if (argv.includes('--backup')) {
    await runBackup();
    process.exit(0);
  }

  runStartupGuards();

  // SINGLE-INSTANCE GUARD — the PID LOCK (authoritative). A daemon can be ALIVE yet otherwise hard to
  // detect, so a connect/port probe is unreliable; the PID lock catches a live daemon regardless. If
  // another live resident KERNEL daemon holds the lock we exit; a stale lock (dead pid, e.g. after
  // kill -9) is stolen and we take over. (The web server's own bind on :7777 is the secondary guard —
  // a second daemon would fail to bind the port and exit loud.)
  const lock = acquireSingleInstanceLock();
  if (!lock.acquired) {
    logger.warn(
      { heldByPid: lock.heldByPid, lockPath: lockPath() },
      'another KERNEL daemon already holds the single-instance lock — exiting (PID guard)',
    );
    process.exit(0);
  }

  // Register the built-in tools (HANDS-04) so the brain can dispatch them and the capabilities
  // frame reports them. Resilient: a tool whose module fails to load is skipped, not fatal.
  await registerBuiltinTools();
  // Wire the live browser screencast (web Face's "watch the browser" pane) to the IPC layer: it pushes
  // frames only to web viewers (broadcastBrowser), checks who's watching (anyBrowserViewers), and the
  // server triggers syncScreencast whenever the viewer set changes. Injected here so browser-view never
  // imports the server (no cycle) and the screencast runs only while a pane is open.
  configureBrowserView({ broadcast: broadcastBrowser, hasViewers: anyBrowserViewers });
  setBrowserViewSync(() => {
    void syncScreencast();
  });
  // Wire the server→client broadcast seams (Red breaker preview + model warm-up readiness) to the shared
  // broadcast() BEFORE the web server starts, so a client connecting mid-warm-up still sees progress.
  // (This wiring previously lived inside the UDS startIpc(); the web transport owns the socket now.)
  wireBroadcasts();
  // Choose the active brain. A persisted owner choice wins; otherwise default to the LOCAL brain
  // (LM Studio) so a never-toggled owner gets a real, offline-capable, tool-using brain out of the
  // box — NOT the StubBrain placeholder or a keyless cloud brain (the "it's dumb / won't use tools"
  // report). A persisted Ollama `local` choice is migrated to `lmstudio` on load. persist=false: the
  // value already came from disk (or is the default).
  applySettings(loadPersistedBrain() ?? 'lmstudio', false);
  // Restore the owner's persisted SAFETY posture (SAFE-08): the Red breaker on/off flag, the daily
  // spend ceiling, and the /override default TTL. Syncs the live gate flag (FLAGS.breakerEnabled) so
  // the gate honours the owner's choice; a fresh install keeps the safe env/default (breaker OFF).
  restoreOwnerConfig();
  // Restore the recent dialogue from the durable transcript so the model CONTINUES the conversation
  // across daemon restarts (the persisted-chat-history fix). Only turns after the last /clear are
  // restored. Best-effort; an absent/empty log just starts fresh.
  conversation.load();
  // Start the daemon-hosted WEB Face transport (HTTP + SSE on 127.0.0.1) — now the SOLE transport.
  // It bridges the frozen frame contract into the loop/gate (gate/tools/MCP/memory preserved). If it
  // can't bind (e.g. the port is held by a non-KERNEL process), the daemon has no UI and no reason to
  // stay resident, so fail loud and let launchd relaunch.
  let web: Awaited<ReturnType<typeof startWebServer>>;
  try {
    web = await startWebServer();
    // SECURITY: never log web.url — it embeds the secret token, and this line is captured into
    // daemon.out.log (a 0644 file). Log only the token-less address; the token lives in its 0600 file.
    logger.info(
      { addr: `http://127.0.0.1:${web.port}` },
      'KERNEL web face online — run `./kernel-up.sh` (or read the web-token file) to open it',
    );
  } catch (err) {
    logger.fatal(
      { err: err instanceof Error ? err.message : String(err) },
      'web face failed to start — no transport available, exiting',
    );
    process.stderr.write(
      `[index] FATAL: web face failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
  // Log exactly which build is live (MAINT-04) — so "am I running stale code?" is answerable from
  // the logs, and the connection-time staleness check has a baseline to compare against.
  logger.info(
    { addr: `http://127.0.0.1:${web.port}`, build: bootBuildStamp() },
    'KERNEL daemon online — web face listening',
  );

  // BRAIN-07: start warming the active model the moment we're online — by the time the Face connects
  // (or right after, mid-warm-up) the model is loading or already resident, so the boot screen can
  // gate on `model.state:ready` and the owner's first prompt is never a cold start. Fire-and-forget:
  // progress broadcasts as `model.state` frames; a warm-up failure resolves to `error` (never throws).
  void warmupActiveBrain(currentBrainSelection());

  // Keep the process resident; gracefully close the web server on termination signals.
  const shutdown = (signal: string) => {
    logger.info({ signal }, 'KERNEL daemon shutting down');
    void web.close().catch(() => {}).finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Run only when executed directly (not when imported by tests).
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    // Fail loud: a tripped startup guard or listen error must surface to stderr/launchd.
    logger.fatal({ err: err instanceof Error ? err.message : String(err) }, 'KERNEL daemon failed to start');
    process.stderr.write(
      `[index] FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
