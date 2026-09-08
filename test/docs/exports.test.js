//@ts-check
/**
 * @file Public discovery is derived from the public surface: every public
 * workspace README carries an export inventory written from its manifest
 * by one census (`scripts/lib/exports.js`), the census is the same one the
 * packed-consumer gate installs from, and the floors prove the scanners
 * still match something.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

import { exportEntries, importSubpaths } from '../../scripts/lib/exports.js';
import { publicWorkspaces, inventoryKey, inventoryTable, exportInventory } from '../../scripts/generate-export-inventory.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('the manifest census', () => {
  it('includes a string root export in both the inventory and runtime probes', () => {
    const pkg = { name: '@jarenjs/x', exports: './src/index.js' };
    assert.deepStrictEqual(exportEntries(pkg), [{
      subpath: '@jarenjs/x', key: '.', kind: 'javascript', target: './src/index.js',
      types: false, expanded: false,
    }]);
    assert.deepStrictEqual(importSubpaths(pkg), ['@jarenjs/x']);
    assert.deepStrictEqual(exportEntries({ name: '@jarenjs/x', exports: {} }), []);
  });

  it('keeps a root condition map attached to its root and declaration', () => {
    const pkg = { name: '@jarenjs/x', exports: {
      types: './dist/types/index.d.ts', import: { default: './src/index.js' },
    } };
    assert.deepStrictEqual(exportEntries(pkg), [{
      subpath: '@jarenjs/x', key: '.', kind: 'javascript', target: './src/index.js',
      types: true, expanded: false,
    }]);
    assert.deepStrictEqual(importSubpaths(pkg), ['@jarenjs/x']);
  });

  it('classifies every export kind, expands a wildcard only where the files are committed, and keeps the root', () => {
    const pkg = {
      name: '@jarenjs/x',
      exports: {
        '.': { types: './dist/types/index.d.ts', default: './src/index.js' },
        './plain': './src/plain.js',
        './schemas/*': './schemas/*',
        './styles/x.css': './styles/x.css',
        './deep/*': { types: './dist/types/deep/*.d.ts', default: './src/deep/*.js' },
        './package.json': './package.json',
      },
    };
    const bare = exportEntries(pkg);
    assert.deepStrictEqual(bare.map((e) => [e.subpath, e.kind, e.types]), [
      ['@jarenjs/x', 'javascript', true],
      ['@jarenjs/x/plain', 'javascript', false],
      ['@jarenjs/x/schemas/*', 'pattern', false],
      ['@jarenjs/x/styles/x.css', 'asset', false],
      ['@jarenjs/x/deep/*', 'pattern', true],
      ['@jarenjs/x/package.json', 'metadata', false],
    ]);
    // the real emit workspace: its schema directory makes the pattern finite
    const emit = publicWorkspaces(ROOT).find((w) => w.name === '@jarenjs/emit');
    const entries = exportEntries(emit.pkg, emit.dir);
    const schemas = entries.filter((e) => e.kind === 'schema');
    assert.ok(schemas.length >= 1, `emit ships ${schemas.length} schema file(s)`);
    assert.ok(schemas.every((e) => e.expanded && e.subpath.startsWith('@jarenjs/emit/schemas/')));
    assert.deepStrictEqual(entries.filter((e) => e.kind === 'javascript').map((e) => e.subpath),
      ['@jarenjs/emit', '@jarenjs/emit/model', '@jarenjs/emit/typescript', '@jarenjs/emit/markdown']);
    // the importable subpaths are the JavaScript ones, wildcards excluded
    assert.deepStrictEqual(importSubpaths(pkg), ['@jarenjs/x', '@jarenjs/x/plain']);
    assert.deepStrictEqual(importSubpaths({ name: '@jarenjs/y' }), ['@jarenjs/y'], 'no exports: the main is the root');
  });

  it('reads nested conditions and never drops a pattern it cannot expand', () => {
    const nested = exportEntries({ name: '@jarenjs/n', exports: {
      '.': { import: { types: './dist/types/index.d.ts', default: './src/index.js' }, require: './dist/index.cjs' },
      './only-types': { types: './dist/types/t.d.ts' },
    } });
    assert.deepStrictEqual(nested.map((e) => [e.subpath, e.kind, e.types, e.target]), [
      ['@jarenjs/n', 'javascript', true, './src/index.js'],
      ['@jarenjs/n/only-types', 'asset', true, null],
    ]);
    assert.deepStrictEqual(importSubpaths({ name: '@jarenjs/n', exports: nested[0] && { '.': { import: { default: './src/index.js' } } } }), ['@jarenjs/n']);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaren-exports-'));
    try {
      fs.mkdirSync(path.join(dir, 'empty'));
      fs.mkdirSync(path.join(dir, 'nested', 'deep'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'nested', 'deep', 'x.js'), '');
      const entries = exportEntries({ name: '@jarenjs/w', exports: {
        './empty/*': './empty/*', './nested/*': './nested/*.js', './two/*/x/*': './two/*/x/*.js', './gone/*': './gone/*',
      } }, dir);
      assert.deepStrictEqual(entries.map((e) => [e.subpath, e.kind]), [
        ['@jarenjs/w/empty/*', 'pattern'],
        ['@jarenjs/w/nested/*', 'pattern'],
        ['@jarenjs/w/two/*/x/*', 'pattern'],
        ['@jarenjs/w/gone/*', 'pattern'],
      ], 'an empty, a subdirectory-only, a two-star and an absent directory all stay patterns');
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('expands a wildcard from the COMMITTED files: a scratch file beside the schemas never enters the inventory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jaren-exports-git-'));
    try {
      const config = path.join(root, 'empty-gitconfig');
      fs.writeFileSync(config, '');
      const env = { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' };
      const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] });
      git('init', '-q');
      git('config', 'user.email', 'test@example.test');
      git('config', 'user.name', 'test');
      const pkgDir = path.join(root, 'pkg');
      fs.mkdirSync(path.join(pkgDir, 'schemas'), { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'schemas', 'a.schema.json'), '{}');
      git('add', '-A');
      git('commit', '-q', '-m', 'one schema');
      fs.writeFileSync(path.join(pkgDir, 'schemas', 'scratch.schema.json'), '{}');
      fs.writeFileSync(path.join(pkgDir, 'schemas', 'staged.schema.json'), '{}');
      git('add', 'pkg/schemas/staged.schema.json');
      const entries = exportEntries({ name: '@jarenjs/g', exports: { './schemas/*': './schemas/*' } }, pkgDir);
      assert.deepStrictEqual(entries.map((e) => e.subpath), ['@jarenjs/g/schemas/a.schema.json', '@jarenjs/g/schemas/staged.schema.json'],
        'committed and staged files are public names; an untracked scratch file is not');
    }
    finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('is the one parser: the packed-consumer gate imports it rather than spelling its own', () => {
    const packed = read('scripts/check-packed-consumers.js');
    assert.match(packed, /from '\.\/lib\/exports\.js'/);
    assert.ok(!/function importSubpaths\(/.test(packed), 'no second census in the packed-consumer check');
    const sources = ['scripts/check-packed-consumers.js', 'scripts/generate-export-inventory.js', 'scripts/lib/exports.js'];
    const definitions = sources.filter((rel) => /export function exportEntries\(|export function importSubpaths\(/.test(read(rel)));
    assert.deepStrictEqual(definitions, ['scripts/lib/exports.js']);
  });
});

describe('every public workspace README carries its derived export inventory', () => {
  const workspaces = publicWorkspaces(ROOT);

  it('there are enough workspaces and exports for the scan to have meant something', () => {
    assert.ok(workspaces.length >= 20, `${workspaces.length} public workspaces`);
    const total = workspaces.reduce((n, w) => n + exportEntries(w.pkg, w.dir).length, 0);
    assert.ok(total >= 150, `${total} exports across the public workspaces`);
    assert.ok(workspaces.every((w) => exportEntries(w.pkg, w.dir).some((e) => e.key === '.')), 'every root is included');
  });

  it('every README has the marker, and the registry answers exactly those keys with the manifest\'s table', () => {
    const facts = exportInventory.facts(new Map());
    for (const workspace of workspaces) {
      const readme = read(path.join(workspace.dir, 'README.md').slice(ROOT.length));
      const key = inventoryKey(workspace.name);
      assert.ok(readme.includes(`<!--fact:${key}-->`), `${workspace.name}: README carries no <!--fact:${key}--> block`);
      assert.ok(typeof facts[key] === 'function', `${workspace.name}: the registry derives ${key}`);
      const table = inventoryTable(workspace);
      assert.ok(readme.includes(table), `${workspace.name}: the README's inventory is not the manifest's (run npm run docs:derive)`);
      // the inventory names every export, once each
      for (const entry of exportEntries(workspace.pkg, workspace.dir)) {
        assert.ok(table.includes(`\`${entry.subpath}\``), `${workspace.name}: ${entry.subpath} is missing from the inventory`);
      }
    }
    assert.strictEqual(Object.keys(facts).length, workspaces.length);
    const docs = exportInventory.docs(ROOT);
    assert.strictEqual(docs.length, workspaces.length, 'one README per public workspace is derived');
  });

  it('a JavaScript row states its declaration status, and every published JavaScript subpath is declared', () => {
    const undeclared = [];
    for (const workspace of workspaces) {
      for (const entry of exportEntries(workspace.pkg, workspace.dir)) {
        if (entry.kind === 'javascript' && !entry.types) undeclared.push(entry.subpath);
      }
    }
    assert.deepStrictEqual(undeclared, [], 'a JavaScript subpath without a declaration');
  });
});
