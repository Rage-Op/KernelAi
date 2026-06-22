/**
 * Provenance — the taint tag carried by every context item and memory record.
 * Set at the read/write site, never inferred later (the MEM-05 quarantine seam).
 *
 *   user     = Pravin said/typed it          (trusted instruction)
 *   self     = KERNEL's own reasoning/output (trusted)
 *   external = read from mail/web/calendar   (UNTRUSTED — lands only in quarantine/)
 */
export type Provenance = 'user' | 'self' | 'external';

/**
 * A single piece of context assembled into the brain prompt.
 * `source` is the load-bearing provenance tag; `origin`/`path` are optional metadata.
 */
export interface ContextItem {
  /** The text injected into context. */
  text: string;
  /** Provenance tag — carried into the brain context. */
  source: Provenance;
  /** Human-readable origin, e.g. "email:2026-06-22 from x@y.com" (external items). */
  origin?: string;
  /** Source file path (used for authority weighting in retrieval rerank). */
  path?: string;
}
