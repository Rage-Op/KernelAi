#!/usr/bin/env node
/**
 * kernel-mcp.mjs — an MCP (Model Context Protocol) server that exposes the running KERNEL daemon as
 * a single tool, `ask_kernel`, over stdio. This lets ANY MCP client (Claude Desktop, Claude Code,
 * etc.) talk to your local KERNEL — it routes a prompt through the daemon's UDS socket exactly like
 * the Face / `chat.mjs` do, and returns KERNEL's reply.
 *
 * KERNEL keeps its own memory, conversation, web search, and finance tools, so `ask_kernel` is a way
 * to delegate to the owner's persistent agent rather than a stateless model call.
 *
 * Register it with Claude Desktop / Claude Code (e.g. in the MCP servers config):
 *   {
 *     "mcpServers": {
 *       "kernel": { "command": "node", "args": ["/Users/<you>/KernelAi/daemon/scripts/kernel-mcp.mjs"] }
 *     }
 *   }
 *
 * Transport note: stdout is reserved for the MCP protocol — all diagnostics go to stderr.
 * Env: KERNEL_SOCKET overrides the socket path.
 */
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const SOCK =
  process.env.KERNEL_SOCKET ??
  path.join(os.homedir(), 'Library', 'Application Support', 'Kernel', 'kernel.sock');

/**
 * Send one prompt to KERNEL over the UDS socket and resolve its full reply. Mirrors the daemon's
 * NDJSON contract: a streaming (local) brain emits `say{delta,final}` frames we accumulate; a
 * non-streaming brain sends a single `reply{text}`. Frames for other turns (or unsolicited
 * ready/capabilities/stats) are ignored. Rejects on a daemon `error` frame, an unreachable socket,
 * or a timeout.
 */
function askKernel(prompt, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const id = `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const conn = net.createConnection({ path: SOCK });
    let buffer = '';
    let acc = '';
    let settled = false;

    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.destroy();
      fn(val);
    };
    const timer = setTimeout(
      () => finish(reject, new Error(`KERNEL did not respond within ${timeoutMs}ms`)),
      timeoutMs,
    );

    conn.on('connect', () => {
      conn.write(JSON.stringify({ type: 'utterance', id, text: prompt, final: true }) + '\n');
    });
    conn.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        let f;
        try {
          f = JSON.parse(line);
        } catch {
          continue;
        }
        // Ignore frames correlated to a different turn; ready/capabilities/stats carry no/other id.
        if (f.id && f.id !== id) continue;
        switch (f.type) {
          case 'say':
            acc += f.delta ?? '';
            if (f.final) finish(resolve, acc.trim());
            break;
          case 'reply':
            finish(resolve, (f.text ?? '').trim());
            break;
          case 'error':
            finish(reject, new Error(f.message ?? 'daemon error'));
            break;
          default:
            break; // ready / capabilities / stats / tool.activity — informational
        }
      }
    });
    conn.on('error', (e) =>
      finish(reject, new Error(`cannot reach KERNEL at ${SOCK} (is the daemon running?): ${e.message}`)),
    );
    conn.on('close', () => {
      if (!settled) finish(resolve, acc.trim());
    });
  });
}

const server = new McpServer({ name: 'kernel', version: '0.1.0' });

server.registerTool(
  'ask_kernel',
  {
    title: 'Ask KERNEL',
    description:
      "Send a message to the owner's running local KERNEL assistant (a persistent macOS agent) and " +
      'return its reply. KERNEL has the owner\'s long-term memory, recent conversation, web search, ' +
      'and finance tools — use it to delegate a task or get an answer grounded in KERNEL\'s own ' +
      'context and tools, rather than answering yourself.',
    inputSchema: { prompt: z.string().describe('The message or question to send to KERNEL.') },
  },
  async ({ prompt }) => {
    try {
      const reply = await askKernel(prompt);
      return { content: [{ type: 'text', text: reply || '(KERNEL returned an empty reply)' }] };
    } catch (e) {
      return {
        content: [{ type: 'text', text: `Error talking to KERNEL: ${e.message}` }],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`kernel-mcp: ready — proxying ask_kernel → ${SOCK}\n`);
