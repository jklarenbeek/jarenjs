//#region the TypeScript emitter
// Stage two of `@jarenjs/emit`: a type model in, a `.d.ts` out.
//
// The emitter is a JTLT stylesheet, not JavaScript string concatenation, and
// that is the whole architectural point. The model dispatches by `kind` — the
// same vocabulary idiom the website's `ui` rules use — so adding a target
// language means writing rules, not forking a printer. If this file had to
// know anything the Markdown emitter also needs, the model would be wrong.
//
// Nested object types print inline (`{ a: string; b: number }`) while
// declarations print multi-line. That is a deliberate formatting choice, not
// a limitation: a text template has no indentation context to thread, and
// inline nested objects are what a human writes for shallow shapes anyway.

import { compileJtltStylesheet } from '@jarenjs/json/jtlt';
import { createTypeTestCompiler } from '@jarenjs/validate/query';

import { compileEmitModel } from './model.js';

/** Match a model node by its `kind`. A SCHEMA match, not a path match:
 * `$apply` on the current node dispatches location-less, so a path match
 * would silently never fire for a re-dispatched node. Shape is what these
 * rules mean anyway. */
const isKind = (kind) => ({
  schema: { type: 'object', properties: { kind: { const: kind } }, required: ['kind'] },
});

/**
 * The stylesheet. Every rule dispatches on a node's `kind`, so the model's
 * vocabulary is the only coupling between the two stages.
 */
export const TYPESCRIPT_STYLESHEET = {
  $jtlt: '0.1',
  output: 'text',
  rules: [
    // The whole model is the document, so declarations are reachable as
    // children of `$.declarations`. A rule matching the dispatched node as
    // the ROOT would never fire: `$..[?...]` selects children, not the root.
    { match: '$', body: [[{ $apply: ['$.declarations[*]', 'decl'] }]] },

    // --- declarations -------------------------------------------------
    // An object declaration becomes an interface: it is what a reader
    // expects and what extends and merges cleanly. Everything else is a
    // type alias.
    {
      match: { schema: { type: 'object', properties: { kind: { const: 'declaration' }, type: { properties: { kind: { const: 'object' } } } }, required: ['kind', 'type'] } },
      mode: 'decl', priority: 2,
      body: [
        [{ $apply: ['$.doc', 'docblock'] }],
        'export interface ', { $raw: '$.name' }, ' ',
        [{ $apply: ['$.type', 'body'] }],
        '\n',
      ],
    },
    {
      match: isKind('declaration'), mode: 'decl', priority: 1,
      body: [
        [{ $apply: ['$.doc', 'docblock'] }],
        'export type ', { $raw: '$.name' }, ' = ',
        [{ $apply: ['$.type', 'type'] }],
        ';\n\n',
      ],
    },

    // --- an object printed as an interface body (multi-line) ----------
    {
      mode: 'body',
      body: [
        '{\n',
        [{ $apply: ['$.members[*]', 'member'] }],
        [{ $apply: ['$.index', 'index'] }],
        '}\n\n',
      ],
    },
    {
      mode: 'member',
      body: [
        [{ $apply: ['$.doc', 'memberdocblock'] }],
        '  ', { $raw: '$.name' },
        { $if: [{ $not: '$.required' }, '?'] },
        ': ',
        [{ $apply: ['$.type', 'type'] }],
        ';\n',
      ],
    },
    { mode: 'index', body: ['  [key: string]: ', [{ $apply: ['$', 'type'] }], ';\n'] },

    // --- type references ----------------------------------------------
    { match: isKind('primitive'), mode: 'type', body: [{ $raw: '$.primitive' }] },
    { match: isKind('ref'), mode: 'type', body: [{ $raw: '$.ref' }] },
    { match: isKind('unknown'), mode: 'type', body: ['unknown'] },
    { match: isKind('never'), mode: 'type', body: ['never'] },
    { match: isKind('literal'), mode: 'type', body: [{ $json: '$.value' }] },
    {
      match: isKind('array'), mode: 'type',
      body: ['Array<', [{ $apply: ['$.items', 'type'] }], '>'],
    },
    {
      match: isKind('record'), mode: 'type',
      body: ['Record<string, ', [{ $apply: ['$.value', 'type'] }], '>'],
    },
    {
      match: isKind('tuple'), mode: 'type',
      body: ['[',
        [{ $apply: ['$.items[0]', 'type'] }],
        [{ $apply: ['$.items[1:]', 'comma'] }],
        [{ $apply: ['$.rest', 'tuplerest'] }],
        ']'],
    },
    {
      match: isKind('object'), mode: 'type',
      body: ['{ ', [{ $apply: ['$.members[*]', 'inlinemember'] }],
        [{ $apply: ['$.index', 'inlineindex'] }],
        '}'],
    },
    // Separated lists without a position variable: dispatch the first item
    // bare and the remainder through a mode that prints its own separator.
    // `[0]` and `[1:]` are ordinary RFC 9535 selectors, so the split costs
    // nothing and needs no help from the model.
    {
      match: isKind('union'), mode: 'type',
      body: [[{ $apply: ['$.options[0]', 'type'] }],
        [{ $apply: ['$.options[1:]', 'pipe'] }]],
    },
    {
      match: isKind('intersection'), mode: 'type',
      body: [[{ $apply: ['$.parts[0]', 'term'] }],
        [{ $apply: ['$.parts[1:]', 'amp'] }]],
    },
    // An intersection PART that is itself a union has to be parenthesized:
    // `&` binds tighter than `|`, so `(A|B) & (C|D)` printed bare becomes
    // `A | B & C | D`, a different and wider type.
    {
      match: isKind('union'), mode: 'term',
      body: ['(', [{ $apply: ['$', 'type'] }], ')'],
    },
    { mode: 'term', body: [[{ $apply: ['$', 'type'] }]] },
    { mode: 'pipe', body: [' | ', [{ $apply: ['$', 'type'] }]] },
    { mode: 'amp', body: [' & ', [{ $apply: ['$', 'term'] }]] },
    { mode: 'comma', body: [', ', [{ $apply: ['$', 'type'] }]] },
    { mode: 'tuplerest', body: [', ...Array<', [{ $apply: ['$', 'type'] }], '>'] },
    { mode: 'inlineindex', body: ['[key: string]: ', [{ $apply: ['$', 'type'] }], '; '] },
    {
      mode: 'inlinemember',
      body: [{ $raw: '$.name' }, { $if: [{ $not: '$.required' }, '?'] }, ': ',
        [{ $apply: ['$.type', 'type'] }], '; '],
    },

    // --- documentation ------------------------------------------------
    // One comment block per node, opened by the first line and closed by it
    // too. An empty `doc` array dispatches nothing, so a node with nothing to
    // say emits no comment at all — no conditional required.
    {
      mode: 'docblock',
      body: [
        [{ $apply: ['$[0]', 'docopen'] }],
        [{ $apply: ['$[1:]', 'docline'] }],
        [{ $apply: ['$[0]', 'docclose'] }],
      ],
    },
    { mode: 'docopen', body: ['/**\n * ', { $raw: '$' }, '\n'] },
    { mode: 'docline', body: [' * ', { $raw: '$' }, '\n'] },
    { mode: 'docclose', body: [' */\n'] },
    {
      mode: 'memberdocblock',
      body: [
        [{ $apply: ['$[0]', 'memberdocopen'] }],
        [{ $apply: ['$[1:]', 'memberdocline'] }],
        [{ $apply: ['$[0]', 'memberdocclose'] }],
      ],
    },
    { mode: 'memberdocopen', body: ['  /**\n   * ', { $raw: '$' }, '\n'] },
    { mode: 'memberdocline', body: ['   * ', { $raw: '$' }, '\n'] },
    { mode: 'memberdocclose', body: ['   */\n'] },
  ],
};

const compiled = compileJtltStylesheet(TYPESCRIPT_STYLESHEET,
  { compileTypeTest: createTypeTestCompiler() });

/**
 * Render a type model as TypeScript declarations.
 * @param {object} model - A type model from {@link compileEmitModel}
 * @param {object} [options]
 * @param {boolean} [options.banner=true] - Emit the do-not-edit header
 * @returns {string} TypeScript source
 */
/** A property name TypeScript accepts without quotes. */
const BARE_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Project a model into printable TypeScript spellings.
 *
 * The model holds the schema's own vocabulary: a member's `name` is the JSON
 * property name and a doc line is the schema's own prose. Neither is
 * constrained to what TypeScript's grammar accepts, and printing them raw was
 * emitting source that does not parse — `my-key: string` is a subtraction, and
 * a `description` containing a comment terminator closes the JSDoc block early
 * and spills the rest of the schema into code position.
 *
 * Doing it here rather than in the model keeps the model language-neutral:
 * `markdown.js` wants the unquoted name, and a future emitter for another
 * language will want its own spelling.
 * @param {any} node
 * @returns {any} the node with names quoted and doc text made comment-safe
 */
function printable(node) {
  if (Array.isArray(node)) return node.map(printable);
  if (node === null || typeof node !== 'object') return node;
  // A literal node carries the schema's own JSON, not model structure. Walking
  // into it rewrote any data field that happened to be called `name` or `doc`,
  // so a `const` of `{ name: 'a-b' }` was emitted as `{ name: '"a-b"' }` — the
  // generator changing the value it was asked to reproduce. Key names are not
  // a safe way to tell structure from data; the `kind` tag is.
  if (node.kind === 'literal') return node;
  /** @type {any} */
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'name' && typeof value === 'string' && !BARE_NAME.test(value))
      out[key] = JSON.stringify(value);
    else if (key === 'doc' && Array.isArray(value))
      out[key] = value.map((line) => typeof line === 'string'
        ? line.replaceAll('*/', '*\\/') : line);
    else out[key] = printable(value);
  }
  return out;
}

export function renderTypeScript(model, options = {}) {
  const banner = options.banner === false
    ? ''
    // A newline in `source` would end the line comment and put whatever
    // follows into code position — a generator that can be made to write
    // arbitrary source by the name of its input file. Collapse the whitespace
    // that could close the comment.
    : `// Generated by @jarenjs/emit${model.source
      ? ` from ${String(model.source).replace(/[\r\n\u2028\u2029]+/g, ' ')}` : ''}.\n`
      + '// Do not edit: regenerate instead.\n\n';
  return banner + compiled(printable(model));
}

/**
 * Compile a JSON Schema straight to TypeScript declarations — the one-call
 * form of {@link compileEmitModel} followed by {@link renderTypeScript}.
 * @param {object|boolean} schema - The schema to emit
 * @param {object} [options] - Model options (see `compileEmitModel`)
 * @returns {string} TypeScript source
 * @example
 * emitTypeScript({ type: 'object', properties: { id: { type: 'string' } } },
 *   { name: 'User' });
 * // export interface User { id?: string; }
 */
export function emitTypeScript(schema, options = {}) {
  return renderTypeScript(compileEmitModel(schema, options), options);
}

//#endregion
