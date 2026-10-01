//@ts-check
/**
 * @file The component rule (docs/workflow/CONVENTIONS.md §1): no component
 * imports another. Cooperation across components is by an injected hook —
 * a host hands `mermaidPlugin` to md and charts' `mermaidPieRenderer` to
 * mermaid — never a static edge, so Markdown without diagrams loads no
 * diagram code and mermaid loads no chart code, bundled or not.
 *
 * Every source file of `components/<x>/src` is scanned with the import
 * scanner `@jarenjs/emit/importmap` ships, so an import in a comment or a
 * string is never counted. The engine (`src/*` outside `src/component/`)
 * imports no other component, without exception. The component layer
 * (`src/component/*`) carries one exception, named below with its reason.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanImports } from '@jarenjs/emit/importmap';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const COMPONENTS = path.join(ROOT, 'components');

/**
 * The one exception: the studio is the suite's integrated editor, and its
 * component layer is where it composes the chart and diagram editors of the
 * components it hosts. Its engine stays inside the rule.
 */
const COMPONENT_LAYER_EXCEPTIONS = Object.freeze({
  '@jarenjs/studio': Object.freeze(['@jarenjs/charts', '@jarenjs/mermaid']),
});

/** Every `.js` file under a directory. @param {string} dir @returns {string[]} */
const sources = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const file = path.join(dir, entry.name);
  return entry.isDirectory() ? sources(file) : entry.name.endsWith('.js') ? [file] : [];
});

/** The package an import specifier names. @param {string} specifier */
const packageOf = (specifier) => (specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]);

const components = fs.readdirSync(COMPONENTS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(COMPONENTS, entry.name, 'package.json')))
  .map((entry) => ({ dir: entry.name, name: JSON.parse(fs.readFileSync(path.join(COMPONENTS, entry.name, 'package.json'), 'utf8')).name }));
const componentNames = new Set(components.map((component) => component.name));

/** Every import of another component, by layer. */
function crossImports() {
  /** @type {Array<{ from: string, layer: 'engine' | 'component', file: string, imports: string }>} */
  const found = [];
  for (const { dir, name } of components) {
    for (const file of sources(path.join(COMPONENTS, dir, 'src'))) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      const layer = rel.includes('/src/component/') ? 'component' : 'engine';
      for (const { specifier } of scanImports(fs.readFileSync(file, 'utf8'))) {
        const target = packageOf(specifier);
        if (target !== name && componentNames.has(target)) found.push({ from: name, layer, file: rel, imports: target });
      }
    }
  }
  return found;
}

describe('the component rule — no component imports another', () => {
  const found = crossImports();

  it('there are components to check, and every one is scanned', () => {
    assert.ok(components.length >= 8, `${components.length} components`);
    assert.ok(componentNames.has('@jarenjs/md') && componentNames.has('@jarenjs/mermaid') && componentNames.has('@jarenjs/charts'));
  });

  it('no engine file imports another component', () => {
    assert.deepStrictEqual(found.filter((edge) => edge.layer === 'engine'), []);
  });

  it('no component-layer file does either, but for the one named exception', () => {
    const unexpected = found.filter((edge) => edge.layer === 'component'
      && !(COMPONENT_LAYER_EXCEPTIONS[edge.from] ?? []).includes(edge.imports));
    assert.deepStrictEqual(unexpected, []);
  });

  it('the exception is still needed — a stale entry would hide the next edge', () => {
    for (const [from, imports] of Object.entries(COMPONENT_LAYER_EXCEPTIONS)) {
      for (const target of imports) {
        assert.ok(found.some((edge) => edge.from === from && edge.imports === target), `${from} → ${target} is no longer imported`);
      }
    }
  });

  it('the manifests agree: md does not depend on mermaid, nor mermaid on charts', () => {
    const manifest = (/** @type {string} */ dir) => JSON.parse(fs.readFileSync(path.join(COMPONENTS, dir, 'package.json'), 'utf8'));
    assert.strictEqual(manifest('md').dependencies['@jarenjs/mermaid'], undefined);
    assert.strictEqual(manifest('mermaid').dependencies['@jarenjs/charts'], undefined);
  });
});
