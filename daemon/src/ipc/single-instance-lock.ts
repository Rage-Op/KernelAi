/**
 * single-instance-lock.ts — an OS-level PID lock guaranteeing AT MOST ONE live KERNEL daemon.
 *
 * Why this exists ON TOP of `probeDaemonAlive` (server.ts): the connect-probe only detects a
 * REACHABLE daemon. The actual multi-daemon bug is a daemon that is ALIVE but UNREACHABLE — its
 * socket file was unlink()ed while the process still holds the bound fd. The probe then reports "no
 * daemon", a second daemon starts, and you get 2-3 live daemons fighting over the socket (the "Face
 * gets no output" failure). This lock catches a live daemon REGARDLESS of socket state.
 *
 * Correctness (hardened after an adversarial review):
 *  - ATOMIC claim via O_CREAT|O_EXCL, with a READ-BACK verify after the write — so if a racing stealer
 *    unlinks-and-recreates between our create and our return, we detect it and retry (closes the
 *    two-daemons-both-acquire race).
 *  - CONDITIONAL steal — a stale (dead-holder) lock is only unlinked if it STILL holds the same dead
 *    pid we observed, so we can never delete a different daemon's freshly-created valid lock.
 *  - COMMAND-CORROBORATED liveness — a live pid only blocks us if its process is actually a resident
 *    KERNEL daemon (`dist/index.js`, no --mode flag). This defeats macOS pid REUSE: a recycled pid now
 *    assigned to an unrelated process won't masquerade as the daemon and wedge boot forever.
 *  - EXIT-ONLY release — we register ONLY a `process.once('exit')` unlink; index.ts owns SIGINT/SIGTERM
 *    so the lock never calls process.exit() and can't abort the daemon's graceful async shutdown.
 *
 * Pure node:fs + a single `ps` probe. Path/pid/liveness are injectable so unit tests never touch the
 * real lock or process table.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { config } from '../config.js';

/** The lock file path — beside the socket in App Support (NOT in the git-backed memory repo). */
export function lockPath(socketPath: string = config.socketPath): string {
  return path.join(path.dirname(socketPath), 'daemon.pid');
}

/**
 * Is a process with this pid currently alive? `process.kill(pid, 0)` sends NO signal — it only checks
 * existence. ESRCH → dead; EPERM → alive but owned by another user (still alive); success → alive.
 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Is `pid` actually a RESIDENT KERNEL daemon — i.e. alive AND its process command runs `dist/index.js`
 * with NO `--mode` flag (the maintenance jobs run `dist/index.js --heartbeat|--consolidate|…`)? This
 * corroborates liveness by command so a REUSED pid (macOS recycles pids) can't masquerade as the
 * daemon and block boot forever. If `ps` is unavailable, fail SAFE (treat as live → don't double-start).
 */
export function pidIsResidentDaemon(pid: number): boolean {
  if (!pidAlive(pid)) return false;
  try {
    const res = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    if (res.status !== 0) return false; // no such process row → not our daemon (recycled/dead)
    const cmd = (res.stdout ?? '').trim();
    if (!cmd) return false;
    return cmd.includes('dist/index.js') && !/\s--\S/.test(cmd); // resident = no --mode flag
  } catch {
    return true; // ps blew up — assume live to preserve the single-instance guarantee
  }
}

/** The outcome of trying to acquire the lock. */
export interface LockResult {
  /** True if we now own the lock. */
  acquired: boolean;
  /** When not acquired, the live pid that holds it (when known). */
  heldByPid?: number;
}

/** Read the pid recorded in the lock file, or null if absent/unreadable/garbage. */
function readHolder(p: string): number | null {
  try {
    const n = parseInt(fs.readFileSync(p, 'utf8').trim(), 10);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

let releaseRegistered = false;

/** Register ONE-shot release of OUR lock on process exit. We deliberately do NOT handle SIGINT/SIGTERM
 *  here — index.ts owns those (graceful ipc.close → process.exit), and `process.exit` fires 'exit',
 *  so our unlink still runs without us racing/aborting the daemon's shutdown. */
function registerRelease(p: string, pid: number): void {
  if (releaseRegistered) return;
  releaseRegistered = true;
  process.once('exit', () => {
    try {
      if (readHolder(p) === pid) fs.unlinkSync(p); // only ever remove OUR OWN lock
    } catch {
      /* already gone */
    }
  });
}

/**
 * Try to acquire the single-instance lock.
 *   - { acquired: true }              → we own it (fresh, stolen-stale, or re-entrant).
 *   - { acquired: false, heldByPid }  → a live resident daemon already holds it; the caller must exit.
 * `holderIsLive` decides whether an existing holder blocks us (default: it is a resident KERNEL
 * daemon). Injectable for tests.
 */
export function acquireSingleInstanceLock(
  p: string = lockPath(),
  pid: number = process.pid,
  holderIsLive: (holderPid: number) => boolean = pidIsResidentDaemon,
): LockResult {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  for (let attempt = 0; attempt < 50; attempt++) {
    // 1. Atomic create-exclusive — wins the race iff the file does not yet exist.
    try {
      const fd = fs.openSync(p, 'wx'); // wx = O_WRONLY | O_CREAT | O_EXCL
      fs.writeSync(fd, String(pid));
      fs.closeSync(fd);
      // READ-BACK verify: a racing stealer could have unlinked + recreated between our create and now.
      if (readHolder(p) === pid) {
        registerRelease(p, pid);
        return { acquired: true };
      }
      continue; // lost the race after creating — retry
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e;
    }
    // 2. The file exists — inspect the holder.
    const holder = readHolder(p);
    if (holder == null) continue; // a concurrent release removed it — retry the create
    if (holder === pid) {
      registerRelease(p, pid); // re-entrant: we already hold it
      return { acquired: true };
    }
    if (holderIsLive(holder)) {
      return { acquired: false, heldByPid: holder };
    }
    // 3. Stale lock (dead/recycled holder) — steal CONDITIONALLY: only unlink if it STILL holds the
    //    same dead pid we saw, so we can never delete a different daemon's just-created valid lock.
    try {
      if (readHolder(p) === holder) fs.unlinkSync(p);
    } catch {
      /* someone else stole/removed it first — retry */
    }
  }
  // Couldn't settle the race after many attempts — fail safe (treat as held, don't start a 2nd daemon).
  return { acquired: false };
}
