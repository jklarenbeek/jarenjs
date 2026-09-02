//@ts-check
/**
 * @file `@jarenjs/json/node` — the one Node-only document loader the
 * suite's CLIs share (`jaren-db`, `jaren-contract`): a document is a
 * `.json` file, or a pure module whose `default` (or named) export IS
 * the document or emits one through `toJSON()` — a pen builder. A
 * module is evaluated TWICE, freshly each time, and refused when the
 * two emissions differ: a clock, the environment or randomness in a
 * document module makes a migration hash differently per load and a
 * contract project differently per run. This subpath is the only one
 * of the package that imports a Node builtin; the root `@jarenjs/json`
 * and every other subpath stay platform-neutral. The helper throws
 * plain errors carrying the reason only — it never prints, never exits,
 * knows no CLI flag and imports no other package of the suite beyond
 * the canonicalizer beside it.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { canonicalizeJson } from './canonical.js';

/** The extensions a document file may carry: JSON, or a module. */
export const DOCUMENT_EXTENSIONS = Object.freeze(['.json', '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']);

const MODULE_EXT = /\.(?:m?js|cjs|m?ts|cts)$/;
const DECLARATION_EXT = /\.d\.[mc]?ts$/;
const TS_EXT = /\.[mc]?ts$/;

/** The unique token of every module evaluation this process made. */
let loads = 0;

/**
 * Whether a file name is a document file: `.json` or a module
 * extension, never a `.d.ts` declaration.
 * @param {string} name
 * @returns {boolean}
 */
export function isDocumentFile(name) {
  if (DECLARATION_EXT.test(name)) return false;
  return name.endsWith('.json') || MODULE_EXT.test(name);
}

/**
 * The document a module exports — `default` when it is not `undefined`,
 * else the named export — as its JSON emission (`JSON.parse(JSON.
 * stringify(value))`, so a pen builder's `toJSON()` participates), or
 * a named refusal.
 * @param {Record<string, unknown>} mod
 * @param {string} exportName
 * @param {string} file
 * @returns {Record<string, unknown>}
 */
function emissionOf(mod, exportName, file) {
  // a CommonJS namespace carries `module.exports` as its default: a
  // module that set `exports.<name>` has the named export, not a default
  const named = mod[exportName];
  const value = Object.hasOwn(mod, 'module.exports') && named !== undefined
    ? named
    : (mod.default !== undefined ? mod.default : named);
  if (value === null || typeof value !== 'object') {
    throw new Error(`module '${file}' exports neither a default nor a '${exportName}' document`);
  }
  let doc;
  try {
    doc = JSON.parse(JSON.stringify(value));
  }
  catch (error) {
    throw new Error(`module '${file}': the ${exportName} emission is not JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`module '${file}': the ${exportName} emission is not a document`);
  }
  return doc;
}

/**
 * One FRESH evaluation of a module: the ESM module map is keyed by the
 * URL with its query, so a unique token yields a new instance; a
 * CommonJS module (`.cjs`, or `.js`/`.ts` under a CommonJS package) is
 * served from `require.cache` by the interop, so its entry is dropped
 * first — two loads are two evaluations on both module systems, not
 * two aliases of one cache entry.
 * @param {string} abs - the absolute path
 * @param {string} file - as the caller named it
 * @param {string} what
 * @returns {Promise<Record<string, unknown>>}
 */
async function evaluate(abs, file, what) {
  const require = createRequire(pathToFileURL(abs).href);
  try {
    delete require.cache[require.resolve(abs)];
  }
  catch {
    // not resolvable through CommonJS (an ESM-only host): the ESM map's token is the whole story
  }
  try {
    return await import(`${pathToFileURL(abs).href}?jaren-load=${++loads}`);
  }
  catch (error) {
    throw new Error(`cannot load ${what} module '${file}': ${error instanceof Error ? error.message : String(error)}`
      + (TS_EXT.test(file)
        ? ' — a .ts module loads only where Node strips types (Node >= 24 does by default; --no-strip-types turns it off)'
        : ''));
  }
}

/**
 * @typedef {Object} LoadDocumentOptions
 * @property {string} [what] - what the file is, for the messages (`'model'`, `'contract'`, `'--from'`); `'document'` by default
 * @property {string} [exportName] - the named export read when a module has no `default`; `'document'` by default
 * @property {string} [impure] - the advice appended to the purity refusal; names the module kind by default
 */

/**
 * Load a document: a `.json` file parsed, or a module evaluated twice
 * whose two emissions must agree. Every refusal is a plain `Error`
 * naming the file and the purpose: an unreadable file (`cannot read
 * <what> '<file>': …`), an extension outside {@link DOCUMENT_EXTENSIONS}
 * or a `.d.ts`, a module that does not load (`cannot load <what> module
 * '<file>': …`, with the strip-types hint for a `.ts`), an export that
 * is no document, an emission that is not JSON or not an object, and an
 * emission that differs between the two evaluations (`the <what> module
 * '<file>' is not pure — …`). Two equal emissions prove the module's own
 * evaluation is deterministic; a read of stable external state (a file
 * that does not change between the two loads) is outside what the
 * comparison can see.
 * @param {string} file
 * @param {LoadDocumentOptions} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function loadDocument(file, options = {}) {
  const what = options.what === undefined ? 'document' : options.what;
  const exportName = options.exportName === undefined ? 'document' : options.exportName;
  if (file.endsWith('.json')) {
    try {
      const text = readFileSync(file, 'utf8');
      // an editor's byte-order mark is not JSON; JSON.parse refuses it
      return JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
    }
    catch (error) {
      throw new Error(`cannot read ${what} '${file}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (DECLARATION_EXT.test(file) || !MODULE_EXT.test(file)) {
    throw new Error(`cannot read ${what} '${file}': neither a .json file nor a module `
      + '(.js, .mjs, .cjs — or .ts where Node strips types)');
  }
  const abs = resolve(file);
  const first = emissionOf(await evaluate(abs, file, what), exportName, file);
  const second = emissionOf(await evaluate(abs, file, what), exportName, file);
  if (canonicalizeJson(first) !== canonicalizeJson(second)) {
    const advice = options.impure === undefined ? `no clock, no env, no randomness in a ${what} module` : options.impure;
    throw new Error(`the ${what} module '${file}' is not pure — two loads emitted different documents; ${advice}`);
  }
  return first;
}
