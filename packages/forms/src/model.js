//@ts-check

/**
 * Form model builder: turns a JSON Schema into a tree of field descriptors
 * that a UI layer (React, vanilla DOM, ...) can render as a form.
 *
 * The builder resolves local `$ref`s (`#/$defs/...`, `#/definitions/...`),
 * shallowly merges `allOf` branches, and annotates every field with the
 * constraints and rendering hints needed for preemptive per-field
 * validation (see validate.js).
 */

import { getInclusiveExclusiveBounds } from '@jarenjs/core';
import { equalsDeep, isJsonObject } from '@jarenjs/core/object';
import { createWeakCache } from '@jarenjs/core/cache';
import { formatMessageValue } from '@jarenjs/core/message';
import {
  NUMERIC_CONSTRAINTS, STRING_CONSTRAINTS,
  ARRAY_CONSTRAINTS, OBJECT_CONSTRAINTS, TYPE_SCOPED_KEYWORDS, splitNullable,
} from '@jarenjs/core/schema';

import { encodeJSONPointerSegment } from '@jarenjs/json/pointer';
import {
  collectSameDocumentAnchors,
  resolveSameDocumentRef,
} from '@jarenjs/validate/references';

import {
  getFormatInfo,
  isNumberFormat,
} from './formats.js';

const DEFAULT_MAX_DEPTH = 24;

/**
 * What `minLength` and `maxLength` count: grapheme clusters, code points
 * or UTF-16 code units, the units a validator's `lengthUnit` names.
 * @typedef {'grapheme'|'codepoint'|'utf16'} LengthUnit
 */

/**
 * @typedef {object} FormField
 * @property {string} pointer - JSON pointer into the DATA (e.g. '/user/name')
 * @property {string} key - Property name (or '-' for an array item template)
 * @property {string} msgid - The field's message-id base: `x-msgid` annotation or the pointer (the root field's base is the empty pointer '')
 * @property {string} label - Human friendly label (schema title or humanized key), through the `t` hook
 * @property {string|undefined} description
 * @property {object} schema - The resolved subschema for this field
 * @property {string} kind - 'string'|'number'|'integer'|'boolean'|'enum'|'const'|'object'|'array'|'unknown'
 * @property {string} control - Suggested control: 'text'|'email'|'url'|'password'|'textarea'|'number'|'checkbox'|'select'|'date'|'datetime-local'|'time'|'color'|'json'
 * @property {boolean} required - Whether the parent object requires this property
 * @property {boolean} nullable - Whether the schema admits `null`, as the validator reads
 *   it: a type that lists `'null'` (an `enum` or `const` beside it must admit `null` too),
 *   OpenAPI's `nullable: true`, an `anyOf`/`oneOf` with a branch that admits it, or no
 *   `type`, `enum`, `const`, `anyOf` or `oneOf` at all. The two spellings of one nullable
 *   type give the field the non-null branch's kind, control and constraints
 * @property {boolean} readOnly
 * @property {Array<any>|null} enumValues - Options for a select control
 * @property {Array<string>|null} enumLabels - Display labels parallel to enumValues (oneOf const/title idiom, through the `t` hook)
 * @property {any} constValue - Fixed value when the schema is a const
 * @property {any} defaultValue
 * @property {string|undefined} placeholder
 * @property {import('./formats.js').FormatPreview|null} preview - The format's preview hint (formats.js), for a host with a renderer for it; null otherwise
 * @property {object} constraints - minLength/maxLength/pattern/minimum/... extracted for the UI:
 *   where several places of the schema hold a bound (the node, the schema its `$ref` names,
 *   an `allOf` branch), the tightest
 * @property {Array<Record<string, any>>} asserted - What the field check judges: the keywords
 *   of each place of the schema that asserts (the node itself, the schema its `$ref` names
 *   and every `allOf` branch, each followed alike), one record per place. A keyword two
 *   places hold is judged twice, never merged
 * @property {LengthUnit} lengthUnit - What `minLength`/`maxLength` count on this field: the
 *   unit the model was built with (`buildFormModel`'s `lengthUnit`), graphemes by default
 * @property {object|null} rules - The raw `x-form` rules annotation, if any (see rules.js)
 * @property {Array<FormField>|null} children - Child fields for object kinds
 * @property {FormField|null} item - Template field for array items
 * @property {Array<FormField>|null} tuple - Fixed prefix fields for tuple arrays
 */

/**
 * The static-text translation hook: receives a role-qualified message id
 * (`<base>#label`, `<base>#description`, `<base>#placeholder`,
 * `<base>#enum/<value>`) and the schema-derived fallback text; returns
 * the text to display.
 * @typedef {(msgid: string, fallback: string|undefined, params?: object) => string|undefined} TranslateHook
 */

/** @type {TranslateHook} The zero-cost identity hook. */
const identityT = (msgid, fallback) => fallback;

/**
 * Convert 'firstName' / 'first_name' / 'first-name' to 'First Name'.
 * Latin-script-oriented (word splitting on case/underscore/hyphen and
 * ASCII capitalization); the `t` hook of buildFormModel is the override
 * point for anything it mangles.
 * @param {string} key
 * @returns {string}
 */
export function humanizeKey(key) {
  if (typeof key !== 'string' || key.length === 0) return String(key);
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}

/**
 * Anchor maps per root schema, computed once and held exactly as long
 * as the root object itself (`collectSameDocumentAnchors` walks the
 * whole document — per-field recomputation would be quadratic).
 */
const ANCHOR_MAPS = createWeakCache();

/**
 * Resolve a same-document `$ref` — `#` (the root), `#/pointer`, or
 * `#anchor` — with the validator's own exported resolver, so a form
 * derives its model from exactly the schema the validator would
 * enforce; a private resolver of `#/pointer` alone would render the
 * root and anchor forms as `unknown`. External refs stay unresolvable
 * by design.
 * @param {string} ref
 * @param {object} rootSchema
 * @returns {object|boolean|null} The referenced schema or null when unresolvable
 */
function resolveLocalRef(ref, rootSchema) {
  if (typeof ref !== 'string' || !ref.startsWith('#')) return null;
  let fragment = ref;
  try {
    if (fragment.indexOf('%') >= 0) fragment = decodeURIComponent(fragment);
  }
  catch (_e) {
    return null; // malformed fragment: same 'unresolvable' answer as a missing target
  }
  const anchors = (rootSchema !== null && typeof rootSchema === 'object')
    ? ANCHOR_MAPS.getOrCreate(rootSchema, collectSameDocumentAnchors)
    : undefined;
  const target = resolveSameDocumentRef(fragment, rootSchema,
    /** @type {Map<string, object>|undefined} */ (anchors));
  return target === undefined ? null : target;
}

// The reading of a keyword's value, as the validator admits it when a
// schema compiles: one reading for the field check (validate.js) and for
// the bounds a control is given.

/**
 * A keyword value as the number the validator reads it as: a number, or
 * a string whose text is one (`"5"`). Any other value (a bigint, which
 * bounds no number; `null`, a boolean, an object, blank text) is none:
 * the validator refuses such a schema when it compiles (`JK0013`), so
 * the keyword asserts nothing per keystroke, as a pattern that does not
 * compile.
 * @param {unknown} value - A keyword's value
 * @returns {number | undefined}
 */
export function numberOfKeyword(value) {
  const number = typeof value === 'number' ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isNaN(number) ? undefined : number;
}

/**
 * A keyword value as the count the validator reads it as (`minLength`,
 * `maxItems`, ...): a non-negative integer, written as a number, a
 * bigint or a number string. Any other value is none (see
 * {@link numberOfKeyword}).
 * @param {unknown} value - A keyword's value
 * @returns {number | undefined}
 */
export function countOfKeyword(value) {
  const number = typeof value === 'bigint' ? value : numberOfKeyword(value);
  return number !== undefined && number >= 0 && (typeof number === 'bigint' || Number.isInteger(number))
    ? Number(number) : undefined;
}

/**
 * The places of a schema that assert a value, in the order a control
 * reads them: the node itself, the schema its `$ref` names and every
 * `allOf` branch, each followed alike. The validator applies every one
 * (the keywords beside a `$ref` as the latest draft reads them), so the
 * field check judges every one. A schema reached twice is one place, so
 * a reference back into a schema it is being read from ends there;
 * `false`, which no value passes, is a place, and `true` is none.
 * @param {unknown} schema
 * @param {object} rootSchema
 * @param {number} depth
 * @param {Array<Record<string, any> | false>} [places] - The places found so far
 * @returns {Array<Record<string, any> | false>}
 */
function assertingPlaces(schema, rootSchema, depth, places = []) {
  if (schema === false ? places.includes(false) : !isJsonObject(schema) || places.includes(schema)) return places;
  places.push(schema);
  if (schema === false || depth > DEFAULT_MAX_DEPTH) return places;
  if (typeof schema.$ref === 'string') {
    const target = resolveLocalRef(schema.$ref, rootSchema);
    if (target !== null) assertingPlaces(target, rootSchema, depth + 1, places);
  }
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) assertingPlaces(branch, rootSchema, depth + 1, places);
  }
  return places;
}

/** The keywords a place holds beside the ones that lead to other places. @param {string} key */
const leadsOn = (key) => key === 'allOf' || key === '$ref';

/**
 * One schema for the several a position is given: itself, or the `allOf`
 * of them, which the field built from it judges branch by branch.
 * @param {unknown[]} schemas
 * @returns {unknown}
 */
const allOfThem = (schemas) => (schemas.length === 1 ? schemas[0] : { allOf: schemas });

/**
 * The tightest of the bounds several places hold on one side of a range,
 * for a control: the greatest lower or the least upper inclusive bound
 * and the tightest exclusive one, a draft-04 boolean read as the bound it
 * makes exclusive. Bounds a control can use are numbers; where no place
 * holds one, the bigint bounds are compared instead.
 * @param {Array<Record<string, any>>} places
 * @param {'minimum' | 'maximum'} inclusive
 * @param {'exclusiveMinimum' | 'exclusiveMaximum'} exclusive
 * @param {Record<string, any>} merged - Where the two bounds are written
 */
function foldBounds(places, inclusive, exclusive, merged) {
  const holders = places.filter((place) => place[inclusive] !== undefined || place[exclusive] !== undefined);
  if (holders.length < 2) return;
  const lower = inclusive === 'minimum';
  /** The tightest of the bounds one family holds, or undefined for none. @param {Array<number | bigint | undefined>} bounds */
  const tightest = (bounds) => bounds.reduce((tight, bound) => (
    bound === undefined || (tight !== undefined && (lower ? bound <= tight : bound >= tight)) ? tight : bound), undefined);
  for (const read of [numberOfKeyword, (/** @type {unknown} */ bound) => (typeof bound === 'bigint' ? bound : undefined)]) {
    const pairs = holders.map((place) => getInclusiveExclusiveBounds(read, place[inclusive], place[exclusive]));
    const [inclusiveBound, exclusiveBound] = [0, 1].map((side) => tightest(pairs.map((pair) => pair[side])));
    if (inclusiveBound === undefined && exclusiveBound === undefined) continue;
    delete merged[inclusive];
    delete merged[exclusive];
    if (inclusiveBound !== undefined) merged[inclusive] = inclusiveBound;
    if (exclusiveBound !== undefined) merged[exclusive] = exclusiveBound;
    return;
  }
}

/** The counts a control can use the tightest of: the greatest minimum, the least maximum. */
const FOLDED_COUNTS = /** @type {const} */ ([
  ['minLength', Math.max], ['maxLength', Math.min], ['minItems', Math.max], ['maxItems', Math.min],
  ['minProperties', Math.max], ['maxProperties', Math.min],
]);

/**
 * The type names every one of several `type` declarations takes, in the
 * first one's order: `integer` where one says `number` and another
 * `integer`. The first declaration's names where they share none (no
 * value passes such a schema; a control still has to be chosen).
 * @param {unknown[][]} declarations
 * @returns {unknown[]}
 */
function intersectTypes(declarations) {
  const shared = declarations.slice(1).reduce((names, others) => names.flatMap((name) => (
    others.includes(name) ? [name]
      : (name === 'number' && others.includes('integer')) || (name === 'integer' && others.includes('number')) ? ['integer'] : [])),
  declarations[0]);
  return shared.length > 0 ? shared : declarations[0];
}

/**
 * The items a place describes: the schemas of its leading positions and
 * the schema of every position after them, in either spelling
 * (`prefixItems` with `items`, or an `items` array with `additionalItems`).
 * @param {Record<string, any>} place
 * @returns {{ prefix: unknown[], rest: unknown } | null} `null` for a place that describes none
 */
function itemsOf(place) {
  if (Array.isArray(place.prefixItems)) return { prefix: place.prefixItems, rest: Array.isArray(place.items) ? undefined : place.items };
  if (Array.isArray(place.items)) return { prefix: place.items, rest: place.additionalItems };
  return place.items === undefined ? null : { prefix: [], rest: place.items };
}

/**
 * The one schema a control is drawn from, for the several places that
 * assert a value: what a control can show, where the field check judges
 * each place on its own (`field.asserted`).
 *
 * - An annotation, and a keyword a control holds one of (`pattern`,
 *   `format`, `multipleOf`, `const`), is the first place's that holds it,
 *   the node's own before its `$ref`'s and its branches'.
 * - A bound or a count two places hold is the tightest; `uniqueItems`
 *   holds where one place asks it; `enum` is the options every place
 *   lists; `type` the names every place takes.
 * - `required` is every place's; a member, an item or a tuple slot two
 *   places describe is the `allOf` of them, so the field built from it
 *   judges each.
 * @param {Array<Record<string, any>>} places - At least two
 * @returns {Record<string, any>}
 */
function foldPlaces(places) {
  /** @type {Record<string, any>} */
  const merged = {};
  for (const place of places) {
    for (const key of Object.keys(place)) {
      if (!leadsOn(key) && merged[key] === undefined) merged[key] = place[key];
    }
  }

  // members: a place's before those of the places read before it, as the form has always listed them
  /** @type {Map<string, unknown[]>} */
  let members = new Map();
  for (const place of places) {
    if (!isJsonObject(place.properties)) continue;
    const before = members;
    members = new Map(Object.keys(place.properties).map((name) => [name, []]));
    for (const [name, schemas] of before) members.set(name, schemas);
    for (const name of Object.keys(place.properties)) /** @type {unknown[]} */ (members.get(name)).push(place.properties[name]);
  }
  if (members.size > 0) merged.properties = Object.fromEntries([...members].map(([name, schemas]) => [name, allOfThem(schemas)]));
  const required = places.filter((place) => Array.isArray(place.required)).flatMap((place) => place.required);
  if (required.length > 0) merged.required = [...new Set(required)];

  // items: each position is given the schema of every place that describes it
  const described = places.map(itemsOf).filter((items) => items !== null);
  if (described.length > 1) {
    const slots = Math.max(...described.map((items) => items.prefix.length));
    const at = (/** @type {number} */ position) => described
      .map((items) => (position < items.prefix.length ? items.prefix[position] : items.rest)).filter((schema) => schema !== undefined);
    delete merged.items;
    delete merged.additionalItems;
    delete merged.prefixItems;
    if (slots > 0) merged.prefixItems = Array.from({ length: slots }, (_, position) => allOfThem(at(position)));
    const rest = at(slots);
    if (rest.length > 0) merged.items = rest.includes(false) ? false : allOfThem(rest);
  }

  foldBounds(places, 'minimum', 'exclusiveMinimum', merged);
  foldBounds(places, 'maximum', 'exclusiveMaximum', merged);
  for (const [keyword, tighter] of FOLDED_COUNTS) {
    const counts = places.map((place) => countOfKeyword(place[keyword])).filter((count) => count !== undefined);
    if (counts.length > 1) merged[keyword] = tighter(...counts);
  }
  if (places.some((place) => place.uniqueItems === true)) merged.uniqueItems = true;
  const enums = places.filter((place) => Array.isArray(place.enum)).map((place) => place.enum);
  if (enums.length > 1) merged.enum = enums[0].filter((option) => enums.every((list) => list.some((other) => equalsDeep(other, option))));
  const types = places.map((place) => declaredTypes(place.type)).filter((names) => names !== null && names.length > 0);
  if (types.length > 1) {
    const shared = intersectTypes(/** @type {unknown[][]} */ (types));
    merged.type = shared.length === 1 ? shared[0] : shared;
  }
  return merged;
}

/**
 * The effective schema a control is drawn from: local `$ref`s followed
 * and `allOf` branches folded into the node (see {@link foldPlaces}). A
 * schema with neither is itself. The field check does not read it for
 * its answers: it judges each place that asserts on its own.
 * @param {object|boolean} schema
 * @param {object} rootSchema
 * @param {number} depth
 * @returns {object|boolean}
 */
export function resolveSchema(schema, rootSchema, depth = 0) {
  if (!isJsonObject(schema)) return schema;
  const places = assertingPlaces(schema, rootSchema, depth).filter((place) => place !== false);
  return places.length < 2 ? schema : foldPlaces(/** @type {Array<Record<string, any>>} */ (places));
}

/**
 * The `oneOf: [{const, title}, ...]` idiom: every branch an object with a
 * `const`. Returns the branches, or null when the idiom does not apply.
 * @param {object} schema
 * @returns {Array<{const: any, title?: string}>|null}
 */
function getOneOfConstBranches(schema) {
  if (!Array.isArray(schema.oneOf) || schema.oneOf.length === 0) return null;
  for (const branch of schema.oneOf) {
    if (!isJsonObject(branch) || branch.const === undefined) return null;
  }
  return schema.oneOf;
}

/**
 * The type names a schema's `type` declares, as the validator reads the
 * keyword: one name, or the names of a list or of a `Set` (a `null`
 * member is the name `'null'`); `null` when it declares none.
 * @param {unknown} type - The `type` keyword's value
 * @returns {unknown[] | null}
 */
export function declaredTypes(type) {
  if (typeof type === 'string') return [type];
  const names = Array.isArray(type) ? type : type instanceof Set ? [...type] : null;
  return names === null ? null : names.map((name) => (name === null ? 'null' : name));
}

/**
 * Whether one place of a schema admits `null` — what layer 1 reads so an
 * explicit `null` is judged as the validator judges it: a type that lists
 * `null` (an `enum` or `const` beside it must admit `null` too), OpenAPI's
 * `nullable: true` (which the validator honours), an `anyOf`/`oneOf` with
 * a branch that admits it, or a place with none of these: without a
 * `type`, the keywords a form reads (`minLength`, `maximum`,
 * `properties`, …) judge only values of their own type and let `null`
 * through, unless `nullable: false` stands there, which refuses it.
 * @param {Record<string, any> | false} place
 * @param {object} rootSchema
 * @param {number} depth
 * @returns {boolean}
 */
function placeAdmitsNull(place, rootSchema, depth) {
  if (place === false) return false;
  if (Array.isArray(place.enum) && !place.enum.includes(null)) return false;
  if (Object.hasOwn(place, 'const') && place.const !== null) return false;
  if (place.nullable === true) return true;
  const types = declaredTypes(place.type);
  if (types !== null) return types.includes('null');
  // without a `type`, OpenAPI's `nullable: false` refuses null, as to the validator
  if (place.nullable === false) return false;
  if (Array.isArray(place.enum) || Object.hasOwn(place, 'const')) return true;
  let union = false;
  for (const key of ['anyOf', 'oneOf']) {
    const branches = place[key];
    if (!Array.isArray(branches)) continue;
    if (branches.some((branch) => admitsNull(branch, rootSchema, depth + 1))) return true;
    union = true;
  }
  return !union;
}

/**
 * Whether a schema admits `null`: every place of it that asserts does
 * (the node, the schema its `$ref` names, each `allOf` branch).
 * @param {unknown} schema
 * @param {object} rootSchema
 * @param {number} depth
 * @returns {boolean}
 */
function admitsNull(schema, rootSchema, depth) {
  return depth <= DEFAULT_MAX_DEPTH
    && assertingPlaces(schema, rootSchema, depth).every((place) => placeAdmitsNull(place, rootSchema, depth));
}

/** The keywords the field check judges, in the order a record lists them. */
const ASSERTED_KEYWORDS = ['type', 'nullable', 'const', 'enum', ...STRING_CONSTRAINTS, ...NUMERIC_CONSTRAINTS, ...ARRAY_CONSTRAINTS, ...OBJECT_CONSTRAINTS];

/**
 * What one place of a schema asserts, as the field check judges it: the
 * keywords layer 1 implements, as the place writes them, and the options
 * of the `oneOf` const/title idiom as an `enum`. `null` for a place that
 * holds none (and for `false`, which names no keyword).
 * @param {Record<string, any> | false} place
 * @returns {Record<string, any> | null}
 */
export function assertionsOf(place) {
  if (place === false) return null;
  /** @type {Record<string, any>} */
  const asserted = {};
  for (const keyword of ASSERTED_KEYWORDS) {
    if (place[keyword] !== undefined) asserted[keyword] = place[keyword];
  }
  if (!Array.isArray(asserted.enum)) {
    delete asserted.enum;
    const options = getOneOfConstBranches(place);
    if (options !== null) asserted.enum = options.map((branch) => branch.const);
  }
  return Object.keys(asserted).length > 0 ? asserted : null;
}

/**
 * The kinds a keyword can infer, each with the keywords that constrain
 * only values of its type (`TYPE_SCOPED_KEYWORDS` of `@jarenjs/core/schema`).
 * @type {ReadonlyArray<['string'|'number'|'array'|'object', readonly string[]]>}
 */
const INFERRED_KINDS = [
  ['string', TYPE_SCOPED_KEYWORDS.string],
  ['number', TYPE_SCOPED_KEYWORDS.number],
  ['array', TYPE_SCOPED_KEYWORDS.array],
  ['object', TYPE_SCOPED_KEYWORDS.object],
];

/** The object keywords that describe members, and the array keywords that describe items: what an object or array control is drawn from. */
const MEMBER_KEYWORDS = ['properties', 'patternProperties', 'additionalProperties'];
const ITEM_KEYWORDS = ['items', 'prefixItems'];

/**
 * The kind of a schema that declares no `type` a control exists for,
 * from its keywords. A kind chooses the control and nothing else.
 *
 * A schema that describes members (`properties`, `patternProperties`,
 * `additionalProperties`) is an object field, and one that describes
 * items (`items`, `prefixItems`) an array field, whatever stands beside
 * them: only that control makes the members or items fields of their
 * own.
 *
 * Any other schema is a number or a string field where its keywords
 * agree on that: every keyword that constrains values of one type alone
 * belongs to the same type. Two readings decide a keyword's type: a
 * `format` that names a number format (`int32`, `float`) is a number
 * keyword, and `required` is an object keyword as a list of names only.
 *
 * Everything else is `unknown`, the `json` control, which holds any
 * value: keywords of two types (`minLength` beside `minimum`), none, and
 * the array and object keywords that are left (`minItems`, `uniqueItems`,
 * `minProperties`, `required`, ...). Those describe no item and no member
 * a control could show, and an array field starts as `[]`, never absent,
 * which a `minItems` alone would refuse on an untouched form.
 * @param {Record<string, any>} schema
 * @returns {string}
 */
function inferFieldKind(schema) {
  const holds = (/** @type {string} */ keyword) => schema[keyword] !== undefined;
  if (MEMBER_KEYWORDS.some(holds)) return 'object';
  if (ITEM_KEYWORDS.some(holds)) return 'array';
  /** @type {string | null} */
  let kind = null;
  for (const [candidate, keywords] of INFERRED_KINDS) {
    for (const keyword of keywords) {
      if (!holds(keyword) || (keyword === 'required' && !Array.isArray(schema.required))) continue;
      const inferred = keyword === 'format' && isNumberFormat(schema.format) ? 'number' : candidate;
      if (kind !== null && kind !== inferred) return 'unknown';
      kind = inferred;
    }
  }
  return kind === 'number' || kind === 'string' ? kind : 'unknown';
}

/**
 * Derive the field kind from a resolved schema: what chooses the field's
 * control. A declared `type` gives it (the first name of a list or of a
 * `Set` that is not `null`); without one a control exists for, the
 * schema's keywords do (see {@link inferFieldKind}). The kind asserts
 * nothing: layer 1 judges a value by the schema's keywords, as the
 * validator does.
 * @param {object|boolean} schema
 * @returns {string}
 */
export function getFieldKind(schema) {
  if (schema == null || typeof schema !== 'object') return 'unknown';
  if (schema.const !== undefined) return 'const';
  if (Array.isArray(schema.enum)) return 'enum';
  // The oneOf const/title idiom is an enum with per-option labels
  if (getOneOfConstBranches(schema) !== null) return 'enum';
  // a nullable union is its non-null branch, exactly as the type array is
  const split = splitNullable(schema);
  if (split !== null && !Array.isArray(schema.type)) return getFieldKind(split.schema);

  // Pick the first non-null type for rendering purposes
  const types = declaredTypes(schema.type);
  switch (types === null ? undefined : (types.find((t) => t !== 'null') ?? types[0])) {
    case 'string': return 'string';
    case 'number': return 'number';
    case 'integer': return 'integer';
    case 'boolean': return 'boolean';
    case 'object': return 'object';
    case 'array': return 'array';
    default: break;
  }

  return inferFieldKind(schema);
}

/**
 * Derive the suggested UI control for a field.
 * @param {string} kind
 * @param {object} schema
 * @returns {string}
 */
function getControl(kind, schema) {
  switch (kind) {
    case 'const': return 'const';
    case 'enum': return 'select';
    case 'boolean': return 'checkbox';
    case 'number':
    case 'integer': return 'number';
    case 'object': return 'object';
    case 'array': return 'array';
    case 'string': {
      const info = getFormatInfo(schema.format);
      if (info) return info.control;
      if (schema.contentEncoding === 'base64' || schema.contentMediaType) return 'textarea';
      const max = schema.maxLength;
      if (max !== undefined && max > 120) return 'textarea';
      return 'text';
    }
    default: return 'json';
  }
}

/** The form-relevant constraint keywords: the shared groups plus the
 * date bounds — constraints like any other; without them a date control
 * has no min/max to offer and the user only learns the range by
 * submitting. */
const FORM_CONSTRAINTS = [
  ...STRING_CONSTRAINTS,
  ...NUMERIC_CONSTRAINTS,
  'formatMinimum', 'formatMaximum', 'formatExclusiveMinimum', 'formatExclusiveMaximum',
  ...ARRAY_CONSTRAINTS,
  ...OBJECT_CONSTRAINTS,
];

/**
 * Extract the constraint set the UI and the preemptive field validation use.
 * @param {object} schema
 * @returns {object}
 */
function getConstraints(schema) {
  const c = {};
  for (const key of FORM_CONSTRAINTS) {
    if (schema[key] !== undefined) c[key] = schema[key];
  }
  return c;
}

/**
 * Build a single field descriptor.
 * @param {object|boolean} rawSchema - The (possibly unresolved) subschema
 * @param {object} rootSchema - The root schema document for $ref resolution
 * @param {string} pointer - JSON pointer into the data
 * @param {string} key - Property name or '-' for an item template
 * @param {boolean} required
 * @param {number} depth
 * @param {TranslateHook} t - The static-text translation hook
 * @param {LengthUnit} lengthUnit - What `minLength`/`maxLength` count, on this field and below it
 * @returns {FormField}
 */
function buildField(rawSchema, rootSchema, pointer, key, required, depth, t, lengthUnit) {
  const places = assertingPlaces(rawSchema, rootSchema, depth);
  const resolved = resolveSchema(rawSchema, rootSchema, depth);
  // One meaning for the two nullable spellings (@jarenjs/core/schema): an
  // anyOf/oneOf of one branch and null renders as its branch — with the
  // node's own annotations over it — just as `type: [T, 'null']` renders
  // as T. The validator still judges the whole schema. The oneOf
  // const/title idiom is not a nullable spelling: its null branch is one
  // of the options (a "none" choice), so it stays an enum.
  const split = isJsonObject(resolved) && getOneOfConstBranches(resolved) !== null ? null : splitNullable(resolved);
  const nullable = admitsNull(rawSchema, rootSchema, depth);
  const branch = split !== null && !Array.isArray(resolved.type) ? split.schema : null;
  const schema = branch !== null ? resolveSchema(branch, rootSchema, depth + 1) : resolved;
  // what the field check judges: each place that asserts, on its own
  const asserted = /** @type {Array<Record<string, any>>} */ ((branch !== null ? assertingPlaces(branch, rootSchema, depth + 1) : places)
    .map(assertionsOf).filter((record) => record !== null));
  const effective = (schema != null && typeof schema === 'object') ? schema : {};
  const kind = getFieldKind(schema);
  const control = getControl(kind, effective);
  const formatInfo = getFormatInfo(effective.format);

  // The message-id base for static text: the x-msgid annotation, or the
  // data pointer (the root field's base is the empty pointer '').
  const base = typeof effective['x-msgid'] === 'string' ? effective['x-msgid'] : pointer;

  const oneOfBranches = kind === 'enum' && !Array.isArray(effective.enum)
    ? getOneOfConstBranches(effective) : null;
  const enumValues = kind === 'enum'
    ? (Array.isArray(effective.enum)
      ? effective.enum
      : oneOfBranches.map((branch) => branch.const))
    : null;
  const enumLabels = enumValues !== null
    ? enumValues.map((value, i) => t(
      `${base}#enum/${String(value)}`,
      oneOfBranches !== null && typeof oneOfBranches[i].title === 'string'
        ? oneOfBranches[i].title
        : String(value)))
    : null;

  const placeholder = effective.examples?.[0] !== undefined
    ? String(effective.examples[0])
    : formatInfo?.placeholder;

  /** @type {FormField} */
  const field = {
    pointer,
    key,
    msgid: base,
    label: t(`${base}#label`, effective.title || humanizeKey(key)),
    description: t(`${base}#description`, effective.description),
    schema: effective,
    kind,
    control,
    required,
    nullable,
    readOnly: effective.readOnly === true,
    enumValues,
    enumLabels,
    constValue: kind === 'const' ? effective.const : undefined,
    defaultValue: effective.default,
    placeholder: t(`${base}#placeholder`, placeholder),
    preview: formatInfo?.preview ?? null,
    constraints: getConstraints(effective),
    asserted,
    lengthUnit,
    // The raw `x-form` annotation only - compiling its query documents is
    // rules.js territory, so model building stays query-engine-free.
    rules: isJsonObject(effective['x-form']) ? effective['x-form'] : null,
    children: null,
    item: null,
    tuple: null,
  };

  if (depth >= DEFAULT_MAX_DEPTH) return field;

  if (kind === 'object' && effective.properties) {
    const requiredSet = new Set(Array.isArray(effective.required) ? effective.required : []);
    field.children = Object.entries(effective.properties).map(([name, propSchema]) =>
      buildField(
        propSchema, rootSchema,
        `${pointer}/${encodeJSONPointerSegment(name)}`, name,
        requiredSet.has(name), depth + 1, t, lengthUnit));
  }

  if (kind === 'array') {
    const prefix = Array.isArray(effective.prefixItems)
      ? effective.prefixItems
      : (Array.isArray(effective.items) ? effective.items : null);
    if (prefix) {
      field.tuple = prefix.map((itemSchema, i) =>
        buildField(itemSchema, rootSchema, `${pointer}/${i}`, String(i), false, depth + 1, t, lengthUnit));
      const rest = Array.isArray(effective.items) ? effective.additionalItems : effective.items;
      if (rest != null && typeof rest === 'object') {
        field.item = buildField(rest, rootSchema, `${pointer}/-`, '-', false, depth + 1, t, lengthUnit);
      }
    }
    else if (effective.items != null && typeof effective.items === 'object') {
      field.item = buildField(effective.items, rootSchema, `${pointer}/-`, '-', false, depth + 1, t, lengthUnit);
    }
    else {
      field.item = buildField({}, rootSchema, `${pointer}/-`, '-', false, depth + 1, t, lengthUnit);
    }
  }

  return field;
}

/**
 * Encode a property name as an RFC 6901 reference token (`~` -> `~0`,
 * `/` -> `~1`), the write-side inverse of the shared parse. An alias of
 * `encodeJSONPointerSegment` from `@jarenjs/json/pointer`, kept for
 * compatibility.
 * @param {string} key
 * @returns {string}
 */
export function escapePointerKey(key) {
  return encodeJSONPointerSegment(key);
}

/**
 * The unit a model's fields count `minLength` and `maxLength` in, from
 * the two options a validator takes for it: `lengthUnit` when set, else
 * `useGrapheme` read for truth (unset or true is `'grapheme'`, false is
 * `'utf16'`), so the options a host hands its validator build a form
 * that counts as that validator does.
 * @param {{ lengthUnit?: unknown, useGrapheme?: unknown } | null | undefined} options
 * @returns {LengthUnit}
 * @throws {TypeError} When `lengthUnit` names no unit: read on, a misspelt unit would count graphemes
 */
function lengthUnitOf(options) {
  const unit = options?.lengthUnit;
  if (unit === 'grapheme' || unit === 'codepoint' || unit === 'utf16') return unit;
  if (unit != null)
    throw new TypeError(`buildFormModel: lengthUnit must be 'grapheme', 'codepoint' or 'utf16', got ${formatMessageValue(unit)}`);
  return (options?.useGrapheme ?? true) ? 'grapheme' : 'utf16';
}

/**
 * Build the form model for a JSON schema.
 *
 * Static text (labels, descriptions, placeholders, enum option labels) is
 * resolved ONCE here, at model-build time - the right place for
 * translation. The optional `t` hook receives role-qualified message ids
 * built from each field's base (`x-msgid` annotation or data pointer):
 * `<base>#label`, `<base>#description`, `<base>#placeholder`,
 * `<base>#enum/<String(value)>` - and the schema-derived fallback text.
 *
 * The length unit is the validator's: hand `buildFormModel` the
 * `lengthUnit` (or `useGrapheme`) the host's `JarenValidator` was made
 * with, and every field's `minLength`/`maxLength` count in it.
 *
 * @param {object|boolean} schema - The root JSON schema
 * @param {object} [options]
 * @param {TranslateHook} [options.t] - Static-text translation hook, default the zero-cost identity `(id, fb) => fb`
 * @param {LengthUnit} [options.lengthUnit] - What `minLength`/`maxLength` count on every field: `'grapheme'` clusters (the default), `'codepoint'` code points or `'utf16'` code units, as the validator's option of that name. Another value is a TypeError
 * @param {boolean} [options.useGrapheme] - The validator's older spelling: `false` counts UTF-16 code units. `lengthUnit` wins when both are given
 * @returns {FormField} The root field descriptor (kind 'object' for object schemas)
 * @throws {TypeError} When `options.lengthUnit` names no unit
 * @example
 * const model = buildFormModel({
 *   type: 'object',
 *   properties: { email: { type: 'string', format: 'email' } },
 *   required: ['email'],
 * });
 * model.children[0].control; // 'email'
 * @example
 * // static-text i18n
 * const nlModel = buildFormModel(schema, {
 *   t: (msgid, fallback) => staticTextNl[msgid] ?? fallback,
 * });
 * @example
 * // a host that validates in code points gets a form that counts code points
 * const options = { lengthUnit: 'codepoint' };
 * const validate = new JarenValidator(options).compile(schema);
 * const model = buildFormModel(schema, options);
 */
export function buildFormModel(schema, options = undefined) {
  const rootSchema = (schema != null && typeof schema === 'object') ? schema : {};
  const t = options != null && typeof options.t === 'function' ? options.t : identityT;
  return buildField(schema, rootSchema, '', '', false, 0, t, lengthUnitOf(options));
}
