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
import { join, dirname, basename, extname, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * @typedef {Object} ExportEntry
 * @property {string} subpath - the import specifier (`@jarenjs/x`, `@jarenjs/x/y`)
 * @property {string} key - the manifest key (`.`, `./y`, `./schemas/*`)
 * @property {'javascript' | 'schema' | 'asset' | 'metadata' | 'pattern'} kind
 * @property {string | null} target - the default/import target, or null
 * @property {boolean} types - whether the manifest names a declaration for it
 * @property {boolean} expanded - whether this row came out of a wildcard
 */

/** The condition names a runtime target hides behind, in preference order. */
const CONDITIONS = ['default', 'import', 'node', 'browser', 'require'];

/**
 * The default (runtime) target of one export entry, or null: a string,
 * or the first condition — recursively, so `{ import: { default } }`
 * resolves like `{ default }`.
 * @param {any} value
 * @returns {string | null}
 */
function targetOf(value) {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object') return null;
  for (const condition of CONDITIONS) {
    if (!(condition in value)) continue;
    const target = targetOf(value[condition]);
    if (target !== null) return target;
  }
  return null;
}

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
  const ext = extname(target);
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return 'javascript';
  if (ext === '.json' && /schema/i.test(target)) return 'schema';
  return 'asset';
}

/**
 * Every export of one manifest, wildcards expanded from the committed
 * files where the workspace directory is given.
 * @param {any} pkg - the parsed `package.json`
 * @param {string | null} [dir] - the workspace directory, for expansion
 * @returns {ExportEntry[]}
 */
export function exportEntries(pkg, dir = null) {
  const declared = pkg.exports ?? { '.': pkg.main ?? './src/index.js' };
  const keys = Object.keys(declared);
  // A string or a root condition map is shorthand for the root export;
  // its characters/condition names are not public subpath keys.
  const exports = typeof declared === 'string'
    || (!Array.isArray(declared) && keys.length > 0 && !keys.some((key) => key.startsWith('.')))
    ? { '.': declared } : declared;
  /** @type {ExportEntry[]} */
  const entries = [];
  const specifier = (/** @type {string} */ key) => (key === '.' ? pkg.name : pkg.name + key.slice(1));
  for (const key of Object.keys(exports)) {
    const value = exports[key];
    const target = targetOf(value);
    const types = hasTypes(value);
    if (!key.includes('*')) {
      entries.push({ subpath: specifier(key), key, kind: kindOf(key, target), target, types, expanded: false });
      continue;
    }
    // a wildcard: finite when ONE star names committed files beside the
    // manifest; anything else stays the pattern it is
    const single = key.split('*').length === 2 && target !== null && target.split('*').length === 2;
    const files = dir === null || !single ? null : wildcardFiles(dir, /** @type {string} */ (target));
    if (files === null || files.length === 0) {
      entries.push({ subpath: specifier(key), key, kind: 'pattern', target, types, expanded: false });
      continue;
    }
    for (const stem of files) {
      const concreteKey = key.replace('*', stem);
      const concreteTarget = target.replace('*', stem);
      entries.push({ subpath: specifier(concreteKey), key, kind: kindOf(concreteKey, concreteTarget),
        target: concreteTarget, types, expanded: true });
    }
  }
  return entries;
}

/**
 * The file names of a directory as git knows them — tracked or staged,
 * never a scratch file — or the directory listing where git cannot
 * answer (a tarball, no git). Names only: a nested path is not a file of
 * this directory.
 * @param {string} folder
 * @returns {string[]}
 */
function committedNames(folder) {
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
 * The stems a `dir/prefix*suffix` pattern matches among the committed
 * files of the workspace, sorted — or null when the directory is absent.
 * @param {string} dir @param {string} pattern
 * @returns {string[] | null}
 */
function wildcardFiles(dir, pattern) {
  const star = pattern.indexOf('*');
  const before = pattern.slice(0, star);
  const after = pattern.slice(star + 1);
  const folder = join(dir, dirname(before + 'x'));
  if (!existsSync(folder) || !statSync(folder).isDirectory()) return null;
  // the folder must lie inside the workspace: a pattern cannot list a stranger's files
  const inside = relative(dir, folder);
  if (inside.startsWith('..') || inside.split(sep).includes('..')) return null;
  const prefix = basename(before + 'x').slice(0, -1);
  const stems = [];
  for (const name of committedNames(folder)) {
    if (!name.startsWith(prefix) || !name.endsWith(after)) continue;
    const stem = name.slice(prefix.length, name.length - after.length);
    if (stem.length > 0) stems.push(stem);
  }
  return stems.sort();
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
