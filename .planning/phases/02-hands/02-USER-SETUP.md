# Phase 2: User Setup Required

**Generated:** 2026-06-22
**Phase:** 02-hands
**Status:** Incomplete

Complete these items for the browser hand (and the phase close-out checks) to function. Claude automated everything possible; these items require either a one-time local download or live network + the owner's credentials.

## Environment Variables

None. The browser tool needs no env vars or API keys.

## Account Setup

None.

## Dashboard Configuration

None.

## Owner Setup Tasks

- [x] **Download the Chromium browser binary** (already run in this environment — re-run on any fresh machine)
  - Run: `cd daemon && npx playwright install chromium`
  - What it does: downloads Chrome for Testing (~hundreds of MB) to `~/Library/Caches/ms-playwright/` — OUTSIDE the repo, gitignored-by-location. The Chromium binary is NOT an npm dependency.
  - Already completed here: Chrome for Testing 149.0.7827.55 (playwright chromium v1228) installed.

- [ ] **Confirm the dedicated profile dir target is correct and isolated**
  - The browser tool launches against `~/Library/Application Support/Kernel/browser-profile/` — a DEDICATED profile, never the owner's real Chrome profile, and OUTSIDE `kernel-memory/` so the GitHub backup never touches live session cookies.

## Manual Owner Checks (gate the phase — cannot run in CI)

These need live network + the owner's credentials, so they are NOT in the unit lane:

- [ ] **Real site login + scrape + form-fill end-to-end (HANDS-03)**
  - Through `registry.dispatch`: `navigate`(a real login page) → `fill`(a non-secret field, e.g. Email) → confirm the headful Chromium types into the real form and the navigation logged the full URL + provenance.
  - Confirm the dedicated profile persists the session across daemon runs.

- [ ] **Credential fence on a REAL site password field (HANDS-05)**
  - Point `fill` at a real site's password `<input>`; confirm the adapter surfaces `type=password` and the gate REFUSES (no keystroke synthesized). The owner enters the credential manually.

## Verification

After the download (already done here), verify with:

```bash
cd daemon
npm view playwright version            # expect 1.61.0
grep '"playwright": "1.61.0"' package.json   # exact pin, no caret
npx playwright install chromium        # idempotent — re-confirms the binary is present
npx tsx --test src/tools/browser.test.ts     # live-Chromium unit lane (5 green); skips clean if binary absent
```

Expected results:
- `playwright` resolves to `1.61.0`, pinned exactly (no caret).
- The browser unit lane is green (5 tests) — or skips cleanly with a clear message if the binary is not installed.
- The dedicated profile dir lives under `~/Library/Application Support/Kernel/browser-profile/`, outside `kernel-memory/`.

---

**Once all items complete:** Mark status as "Complete" at top of file.
