# Phase 5: User Setup Required

**Generated:** 2026-06-22
**Phase:** 05-safety-self-maintenance-gated-do-not-auto-execute
**Status:** Incomplete

Complete these items for the nightly self-maintenance jobs (consolidation/cleanup/backup) to run
on schedule and for the finance-safe GitHub backup to push. Claude automated everything possible
(the job code, the backup safety stack, the three plists, and the full test suite); these items
require human access to the owner machine + a GitHub account Claude has no credentials for.

The runbook with copy-paste commands is `launchd/README.md` (sections 4-7).

## Environment Variables

None. The jobs read `KERNEL_MEMORY_DIR` from the plist `EnvironmentVariables` (filled below) and
git push auth comes from the SSH deploy key, not an env var. (No `.env` secret is added — `.env`
is gitignored in kernel-memory and never backed up.)

## Account Setup

- [ ] **Create a PRIVATE GitHub repo for the memory backup**
  - URL: https://github.com/new → set visibility to **Private**
  - Skip if: you already have a private kernel-memory backup repo

## Dashboard Configuration

- [ ] **Add the private repo as the kernel-memory remote**
  - Location: terminal (kernel-memory/ is its own git repo, separate from the project root)
  - Command: `git -C <repo>/kernel-memory remote add origin git@github.com:<you>/kernel-memory.git`
  - Notes: the backup job FAILS LOUD (refuses to push) until this remote exists — by design.

- [ ] **Add an SSH deploy key with PUSH access**
  - Location: GitHub repo → Settings → Deploy keys → Add deploy key → check "Allow write access"
  - Notes: SSH deploy key recommended over a PAT (scoped to this one repo).

- [ ] **Install the pre-push hook into kernel-memory/.git/hooks/**
  - Location: terminal (a `.git/hooks/` file is NOT tracked by git, so it must be copied in)
  - Commands:
    - `cp <repo>/daemon/scripts/hooks/kernel-memory-pre-push.sh <repo>/kernel-memory/.git/hooks/pre-push`
    - `chmod +x <repo>/kernel-memory/.git/hooks/pre-push`
  - Notes: the backup job refuses to push if this hook is absent (defense-in-depth layer b).

- [ ] **Fill the plist placeholders and bootstrap the three maintenance jobs**
  - Location: terminal (`launchd/README.md` sections 1, 4)
  - Replace `/ABSOLUTE/PATH/TO/node`, `/ABSOLUTE/PATH/TO/KernelAi/daemon/dist/index.js`, and
    `/ABSOLUTE/PATH/TO/KernelAi/kernel-memory` in `com.kernel.consolidation.plist`,
    `com.kernel.cleanup.plist`, and `com.kernel.backup.plist`.
  - Then `cp` each into `~/Library/LaunchAgents/` and
    `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.kernel.<job>.plist`.
  - Notes: `npm run build` first — the plists run `dist/index.js`, not `src/`.

## Verification

After completing setup, verify on the owner machine:

```bash
# (1) the plists are valid and loaded
plutil -lint launchd/com.kernel.consolidation.plist launchd/com.kernel.cleanup.plist launchd/com.kernel.backup.plist
launchctl print gui/$(id -u)/com.kernel.consolidation | grep -E 'state|pid'

# (2) trigger a real consolidation + cleanup run (no schedule wait)
launchctl kickstart -k gui/$(id -u)/com.kernel.consolidation
launchctl kickstart -k gui/$(id -u)/com.kernel.cleanup
ls <repo>/kernel-memory/working-memory/reflections/   # → a fresh reflection file
tail -n 3 <repo>/kernel-memory/self/changelog.md       # (if the run recorded a changelog line)

# (3) trigger one REAL backup push and confirm finance never left the machine
node <repo>/daemon/dist/index.js --backup
git -C <repo>/kernel-memory ls-files | grep -i finance  # → MUST be empty (finance never tracked)

# (4) confirm the fail-loud guard: with NO remote/hook configured, --backup must refuse to push
#     (exit non-zero with "backup refused — no 'origin' remote" / "pre-push hook is not installed")
```

Expected results:
- The three plists lint OK and load; a nightly run (or kickstart) writes reflections + prunes stale files.
- A real `--backup` push succeeds AND `git ls-files | grep -i finance` is EMPTY (finance never backed up).
- Before the remote/hook are configured, `--backup` fails loud rather than pushing or no-op'ing.

---

**Once all items complete:** Mark status as "Complete" at top of file.
