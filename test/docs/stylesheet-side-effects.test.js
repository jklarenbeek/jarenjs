//@ts-check
/**
 * @file A package that exports a stylesheet declares it a side effect. A
 * bundler that honours `sideEffects` drops a bare `import 'pkg/x.css'` from
 * a package marked side-effect free (webpack does), and the host silently
 * loses the styles; a list naming the stylesheets keeps them while the
 * JavaScript stays shakeable.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { exportEntries } from '../../scripts/lib/exports.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Every workspace manifest the root lists. */
function workspaces() {
  const root = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return root.workspaces.map((/** @type {string} */ dir) => ({ dir, pkg: JSON.parse(fs.readFileSync(path.join(ROOT, dir, 'package.json'), 'utf8')) }));
}

/**
 * Whether a `sideEffects` pattern covers a package-relative file, as webpack
 * reads it: a pattern without a slash matches the file name at any depth,
 * `**` spans directories, `*` stays within one.
 * @param {string} pattern
 * @param {string} file - package-relative, forward slashes, no `./`
 */
function sideEffectCovers(pattern, file) {
  const glob = pattern.replace(/^\.\//, '');
  const full = glob.includes('/') ? glob : `**/${glob}`;
  const source = full.split(/(\*\*\/|\*\*|\*)/).map((part) => (part === '**/' ? '(?:.*/)?' : part === '**' ? '.*' : part === '*' ? '[^/]*'
    : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))).join('');
  return new RegExp(`^${source}$`).test(file);
}

describe('stylesheet exports and side effects', () => {
  it('reads a sideEffects pattern the way a bundler does', () => {
    assert.ok(sideEffectCovers('**/*.css', 'styles/tokens.css'));
    assert.ok(sideEffectCovers('*.css', 'styles/deep/x.css'));
    assert.ok(sideEffectCovers('./styles/*.css', 'styles/x.css'));
    assert.ok(!sideEffectCovers('./styles/*.css', 'styles/deep/x.css'));
    assert.ok(!sideEffectCovers('**/*.css', 'src/index.js'));
  });

  it('a package exporting a stylesheet never declares itself side-effect free, and its list names the stylesheet', () => {
    /** @type {string[]} */
    const wrong = [];
    let sheets = 0;
    for (const { dir, pkg } of workspaces()) {
      const css = exportEntries(pkg, path.join(ROOT, dir)).map((e) => e.target).filter((t) => typeof t === 'string' && t.endsWith('.css'));
      if (css.length === 0) continue;
      sheets += css.length;
      const declared = pkg.sideEffects;
      if (declared === false) { wrong.push(`${pkg.name}: sideEffects is false`); continue; }
      if (declared === undefined || declared === true) continue;
      for (const target of css) {
        const file = target.replace(/^\.\//, '');
        if (!declared.some((/** @type {string} */ p) => sideEffectCovers(p, file))) wrong.push(`${pkg.name}: ${file} is not in sideEffects`);
      }
    }
    assert.deepStrictEqual(wrong, []);
    assert.ok(sheets >= 13, `${sheets} exported stylesheets read`);
  });
});
