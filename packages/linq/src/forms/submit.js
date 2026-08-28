//@ts-check
/**
 * @file `assertOnSubmit()` — the second spelling of a rule written once.
 * An `x-form.assert` is evaluated per keystroke by `evaluateFormRules`;
 * the same constraint is authoritative at submit through the validator's
 * `$query` keyword, and the forms README's layer 3 is the transform that
 * copies one into the other. The pen offers it as ONE call over the
 * document it wrote, so an author spells the rule once and asks for both
 * documents.
 *
 * The rules the copy keeps are the README's, and each is a place a naive
 * copy went wrong: an absent field binds `null` (through `$default`), an
 * item-template assert quantifies over the ELEMENTS rather than the
 * selected leaves, and an assert on a field that also declares `visible`
 * is guarded by it so it holds vacuously while the field is hidden. The
 * branches land on the ROOT, where `$` is the instance root the rule
 * context expects; the message travels with them so submit renders the
 * same text the keystroke path does.
 *
 * Nothing here imports `@jarenjs/forms`: the transform reads the emitted
 * document, and the pen test pins it equal to
 * `formRulesToQueryAssertions` over the corpus.
 */

import { deepFreeze } from '@jarenjs/core/object';

import { LinqBuildError } from '../errors.js';
import { isSchemaBuilder, schemaOf } from '../schema/brand.js';
import { describeValue } from '../json-boundary.js';
import { KEYWORD } from './rules.js';

/**
 * The loop-variable prefix for element quantification — the same one the
 * forms transform uses, so the two documents are byte-equal.
 */
const ITEM_VAR = '_item';

/** RFC 6901: `~` and `/` escape inside a pointer segment. @param {string} key */
const escapePointer = (key) => key.replaceAll('~', '~0').replaceAll('/', '~1');

/**
 * The RFC 9535 name selector `['…']` for one member name.
 * @param {string} key
 * @returns {string}
 */
function nameSelector(key) {
  let out = "['";
  for (const ch of key) {
    const code = /** @type {number} */ (ch.codePointAt(0));
    if (ch === '\\' || ch === "'") out += `\\${ch}`;
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}']`;
}

/** A new chunk list with `selector` appended to its last chunk. */
function extendChunks(chunks, selector) {
  const next = chunks.slice();
  next[next.length - 1] += selector;
  return next;
}

/**
 * The `$query` document for one assert, from its location expressed as
 * path chunks split at each array expansion.
 * @param {readonly string[]} chunks
 * @param {any} assert - the authored rule document
 * @param {string} pointer - the field's data pointer
 * @param {any} [visible] - the field's `visible` rule, when it has one
 * @returns {any}
 */
function assertQuery(chunks, assert, pointer, visible) {
  const depth = chunks.length - 1;
  const at = (k) => (k === 0 ? chunks[0] : `$${ITEM_VAR}${k - 1}${chunks[k]}`);
  const body = visible === undefined ? assert : { $or: [{ $not: visible }, assert] };
  let query = {
    $let: { value: { $default: [at(depth), { $const: null }] }, pointer: { $const: pointer } },
    $return: body,
  };
  for (let k = depth - 1; k >= 0; k--) {
    query = { $every: { [`${ITEM_VAR}${k}`]: at(k) }, $satisfies: query };
  }
  return query;
}

/**
 * The `errorMessage.$query` spec one assert carries: the rule's message
 * with `params` merged over `{ pointer }`, or the catalog default.
 * @param {any} message
 * @param {string} pointer
 * @returns {any}
 */
function messageSpec(message, pointer) {
  if (typeof message === 'string') return { message, params: { pointer } };
  if (message !== null && typeof message === 'object' && !Array.isArray(message)) {
    return { ...message, params: { pointer, ...(message.params || {}) } };
  }
  return { $msgid: 'x-form/assert', params: { pointer } };
}

/**
 * Walk the structural spine `buildFormModel` walks — `properties`,
 * `prefixItems`, `items`, `allOf` — collecting every `x-form.assert`
 * with its data location. `$ref`s are NOT resolved: a definition's data
 * location depends on its use site.
 * @param {any} schema
 * @param {string} pointer
 * @param {readonly string[]} chunks
 * @param {any[]} out
 */
function collect(schema, pointer, chunks, out) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return;

  const rules = schema[KEYWORD];
  if (rules !== null && typeof rules === 'object' && !Array.isArray(rules)
    && rules.assert !== undefined) {
    out.push({
      query: assertQuery(chunks, rules.assert, pointer, rules.visible),
      pointer,
      message: rules.message,
    });
  }
  if (schema.properties !== null && typeof schema.properties === 'object') {
    for (const [key, sub] of Object.entries(schema.properties)) {
      collect(sub, `${pointer}/${escapePointer(key)}`, extendChunks(chunks, nameSelector(key)), out);
    }
  }
  if (Array.isArray(schema.prefixItems)) {
    for (let i = 0; i < schema.prefixItems.length; i++) {
      collect(schema.prefixItems[i], `${pointer}/${i}`, extendChunks(chunks, `[${i}]`), out);
    }
  }
  if (schema.items !== null && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
    collect(schema.items, `${pointer}/-`, [...extendChunks(chunks, '[*]'), ''], out);
  }
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) collect(branch, pointer, chunks, out);
  }
}

/**
 * The submit twin of a document's `x-form.assert` rules: every assert
 * copied onto the ROOT as its own `allOf` branch
 * `{ $query, errorMessage }`, so the rule an author wrote once for
 * per-keystroke feedback is also what the compiled validator enforces.
 *
 * A document with no assert answers the document itself — there is
 * nothing to copy, and a needless `allOf` would be a second spelling of
 * the same schema.
 *
 * @param {any} root - the root builder, or a document
 * @returns {any} the deep-frozen submit document
 * @throws {LinqBuildError} `JL0101` a value that is not a builder or an
 *   object schema
 * @example
 * const schema = s.object({ vatId: s.string().form({ assert: …, message: … }) });
 * new JarenValidator().compile(assertOnSubmit(schema));   // app-side
 */
export function assertOnSubmit(root) {
  const schema = isSchemaBuilder(root) ? schemaOf(root) : root;
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new LinqBuildError('JL0101',
      'assertOnSubmit() takes the document\'s root builder or its schema object, got '
      + describeValue(root));
  }
  /** @type {any[]} */
  const asserts = [];
  collect(schema, '', ['$'], asserts);
  if (asserts.length === 0) return deepFreeze(JSON.parse(JSON.stringify(schema)));
  const branches = asserts.map((entry) => ({
    $query: entry.query,
    errorMessage: { $query: messageSpec(entry.message, entry.pointer) },
  }));
  const allOf = Array.isArray(schema.allOf) ? schema.allOf : [];
  return deepFreeze(JSON.parse(JSON.stringify({ ...schema, allOf: [...allOf, ...branches] })));
}
