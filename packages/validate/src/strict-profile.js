//@ts-check
/**
 * @file Strict structured-output profiles: the schema a provider's strict
 * mode accepts, derived from any schema whose answers it can carry, with
 * the two maps between the original's instances and the profile's.
 *
 * A strict mode constrains decoding to a small JSON Schema subset: one
 * self-contained document (`$defs` and same-document `$ref`s), every
 * object closed (`additionalProperties: false`) with every declared
 * member `required`, `anyOf` but no `oneOf`, and a short list of value
 * keywords. {@link deriveStrictProfile} builds that document:
 *
 * - every reference the schema uses — into itself or into the documents
 *   passed as `references` — is bundled under the profile's `$defs`;
 * - every object is closed, and every optional member becomes required
 *   with its type widened to also admit `null`. A member whose original
 *   schema already admits `null` is left as it is: the original's own
 *   validator answers `null` against the member's schema when the profile
 *   is derived, and only a member it refuses `null` for is widened and
 *   recorded as a placeholder;
 * - every keyword the profile does not carry is restated in the node's
 *   `description`, where the model still reads it ({@link relaxSchema}'s
 *   rule), and `oneOf` becomes `anyOf`;
 * - a root that is not an object is wrapped as the one member `value`.
 *
 * Everything the profile drops is a relaxation, so the ORIGINAL schema
 * stays the authority: validate what `fromProfile` returns with it. The
 * two tightenings are closing and requiring; requiring is undone by
 * `fromProfile` (a placeholder `null` becomes an absent member again) and
 * closing narrows only which undeclared members a model can write.
 * Where closing or bundling would make a profile that answers wrong — an
 * object whose member names are open, a member contributed by `allOf`, a
 * schema that accepts any value — the schema is refused with a coded
 * `SchemaCompileError` naming the place, never a silently wrong profile.
 */

import { equalsJson, isJsonObject, setObjectMember } from '@jarenjs/core/object';
import { SCHEMA_VALUE_KEYWORDS, SCHEMA_MAP_KEYWORDS, SCHEMA_LIST_KEYWORDS } from '@jarenjs/core/schema';
import { collectSameDocumentAnchors, resolveSameDocumentRef } from './normalize.js';
import { encodeJsonPointerPath } from './traverse.js';
import { SchemaCompileError } from './errors.js';
import { JarenValidator } from './index.js';

/** Keywords holding one schema (or, for `items`, a draft-07 tuple of them). */
const VALUE_POSITIONS = new Set(SCHEMA_VALUE_KEYWORDS.concat(['additionalItems']));
/** Keywords holding a list of schemas. */
const LIST_POSITIONS = new Set(SCHEMA_LIST_KEYWORDS);
/** Keywords holding a map of schemas (`dependencies` maps to a schema or a list of names). */
const MAP_POSITIONS = new Set(SCHEMA_MAP_KEYWORDS.concat(['$defs', 'definitions', 'dependencies']));

/** The base a schema without an absolute `$id` is read under. */
const SCHEMA_BASE = 'jaren-strict:/schema.json';
/** The identifier the profile is compiled under to read answers against it. */
const PROFILE_BASE = 'jaren-strict:/profile.json';
const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

/** Dropped without a note: identity, and the containers bundling replaces. */
const IDENTITY = new Set(['$schema', '$id', '$anchor', '$dynamicAnchor', '$vocabulary', '$comment', '$defs', 'definitions']);
/** The keywords a strict profile carries as written. */
const CARRIED = new Set(['type', 'enum', 'const', 'title', 'description']);
/** Keywords that apply members, items or branches beside their node. */
const COMPOSING = new Set(['allOf', 'if', 'then', 'else', 'dependentSchemas', 'propertyDependencies', 'prefixItems',
  'additionalItems', 'unevaluatedItems']);
/** Keywords that cannot sit beside a `$ref` or an `anyOf`, whose target or branches the profile carries alone. */
const STRUCTURAL = new Set(['type', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'unevaluatedProperties',
  'patternProperties', 'items', 'anyOf', 'oneOf', '$ref', ...COMPOSING]);
/** Keywords that only reach object instances. */
const OBJECT_KEYWORDS = new Set(['properties', 'required', 'additionalProperties', 'unevaluatedProperties', 'patternProperties']);

/**
 * @param {string} code
 * @param {string} reason
 * @param {string} at - Where, as `uri#pointer`
 */
function refusal(code, reason, at) {
  return new SchemaCompileError(code, reason, at.startsWith(`${SCHEMA_BASE}#`) ? at.slice(SCHEMA_BASE.length) : at);
}

/**
 * Append the notes of the keywords a node no longer carries to its
 * `description`, after any description it has.
 * @param {Record<string, unknown>} out
 * @param {string[]} notes
 */
function appendNotes(out, notes) {
  if (notes.length === 0) return;
  out.description = out.description === undefined ? notes.join(' ') : `${out.description} ${notes.join(' ')}`;
}

/**
 * Map one keyword's value through `child` at every schema position it
 * holds; any other keyword's value (data, names, unknown keywords) is
 * returned as written.
 * @param {string} key
 * @param {unknown} value
 * @param {string} at - The node's location
 * @param {(node: unknown, at: string) => unknown} child
 * @returns {unknown}
 */
function mapPosition(key, value, at, child) {
  if (LIST_POSITIONS.has(key) || VALUE_POSITIONS.has(key)) {
    if (Array.isArray(value)) return value.map((item, i) => child(item, encodeJsonPointerPath(at, key, i)));
    return VALUE_POSITIONS.has(key) ? child(value, encodeJsonPointerPath(at, key)) : value;
  }
  if (MAP_POSITIONS.has(key) && isJsonObject(value)) {
    const here = encodeJsonPointerPath(at, key);
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const name of Object.keys(value)) {
      setObjectMember(out, name, key === 'dependencies' && Array.isArray(value[name])
        ? value[name] : child(value[name], encodeJsonPointerPath(here, name)));
    }
    return out;
  }
  return value;
}

/**
 * Relax one schema node: every keyword in `relaxed` is removed and restated
 * by `note` in the node's `description`, `oneOf` becomes `anyOf`, and every
 * schema position is mapped through `child`.
 * @param {Record<string, unknown>} node
 * @param {string} at
 * @param {ReadonlySet<string>} relaxed
 * @param {(keyword: string, value: unknown) => string} note
 * @param {(node: unknown, at: string) => unknown} child
 * @returns {Record<string, unknown>}
 */
function relaxNode(node, at, relaxed, note, child) {
  /** @type {Record<string, unknown>} */
  const out = {};
  const notes = [];
  for (const key of Object.keys(node)) {
    if (relaxed.has(key)) {
      notes.push(note(key, node[key]));
      continue;
    }
    if (key === 'oneOf') {
      // exactly-one becomes at-least-one: strict subsets support anyOf
      // but not oneOf, and branches told apart by a relaxed keyword
      // would fail exactly-one on the relaxation itself
      if (Object.hasOwn(node, 'anyOf') && !relaxed.has('anyOf'))
        throw refusal('JK0105', 'a node carries both oneOf and anyOf, and a profile turns oneOf into anyOf; merge them into one anyOf', at);
      out.anyOf = mapPosition(key, node[key], at, child);
      continue;
    }
    setObjectMember(out, key, mapPosition(key, node[key], at, child));
  }
  appendNotes(out, notes);
  return out;
}

/**
 * Relax a schema for a structured-output subset that does not enforce some
 * keywords: each named keyword is removed wherever it sits in a schema
 * position and restated, by `note`, in that node's `description` (the
 * model still reads it), and every `oneOf` becomes `anyOf`. Values that are
 * data (`enum`, `const`, `default`, `examples`) and member names are never
 * rewritten. The result is a pure relaxation: every instance the schema
 * accepts, the relaxed schema accepts; validate answers with the original.
 * @param {object|boolean} schema - The schema to relax
 * @param {{ keywords: Iterable<string>, note: (keyword: string, value: unknown) => string }} options -
 *   `keywords`: the keywords to remove; `note`: the text that restates one
 * @returns {object|boolean} The relaxed schema; the input is not changed
 * @throws {SchemaCompileError} `JK0105` for a node with both `oneOf` and
 *   `anyOf`; `JK0107` for an argument it does not take
 */
export function relaxSchema(schema, options) {
  const keywords = options?.keywords;
  const note = options?.note;
  if (!isSchemaValue(schema) || keywords == null || typeof keywords[Symbol.iterator] !== 'function'
    || typeof keywords === 'string' || typeof note !== 'function')
    throw new SchemaCompileError('JK0107', 'relaxSchema takes a schema and { keywords, note }: an iterable of keyword names and a function');
  const relaxed = new Set(keywords);
  /** @type {(node: unknown, at: string) => unknown} */
  const walk = (node, at) => (isJsonObject(node) ? relaxNode(node, at, relaxed, note, walk) : node);
  return /** @type {object|boolean} */ (walk(schema, '#'));
}

/** @param {unknown} value */
function isSchemaValue(value) {
  return typeof value === 'boolean' || isJsonObject(value);
}

/**
 * The note a strict profile writes for a keyword it does not carry.
 * @param {string} keyword
 * @param {unknown} value
 */
function strictNote(keyword, value) {
  return value === null || typeof value !== 'object'
    ? `(strict profile: ${keyword} ${JSON.stringify(value)} is relaxed here; the original schema enforces it)`
    : `(strict profile: the ${keyword} keyword is relaxed here; the original schema enforces it)`;
}

/** @param {string} uri */
function withoutFragment(uri) {
  const hash = uri.indexOf('#');
  return hash === -1 ? uri : uri.slice(0, hash);
}

/**
 * @typedef {object} StrictProfile
 * @property {Record<string, unknown>} schema - The profile document to hand
 *   a provider's strict mode: closed objects, every member required,
 *   references bundled under `$defs`
 * @property {(value: unknown) => unknown} toProfile - Map an instance of the
 *   original schema to the profile's shape: an absent member is filled with
 *   `null`, a member the profile closed out is dropped, and a non-object
 *   root is wrapped as `{ value }` (for few-shot examples and tests)
 * @property {(answer: unknown) => unknown} fromProfile - Map an answer in the
 *   profile's shape back to the original's: a `null` placed for a member the
 *   original lets be absent, and whose schema refuses `null`, is removed, and
 *   a wrapped root is unwrapped. Validate the result with the original schema;
 *   an answer the profile does not accept is returned as far as it reads
 */

/**
 * Derive the strict structured-output profile of a schema: one closed,
 * self-contained document a provider's strict mode accepts, and the two maps
 * between the original's instances and the profile's. See the file comment
 * for the transform; the original schema remains the authority for what an
 * answer means.
 * @param {object|boolean} schema - The schema answers must satisfy (any draft from 07)
 * @param {{ references?: object[] }} [options] - `references`: the other
 *   schema documents its `$ref`s name, each with an absolute `$id`
 * @returns {StrictProfile}
 * @throws {SchemaCompileError} `JK0101` a schema that accepts any value,
 *   `JK0102` an object whose member names are open, `JK0103` a keyword that
 *   adds members, items or branches the profile cannot carry beside its node,
 *   `JK0104` a reference the profile cannot bundle, `JK0105` both `oneOf` and
 *   `anyOf` on one node, `JK0106` a required member the object does not
 *   declare, `JK0107` an argument it does not take, `JK0108` a schema that
 *   accepts no value; each names the place
 */
export function deriveStrictProfile(schema, options = {}) {
  const references = options?.references ?? [];
  if (!isSchemaValue(schema) || !Array.isArray(references))
    throw new SchemaCompileError('JK0107', 'deriveStrictProfile takes a schema and { references }: an array of schema documents');
  if (!isJsonObject(schema))
    throw schema ? refusal('JK0101', 'a schema that accepts any value has no strict form; give it a type', '#')
      : refusal('JK0108', 'a schema that accepts no value has no strict form', '#');

  /** Every schema node of the documents, by the resource and pointer it sits at. */
  const located = new Map();
  /** Resource documents by their absolute identifier. */
  const resources = new Map();
  /** @param {unknown} node @param {string} base @param {string} at */
  const index = (node, base, at) => {
    if (!isJsonObject(node) || located.has(node)) return;
    if (typeof node.$id === 'string' && at !== `${base}#`) {
      base = withoutFragment(new URL(node.$id, base).href);
      at = `${base}#`;
    }
    if (at === `${base}#`) resources.set(base, { node, anchors: collectSameDocumentAnchors(node) });
    located.set(node, at);
    for (const key of Object.keys(node)) mapPosition(key, node[key], at, (child, there) => index(child, base, there));
  };
  const rootBase = typeof schema.$id === 'string' ? withoutFragment(new URL(schema.$id, SCHEMA_BASE).href) : SCHEMA_BASE;
  index(schema, rootBase, `${rootBase}#`);
  for (const reference of references) {
    let base;
    try { base = isJsonObject(reference) && typeof reference.$id === 'string' ? withoutFragment(new URL(reference.$id).href) : undefined; }
    catch { base = undefined; }
    if (base === undefined)
      throw new SchemaCompileError('JK0107', 'deriveStrictProfile: every reference is a schema object with an absolute $id');
    index(reference, base, `${base}#`);
  }

  /** The original's own validator, asked whether a member's schema admits null. */
  let original;
  /** @param {string} at */
  const admitsNull = (at) => {
    if (original === undefined) {
      original = new JarenValidator();
      original.addSchema({ ...schema, $id: rootBase });
      for (const reference of references) original.addSchema(reference);
    }
    return original.compile({ $ref: at })(null) === true;
  };

  const wrapped = !(schema.type === 'object' && !Object.hasOwn(schema, '$ref') && !Object.hasOwn(schema, 'anyOf')
    && !Object.hasOwn(schema, 'oneOf'));
  /** @type {Map<object, string>} */
  const names = new Map();
  const used = new Set();
  /** @type {object[]} */
  const pending = [];

  /** @param {string} ref @param {string} base @param {string} at */
  const bundle = (ref, base, at) => {
    let url;
    try { url = new URL(ref, base); }
    catch { throw refusal('JK0104', `$ref '${ref}' is not a URI reference`, at); }
    const resource = resources.get(withoutFragment(url.href));
    if (resource === undefined)
      throw refusal('JK0104', `$ref '${ref}' names a document neither the schema nor its references hold; pass it in references`, at);
    const target = resolveSameDocumentRef(url.hash === '' ? '#' : url.hash, resource.node, resource.anchors);
    const where = target === undefined ? undefined : located.get(target);
    if (where === undefined) throw refusal('JK0104', `$ref '${ref}' resolves to no schema`, at);
    if (target === schema && !wrapped) return '#';
    let name = names.get(target);
    if (name === undefined) {
      const pointer = where.slice(where.indexOf('#') + 1).split('/');
      const last = pointer.length > 1 ? decodeURIComponent(pointer.at(-1)).replace(/~1/g, '/').replace(/~0/g, '~')
        : (withoutFragment(where).split('/').at(-1) ?? '').replace(/\.json$/, '');
      const stem = last.replace(/[^A-Za-z0-9_.-]/g, '_') || 'schema';
      name = stem;
      for (let n = 2; used.has(name); n++) name = `${stem}_${n}`;
      used.add(name);
      names.set(target, name);
      pending.push(target);
    }
    return `#/$defs/${name}`;
  };

  /** Profile object nodes → the members whose `null` stands for absence. */
  const placeholders = new WeakMap();
  /** The optional members, widened once every reference is bundled (so a
   * reference the profile cannot bundle is refused as such first). */
  const optional = [];

  /** @param {unknown} node @param {string} base @param {string} at @returns {any} */
  const strict = (node, base, at) => {
    if (node === true) throw refusal('JK0101', 'a schema that accepts any value has no strict form; give it a type', at);
    if (!isJsonObject(node)) throw refusal('JK0108', 'a schema that accepts no value has no strict form; remove it', at);
    // a node read where the index first met it carries that resource's base,
    // so a reference inside an embedded `$id` resolves against its own
    const first = located.get(node);
    if (first !== undefined) { at = first; base = withoutFragment(first); }
    for (const key of ['$dynamicRef', '$recursiveRef']) {
      if (Object.hasOwn(node, key)) throw refusal('JK0104', `a ${key} resolves by dynamic scope, which one bundled document cannot carry`, encodeJsonPointerPath(at, key));
    }
    const types = typeof node.type === 'string' ? [node.type] : Array.isArray(node.type) ? node.type : null;
    const enumerated = Object.hasOwn(node, 'enum') || Object.hasOwn(node, 'const');
    const objects = types?.includes('object') ?? false;
    const arrays = types?.includes('array') ?? false;
    // `allOf` of one branch is that branch, which generators write to give a
    // `$ref` siblings; it is carried as the one branch of an anyOf
    const single = Array.isArray(node.allOf) && node.allOf.length === 1;
    const union = Object.hasOwn(node, 'anyOf') || Object.hasOwn(node, 'oneOf') || single;
    const reference = Object.hasOwn(node, '$ref');
    // a typed or enumerated node is its own shape; otherwise a $ref or a union is
    const shaped = types !== null || enumerated;

    /** @type {Set<string>} */
    const relaxed = new Set();
    for (const key of Object.keys(node)) {
      if (IDENTITY.has(key) || CARRIED.has(key)) continue;
      if (shaped) {
        // a typed or enumerated node is its own shape: whatever else it says
        // only narrows it, so relaxing it is safe — except where it reaches
        // the members or the items of a shape this node closes
        if (objects && (COMPOSING.has(key) || key === 'anyOf' || key === 'oneOf' || key === '$ref'
          || (key === 'dependencies' && isJsonObject(node.dependencies) && Object.values(node.dependencies).some((value) => !Array.isArray(value)))))
          throw refusal('JK0103', `${key} beside an object type adds members a closed profile object cannot carry; move the members into the object (or into each branch)`, encodeJsonPointerPath(at, key));
        if (arrays && (key === 'prefixItems' || key === 'additionalItems' || key === 'unevaluatedItems' || (key === 'items' && Array.isArray(node.items))))
          throw refusal('JK0103', `${key} gives array positions their own schemas, which a strict profile cannot carry; use one items schema`, encodeJsonPointerPath(at, key));
        if ((objects && OBJECT_KEYWORDS.has(key)) || (arrays && key === 'items')) continue;
        relaxed.add(key);
        continue;
      }
      if (reference || union) {
        // a $ref or a union carries its target or branches alone: a sibling
        // that applies beside it is refused, an annotation is relaxed
        if (key === '$ref' || key === 'anyOf' || key === 'oneOf' || (key === 'allOf' && single)) {
          if ((reference && union) || (single && (Object.hasOwn(node, 'anyOf') || Object.hasOwn(node, 'oneOf'))))
            throw refusal('JK0103', `${key} beside another $ref, anyOf, oneOf or allOf applies both, which a strict profile cannot carry; move one into the other's branches`, encodeJsonPointerPath(at, key));
          continue;
        }
        if (STRUCTURAL.has(key) || key === 'dependencies')
          throw refusal('JK0103', `${key} beside a ${reference ? '$ref' : 'union'} applies with it, which a strict profile cannot carry; move it into the ${reference ? 'referenced schema' : 'branches'}`, encodeJsonPointerPath(at, key));
        relaxed.add(key);
        continue;
      }
    }
    const composed = Object.keys(node).find((key) => COMPOSING.has(key));
    if (!shaped && !reference && !union && composed !== undefined)
      throw refusal('JK0103', `${composed} composes schemas a strict profile cannot carry beside a node with no type; give the node a type, or write the composition out`, encodeJsonPointerPath(at, composed));
    if (!shaped && !reference && !union)
      throw refusal('JK0101', 'a schema with no type, enum, const, $ref or anyOf accepts any value, which a strict profile cannot carry; give it a type', at);
    if (objects) checkObject(node, at);
    if (arrays) {
      if (!Object.hasOwn(node, 'items') || node.items === true)
        throw refusal('JK0101', 'an array whose items accept any value has no strict form; give it an items schema', at);
      if (node.items === false)
        throw refusal('JK0108', 'an array whose items accept no value has no strict form; remove the array type', encodeJsonPointerPath(at, 'items'));
    }
    const kept = {};
    for (const key of Object.keys(node)) if (!IDENTITY.has(key)) setObjectMember(kept, key, node[key]);
    // closing replaces both; a schema-valued one was refused above
    if (objects) delete kept.unevaluatedProperties;
    if (single && !shaped && !reference) {
      kept.anyOf = kept.allOf;
      delete kept.allOf;
    }
    /** @type {(child: unknown, there: string) => unknown} */
    const child = (value, there) => (isJsonObject(value) ? strict(value, base, there) : value);
    const out = relaxNode(kept, at, relaxed, strictNote, child);

    if (!shaped && reference) out.$ref = bundle(/** @type {string} */ (node.$ref), base, at);
    if (Array.isArray(out.anyOf)) {
      out.anyOf.forEach((branch, i) => {
        if (typeof branch === 'boolean')
          throw (branch ? refusal('JK0101', 'a branch that accepts any value has no strict form; give it a type', encodeJsonPointerPath(at, 'anyOf', i))
            : refusal('JK0108', 'a branch that accepts no value has no strict form; remove it', encodeJsonPointerPath(at, 'anyOf', i)));
      });
    }
    if (objects) closeObject(node, out, at);
    return out;
  };

  /** Refuse an object whose members a closed profile object would read wrong. @param {any} node @param {string} at */
  const checkObject = (node, at) => {
    if (Object.hasOwn(node, 'patternProperties'))
      throw refusal('JK0102', 'patternProperties admits members by name pattern, which a closed profile object cannot carry; declare the members under properties, or use an array of { key, value } entries', encodeJsonPointerPath(at, 'patternProperties'));
    for (const key of ['additionalProperties', 'unevaluatedProperties']) {
      if (Object.hasOwn(node, key) && typeof node[key] !== 'boolean')
        throw refusal('JK0102', `${key} admits members of any name, which a closed profile object cannot carry; declare the members under properties, or use an array of { key, value } entries`, encodeJsonPointerPath(at, key));
    }
    const declared = isJsonObject(node.properties) ? node.properties : {};
    if (Object.keys(declared).length === 0 && node.additionalProperties !== false && node.unevaluatedProperties !== false)
      throw refusal('JK0102', 'an object that declares no properties admits members of any name, which a closed profile object cannot carry; declare its members under properties', at);
    const held = (/** @type {string} */ name) => Object.hasOwn(declared, name) && declared[name] !== false;
    for (const name of Array.isArray(node.required) ? node.required : []) {
      if (!held(name))
        throw refusal('JK0106', `required member '${name}' is not declared under properties, so a closed profile object could never hold it; declare it`, encodeJsonPointerPath(at, 'required'));
    }
    // a dependency fires only on a member the closed object holds, and then
    // requires members it must hold too
    for (const key of ['dependentRequired', 'dependencies']) {
      if (!isJsonObject(node[key])) continue;
      for (const [trigger, names] of Object.entries(node[key])) {
        const missing = held(trigger) && Array.isArray(names) ? names.find((name) => !held(name)) : undefined;
        if (missing !== undefined)
          throw refusal('JK0106', `${key} requires member '${missing}' beside '${trigger}', which is not declared under properties, so a closed profile object could never hold it; declare it`, encodeJsonPointerPath(at, key));
      }
    }
  };

  /** Close a profile object: every member required, optional ones widened to admit null. @param {any} node @param {any} out @param {string} at */
  const closeObject = (node, out, at) => {
    const declared = isJsonObject(node.properties) ? node.properties : {};
    const required = new Set(Array.isArray(node.required) ? node.required : []);
    /** @type {Record<string, unknown>} */
    const members = {};
    const where = encodeJsonPointerPath(at, 'properties');
    for (const name of Object.keys(declared)) {
      const member = declared[name];
      if (member === false) continue;
      if (member === true)
        throw refusal('JK0101', 'a member that accepts any value has no strict form; give it a type', encodeJsonPointerPath(where, name));
      setObjectMember(members, name, out.properties[name]);
      if (!required.has(name)) optional.push({ out, name, at: encodeJsonPointerPath(where, name) });
    }
    out.properties = members;
    out.required = Object.keys(members);
    out.additionalProperties = false;
  };

  const body = strict(schema, rootBase, `${rootBase}#`);
  /** @type {Record<string, unknown>} */
  const defs = {};
  while (pending.length > 0) {
    const target = /** @type {object} */ (pending.shift());
    const at = located.get(target);
    setObjectMember(defs, /** @type {string} */ (names.get(target)), strict(target, withoutFragment(at), at));
  }
  for (const { out, name, at } of optional) {
    if (admitsNull(at)) continue;
    out.properties[name] = widenNull(out.properties[name]);
    const absent = placeholders.get(out) ?? new Set();
    absent.add(name);
    placeholders.set(out, absent);
  }
  /** @type {Record<string, any>} */
  const profile = wrapped
    ? { type: 'object', properties: { value: body }, required: ['value'], additionalProperties: false }
    : body;
  if (Object.keys(defs).length > 0) profile.$defs = defs;
  return createMaps(profile, placeholders, wrapped);
}

/**
 * Widen a profiled member to also admit `null`.
 * @param {any} profiled
 * @returns {any}
 */
function widenNull(profiled) {
  const constant = Object.hasOwn(profiled, 'const');
  if (!constant && (typeof profiled.type === 'string' || Array.isArray(profiled.type))) {
    const types = [profiled.type].flat();
    if (!types.includes('null')) profiled.type = [...types, 'null'];
    if (Array.isArray(profiled.enum) && !profiled.enum.includes(null)) profiled.enum = [...profiled.enum, null];
    return profiled;
  }
  if (!constant && Array.isArray(profiled.enum)) {
    profiled.enum = [...profiled.enum, null];
    return profiled;
  }
  if (!constant && Array.isArray(profiled.anyOf) && !Object.hasOwn(profiled, '$ref')) {
    profiled.anyOf = [...profiled.anyOf, { type: 'null' }];
    return profiled;
  }
  return { anyOf: [profiled, { type: 'null' }] };
}

/**
 * The two instance maps over a finished profile.
 * @param {Record<string, any>} profile
 * @param {WeakMap<object, Set<string>>} placeholders
 * @param {boolean} wrapped
 * @returns {StrictProfile}
 */
function createMaps(profile, placeholders, wrapped) {
  /** @type {Map<object, string>|undefined} */
  let pointers;
  /** @type {JarenValidator|undefined} */
  let validator;
  const checks = new Map();
  /** Whether the profile node accepts the value, by the validator over the profile. @param {unknown} value @param {object} node */
  const matches = (value, node) => {
    if (pointers === undefined) {
      pointers = new Map();
      /** @type {(n: unknown, at: string) => unknown} */
      const visit = (n, at) => {
        if (!isJsonObject(n)) return;
        if (!pointers?.has(n)) pointers?.set(n, at);
        for (const key of Object.keys(n)) mapPosition(key, n[key], at, visit);
      };
      visit(profile, `${PROFILE_BASE}#`);
      validator = new JarenValidator();
      validator.addSchema({ $schema: DRAFT_2020_12, ...profile, $id: PROFILE_BASE });
    }
    let check = checks.get(node);
    if (check === undefined) {
      check = /** @type {JarenValidator} */ (validator).compile({ $ref: pointers.get(node) });
      checks.set(node, check);
    }
    return check(value) === true;
  };
  /** Follow the profile's own references. @param {any} node */
  const deref = (node) => {
    const seen = new Set();
    while (isJsonObject(node) && typeof node.$ref === 'string' && !seen.has(node)) {
      seen.add(node);
      node = node.$ref === '#' ? profile : profile.$defs?.[node.$ref.slice('#/$defs/'.length)];
    }
    return node;
  };

  /** @param {unknown} value @param {any} node @returns {unknown} */
  const restore = (value, node) => {
    node = deref(node);
    if (!isJsonObject(node)) return value;
    if (Array.isArray(node.anyOf)) {
      const results = node.anyOf.filter((branch) => matches(value, branch)).map((branch) => restore(value, branch));
      // where two branches accept the answer and disagree about a null,
      // the null stays: the original's validator decides
      return results.length > 0 && results.every((result) => equalsJson(result, results[0])) ? results[0] : value;
    }
    if (Array.isArray(value)) return isJsonObject(node.items) ? value.map((item) => restore(item, node.items)) : value;
    if (!isJsonObject(value) || !isJsonObject(node.properties)) return value;
    const absent = placeholders.get(node);
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(node.properties, key)) setObjectMember(out, key, value[key]);
      else if (value[key] !== null || !absent?.has(key)) setObjectMember(out, key, restore(value[key], node.properties[key]));
    }
    return out;
  };

  /** @param {unknown} value @param {any} node @returns {unknown} */
  const fill = (value, node) => {
    node = deref(node);
    if (!isJsonObject(node)) return value;
    if (Array.isArray(node.anyOf)) {
      for (const branch of node.anyOf) {
        const filled = fill(value, branch);
        if (matches(filled, branch)) return filled;
      }
      return value;
    }
    if (Array.isArray(value)) return isJsonObject(node.items) ? value.map((item) => fill(item, node.items)) : value;
    if (!isJsonObject(value) || !isJsonObject(node.properties)) return value;
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const key of Object.keys(node.properties))
      setObjectMember(out, key, Object.hasOwn(value, key) ? fill(value[key], node.properties[key]) : null);
    return out;
  };

  return {
    schema: profile,
    toProfile: (value) => fill(wrapped ? { value } : value, profile),
    fromProfile: (answer) => {
      const restored = restore(answer, profile);
      return wrapped && isJsonObject(restored) && Object.hasOwn(restored, 'value') ? restored.value : restored;
    },
  };
}
