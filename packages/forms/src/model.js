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

import { isJsonObject } from '@jarenjs/core/object';
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
 * @property {object} constraints - minLength/maxLength/pattern/minimum/... extracted for the UI
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

/**
 * Resolve local $refs and shallowly merge allOf branches into a single
 * effective schema object for form purposes.
 * @param {object|boolean} schema
 * @param {object} rootSchema
 * @param {number} depth
 * @returns {object|boolean}
 */
export function resolveSchema(schema, rootSchema, depth = 0) {
  if (depth > DEFAULT_MAX_DEPTH) return schema;
  if (!isJsonObject(schema)) return schema;

  let resolved = schema;

  if (typeof schema.$ref === 'string') {
    const target = resolveLocalRef(schema.$ref, rootSchema);
    if (target != null && typeof target === 'object') {
      const deref = resolveSchema(target, rootSchema, depth + 1);
      // 2019-09+: siblings apply together with the referenced schema
      const { $ref: _$ref, ...siblings } = schema;
      resolved = (deref && typeof deref === 'object')
        ? { ...deref, ...siblings }
        : deref;
    }
  }

  if (resolved && typeof resolved === 'object' && Array.isArray(resolved.allOf)) {
    const merged = { ...resolved };
    delete merged.allOf;
    const requiredSets = merged.required ? [merged.required] : [];
    for (const branch of resolved.allOf) {
      const sub = resolveSchema(branch, rootSchema, depth + 1);
      if (sub == null || typeof sub !== 'object') continue;
      if (sub.properties) {
        merged.properties = { ...sub.properties, ...(merged.properties || {}) };
      }
      if (Array.isArray(sub.required)) requiredSets.push(sub.required);
      for (const key of Object.keys(sub)) {
        if (key === 'properties' || key === 'required' || key === 'allOf') continue;
        if (merged[key] === undefined) merged[key] = sub[key];
      }
    }
    if (requiredSets.length > 0) {
      merged.required = [...new Set(requiredSets.flat())];
    }
    resolved = merged;
  }

  return resolved;
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
 * Whether a resolved schema admits `null` — what layer 1 reads so an
 * explicit `null` is judged as the validator judges it: a type that lists
 * `null` (an `enum` or `const` beside it must admit `null` too), OpenAPI's
 * `nullable: true` (which the validator honours), an `anyOf`/`oneOf` with
 * a branch that admits it, or a schema with none of these: without a
 * `type`, the keywords a form reads (`minLength`, `maximum`,
 * `properties`, …) judge only values of their own type and let `null`
 * through, unless `nullable: false` stands there, which refuses it.
 * @param {unknown} schema
 * @param {object} rootSchema
 * @param {number} depth
 * @returns {boolean}
 */
function admitsNull(schema, rootSchema, depth) {
  if (!isJsonObject(schema) || depth > DEFAULT_MAX_DEPTH) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(null)) return false;
  if (Object.hasOwn(schema, 'const') && schema.const !== null) return false;
  if (schema.nullable === true) return true;
  const types = declaredTypes(schema.type);
  if (types !== null) return types.includes('null');
  // without a `type`, OpenAPI's `nullable: false` refuses null, as to the validator
  if (schema.nullable === false) return false;
  if (Array.isArray(schema.enum) || Object.hasOwn(schema, 'const')) return true;
  let union = false;
  for (const key of ['anyOf', 'oneOf']) {
    const branches = schema[key];
    if (!Array.isArray(branches)) continue;
    if (branches.some((branch) => admitsNull(resolveSchema(branch, rootSchema, depth + 1), rootSchema, depth + 1))) return true;
    union = true;
  }
  return !union;
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
  const resolved = resolveSchema(rawSchema, rootSchema, depth);
  // One meaning for the two nullable spellings (@jarenjs/core/schema): an
  // anyOf/oneOf of one branch and null renders as its branch — with the
  // node's own annotations over it — just as `type: [T, 'null']` renders
  // as T. The validator still judges the whole schema. The oneOf
  // const/title idiom is not a nullable spelling: its null branch is one
  // of the options (a "none" choice), so it stays an enum.
  const split = isJsonObject(resolved) && getOneOfConstBranches(resolved) !== null ? null : splitNullable(resolved);
  const nullable = admitsNull(resolved, rootSchema, depth);
  const schema = split !== null && !Array.isArray(resolved.type)
    ? resolveSchema(split.schema, rootSchema, depth + 1)
    : resolved;
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
