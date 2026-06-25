#!/usr/bin/env bash
#
# kernel-up.sh — bring KERNEL up as TWO pieces: (1) LM Studio runs the model, (2) this daemon hosts the
# web Face + orchestrates. Builds the daemon + the web UI, ensures Chromium is present, (re)starts the
# daemon, then prints (and opens) the local web URL.
#
# Usage:  ./kernel-up.sh            # build + start + open the browser
#         KERNEL_HTTP_PORT=8080 ./kernel-up.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPPORT="$HOME/Library/Application Support/Kernel"
PORT="${KERNEL_HTTP_PORT:-7777}"
LOG="$SUPPORT/daemon.out.log"
mkdir -p "$SUPPORT"

cd "$ROOT/daemon"

echo "[kernel] building daemon…"
npm run build >/dev/null

echo "[kernel] building web face…"
npm run build:web >/dev/null

# Ensure the Playwright Chromium binary exists (the browser hand + live view need it).
if ! ls "$HOME/Library/Caches/ms-playwright"/chromium-* >/dev/null 2>&1; then
  echo "[kernel] installing Chromium for Playwright (one-time)…"
  npx playwright install chromium
fi

# Start the daemon on the FRESH build. If a launchd job manages it (KeepAlive=true), a blind
# `pkill dist/index.js` would just race launchd's instant relaunch — so cycle it via launchctl instead.
# Otherwise stop any stale plain-node daemon and start one (the single-instance lock makes this safe).
LABEL="com.kernel.daemon"
GUI="gui/$(id -u)/$LABEL"
MANAGED=0
PID=""
if launchctl print "$GUI" >/dev/null 2>&1; then
  echo "[kernel] launchd job $LABEL is loaded — cycling via 'launchctl kickstart -k' (not pkill)…"
  launchctl kickstart -k "$GUI" 2>/dev/null || true
  MANAGED=1
  if [ "$PORT" != "7777" ]; then
    echo "[kernel] NOTE: a launchd-managed daemon binds the plist's port (default 7777), NOT KERNEL_HTTP_PORT=$PORT."
    echo "        Edit the plist's EnvironmentVariables, or 'launchctl bootout $GUI' then re-run, to use $PORT."
    PORT=7777
  fi
else
  pkill -f "dist/index.js" 2>/dev/null || true
  sleep 0.4
  echo "[kernel] starting daemon…"
  nohup node dist/index.js >"$LOG" 2>&1 &
  PID=$!
fi

# Wait for the web server to answer (static index served without a token).
for _ in $(seq 1 60); do
  if curl -sf -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then break; fi
  if [ "$MANAGED" = "0" ] && [ -n "$PID" ] && ! kill -0 "$PID" 2>/dev/null; then
    echo "[kernel] daemon exited early — last log lines:"; tail -n 25 "$LOG"; exit 1
  fi
  sleep 0.25
done
[ -z "$PID" ] && PID="launchd-managed"

TOKEN="$(cat "$SUPPORT/web-token" 2>/dev/null || true)"
URL="http://127.0.0.1:$PORT/?token=$TOKEN"

cat <<EOF

  ┌──────────────────────────────────────────────────────────────┐
  │  KERNEL is up.                                                 │
  └──────────────────────────────────────────────────────────────┘

  Web face:   $URL
  Daemon log: $LOG
  PID:        $PID

  Reminder — the OTHER piece is LM Studio: load a model (MLX or GGUF)
  and start its server (Developer ▸ Start Server, or: lms server start).
  Then in the web face: Settings ▸ Engine ▸ LM Studio.

EOF

command -v open >/dev/null 2>&1 && open "$URL" || true
