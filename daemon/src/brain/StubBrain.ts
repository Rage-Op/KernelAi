import type { BrainProvider, Decision } from './BrainProvider.js';

/**
 * Deterministic, no-network brain that satisfies BrainProvider.
 *
 * Even the stub goes through `reason()` so the swap-seam is real — the daemon
 * never hardcodes the reply (RESEARCH.md anti-pattern). Real brains
 * (ClaudeBrain over @anthropic-ai/sdk, LocalBrain over Ollama HTTP) drop in by
 * satisfying the same interface.
 */
export class StubBrain implements BrainProvider {
  async reason(prompt: string, _context: string): Promise<Decision> {
    return {
      thought: `stub considered: ${prompt.slice(0, 80)}`,
      reply: `KERNEL skeleton online. (StubBrain echo) You said: ${prompt}`,
      // no action — no tools exist in Phase 1
    };
  }
}
