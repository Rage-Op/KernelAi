#!/usr/bin/env node
/**
 * write-build-stamp.mjs — run by the `postbuild` npm script after `tsc`. Writes dist/build-stamp.json
 * with the build time + git short-sha so the daemon can log which build is live and detect when dist
 * has been rebuilt since it booted (see src/build-stamp.ts).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

let git = 'nogit';
try {
  git = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim() || 'nogit';
} catch {
  /* not a git checkout — fine */
}

mkdirSync(distDir, { recursive: true });
const stamp = { builtAt: new Date().toISOString(), git };
writeFileSync(path.join(distDir, 'build-stamp.json'), JSON.stringify(stamp));
console.log('build stamp:', JSON.stringify(stamp));
