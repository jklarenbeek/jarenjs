//@ts-check
/**
 * @file The ONE census of a workspace manifest's `exports`: what a
 * consumer can import, what each subpath is, and whether a declaration
 * rides with it. Two gates read it — the packed-consumer check, which
 * installs every JavaScript subpath from a tarball and imports it, and
 * the README export inventory, which writes the same list where a reader
 * looks — so a manifest change reaches both from one parser, and a
 * second spelling of "the public subpaths" cannot drift from the first.
 *
 * Wildcards (`./schemas/*`, `./dates/*`) are expanded only where the
 * COMMITTED files make the public names finite: a single-star pattern is
 * listed file by file from `git ls-files` over its target directory (a
 * scratch file dropped beside the schemas never reaches a README, and a
 * checkout without git falls back to the directory listing), and stays a
 * pattern otherwise — a pattern with two stars, a directory that is
 * absent or holds no matching file. A pattern is never silently dropped.
 * `./package.json` is metadata, a stylesheet or CSS file is an asset, a
 * `.json` schema is a schema, and a `.js` target is JavaScript — with
 * `types` when the manifest points a declaration at it, through nested
 * conditions (`{ import: { types, default } }`) as well as flat ones.
 * Root string and condition-map shorthands are inventoried as `.`.
 */

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { expandExports } from '@jarenjs/emit/importmap';

/**
 * @typedef {Object} ExportEntry
 * @property {string} subpath - the import specifier (`@jarenjs/x`, `@jarenjs/x/y`)
 * @property {string} key - the manifest key (`.`, `./y`, `./schemas/*`)
 * @property {'javascript' | 'schema' | 'asset' | 'metadata' | 'pattern'} kind
 * @property {string | null} target - the default/import target, or null
 * @property {boolean} types - whether the manifest names a declaration for it
 * @property {boolean} expanded - whether this row came out of a wildcard
 */

/** The conditions the census resolves a runtime target under: every
 * runtime condition a manifest here may name. */
const CONDITIONS = ['default', 'import', 'node', 'browser', 'require'];

/**
 * Whether a declaration rides with the entry, at any depth of conditions.
 * @param {any} value
 * @returns {boolean}
 */
function hasTypes(value) {
  if (value === null || typeof value !== 'object') return false;
  if (typeof value.types === 'string') return true;
  return Object.values(value).some((nested) => hasTypes(nested));
}

/**
 * The kind of one concrete target.
 * @param {string} key @param {string | null} target
 * @returns {ExportEntry['kind']}
 */
function kindOf(key, target) {
  if (key === './package.json') return 'metadata';
  if (target === null) return 'asset';
  const dot = target.lastIndexOf('.');
  const ext = dot > target.lastIndexOf('/') ? target.slice(dot) : '';
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return 'javascript';
  if (ext === '.json' && /schema/i.test(target)) return 'schema';
  return 'asset';
}

/**
 * Every export of one manifest, wildcards expanded from the committed
 * files where the workspace directory is given. The resolution and the
 * expansion are `@jarenjs/emit/importmap`'s — the one implementation the
 * import map builder uses too — with this census's git-backed lister.
 * @param {any} pkg - the parsed `package.json`
 * @param {string | null} [dir] - the workspace directory, for expansion
 * @returns {ExportEntry[]}
 */
export function exportEntries(pkg, dir = null) {
  const specifier = (/** @type {string} */ key) => (key === '.' ? pkg.name : pkg.name + key.slice(1));
  const listFiles = dir === null ? undefined : (/** @type {string} */ folder) => committedFiles(join(dir, folder));
  return expandExports(pkg, { conditions: CONDITIONS, listFiles }).map((entry) => ({
    subpath: specifier(entry.key),
    key: entry.pattern,
    kind: entry.unexpanded ? 'pattern' : kindOf(entry.key, entry.target),
    target: entry.target,
    types: hasTypes(entry.value),
    expanded: entry.expanded,
  }));
}

/**
 * The file names of a directory as git knows them — tracked or staged,
 * never a scratch file — or the directory listing where git cannot
 * answer (a tarball, no git); null when the directory is absent. Names
 * only: a nested path is not a file of this directory.
 * @param {string} folder
 * @returns {string[] | null}
 */
function committedFiles(folder) {
  if (!existsSync(folder) || !statSync(folder).isDirectory()) return null;
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--', '.'],
      { cwd: folder, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\0').filter((name) => name !== '' && !name.includes('/'));
  }
  catch {
    return readdirSync(folder).filter((name) => !statSync(join(folder, name)).isDirectory());
  }
}

/**
 * The importable JavaScript subpaths of a package — no assets, no
 * metadata, no unexpanded pattern — what a consumer probe can
 * `import()`. Given the workspace directory, a JavaScript wildcard's
 * committed files are probed one by one.
 * @param {any} pkg
 * @param {string | null} [dir] - the workspace directory, for wildcard expansion
 * @returns {string[]}
 */
export function importSubpaths(pkg, dir = null) {
  return exportEntries(pkg, dir).filter((entry) => entry.kind === 'javascript').map((entry) => entry.subpath);
}
