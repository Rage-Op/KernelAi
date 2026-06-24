/**
 * build-stamp.ts (MAINT-04) — the cure for the recurring "I rebuilt but the daemon still runs the OLD
 * code" trap. The daemon runs compiled `dist/`, so `npm run build` alone changes nothing until the
 * process is restarted (the owner has had to `launchctl kickstart` by hand). This module makes that
 * automatic and diagnosable:
 *
 *   - a `postbuild` script writes dist/build-stamp.json (an ISO timestamp + git short-sha) on every build;
 *   - the daemon LOGS its boot stamp at startup so logs say exactly which build is live;
 *   - on each new IPC connection, `exitIfStale` compares the boot stamp to the on-disk stamp — if `dist`
 *     was rebuilt since boot AND we're launchd-owned (ppid 1, KeepAlive will relaunch us), it exits so
 *     launchd brings the daemon back up on the FRESH code. (Not launchd-owned → just warn.)
 *
 * In dev/test (no stamp file) the stamp reads 'dev' and `isStale` is always false — never disruptive.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BuildStamp {
  builtAt: string;
  git: string;
}

const DEV_STAMP: BuildStamp = { builtAt: 'dev', git: 'nogit' };

/** dist/build-stamp.json sits beside the compiled build-stamp.js. In src (tsx test) it's absent. */
const STAMP_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'build-stamp.json');

/** Read a stamp file; any failure (absent/malformed) yields the DEV stamp. Never throws. */
export function readStampFrom(file: string): BuildStamp {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<BuildStamp>;
    return {
      builtAt: typeof raw.builtAt === 'string' && raw.builtAt ? raw.builtAt : 'dev',
      git: typeof raw.git === 'string' && raw.git ? raw.git : 'nogit',
    };
  } catch {
    return { ...DEV_STAMP };
  }
}

/** True when two stamps describe different builds. */
export function stampsDiffer(a: BuildStamp, b: BuildStamp): boolean {
  return a.builtAt !== b.builtAt || a.git !== b.git;
}

let bootStamp: BuildStamp | null = null;

/** The stamp captured when THIS process started (cached on first read). */
export function bootBuildStamp(): BuildStamp {
  if (!bootStamp) bootStamp = readStampFrom(STAMP_FILE);
  return bootStamp;
}

/** The stamp currently on disk (re-read each call so a post-boot rebuild is visible). */
export function onDiskBuildStamp(): BuildStamp {
  return readStampFrom(STAMP_FILE);
}

/** True when `dist` was rebuilt since this process booted (and we have a real stamp to compare). */
export function isStale(): boolean {
  const boot = bootBuildStamp();
  if (boot.builtAt === 'dev') return false; // dev/test (no stamp) is never "stale"
  return stampsDiffer(boot, onDiskBuildStamp());
}

/** A minimal logger shape (so this module needn't import pino directly / stays unit-testable). */
interface StampLogger {
  warn(obj: unknown, msg: string): void;
}

/**
 * If the running code is stale, exit so launchd relaunches us on the fresh build (only when
 * launchd-owned — ppid 1 — so something WILL restart us; otherwise just warn). `exit` is injectable
 * for tests. Safe to call on every connection: it's a cheap file read and a no-op unless truly stale.
 */
export function exitIfStale(log: StampLogger, exit: (code: number) => never = process.exit): void {
  if (!isStale()) return;
  const ctx = { boot: bootBuildStamp(), disk: onDiskBuildStamp() };
  if (process.ppid === 1) {
    log.warn(ctx, 'daemon code is STALE (dist rebuilt since boot) — exiting so launchd relaunches onto fresh code');
    exit(0);
  } else {
    log.warn(ctx, 'daemon code is STALE (dist rebuilt since boot) — restart the daemon to pick it up (npm run build alone is not enough)');
  }
}
