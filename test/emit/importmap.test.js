//@ts-check
/**
 * `@jarenjs/emit/importmap` and `jaren-emit importmap`: serving installed
 * packages unbundled. The fixture tree is written into a temporary directory
 * from a description below — a committed `node_modules` would be ignored —
 * and carries the cases that matter: a wildcard export, a dependency closure,
 * a nested second copy of a package, a literal dynamic import, and imports
 * that are not imports (in a comment, in a string, after a regex holding a
 * quote).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildImportMap, expandExports, exportTarget, scanImports } from '@jarenjs/emit/importmap';

const CLI = fileURLToPath(new URL('../../packages/emit/src/cli.js', import.meta.url));

/** The installed tree, as `path → content` (objects are written as JSON). */
const TREE = {
  'node_modules/@jarenjs/app/package.json': {
    name: '@jarenjs/app', version: '1.0.0',
    exports: {
      '.': { types: './dist/index.d.ts', default: './src/index.js' },
      './routes': './src/routes.js',
      './schemas/*': './schemas/*',
      './package.json': './package.json',
    },
    dependencies: { '@jarenjs/view': '1.0.0', '@jarenjs/core': '1.0.0' },
  },
  'node_modules/@jarenjs/app/src/index.js': [
    "import { h } from '@jarenjs/view';",
    "import { scan } from '@jarenjs/core/scan';",
    "import './side.js';",
    "// import './commented.js';",
    "const fake = \"import x from './fake.js'\";",
    "const re = /['\"]/g;",
    "export { routes } from './routes.js';",
    "export const lazy = () => import('./lazy.js');",
    'export { h, scan, fake, re };',
  ].join('\n'),
  'node_modules/@jarenjs/app/src/routes.js': 'export const routes = 1;\n',
  'node_modules/@jarenjs/app/src/side.js': 'export {};\n',
  'node_modules/@jarenjs/app/src/lazy.js': "import { deep } from './deep/deep.js';\nexport default deep;\n",
  'node_modules/@jarenjs/app/src/deep/deep.js': 'export const deep = 1;\n',
  'node_modules/@jarenjs/app/src/commented.js': 'export {};\n',
  'node_modules/@jarenjs/app/schemas/a.schema.json': { type: 'string' },
  'node_modules/@jarenjs/app/schemas/b.schema.json': { type: 'number' },
  'node_modules/@jarenjs/view/package.json': {
    name: '@jarenjs/view', version: '1.0.0',
    exports: { '.': './src/index.js', './helpers/*': './src/helpers/*.js' },
    dependencies: { '@jarenjs/core': '1.0.0' },
  },
  'node_modules/@jarenjs/view/src/index.js': "import { x } from './helpers/x.js';\nimport '@jarenjs/core';\nexport const h = x;\n",
  'node_modules/@jarenjs/view/src/helpers/x.js': 'export const x = 1;\n',
  'node_modules/@jarenjs/view/src/helpers/y.js': 'export const y = 1;\n',
  // a second copy of core, nested under view
  'node_modules/@jarenjs/view/node_modules/@jarenjs/core/package.json': {
    name: '@jarenjs/core', version: '0.9.0', exports: { '.': './src/index.js' },
  },
  'node_modules/@jarenjs/view/node_modules/@jarenjs/core/src/index.js': 'export const old = 1;\n',
  'node_modules/@jarenjs/core/package.json': {
    name: '@jarenjs/core', version: '1.0.0', exports: { '.': './src/index.js', './scan': './src/scan.js' },
  },
  'node_modules/@jarenjs/core/src/index.js': "import { readFileSync } from 'node:fs';\nexport const core = readFileSync;\n",
  'node_modules/@jarenjs/core/src/scan.js': 'export const scan = 1;\n',
};

/** Write `TREE` (plus `extra`) into a fresh directory. @param {Record<string, any>} [extra] */
function installTree(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jaren-importmap-'));
  for (const [file, content] of Object.entries({ ...TREE, ...extra })) {
    const target = path.join(root, ...file.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return root;
}

/** @param {string} root @param {string[]} args */
const runCli = (root, args) => spawnSync(process.execPath, [CLI, 'importmap', '--root', root, ...args], { encoding: 'utf8' });

const EXPECTED_IMPORTS = {
  '@jarenjs/app': '/vendor/@jarenjs/app/src/index.js',
  '@jarenjs/app/package.json': '/vendor/@jarenjs/app/package.json',
  '@jarenjs/app/routes': '/vendor/@jarenjs/app/src/routes.js',
  '@jarenjs/app/schemas/a.schema.json': '/vendor/@jarenjs/app/schemas/a.schema.json',
  '@jarenjs/app/schemas/b.schema.json': '/vendor/@jarenjs/app/schemas/b.schema.json',
  '@jarenjs/core': '/vendor/@jarenjs/core/src/index.js',
  '@jarenjs/core/scan': '/vendor/@jarenjs/core/src/scan.js',
  '@jarenjs/view': '/vendor/@jarenjs/view/src/index.js',
  '@jarenjs/view/helpers/x': '/vendor/@jarenjs/view/src/helpers/x.js',
  '@jarenjs/view/helpers/y': '/vendor/@jarenjs/view/src/helpers/y.js',
};

const EXPECTED_FILES = [
  '/vendor/@jarenjs/app/package.json',
  '/vendor/@jarenjs/app/schemas/a.schema.json',
  '/vendor/@jarenjs/app/schemas/b.schema.json',
  '/vendor/@jarenjs/app/src/deep/deep.js',
  '/vendor/@jarenjs/app/src/index.js',
  '/vendor/@jarenjs/app/src/lazy.js',
  '/vendor/@jarenjs/app/src/routes.js',
  '/vendor/@jarenjs/app/src/side.js',
  '/vendor/@jarenjs/core/src/index.js',
  '/vendor/@jarenjs/core/src/scan.js',
  '/vendor/@jarenjs/view/src/helpers/x.js',
  '/vendor/@jarenjs/view/src/helpers/y.js',
  '/vendor/@jarenjs/view/src/index.js',
];

describe('buildImportMap — an installed tree, served unbundled', () => {
  it('maps every export, wildcards expanded, and lists every file the entries reach', () => {
    const root = installTree();
    try {
      const result = buildImportMap({ packages: ['app', 'view'], root, prefix: '/vendor/' });
      assert.deepStrictEqual(result.imports, EXPECTED_IMPORTS);
      assert.deepStrictEqual(result.files, EXPECTED_FILES);
      assert.deepStrictEqual(result.unresolved, []);
      assert.deepStrictEqual(result.duplicates, [{ name: '@jarenjs/core',
        paths: ['node_modules/@jarenjs/core', 'node_modules/@jarenjs/view/node_modules/@jarenjs/core'] }]);
    }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('names a duplicate relative to the root it was given, also when that root is a link', () => {
    const root = installTree();
    const link = `${root}-link`;
    try {
      fs.symlinkSync(root, link, 'junction');
      const result = buildImportMap({ packages: ['app', 'view'], root: link, prefix: '/vendor/' });
      assert.deepStrictEqual(result.duplicates, [{ name: '@jarenjs/core',
        paths: ['node_modules/@jarenjs/core', 'node_modules/@jarenjs/view/node_modules/@jarenjs/core'] }]);
      assert.deepStrictEqual(result.imports, EXPECTED_IMPORTS);
    }
    finally {
      fs.rmSync(link, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports what the map cannot resolve: an undeclared package, a file outside the package, a missing file', () => {
    const root = installTree({
      'node_modules/@jarenjs/core/src/scan.js': "import '@jarenjs/missing';\nimport '../../outside.js';\nimport './nowhere.js';\n",
    });
    try {
      const { unresolved } = buildImportMap({ packages: ['core'], root, prefix: '/vendor/' });
      // sorted by specifier, code unit by code unit; each credited to the file that imports it
      assert.deepStrictEqual(unresolved, [
        { specifier: '../../outside.js', from: '@jarenjs/core/src/scan.js' },
        { specifier: './nowhere.js', from: '@jarenjs/core/src/scan.js' },
        { specifier: '@jarenjs/missing', from: '@jarenjs/core/src/scan.js' },
      ]);
    }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('serves a dependency installed only nested from where it sits, and never an unused root copy', () => {
    const root = installTree({
      'node_modules/@jarenjs/view/package.json': { name: '@jarenjs/view', version: '1.0.0',
        exports: { '.': './src/index.js' }, dependencies: { '@jarenjs/only': '1' } },
      'node_modules/@jarenjs/view/src/index.js': "import '@jarenjs/only';\n",
      'node_modules/@jarenjs/view/node_modules/@jarenjs/only/package.json': { name: '@jarenjs/only', version: '0.9.0', exports: { '.': './i.js' } },
      'node_modules/@jarenjs/view/node_modules/@jarenjs/only/i.js': 'export const v = 9;\n',
      'node_modules/@jarenjs/only/package.json': { name: '@jarenjs/only', version: '2.0.0', exports: { '.': './i.js' } },
      'node_modules/@jarenjs/only/i.js': 'export const v = 2;\n',
    });
    try {
      const result = buildImportMap({ packages: ['view'], root, prefix: '/vendor/' });
      assert.strictEqual(result.imports['@jarenjs/only'], '/vendor/@jarenjs/view/node_modules/@jarenjs/only/i.js');
      assert.ok(result.files.includes('/vendor/@jarenjs/view/node_modules/@jarenjs/only/i.js'));
      assert.ok(!result.files.includes('/vendor/@jarenjs/only/i.js'), 'the unused root copy is not served');
      assert.deepStrictEqual(result.unresolved, []);
    }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('reports a target Node refuses instead of mapping it, and maps nothing a null withholds', () => {
    const root = installTree({
      'node_modules/@jarenjs/core/package.json': {
        name: '@jarenjs/core', version: '1.0.0',
        exports: { '.': './src/index.js', './x': './../outside.js', './hidden/*': null, './scan': './src/scan.js' },
      },
    });
    try {
      const { imports, unresolved } = buildImportMap({ packages: ['core'], root, prefix: '/vendor/' });
      assert.deepStrictEqual(Object.keys(imports), ['@jarenjs/core', '@jarenjs/core/scan']);
      assert.deepStrictEqual(unresolved, [{ specifier: '@jarenjs/core/x', from: '@jarenjs/core/package.json' }]);
    }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses what it does not take, and a package that is not installed', () => {
    const root = installTree();
    try {
      for (const [options, pattern] of /** @type {[any, RegExp][]} */ ([
        [null, /options are/], [{ packages: [] }, /non-empty list/], [{ packages: ['app'], nope: 1 }, /does not take 'nope'/],
        [{ packages: ['app'], root, prefix: '/vendor' }, /ending in \//], [{ packages: ['ghost'], root }, /not installed/],
      ])) assert.throws(() => buildImportMap(options), (error) => error instanceof TypeError && pattern.test(error.message));
    }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('jaren-emit importmap', () => {
  it('refuses a nested duplicate without --allow-duplicates, and names it', () => {
    const root = installTree();
    try {
      const run = runCli(root, ['--packages', 'app,view', '--prefix', '/vendor/']);
      assert.strictEqual(run.status, 1);
      assert.strictEqual(run.stdout, '');
      assert.match(run.stderr, /@jarenjs\/core is installed more than once: node_modules\/@jarenjs\/core, node_modules\/@jarenjs\/view\/node_modules\/@jarenjs\/core/);
    }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('prints the import map with --allow-duplicates, the same bytes twice, and the files with --files', () => {
    const root = installTree();
    try {
      const first = runCli(root, ['--packages', 'app,view', '--prefix', '/vendor/', '--allow-duplicates']);
      const second = runCli(root, ['--packages', 'app,view', '--prefix', '/vendor/', '--allow-duplicates']);
      assert.strictEqual(first.status, 0, first.stderr);
      assert.strictEqual(first.stdout, second.stdout);
      assert.deepStrictEqual(JSON.parse(first.stdout), { imports: EXPECTED_IMPORTS });
      assert.match(first.stderr, /^warning: @jarenjs\/core is installed more than once/);
      const listed = runCli(root, ['--packages', 'app,view', '--prefix', '/vendor/', '--allow-duplicates', '--files']);
      assert.deepStrictEqual(listed.stdout.trim().split('\n'), EXPECTED_FILES);
      const deduped = installTree();
      fs.rmSync(path.join(deduped, 'node_modules/@jarenjs/view/node_modules'), { recursive: true });
      const clean = runCli(deduped, ['--packages', 'app,view', '--prefix', '/vendor/']);
      fs.rmSync(deduped, { recursive: true, force: true });
      assert.strictEqual(clean.status, 0, clean.stderr);
      assert.strictEqual(clean.stdout, first.stdout);
    }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses an unknown option and a missing --packages', () => {
    for (const args of [['--nope'], []]) {
      const run = spawnSync(process.execPath, [CLI, 'importmap', ...args], { encoding: 'utf8' });
      assert.strictEqual(run.status, 2, args.join(' '));
    }
  });
});

describe('scanImports — imports, never a comment or a string', () => {
  it('reads every import form, in source order', () => {
    const source = [
      "import a from './a.js';",
      "import { b, c as d } from './b.js';",
      "import * as e from './e.js';",
      "import f, { g } from\n  './f.js';",
      "import './side.js';",
      "import data from './data.json' with { type: 'json' };",
      "export * from './star.js';",
      "export * as ns from './ns.js';",
      "export { h } from './h.js';",
      'const later = import(`./template.js`);',
      "const lazy = await import('./lazy.js', { with: { type: 'json' } });",
      // a regular expression holding a quote is not a string: the import after it is read
      'const quote = /"/; import after from \'./after-regex.js\'; const tail = "";',
    ].join('\n');
    assert.deepStrictEqual(scanImports(source).map((i) => [i.specifier, i.dynamic]), [
      ['./a.js', false], ['./b.js', false], ['./e.js', false], ['./f.js', false], ['./side.js', false],
      ['./data.json', false], ['./star.js', false], ['./ns.js', false], ['./h.js', false],
      ['./template.js', true], ['./lazy.js', true], ['./after-regex.js', false],
    ]);
  });

  it('reads nothing in a comment, a string, a template, after a regex with a quote, or a computed import', () => {
    const source = [
      "// import './line.js'",
      "/* export * from './block.js' */",
      "const s = \"import x from './string.js'\";",
      "const t = `import './template.js' ${'x'}`;",
      "const r = /'/g; const q = \"import('./after-regex.js')\";",
      'const name = "./computed.js"; const c = import(name);',
      'export { local }; const local = 1;',
      'const o = { import: 1 }; o.import(\'./method.js\');',
      'console.log(import.meta.url);',
    ].join('\n');
    assert.deepStrictEqual(scanImports(source), []);
  });

  it('reads an import inside a template substitution', () => {
    assert.deepStrictEqual(scanImports('const t = `${await import(\'./inside.js\')}`;'),
      [{ specifier: './inside.js', dynamic: true }]);
  });

  it('reads a binding named by a string (ES2022), in an import and an export', () => {
    const source = [
      "import { \"a-b\" as ab } from './named.js';",
      "import def, { \"x y\" as xy } from './named2.js';",
      "export { ab as \"c-d\" } from './named3.js';",
      "export * as \"e f\" from './named4.js';",
    ].join('\n');
    assert.deepStrictEqual(scanImports(source).map((i) => i.specifier), ['./named.js', './named2.js', './named3.js', './named4.js']);
  });

  it('tells a division from a regular expression where it decides what follows', () => {
    for (const [code, specifier] of [
      ["const half = mod.default / 2; const m = import('./after-property.js');", './after-property.js'],
      ["const q = i++ / 2; const m = import('./after-increment.js');", './after-increment.js'],
      ["const q = i-- / 2; const m = import('./after-decrement.js');", './after-decrement.js'],
      ["if (s) /[/*]/.test(s);\nconst m = import('./after-if-regex.js');\nconst t = 1; /* tail */", './after-if-regex.js'],
      ["while (s) /`/.test(s);\nconst m = import('./after-while-regex.js');\nconst t = `tail`;", './after-while-regex.js'],
      ["const r = (a) / 2; const m = import('./after-paren-division.js'); const u = '/';", './after-paren-division.js'],
    ]) assert.deepStrictEqual(scanImports(code).map((i) => i.specifier), [specifier], code);
  });

  it('reads no clause where import is a key, and no phantom from a tag named from', () => {
    assert.deepStrictEqual(scanImports("export const conditions = { import: true, require: false };\nexport { helper } from './helper.js';")
      .map((i) => i.specifier), ['./helper.js']);
    assert.deepStrictEqual(scanImports("const from = (s) => s[0];\nconst cfg = { import: true };\nconst p = from`./phantom.js`;"), []);
    // an export list with no from ends at its semicolon: a later tag named from is no source
    assert.deepStrictEqual(scanImports("export { local };\nconst from = (s) => s[0];\nconst p = from`./phantom.js`;\nconst local = 1;"), []);
    assert.deepStrictEqual(scanImports("class C { import(x) { return x; } }\nexport * from './star.js';").map((i) => i.specifier),
      ['./star.js']);
  });
});

describe('exportTarget and expandExports — the one export expansion', () => {
  it('resolves conditions in the manifest\'s own order, through nesting and fallback arrays', () => {
    assert.strictEqual(exportTarget({ node: './n.js', default: './d.js' }, ['browser', 'import', 'default']), './d.js');
    assert.strictEqual(exportTarget({ browser: './b.js', default: './d.js' }, ['browser', 'import', 'default']), './b.js');
    assert.strictEqual(exportTarget({ default: './d.js', browser: './b.js' }, ['browser', 'import', 'default']), './d.js');
    assert.strictEqual(exportTarget({ import: { types: './t.d.ts', default: './i.js' } }, ['import', 'default']), './i.js');
    assert.strictEqual(exportTarget([{ worker: './w.js' }, './fallback.js'], ['default']), './fallback.js');
    assert.strictEqual(exportTarget({ types: './t.d.ts' }, ['default']), null);
  });

  it('expands a single-star wildcard through the lister it is handed, and keeps anything else a pattern', () => {
    const manifest = { exports: {
      './s/*': './schemas/*.json', './two/*/*': './two/*/*.js', './up/*': '../up/*.js', './none/*': './none/*.js',
    } };
    // the lister answers every folder: refusing '../up' is the expansion's own decision
    const listFiles = (/** @type {string} */ folder) => (folder === './schemas' ? ['a.json', 'b.json', 'c.txt']
      : folder === '../up' || folder === './two' ? ['x.js'] : null);
    const rows = expandExports(manifest, { conditions: ['default'], listFiles });
    assert.deepStrictEqual(rows.map((r) => [r.key, r.target, r.expanded, r.unexpanded]), [
      ['./s/a', './schemas/a.json', true, false],
      ['./s/b', './schemas/b.json', true, false],
      ['./two/*/*', './two/*/*.js', false, true],
      ['./up/*', '../up/*.js', false, true],
      ['./none/*', './none/*.js', false, true],
    ]);
    assert.deepStrictEqual(expandExports({ exports: './main.js' }, { conditions: ['default'] }).map((r) => [r.key, r.target]),
      [['.', './main.js']]);
    assert.deepStrictEqual(expandExports({ main: './lib.js' }, { conditions: ['default'] }).map((r) => [r.key, r.target]),
      [['.', './lib.js']]);
    assert.deepStrictEqual(expandExports({ exports: { import: './i.js', default: './d.js' } }, { conditions: ['default'] })
      .map((r) => [r.key, r.target]), [['.', './d.js']]);
  });

  it('resolves each subpath as Node does: an exact key, then the longest pattern, and a null withholds', () => {
    const listFiles = (/** @type {string} */ folder) => ({
      './dist': ['a.js', 'utils.js', 'utils/index.js'],
      './src': ['a.js', 'features/a.js', 'features/private-internal/x.js'],
      './lib': ['a.js'],
    })[folder] ?? null;
    const rows = (/** @type {any} */ exports) => expandExports({ exports }, { conditions: ['default'], listFiles })
      .map((r) => [r.key, r.target]);
    // an exact key wins over a pattern that also expands to it, whatever the order
    assert.deepStrictEqual(rows({ './*': './dist/*.js', './utils': './dist/utils/index.js' }),
      [['./a', './dist/a.js'], ['./utils/index', './dist/utils/index.js'], ['./utils', './dist/utils/index.js']]);
    // the pattern with the longer part before its * wins
    assert.deepStrictEqual(rows({ './*': './lib/*', './*.js': './src/*.js' }).filter(([key]) => key === './a.js'),
      [['./a.js', './src/a.js']]);
    // a null target withholds its subpaths and asks for nothing
    assert.deepStrictEqual(rows({ './*': './src/*', './features/private-internal/*': null }),
      [['./a.js', './src/a.js'], ['./features/a.js', './src/features/a.js']]);
  });

  it('expands a * across folders, as Node matches it', () => {
    const rows = expandExports({ exports: { './*': './src/*' } },
      { conditions: ['default'], listFiles: (folder) => (folder === './src' ? ['top.js', 'nested/deep.js'] : null) });
    assert.deepStrictEqual(rows.map((r) => r.key), ['./nested/deep.js', './top.js']);
  });

  it('marks a target Node refuses: not under ./, or holding .., . or node_modules', () => {
    const rows = expandExports({ exports: {
      './ok': './ok.js', './x': './../outside.js', './y': 'y.js', './z': './node_modules/dep/z.js', './w': './a/%2e%2e/w.js',
    } }, { conditions: ['default'] });
    assert.deepStrictEqual(rows.map((r) => [r.key, r.invalid]),
      [['./ok', false], ['./x', true], ['./y', true], ['./z', true], ['./w', true]]);
  });
});
