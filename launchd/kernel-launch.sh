#!/bin/sh
# KERNEL launchd job launcher.
#
# WHY: launchd gives jobs a MINIMAL environment (no HOME, a bare PATH) and no
# controlling terminal. node can hang in startup (node::LoadEnvironment) under that
# combination. This wrapper sets a real env, resolves node + the repo from its own
# location, optionally loads the owner's secrets, DETACHES stdin (< /dev/null), and
# execs the daemon in the requested mode. Used by every com.kernel.* launchd job.
#
# SECRETS: if ~/.kernel.env exists it is sourced here — drop `export ANTHROPIC_API_KEY=...`
# (and any Plaid keys) into that file (chmod 600) so the launchd-run daemon can reach the
# cloud brain / finance API. It is never committed and never in the repo.
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

export HOME="${HOME:-/Users/$(id -un)}"
# Include ~/.local/bin so user-installed CLIs (notably Claude Code, used by the `claude-code`
# subscription brain) are on PATH — launchd's default PATH omits it.
export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
export KERNEL_MEMORY_DIR="${KERNEL_MEMORY_DIR:-$REPO/kernel-memory}"

# Owner-provided secrets (optional; absent is fine — the daemon idles without them).
[ -f "$HOME/.kernel.env" ] && . "$HOME/.kernel.env"

NODE="$(command -v node || echo /usr/local/bin/node)"
exec "$NODE" "$REPO/daemon/dist/index.js" "$@" < /dev/null
