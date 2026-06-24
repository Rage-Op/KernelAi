/**
 * safety/owner-config.ts — the OWNER-CONFIGURABLE safety posture (SAFE-08, the control surface).
 *
 * Until now three knobs were read ONLY from the environment, so the owner could not change them
 * from the app:
 *   - the Red breaker on/off flag (safety/flags.ts ← KERNEL_BREAKER_ENABLED)
 *   - the daily spend ceiling     (tools/registry.ts ← KERNEL_DAILY_SPEND_CEILING)
 *   - the /override default TTL    (ipc/server.ts hardcoded 600_000)
 * This module makes them PERSISTED owner settings the Face can read and update over IPC
 * (`settings.update` / `settings.state`), so "tiered access" is configurable, not a redeploy.
 *
 * Persistence mirrors settings.ts EXACTLY: a tiny JSON file (`safety-config.json`) in the daemon's
 * Application Support dir — next to the UDS socket and brain.json, NOT the git-backed memory repo
 * (it is a posture preference, never a memory, and must never be backed up). The path is injectable
 * so tests never touch the real Application Support dir.
 *
 * Precedence: a PERSISTED owner choice (the deliberate Face toggle) wins over the environment, which
 * only provides the initial default for a fresh install (same model as brain.json over the loop
 * default). The live Red-breaker flag the gate reads (FLAGS.breakerEnabled, flags.ts) is kept in
 * sync here — this module is the single writer of that field outside tests.
 *
 * SAFETY: enabling the breaker is NECESSARY but not SUFFICIENT for a Red action to run unattended —
 * the dry-run preview still broadcasts and (with a Face connected) the owner gets the 10s cancel
 * window; the ceiling + audit still gate spend. Default OFF preserves the deny-Red posture until the
 * owner deliberately flips it on from the Settings UI.
 */
import fs from 'node:fs';
import path from 'node:path';

import { config } from '../config.js';
import { logger } from '../memory/log.js';
import { FLAGS } from './flags.js';

/** The owner-configurable safety posture. */
export interface OwnerConfig {
  /** Master switch for the live Red breaker (false → Red denies, the P1-P4 posture). */
  breakerEnabled: boolean;
  /** Daily spend ceiling (USD) the breaker reserves against. 0 = no spend permitted. */
  dailySpendCeiling: number;
  /** Default /override TTL in ms when the Face omits one. */
  defaultTtlMs: number;
}

const DEFAULT_TTL_MS = 600_000; // 10 minutes

/** Parse a numeric env var; returns `fallback` when unset/blank/NaN. */
function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** The live, in-memory config — seeded from the environment (the fresh-install default). */
let current: OwnerConfig = {
  breakerEnabled: process.env.KERNEL_BREAKER_ENABLED === 'true',
  dailySpendCeiling: envNum('KERNEL_DAILY_SPEND_CEILING', 0),
  defaultTtlMs: envNum('KERNEL_OVERRIDE_TTL_MS', DEFAULT_TTL_MS),
};

/** TEST-ONLY override of the persistence file path (null → the real Application Support path). */
let configPathOverride: string | null = null;

/** TEST-ONLY seam: redirect safety-config.json to a tmp path (or null to reset). */
export function __setOwnerConfigPathForTest(p: string | null): void {
  configPathOverride = p;
}

/** Where the safety posture persists: `safety-config.json` next to the UDS socket / brain.json. */
function ownerConfigPath(): string {
  return configPathOverride ?? path.join(path.dirname(config.socketPath), 'safety-config.json');
}

/** A read-only snapshot of the live owner config (for the `settings.state` frame + inspection). */
export function ownerConfig(): Readonly<OwnerConfig> {
  return { ...current };
}

/** The daily spend ceiling the breaker reserves against (registry.ts reads this, not the env). */
export function dailySpendCeiling(): number {
  return current.dailySpendCeiling;
}

/** The default /override TTL (server.ts reads this when the Face omits a ttl). */
export function defaultOverrideTtlMs(): number {
  return current.defaultTtlMs;
}

/** Persist the live config (best-effort; a write failure is logged, never fatal). */
function persist(): void {
  try {
    const file = ownerConfigPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(current) + '\n', 'utf8');
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'failed to persist owner safety config',
    );
  }
}

/** Read the persisted config; null when absent/unreadable/invalid. Validates each field's type. */
export function loadPersistedOwnerConfig(): Partial<OwnerConfig> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(ownerConfigPath(), 'utf8')) as Record<string, unknown>;
    const out: Partial<OwnerConfig> = {};
    if (typeof parsed.breakerEnabled === 'boolean') out.breakerEnabled = parsed.breakerEnabled;
    if (typeof parsed.dailySpendCeiling === 'number' && Number.isFinite(parsed.dailySpendCeiling)) {
      out.dailySpendCeiling = parsed.dailySpendCeiling;
    }
    if (typeof parsed.defaultTtlMs === 'number' && Number.isFinite(parsed.defaultTtlMs) && parsed.defaultTtlMs > 0) {
      out.defaultTtlMs = parsed.defaultTtlMs;
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null; // absent / unreadable / corrupt → no persisted choice
  }
}

/**
 * Apply a (partial) owner config: merge the provided fields, SYNC the live breaker flag the gate
 * reads (FLAGS.breakerEnabled), and persist unless told otherwise. Unknown/undefined fields are
 * left untouched, so the Face can update one toggle at a time. Returns the new full config.
 */
export function applyOwnerConfig(partial: Partial<OwnerConfig>, persistChoice = true): OwnerConfig {
  if (typeof partial.breakerEnabled === 'boolean') current.breakerEnabled = partial.breakerEnabled;
  if (typeof partial.dailySpendCeiling === 'number' && Number.isFinite(partial.dailySpendCeiling)) {
    current.dailySpendCeiling = Math.max(0, partial.dailySpendCeiling);
  }
  if (typeof partial.defaultTtlMs === 'number' && Number.isFinite(partial.defaultTtlMs) && partial.defaultTtlMs > 0) {
    current.defaultTtlMs = partial.defaultTtlMs;
  }
  // The gate reads FLAGS.breakerEnabled live — this module is its single writer outside tests.
  FLAGS.breakerEnabled = current.breakerEnabled;
  if (persistChoice) persist();
  return { ...current };
}

/**
 * Restore the persisted owner config on daemon startup (a persisted choice wins over the env
 * default). ALWAYS syncs FLAGS.breakerEnabled to the resolved value so the gate's live flag reflects
 * the owner's posture (env default when nothing persisted). A no-op-safe call for a fresh install.
 */
export function restoreOwnerConfig(): void {
  const saved = loadPersistedOwnerConfig();
  // Sync the flag (and apply any persisted overrides) WITHOUT re-persisting — the value came from
  // disk or is the env-seeded default.
  applyOwnerConfig(saved ?? {}, false);
}
