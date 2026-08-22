//@ts-check
/**
 * @file The service worker's cache name, gated.
 *
 * `public/sw.js` serves the shell, the icons, the manifest and the fonts
 * cache-FIRST, and the only thing that retires a cache is the activate
 * handler deleting every key that is not the current `CACHE`. So a changed
 * asset shipped under an unchanged name is bytes a returning reader never
 * receives — a failure with no symptom on the machine that deployed it.
 * `docs/DESIGN.md` §9 has always stated that rule; this is the gate that
 * holds it, and what follows is its decision table.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

import {
  governedAssets, cacheNameOf, decideCacheBump, checkServiceWorkerCache,
} from '../../scripts/check-sw-cache.js';

const WORKER = new URL('../../packages/website/public/sw.js', import.meta.url);

describe('the assets a cache name governs', function () {
  it('takes the cache-first assets and leaves the revalidated data out', function () {
    assert.deepStrictEqual(governedAssets([
      ' M packages/website/public/manifest.webmanifest',
      '?? packages/website/public/fonts/inter-latin-400-normal.woff2',
      ' D packages/website/public/icon-192.png',
      // the measurements have their own guard, and are served
      // stale-while-revalidate: a cached copy is replaced, never kept
      ' M packages/website/public/benchmarks/validate.json',
      '?? packages/website/public/site/cards.json',
      ' M packages/website/public/build.json',
      // and the worker itself is the thing being bumped
      ' M packages/website/public/sw.js',
    ].join('\n')), [
      'packages/website/public/manifest.webmanifest',
      'packages/website/public/fonts/inter-latin-400-normal.woff2',
      'packages/website/public/icon-192.png',
    ]);
  });

  it('follows a rename to the file that would actually ship', function () {
    assert.deepStrictEqual(
      governedAssets('R  packages/website/public/old.png -> packages/website/public/new.png'),
      ['packages/website/public/new.png']);
  });

  it('reads the name the worker declares', function () {
    assert.strictEqual(cacheNameOf(readFileSync(WORKER, 'utf8')), 'jaren-website-v27');
    assert.strictEqual(cacheNameOf("const CACHE = 'jaren-website-v99';"), 'jaren-website-v99');
    assert.strictEqual(cacheNameOf('const CACHE = computeIt();'), null);
  });
});

describe('the bump decision', function () {
  const state = (changed, cache, head) => decideCacheBump({ changed, cache, head });

  it('refuses a changed asset under an unchanged name', function () {
    const report = state(['packages/website/public/icon-192.png'], 'v27', 'v27');
    assert.strictEqual(report.code, 1);
    assert.deepStrictEqual(report.changed, ['packages/website/public/icon-192.png']);
  });

  it('passes the same change once the name moves', function () {
    assert.strictEqual(state(['packages/website/public/icon-192.png'], 'v28', 'v27').code, 0);
  });

  it('passes a clean tree, bumped or not', function () {
    assert.strictEqual(state([], 'v27', 'v27').code, 0);
    assert.strictEqual(state([], 'v28', 'v27').code, 0);
  });

  it('lets a NEW worker carry anything — it can be stale against nothing', function () {
    assert.strictEqual(state(['packages/website/public/icon-192.png'], 'v1', null).code, 0);
  });

  it('cannot decide for a worker that declares no name, and says so', function () {
    const report = state([], null, 'v27');
    assert.strictEqual(report.code, 2);
    assert.match(String(report.reason), /declares no CACHE name/);
  });
});

describe('the gate over this repository', function () {
  it('runs, and reports a state rather than an unreadable one', function () {
    const report = checkServiceWorkerCache();
    if (report.code === 2) return;   // a tarball or a shallow checkout: nothing to compare
    assert.ok(report.code === 0 || report.code === 1);
    assert.match(String(report.cache), /^jaren-website-v\d+$/);
    if (report.code === 1) {
      assert.fail(`${report.changed.length} public asset(s) ship under an unbumped `
        + `'${report.cache}':\n  ${report.changed.join('\n  ')}`);
    }
  });
});
