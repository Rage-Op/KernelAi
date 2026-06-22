/**
 * Short-lived heartbeat job (CORE-03).
 *
 * The `--heartbeat` launchd job runs `node dist/index.js --heartbeat`, which calls
 * `runHeartbeat()`: append ONE dated heartbeat line to `logs/{today}.md`, then resolve so
 * the process exits. No socket, no loop — it proves the scheduled-wake path writes a dated
 * entry to the append-only log and clocks out immediately.
 */
import { logHeartbeat, logger } from './memory/log.js';
import { config } from './config.js';

/**
 * Append a single dated heartbeat line and resolve. Returns the line written.
 */
export async function runHeartbeat(memoryDir: string = config.memoryDir): Promise<string> {
  const line = logHeartbeat(memoryDir);
  logger.info({ event: 'heartbeat.run', memoryDir }, 'heartbeat job complete');
  return line;
}
