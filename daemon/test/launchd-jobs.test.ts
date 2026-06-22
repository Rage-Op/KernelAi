/**
 * launchd-jobs.test.ts (MAINT-03).
 *
 * Lints (NOT executes) the three maintenance plists: each must be valid plist XML, invoke the
 * `kernel-launch.sh` wrapper with its `--<job>` ProgramArgument, and carry a StartCalendarInterval.
 * (The wrapper sets a real env + detaches stdin + execs `dist/index.js` — direct `node dist/index.js`
 * ProgramArguments hang under launchd's minimal env and are TCC-blocked under ~/Documents; the wrapper
 * is the canonical, working invocation.) We validate with macOS `plutil -lint` (the canonical plist
 * validator) AND assert the load-bearing content. These plists are NEVER bootstrapped/loaded here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Repo-root launchd/ dir (src/ ... no — this test lives in daemon/test/, two up is the repo root). */
function launchdDir(): string {
  const here = path.dirname(new URL(import.meta.url).pathname);
  return path.resolve(here, '..', '..', 'launchd');
}

const JOBS: { file: string; flag: string; label: string }[] = [
  { file: 'com.kernel.consolidation.plist', flag: '--consolidate', label: 'com.kernel.consolidation' },
  { file: 'com.kernel.cleanup.plist', flag: '--cleanup', label: 'com.kernel.cleanup' },
  { file: 'com.kernel.backup.plist', flag: '--backup', label: 'com.kernel.backup' },
];

for (const job of JOBS) {
  test(`${job.file}: valid plist XML invoking the kernel-launch.sh wrapper ${job.flag} with a StartCalendarInterval`, () => {
    const file = path.join(launchdDir(), job.file);
    assert.ok(fs.existsSync(file), `${file} must exist`);

    // (1) plutil -lint — the canonical macOS plist validator (lint only, never load).
    const lint = spawnSync('plutil', ['-lint', file], { encoding: 'utf8' });
    assert.equal(lint.status, 0, `plutil -lint must pass for ${job.file}: ${lint.stdout}${lint.stderr}`);

    // (2) load-bearing content: the correct Label, the kernel-launch.sh wrapper + --<job>
    //     ProgramArgument, and a StartCalendarInterval key.
    const xml = fs.readFileSync(file, 'utf8');
    assert.match(xml, new RegExp(`<string>${job.label}</string>`), 'correct Label');
    assert.match(xml, /kernel-launch\.sh<\/string>/, 'invokes the kernel-launch.sh wrapper');
    assert.match(xml, new RegExp(`<string>${job.flag}</string>`), `invokes ${job.flag}`);
    assert.match(xml, /<key>StartCalendarInterval<\/key>/, 'scheduled via StartCalendarInterval');
  });
}

test('all three job plists invoke distinct job flags (no copy-paste flag bug)', () => {
  const flags = JOBS.map((j) => {
    const xml = fs.readFileSync(path.join(launchdDir(), j.file), 'utf8');
    return xml.match(/--(consolidate|cleanup|backup)/)?.[0];
  });
  assert.deepEqual(flags, ['--consolidate', '--cleanup', '--backup']);
});
