#!/usr/bin/env node
//@ts-check
/**
 * Post-deploy verification: the LIVE site is the one that was just built.
 *
 *   node scripts/verify-live-site.js [--url <base>] [--timeout <seconds>]
 *
 * Wired as the website workspace's `postdeploy`, so the close-out
 * protocol's "verify the live publish, not just the branch push" runs
 * itself on every deploy instead of depending on someone remembering to
 * open a tab. `gh-pages` reports success when the BRANCH is pushed; Pages
 * then builds and propagates on its own schedule, and it can fail there —
 * the branch push is not the publish.
 *
 * The artifact compared is `build.json`, which the build stamps with the
 * commit it was built from and the version the manifests carried. The
 * comparison is against the LOCAL `git rev-parse HEAD` and the root
 * manifest, and it lines up because of the order the close-out protocol
 * runs in: the version bump lands in the working tree, the site is built
 * and deployed, and only THEN is the work committed. At the moment this
 * runs, HEAD is exactly the revision the deployed build recorded.
 *
 * A fresh publish takes a minute or two to propagate, so a mismatch is
 * retried with backoff before it is believed.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Where the site is published. */
export const LIVE = 'https://jklarenbeek.github.io/jarenjs/';

/** What the deploy should have published: this checkout, right now. */
export function expected(root = ROOT) {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  return { version: manifest.version, commit };
}

/**
 * @typedef {object} LiveReport
 * @property {number} code - 0 verified, 1 mismatch or unreachable
 * @property {number} attempts
 * @property {any} [live] - the last `build.json` fetched
 * @property {string[]} problems
 */

/**
 * Poll the live `build.json` until it matches, or the budget runs out.
 * @param {{ url?: string, want?: {version: string, commit: string},
 *   timeoutMs?: number, fetchJson?: (url: string) => Promise<any>,
 *   wait?: (ms: number) => Promise<any>, log?: (m: string) => void }} [options]
 * @returns {Promise<LiveReport>}
 */
export async function verifyLiveSite(options = {}) {
  const base = (options.url ?? LIVE).replace(/\/*$/, '/');
  const want = options.want ?? expected();
  const budget = options.timeoutMs ?? 240_000;
  const log = options.log ?? ((m) => console.log(m));
  const wait = options.wait ?? sleep;
  const fetchJson = options.fetchJson ?? (async (url) => {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json();
  });

  const started = Date.now();
  let attempts = 0;
  let live;
  /** @type {string[]} */
  let problems = [];
  // 5s, 10s, 20s, 40s, then every 40s — a fresh Pages build is usually
  // live inside a minute and occasionally takes three
  let backoff = 5_000;
  for (;;) {
    attempts += 1;
    problems = [];
    try {
      live = await fetchJson(`${base}build.json?t=${started}-${attempts}`);
      if (live?.commit !== want.commit) {
        problems.push(`commit: live ${String(live?.commit).slice(0, 7)} `
          + `≠ local HEAD ${want.commit.slice(0, 7)}`);
      }
      if (live?.version !== want.version) {
        problems.push(`version: live ${live?.version} ≠ manifest ${want.version}`);
      }
      if (problems.length === 0) return { code: 0, attempts, live, problems };
    }
    catch (err) {
      problems.push(`build.json unreachable: ${String(/** @type {any} */ (err)?.message ?? err)}`);
    }
    if (Date.now() - started + backoff > budget) break;
    log(`not live yet (${problems.join('; ')}) — retrying in ${Math.round(backoff / 1000)}s`);
    await wait(backoff);
    backoff = Math.min(backoff * 2, 40_000);
  }
  return { code: 1, attempts, live, problems };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  const seconds = Number(flag('--timeout') ?? 240);
  const want = expected();
  console.log(`verifying the live publish: v${want.version} @ ${want.commit.slice(0, 7)}`);
  const report = await verifyLiveSite({
    url: flag('--url'),
    timeoutMs: Number.isFinite(seconds) ? seconds * 1000 : 240_000,
  });
  if (report.code !== 0) {
    console.error(`the live site is NOT this build after ${report.attempts} attempt(s):\n\n  `
      + `${report.problems.join('\n  ')}\n`);
    console.error('the branch push is not the publish — check the Pages build for this repository.');
    process.exit(1);
  }
  console.log(`live: v${report.live.version} @ ${String(report.live.commit).slice(0, 7)}, `
    + `built ${String(report.live.built).slice(0, 10)} (verified in ${report.attempts} attempt(s)).`);
}
