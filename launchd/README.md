# launchd — KERNEL install / uninstall runbook

> ## Install (current, wrapper-based — supersedes any older steps below)
>
> All five plists invoke **`kernel-launch.sh`** (a wrapper), not `node dist/index.js` directly.
> Two hard-won reasons:
> 1. **Never keep the code under `~/Documents` / `~/Desktop` / `~/Downloads`.** Those are TCC-protected;
>    launchd-spawned jobs are denied read access and exit **126**. Keep the project at e.g. `~/KernelAi`.
> 2. launchd gives jobs a minimal env (no `HOME`, bare `PATH`) and no terminal — `node` can hang in
>    startup. The wrapper sets a real env, resolves node + the repo from its own location, and detaches
>    stdin (`< /dev/null`).
>
> **Secrets:** create `~/.kernel.env` (chmod 600) with `export ANTHROPIC_API_KEY=...` (and any Plaid keys).
> The wrapper sources it so the launchd-run daemon can reach the cloud brain / finance API. Never committed.
>
> **Install:**
> ```sh
> # 1. project lives OUTSIDE ~/Documents (e.g. ~/KernelAi); daemon built (npm --prefix daemon run build)
> # 2. generate filled plists into ~/Library/LaunchAgents (replace __KERNEL_DIR__ with the repo path):
> for p in launchd/com.kernel.*.plist; do
>   sed "s#__KERNEL_DIR__#$PWD#g" "$p" > "$HOME/Library/LaunchAgents/$(basename "$p")"
> done
> # 3. bootstrap:
> for j in daemon heartbeat consolidation cleanup backup; do
>   launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.kernel.$j.plist"; done
> ```
> **Uninstall:** `for j in daemon heartbeat consolidation cleanup backup; do launchctl bootout gui/$(id -u)/com.kernel.$j 2>/dev/null; done`

Five LaunchAgents run KERNEL under launchd (CORE-01, CORE-03, MEM-07, MAINT-01/03):

| Plist | Job | Keys |
|-------|-----|------|
| `com.kernel.daemon.plist` | The long-lived daemon (the UDS IPC server + loop). | `RunAtLoad` + `KeepAlive` — starts at login, relaunches on crash. |
| `com.kernel.heartbeat.plist` | A short-lived `--heartbeat` that appends a dated line and exits. | `StartCalendarInterval` — fires on a schedule (default: top of every hour). |
| `com.kernel.consolidation.plist` | A short-lived `--consolidate`: logs → reflections, promote ONLY source-vetted facts → knowledge/ (external NEVER promoted; IDENTITY.md never auto-edited). | `StartCalendarInterval` — nightly **03:00**. |
| `com.kernel.cleanup.plist` | A short-lived `--cleanup`: prune stale working-memory + old logs (IDENTITY/knowledge/finance untouched). | `StartCalendarInterval` — nightly **03:30**. |
| `com.kernel.backup.plist` | A short-lived `--backup`: explicit-add commit + push of the memory repo to the private GitHub remote (finance/ NEVER staged; fails loud without remote/hook). | `StartCalendarInterval` — nightly **04:00**. |

> The three maintenance jobs are staggered (03:00 / 03:30 / 04:00) so the backup pushes a freshly
> consolidated-and-pruned snapshot. They are short-lived (spawn → work → exit), exactly like the
> heartbeat. If the Mac was asleep at the scheduled time, launchd runs the job at the next wake.

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

Replace, in **all five** plists (`com.kernel.daemon.plist`, `com.kernel.heartbeat.plist`,
`com.kernel.consolidation.plist`, `com.kernel.cleanup.plist`, `com.kernel.backup.plist`):

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
plutil -lint launchd/com.kernel.consolidation.plist
plutil -lint launchd/com.kernel.cleanup.plist
plutil -lint launchd/com.kernel.backup.plist
```

## 4. Install (copy into ~/Library/LaunchAgents, then bootstrap)

`bootstrap` reads the file from `~/Library/LaunchAgents/`, so copy the filled plists there first:

```bash
cp launchd/com.kernel.daemon.plist        ~/Library/LaunchAgents/
cp launchd/com.kernel.heartbeat.plist     ~/Library/LaunchAgents/
cp launchd/com.kernel.consolidation.plist ~/Library/LaunchAgents/
cp launchd/com.kernel.cleanup.plist       ~/Library/LaunchAgents/
cp launchd/com.kernel.backup.plist        ~/Library/LaunchAgents/

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.kernel.daemon.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.kernel.heartbeat.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.kernel.consolidation.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.kernel.cleanup.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.kernel.backup.plist
```

You can trigger any maintenance job immediately (don't wait for the nightly schedule):

```bash
launchctl kickstart -k gui/$(id -u)/com.kernel.consolidation   # writes kernel-memory/working-memory/reflections + self/changelog.md
launchctl kickstart -k gui/$(id -u)/com.kernel.cleanup          # prunes stale working-memory + old logs
launchctl kickstart -k gui/$(id -u)/com.kernel.backup           # commits + pushes (requires the GitHub setup below)
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

## 7. GitHub backup setup (MAINT-01 — required before `--backup` can push)

The backup job (`com.kernel.backup`) commits the memory repo and pushes it to a **private** GitHub
remote. It is built to **fail loud** (refuse to push) until the remote AND the pre-push hook are
both present — that is the designed behavior, not a bug: a misconfigured backup must never leak
silently. finance/ bytes NEVER leave the machine (explicit-add allowlist + `assertFinanceNotTracked`
ls-files layer d + the pre-push hook scanning pushed bytes).

```bash
# (a) Create a PRIVATE GitHub repo (GitHub → New repository → Private), then add it as the
#     kernel-memory remote (kernel-memory/ is its OWN git repo, separate from the project root):
git -C <repo>/kernel-memory remote add origin git@github.com:<you>/kernel-memory.git

# (b) Add an SSH deploy key with PUSH access (GitHub repo → Settings → Deploy keys → "Allow write").
#     SSH deploy key is recommended over a PAT (scoped to this one repo).

# (c) Install the pre-push hook (a .git/hooks/ file is NOT tracked by git — it must be copied in):
cp <repo>/daemon/scripts/hooks/kernel-memory-pre-push.sh <repo>/kernel-memory/.git/hooks/pre-push
chmod +x <repo>/kernel-memory/.git/hooks/pre-push
```

Trigger one real backup and confirm finance never left the machine:

```bash
node <repo>/daemon/dist/index.js --backup           # or: launchctl kickstart -k gui/$(id -u)/com.kernel.backup
git -C <repo>/kernel-memory ls-remote origin | head  # the push landed
# On the remote (or a fresh clone): the tracked tree must contain NO finance path:
git -C <repo>/kernel-memory ls-files | grep -i finance   # → MUST be empty
```

If you run `--backup` BEFORE configuring the remote or installing the hook, it will exit non-zero
with a clear message ("backup refused — no 'origin' remote" / "the pre-push hook is not installed")
and push nothing. That is the fail-loud guard working.

## 8. Uninstall

```bash
for j in daemon heartbeat consolidation cleanup backup; do
  launchctl bootout gui/$(id -u)/com.kernel.$j 2>/dev/null
  rm -f ~/Library/LaunchAgents/com.kernel.$j.plist
done
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
