import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { z } from 'zod';

/**
 * Hard upper bound (chars) on the assembled session-start injection.
 * IDENTITY.md + working-memory/current.md must always fit under this cap;
 * retrieved items greedily fill the remainder. (spec §5; ROADMAP criterion 2)
 */
export const INJECT_CAP = 16384;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Resolve the kernel-memory/ directory.
 * Precedence: KERNEL_MEMORY_DIR env var → sibling ../kernel-memory of the daemon.
 * (When running compiled JS from dist/, the daemon root is one level up from dist/.)
 */
function resolveMemoryDir(): string {
  const fromEnv = process.env.KERNEL_MEMORY_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  // src/config.ts → daemon/src ; dist/config.js → daemon/dist. Either way, the
  // daemon root is the parent of this file's directory, and kernel-memory/ is its sibling.
  const daemonRoot = path.resolve(__dirname, '..');
  return path.resolve(daemonRoot, '..', 'kernel-memory');
}

/**
 * Unix-domain-socket path the Face attaches to.
 * ~/Library/Application Support/Kernel/kernel.sock  (spec §2; STACK.md)
 */
function resolveSocketPath(): string {
  return path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Kernel',
    'kernel.sock',
  );
}

/**
 * The WORKSPACE root for the `fs`/`shell` hands (HANDS-06). Writes and deletes are confined here by
 * default (reads are broader, minus secret paths — see exec-policy.ts), so the graduated computer
 * control the owner enabled cannot clobber arbitrary files. Override with KERNEL_WORKSPACE_DIR;
 * default ~/Kernel — a dedicated folder OUTSIDE the source repo (so the assistant never writes into
 * its own codebase) that the owner can open and inspect. The fs tool creates it on first use.
 */
function resolveWorkspaceDir(): string {
  const fromEnv = process.env.KERNEL_WORKSPACE_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.homedir(), 'Kernel');
}

const ConfigSchema = z.object({
  memoryDir: z
    .string()
    .min(1, 'KERNEL_MEMORY_DIR resolved to an empty path')
    .refine(
      (p: string) => fs.existsSync(p) && fs.statSync(p).isDirectory(),
      {
        error: (issue) =>
          `kernel-memory dir does not exist or is not a directory: ${String(issue.input)}`,
      },
    ),
  socketPath: z.string().min(1),
  injectCap: z.number().int().positive(),
  /** The fs/shell workspace root (HANDS-06). Not existence-checked here — the fs tool mkdir's it lazily. */
  workspaceDir: z.string().min(1),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Build + validate the typed config. Fails loud (throws) on a missing/invalid
 * memory dir so the daemon never silently runs against a phantom memory repo.
 */
function loadConfig(): Config {
  const candidate = {
    memoryDir: resolveMemoryDir(),
    socketPath: resolveSocketPath(),
    injectCap: INJECT_CAP,
    workspaceDir: resolveWorkspaceDir(),
  };
  return ConfigSchema.parse(candidate);
}

export const config: Config = loadConfig();
