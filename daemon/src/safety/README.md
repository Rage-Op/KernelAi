# safety/ — the gate chokepoint seam

This directory is the single chokepoint through which every world-affecting action
must pass before it executes. It is **empty in Phase 1** — no code, no enforcement —
because the skeleton has no tools to gate yet.

It is filled later:

- **Phase 2** adds `gate.authorize(action)` — the function the loop calls between
  `decide` and `act`, so a `Decision.action` cannot reach a tool router without
  first clearing the gate.
- **Phase 5** adds the full tiered gate (🟢 reversible / 🟡 recoverable / 🔴
  irreversible+financial), the dry-run preview → 10s cancel → spend-ceiling →
  audit-log flow, and the circuit breaker — including the hard non-overridable
  rules (no credential entry, no Red action sourced from external content, daily
  spend ceiling).

The seam exists now so that when tools land, there is exactly one place that
authorizes them — never an ad-hoc `if` scattered across the codebase.
