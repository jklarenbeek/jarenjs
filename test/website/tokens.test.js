//@ts-check
/**
 * @file The site consumes the host token vocabulary from the view package
 * instead of keeping a copy: its stylesheet imports the exported file, and
 * no stylesheet, page or script of the site declares one of its names again (a
 * second definition is a second source of truth, and the two drift).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (/** @type {string} */ rel) => readFileSync(join(ROOT, rel), 'utf8');
const SITE = 'packages/website';

/** The names the exported file declares. */
function exportedNames() {
  const css = read('packages/view/styles/tokens.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const names = new Set([...css.matchAll(/(?:^|[{;\s])(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  assert.ok(names.size >= 30, `${names.size} exported names`);
  return names;
}

/** Every stylesheet, page and script the site writes itself. */
function siteSources() {
  const src = readdirSync(join(ROOT, SITE, 'src'), { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.(?:css|html|js)$/.test(file)).map((file) => `${SITE}/src/${file.split('\\').join('/')}`);
  return [`${SITE}/index.html`, ...src];
}

describe('website — the host tokens come from the view package', () => {
  it('the site stylesheet imports the exported token file', () => {
    const css = read(`${SITE}/src/styles.css`).replace(/\/\*[\s\S]*?\*\//g, '');
    const imports = [...css.matchAll(/@import\s+'([^']+)'\s*;/g)].map((m) => m[1]);
    assert.ok(imports.includes('@jarenjs/view/styles/tokens.css'), imports.join(', '));
    const manifest = JSON.parse(read(`${SITE}/package.json`));
    assert.ok(manifest.dependencies['@jarenjs/view'], 'the site declares the package it imports from');
  });

  it('no site stylesheet or page defines an exported token again', () => {
    const names = exportedNames();
    const sources = siteSources();
    assert.ok(sources.length >= 2, `${sources.length} site sources read`);
    /** @type {string[]} */
    const again = [];
    for (const file of sources) {
      const text = read(file).replace(/\/\*[\s\S]*?\*\//g, '');
      // a declaration (`--bg:`, or `'--bg':` in a style object) or a setProperty('--bg', …)
      const defined = [...text.matchAll(/(?:^|[{;\s"'])(--[a-z0-9-]+)["']?\s*:/g), ...text.matchAll(/setProperty\(\s*["'](--[a-z0-9-]+)/g)];
      for (const m of defined) if (names.has(m[1])) again.push(`${file}: ${m[1]}`);
    }
    assert.deepStrictEqual(again, []);
  });
});
