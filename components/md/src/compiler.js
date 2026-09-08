//@ts-check
/**
 * @file compileMarkdown: parse once, then hand out specialized
 * closures.
 *
 * A CompiledMd is the package's unit of work: the parsed document plus
 * lazily-built, cached projections (vnode tree, canonical Markdown,
 * frontmatter externals). Every projection is computed at most once
 * per compiled document — calling `toVnode()` twice returns the same
 * reference, which is what the view patcher's `===` fast path wants.
 */

import { parseMarkdown, buildPluginTables } from './parser.js';
import { walkAst, visitAst } from './ast.js';
import { toMarkdown } from './to-md.js';
import { mdToVnode } from './to-vnode.js';

/**
 * @typedef {import('./ast.js').MdNode} MdNode
 * @typedef {import('./ast.js').MdDocument} MdDocument
 * @typedef {import('./parser.js').MdParseOptions} MdParseOptions
 */
/**
 * @typedef {MdParseOptions & { retainSource?: boolean,
 *   html?: 'skip'|'text', headingIds?: boolean, slugPrefix?: string,
 *   headingAnchors?: boolean, footnotesLabel?: string,
 *   keyed?: boolean }} MdCompileOptions
 */
/**
 * The compiled closure bundle.
 * @typedef {object} CompiledMd
 * @property {MdDocument} doc the parsed document
 * @property {MdNode[]} ast `doc.ast`
 * @property {any} frontmatter `doc.frontmatter`
 * @property {string} hash `doc.meta.hash`
 * @property {string|null} source the source text (null when `retainSource: false`)
 * @property {any} tables the compiled plugin tables (internal contract)
 * @property {() => any} toVnode cached vnode projection
 * @property {() => string} toMarkdown cached canonical Markdown
 * @property {(visitor: any) => void} walk pre-order walker over the AST
 * @property {(visitors: any) => void} visit compiled per-type visitor
 * @property {() => Record<string, any>} externals frontmatter as JSLT/query externals
 */

/**
 * Compile Markdown source (or an already-parsed MdDocument) into a
 * closure bundle.
 *
 * @example
 * const md = compileMarkdown('# Hi\n\nSome *text*.');
 * md.toVnode();          // ['article', { class: 'md' }, ...]
 * md.toMarkdown();       // '# Hi\n\nSome *text*.\n'
 * md.externals();        // {} — no frontmatter
 *
 * @param {string | MdDocument} sourceOrDoc
 * @param {MdCompileOptions} [options]
 * @returns {CompiledMd}
 */
export function compileMarkdown(sourceOrDoc, options = {}) {
  const fromSource = typeof sourceOrDoc === 'string';
  const doc = fromSource
    ? parseMarkdown(sourceOrDoc, options)
    : sourceOrDoc;
  const source = fromSource && options.retainSource !== false
    ? /** @type {string} */ (sourceOrDoc)
    : null;
  const tables = buildPluginTables(options.plugins);

  /** @type {any} */
  let vnode;
  /** @type {string | undefined} */
  let markdown;
  /** @type {Record<string, any> | undefined} */
  let externals;

  /** @type {CompiledMd} */
  const compiled = {
    doc,
    ast: doc.ast,
    frontmatter: doc.frontmatter,
    hash: doc.meta.hash,
    source,
    tables,

    toVnode() {
      if (vnode === undefined) {
        vnode = mdToVnode(compiled, {
          plugins: options.plugins,
          html: options.html,
          sanitizeUrl: options.sanitizeUrl,
          headingIds: options.headingIds,
          slugPrefix: options.slugPrefix,
          headingAnchors: options.headingAnchors,
          footnotesLabel: options.footnotesLabel,
          keyed: options.keyed,
        });
      }
      return vnode;
    },

    toMarkdown() {
      if (markdown === undefined) markdown = toMarkdown(doc);
      return markdown;
    },

    walk(visitor) {
      walkAst(doc.ast, visitor);
    },

    visit(visitors) {
      visitAst(doc.ast, visitors);
    },

    externals() {
      if (externals === undefined) externals = frontmatterExternals(doc.frontmatter);
      return externals;
    },
  };
  return compiled;
}

/**
 * Flatten frontmatter into an externals object for the query/JSLT
 * engines (MD-FORMAT.md §3.4). Only a frontmatter *object* contributes
 * members; the engine-reserved names `root` and `path` are dropped.
 * @param {any} frontmatter
 * @returns {Record<string, any>}
 */
export function frontmatterExternals(frontmatter) {
  /** @type {Record<string, any>} */
  const out = {};
  if (frontmatter === null || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    return out;
  }
  for (const key of Object.keys(frontmatter)) {
    if (key === 'root' || key === 'path') continue;
    out[key] = frontmatter[key];
  }
  return out;
}

/**
 * Emit a `@jarenjs/forms`-consumable structure from a document whose
 * frontmatter declares a schema (`$schema` object member or `form:`
 * key). The caller injects the forms module (or the two functions it
 * needs) — `@jarenjs/md` stays dependency-free:
 *
 * @example
 * import * as forms from '@jarenjs/forms';
 * const form = mdToForm(md.doc, forms);
 * // { schema, fields, data } or null when no schema is declared
 *
 * @param {MdDocument} doc
 * @param {{ buildFormModel: (schema: any) => any,
 *           createInitialData: (fields: any) => any }} forms
 * @returns {{ schema: any, fields: any, data: any } | null}
 */
export function mdToForm(doc, forms) {
  const fm = doc.frontmatter;
  if (fm === null || typeof fm !== 'object' || Array.isArray(fm)) return null;
  const schema = typeof fm.form === 'object' && fm.form !== null
    ? fm.form
    : typeof fm.$schema === 'object' && fm.$schema !== null ? fm.$schema : null;
  if (schema === null) return null;
  const fields = forms.buildFormModel(schema);
  const data = fm.data !== undefined ? fm.data : forms.createInitialData(fields);
  return { schema, fields, data };
}
