/**
 * register-builtins.ts — load the built-in tool modules so they self-register (HANDS-04).
 *
 * Each tool module (`browser`, `mail`, `peekaboo`, `finance`) calls `register(<tool>)` at module
 * eval time, so a tool only enters the registry once its module is imported. Nothing on the daemon's
 * runtime path imported them before, so the registry was empty at startup — the brain's action
 * dispatch would default-deny every tool as "unknown", and the capabilities frame showed none.
 * `registerBuiltinTools()` (called once from `main()`) imports all four.
 *
 * Resilient by design: each import is awaited independently in its own try/catch, so a tool whose
 * module fails to load (e.g. a missing native dep on a given machine) is logged and SKIPPED without
 * preventing the others from registering or crashing the daemon. Importing a module never executes
 * a tool — `execute` still only runs through `registry.dispatch` after `gate.authorize` (HANDS-05).
 */
import { logger } from '../memory/log.js';
import { listTools } from './registry.js';

const BUILTIN_TOOL_MODULES = [
  './browser.js',
  './mail.js',
  './peekaboo.js',
  './finance.js',
  './web.js',
  // HANDS-06 — graduated, tier-gated computer control (read-only GREEN, writes YELLOW, destructive
  // RED → breaker). Self-register like the others; the gate enforces the tier on every call.
  './fs.js',
  './shell.js',
] as const;

/** Import every built-in tool module so it self-registers. Idempotent; safe to call once at boot. */
export async function registerBuiltinTools(): Promise<string[]> {
  for (const mod of BUILTIN_TOOL_MODULES) {
    try {
      await import(mod);
    } catch (err) {
      logger.warn(
        { mod, err: err instanceof Error ? err.message : String(err) },
        'tool module failed to load — skipping (its capability will be unavailable)',
      );
    }
  }
  const tools = listTools();
  logger.info({ tools }, 'built-in tools registered');
  return tools;
}
