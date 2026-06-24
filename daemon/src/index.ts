/**
 * KERNEL daemon entry point (CORE-01).
 *
 * Two modes:
 *   - `--heartbeat`  → run the short-lived heartbeat job (append a dated line) and exit.
 *   - default        → run startup guards, then start the UDS IPC server + the loop and
 *                      stay resident (the open socket keeps the process alive — NO polling
 *                      timer). launchd (RunAtLoad + KeepAlive) owns relaunch-at-login.
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
import { startIpcServer, probeDaemonAlive } from './ipc/server.js';
import { applySettings, loadPersistedBrain } from './settings.js';
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

  // SINGLE-INSTANCE GUARD: if a daemon is already listening on the socket (e.g. the launchd job),
  // do NOT start a second one. `startIpc` unlinks the stale socket before binding, which would
  // otherwise STEAL the socket from the running daemon and leave two daemons fighting over it — the
  // root cause of "the Face talks to the wrong (env-less) daemon" (no Tavily key → no internet).
  if (await probeDaemonAlive(config.socketPath)) {
    logger.warn(
      { socketPath: config.socketPath },
      'another KERNEL daemon is already listening — exiting (single-instance guard)',
    );
    process.exit(0);
  }

  // Register the built-in tools (HANDS-04) so the brain can dispatch them and the capabilities
  // frame reports them. Resilient: a tool whose module fails to load is skipped, not fatal.
  await registerBuiltinTools();
  // Choose the active brain. A persisted owner choice wins; otherwise default to the LOCAL brain
  // (qwen3.5 via Ollama) so a never-toggled owner gets a real, offline-capable, tool-using brain
  // out of the box — NOT the StubBrain placeholder or a keyless cloud brain (the "it's dumb /
  // won't use tools" report). persist=false: the value already came from disk (or is the default).
  applySettings(loadPersistedBrain() ?? 'local', false);
  // Restore the recent dialogue from the durable transcript so the model CONTINUES the conversation
  // across daemon restarts (the persisted-chat-history fix). Only turns after the last /clear are
  // restored. Best-effort; an absent/empty log just starts fresh.
  conversation.load();
  const ipc = await startIpcServer();
  // Log exactly which build is live (MAINT-04) — so "am I running stale code?" is answerable from
  // the logs, and the connection-time staleness check has a baseline to compare against.
  logger.info(
    { socketPath: config.socketPath, build: bootBuildStamp() },
    'KERNEL daemon online — IPC listening',
  );

  // Keep the process resident; gracefully close the socket on termination signals.
  const shutdown = (signal: string) => {
    logger.info({ signal }, 'KERNEL daemon shutting down');
    void ipc.close().finally(() => process.exit(0));
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
