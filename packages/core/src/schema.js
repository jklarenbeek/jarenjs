//@ts-check
/**
 * @file The JSON Schema constraint-keyword vocabulary, grouped by the
 * value family each keyword constrains. Forms' constraint extraction,
 * emit's dropped-constraint table and the validator's dispatch and
 * `$ref`-sibling detection compose their lists from these shared groups
 * and append their own extras. Consumers own their processing loops;
 * the shared vocabulary keeps keyword membership consistent.
 *
 * ORDER IS PART OF THE CONTRACT: the validator's `$data` dispatch
 * applies keywords in list order and its error order is observable
 * behaviour, so the internal order of each group is fixed. Membership
 * consumers are order-insensitive by construction.
 *
 * Beside the groups lives the one nullable normalizer: `{ type: [T,
 * 'null'] }` and a two-branch `anyOf`/`oneOf` with a null-only branch
 * are two spellings of one meaning only when they accept the same
 * values. `splitNullable` gives a reader the non-null branch
 * structurally (forms, the contract transport compiler);
 * `canonicalNullable` gives the one spelling value-exactly (the contract
 * diff), or `null` where the spellings accept different values.
 */

import { equalsJson } from './object.js';

/** Keywords constraining numeric values, in dispatch order. */
export const NUMERIC_CONSTRAINTS = Object.freeze([
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
]);

/** Keywords constraining string values, in dispatch order. */
export const STRING_CONSTRAINTS = Object.freeze([
  'minLength', 'maxLength', 'pattern', 'format',
]);

/** Keywords constraining array values, in dispatch order. */
export const ARRAY_CONSTRAINTS = Object.freeze([
  'minItems', 'maxItems', 'uniqueItems',
]);

/** Keywords constraining object values, in dispatch order. */
export const OBJECT_CONSTRAINTS = Object.freeze([
  'minProperties', 'maxProperties',
]);

/**
 * Annotation keywords: they describe a value and never decide whether
 * it is accepted (2020-12's meta-data vocabulary, plus `$comment`).
 */
export const ANNOTATION_KEYWORDS = /* @__PURE__ */ Object.freeze([
  'title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly', '$comment',
]);

/**
 * For each JSON type, the keywords that constrain only values of that
 * type and accept every other value, `null` among them. A nullable
 * spelling can move exactly these between an `anyOf` branch and a type
 * array without changing what the schema accepts. Composed from the
 * groups above, their order kept. `format` and its bounds count as
 * string keywords: 2020-12 defines every format over strings, and the
 * suite's format validators accept values their format does not cover.
 * @type {Readonly<Record<'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object', readonly string[]>>}
 */
// Pure calls on literals, so a bundle that never normalizes carries none
// of the table. `concat`, not a spread: a bundler keeps a spread (it may
// run an iterator), and with it the whole table.
export const TYPE_SCOPED_KEYWORDS = /* @__PURE__ */ Object.freeze({
  __proto__: null,
  string: /* @__PURE__ */ Object.freeze(/* @__PURE__ */ STRING_CONSTRAINTS.concat([
    'formatMinimum', 'formatMaximum', 'formatExclusiveMinimum', 'formatExclusiveMaximum',
    'contentEncoding', 'contentMediaType', 'contentSchema'])),
  number: NUMERIC_CONSTRAINTS,
  integer: NUMERIC_CONSTRAINTS,
  boolean: /* @__PURE__ */ Object.freeze([]),
  array: /* @__PURE__ */ Object.freeze(/* @__PURE__ */ ARRAY_CONSTRAINTS.concat([
    'items', 'prefixItems', 'contains', 'minContains', 'maxContains', 'unevaluatedItems'])),
  object: /* @__PURE__ */ Object.freeze(/* @__PURE__ */ OBJECT_CONSTRAINTS.concat([
    'properties', 'patternProperties', 'additionalProperties', 'required', 'propertyNames',
    'dependentRequired', 'dependentSchemas', 'unevaluatedProperties'])),
});

/** @type {{ annotations: Set<string>, scoped: Record<string, Set<string>> } | null} */
let lookups = null;

/** The two tables as sets, built on the first normalization. */
function tables() {
  if (lookups === null) {
    lookups = {
      annotations: new Set(ANNOTATION_KEYWORDS),
      scoped: Object.fromEntries(Object.entries(TYPE_SCOPED_KEYWORDS)
        .map(([type, keywords]) => [type, new Set(keywords)])),
    };
  }
  return lookups;
}

/** @param {unknown} value @returns {value is Record<string, any>} */
const isNode = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Whether a key only annotates the node it sits on. An `x-` extension
 * annotates too, except the two the normalizer acts on.
 * @param {string} key
 */
const annotates = (key) => tables().annotations.has(key)
  || (key.startsWith('x-') && key !== 'x-coerce' && key !== 'x-trim');

/**
 * Whether a branch admits `null` and nothing else: `{ type: 'null' }`,
 * `{ const: null }` or `{ enum: [null] }`, annotations allowed.
 * @param {unknown} branch
 */
function isNullOnly(branch) {
  if (!isNode(branch)) return false;
  let spelled = false;
  for (const key of Object.keys(branch)) {
    if (annotates(key)) continue;
    const value = branch[key];
    const nullOnly = key === 'type' ? value === 'null' || (Array.isArray(value) && value.length > 0 && value.every((t) => t === 'null'))
      : key === 'const' ? value === null
        : key === 'enum' ? Array.isArray(value) && value.length > 0 && value.every((v) => v === null)
          : false;
    if (!nullOnly) return false;
    spelled = true;
  }
  return spelled;
}

/**
 * The single non-null type of a `[T, 'null']` type array, or `null`.
 * @param {unknown} type
 * @returns {string | null}
 */
function nullableTypeOf(type) {
  if (!Array.isArray(type) || !type.includes('null')) return null;
  const others = [...new Set(type.filter((t) => t !== 'null'))];
  return others.length === 1 && typeof others[0] === 'string' ? others[0] : null;
}

/**
 * The two branches of a nullable `anyOf`/`oneOf`, or `null`: exactly two
 * branches, one of them null-only, on a node that carries nothing else
 * but annotations.
 * @param {Record<string, any>} schema
 * @returns {{ branch: any, annotations: Record<string, any> } | null}
 */
function unionBranches(schema) {
  const applicator = Array.isArray(schema.anyOf) ? 'anyOf' : Array.isArray(schema.oneOf) ? 'oneOf' : null;
  if (applicator === null) return null;
  const options = schema[applicator];
  if (options.length !== 2) return null;
  /** @type {Record<string, any>} */
  const annotations = {};
  for (const key of Object.keys(schema)) {
    if (key === applicator) continue;
    if (!annotates(key)) return null;
    annotations[key] = schema[key];
  }
  const [a, b] = options;
  if (isNullOnly(b) && !isNullOnly(a)) return { branch: a, annotations };
  if (isNullOnly(a) && !isNullOnly(b)) return { branch: b, annotations };
  return null;
}

/**
 * Split a nullable schema into its non-null branch — structurally, for a
 * reader that needs the branch to choose a control or an encoding and
 * leaves the rest to the validator.
 *
 * - `{ type: [T, 'null'], … }` with one non-null `T` gives the node with
 *   `type: T`;
 * - an `anyOf` or `oneOf` of exactly two branches, one of them null-only
 *   (`{ type: 'null' }`, `{ const: null }`, `{ enum: [null] }`), on a node
 *   that carries only annotations, gives the other branch with the node's
 *   annotations laid over it.
 *
 * Anything else — one type, several non-null types, a nullable `enum` —
 * is `null`. The input is never modified.
 * @param {unknown} schema
 * @returns {{ schema: any, nullable: true } | null}
 * @example
 * splitNullable({ anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] });
 * // { schema: { type: 'string', format: 'date' }, nullable: true }
 */
export function splitNullable(schema) {
  if (!isNode(schema)) return null;
  const type = nullableTypeOf(schema.type);
  if (type !== null) return { schema: { ...schema, type }, nullable: true };
  const union = unionBranches(schema);
  if (union === null) return null;
  return { schema: isNode(union.branch) ? { ...union.branch, ...union.annotations } : union.branch, nullable: true };
}

/** Keywords holding one subschema, a map of them, or a list of them. */
const ONE_SUBSCHEMA = ['items', 'contains', 'additionalProperties', 'propertyNames', 'unevaluatedItems',
  'unevaluatedProperties', 'not', 'if', 'then', 'else', 'contentSchema'];
const MAP_OF_SUBSCHEMAS = ['properties', 'patternProperties', 'dependentSchemas'];
const LIST_OF_SUBSCHEMAS = ['prefixItems', 'allOf', 'anyOf', 'oneOf'];

/**
 * Whether a normalizer keyword (`default`, `x-coerce`, `x-trim`) sits at
 * or below a node, through every subschema position. A `$ref` is not
 * followed: this reads the node alone, without its document.
 * @param {unknown} node
 * @param {Set<object>} [seen]
 * @returns {boolean}
 */
function reachesNormalizer(node, seen = new Set()) {
  if (!isNode(node) || seen.has(node)) return false;
  seen.add(node);
  if (Object.hasOwn(node, 'default') || Object.hasOwn(node, 'x-coerce') || Object.hasOwn(node, 'x-trim')) return true;
  for (const key of ONE_SUBSCHEMA) if (reachesNormalizer(node[key], seen)) return true;
  for (const key of MAP_OF_SUBSCHEMAS) {
    const map = node[key];
    if (isNode(map) && Object.keys(map).some((name) => reachesNormalizer(map[name], seen))) return true;
  }
  for (const key of LIST_OF_SUBSCHEMAS) {
    const list = node[key];
    if (Array.isArray(list) && list.some((sub) => reachesNormalizer(sub, seen))) return true;
  }
  return false;
}

/**
 * The one canonical spelling of a nullable schema — `{ …S, type: [T,
 * 'null'] }` — when, and only when, the two spellings accept exactly the
 * same values: the non-null branch `S` has `type: T` and every other
 * keyword of `S` is scoped to `T` (TYPE_SCOPED_KEYWORDS) or annotates.
 * A `$query`, an applicator, `const`, `enum`, `$ref`, two different
 * values for one annotation, or a normalizer keyword (`default`,
 * `x-coerce`, `x-trim`) at or below the branch keep the spellings
 * distinct, and the result is `null`: the normalizer enters a type array
 * and never a union branch, so such a keyword would act on one spelling
 * only. (A `$ref` below the branch is not followed — this reads the node
 * without its document.) (A host's own normalizer OPTIONS — `coerceTypes`,
 * `removeAdditional` — act on the type array alone too; a host that uses
 * them reads a union through `splitNullable`.) A schema that is not
 * nullable is `null` too.
 * @param {unknown} schema
 * @returns {Record<string, any> | null}
 * @example
 * canonicalNullable({ anyOf: [{ type: 'string', minLength: 2 }, { type: 'null' }] });
 * // { type: ['string', 'null'], minLength: 2 }
 * canonicalNullable({ anyOf: [{ type: 'string', $query: { … } }, { type: 'null' }] }); // null
 */
export function canonicalNullable(schema) {
  if (!isNode(schema)) return null;
  const arrayType = nullableTypeOf(schema.type);
  if (arrayType !== null) {
    const scoped = tables().scoped[arrayType];
    if (scoped === undefined) return null;
    for (const key of Object.keys(schema)) {
      if (key !== 'type' && !scoped.has(key) && !annotates(key)) return null;
    }
    return { ...schema, type: [arrayType, 'null'] };
  }
  const union = unionBranches(schema);
  if (union === null || !isNode(union.branch)) return null;
  const branch = union.branch;
  const type = branch.type;
  if (typeof type !== 'string' || type === 'null') return null;
  const scoped = tables().scoped[type];
  if (scoped === undefined) return null;
  for (const key of Object.keys(branch)) {
    if (key === 'type' || scoped.has(key)) continue;
    if (key === 'default' || !annotates(key)) return null;
  }
  if (reachesNormalizer(branch)) return null;
  /** @type {Record<string, any>} */
  const canonical = { ...branch };
  for (const key of Object.keys(union.annotations)) {
    if (Object.hasOwn(canonical, key) && !equalsJson(canonical[key], union.annotations[key])) return null;
    canonical[key] = union.annotations[key];
  }
  canonical.type = [type, 'null'];
  return canonical;
}
