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
 *   is derived, and only a member it refuses `null` for is widened. Either
 *   way a `null` an answer writes there stands for the member left out;
 * - every keyword the profile does not carry is restated in the node's
 *   `description`, where the model still reads it ({@link relaxSchema}'s
 *   rule), and `oneOf` becomes `anyOf`; an annotation the original never
 *   enforces (and an `x-` keyword) is dropped without a note;
 * - a node is read as the original reads it: a `$ref` alone before draft
 *   2019-09 and where no draft is declared, a reference to a boolean schema
 *   as that schema;
 * - a value of any shape (`{}`, a free-form object, a tuple, an `enum` or
 *   `const` of objects or arrays) is carried as
 *   JSON text, a map (`patternProperties`, a schema-valued
 *   `additionalProperties`) as an array of `{ key, value }` entries, and an
 *   object beside `allOf`/`anyOf`/`oneOf` whose branches only add, require
 *   or narrow members is distributed into each branch;
 * - a root that is not one closed object is wrapped as the one member `value`.
 *
 * Everything the profile drops is a relaxation, so the ORIGINAL schema
 * stays the authority: validate what `fromProfile` returns with it. The
 * two tightenings are closing and requiring; requiring is undone by
 * `fromProfile` (a `null` at a member the original leaves optional becomes
 * an absent member again) and closing narrows only which undeclared members
 * a model can write.
 * Where closing or bundling would make a profile that answers wrong — a map
 * beside declared members, a member contributed by `if`/`then`, two schemas
 * for one member — the schema is refused with a coded `SchemaCompileError`
 * naming the place, never a silently wrong profile.
 *
 * Providers also cap a strict schema's size, each in its own numbers, and
 * the caps change: the derivation builds none in. {@link strictProfileSize}
 * measures a profile in the numbers such caps are worded in, for a host to
 * compare.
 */

import { equalsJson, isJsonObject, setObjectMember } from '@jarenjs/core/object';
import { SCHEMA_VALUE_KEYWORDS, SCHEMA_MAP_KEYWORDS, SCHEMA_LIST_KEYWORDS, ANNOTATION_KEYWORDS } from '@jarenjs/core/schema';
import { withoutUnreadVocabularies } from './normalize.js';
import { indexSchemaResources, readsRefAlone, resolveSchemaReference } from './references.js';
import { encodeJsonPointerPath, withoutFragment } from './origin.js';
import { detectSchemaDraft, dialectDraft, holdDialects, identifierKeyword } from './schema-keywords.js';
import { VALIDATOR_STATE } from './validator-state.js';
import { createJsonPointer } from './traverse.js';
import { SchemaCompileError, SchemaRuntimeError } from './errors.js';
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
/** Annotations the profile does not carry, and `errorMessage`, which words a failure: none decides whether a value is accepted. */
const ANNOTATIONS = new Set([...ANNOTATION_KEYWORDS, 'errorMessage']);

/**
 * Whether a keyword the profile does not carry is one the original never
 * enforces: an annotation, `errorMessage`, or an `x-` vendor keyword. The profile drops it
 * without a note, since a note tells the model the original enforces it.
 * @param {string} keyword
 */
function unenforced(keyword) {
  return ANNOTATIONS.has(keyword) || keyword.startsWith('x-');
}

/**
 * A place in the schema as a refusal names it: `#pointer` in the schema,
 * `uri#pointer` in a reference.
 * @param {string} at - Where, as `uri#pointer`
 */
function placeOf(at) {
  return at.startsWith(`${SCHEMA_BASE}#`) ? at.slice(SCHEMA_BASE.length) : at;
}

/**
 * @param {string} code
 * @param {string} reason
 * @param {string} at - Where, as `uri#pointer`
 */
function refusal(code, reason, at) {
  return new SchemaCompileError(code, reason, placeOf(at));
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
  // the values an enum or const lists are restated: a carrier is all the
  // model reads of them
  return value === null || typeof value !== 'object' || keyword === 'enum' || keyword === 'const'
    ? `(strict profile: ${keyword} ${JSON.stringify(value)} is relaxed here; the original schema enforces it)`
    : `(strict profile: the ${keyword} keyword is relaxed here; the original schema enforces it)`;
}

/**
 * @typedef {object} StrictProfile
 * @property {Record<string, unknown>} schema - The profile document to hand
 *   a provider's strict mode: closed objects, every member required,
 *   references bundled under `$defs`
 * @property {(value: unknown) => unknown} toProfile - Map an instance of the
 *   original schema to the profile's shape: an absent member is filled with
 *   `null`, a member the profile closed out is dropped, a value at a union is
 *   written in the branch it belongs to (the first whose original schema
 *   accepts it), and a non-object root is wrapped as `{ value }` (for
 *   few-shot examples and tests)
 * @property {(answer: unknown) => unknown} fromProfile - Map an answer in the
 *   profile's shape back to the original's: a `null` at a member the original
 *   does not require is removed (a strict answer cannot leave a member out,
 *   so its `null` there means absent), unless the original refuses the answer
 *   without the member and accepts it with the `null`; a member the original
 *   requires keeps its `null`. JSON text is parsed, entries become an object,
 *   an answer two union branches read differently is read by the first whose
 *   original accepts its reading, and a wrapped root is unwrapped. Validate
 *   the result with the original schema; an answer the profile does not
 *   accept is returned as far as it reads. Throws
 *   `SchemaRuntimeError` `JK2002` for text that is not JSON and `JK2003` for
 *   entries that name one key twice, each with the `dataPath`
 */

/**
 * Derive the strict structured-output profile of a schema: one closed,
 * self-contained document a provider's strict mode accepts, and the two maps
 * between the original's instances and the profile's. See the file comment
 * for the transform; the original schema remains the authority for what an
 * answer means.
 * @param {object|boolean} schema - The schema answers must satisfy (any draft from 07)
 * @param {{ references?: object[], dialects?: object }} [options] - `references`: the other
 *   schema documents its `$ref`s name, each with an absolute `$id`; `dialects`: a
 *   `JarenValidator` whose held meta-schemas a `$schema` is read through, as its compile
 *   reads it, a place whose dialect leaves the validation vocabulary out carrying none of its
 *   validation keywords — without it a `$schema` naming no known draft (a custom dialect) reads
 *   as draft-07
 * @returns {StrictProfile}
 * @throws {SchemaCompileError} `JK0102` an object whose member names are
 *   open and that no entries array carries, `JK0103` a keyword that adds
 *   members, items or branches the profile cannot carry beside its node,
 *   `JK0104` a reference the profile cannot bundle, `JK0105` both `oneOf` and
 *   `anyOf` on one node, `JK0106` a required member the object does not
 *   declare, `JK0107` an argument it does not take, `JK0108` a schema that
 *   accepts no value, `JK0010` an `$id` that is no URI reference (as the
 *   validator refuses it), `JK0016` a dialect requiring a vocabulary the validator does
 *   not implement; each names the place. The original is compiled too, so
 *   its own refusals (`JK0009` for a reference nothing holds) surface here
 */
export function deriveStrictProfile(schema, options = {}) {
  const givenReferences = options?.references ?? [];
  if (!isSchemaValue(schema) || !Array.isArray(givenReferences))
    throw new SchemaCompileError('JK0107', 'deriveStrictProfile takes a schema and { references }: an array of schema documents');
  const dialects = options?.dialects;
  if (dialects !== undefined && !VALIDATOR_STATE.has(dialects))
    throw new SchemaCompileError('JK0107', "deriveStrictProfile takes { dialects } as a JarenValidator, whose held meta-schemas name the dialects");
  if (schema === false) throw refusal('JK0108', 'a schema that accepts no value has no strict form', '#');
  // each document as the validator holding its dialects reads it: without
  // the validation keywords where the dialect governing a place leaves them out
  schema = withoutUnreadVocabularies(schema, { dialects });
  const references = givenReferences.map((reference) => withoutUnreadVocabularies(reference, { dialects }));

  /** Every schema node of the documents, by the resource and pointer it sits at. */
  const located = new Map();
  /** The draft each node is read under: its own `$schema`, else its document's; null where none is declared. */
  const drafts = new Map();
  /**
   * The resources of the documents, as the validator registers them: the
   * base each node sits under and each `$ref` resolves against.
   */
  const resources = indexSchemaResources(schema, { base: SCHEMA_BASE, dialects });
  const { held } = resources;
  /** The `$schema` URIs of the documents, which the original reads through `held`'s meta-schemas. */
  const named = new Set();
  /** The nodes a draft-04 `id` identifies: identity there, as `$id` is. */
  const idNodes = new WeakSet();
  /**
   * Whether a member of a node is its identity, dropped without a note.
   * @param {object} node @param {string} key
   */
  const isIdentity = (node, key) => IDENTITY.has(key) || (key === 'id' && idNodes.has(node));
  /**
   * The base an identifier names, refused as the validator refuses one that
   * is no URI reference.
   * @param {string} id @param {string} base @param {string} at - The node's location
   * @param {string} keyword - `$id`, or the draft-04 `id` ({@link identifierKeyword})
   */
  const identified = (id, base, at, keyword) => {
    createJsonPointer(id, base, undefined, keyword, placeOf(encodeJsonPointerPath(at, keyword)));
    return withoutFragment(new URL(id, base).href);
  };
  /**
   * @param {unknown} node @param {string} base @param {string} at @param {number|null} draft
   * @param {number|null} declared - The known draft the document declares, null for none or an unknown one
   */
  const index = (node, base, at, draft, declared) => {
    if (!isJsonObject(node) || located.has(node)) return;
    if (typeof node.$schema === 'string') {
      draft = detectSchemaDraft(node, held);
      declared = dialectDraft(node.$schema, held);
      named.add(node.$schema);
    }
    // the base the resource index places the node under: an identifier
    // that names only a fragment (a draft-07 plain name) starts no resource
    const keyword = identifierKeyword(node, declared);
    if (keyword === 'id') idNodes.add(node);
    if (keyword !== undefined && at !== `${base}#`) identified(node[keyword], base, at, keyword);
    const place = resources.places.get(node);
    if (place !== undefined && place.base !== base) {
      base = place.base;
      at = `${base}#`;
    }
    located.set(node, at);
    drafts.set(node, draft);
    for (const key of Object.keys(node)) mapPosition(key, node[key], at, (child, there) => index(child, base, there, draft, declared));
  };
  const rootKeyword = isJsonObject(schema) ? identifierKeyword(schema, typeof schema.$schema === 'string' ? dialectDraft(schema.$schema, held) : null) : undefined;
  const rootBase = rootKeyword !== undefined ? identified(schema[rootKeyword], SCHEMA_BASE, `${SCHEMA_BASE}#`, rootKeyword) : SCHEMA_BASE;
  index(schema, rootBase, `${rootBase}#`, null, null);
  for (const reference of references) {
    let base;
    try { base = isJsonObject(reference) && typeof reference.$id === 'string' ? withoutFragment(new URL(reference.$id).href) : undefined; }
    catch { base = undefined; }
    if (base === undefined)
      throw new SchemaCompileError('JK0107', 'deriveStrictProfile: every reference is a schema object with an absolute $id');
    indexSchemaResources(reference, { base, into: resources });
    index(reference, base, `${base}#`, null, null);
  }

  /** The original's own validator, asked whether a place's schema accepts a value. */
  let original;
  const placeChecks = new Map();
  /** @param {string} place @param {unknown} value */
  const accepts = (place, value) => {
    if (original === undefined) {
      original = new JarenValidator();
      // each dialect the documents name, read as `held` reads it
      holdDialects(original, named, held);
      // held under the base the index read it at, which `addSchema` names it
      // by, so a resource embedded in it resolves against it
      if (isJsonObject(schema)) original.addSchema(schema, rootBase);
      else original.addSchema({}, rootBase);
      for (const reference of references) original.addSchema(reference);
    }
    let check = placeChecks.get(place);
    if (check === undefined) {
      check = original.compile({ $ref: place });
      placeChecks.set(place, check);
    }
    return check(value) === true;
  };

  // the profile's root is the schema's own object when it stays one closed
  // object; anything else is wrapped as the member `value`
  const root = /** @type {any} */ (schema);
  const wrapped = !(isJsonObject(root) && root.type === 'object' && !['$ref', 'anyOf', 'oneOf', 'patternProperties'].some((key) => Object.hasOwn(root, key))
    && !isJsonObject(root.additionalProperties)
    && ((isJsonObject(root.properties) && Object.keys(root.properties).length > 0) || root.additionalProperties === false || root.unevaluatedProperties === false));
  let rootReferenced = false;
  /** @type {Map<object, string>} */
  const names = new Map();
  const used = new Set();
  /** @type {object[]} */
  const pending = [];

  /**
   * The schema a reference names: a schema object of the documents, or a
   * boolean schema.
   * @param {string} ref @param {string} base @param {string} at
   * @returns {object|boolean}
   */
  const targetOf = (ref, base, at) => {
    let url;
    try { url = new URL(ref, base); }
    catch { throw refusal('JK0104', `$ref '${ref}' is not a URI reference`, at); }
    if (!resources.resources.has(withoutFragment(url.href)))
      throw refusal('JK0104', `$ref '${ref}' names a document neither the schema nor its references hold; pass it in references`, at);
    const target = resolveSchemaReference(ref, base, resources);
    if (typeof target !== 'boolean' && (target === undefined || !located.has(target)))
      throw refusal('JK0104', `$ref '${ref}' resolves to no schema`, at);
    return /** @type {object|boolean} */ (target);
  };
  /**
   * Whether a member's schema accepts no value: `false`, or a `$ref` to it.
   * @param {unknown} member @param {string} base
   */
  const refusesAll = (member, base) => {
    if (member === false) return true;
    if (!isJsonObject(member) || typeof member.$ref !== 'string') return false;
    const first = located.get(member);
    try { return targetOf(member.$ref, resources.places.get(member)?.refBase ?? base, first ?? `${base}#`) === false; }
    catch { return false; }
  };

  /** @param {object} target - A schema object {@link targetOf} returned */
  const bundle = (target) => {
    const where = located.get(target);
    if (target === schema && !wrapped) {
      rootReferenced = true;
      return '#';
    }
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
  /**
   * Profile nodes → the places of the original each stands for: the place it
   * was derived from, or, for a member several places declare, all of them.
   * `toProfile` asks the original there which union branch a value belongs to.
   * @type {WeakMap<object, string[]>}
   */
  const origins = new WeakMap();
  /** Profile nodes that carry a value as JSON text, and maps carried as `{ key, value }` entries. */
  const texts = new WeakSet();
  const maps = new WeakSet();
  /** The optional members, widened once every reference is bundled (so a
   * reference the profile cannot bundle is refused as such first). */
  const optional = [];

  /**
   * A node that carries any value as JSON text: a string the model writes
   * and `fromProfile` parses, which the original then judges.
   * @param {any} node - The original node (`true`, or an object)
   * @param {string[]|null} types - Its declared types
   */
  const carrier = (node, types) => {
    /** @type {Record<string, unknown>} */
    const out = { type: types?.includes('null') ? ['string', 'null'] : 'string' };
    const notes = [`(strict profile: write this ${types === null ? 'value' : types.filter((type) => type !== 'null').join(' or ')} as JSON text, a string such as "{\\"a\\": 1}"; the original schema enforces it)`];
    if (isJsonObject(node)) {
      for (const key of Object.keys(node)) {
        if (key === 'title' || key === 'description') setObjectMember(out, key, node[key]);
        else if (!isIdentity(node, key) && key !== 'type' && !unenforced(key)) notes.push(strictNote(key, node[key]));
      }
    }
    appendNotes(out, notes);
    texts.add(out);
    return out;
  };

  /**
   * A map — members admitted by `patternProperties` or a schema-valued
   * `additionalProperties` — carried as an array of `{ key, value }` entries.
   * @param {any} node @param {string[]} types @param {string} base @param {string} at
   */
  const entries = (node, types, base, at) => {
    if (isJsonObject(node.properties) && Object.keys(node.properties).length > 0)
      throw refusal('JK0102', 'a map beside declared properties admits members of any name next to fixed ones, which neither a closed object nor an entries array carries; move the map into a member of its own', at);
    if (types.includes('array'))
      throw refusal('JK0102', 'a map that may also be an array has no strict form: its entries array would read as either; give the map its own member', at);
    const patterns = isJsonObject(node.patternProperties) ? Object.keys(node.patternProperties) : [];
    /** @type {[unknown, string][]} */
    const values = patterns.filter((pattern) => node.patternProperties[pattern] !== false)
      .map((pattern) => [node.patternProperties[pattern], encodeJsonPointerPath(encodeJsonPointerPath(at, 'patternProperties'), pattern)]);
    const rest = Object.hasOwn(node, 'additionalProperties') ? node.additionalProperties : true;
    if (rest !== false) values.push([rest, encodeJsonPointerPath(at, 'additionalProperties')]);
    const distinct = values.filter(([schema], i) => values.findIndex(([other]) => equalsJson(other, schema)) === i);
    const value = distinct.some(([schema]) => schema === true) ? carrier(true, null)
      : distinct.length === 1 ? strict(distinct[0][0], base, distinct[0][1])
        : { anyOf: distinct.map(([schema, there]) => strict(schema, base, there)) };
    /** @type {Record<string, unknown>} */
    const out = { type: types.length === 1 ? 'array' : types.map((type) => (type === 'object' ? 'array' : type)) };
    const notes = ['(strict profile: this object is written as an array of { key, value } entries, one per member, each key once; the original schema enforces it)'];
    for (const key of Object.keys(node)) {
      if (key === 'title' || key === 'description') setObjectMember(out, key, node[key]);
      else if (!isIdentity(node, key) && !unenforced(key) && !['type', 'properties', 'patternProperties', 'additionalProperties'].includes(key)) notes.push(strictNote(key, node[key]));
    }
    // a pattern whose schema is false gives a name no value: no member may carry it
    const refused = patterns.filter((pattern) => node.patternProperties[pattern] === false);
    const valued = patterns.filter((pattern) => node.patternProperties[pattern] !== false);
    const spelled = (/** @type {string[]} */ list) => list.map((pattern) => JSON.stringify(pattern)).join(' or ');
    const barred = refused.length === 0 ? '' : `; no name matches ${spelled(refused)}`;
    const keyNote = patterns.length === 0 ? '(strict profile: a member name)'
      : valued.length === 0 ? `(strict profile: a member name; no name matches ${spelled(refused)}; the original schema enforces it)`
        : `(strict profile: a member name; a name matching ${spelled(valued)} takes that pattern's value schema${rest === false ? ', and every name matches one' : ''}${barred}; the original schema enforces it)`;
    out.items = { type: 'object', properties: { key: { type: 'string', description: keyNote }, value }, required: ['key', 'value'], additionalProperties: false };
    appendNotes(out, notes);
    maps.add(out);
    return out;
  };

  /** Keywords a branch distributed into its object may not carry. */
  const UNDISTRIBUTED = new Set(['$ref', '$dynamicRef', '$recursiveRef', 'anyOf', 'oneOf', 'allOf', 'patternProperties',
    'unevaluatedProperties', 'enum', 'const', 'if', 'then', 'else', 'dependentSchemas', 'propertyDependencies', 'dependencies']);
  /** Keywords that give a schema its shape; a schema without any only narrows another. */
  const SHAPING = new Set([...STRUCTURAL, 'patternProperties', 'dependentSchemas', 'propertyDependencies', 'dependencies', 'not',
    '$dynamicRef', '$recursiveRef']);

  /**
   * An object beside `allOf`/`anyOf`/`oneOf` whose branches only add or
   * require members: each `allOf` branch is folded into the object, and the
   * object is distributed into each `anyOf` branch, as closed objects.
   * @param {any} node @param {string} base @param {string} at
   */
  const distribute = (node, base, at) => {
    if (Object.hasOwn(node, 'anyOf') && Object.hasOwn(node, 'oneOf'))
      throw refusal('JK0105', 'a node carries both oneOf and anyOf, and a profile turns oneOf into anyOf; merge them into one anyOf', at);
    /** A record of members: schema, the original places that schema stands for, required names, notes. */
    const start = () => {
      const properties = isJsonObject(node.properties) ? node.properties : {};
      const where = encodeJsonPointerPath(at, 'properties');
      return {
        members: new Map(Object.keys(properties).map((name) => [name, { schema: properties[name], places: [encodeJsonPointerPath(where, name)] }])),
        required: new Set(Array.isArray(node.required) ? node.required : []),
        notes: /** @type {string[]} */ ([]),
      };
    };
    /** @param {ReturnType<typeof start>} record @param {unknown} branch @param {string} there */
    const fold = (record, branch, there) => {
      if (branch === false) return false;
      if (!isJsonObject(branch)) return true;
      const first = located.get(branch) ?? there;
      for (const key of Object.keys(branch)) {
        if (UNDISTRIBUTED.has(key) || (key === 'type' && [branch.type].flat().some((type) => type !== 'object'))
          || (key === 'additionalProperties' && typeof branch[key] !== 'boolean'))
          throw refusal('JK0103', `${key} in a branch beside an object type is not a member the object can take; write the branch as properties and required only`, encodeJsonPointerPath(first, key));
      }
      const where = encodeJsonPointerPath(first, 'properties');
      for (const [name, schema] of Object.entries(isJsonObject(branch.properties) ? branch.properties : {})) {
        const place = encodeJsonPointerPath(where, name);
        const held = record.members.get(name);
        if (held === undefined || equalsJson(held.schema, schema)) {
          record.members.set(name, { schema, places: [...(held?.places ?? []), place] });
          continue;
        }
        record.members.set(name, { schema: conjoin(held, { schema, places: [place] }, place), places: [...held.places, place] });
      }
      for (const name of Array.isArray(branch.required) ? branch.required : []) record.required.add(name);
      if (branch.additionalProperties === false) {
        // a closed branch admits its own members only: the others leave the
        // object, and a branch that would need one of them never matches
        const own = isJsonObject(branch.properties) ? branch.properties : {};
        for (const name of [...record.members.keys()]) {
          if (Object.hasOwn(own, name)) continue;
          if (record.required.has(name)) return false;
          record.members.delete(name);
        }
        for (const name of record.required) if (!Object.hasOwn(own, name)) return false;
      }
      if (typeof branch.description === 'string') record.notes.push(branch.description);
      for (const key of Object.keys(branch)) {
        if (!['type', 'properties', 'required', 'title', 'description', 'additionalProperties'].includes(key) && !isIdentity(branch, key) && !unenforced(key))
          record.notes.push(strictNote(key, branch[key]));
      }
      return true;
    };
    /** @param {ReturnType<typeof start>} record */
    const close = (record) => {
      /** @type {Record<string, any>} */
      const synthetic = {};
      for (const key of Object.keys(node)) {
        if (!['anyOf', 'oneOf', 'allOf', 'properties', 'required', 'description'].includes(key)) setObjectMember(synthetic, key, node[key]);
      }
      const description = [node.description, ...record.notes].filter((text) => typeof text === 'string').join(' ');
      if (description !== '') synthetic.description = description;
      synthetic.properties = {};
      const places = new Map();
      for (const [name, { schema, places: where }] of record.members) {
        setObjectMember(synthetic.properties, name, schema);
        places.set(name, where);
      }
      synthetic.required = [...record.required];
      return strict(synthetic, base, at, places);
    };
    /**
     * A node whose own `additionalProperties` is false admits only the
     * members its own `properties` declare: a member only a branch declares
     * leaves the object, and a record that requires one accepts nothing.
     * Returns the first such required member, or undefined.
     * @param {ReturnType<typeof start>} record
     */
    const outside = (record) => {
      if (node.additionalProperties !== false || Object.hasOwn(node, 'patternProperties')) return undefined;
      const own = isJsonObject(node.properties) ? node.properties : {};
      const removed = [...record.members.keys()].filter((name) => !Object.hasOwn(own, name));
      for (const name of removed) record.members.delete(name);
      return removed.find((name) => record.required.has(name));
    };
    const all = start();
    const conjunction = Array.isArray(node.allOf) ? node.allOf : [];
    for (let i = 0; i < conjunction.length; i++) {
      if (!fold(all, conjunction[i], encodeJsonPointerPath(at, 'allOf', i)))
        throw refusal('JK0108', 'an allOf branch that accepts no value leaves the object none; remove it', encodeJsonPointerPath(at, 'allOf', i));
    }
    const key = Object.hasOwn(node, 'anyOf') ? 'anyOf' : Object.hasOwn(node, 'oneOf') ? 'oneOf' : null;
    if (key === null || !Array.isArray(node[key])) {
      const name = outside(all);
      if (name !== undefined)
        throw refusal('JK0108', `member '${name}' is required, and only a branch declares it, which additionalProperties false beside the branches refuses, so the object accepts no value; declare it under the object's own properties`, encodeJsonPointerPath(at, 'additionalProperties'));
      return close(all);
    }
    const branches = [];
    for (let i = 0; i < node[key].length; i++) {
      const record = { members: new Map(all.members), required: new Set(all.required), notes: [...all.notes] };
      const there = encodeJsonPointerPath(at, key, i);
      if (!fold(record, node[key][i], there) || outside(record) !== undefined) continue;
      const branch = close(record);
      // the object copied into a branch stands for that branch of the original
      origins.set(branch, [located.get(node[key][i]) ?? there]);
      branches.push(branch);
    }
    if (branches.length === 0) throw refusal('JK0108', `every ${key} branch accepts no value; remove the object`, encodeJsonPointerPath(at, key));
    return { anyOf: branches };
  };

  /**
   * The one schema two places give the same member, when it is exact: an
   * `enum` or `const` on one side, narrowed to the values the other side
   * accepts. Any other pair is refused.
   * @param {{ schema: unknown, places: string[] }} one @param {{ schema: unknown, places: string[] }} other @param {string} at
   */
  const conjoin = (one, other, at) => {
    if (one.schema === false || other.schema === false) return false;
    if (one.schema === true) return other.schema;
    if (other.schema === true) return one.schema;
    const listed = (/** @type {any} */ schema) => isJsonObject(schema)
      && Object.keys(schema).every((key) => ['enum', 'const', 'title', 'description'].includes(key))
      && (Array.isArray(schema.enum) || Object.hasOwn(schema, 'const'));
    // a side that only narrows (bounds, lengths, formats) keeps the other's
    // shape, and is restated in its description like any relaxed keyword
    const narrowing = (/** @type {any} */ schema) => isJsonObject(schema) && Object.keys(schema).every((key) => !SHAPING.has(key));
    for (const [shape, narrow] of [[one, other], [other, one]]) {
      if (!narrowing(narrow.schema) || !isJsonObject(shape.schema)) continue;
      const extra = /** @type {any} */ (narrow.schema);
      const notes = Object.keys(extra).filter((key) => !isIdentity(extra, key) && key !== 'title' && (key === 'description' || !unenforced(key)))
        .map((key) => (key === 'description' ? extra.description : strictNote(key, extra[key])));
      const widened = /** @type {any} */ ({ ...shape.schema });
      // the copy is read under the draft of the place it copies
      drafts.set(widened, drafts.get(shape.schema) ?? null);
      appendNotes(widened, notes);
      return widened;
    }
    const [values, judge] = listed(one.schema) ? [one, other] : listed(other.schema) ? [other, one] : [null, null];
    if (values === null || judge === null)
      throw refusal('JK0103', 'a branch gives a member a schema of its own beside the object\'s, and a strict profile cannot apply both; give the member one schema, or an enum on one side', at);
    const schema = /** @type {any} */ (values.schema);
    const kept = (Object.hasOwn(schema, 'const') ? [schema.const] : schema.enum)
      .filter((/** @type {unknown} */ value) => judge.places.every((place) => accepts(place, value)));
    return kept.length === 0 ? false : { ...(schema.description === undefined ? {} : { description: schema.description }), enum: kept };
  };

  /**
   * The profile of one schema, recorded with the place of the original it stands for.
   * @param {unknown} node @param {string} base @param {string} at
   * @param {Map<string, string[]>} [places] - For a synthetic object: the original places of each member
   * @returns {any}
   */
  const strict = (node, base, at, places) => {
    const out = shaped(node, base, at, places);
    if (isJsonObject(out) && !origins.has(out)) origins.set(out, [located.get(/** @type {object} */ (node)) ?? at]);
    return out;
  };

  /**
   * @param {unknown} node @param {string} base @param {string} at
   * @param {Map<string, string[]>} [places] - For a synthetic object: the original places of each member
   * @returns {any}
   */
  const shaped = (node, base, at, places) => {
    if (node === true) return carrier(true, null);
    if (!isJsonObject(node)) throw refusal('JK0108', 'a schema that accepts no value has no strict form; remove it', at);
    // a node read where the index first met it carries that resource's base,
    // so a reference inside an embedded `$id` resolves against its own (the
    // enclosing one's, for an `$id` beside a `$ref` read alone)
    const first = located.get(node);
    if (first !== undefined) { at = first; base = resources.places.get(node)?.refBase ?? withoutFragment(first); }
    // before draft 2019-09, and where no draft is declared, the original
    // reads a `$ref` alone: nothing beside it applies, so nothing beside it
    // shapes the profile (a description still documents the node)
    if (typeof node.$ref === 'string' && readsRefAlone(node, drafts.get(node) ?? null, held))
      node = typeof node.description === 'string' ? { $ref: node.$ref, description: node.description } : { $ref: node.$ref };
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

    // a tuple gives positions their own schemas, which one items schema
    // cannot: the array is carried as JSON text
    if (arrays && (Object.hasOwn(node, 'prefixItems') || Object.hasOwn(node, 'additionalItems')
      || Object.hasOwn(node, 'unevaluatedItems') || Array.isArray(node.items)))
      return carrier(node, types);
    // an enum or const that lists an object or an array is carried as JSON
    // text: a closed object, or items carried as text, accepts none of its values
    const listed = [...(Object.hasOwn(node, 'const') ? [node.const] : []), ...(Array.isArray(node.enum) ? node.enum : [])];
    if ((objects || arrays) && listed.some((value) => value !== null && typeof value === 'object')) return carrier(node, types);
    if (objects && !enumerated) {
      const composed = Object.hasOwn(node, 'allOf') || Object.hasOwn(node, 'anyOf') || Object.hasOwn(node, 'oneOf');
      if (composed && !reference && types?.every((type) => type === 'object')) return distribute(node, base, at);
      const map = !composed && !reference && (isJsonObject(node.patternProperties) || isJsonObject(node.additionalProperties)
        || node.additionalProperties === true && Object.hasOwn(node, 'patternProperties'));
      if (map) return entries(node, /** @type {string[]} */ (types), base, at);
      const declared = isJsonObject(node.properties) ? Object.keys(node.properties).length : 0;
      if (!composed && !reference && declared === 0 && !Object.hasOwn(node, 'patternProperties') && node.additionalProperties !== false
        && (node.unevaluatedProperties === undefined || typeof node.unevaluatedProperties === 'boolean') && node.unevaluatedProperties !== false)
        return carrier(node, types);
    }

    /** @type {Set<string>} */
    const relaxed = new Set();
    /** @type {Set<string>} */
    const dropped = new Set();
    for (const key of Object.keys(node)) {
      if (isIdentity(node, key) || CARRIED.has(key)) continue;
      if (unenforced(key)) {
        dropped.add(key);
        continue;
      }
      if (shaped) {
        // a typed or enumerated node is its own shape: whatever else it says
        // only narrows it, so relaxing it is safe — except where it reaches
        // the members or the items of a shape this node closes
        if (objects && (COMPOSING.has(key) || key === 'anyOf' || key === 'oneOf' || key === '$ref'
          || (key === 'dependencies' && isJsonObject(node.dependencies) && Object.values(node.dependencies).some((value) => !Array.isArray(value)))))
          throw refusal('JK0103', `${key} beside an object type adds members a closed profile object cannot carry; move the members into the object (or into each branch)`, encodeJsonPointerPath(at, key));
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
    if (!shaped && !reference && !union) return carrier(node, null);
    const target = !shaped && reference ? targetOf(/** @type {string} */ (node.$ref), base, at) : undefined;
    if (target === false)
      throw refusal('JK0108', `$ref '${node.$ref}' names a schema that accepts no value, which has no strict form; remove it`, at);
    if (target === true) {
      // a reference to the schema that accepts any value is that schema
      /** @type {Record<string, unknown>} */
      const rest = {};
      for (const key of Object.keys(node)) if (key !== '$ref') setObjectMember(rest, key, node[key]);
      return carrier(rest, null);
    }
    if (objects) checkObject(node, base, at, places);
    if (arrays && node.items === false)
      throw refusal('JK0108', 'an array whose items accept no value has no strict form; remove the array type', encodeJsonPointerPath(at, 'items'));
    const kept = {};
    for (const key of Object.keys(node)) if (!isIdentity(node, key) && !dropped.has(key)) setObjectMember(kept, key, node[key]);
    if (objects) {
      // closing replaces both; a schema-valued one was refused above
      delete kept.unevaluatedProperties;
      if (Object.hasOwn(kept, 'additionalProperties')) kept.additionalProperties = false;
      // a member declared false (or a reference to false) is one the closed object leaves out
      if (isJsonObject(kept.properties))
        kept.properties = Object.fromEntries(Object.entries(kept.properties).filter(([, member]) => !refusesAll(member, base)));
    }
    // an array whose items accept any value carries each as JSON text
    if (arrays && !Object.hasOwn(kept, 'items')) kept.items = true;
    if (single && !shaped && !reference) {
      kept.anyOf = kept.allOf;
      delete kept.allOf;
    }
    const closed = encodeJsonPointerPath(at, 'additionalProperties');
    // a member of a synthetic object stands for every place that declares it
    const declared = encodeJsonPointerPath(at, 'properties');
    const standing = places === undefined ? undefined
      : new Map([...places].map(([name, list]) => [encodeJsonPointerPath(declared, name), list]));
    /** @type {(child: unknown, there: string) => unknown} */
    const child = (value, there) => {
      if (value === false && there === closed) return false;
      const made = strict(value, base, there);
      const list = standing?.get(there);
      if (list !== undefined && isJsonObject(made)) origins.set(made, list);
      return made;
    };
    const out = relaxNode(kept, at, relaxed, strictNote, child);

    if (target !== undefined) out.$ref = bundle(target);
    if (objects) closeObject(node, out, base, at, places);
    return out;
  };

  /**
   * Refuse an object whose members a closed profile object would read wrong.
   * @param {any} node @param {string} base @param {string} at @param {Map<string, string[]>} [places]
   */
  const checkObject = (node, base, at, places) => {
    if (Object.hasOwn(node, 'patternProperties'))
      throw refusal('JK0102', 'patternProperties beside an object type it cannot carry as entries; move the map into a member of its own', encodeJsonPointerPath(at, 'patternProperties'));
    for (const key of ['additionalProperties', 'unevaluatedProperties']) {
      if (Object.hasOwn(node, key) && typeof node[key] !== 'boolean')
        throw refusal('JK0102', `${key} admits members of any name, which a closed profile object cannot carry; declare the members under properties, or move the map into a member of its own`, encodeJsonPointerPath(at, key));
    }
    const declared = isJsonObject(node.properties) ? node.properties : {};
    const held = (/** @type {string} */ name) => Object.hasOwn(declared, name) && !refusesAll(declared[name], base);
    for (const name of Array.isArray(node.required) ? node.required : []) {
      if (!held(name))
        throw refusal('JK0106', `required member '${name}' is not declared under properties, so a closed profile object could never hold it; declare it`, places === undefined ? encodeJsonPointerPath(at, 'required') : at);
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

  /**
   * Close a profile object: every member required, optional ones widened to admit null.
   * @param {any} node @param {any} out @param {string} base @param {string} at @param {Map<string, string[]>} [places]
   */
  const closeObject = (node, out, base, at, places) => {
    const declared = isJsonObject(node.properties) ? node.properties : {};
    const required = new Set(Array.isArray(node.required) ? node.required : []);
    /** @type {Record<string, unknown>} */
    const members = {};
    const where = encodeJsonPointerPath(at, 'properties');
    for (const name of Object.keys(declared)) {
      if (refusesAll(declared[name], base)) continue;
      setObjectMember(members, name, out.properties[name]);
      if (!required.has(name)) optional.push({ out, name, at: places?.get(name) ?? [encodeJsonPointerPath(where, name)] });
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
  /** Follow the profile's own references while it is built. @param {any} node */
  const local = (node) => {
    const seen = new Set();
    while (isJsonObject(node) && typeof node.$ref === 'string' && node.$ref.startsWith('#/$defs/') && !seen.has(node)) {
      seen.add(node);
      node = defs[node.$ref.slice('#/$defs/'.length)];
    }
    return node;
  };
  /** Whether a profile node admits null — not always so where the original's
   * does: a JSON-text carrier is a string. @param {any} node @param {Set<object>} [seen] @returns {boolean} */
  const profileAdmitsNull = (node, seen = new Set()) => {
    node = local(node);
    if (!isJsonObject(node) || seen.has(node)) return true;
    seen.add(node);
    if (Array.isArray(node.anyOf)) return node.anyOf.some((/** @type {unknown} */ branch) => profileAdmitsNull(branch, seen));
    if (Object.hasOwn(node, 'const')) return node.const === null;
    if (Array.isArray(node.enum)) return node.enum.includes(null) && (node.type === undefined || [node.type].flat().includes('null'));
    return node.type === undefined || [node.type].flat().includes('null');
  };
  /** Profile object nodes → their optional members whose null the original admits. */
  const nullables = new WeakMap();
  for (const { out, name, at } of optional) {
    if (at.every((/** @type {string} */ place) => accepts(place, null))) {
      // a null the original admits stays a null, so the profile must admit it
      if (!profileAdmitsNull(out.properties[name])) out.properties[name] = widenNull(out.properties[name]);
      const either = nullables.get(out) ?? new Set();
      either.add(name);
      nullables.set(out, either);
      continue;
    }
    out.properties[name] = widenNull(out.properties[name]);
    const absent = placeholders.get(out) ?? new Set();
    absent.add(name);
    placeholders.set(out, absent);
  }
  // the original is the authority over every answer, so it must compile:
  // a reference a JSON-text carrier holds unread is refused here, coded by
  // the validator, rather than by the host's first answer
  accepts(`${rootBase}#`, null);
  // an object root whose members all fold away is carried as text after all
  const wrap = wrapped || body.type !== 'object';
  if (wrap && !wrapped && rootReferenced)
    throw refusal('JK0104', 'a reference to the root, whose object carries no members of its own, cannot be bundled; declare its members', '#');
  /** @type {Record<string, any>} */
  const profile = wrap
    ? { type: 'object', properties: { value: body }, required: ['value'], additionalProperties: false }
    : body;
  if (Object.keys(defs).length > 0) profile.$defs = defs;
  // a carrier beside a branch that also admits a string would read either
  // way: there it is boxed as the one member `json` of an object
  const mayBeString = (/** @type {any} */ node, /** @type {Set<object>} */ seen = new Set()) => {
    node = local(node);
    if (!isJsonObject(node) || seen.has(node) || texts.has(node)) return true;
    seen.add(node);
    if (Array.isArray(node.anyOf)) return node.anyOf.some((/** @type {unknown} */ branch) => mayBeString(branch, seen));
    if (Object.hasOwn(node, 'const')) return typeof node.const === 'string';
    if (Array.isArray(node.enum)) return node.enum.some((/** @type {unknown} */ value) => typeof value === 'string');
    return node.type === undefined || [node.type].flat().includes('string');
  };
  /** @type {(node: unknown) => void} */
  const box = (node) => {
    if (!isJsonObject(node)) return;
    if (Array.isArray(node.anyOf)) {
      node.anyOf = node.anyOf.map((/** @type {any} */ branch, /** @type {number} */ i) => {
        const target = local(branch);
        if (!texts.has(target) || !node.anyOf.some((/** @type {unknown} */ other, /** @type {number} */ j) => j !== i && mayBeString(other))) return branch;
        const nullable = Array.isArray(target.type);
        const boxed = { type: nullable ? ['object', 'null'] : 'object', properties: { json: { type: 'string', description: target.description } },
          required: ['json'], additionalProperties: false };
        boxes.add(boxed);
        const stood = origins.get(branch);
        if (stood !== undefined) origins.set(boxed, stood);
        return boxed;
      });
    }
    for (const key of Object.keys(node)) mapPosition(key, node[key], '#', (child) => { box(child); return child; });
  };
  const boxes = new WeakSet();
  box(profile);
  return createMaps(profile, { placeholders, nullables, texts, maps, boxes, origins }, wrap, accepts, `${rootBase}#`);
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
 * @param {{ placeholders: WeakMap<object, Set<string>>, nullables: WeakMap<object, Set<string>>, texts: WeakSet<object>,
 *   maps: WeakSet<object>, boxes: WeakSet<object>, origins: WeakMap<object, string[]> }} marks - the members whose null
 *   stands for absence, the optional members whose null the original admits, the JSON-text carriers, the entries
 *   maps, the boxed carriers, the places of the original each profile node stands for
 * @param {boolean} wrapped
 * @param {(place: string, value: unknown) => boolean} accepts - The original's own answer at one of its places
 * @param {string} root - The place of the original's root
 * @returns {StrictProfile}
 */
function createMaps(profile, { placeholders, nullables, texts, maps, boxes, origins }, wrapped, accepts, root) {
  /** The original's own answer for a whole instance. @param {unknown} value */
  const judge = (value) => accepts(root, value);
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

  /**
   * Whether a value belongs to a union branch: the original accepts it at every place the branch stands for. A
   * branch that stands for no place (the `null` an optional member is widened with) is asked of the profile.
   * @param {unknown} value @param {object} branch
   */
  const belongs = (value, branch) => {
    const places = origins.get(branch);
    return places === undefined ? matches(value, branch) : places.every((place) => accepts(place, value));
  };

  /** @param {string} path @param {string} key */
  const below = (path, key) => `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;

  /** @param {unknown} value @param {any} node @param {string} path @returns {unknown} */
  const restore = (value, node, path) => {
    node = deref(node);
    if (!isJsonObject(node)) return value;
    if (boxes.has(node)) {
      if (!isJsonObject(value) || typeof value.json !== 'string') return value;
      value = value.json;
      path = below(path, 'json');
    }
    if (texts.has(node) || boxes.has(node)) {
      if (typeof value !== 'string') return value;
      try { return JSON.parse(value); }
      catch {
        throw new SchemaRuntimeError('JK2002', 'a member carried as JSON text is not JSON text; write the value as a string of JSON', { dataPath: path });
      }
    }
    if (Array.isArray(node.anyOf)) {
      /** What each branch that accepts the answer reads it as. @type {[unknown, object][]} */
      const readings = [];
      let failure;
      for (const branch of node.anyOf) {
        if (!matches(value, branch)) continue;
        try { readings.push([restore(value, branch, path), branch]); }
        catch (error) { failure ??= error; }
      }
      if (readings.length === 0 && failure !== undefined) throw failure;
      if (readings.length === 0) return value;
      if (readings.every(([reading]) => equalsJson(reading, readings[0][0]))) return readings[0][0];
      // two branches accept the answer and read it differently: it is the reading of the first branch whose
      // original accepts what that branch reads. Where none does, the answer stays as written, and the
      // original's validator decides
      const own = readings.find(([reading, branch]) => belongs(reading, branch));
      return own === undefined ? value : own[0];
    }
    if (Array.isArray(value)) {
      const items = isJsonObject(node.items) ? value.map((item, i) => restore(item, node.items, below(path, String(i)))) : value;
      return maps.has(node) ? fromEntries(items, path) : items;
    }
    if (!isJsonObject(value) || !isJsonObject(node.properties)) return value;
    const absent = placeholders.get(node);
    const either = nullables.get(node);
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const key of Object.keys(value)) {
      const at = below(path, key);
      if (!Object.hasOwn(node.properties, key)) setObjectMember(out, key, value[key]);
      else if (value[key] !== null) setObjectMember(out, key, restore(value[key], node.properties[key], at));
      // a null the original refuses at an optional member stands for an absent member
      else if (absent?.has(key)) continue;
      // so does a null the original admits there, unless the answer needs it; a required member keeps its null
      else if (either?.has(key) && !kept(at)) continue;
      else setObjectMember(out, key, restore(null, node.properties[key], at));
    }
    return out;
  };
  /**
   * The nulls an answer writes at optional members whose schema admits null, by their place in the answer: the ones
   * met, and the ones this reading keeps. A model under a strict profile cannot leave a member out, so its null there
   * means absent; one stays only where the original refuses the answer without the member and accepts it with the null.
   * @type {Set<string>}
   */
  let met = new Set();
  /** @type {Set<string>} */
  let staying = new Set();
  /** @param {string} at */
  const kept = (at) => {
    met.add(at);
    return staying.has(at);
  };

  /** Entries back to the object they carry; an entry that is not one is left for the original to refuse. @param {unknown[]} items @param {string} path */
  const fromEntries = (items, path) => {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (let i = 0; i < items.length; i++) {
      const entry = /** @type {any} */ (items[i]);
      if (!isJsonObject(entry) || typeof entry.key !== 'string' || !Object.hasOwn(entry, 'value')) return items;
      if (Object.hasOwn(out, entry.key))
        throw new SchemaRuntimeError('JK2003', `the entries name member '${entry.key}' twice; write each key once`, { dataPath: below(path, String(i)) });
      setObjectMember(out, entry.key, entry.value);
    }
    return out;
  };

  /** @param {unknown} value @param {any} node @returns {unknown} */
  const fill = (value, node) => {
    node = deref(node);
    if (!isJsonObject(node)) return value;
    if (boxes.has(node)) return value === null && Array.isArray(node.type) ? null : { json: JSON.stringify(value) };
    if (texts.has(node)) return value === null && Array.isArray(node.type) ? null : JSON.stringify(value);
    if (Array.isArray(node.anyOf)) {
      // the branch the value belongs to: the first whose original schema accepts it. Filling a closed branch
      // drops the members it does not declare and writes null for the ones it does, so a filled value the
      // profile accepts says nothing about whose value it was
      const own = value === undefined ? undefined : node.anyOf.find((/** @type {object} */ branch) => belongs(value, branch));
      if (own !== undefined) return fill(value, own);
      // a value the original refuses in every branch: the first branch its filled value fits, else as written
      for (const branch of node.anyOf) {
        const filled = fill(value, branch);
        if (matches(filled, branch)) return filled;
      }
      return value;
    }
    if (maps.has(node) && isJsonObject(value))
      return Object.keys(value).map((key) => ({ key, value: fill(value[key], node.items.properties.value) }));
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
      /** The answer read with the given nulls kept. @param {Set<string>} nulls */
      const read = (nulls) => {
        staying = nulls;
        const restored = restore(answer, profile, '');
        return wrapped && isJsonObject(restored) && Object.hasOwn(restored, 'value') ? restored.value : restored;
      };
      met = new Set();
      // absent is the rule: every null at a member the original leaves optional is removed
      const without = read(new Set());
      if (met.size === 0 || judge(without)) return without;
      // where the original refuses that and accepts the answer with those nulls (a member something else
      // requires to be present), the nulls it needs stay, and no other
      const needed = new Set(met);
      if (!judge(read(needed))) return without;
      for (const at of [...needed]) {
        needed.delete(at);
        if (!judge(read(needed))) needed.add(at);
      }
      return read(needed);
    },
  };
}

/** The definitions one loop of references may hold and still be walked path by path. */
const LOOP_MEMBERS = 512;
/** The entries one loop is walked for; past it the loop is measured end to end. */
const LOOP_ENTRIES = 100_000;

/**
 * The number of Unicode code points in a string.
 * @param {string} text
 */
function codePoints(text) {
  let count = text.length;
  for (let i = 1; i < text.length; i++) {
    // a surrogate pair is one code point
    if ((text.charCodeAt(i) & 0xFC00) === 0xDC00 && (text.charCodeAt(i - 1) & 0xFC00) === 0xD800) count--;
  }
  return count;
}

/**
 * @typedef {object} StrictProfileSize
 * @property {number} characters - Characters of the schema's JSON text, written without whitespace
 * @property {number} properties - Object properties in all: every member an object declares under `properties`
 * @property {number} optionalProperties - Of those, the members their object does not list in `required`
 *   (none in a derived profile, which requires every member)
 * @property {number} unionProperties - Of those, the members whose schema, read through the definition it
 *   references, holds `anyOf` or a list of types (a derived profile writes an optional member as one)
 * @property {number} definitions - Definitions: the members of every `$defs` and `definitions`
 * @property {number} recursiveSchemas - Schemas on a loop of references: each definition, and the root, that a
 *   reference inside it leads back to
 * @property {number} depth - Levels of object nesting on the deepest path from the root: each object entered
 *   counts one, a reference is followed into its definition, and a path enters no definition twice, so a loop
 *   of references is walked once
 * @property {number} enumValues - Enum values in all, over every `enum`
 * @property {number} largestEnum - Values of the one `enum` that lists the most
 * @property {number} largestEnumCharacters - Characters of the values of the one `enum` whose values are
 *   longest together
 * @property {number} nameCharacters - Characters of every property name, definition name, `enum` value and
 *   `const` value together
 */

/**
 * Measure a strict profile, or any schema of the strict subset, in the numbers providers cap a
 * structured-output schema by. The caps differ per provider and change, so none is built in: compare the
 * numbers with the caps of the provider the schema is sent to. Characters are Unicode code points; a value
 * that is not a string counts as its JSON text. A reference that names no definition of the document adds
 * no level. A loop of more than 512 definitions, or one whose paths take more than 100,000 entries to walk,
 * is not walked path by path: its `depth` counts every definition of the loop once, end to end, which no
 * path exceeds.
 * @param {StrictProfile|object|boolean} profile - What `deriveStrictProfile` returns, or a schema
 * @returns {StrictProfileSize}
 * @throws {SchemaCompileError} `JK0107` for an argument that is neither
 */
export function strictProfileSize(profile) {
  const given = /** @type {any} */ (profile);
  const schema = isJsonObject(given) && typeof given.fromProfile === 'function' ? given.schema : given;
  if (!isSchemaValue(schema)) throw new SchemaCompileError('JK0107', 'strictProfileSize takes a strict profile or a schema');
  /** @type {StrictProfileSize} */
  const size = { characters: codePoints(JSON.stringify(schema)), properties: 0, optionalProperties: 0, unionProperties: 0, definitions: 0,
    recursiveSchemas: 0, depth: 0, enumValues: 0, largestEnum: 0, largestEnumCharacters: 0, nameCharacters: 0 };
  /** @param {unknown} value */
  const written = (value) => codePoints(typeof value === 'string' ? value : JSON.stringify(value));
  /** A reference into the document as the walk spells a place: the pointer, its escapes for a URI read. @param {string} ref */
  const placeNamed = (ref) => {
    try { return ref.startsWith('#') ? decodeURIComponent(ref) : ref; }
    catch { return ref; }
  };
  /**
   * The root and each definition, by place: the object levels its own text reaches, and each reference in
   * it with the levels entered where it stands.
   * @type {Map<string, { node: unknown, own: number, edges: [string, number][] }>}
   */
  const bodies = new Map();
  /** @param {string} at @param {unknown} node */
  const bodyAt = (at, node) => {
    const body = { node, own: 0, edges: /** @type {[string, number][]} */ ([]) };
    bodies.set(placeNamed(at), body);
    return body;
  };
  /** The schema of every declared member. @type {unknown[]} */
  const members = [];

  // one walk over every schema position: the counts, and the levels and references of each body
  /** @param {unknown} node @param {string} at @param {{ own: number, edges: [string, number][] }} body @param {number} level */
  const visit = (node, at, body, level) => {
    if (!isJsonObject(node)) return;
    const here = level + (isJsonObject(node.properties) || [node.type].flat().includes('object') ? 1 : 0);
    if (here > body.own) body.own = here;
    if (typeof node.$ref === 'string') body.edges.push([placeNamed(node.$ref), here]);
    if (Array.isArray(node.enum)) {
      const characters = node.enum.reduce((/** @type {number} */ sum, /** @type {unknown} */ value) => sum + written(value), 0);
      size.enumValues += node.enum.length;
      size.nameCharacters += characters;
      size.largestEnum = Math.max(size.largestEnum, node.enum.length);
      size.largestEnumCharacters = Math.max(size.largestEnumCharacters, characters);
    }
    if (Object.hasOwn(node, 'const')) size.nameCharacters += written(node.const);
    for (const key of Object.keys(node)) {
      const value = node[key];
      const names = isJsonObject(value) ? Object.keys(value) : [];
      const defining = key === '$defs' || key === 'definitions';
      if (defining || key === 'properties') {
        for (const name of names) size.nameCharacters += codePoints(name);
        if (defining) size.definitions += names.length;
        else {
          const required = new Set(Array.isArray(node.required) ? node.required : []);
          size.properties += names.length;
          for (const name of names) {
            if (!required.has(name)) size.optionalProperties++;
            members.push(value[name]);
          }
        }
      }
      // a definition is a body of its own, reached by reference
      mapPosition(key, value, at, (child, there) => visit(child, there, defining ? bodyAt(there, child) : body, defining ? 0 : here));
    }
  };
  visit(schema, '#', bodyAt('#', schema), 0);

  for (let member of members) {
    const seen = new Set();
    while (isJsonObject(member) && typeof member.$ref === 'string' && !seen.has(member)) {
      seen.add(member);
      member = bodies.get(placeNamed(member.$ref))?.node;
    }
    if (isJsonObject(member) && (Array.isArray(member.anyOf) || Array.isArray(member.type))) size.unionProperties++;
  }

  // the loops of references: strongly connected bodies, the ones nothing in them leaves first
  /** @type {Map<string, number>} */
  const seenAt = new Map();
  /** @type {Map<string, number>} */
  const lowest = new Map();
  /** @type {string[]} */
  const open = [];
  const isOpen = new Set();
  /** @type {string[][]} */
  const loops = [];
  for (const start of bodies.keys()) {
    if (seenAt.has(start)) continue;
    /** @type {{ at: string, next: number }[]} */
    const work = [{ at: start, next: 0 }];
    while (work.length > 0) {
      const frame = /** @type {{ at: string, next: number }} */ (work.at(-1));
      const { at } = frame;
      if (!seenAt.has(at)) {
        seenAt.set(at, seenAt.size);
        lowest.set(at, seenAt.size - 1);
        open.push(at);
        isOpen.add(at);
      }
      const { edges } = /** @type {{ edges: [string, number][] }} */ (bodies.get(at));
      let deeper = false;
      while (!deeper && frame.next < edges.length) {
        const to = edges[frame.next++][0];
        if (!bodies.has(to)) continue;
        if (!seenAt.has(to)) {
          work.push({ at: to, next: 0 });
          deeper = true;
        }
        else if (isOpen.has(to)) lowest.set(at, Math.min(/** @type {number} */ (lowest.get(at)), /** @type {number} */ (seenAt.get(to))));
      }
      if (deeper) continue;
      work.pop();
      const above = work.at(-1);
      if (above !== undefined) lowest.set(above.at, Math.min(/** @type {number} */ (lowest.get(above.at)), /** @type {number} */ (lowest.get(at))));
      if (lowest.get(at) !== seenAt.get(at)) continue;
      const loop = [];
      let member;
      do {
        member = /** @type {string} */ (open.pop());
        isOpen.delete(member);
        loop.push(member);
      } while (member !== at);
      loops.push(loop);
    }
  }

  /** The loop each body is on. @type {Map<string, string[]>} */
  const loopOf = new Map();
  for (const loop of loops) for (const at of loop) loopOf.set(at, loop);
  /** Where a path enters a loop: the root, and each body a reference from outside its loop names. */
  const starts = new Set(['#']);
  for (const [at, { edges }] of bodies) {
    for (const [to] of edges) if (bodies.has(to) && loopOf.get(to) !== loopOf.get(at)) starts.add(to);
  }
  /** The deepest nesting from each start. @type {Map<string, number>} */
  const deepest = new Map();
  for (const loop of loops) {
    const recursive = loop.length > 1 || /** @type {{ edges: [string, number][] }} */ (bodies.get(loop[0])).edges.some(([to]) => to === loop[0]);
    const inside = new Set(recursive ? loop : []);
    if (recursive) size.recursiveSchemas += loop.length;
    let entries = LOOP_ENTRIES;
    const onPath = new Set();
    /** The deepest path from a body that enters no body of its loop twice. @param {string} at @returns {number} */
    const walk = (at) => {
      const { own, edges } = /** @type {{ own: number, edges: [string, number][] }} */ (bodies.get(at));
      let most = own;
      entries--;
      onPath.add(at);
      for (const [to, level] of edges) {
        if (entries < 0) break;
        if (!bodies.has(to) || onPath.has(to)) continue;
        most = Math.max(most, level + (inside.has(to) ? walk(to) : /** @type {number} */ (deepest.get(to))));
      }
      onPath.delete(at);
      return most;
    };
    const entered = loop.filter((at) => starts.has(at));
    /** @type {[string, number][]} */
    const walked = loop.length > LOOP_MEMBERS ? [] : entered.map((at) => [at, walk(at)]);
    if (loop.length <= LOOP_MEMBERS && entries >= 0) {
      for (const [at, most] of walked) deepest.set(at, most);
      continue;
    }
    // every body of the loop once, end to end, then the deepest body the loop leaves for
    let laid = 0;
    let beyond = 0;
    for (const at of loop) {
      const { own, edges } = /** @type {{ own: number, edges: [string, number][] }} */ (bodies.get(at));
      laid += own;
      for (const [to] of edges) if (!inside.has(to) && deepest.has(to)) beyond = Math.max(beyond, /** @type {number} */ (deepest.get(to)));
    }
    for (const at of entered) deepest.set(at, laid + beyond);
  }
  size.depth = /** @type {number} */ (deepest.get('#'));
  return size;
}
