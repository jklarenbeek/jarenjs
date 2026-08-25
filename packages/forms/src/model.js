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
import {
  NUMERIC_CONSTRAINTS, STRING_CONSTRAINTS,
  ARRAY_CONSTRAINTS, OBJECT_CONSTRAINTS,
} from '@jarenjs/core/schema';

import { encodeJSONPointerSegment } from '@jarenjs/json/pointer';
import {
  collectSameDocumentAnchors,
  resolveSameDocumentRef,
} from '@jarenjs/validate/normalize';

import {
  getFormatInfo,
} from './formats.js';

const DEFAULT_MAX_DEPTH = 24;

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
 * @property {boolean} readOnly
 * @property {Array<any>|null} enumValues - Options for a select control
 * @property {Array<string>|null} enumLabels - Display labels parallel to enumValues (oneOf const/title idiom, through the `t` hook)
 * @property {any} constValue - Fixed value when the schema is a const
 * @property {any} defaultValue
 * @property {string|undefined} placeholder
 * @property {import('./formats.js').FormatPreview|null} preview - The format's preview hint (formats.js), for a host with a renderer for it; null otherwise
 * @property {object} constraints - minLength/maxLength/pattern/minimum/... extracted for the UI
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
 * enforce. (The previous private re-implementation resolved only
 * `#/pointer`, silently rendering `$ref: "#"` and `#anchor` fields as
 * `unknown`.) External refs stay unresolvable by design.
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
  if (schema == null || typeof schema !== 'object' || Array.isArray(schema)) return schema;

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
    if (branch == null || typeof branch !== 'object' || Array.isArray(branch)
      || branch.const === undefined) return null;
  }
  return schema.oneOf;
}

/**
 * Derive the field kind from a resolved schema.
 * @param {object|boolean} schema
 * @returns {string}
 */
export function getFieldKind(schema) {
  if (schema == null || typeof schema !== 'object') return 'unknown';
  if (schema.const !== undefined) return 'const';
  if (Array.isArray(schema.enum)) return 'enum';
  // The oneOf const/title idiom is an enum with per-option labels
  if (getOneOfConstBranches(schema) !== null) return 'enum';

  let type = schema.type;
  if (Array.isArray(type)) {
    // Pick the first non-null type for rendering purposes
    type = type.find((t) => t !== 'null') ?? type[0];
  }
  switch (type) {
    case 'string': return 'string';
    case 'number': return 'number';
    case 'integer': return 'integer';
    case 'boolean': return 'boolean';
    case 'object': return 'object';
    case 'array': return 'array';
    default: break;
  }

  // Infer from structural keywords when type is absent
  if (schema.properties || schema.patternProperties || schema.additionalProperties !== undefined) return 'object';
  if (schema.items !== undefined || schema.prefixItems !== undefined) return 'array';
  if (schema.minLength !== undefined || schema.maxLength !== undefined || schema.pattern !== undefined || schema.format !== undefined) return 'string';
  if (schema.minimum !== undefined || schema.maximum !== undefined || schema.multipleOf !== undefined) return 'number';
  return 'unknown';
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

/**
 * Extract the constraint set the UI and the preemptive field validation use.
 * @param {object} schema
 * @returns {object}
 */
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
 * @returns {FormField}
 */
function buildField(rawSchema, rootSchema, pointer, key, required, depth, t) {
  const schema = resolveSchema(rawSchema, rootSchema, depth);
  const effective = (schema != null && typeof schema === 'object') ? schema : {};
  const kind = getFieldKind(schema);
  const control = getControl(kind, effective);
  const formatInfo = getFormatInfo(effective.format);

  // The message-id base for static text: the x-msgid annotation, or the
  // data pointer (the root field's base is the empty pointer '').
  const base = typeof effective['x-msgid'] === 'string' ? effective['x-msgid'] : pointer;

  const oneOfBranches = kind === 'enum' ? getOneOfConstBranches(effective) : null;
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
    readOnly: effective.readOnly === true,
    enumValues,
    enumLabels,
    constValue: kind === 'const' ? effective.const : undefined,
    defaultValue: effective.default,
    placeholder: t(`${base}#placeholder`, placeholder),
    preview: formatInfo?.preview ?? null,
    constraints: getConstraints(effective),
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
        `${pointer}/${escapePointerKey(name)}`, name,
        requiredSet.has(name), depth + 1, t));
  }

  if (kind === 'array') {
    const prefix = Array.isArray(effective.prefixItems)
      ? effective.prefixItems
      : (Array.isArray(effective.items) ? effective.items : null);
    if (prefix) {
      field.tuple = prefix.map((itemSchema, i) =>
        buildField(itemSchema, rootSchema, `${pointer}/${i}`, String(i), false, depth + 1, t));
      const rest = Array.isArray(effective.items) ? effective.additionalItems : effective.items;
      if (rest != null && typeof rest === 'object') {
        field.item = buildField(rest, rootSchema, `${pointer}/-`, '-', false, depth + 1, t);
      }
    }
    else if (effective.items != null && typeof effective.items === 'object') {
      field.item = buildField(effective.items, rootSchema, `${pointer}/-`, '-', false, depth + 1, t);
    }
    else {
      field.item = buildField({}, rootSchema, `${pointer}/-`, '-', false, depth + 1, t);
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
 * Build the form model for a JSON schema.
 *
 * Static text (labels, descriptions, placeholders, enum option labels) is
 * resolved ONCE here, at model-build time - the right place for
 * translation. The optional `t` hook receives role-qualified message ids
 * built from each field's base (`x-msgid` annotation or data pointer):
 * `<base>#label`, `<base>#description`, `<base>#placeholder`,
 * `<base>#enum/<String(value)>` - and the schema-derived fallback text.
 *
 * @param {object|boolean} schema - The root JSON schema
 * @param {object} [options]
 * @param {TranslateHook} [options.t] - Static-text translation hook, default the zero-cost identity `(id, fb) => fb`
 * @returns {FormField} The root field descriptor (kind 'object' for object schemas)
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
 */
export function buildFormModel(schema, options = undefined) {
  const rootSchema = (schema != null && typeof schema === 'object') ? schema : {};
  const t = options != null && typeof options.t === 'function' ? options.t : identityT;
  return buildField(schema, rootSchema, '', '', false, 0, t);
}
