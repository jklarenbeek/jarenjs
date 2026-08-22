#!/usr/bin/env node
//@ts-check
/**
 * The deploy guard: refuse to publish a changed `public/` asset under a
 * service-worker cache name that has not moved.
 *
 *   node scripts/check-sw-cache.js
 *
 * `packages/website/public/sw.js` opens with `CACHE = 'jaren-website-vNN'`,
 * and the fetch handler serves the precached shell, the icons, the manifest
 * and the fonts cache-FIRST. A returning reader is therefore handed the
 * bytes of whichever cache their browser already holds, and the only thing
 * that retires it is the activate handler deleting every key that is not
 * the current `CACHE`. Ship a new icon or a new font under the old name and
 * that reader keeps the old one — silently, for as long as the cache lives.
 *
 * `docs/DESIGN.md` §9 has stated the rule in prose since the worker was
 * written. Prose is a thing to remember; this is the same argument the
 * tracked-measurement guard makes on the same path, with an exit code.
 *
 * The generated measurements are deliberately exempt: they are served
 * stale-while-revalidate, so a returning reader gets the cached copy AND a
 * fresh one, and their own guard already stands between an uncommitted
 * measurement and a publish.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** The worker, and the assets its name governs. */
const PUBLIC = 'packages/website/public';
const WORKER = `${PUBLIC}/sw.js`;

/** Served stale-while-revalidate, and guarded by their own drift check. */
const EXEMPT = [`${PUBLIC}/benchmarks/`, `${PUBLIC}/site/`, `${PUBLIC}/build.json`];

/** A directory path as a base URL, whatever the platform separator. */
const pathUrl = (/** @type {string} */ dir) => new URL(`file://${resolve(dir)}/`);

/** `CACHE = '…'`, as the worker declares it. */
const CACHE_NAME = /\bCACHE\s*=\s*'([^']+)'/;

/**
 * The `public/` assets a `git status --porcelain` run reports as differing
 * from HEAD, minus the ones the cache name does not govern.
 * @param {string} status - porcelain output, paths relative to the root.
 * @returns {string[]}
 */
export function governedAssets(status) {
  return status.split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    // `XY path` — a rename carries ` -> `, whose destination is the one that ships
    .map((line) => line.slice(2).trim().split(' -> ').pop() ?? '')
    .filter((path) => path !== WORKER && !EXEMPT.some((prefix) => path.startsWith(prefix)));
}

/**
 * The cache name a service-worker source declares, or null.
 * @param {string} source
 * @returns {string | null}
 */
export const cacheNameOf = (source) => CACHE_NAME.exec(source)?.[1] ?? null;

/**
 * The verdict, given what changed and the two cache names. A worker with
 * no committed side is new — there is nothing it could be serving stale
 * bytes against — so anything ships under it.
 * @param {{ changed: string[], cache: string | null, head: string | null }} state
 * @returns {CacheReport}
 */
export function decideCacheBump({ changed, cache, head }) {
  if (cache === null) {
    return { code: 2, changed, cache, head, reason: `${WORKER} declares no CACHE name` };
  }
  const bumped = head === null || cache !== head;
  return { code: changed.length > 0 && !bumped ? 1 : 0, changed, cache, head };
}

/**
 * @typedef {object} CacheReport
 * @property {number} code - 0 clean, 1 an unbumped change, 2 the check could not run
 * @property {string[]} changed - the changed assets the cache name governs
 * @property {string | null} cache - the working tree's cache name
 * @property {string | null} head - HEAD's cache name, null when the worker is new
 * @property {string} [reason] - why the check could not run
 */

/**
 * Whether a `public/` asset changed without the cache name moving with it.
 * @param {{ root?: string }} [options]
 * @returns {CacheReport}
 */
export function checkServiceWorkerCache(options = {}) {
  const cwd = options.root ?? ROOT;
  /** @param {string[]} args */
  const run = (args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  let status;
  let headWorker;
  try {
    status = run(['status', '--porcelain', '--untracked-files=all', '--', PUBLIC]);
    // a worker with no committed side is new: there is nothing it could
    // be serving stale bytes against
    try {
      headWorker = run(['show', `HEAD:${WORKER}`]);
    }
    catch {
      headWorker = null;
    }
  }
  catch (err) {
    return {
      code: 2, changed: [], cache: null, head: null,
      reason: String(/** @type {any} */ (err)?.message ?? err),
    };
  }
  return decideCacheBump({
    changed: governedAssets(status),
    cache: cacheNameOf(readFileSync(new URL(WORKER, pathUrl(cwd)), 'utf8')),
    head: headWorker === null ? null : cacheNameOf(headWorker),
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = checkServiceWorkerCache();
  if (report.code === 2) {
    console.error(`cannot read the service worker's cache state: ${report.reason}`);
    process.exit(2);
  }
  if (report.code === 1) {
    console.error(`${report.changed.length} asset(s) under ${PUBLIC} differ from HEAD, `
      + `and ${WORKER} still declares '${report.cache}':\n\n  ${report.changed.join('\n  ')}\n`);
    console.error('a returning reader is served the cache their browser already holds, so\n'
      + 'shipping these under the old name means they keep the old bytes. Bump the CACHE\n'
      + `name in ${WORKER} — the activate handler then deletes every other key — and\n`
      + 'deploy again. (The generated measurements are exempt: they are served\n'
      + 'stale-while-revalidate and have their own guard.)');
    process.exit(1);
  }
  console.log(report.changed.length === 0
    ? `no ${PUBLIC} asset changed; cache '${report.cache}' stands.`
    : `${report.changed.length} changed asset(s) ship under '${report.cache}' (was '${report.head}').`);
}
