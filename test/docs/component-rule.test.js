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
 * string is never counted. An import of another component is one that names
 * its package, or a relative path that lands in its folder. The engine
 * (`src/*` outside `src/component/`) imports no other component, without
 * exception. The component layer (`src/component/*`) carries one exception,
 * named below with its reason, and it covers no relative path: a published
 * package cannot reach a sibling's folder that way.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
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

/** The components in a directory: each folder holding a manifest, and its package name. @param {string} dir */
const componentsIn = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'package.json')))
  .map((entry) => ({ dir: entry.name, name: JSON.parse(fs.readFileSync(path.join(dir, entry.name, 'package.json'), 'utf8')).name }));

const components = componentsIn(COMPONENTS);
const componentNames = new Set(components.map((component) => component.name));

/**
 * Every import of another component in a components directory, by layer;
 * an edge written as a relative path carries that path. Files are named
 * relative to the directory's parent (`components/<x>/src/…`).
 * @param {string} [dir]
 */
function crossImports(dir = COMPONENTS) {
  const local = componentsIn(dir);
  const names = new Set(local.map((component) => component.name));
  const byFolder = new Map(local.map((component) => [component.dir, component.name]));
  /** @type {Array<{ from: string, layer: 'engine' | 'component', file: string, imports: string, path?: string }>} */
  const found = [];
  for (const { dir: folder, name } of local) {
    for (const file of sources(path.join(dir, folder, 'src'))) {
      const rel = path.relative(path.dirname(dir), file).split(path.sep).join('/');
      const layer = rel.includes('/src/component/') ? 'component' : 'engine';
      for (const { specifier } of scanImports(fs.readFileSync(file, 'utf8'))) {
        if (specifier.startsWith('./') || specifier.startsWith('../')) {
          // the folder of the components directory the path lands in
          const target = byFolder.get(path.relative(dir, path.resolve(path.dirname(file), specifier)).split(path.sep)[0]);
          if (target !== undefined && target !== name) found.push({ from: name, layer, file: rel, imports: target, path: specifier });
          continue;
        }
        const target = packageOf(specifier);
        if (target !== name && names.has(target)) found.push({ from: name, layer, file: rel, imports: target });
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
      && (edge.path !== undefined || !(COMPONENT_LAYER_EXCEPTIONS[edge.from] ?? []).includes(edge.imports)));
    assert.deepStrictEqual(unexpected, []);
  });

  it('the exception is still needed — a stale entry would hide the next edge', () => {
    for (const [from, imports] of Object.entries(COMPONENT_LAYER_EXCEPTIONS)) {
      for (const target of imports) {
        assert.ok(found.some((edge) => edge.from === from && edge.imports === target && edge.path === undefined),
          `${from} → ${target} is no longer imported`);
      }
    }
  });

  it('counts a relative path into another component\'s folder as an import of it, in either layer', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jaren-component-rule-'));
    const dir = path.join(root, 'components');
    const put = (/** @type {string} */ rel, /** @type {string} */ text) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    };
    try {
      put('a/package.json', JSON.stringify({ name: '@x/a' }));
      put('a/src/index.js', "import { b } from '../../b/src/index.js';\nimport './own.js';\nimport '../../../packages/core/src/index.js';\nexport { b };\n");
      put('a/src/own.js', 'export {};\n');
      put('b/package.json', JSON.stringify({ name: '@x/b' }));
      put('b/src/index.js', 'export const b = 1;\n');
      put('b/src/component/index.js', "import { a } from '../../../a/src/index.js';\nimport '@x/a';\nexport { a };\n");
      assert.deepStrictEqual(crossImports(dir), [
        { from: '@x/a', layer: 'engine', file: 'components/a/src/index.js', imports: '@x/b', path: '../../b/src/index.js' },
        { from: '@x/b', layer: 'component', file: 'components/b/src/component/index.js', imports: '@x/a', path: '../../../a/src/index.js' },
        { from: '@x/b', layer: 'component', file: 'components/b/src/component/index.js', imports: '@x/a' },
      ]);
    }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('the manifests agree: md does not depend on mermaid, nor mermaid on charts', () => {
    const manifest = (/** @type {string} */ dir) => JSON.parse(fs.readFileSync(path.join(COMPONENTS, dir, 'package.json'), 'utf8'));
    assert.strictEqual(manifest('md').dependencies['@jarenjs/mermaid'], undefined);
    assert.strictEqual(manifest('mermaid').dependencies['@jarenjs/charts'], undefined);
  });
});
