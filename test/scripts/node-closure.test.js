//@ts-check
/**
 * @file The Node closure measurement `scripts/check-tree-shaking.js`
 * commits as `benchmark/node-closures.json`: the modules a fresh Node
 * process loads for one import, attributed to the workspace that owns
 * each file, the live heap they hold, and the staleness check that holds
 * the committed module counts to the tree's.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CLOSURE_RUNS, measureClosures, serializeClosures, staleClosures } from '../../scripts/lib/node-closure.js';

/** Write `files` (a path relative to `root` -> its text) below `root`.
 * @param {string} root @param {Record<string, string>} files */
function plant(root, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** @param {string} name @param {any} exports */
const manifest = (name, exports) => JSON.stringify({ name, version: '1.0.0', type: 'module', exports });

/** One measured entry, its total summed from the split. @param {Record<string, number>} byPackage */
const entry = (byPackage, heapBytes = 1000) => ({
  modules: Object.values(byPackage).reduce((sum, n) => sum + n, 0), byPackage, heapBytes, heapSpreadBytes: 0,
});

describe("a subpath's Node closure, counted in fresh processes", () => {
  /** @type {string} */
  let root;
  /** @param {string} name */
  const workspace = (name) => {
    const dir = join(root, 'node_modules', name);
    return { name, dir, pkg: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) };
  };

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'node-closure-'));
    plant(root, {
      'node_modules/@fx/alpha/package.json': manifest('@fx/alpha', {
        '.': './src/index.js', './leaf': './src/leaf.js', './parts/*': './src/parts/*.js',
        './data.json': './data.json', './package.json': './package.json',
      }),
      'node_modules/@fx/alpha/src/index.js':
        "import './a.js';\nimport { b } from '@fx/beta';\nexport const later = () => import('./heavy.js');\nexport default b;\n",
      'node_modules/@fx/alpha/src/a.js': "import { leaf } from './leaf.js';\nexport const a = leaf;\n",
      'node_modules/@fx/alpha/src/leaf.js': 'export const leaf = 1;\n',
      'node_modules/@fx/alpha/src/heavy.js': 'export const heavy = 1;\n',
      'node_modules/@fx/alpha/src/parts/one.js': "export { leaf as one } from '../leaf.js';\n",
      'node_modules/@fx/alpha/src/parts/two.js': 'export const two = 2;\n',
      'node_modules/@fx/alpha/data.json': '{}\n',
      'node_modules/@fx/beta/package.json': manifest('@fx/beta', { '.': './src/index.js' }),
      'node_modules/@fx/beta/src/index.js':
        "import 'node:path';\nimport table from './table.json' with { type: 'json' };\nimport { plain } from 'plain';\nexport const b = table.length + plain;\n",
      'node_modules/@fx/beta/src/table.json': '[1, 2]\n',
      'node_modules/plain/package.json': JSON.stringify({ name: 'plain', type: 'module', exports: './index.js' }),
      'node_modules/plain/index.js': 'export const plain = 1;\n',
      'node_modules/@fx/broken/package.json': manifest('@fx/broken', { '.': './src/index.js' }),
      'node_modules/@fx/broken/src/index.js': "throw new Error('refuses to load');\n",
      // a hundred thousand small objects, about 3 MB: one module keeps them, the other drops them
      'node_modules/@fx/keeps/package.json': manifest('@fx/keeps', { '.': './src/index.js' }),
      'node_modules/@fx/keeps/src/index.js': 'export const kept = Array.from({ length: 100000 }, (_, i) => ({ i }));\n',
      'node_modules/@fx/drops/package.json': manifest('@fx/drops', { '.': './src/index.js' }),
      'node_modules/@fx/drops/src/index.js': 'Array.from({ length: 100000 }, (_, i) => ({ i }));\nexport const dropped = true;\n',
    });
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('counts every module one import loads, by the workspace that owns its file', () => {
    const measured = measureClosures({ cwd: root, workspaces: [workspace('@fx/alpha'), workspace('@fx/beta')], runs: 3 });
    assert.deepStrictEqual(Object.fromEntries(Object.entries(measured.subpaths)
      .map(([subpath, { modules, byPackage, wildcard }]) => [subpath, [modules, byPackage, wildcard]])), {
      // alpha's index, a and leaf; beta's index and its JSON table; `plain`
      // belongs to no workspace. `node:path` is a built-in, and the module
      // behind an import() nobody calls is never loaded.
      '@fx/alpha': [6, { '(other)': 1, alpha: 3, beta: 2 }, undefined],
      '@fx/alpha/leaf': [1, { alpha: 1 }, undefined],
      // a wildcard's files are subpaths of their own; data.json and
      // package.json are not module graphs and are not measured
      '@fx/alpha/parts/one': [2, { alpha: 2 }, './parts/*'],
      '@fx/alpha/parts/two': [1, { alpha: 1 }, './parts/*'],
      '@fx/beta': [3, { '(other)': 1, beta: 2 }, undefined],
    });
    assert.deepStrictEqual([measured.runtime, measured.platform, measured.runs],
      [process.version, `${process.platform} ${process.arch}`, 3]);
    for (const [subpath, { heapBytes, heapSpreadBytes }] of Object.entries(measured.subpaths)) {
      assert.ok(Number.isInteger(heapBytes) && heapBytes > 0, `${subpath} holds ${heapBytes} bytes`);
      assert.ok(Number.isInteger(heapSpreadBytes) && heapSpreadBytes >= 0, `${subpath} spread ${heapSpreadBytes}`);
    }
  });

  it('holds what the import keeps and not the garbage it leaves', () => {
    const { subpaths } = measureClosures({ cwd: root, workspaces: [workspace('@fx/keeps'), workspace('@fx/drops')], runs: 1 });
    assert.ok(subpaths['@fx/keeps'].heapBytes > 2_000_000, `kept ${subpaths['@fx/keeps'].heapBytes} bytes`);
    assert.ok(subpaths['@fx/drops'].heapBytes < 1_000_000, `dropped ${subpaths['@fx/drops'].heapBytes} bytes`);
  });

  it('names the subpath a fresh process cannot import, and why', () => {
    assert.throws(() => measureClosures({ cwd: root, workspaces: [workspace('@fx/broken')], runs: 1 }),
      /@fx\/broken: a fresh Node process could not import it[^]*refuses to load/);
  });
});

describe('the runs of one measurement', () => {
  // a probe that answers from a script: no process runs, so the files need not exist
  const dir = realpathSync(tmpdir());
  const workspaces = [{ name: '@x/a', dir, pkg: { name: '@x/a', exports: { '.': './index.js', './b': './b.js' } } }];
  const A = pathToFileURL(join(dir, 'index.js')).href;
  const B = pathToFileURL(join(dir, 'b.js')).href;

  it('interleave the subpaths, publish the median heap and the spread, and agree on the modules', () => {
    /** @type {string[]} */
    const order = [];
    const heaps = { '@x/a': [300, 100, 200], '@x/a/b': [50, 70, 60] };
    const measured = measureClosures({ cwd: '/nowhere', workspaces, runs: 3, probe: (specifier) => {
      order.push(specifier);
      const run = order.filter((seen) => seen === specifier).length - 1;
      return { loaded: specifier === '@x/a' ? [A, B] : [B], heap: heaps[/** @type {'@x/a'} */ (specifier)][run] };
    } });
    assert.deepStrictEqual(order, ['@x/a', '@x/a/b', '@x/a', '@x/a/b', '@x/a', '@x/a/b']);
    assert.deepStrictEqual(measured.subpaths, {
      '@x/a': { modules: 2, byPackage: { a: 2 }, heapBytes: 200, heapSpreadBytes: 200 },
      '@x/a/b': { modules: 1, byPackage: { a: 1 }, heapBytes: 60, heapSpreadBytes: 20 },
    });
    // an even number of runs takes the mean of the middle two
    let calls = 0;
    const even = measureClosures({ cwd: '/nowhere', workspaces, runs: 2,
      probe: () => ({ loaded: [A], heap: [100, 100, 301, 301][calls++] }) });
    assert.deepStrictEqual([even.subpaths['@x/a'].heapBytes, even.subpaths['@x/a'].heapSpreadBytes], [201, 201]);
  });

  it('refuse to publish a subpath whose fresh processes loaded different modules', () => {
    let calls = 0;
    assert.throws(() => measureClosures({ cwd: '/nowhere', workspaces, runs: 2,
      probe: () => ({ loaded: calls++ === 2 ? [A, B] : [A], heap: 1 }) }),
    /@x\/a loaded different modules in two fresh processes: 1 \(a 1\), then 2 \(a 2\)/);
  });

  it('are at least five for the committed figures', () => {
    assert.ok(CLOSURE_RUNS >= 5, `${CLOSURE_RUNS} runs`);
  });
});

describe('the committed module counts are held to the tree', () => {
  const measured = { runtime: 'v24.0.0', platform: 'linux x64', runs: 1, subpaths: {
    '@x/a': entry({ a: 2, core: 3 }), '@x/a/b': entry({ a: 1 }),
  } };

  it('is green when every count agrees, whatever the heap did', () => {
    assert.deepStrictEqual(staleClosures(measured, measured), []);
    const moved = structuredClone(measured);
    moved.subpaths['@x/a'].heapBytes = 99999;
    moved.subpaths['@x/a'].heapSpreadBytes = 512;
    assert.deepStrictEqual(staleClosures(moved, measured), []);
  });

  it('names a mutated committed count, both ways round', () => {
    const mutated = structuredClone(measured);
    mutated.subpaths['@x/a'] = entry({ a: 2, core: 4 });
    assert.deepStrictEqual(staleClosures(mutated, measured), ['  @x/a: committed 6 (core 4, a 2), measured 5 (core 3, a 2)']);
    assert.deepStrictEqual(staleClosures(measured, mutated), ['  @x/a: committed 5 (core 3, a 2), measured 6 (core 4, a 2)']);
  });

  it('names a module that moved between packages though the total did not', () => {
    const mutated = structuredClone(measured);
    mutated.subpaths['@x/a'] = entry({ a: 3, core: 2 });
    assert.deepStrictEqual(staleClosures(mutated, measured), ['  @x/a: committed 5 (a 3, core 2), measured 5 (core 3, a 2)']);
  });

  it('names a subpath the file lacks and one the manifests no longer export', () => {
    const lacking = structuredClone(measured);
    delete lacking.subpaths['@x/a/b'];
    assert.deepStrictEqual(staleClosures(lacking, measured), ['  @x/a/b: not in the committed file, measured 1 (a 1)']);
    assert.deepStrictEqual(staleClosures(measured, lacking), ['  @x/a/b: committed 1 (a 1), no longer an importable subpath']);
  });
});

describe('the committed file', () => {
  it('writes one line per subpath, in subpath order, and reads back the same', () => {
    const measured = { runtime: 'v24.0.0', platform: 'linux x64', runs: 5, subpaths: {
      '@x/b': entry({ b: 1 }, 7), '@x/a/w': { ...entry({ a: 1 }, 5), wildcard: './*' }, '@x/a': entry({ core: 3, a: 2 }, 9),
    } };
    const text = serializeClosures(measured);
    assert.strictEqual(text, [
      '{',
      '  "runtime": "v24.0.0",',
      '  "platform": "linux x64",',
      '  "runs": 5,',
      '  "subpaths": {',
      '    "@x/a": {"modules":5,"byPackage":{"a":2,"core":3},"heapBytes":9,"heapSpreadBytes":0},',
      '    "@x/a/w": {"modules":1,"byPackage":{"a":1},"heapBytes":5,"heapSpreadBytes":0,"wildcard":"./*"},',
      '    "@x/b": {"modules":1,"byPackage":{"b":1},"heapBytes":7,"heapSpreadBytes":0}',
      '  }',
      '}',
      '',
    ].join('\n'));
    assert.deepStrictEqual(JSON.parse(text), { ...measured, subpaths: {
      '@x/a': { modules: 5, byPackage: { a: 2, core: 3 }, heapBytes: 9, heapSpreadBytes: 0 },
      '@x/a/w': measured.subpaths['@x/a/w'],
      '@x/b': measured.subpaths['@x/b'],
    } });
  });
});
