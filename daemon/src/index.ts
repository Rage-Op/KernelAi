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
import { baselineIdentityHash, readIdentityVerified } from './memory/identity.js';
import { startIpcServer } from './ipc/server.js';
import { runHeartbeat } from './heartbeat.js';
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

  runStartupGuards();
  const ipc = await startIpcServer();
  logger.info({ socketPath: config.socketPath }, 'KERNEL daemon online — IPC listening');

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
