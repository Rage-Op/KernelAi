# KERNEL Web Face — two-piece quickstart

KERNEL now runs as **two pieces**:

1. **LM Studio** — runs the local model (MLX or GGUF).
2. **The daemon** — hosts the web Face and orchestrates everything (gate, tools, MCP, memory, filesystem,
   shell, `/override`, meta-commands). You open it in any browser.

The SwiftUI Mac app has been **removed**, and the daemon's old Unix-socket (UDS) transport has now been
**stripped** too — the web Face (HTTP + SSE on `127.0.0.1`) is the daemon's sole transport. (The frame
router, gate, loop, tools, MCP, and memory are unchanged; only the socket plumbing is gone.)

---

## 1. LM Studio

1. Install LM Studio (https://lmstudio.ai) and download a model. On Apple Silicon, try an **MLX** build for
   best speed (LM Studio runs MLX even on a 16GB Mac — Ollama gates MLX to 32GB+).
2. **Load** the model.
3. **Start the local server**: Developer ▸ *Start Server* (or `lms server start`). It listens on
   `http://localhost:1234`. KERNEL auto-detects the loaded model.

> You can also use **Ollama** (`local`) or **Claude cloud** (`cloud`) — switch in Settings ▸ Engine. The
> orchestration (tools/MCP/gate) is identical for all three.

## 2. The daemon + web Face

From the repo root:

```bash
./kernel-up.sh
```

This builds the daemon + the web UI, ensures Chromium is installed, starts the daemon, and prints + opens:

```
http://127.0.0.1:7777/?token=<your-token>
```

Bookmark that URL (the token is remembered in the page session). To use a different port:
`KERNEL_HTTP_PORT=8080 ./kernel-up.sh`.

---

## What you get

- **Status header** — daemon, engine (ollama / lm studio / cloud), model, and ready state, always visible.
- **Chat** — scrollable, streaming answers, live **reasoning** (collapsible), live **tool activity**,
  per-turn **stats** (tok/s, tokens, context, cost), and a determinate **progress** bar.
- **Browser** — when KERNEL drives Playwright, a **live screencast** appears here. A real Chromium window
  also opens on the Mac (so you can complete logins / 2FA there). The stream runs only while this pane is open.
- **Settings** — switch engine, toggle the Red breaker, set the daily spend ceiling, activate `/override`,
  and see the full gate-chokepointed capability list.
- **LM Studio model control** (Settings) — list the models LM Studio has downloaded, see which one is
  loaded (with its context window + capabilities), and **load / unload** a model — optionally at a chosen
  context length — straight from the browser, via LM Studio's native `/api/v1` REST API. This is an
  owner-only, localhost control surface (it can only act on models LM Studio already lists), parallel to
  the **Background services** kill panel.

## Security

The web server binds **127.0.0.1 only** and requires the **token** (`~/Library/Application Support/Kernel/web-token`,
0600) on both `/events` and `/frame`. It rejects non-loopback `Host`/`Origin` headers (anti DNS-rebinding / CSRF),
sends `Referrer-Policy: no-referrer`, and the SPA scrubs the token out of the URL on load. The daemon never logs
the token. Every action the model takes still flows through the **same gate** as before — the web Face grants
nothing the gate wouldn't allow.

**Accepted egress — the Browser pane:** anyone holding the token can open the Browser pane and watch KERNEL's
live (headful) Chromium, *including* any logged-in session, OTP, or 2FA page currently on screen. This is the
whole point of the feature, and the token already grants full gate-mediated control, so it is an intentional,
documented egress — treat the token as you would a password and don't share the launcher URL with anyone you
wouldn't hand the keyboard to. (A future hardening could blank the stream while a credential field is focused.)

## Notes

- If a **launchd**-managed daemon is running an older build, cycle it with
  `launchctl kickstart -k gui/$(id -u)/com.kernel.daemon` instead of `kernel-up.sh` (which manages a
  plain-node daemon).
- Logs: `~/Library/Application Support/Kernel/daemon.out.log`.
- Stop: `pkill -f dist/index.js` (plain-node) — the single-instance lock keeps restarts safe.
