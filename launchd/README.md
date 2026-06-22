# launchd — KERNEL install / uninstall runbook

Two LaunchAgents run KERNEL under launchd (CORE-01, CORE-03):

| Plist | Job | Keys |
|-------|-----|------|
| `com.kernel.daemon.plist` | The long-lived daemon (the UDS IPC server + loop). | `RunAtLoad` + `KeepAlive` — starts at login, relaunches on crash. |
| `com.kernel.heartbeat.plist` | A short-lived `--heartbeat` that appends a dated line and exits. | `StartCalendarInterval` — fires on a schedule (default: top of every hour). |

> Use `launchctl bootstrap` / `bootout` — **NOT** the deprecated `load` / `unload`. The
> modern verbs require the target domain stated explicitly (`gui/$(id -u)`).

---

## 1. Fill the placeholders

Both plists ship with `/ABSOLUTE/PATH/TO/...` placeholders because launchd has a **minimal
environment** — `node` is not on its `PATH`, so an absolute node path is mandatory.

Find your real values:

```bash
which node                      # → e.g. /usr/local/bin/node  (ProgramArguments[0])
cd /path/to/KernelAi && pwd     # → the repo root (used below)
```

Replace, in **both** `com.kernel.daemon.plist` and `com.kernel.heartbeat.plist`:

- `/ABSOLUTE/PATH/TO/node` → the `which node` output.
- `/ABSOLUTE/PATH/TO/KernelAi/daemon/dist/index.js` → `<repo>/daemon/dist/index.js`.
- `/ABSOLUTE/PATH/TO/KernelAi/kernel-memory` → `<repo>/kernel-memory` (the `KERNEL_MEMORY_DIR`
  env var **and** the `StandardOutPath`/`StandardErrorPath` log paths).

## 2. Build (the plists point at compiled JS)

```bash
cd <repo>/daemon && npm run build      # produces daemon/dist/index.js
```

## 3. Validate the plists

```bash
plutil -lint launchd/com.kernel.daemon.plist
plutil -lint launchd/com.kernel.heartbeat.plist
```

## 4. Install (copy into ~/Library/LaunchAgents, then bootstrap)

`bootstrap` reads the file from `~/Library/LaunchAgents/`, so copy the filled plists there first:

```bash
cp launchd/com.kernel.daemon.plist    ~/Library/LaunchAgents/
cp launchd/com.kernel.heartbeat.plist ~/Library/LaunchAgents/

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.kernel.daemon.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.kernel.heartbeat.plist
```

Confirm the daemon is running and the socket exists:

```bash
launchctl print gui/$(id -u)/com.kernel.daemon | grep -E 'state|pid'
ls -l "$HOME/Library/Application Support/Kernel/kernel.sock"
```

## 5. Test the heartbeat immediately (don't wait for the schedule)

```bash
launchctl kickstart -k gui/$(id -u)/com.kernel.heartbeat
# then confirm a fresh dated line landed:
tail -n 3 "<repo>/kernel-memory/logs/$(date +%F).md"   # → a `heartbeat 2026-...Z` line
```

## 6. Relaunch-at-login check

Log out and back in (or simulate with `bootout` + `bootstrap`) and confirm the daemon is
running again:

```bash
launchctl bootout    gui/$(id -u)/com.kernel.daemon
launchctl bootstrap  gui/$(id -u) ~/Library/LaunchAgents/com.kernel.daemon.plist
launchctl print      gui/$(id -u)/com.kernel.daemon | grep -E 'state|pid'
```

## 7. Uninstall

```bash
launchctl bootout gui/$(id -u)/com.kernel.daemon
launchctl bootout gui/$(id -u)/com.kernel.heartbeat
rm ~/Library/LaunchAgents/com.kernel.daemon.plist
rm ~/Library/LaunchAgents/com.kernel.heartbeat.plist
```

---

## Notes / gotchas

- **`bootstrap` vs `load`:** `load`/`unload` are deprecated; they inferred the domain.
  `bootstrap`/`bootout` require `gui/$(id -u)` explicitly.
- **Changing the Label or a path:** edit the plist, then `bootout` + re-`bootstrap` (and
  re-`cp` into `~/Library/LaunchAgents/`). launchd caches the registration; a file edit
  alone is not picked up.
- **Minimal environment:** if "it works from the terminal but fails under launchd," it is
  almost always the PATH/node-resolution bug — verify the absolute node path and the
  explicit `EnvironmentVariables.PATH`. Check `kernel-memory/logs/daemon.err.log`.
- **Asleep at the scheduled time:** `StartCalendarInterval` runs the job at the next wake.
- **TCC / code-signing:** not needed for the P1 node daemon; it becomes relevant in Phase 2
  (the Face app + Peekaboo Accessibility grants).
```
