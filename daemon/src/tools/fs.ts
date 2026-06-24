/**
 * tools/fs.ts (HANDS-06) — KERNEL's filesystem hands: read/list/stat (GREEN), write/edit/mkdir/move
 * (YELLOW), delete (RED → the live breaker). The brain references this via ToolCall.tool='fs'.
 *
 * Tier is assigned CENTRALLY by classifyTier (tiers.ts) from `op`, and the gate is the only path to
 * execute — this file never self-authorizes. What it DOES enforce (the guards the gate can't, mirroring
 * how web.ts declines on a missing key) are the two filesystem-specific safety rules:
 *   - SECRET FENCE: any read OR write of a credential/key path (~/.kernel.env, ~/.ssh, *.pem, keychains)
 *     is refused outright (exec-policy.isSecretPath) — KERNEL never touches the owner's secrets.
 *   - WORKSPACE SCOPE: write/edit/mkdir/move/delete are confined to the workspace root
 *     (config.workspaceDir) so graduated hands cannot clobber arbitrary files. Reads are broader (any
 *     non-secret absolute path) so the model can actually look things up.
 *
 * Never throws across the dispatch boundary — every failure is a typed escalation.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { register } from './registry.js';
import type { Tool, ToolResult } from './Tool.js';
import { logger } from '../memory/log.js';
import { config } from '../config.js';
import { isSecretPath, isWithin, resolveUserPath } from '../safety/exec-policy.js';

/** Cap a file read so a huge file can't blow the small model's context window. */
const MAX_READ_BYTES = 64 * 1024;
/** Cap directory listings. */
const MAX_LIST_ENTRIES = 500;

export const fsArgsSchema = z
  .object({
    op: z.enum(['read', 'list', 'stat', 'write', 'edit', 'mkdir', 'move', 'delete']),
    /** Target path (most ops). `~` and relative paths resolve against the workspace root. */
    path: z.string().optional(),
    /** Full file contents (op=write). */
    content: z.string().optional(),
    /** Exact substring to replace (op=edit). */
    find: z.string().optional(),
    /** Replacement text (op=edit). */
    replace: z.string().optional(),
    /** Destination path (op=move). */
    dest: z.string().optional(),
  })
  .strict();

type FsArgs = z.infer<typeof fsArgsSchema>;

/** The model-facing description (curated for a small model — short, with the safety rules stated). */
export const FS_TOOL_DESCRIPTION =
  'Read and write files on this Mac. ops: read (a file), list (a directory), stat (file info), write ' +
  '(create/overwrite a file), edit (replace text in a file), mkdir, move, delete. You can READ any ' +
  "non-secret path; writing/deleting is limited to KERNEL's workspace folder. Deleting needs the " +
  "owner's approval. Use this to inspect or produce real files for the owner.";

const esc = (reason: string, recommendation?: string): ToolResult => ({
  ok: false,
  escalation: { reason, ...(recommendation ? { recommendation } : {}) },
});

/** Resolve the user path against the workspace root, applying the secret fence (read + write). */
function resolveAndFence(p: string | undefined): { abs: string } | ToolResult {
  if (!p || !p.trim()) return esc('fs: a `path` is required.');
  const abs = resolveUserPath(p, config.workspaceDir);
  if (isSecretPath(abs)) {
    return esc(
      `refusing to access a credential/secret path (${path.basename(abs)}).`,
      'KERNEL never reads or writes secrets; Pravin handles those directly.',
    );
  }
  return { abs };
}

/** A mutating op must stay inside the workspace root. Returns an escalation if it escapes. */
function requireWorkspace(abs: string, op: string): ToolResult | null {
  if (!isWithin(config.workspaceDir, abs)) {
    return esc(
      `fs ${op} is confined to the workspace (${config.workspaceDir}); "${abs}" is outside it.`,
      'Work inside the workspace, or ask Pravin to widen KERNEL_WORKSPACE_DIR.',
    );
  }
  return null;
}

async function ensureWorkspace(): Promise<void> {
  await fsp.mkdir(config.workspaceDir, { recursive: true });
}

export const fsTool: Tool = {
  name: 'fs',
  schema: fsArgsSchema,
  async execute(args): Promise<ToolResult> {
    const a = args as FsArgs;
    const resolved = resolveAndFence(a.path);
    if ('ok' in resolved) return resolved; // escalation (missing path / secret)
    const abs = resolved.abs;

    try {
      switch (a.op) {
        case 'read': {
          const stat = await fsp.stat(abs);
          if (!stat.isFile()) return esc(`fs read: "${abs}" is not a file.`);
          const buf = await fsp.readFile(abs);
          const truncated = buf.byteLength > MAX_READ_BYTES;
          const content = buf.subarray(0, MAX_READ_BYTES).toString('utf8');
          return { ok: true, data: { op: 'read', path: abs, bytes: stat.size, truncated, content } };
        }
        case 'list': {
          const entries = await fsp.readdir(abs, { withFileTypes: true });
          const items = entries
            .slice(0, MAX_LIST_ENTRIES)
            .map((e) => ({ name: e.name, kind: e.isDirectory() ? 'dir' : 'file' }));
          return { ok: true, data: { op: 'list', path: abs, count: entries.length, items } };
        }
        case 'stat': {
          const stat = await fsp.stat(abs);
          return {
            ok: true,
            data: {
              op: 'stat', path: abs, kind: stat.isDirectory() ? 'dir' : 'file',
              bytes: stat.size, modified: stat.mtime.toISOString(),
            },
          };
        }
        case 'write': {
          const outside = requireWorkspace(abs, 'write');
          if (outside) return outside;
          if (typeof a.content !== 'string') return esc('fs write: `content` is required.');
          await ensureWorkspace();
          await fsp.mkdir(path.dirname(abs), { recursive: true });
          await fsp.writeFile(abs, a.content, 'utf8');
          logger.info({ tool: 'fs', op: 'write' }, 'fs: wrote file');
          return { ok: true, data: { op: 'write', path: abs, bytes: Buffer.byteLength(a.content) } };
        }
        case 'edit': {
          const outside = requireWorkspace(abs, 'edit');
          if (outside) return outside;
          if (typeof a.find !== 'string' || a.find.length === 0) return esc('fs edit: a non-empty `find` is required.');
          if (typeof a.replace !== 'string') return esc('fs edit: `replace` is required.');
          const current = await fsp.readFile(abs, 'utf8');
          if (!current.includes(a.find)) return esc('fs edit: `find` text was not found in the file.');
          const next = current.split(a.find).join(a.replace);
          await fsp.writeFile(abs, next, 'utf8');
          logger.info({ tool: 'fs', op: 'edit' }, 'fs: edited file');
          return { ok: true, data: { op: 'edit', path: abs, replacements: current.split(a.find).length - 1 } };
        }
        case 'mkdir': {
          const outside = requireWorkspace(abs, 'mkdir');
          if (outside) return outside;
          await fsp.mkdir(abs, { recursive: true });
          return { ok: true, data: { op: 'mkdir', path: abs } };
        }
        case 'move': {
          const outsideSrc = requireWorkspace(abs, 'move');
          if (outsideSrc) return outsideSrc;
          const destResolved = resolveAndFence(a.dest);
          if ('ok' in destResolved) return destResolved;
          const outsideDest = requireWorkspace(destResolved.abs, 'move');
          if (outsideDest) return outsideDest;
          await fsp.mkdir(path.dirname(destResolved.abs), { recursive: true });
          await fsp.rename(abs, destResolved.abs);
          return { ok: true, data: { op: 'move', from: abs, to: destResolved.abs } };
        }
        case 'delete': {
          // RED-tier: reaches execute only after the breaker's cancel window + audit.
          const outside = requireWorkspace(abs, 'delete');
          if (outside) return outside;
          await fsp.rm(abs, { recursive: true, force: false });
          logger.info({ tool: 'fs', op: 'delete' }, 'fs: deleted path');
          return { ok: true, data: { op: 'delete', path: abs } };
        }
        default:
          return esc(`fs: unsupported op.`);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ tool: 'fs', op: a.op }, 'fs: op failed — escalating');
      return esc(`fs ${a.op} failed: ${reason}`);
    }
  },
};

// Module-init side effect: importing this tool wires it into the router (HANDS-04).
register(fsTool);
