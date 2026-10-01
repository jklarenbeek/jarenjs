//@ts-check
/**
 * @file `@jarenjs/emit/importmap` — serve the suite unbundled. A browser
 * that loads ES modules straight from a server needs an import map: every
 * package's `exports` resolved for the browser, every `*` subpath expanded
 * (an import map cannot express a suffix pattern), and every file those
 * entries reach listed so the server serves them. `buildImportMap` answers
 * all of it from an installed tree; `jaren-emit importmap` prints it.
 *
 * Three layers, the first two pure:
 *
 *  - `scanImports(source)` — the module specifiers a JavaScript source
 *    imports: `import … from`, `export … from`, `import 'x'` and
 *    `import('x')` with a literal. A char-code scan over
 *    `@jarenjs/core/scan`, so a specifier in a comment, a string or a
 *    template is never misread as an import.
 *  - `exportTarget` / `expandExports` — a manifest's `exports` for a set of
 *    conditions, single-star wildcards expanded through an injected file
 *    lister. The repository's export census (`scripts/lib/exports.js`)
 *    reads its manifests through these same two functions with a
 *    git-backed lister; this module lists the installed directory.
 *  - `buildImportMap(options)` — the installed tree under `root`, the
 *    packages' dependency closure resolved as Node resolves it, nested
 *    copies reported as `duplicates`.
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';

import {
  CC_BACKSLASH, CC_DOLLAR, CC_DQUOTE, CC_LF, CC_CR, CC_LBRACKET, CC_RBRACKET, CC_SLASH, CC_SQUOTE, CC_STAR,
  isDigitCode, isNameCharCode, isNameStartCode, isWhitespaceCode,
} from '@jarenjs/core/scan';

//#region scanImports

const CC_BACKTICK = 0x60;
const CC_LBRACE = 0x7B;
const CC_RBRACE = 0x7D;
const CC_DOT = 0x2E;

/** After these words a `/` opens a regular expression, not a division. */
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await', 'export', 'default']);

/**
 * One token of the scan: a word, a string (its decoded value), or a single
 * punctuation character. Comments, whitespace, regular expressions and
 * template text produce nothing.
 * @typedef {{ kind: 'word' | 'string' | 'punct', value: string }} Token
 */

/**
 * Decode the escapes a module specifier may carry in its quotes.
 * @param {string} raw
 * @returns {string}
 */
function decodeString(raw) {
  if (!raw.includes('\\')) return raw;
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r\n|[\s\S])/g, (_, escape) => {
    if (escape[0] === 'u') return String.fromCodePoint(parseInt(escape[1] === '{' ? escape.slice(2, -1) : escape.slice(1), 16));
    if (escape[0] === 'x') return String.fromCharCode(parseInt(escape.slice(1), 16));
    if (escape === '\n' || escape === '\r\n' || escape === '\r') return '';
    return ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' })[escape] ?? escape;
  });
}

/**
 * Tokenize a JavaScript source, skipping comments, regular expressions and
 * template text (a template's `${…}` substitutions are code and are
 * tokenized). A `/` is read as a regular expression where the token before
 * it cannot end an operand — the heuristic every hand-written JS scanner
 * uses; a division right after a block's closing `}` is the case it reads
 * wrong, and it never affects an import.
 * @param {string} source
 * @returns {Token[]}
 */
function tokenize(source) {
  /** @type {Token[]} */
  const tokens = [];
  const n = source.length;
  /** Open template substitutions: the brace depth each one returns at. @type {number[]} */
  const templates = [];
  let depth = 0;
  let i = 0;
  /** Whether a `/` here opens a regular expression. */
  const regexAllowed = () => {
    const last = tokens[tokens.length - 1];
    if (last === undefined) return true;
    if (last.kind === 'string') return false;
    if (last.kind === 'word') return REGEX_AFTER_WORD.has(last.value);
    return last.value !== ')' && last.value !== ']';
  };
  /** Skip template text from `i` (just past a backtick or a closing `}`):
   * stop past the closing backtick, or past a `${` (entering code). */
  const templateText = () => {
    while (i < n) {
      const c = source.charCodeAt(i);
      if (c === CC_BACKSLASH) { i += 2; continue; }
      if (c === CC_BACKTICK) { i++; return; }
      if (c === CC_DOLLAR && source.charCodeAt(i + 1) === CC_LBRACE) {
        i += 2;
        templates.push(depth);
        depth++;
        return;
      }
      i++;
    }
  };
  while (i < n) {
    const c = source.charCodeAt(i);
    if (isWhitespaceCode(c) || c === CC_LF || c === CC_CR) { i++; continue; }
    if (c === CC_SLASH) {
      const next = source.charCodeAt(i + 1);
      if (next === CC_SLASH) {
        while (i < n && source.charCodeAt(i) !== CC_LF) i++;
        continue;
      }
      if (next === CC_STAR) {
        const end = source.indexOf('*/', i + 2);
        i = end < 0 ? n : end + 2;
        continue;
      }
      if (regexAllowed()) {
        i++;
        let inClass = false;
        while (i < n) {
          const r = source.charCodeAt(i);
          if (r === CC_BACKSLASH) { i += 2; continue; }
          if (r === CC_LF) break;
          if (inClass) { if (r === CC_RBRACKET) inClass = false; }
          else if (r === CC_LBRACKET) inClass = true;
          else if (r === CC_SLASH) { i++; break; }
          i++;
        }
        while (i < n && isNameCharCode(source.charCodeAt(i))) i++;
        // a regular expression ends an operand, as a string does
        tokens.push({ kind: 'string', value: '' });
        continue;
      }
      tokens.push({ kind: 'punct', value: '/' });
      i++;
      continue;
    }
    if (c === CC_SQUOTE || c === CC_DQUOTE) {
      const start = ++i;
      while (i < n) {
        const s = source.charCodeAt(i);
        if (s === CC_BACKSLASH) { i += 2; continue; }
        if (s === c || s === CC_LF) break;
        i++;
      }
      tokens.push({ kind: 'string', value: decodeString(source.slice(start, i)) });
      i++;
      continue;
    }
    if (c === CC_BACKTICK) {
      // a template with no substitution is a literal, which `import()` may take
      const start = ++i;
      const before = templates.length;
      templateText();
      if (templates.length === before) tokens.push({ kind: 'string', value: decodeString(source.slice(start, i - 1)) });
      else tokens.push({ kind: 'punct', value: '`' });
      continue;
    }
    if (c === CC_LBRACE) { depth++; tokens.push({ kind: 'punct', value: '{' }); i++; continue; }
    if (c === CC_RBRACE) {
      depth--;
      i++;
      if (templates.length > 0 && templates[templates.length - 1] === depth) {
        templates.pop();
        templateText();
        tokens.push({ kind: 'string', value: '' });
        continue;
      }
      tokens.push({ kind: 'punct', value: '}' });
      continue;
    }
    if (isNameStartCode(c) || c === CC_DOLLAR) {
      const start = i;
      i++;
      while (i < n && (isNameCharCode(source.charCodeAt(i)) || source.charCodeAt(i) === CC_DOLLAR)) i++;
      tokens.push({ kind: 'word', value: source.slice(start, i) });
      continue;
    }
    if (isDigitCode(c)) {
      const start = i;
      while (i < n && (isNameCharCode(source.charCodeAt(i)) || source.charCodeAt(i) === CC_DOT)) i++;
      tokens.push({ kind: 'word', value: source.slice(start, i) });
      continue;
    }
    tokens.push({ kind: 'punct', value: source[i] });
    i++;
  }
  return tokens;
}

/**
 * The module specifiers a JavaScript source imports, in source order:
 * `import … from 'x'`, `import 'x'`, `export … from 'x'` (static), and
 * `import('x')` whose argument is a string or a template without
 * substitutions (dynamic). A computed `import(expr)` names no file and is
 * not reported. Nothing in a comment, a string or a template is read as
 * an import.
 * @param {string} source
 * @returns {Array<{ specifier: string, dynamic: boolean }>}
 * @example
 * scanImports("import { a } from './a.js'; // import 'b'\nconst c = import('./c.js');")
 * // [{ specifier: './a.js', dynamic: false }, { specifier: './c.js', dynamic: true }]
 */
export function scanImports(source) {
  const tokens = tokenize(source);
  /** @type {Array<{ specifier: string, dynamic: boolean }>} */
  const found = [];
  const is = (/** @type {Token | undefined} */ t, /** @type {string} */ kind, /** @type {string} */ value) =>
    t !== undefined && t.kind === kind && t.value === value;
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.kind !== 'word' || (t.value !== 'import' && t.value !== 'export') || is(tokens[k - 1], 'punct', '.')) continue;
    const next = tokens[k + 1];
    if (next === undefined) break;
    if (t.value === 'import') {
      if (next.kind === 'string') { found.push({ specifier: next.value, dynamic: false }); continue; }
      if (is(next, 'punct', '(')) {
        const arg = tokens[k + 2];
        if (arg !== undefined && arg.kind === 'string' && (is(tokens[k + 3], 'punct', ')') || is(tokens[k + 3], 'punct', ','))) {
          found.push({ specifier: arg.value, dynamic: true });
        }
        continue;
      }
      if (is(next, 'punct', '.')) continue; // import.meta
      // import x / { … } / * as ns … from 'x': the clause holds no string
      for (let j = k + 1; j < tokens.length; j++) {
        if (tokens[j].kind !== 'string') continue;
        if (is(tokens[j - 1], 'word', 'from')) found.push({ specifier: tokens[j].value, dynamic: false });
        break;
      }
      continue;
    }
    // export * from 'x', export * as ns from 'x', export { … } from 'x'
    let j = k + 1;
    if (is(next, 'punct', '*')) {
      j = k + 2;
      if (is(tokens[j], 'word', 'as')) j += 2;
    }
    else if (is(next, 'punct', '{')) {
      while (j < tokens.length && !is(tokens[j], 'punct', '}')) j++;
      j++;
    }
    else continue;
    if (is(tokens[j], 'word', 'from') && tokens[j + 1]?.kind === 'string') {
      found.push({ specifier: /** @type {Token} */ (tokens[j + 1]).value, dynamic: false });
    }
  }
  return found;
}

//#endregion

//#region exportTarget / expandExports

/**
 * The target one `exports` value resolves to for a set of conditions, or
 * null: a string as it is; an array, its first entry that resolves; a
 * condition object, its first key — in the manifest's own order, as Node
 * and the bundlers read it — that is one of `conditions` and resolves.
 * @param {any} value
 * @param {readonly string[]} conditions
 * @returns {string | null}
 */
export function exportTarget(value, conditions) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const target = exportTarget(entry, conditions);
      if (target !== null) return target;
    }
    return null;
  }
  if (value === null || typeof value !== 'object') return null;
  for (const key of Object.keys(value)) {
    if (!conditions.includes(key)) continue;
    const target = exportTarget(value[key], conditions);
    if (target !== null) return target;
  }
  return null;
}

/**
 * One export of a manifest: a key and its target, or a wildcard that
 * stayed a pattern.
 * @typedef {Object} ExportedPath
 * @property {string} key - the manifest key, concrete after expansion (`./schemas/a.json`)
 * @property {string} pattern - the key as the manifest writes it (`./schemas/*`)
 * @property {string | null} target - the resolved target, concrete after expansion
 * @property {boolean} expanded - whether the row came out of a wildcard
 * @property {boolean} unexpanded - a wildcard the lister could not make finite
 * @property {any} value - the manifest's value for the pattern
 */

/**
 * Every export of a manifest for a set of conditions. A wildcard with one
 * `*` in its key and its target is expanded file by file: `listFiles`
 * answers the file names in the target's folder (a path relative to the
 * package root, `./schemas`), or null when there is none. Anything else —
 * two stars, no folder, no matching file, or a folder outside the
 * package — stays the pattern it is, marked `unexpanded`; nothing is
 * dropped. A manifest without `exports` exports `main` (or
 * `./src/index.js`) as `.`, and a string or a root condition map is
 * shorthand for `.`.
 * @param {any} manifest - the parsed `package.json`
 * @param {{ conditions: readonly string[], listFiles?: (folder: string) => string[] | null }} options
 * @returns {ExportedPath[]}
 */
export function expandExports(manifest, options) {
  const { conditions, listFiles } = options;
  const declared = manifest.exports ?? { '.': manifest.main ?? './src/index.js' };
  const keys = typeof declared === 'object' && declared !== null ? Object.keys(declared) : [];
  const exports = typeof declared === 'string' || Array.isArray(declared)
    || (keys.length > 0 && !keys.some((key) => key.startsWith('.')))
    ? { '.': declared } : declared;
  /** @type {ExportedPath[]} */
  const out = [];
  for (const key of Object.keys(exports)) {
    const value = exports[key];
    const target = exportTarget(value, conditions);
    if (!key.includes('*')) {
      out.push({ key, pattern: key, target, expanded: false, unexpanded: false, value });
      continue;
    }
    const stems = target !== null && key.split('*').length === 2 && target.split('*').length === 2
      && listFiles !== undefined ? wildcardStems(target, listFiles) : null;
    if (stems === null || stems.length === 0) {
      out.push({ key, pattern: key, target, expanded: false, unexpanded: true, value });
      continue;
    }
    for (const stem of stems) {
      out.push({ key: key.replace('*', stem), pattern: key, target: /** @type {string} */ (target).replace('*', stem),
        expanded: true, unexpanded: false, value });
    }
  }
  return out;
}

/**
 * The stems `./folder/prefix*suffix` matches among the files `listFiles`
 * names, sorted; null when the folder is absent or lies outside the
 * package.
 * @param {string} target
 * @param {(folder: string) => string[] | null} listFiles
 * @returns {string[] | null}
 */
function wildcardStems(target, listFiles) {
  const star = target.indexOf('*');
  const before = target.slice(0, star);
  const after = target.slice(star + 1);
  if (after.includes('/')) return null;
  const folder = posix.dirname(before + 'x');
  const normalized = posix.normalize(folder);
  if (normalized === '..' || normalized.startsWith('../') || posix.isAbsolute(normalized)) return null;
  const names = listFiles(folder);
  if (names === null) return null;
  const prefix = posix.basename(before + 'x').slice(0, -1);
  const stems = [];
  for (const name of names) {
    if (name.includes('/') || !name.startsWith(prefix) || !name.endsWith(after)) continue;
    const stem = name.slice(prefix.length, name.length - after.length);
    if (stem.length > 0) stems.push(stem);
  }
  return stems.sort();
}

//#endregion

//#region buildImportMap

/** The conditions a browser resolves `exports` under. */
const BROWSER_CONDITIONS = Object.freeze(['browser', 'import', 'default']);

/** The options `buildImportMap` reads. */
const OPTIONS = Object.freeze(['packages', 'root', 'prefix', 'conditions']);

/** The JavaScript files a scan follows. */
const RE_SCRIPT = /\.(?:m?js)$/;

/**
 * @typedef {Object} ImportMapResult
 * @property {Record<string, string>} imports - specifier → URL, keys sorted:
 *   the `imports` member of an import map
 * @property {string[]} files - every URL a server must serve, sorted: each
 *   export's target and every file reachable from one through relative
 *   static and literal dynamic imports
 * @property {Array<{ name: string, paths: string[] }>} duplicates - a
 *   package installed at more than one place in the closure; the map uses
 *   the copy nearest the root
 * @property {Array<{ specifier: string, from: string }>} unresolved - a
 *   bare specifier a served file imports that the map does not resolve, a
 *   relative import that leaves its package or names no file, or a
 *   wildcard export the installed files could not make finite
 */

/**
 * Build the import map, and the file list, that serve `packages` and their
 * dependency closure unbundled from an installed tree.
 *
 * Each package is found as Node finds it — `node_modules/<name>` beside
 * the dependent, then in each parent directory up to `root` — starting
 * from `root` for the packages named. Its `exports` resolve under
 * `conditions`, single-star wildcards expand from the installed directory,
 * and every export becomes `imports[specifier] = prefix + name + '/' +
 * path`. A package installed more than once is reported in `duplicates`.
 * Node built-ins (`node:fs`, `fs`) are left to the platform.
 *
 * Two calls over the same tree answer the same bytes: keys and lists are
 * sorted.
 * @param {{ packages: readonly string[], root?: string, prefix?: string, conditions?: readonly string[] }} options
 *   `packages` are package names; a bare name is a suite package (`app` is
 *   `@jarenjs/app`). `root` holds `node_modules` (default: the current
 *   directory). `prefix` is the URL every file is served under and ends
 *   with `/` (default `/node_modules/`). `conditions` default to
 *   `browser`, `import`, `default`.
 * @returns {ImportMapResult}
 * @throws {TypeError} an option it does not take, or one that is malformed; a
 *   named package that is not installed
 * @example
 * const { imports, files, duplicates } = buildImportMap({ packages: ['app', 'view'], prefix: '/vendor/' });
 * // imports['@jarenjs/app'] === '/vendor/@jarenjs/app/src/index.js'
 */
export function buildImportMap(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('buildImportMap: options are { packages, root?, prefix?, conditions? }');
  }
  for (const key of Object.keys(options)) {
    if (!OPTIONS.includes(key)) throw new TypeError(`buildImportMap: does not take '${key}' — it takes ${OPTIONS.join(', ')}`);
  }
  const { packages, root = '.', prefix = '/node_modules/', conditions = BROWSER_CONDITIONS } = options;
  if (!Array.isArray(packages) || packages.length === 0 || packages.some((name) => typeof name !== 'string' || name === '')) {
    throw new TypeError('buildImportMap: packages is a non-empty list of package names');
  }
  if (typeof root !== 'string') throw new TypeError('buildImportMap: root is a directory path');
  if (typeof prefix !== 'string' || !prefix.endsWith('/')) throw new TypeError('buildImportMap: prefix is a URL path ending in /');
  if (!Array.isArray(conditions) || conditions.some((condition) => typeof condition !== 'string')) {
    throw new TypeError('buildImportMap: conditions is a list of condition names');
  }
  // the real directory: every path below is compared with real paths (a
  // linked temp directory, a workspace link) and reported relative to it
  const resolved = resolve(root);
  const top = existsSync(resolved) ? realpathSync(resolved) : resolved;
  /** name → its install directory (the one the map serves) @type {Map<string, string>} */
  const chosen = new Map();
  /** name → every install directory met, by real path @type {Map<string, Set<string>>} */
  const met = new Map();
  /** @type {Array<{ name: string, dir: string }>} */
  const queue = [];
  const visit = (/** @type {string} */ name, /** @type {string} */ from, /** @type {boolean} */ named) => {
    const dir = locate(name, from, top);
    if (dir === null) {
      if (named) throw new TypeError(`buildImportMap: '${name}' is not installed under ${top}`);
      return;
    }
    const real = realpathSync(dir);
    let paths = met.get(name);
    if (paths === undefined) met.set(name, paths = new Set());
    if (paths.has(real)) return;
    paths.add(real);
    // the copy nearest the root serves; a nested one is a duplicate
    const current = chosen.get(name);
    if (current === undefined || dir.length < current.length) chosen.set(name, dir);
    queue.push({ name, dir });
  };
  for (const given of packages) visit(given.includes('/') || given.startsWith('@') ? given : `@jarenjs/${given}`, top, true);
  /** name → its parsed manifest, for the chosen copies @type {Map<string, any>} */
  const manifests = new Map();
  while (queue.length > 0) {
    const { name, dir } = /** @type {{ name: string, dir: string }} */ (queue.shift());
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    for (const dep of Object.keys(manifest.dependencies ?? {})) visit(dep, dir, false);
    if (chosen.get(name) === dir) manifests.set(name, manifest);
  }
  const names = [...manifests.keys()].sort();
  // the map: every package's exports, before any file is followed, so a
  // bare import is checked against the whole closure
  /** @type {Record<string, string>} */
  const imports = {};
  /** @type {Array<{ specifier: string, from: string }>} */
  const unresolved = [];
  /** @type {Array<{ name: string, file: string }>} */
  const entryFiles = [];
  for (const name of names) {
    const dir = /** @type {string} */ (chosen.get(name));
    const entries = expandExports(manifests.get(name), { conditions, listFiles: (folder) => listDirectory(join(dir, folder)) });
    for (const entry of entries) {
      const specifier = entry.key === '.' ? name : name + entry.key.slice(1);
      if (entry.unexpanded) { unresolved.push({ specifier, from: `${name}/package.json` }); continue; }
      if (entry.target === null) continue;
      const file = posix.normalize(entry.target);
      imports[specifier] = prefix + name + '/' + file;
      entryFiles.push({ name, file });
    }
  }
  // the files: each export's target and what it reaches
  const files = new Set();
  for (const { name, file } of entryFiles) {
    followFiles(name, /** @type {string} */ (chosen.get(name)), file, prefix, files, unresolved, (bare, from) => {
      if (!resolvesBare(bare, imports)) unresolved.push({ specifier: bare, from });
    });
  }
  /** @type {Array<{ name: string, paths: string[] }>} */
  const duplicates = [];
  for (const [name, paths] of met) {
    if (paths.size > 1) duplicates.push({ name, paths: [...paths].map((path) => relative(top, path).split(sep).join('/')).sort() });
  }
  duplicates.sort((a, b) => compare(a.name, b.name));
  const seen = new Set();
  const open = unresolved.filter((entry) => {
    const id = `${entry.specifier}\u0000${entry.from}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  }).sort((a, b) => compare(a.specifier, b.specifier) || compare(a.from, b.from));
  return {
    imports: Object.fromEntries(Object.keys(imports).sort(compare).map((key) => [key, imports[key]])),
    files: [...files].sort(compare),
    duplicates,
    unresolved: open,
  };
}

/** Code-unit order, the same on every host. @param {string} a @param {string} b */
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Where `name` is installed as seen from `from`: `node_modules/<name>`
 * there, then in each parent up to `top`.
 * @param {string} name @param {string} from @param {string} top
 * @returns {string | null}
 */
function locate(name, from, top) {
  let dir = from;
  for (;;) {
    const candidate = join(dir, 'node_modules', ...name.split('/'));
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dir === top || dirname(dir) === dir || !(dir + sep).startsWith(top + sep)) return null;
    dir = dirname(dir);
  }
}

/** The file names in a directory, or null. @param {string} folder @returns {string[] | null} */
function listDirectory(folder) {
  if (!existsSync(folder) || !statSync(folder).isDirectory()) return null;
  return readdirSync(folder).filter((name) => statSync(join(folder, name)).isFile());
}

/**
 * Whether a bare specifier resolves: a Node built-in is the platform's,
 * anything else needs its own entry in the map.
 * @param {string} specifier
 * @param {Record<string, string>} imports
 */
function resolvesBare(specifier, imports) {
  if (specifier.startsWith('node:') || builtinModules.includes(specifier.split('/')[0])) return true;
  return Object.hasOwn(imports, specifier);
}

/**
 * Add `file` (package-relative) and every file it reaches through relative
 * imports to `files`; report what leaves the package or names nothing, and
 * hand each bare specifier to `bare`.
 * @param {string} name @param {string} dir @param {string} file @param {string} prefix
 * @param {Set<string>} files
 * @param {Array<{ specifier: string, from: string }>} unresolved
 * @param {(specifier: string, from: string) => void} bare
 */
function followFiles(name, dir, file, prefix, files, unresolved, bare) {
  const pending = [file];
  while (pending.length > 0) {
    const current = /** @type {string} */ (pending.pop());
    const url = prefix + name + '/' + current;
    if (files.has(url)) continue;
    const path = join(dir, ...current.split('/'));
    if (!existsSync(path) || !statSync(path).isFile()) {
      unresolved.push({ specifier: `./${current}`, from: `${name}/package.json` });
      continue;
    }
    files.add(url);
    if (!RE_SCRIPT.test(current)) continue;
    for (const { specifier } of scanImports(readFileSync(path, 'utf8'))) {
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        const next = posix.normalize(posix.join(posix.dirname(current), specifier));
        if (next === '..' || next.startsWith('../')) unresolved.push({ specifier, from: `${name}/${current}` });
        else pending.push(next);
      }
      else bare(specifier, `${name}/${current}`);
    }
  }
}

//#endregion
