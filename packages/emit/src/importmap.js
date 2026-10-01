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
 *    template is never misread as an import, and every ECMAScript space
 *    and line end — a byte order mark included — separates tokens.
 *  - `exportTarget` / `expandExports` — a manifest's `exports` for a set of
 *    conditions, single-star wildcards expanded through an injected file
 *    lister. The repository's export census (`scripts/lib/exports.js`)
 *    reads its manifests through these same two functions with a
 *    git-backed lister; this module lists the installed directory.
 *  - `buildImportMap(options)` — the installed tree under `root`, the
 *    packages' dependency closure (peer and optional dependencies
 *    included) resolved as Node resolves it, nested copies reported as
 *    `duplicates`.
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';

import {
  CC_BACKSLASH, CC_DOLLAR, CC_DQUOTE, CC_LF, CC_CR, CC_LBRACKET, CC_RBRACKET, CC_SLASH, CC_SQUOTE, CC_STAR,
  isDigitCode, isNameCharCode, isNameStartCode,
} from '@jarenjs/core/scan';

//#region scanImports

const CC_BACKTICK = 0x60;
const CC_LBRACE = 0x7B;
const CC_RBRACE = 0x7D;
const CC_DOT = 0x2E;
const CC_LPAREN = 0x28;
const CC_RPAREN = 0x29;

/** Whether a code unit ends a line: LF, CR, and U+2028/U+2029 (ECMAScript
 * LineTerminator). @param {number} c */
const isLineEndCode = (c) => c === CC_LF || c === CC_CR || c === 0x2028 || c === 0x2029;

/** Whether a code unit is ECMAScript WhiteSpace or a LineTerminator: tab,
 * vertical tab, form feed, space, the byte order mark, every Unicode space
 * separator (U+00A0, U+1680, U+2000–U+200A, U+202F, U+205F, U+3000) and the
 * four line ends. @param {number} c */
const isSpaceCode = (c) => (c >= 0x09 && c <= 0x0D) || c === 0x20
  || (c >= 0xA0 && (c === 0xA0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200A) || c === 0x2028 || c === 0x2029
    || c === 0x202F || c === 0x205F || c === 0x3000 || c === 0xFEFF));

/** Whether a code unit continues a name, a number or a regular expression's
 * flags: `isNameCharCode` admits every code unit above ASCII, the Unicode
 * spaces included, so they are taken out here. @param {number} c */
const isNamePartCode = (c) => isNameCharCode(c) && !isSpaceCode(c);

/** After these words a `/` opens a regular expression, not a division. */
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await', 'export', 'default']);

/**
 * One token of the scan: a word, a string (its decoded value), or a single
 * punctuation character. Comments, white space (a byte order mark and every
 * Unicode space and line end included), regular expressions and template
 * text produce nothing.
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

/** The statement heads whose parenthesized condition a regular expression
 * may follow: `if (x) /re/.test(y)`. */
const PAREN_HEADS = new Set(['if', 'while', 'for', 'with']);

/**
 * Tokenize a JavaScript source, skipping comments, regular expressions and
 * template text (a template's `${…}` substitutions are code and are
 * tokenized). A `/` is read as a regular expression where the token before
 * it cannot end an operand: not after a name or a number (a keyword such as
 * `return` excepted, unless it is a property after `.`), a string, a `]`,
 * a postfix `++`/`--`, or a `)` — except the `)` that closes an `if`,
 * `while`, `for` or `with` head. A division right after a block's closing
 * `}` is the case this reads wrong; it is a statement nobody writes.
 * @param {string} source
 * @returns {Token[]}
 */
function tokenize(source) {
  /** @type {Token[]} */
  const tokens = [];
  const n = source.length;
  /** Open template substitutions: the brace depth each one returns at. @type {number[]} */
  const templates = [];
  /** Open parentheses: whether each one is a statement head's (`if (`). @type {boolean[]} */
  const parens = [];
  /** The `)` tokens that closed a statement head. @type {WeakSet<Token>} */
  const headEnds = new WeakSet();
  let depth = 0;
  let i = 0;
  /** Whether the token at `k` is a word read as a property, after a `.`. @param {number} k */
  const property = (k) => k > 0 && tokens[k - 1].kind === 'punct' && tokens[k - 1].value === '.';
  /** Whether a `/` here opens a regular expression. */
  const regexAllowed = () => {
    const k = tokens.length - 1;
    const last = tokens[k];
    if (last === undefined) return true;
    if (last.kind === 'string') return false;
    if (last.kind === 'word') return REGEX_AFTER_WORD.has(last.value) && !property(k);
    if (last.value === ')') return headEnds.has(last);
    if (last.value === ']') return false;
    // `a++ / 2`: a postfix increment or decrement ends an operand
    if ((last.value === '+' || last.value === '-') && tokens[k - 1]?.value === last.value
      && tokens[k - 1].kind === 'punct' && endsOperand(k - 2)) return false;
    return true;
  };
  /** Whether the token at `k` ends an operand. @param {number} k */
  const endsOperand = (k) => {
    const t = tokens[k];
    if (t === undefined) return false;
    if (t.kind === 'string') return true;
    if (t.kind === 'word') return !REGEX_AFTER_WORD.has(t.value) || property(k);
    return t.value === ')' || t.value === ']';
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
    if (isSpaceCode(c)) { i++; continue; }
    if (c === CC_SLASH) {
      const next = source.charCodeAt(i + 1);
      if (next === CC_SLASH) {
        while (i < n && !isLineEndCode(source.charCodeAt(i))) i++;
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
        while (i < n && isNamePartCode(source.charCodeAt(i))) i++;
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
    if (c === CC_LPAREN) {
      const before = tokens[tokens.length - 1];
      parens.push(before !== undefined && before.kind === 'word' && PAREN_HEADS.has(before.value) && !property(tokens.length - 1));
      tokens.push({ kind: 'punct', value: '(' });
      i++;
      continue;
    }
    if (c === CC_RPAREN) {
      /** @type {Token} */
      const close = { kind: 'punct', value: ')' };
      if (parens.pop() === true) headEnds.add(close);
      tokens.push(close);
      i++;
      continue;
    }
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
      while (i < n && (isNamePartCode(source.charCodeAt(i)) || source.charCodeAt(i) === CC_DOLLAR)) i++;
      tokens.push({ kind: 'word', value: source.slice(start, i) });
      continue;
    }
    if (isDigitCode(c)) {
      const start = i;
      while (i < n && (isNamePartCode(source.charCodeAt(i)) || source.charCodeAt(i) === CC_DOT)) i++;
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
  /** The specifier of the clause that opens at `j` — `x`, `{ … }`, `* as ns`,
   * a default and a brace list — or null when the tokens there are no
   * import or export clause (an object key named `import`, say). A binding
   * may be named by a string (`{ "a-b" as ab }`, `* as "e f"`). @param {number} j */
  const clause = (j) => {
    let braces = false;
    for (; j < tokens.length; j++) {
      const t = tokens[j];
      if (t.kind === 'word') {
        if (t.value === 'from' && !braces && tokens[j + 1]?.kind === 'string') return /** @type {Token} */ (tokens[j + 1]).value;
        continue;
      }
      if (t.kind === 'string') {
        // a string is a binding's name: inside the braces, or `* as "name"`
        if (!braces && !is(tokens[j - 1], 'word', 'as')) return null;
        continue;
      }
      if (t.value === '{' && !braces) braces = true;
      else if (t.value === '}' && braces) braces = false;
      else if (t.value !== ',' && t.value !== '*') return null;
    }
    return null;
  };
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
      // import.meta, and an object key or a method named import
      if (next.kind !== 'word' && !is(next, 'punct', '{') && !is(next, 'punct', '*')) continue;
    }
    // export * from 'x', export * as ns from 'x', export { … } from 'x';
    // a declaration (`export const`, `export function`) has no clause
    else if (!is(next, 'punct', '*') && !is(next, 'punct', '{')) continue;
    const specifier = clause(k + 1);
    if (specifier !== null) found.push({ specifier, dynamic: false });
  }
  return found;
}

//#endregion

//#region exportTarget / expandExports

/**
 * The target one `exports` value resolves to for a set of conditions, or
 * null when it exports nothing: a string as it is; a condition object, its
 * first key — in the manifest's own order, as Node and the bundlers read
 * it — that is `default` or one of `conditions` and answers, a `null`
 * included, so a `null` under a matched condition withholds the subpath
 * (`default` matches whatever the conditions are, as it does in Node); an
 * array, its first entry that resolves to a target Node takes, past a
 * `null`, an unmatched entry and a target Node refuses — and, when none
 * does, its last refusal or `null`.
 * @param {any} value
 * @param {readonly string[]} conditions
 * @returns {string | null}
 */
export function exportTarget(value, conditions) {
  return resolveTarget(value, conditions) ?? null;
}

/**
 * One `exports` value as Node's PACKAGE_TARGET_RESOLVE reads it, keeping
 * apart what `exportTarget` folds into null: a string target, `null` when
 * the value withholds the subpath, `undefined` when no condition matches
 * (the enclosing object then reads its next key). A target that is no
 * string, array, object or null is passed over like an unmatched one.
 * @param {any} value
 * @param {readonly string[]} conditions
 * @returns {string | null | undefined}
 */
function resolveTarget(value, conditions) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    /** @type {string | null | undefined} */
    let last = value.length === 0 ? null : undefined;
    for (const entry of value) {
      const target = resolveTarget(entry, conditions);
      if (target === undefined) continue;
      if (target !== null && validTarget(target, null)) return target;
      last = target;
    }
    return last;
  }
  if (value === null) return null;
  if (typeof value !== 'object') return undefined;
  for (const key of Object.keys(value)) {
    if (key !== 'default' && !conditions.includes(key)) continue;
    const target = resolveTarget(value[key], conditions);
    if (target !== undefined) return target;
  }
  return undefined;
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
 * @property {boolean} invalid - a target Node refuses (`ERR_INVALID_PACKAGE_TARGET`):
 *   one that does not start with `./`, or holds a `.`, `..`, `node_modules` or
 *   empty segment. What a `*` matched through such a segment (a nested
 *   `node_modules`) is no export at all — Node refuses the specifier — and
 *   makes no row
 * @property {any} value - the manifest's value for the pattern
 */

/** Whether a path segment is one Node refuses in a target: empty, `.`,
 * `..` or `node_modules`, case-insensitive and percent-decoded.
 * @param {string} segment */
function refusedSegment(segment) {
  let text = segment;
  try { text = decodeURIComponent(segment); }
  catch { /* a malformed escape stays as written */ }
  text = text.toLowerCase();
  return text === '' || text === '.' || text === '..' || text === 'node_modules';
}

/**
 * Whether Node takes `target` as an `exports` target, with `match` — what a
 * `*` matched, or null — substituted (PACKAGE_TARGET_RESOLVE).
 * @param {string} target
 * @param {string | null} match
 * @returns {boolean}
 */
function validTarget(target, match) {
  if (!target.startsWith('./') || target.slice(2).split(/[/\\]/).some(refusedSegment)) return false;
  return match === null || !match.split(/[/\\]/).some(refusedSegment);
}

/**
 * The key a subpath resolves through, as Node resolves it: the subpath
 * itself when it is a key without a `*`; else the pattern with the longest
 * part before its `*`, then the longest key (PATTERN_KEY_COMPARE),
 * whatever order the manifest writes them in; null when none matches.
 * @param {readonly string[]} keys
 * @param {string} subpath
 * @returns {string | null}
 */
function governingKey(keys, subpath) {
  if (keys.includes(subpath) && !subpath.includes('*')) return subpath;
  let best = null;
  for (const key of keys) {
    const star = key.indexOf('*');
    if (star < 0 || star !== key.lastIndexOf('*')) continue;
    const base = key.slice(0, star);
    const trailer = key.slice(star + 1);
    if (!subpath.startsWith(base) || subpath === base) continue;
    if (trailer.length > 0 && (!subpath.endsWith(trailer) || subpath.length < key.length)) continue;
    if (best === null || star > best.indexOf('*') || (star === best.indexOf('*') && key.length > best.length)) best = key;
  }
  return best;
}

/**
 * Every export of a manifest for a set of conditions, in the manifest's
 * order. A wildcard with one `*` in its key and its target is expanded file
 * by file: `listFiles` answers every file below the target's folder (a path
 * relative to the package root, `./schemas`) as a path relative to that
 * folder, nested ones included (`a.json`, `deep/b.json` — a `*` matches
 * across `/`), or null when there is none. Each subpath is then resolved
 * as Node resolves it, so a wildcard row appears only where its pattern is
 * the one that governs the subpath: an exact key wins over every pattern,
 * and a longer pattern over a shorter one, whatever the manifest's order.
 * A `null` target — Node's way to withhold a subpath — exports nothing and
 * asks for nothing. Anything else — two stars, no folder, no matching file,
 * or a folder outside the package — stays the pattern it is, marked
 * `unexpanded`; nothing is dropped. A target Node refuses is marked
 * `invalid`; a file a `*` reaches through a `node_modules`, `.` or `..`
 * folder is no subpath Node exports, and makes no row. A manifest without
 * `exports` exports its `main` as `.` — read
 * from the package root, with or without a leading `./` — or `./index.js`
 * when it names none, as Node reads it; a string or a root condition map is
 * shorthand for `.`.
 * @param {any} manifest - the parsed `package.json`
 * @param {{ conditions: readonly string[], listFiles?: (folder: string) => string[] | null }} options
 * @returns {ExportedPath[]}
 */
export function expandExports(manifest, options) {
  const { conditions, listFiles } = options;
  const declared = manifest.exports ?? { '.': legacyMain(manifest.main) };
  const keys = typeof declared === 'object' && declared !== null ? Object.keys(declared) : [];
  const exports = typeof declared === 'string' || Array.isArray(declared)
    || (keys.length > 0 && !keys.some((key) => key.startsWith('.')))
    ? { '.': declared } : declared;
  const exportKeys = Object.keys(exports);
  /** @type {ExportedPath[]} */
  const out = [];
  for (const key of exportKeys) {
    const value = exports[key];
    const target = exportTarget(value, conditions);
    if (!key.includes('*')) {
      out.push({ key, pattern: key, target, expanded: false, unexpanded: false,
        invalid: target !== null && !validTarget(target, null), value });
      continue;
    }
    // withheld: Node answers ERR_PACKAGE_PATH_NOT_EXPORTED, and no file is asked for
    if (target === null) continue;
    const stems = key.split('*').length === 2 && target.split('*').length === 2
      && listFiles !== undefined ? wildcardStems(target, listFiles) : null;
    if (stems === null || stems.length === 0) {
      out.push({ key, pattern: key, target, expanded: false, unexpanded: true, invalid: false, value });
      continue;
    }
    for (const stem of stems) {
      // a file reached through a node_modules, . or .. folder names no subpath:
      // Node refuses such a specifier (ERR_INVALID_MODULE_SPECIFIER), so it is
      // skipped as a withheld one is
      if (stem.split(/[/\\]/).some(refusedSegment)) continue;
      const subpath = key.replace('*', stem);
      if (governingKey(exportKeys, subpath) !== key) continue;
      out.push({ key: subpath, pattern: key, target: target.replace('*', stem), expanded: true, unexpanded: false,
        invalid: !validTarget(target, stem), value });
    }
  }
  return out;
}

/**
 * The `.` target of a manifest without `exports`: its `main`, which Node
 * reads from the package root whether or not it starts with `./`, or
 * `./index.js` when there is none.
 * @param {unknown} main
 * @returns {string}
 */
function legacyMain(main) {
  if (typeof main !== 'string' || main === '') return './index.js';
  return main.startsWith('./') ? main : `./${main}`;
}

/**
 * The stems `./folder/prefix*suffix` matches among the files `listFiles`
 * names below the folder — a stem may hold a `/`, as Node's `*` does —
 * sorted; null when the folder is absent or lies outside the package.
 * @param {string} target
 * @param {(folder: string) => string[] | null} listFiles
 * @returns {string[] | null}
 */
function wildcardStems(target, listFiles) {
  const star = target.indexOf('*');
  const before = target.slice(0, star);
  const after = target.slice(star + 1);
  const folder = posix.dirname(before + 'x');
  const normalized = posix.normalize(folder);
  if (normalized === '..' || normalized.startsWith('../') || posix.isAbsolute(normalized)) return null;
  const names = listFiles(folder);
  if (names === null) return null;
  const prefix = posix.basename(before + 'x').slice(0, -1);
  const stems = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(after) || name.length < prefix.length + after.length) continue;
    const stem = name.slice(prefix.length, name.length - after.length);
    if (stem.length > 0) stems.push(stem);
  }
  return stems.sort(compare);
}

//#endregion

//#region buildImportMap

/** The conditions a browser resolves `exports` under. */
const BROWSER_CONDITIONS = Object.freeze(['browser', 'import', 'default']);

/** The options `buildImportMap` reads. */
const OPTIONS = Object.freeze(['packages', 'root', 'prefix', 'conditions']);

/** The fields of a manifest whose packages the closure follows. */
const DEPENDENCY_FIELDS = Object.freeze(['dependencies', 'peerDependencies', 'optionalDependencies']);

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
 *   relative import that leaves its package or names no file (credited to
 *   the file that imports it), a wildcard export the installed files could
 *   not make finite, or an export whose target Node refuses
 * @property {Array<{ specifier: string, from: string, reason: string }>} optional -
 *   a bare specifier a served file imports that names an optional peer of
 *   its package (`peerDependencies`, marked `optional` in
 *   `peerDependenciesMeta`) which is not installed: not a failure, since
 *   only a page that loads that file needs it; `reason` says so
 */

/**
 * Build the import map, and the file list, that serve `packages` and their
 * dependency closure unbundled from an installed tree.
 *
 * The closure follows each package's `dependencies`, `peerDependencies`
 * and `optionalDependencies`, a dependency that is not installed passed
 * over. Each package is found as Node finds it — `node_modules/<name>`
 * beside the dependent, then in each parent directory up to `root` —
 * starting from `root` for the packages named. Its `exports` resolve under
 * `conditions` with Node's precedence (`expandExports`), single-star
 * wildcards expand from the installed directory, and every export becomes
 * `imports[specifier] = prefix + <the copy's path below
 * root/node_modules> + '/' + path` — a dependency installed nested is
 * served from its nested place, never from a root copy no dependent
 * reaches. A target Node refuses is reported in `unresolved`, a `null`
 * target maps nothing. A package installed more than once is reported in
 * `duplicates`. An import of an optional peer that is not installed is
 * reported in `optional`, not in `unresolved`: a page that never loads the
 * importing file never fetches it. Node built-ins (`node:fs`, `fs`) are
 * left to the platform.
 *
 * Two calls over the same tree answer the same bytes: keys and lists are
 * sorted.
 * @param {{ packages: readonly string[], root?: string, prefix?: string, conditions?: readonly string[] }} options
 *   `packages` are package names; a bare name is a suite package (`app` is
 *   `@jarenjs/app`). `root` holds `node_modules` (default: the current
 *   directory). `prefix` is the URL `root/node_modules` is served under
 *   and ends with `/` (default `/node_modules/`). `conditions` default to
 *   `browser`, `import`, `default`; `default` matches whatever they are.
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
    for (const field of DEPENDENCY_FIELDS) {
      for (const dep of Object.keys(manifest[field] ?? {})) visit(dep, dir, false);
    }
    if (chosen.get(name) === dir) manifests.set(name, manifest);
  }
  const names = [...manifests.keys()].sort();
  /** Where a copy is served: its directory below `root/node_modules`, which `prefix` serves — a copy
   * installed nested is served from its nested place. @param {string} dir */
  const served = (dir) => prefix + relative(join(top, 'node_modules'), dir).split(sep).join('/') + '/';
  // the map: every package's exports, before any file is followed, so a
  // bare import is checked against the whole closure
  /** @type {Record<string, string>} */
  const imports = {};
  /** @type {Array<{ specifier: string, from: string }>} */
  const unresolved = [];
  /** @type {Array<{ specifier: string, from: string, reason: string }>} */
  const optional = [];
  /** @type {Array<{ name: string, file: string }>} */
  const entryFiles = [];
  for (const name of names) {
    const dir = /** @type {string} */ (chosen.get(name));
    const entries = expandExports(manifests.get(name), { conditions, listFiles: (folder) => listDirectory(join(dir, folder)) });
    for (const entry of entries) {
      const specifier = entry.key === '.' ? name : name + entry.key.slice(1);
      // a wildcard the files could not make finite, or a target Node refuses: nothing a browser could load
      if (entry.unexpanded || entry.invalid) { unresolved.push({ specifier, from: `${name}/package.json` }); continue; }
      if (entry.target === null) continue;
      const file = posix.normalize(entry.target);
      imports[specifier] = served(dir) + file;
      entryFiles.push({ name, file });
    }
  }
  // the files: each export's target and what it reaches
  const files = new Set();
  for (const { name, file } of entryFiles) {
    const dir = /** @type {string} */ (chosen.get(name));
    followFiles(name, dir, file, served(dir), files, unresolved, (bare, from) => {
      if (resolvesBare(bare, imports)) return;
      const reason = absentOptionalPeer(name, manifests.get(name), bare, dir, top);
      if (reason === null) unresolved.push({ specifier: bare, from });
      else optional.push({ specifier: bare, from, reason });
    });
  }
  /** @type {Array<{ name: string, paths: string[] }>} */
  const duplicates = [];
  for (const [name, paths] of met) {
    if (paths.size > 1) duplicates.push({ name, paths: [...paths].map((path) => relative(top, path).split(sep).join('/')).sort() });
  }
  duplicates.sort((a, b) => compare(a.name, b.name));
  return {
    imports: Object.fromEntries(Object.keys(imports).sort(compare).map((key) => [key, imports[key]])),
    files: [...files].sort(compare),
    duplicates,
    unresolved: once(unresolved),
    optional: once(optional),
  };
}

/**
 * Each import once, sorted by specifier, then by the file that imports it.
 * @template {{ specifier: string, from: string }} T
 * @param {T[]} entries
 * @returns {T[]}
 */
function once(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    const id = `${entry.specifier}\u0000${entry.from}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  }).sort((a, b) => compare(a.specifier, b.specifier) || compare(a.from, b.from));
}

/**
 * Why a bare import of package `name` the map does not resolve is no
 * failure, or null when it is one: the import names an optional peer of
 * `name` — in `peerDependencies`, marked `optional` in
 * `peerDependenciesMeta` — that is not installed where Node would look.
 * @param {string} name @param {any} manifest - `name`'s manifest
 * @param {string} specifier @param {string} dir - `name`'s directory
 * @param {string} top
 * @returns {string | null}
 */
function absentOptionalPeer(name, manifest, specifier, dir, top) {
  const peer = specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
  if (!Object.hasOwn(manifest.peerDependencies ?? {}, peer) || manifest.peerDependenciesMeta?.[peer]?.optional !== true) return null;
  return locate(peer, dir, top) === null ? `an optional peer of ${name} that is not installed` : null;
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

/** Every file below a directory, as `/`-separated paths relative to it,
 * or null when there is no such directory. @param {string} folder
 * @returns {string[] | null} */
function listDirectory(folder) {
  if (!existsSync(folder) || !statSync(folder).isDirectory()) return null;
  /** @type {string[]} */
  const out = [];
  /** @param {string} dir @param {string} at */
  const walk = (dir, at) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path, `${at}${name}/`);
      else if (stat.isFile()) out.push(`${at}${name}`);
    }
  };
  walk(folder, '');
  return out;
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
 * imports to `files`; report what leaves the package or names nothing —
 * credited to the file that imports it, or to the manifest for an export's
 * own target — and hand each bare specifier to `bare`.
 * @param {string} name @param {string} dir @param {string} file
 * @param {string} base - the URL the package's directory is served at, ending in `/`
 * @param {Set<string>} files
 * @param {Array<{ specifier: string, from: string }>} unresolved
 * @param {(specifier: string, from: string) => void} bare
 */
function followFiles(name, dir, file, base, files, unresolved, bare) {
  /** @type {Array<{ path: string, specifier: string, from: string }>} */
  const pending = [{ path: file, specifier: `./${file}`, from: `${name}/package.json` }];
  while (pending.length > 0) {
    const { path: current, specifier: asked, from } = /** @type {{ path: string, specifier: string, from: string }} */ (pending.pop());
    const url = base + current;
    if (files.has(url)) continue;
    const path = join(dir, ...current.split('/'));
    if (!existsSync(path) || !statSync(path).isFile()) {
      unresolved.push({ specifier: asked, from });
      continue;
    }
    files.add(url);
    if (!RE_SCRIPT.test(current)) continue;
    for (const { specifier } of scanImports(readFileSync(path, 'utf8'))) {
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        const next = posix.normalize(posix.join(posix.dirname(current), specifier));
        if (next === '..' || next.startsWith('../')) unresolved.push({ specifier, from: `${name}/${current}` });
        else pending.push({ path: next, specifier, from: `${name}/${current}` });
      }
      else bare(specifier, `${name}/${current}`);
    }
  }
}

//#endregion
