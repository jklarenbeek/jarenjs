//#region schema-driven normalization
// Normalization is a SEPARATE pass from validation, compiled from the same
// schema. `@jarenjs/validate`'s compiled validators are pure predicates and
// stay that way: they never apply a `default`, never coerce, never trim and
// never strip. This module is where a consumer that needs Zod-style
// normalized *output* gets it, without the validator growing a side effect.
//
// Two properties are load-bearing:
//
//   1. The input is never mutated. Ajv's `useDefaults`/`coerceTypes` write
//      into the document they were handed; this compiles to a copy-on-write
//      walk instead, so `normalize(input)` returns a new value and `input`
//      is exactly as it was. A caller can hand the same document to two
//      normalizers, or keep it as an audit record, without defensive copying.
//   2. Untouched subtrees keep their identity. A node whose whole subtree is
//      unchanged is returned by reference, and a document that needs no
//      change at all returns the input reference itself (`normalize(x) === x`).
//      That makes a no-op cheap and lets downstream memoization by identity
//      keep working.
//
// House style: the same two-stage shape as the validator. `compileNormalizer`
// walks the schema once and specializes one closure per node; the returned
// function just runs closures. No `eval`, no `new Function`, no dependencies
// outside `@jarenjs/*`.

import {
  cloneJson,
  isJsonContainer,
  isJsonObject,
  isPlainOptions,
  refuseUnknownMembers,
  setObjectMember,
} from '@jarenjs/core/object';

import { parseJSONPointer } from '@jarenjs/json';
import { isJsonNumberString } from '@jarenjs/core/number';
import { isStringWhiteSpace } from '@jarenjs/core/string';
import { CC_LBRACE, CC_LBRACKET, isWhitespaceCode } from '@jarenjs/core/scan';
import {
  TRAVERSE_SCHEMA_OBJECTS,
  TRAVERSE_SCHEMA_MAPS,
  TRAVERSE_SCHEMA_MAP_MAPS,
  detectSchemaDraft,
  dialectDraft,
  identifierKeyword,
  identifierText,
  admitsPropertyDependencies,
  readPrefixItems,
  readsPrefixItems,
  readsSince,
} from './schema-keywords.js';
import { createSchemaPatternTester } from './string.js';
import { DEFAULT_ORIGIN, withoutFragment } from './origin.js';
import { admitsDynamicReference, appliesRefSiblings } from './dynamic-ref.js';
import { VALIDATOR_STATE } from './validator-state.js';

// The validator's reading of a `pattern` string, for a consumer that checks
// one without compiling a schema (a form field, per keystroke); of the
// draft a `$schema` declares, for a consumer that reads a `$ref`'s siblings
// as this module does ({@link readsRefAlone}); and of where `prefixItems`
// is a keyword, which a draft before 2020-12 reads as an unknown one.
export { createSchemaPatternTester, detectSchemaDraft, readsPrefixItems };

const hasOwn = Object.hasOwn;

/**
 * A compiled normalizer. `In` is what the caller accepts, `Out` what the
 * normalized value is; they differ whenever defaults are materialized, which
 * is exactly the distinction a contract wrapper needs to expose.
 * @template [In=unknown]
 * @template [Out=In]
 * @typedef {(data: In) => Out} Normalizer
 */

/**
 * Options for {@link compileNormalizer}. Every normalization is off by
 * default: each one changes the meaning of the caller's data, so each is a
 * decision the caller makes rather than inherits. With no options the
 * compiled normalizer is the identity.
 * Four of the five also accept a **predicate** `(schemaNode) => boolean`
 * instead of a boolean, evaluated once per node at compile time. That is how
 * a consumer turns a whole-schema switch into a per-field decision — "trim
 * these string fields, leave those alone" — without the option becoming a
 * blunt instrument and without any runtime cost.
 * @typedef {object} NormalizeOptions
 * @property {boolean|((schemaNode: Record<string, unknown>) => boolean)} [useDefaults=false] - Materialize `default` for absent object properties, recursively,
 *   where every schema object that may apply at the object's place admits the member by its name ({@link unfilledDefaults})
 * @property {boolean|'all'} [removeAdditional=false] - Strip unknown properties: `true` only where `additionalProperties: false`, `'all'` wherever an object shape is declared
 * @property {boolean|((schemaNode: Record<string, unknown>) => boolean)} [coerceTypes=false] - Convert a value to the node's declared scalar `type` when it is convertible
 * @property {boolean|((schemaNode: Record<string, unknown>) => boolean)} [trimStrings=false] - Trim leading/trailing whitespace from strings, before coercion
 * @property {boolean|((schemaNode: Record<string, unknown>) => boolean)} [coerceJsonText=false] - Decode a string holding the JSON text of an object or array where the node's `type` wants that container and admits no string, then normalize the decoded value
 * @property {object} [dialects] - A `JarenValidator` whose held meta-schemas name the
 *   dialects the schema's `$schema` URIs may name ({@link heldDialects}). Without it a `$schema`
 *   is read by its name alone: a custom dialect reads as draft-07
 */

/**
 * The schemas a validator holds, by URI: the map its compile reads a
 * `$schema` through ({@link dialectDraft}), so a reader handed it reads a
 * custom dialect's draft exactly as that validator does — one reading, no
 * copy. `undefined` when no validator is given, where a `$schema` is read by
 * its name alone.
 * @param {unknown} dialects - The `dialects` option: a `JarenValidator`, or undefined
 * @param {string} who - The function the option was given to, for the refusal
 * @returns {{ get(key: string): unknown }|undefined}
 * @throws {TypeError} When `dialects` is given and is no `JarenValidator`: a
 *   misspelt value would otherwise read every custom dialect as draft-07 without a word
 */
function heldDialects(dialects, who) {
  if (dialects === undefined) return undefined;
  const state = typeof dialects === 'object' && dialects !== null ? VALIDATOR_STATE.get(dialects) : undefined;
  if (state === undefined) throw new TypeError(`${who}: 'dialects' must be a JarenValidator, whose held meta-schemas name the dialects`);
  return state.schemas;
}

/**
 * Convert `value` to `type` when the conversion is unambiguous, otherwise
 * return it unchanged so validation reports the type error.
 *
 * The table is deliberately conservative - it exists to decode transport
 * encodings (query strings, form fields, environment variables, CSV cells)
 * where everything arrives as a string, not to paper over wrong data. Ajv
 * additionally maps `null`/`0`/`1`/`''` across types; those conversions lose
 * the difference between "absent", "empty" and "false", so they are not
 * reproduced here.
 * @param {any} value - The value to convert
 * @param {string} type - The declared JSON Schema scalar type
 * @returns {any} The converted value, or `value` when no conversion applies
 */
function coerceToType(value, type) {
  switch (type) {
    case 'number':
    case 'integer': {
      if (typeof value === 'number') return value;
      if (typeof value !== 'string' || !isJsonNumberString(value)) return value;
      const num = Number(value);
      if (!Number.isFinite(num)) return value;
      if (type === 'integer' && !Number.isSafeInteger(num)) return value;
      return num;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      return value;
    case 'string':
      if (typeof value === 'string') return value;
      if (typeof value === 'boolean') return String(value);
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
      return value;
    case 'null':
      return value === 'null' ? null : value;
    default:
      return value;
  }
}

/**
 * @typedef {object} SchemaPlace Where one schema object of a document sits
 * @property {string} base - The base URI of the resource holding it: its own, when its identifier starts one
 * @property {string} refBase - The base its `$ref` resolves against: `base`, or the enclosing
 *   resource's where its identifier sits beside a `$ref` read alone (before draft 2019-09)
 * @property {number|null} draft - The draft it is read under: the nearest `$schema` at or above
 *   it ({@link detectSchemaDraft}), null where none is declared
 * @property {number|null} declared - The known draft its document declares ({@link dialectDraft}),
 *   null for none or an unknown one
 */

/**
 * @typedef {object} SchemaResources The schema resources of one or more documents
 * @property {Map<object, SchemaPlace>} places - Every schema object, by identity
 * @property {Map<string, { node: object|boolean, names: Map<string, object> }>} resources - Each
 *   resource by its base URI (no fragment): its root and its plain names
 * @property {{ get(key: string): unknown }} [held] - The schemas a validator holds, by URI, a
 *   `$schema` is read through ({@link heldDialects}); absent where it is read by its name alone
 */

/**
 * Index the schema resources of a document as the validator registers
 * them: the document is one resource, and every subschema whose identifier
 * (`$id`, or the draft-04 `id` where the validator reads it:
 * {@link identifierKeyword}) names a URI starts another, at that URI
 * resolved against the base of the resource holding it — relative and
 * absolute alike. A fragment-only identifier (`$id: '#foo'`) starts none;
 * it is a plain name of the resource holding it, as `$anchor` and
 * `$dynamicAnchor` are, keyed as the URI spells the name. A name spelled as
 * a JSON Pointer (`$anchor: '/a'`) declares nothing: `#/a` is a pointer. A
 * `$ref` resolves against the base of the resource holding it, except where
 * an identifier sits beside a `$ref` the validator reads alone (before draft
 * 2019-09): that identifier still names its subschema, and the `$ref`
 * resolves against the enclosing resource. First declaration wins, which
 * keeps the index deterministic for a document that (invalidly) repeats a
 * name or an identifier. Exported because `@jarenjs/emit` and the strict
 * profile resolve references through it: three readings of one document's
 * scope would make a type or a profile disagree with this normalizer.
 * @param {object|boolean} root - The root schema of the document
 * @param {{ base?: string, propertyDependencies?: boolean, into?: SchemaResources, dialects?: object }} [options] -
 *   `base`: the URI the document is read under where it names none (the validator's default
 *   origin); `propertyDependencies: true` also walks the subschemas of `propertyDependencies`;
 *   `into`: an index to add the document to (a second document beside the first), read through
 *   the dialects it was made with; `dialects`: a `JarenValidator` whose held meta-schemas a
 *   `$schema` is read through, as that validator's compile reads it ({@link heldDialects}),
 *   where without it a `$schema` naming no known draft reads as draft-07
 * @returns {SchemaResources}
 * @throws {TypeError} When `dialects` is given and is no `JarenValidator`
 */
export function indexSchemaResources(root, options = {}) {
  /** @type {SchemaResources} */
  const index = options.into ?? { places: new Map(), resources: new Map() };
  const held = heldDialects(options.dialects, 'indexSchemaResources');
  if (held !== undefined) index.held = held;
  const base = options.base ?? DEFAULT_ORIGIN;
  const document = { node: root, names: new Map() };
  if (isJsonObject(root)) placeSchemas(index, root, base, null, null, document, options.propertyDependencies);
  else if (!index.resources.has(base)) index.resources.set(base, document);
  return index;
}

/**
 * Walk one subtree of schema positions, placing every schema object in it;
 * `resource` (when given) receives the names it declares and the resources
 * it starts are registered. Without `resource`, a subtree a JSON Pointer
 * reached outside the schema positions: placed only, as the validator
 * reads it, registering nothing.
 * @param {SchemaResources} index
 * @param {any} start
 * @param {string} startBase
 * @param {number|null} startDraft
 * @param {number|null} startDeclared
 * @param {{ node: object|boolean, names: Map<string, object> }|undefined} startResource
 * @param {boolean|undefined} propertyDependencies
 */
function placeSchemas(index, start, startBase, startDraft, startDeclared, startResource, propertyDependencies) {
  const { places, resources, held } = index;
  const seen = new Set();
  /**
   * @param {any} node @param {string} base @param {number|null} parentDraft
   * @param {number|null} parentDeclared
   * @param {{ node: object|boolean, names: Map<string, object> }|undefined} resource
   * @param {boolean} isRoot
   */
  const walk = (node, base, parentDraft, parentDeclared, resource, isRoot) => {
    if (!isJsonContainer(node) || seen.has(node) || places.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i], base, parentDraft, parentDeclared, resource, false);
      return;
    }
    // The draft a document declares is inherited by everything below it.
    const draft = typeof node.$schema === 'string' ? detectSchemaDraft(node, held) : parentDraft;
    const declared = typeof node.$schema === 'string' ? dialectDraft(node.$schema, held) : parentDeclared;
    const declare = (/** @type {string|undefined} */ name) => {
      if (resource !== undefined && name !== undefined && !resource.names.has(name)) resource.names.set(name, node);
    };
    let own = base;
    const idName = identifierKeyword(node, declared);
    // read without a JSON Pointer fragment, which names nothing
    const idText = idName === undefined ? undefined : identifierText(node[idName]);
    const name = idText === undefined ? undefined : plainNameKey(idText);
    if (name !== undefined) declare(name);
    else if (idText !== undefined) {
      // An embedded resource, under the URI its identifier names, with names
      // of its own (one that is no URI reference, which the validator
      // refuses, names no URI and still has its own names)
      own = resourceBase(idText, base) ?? base;
      if (resource !== undefined && !isRoot) resource = { node, names: new Map() };
    }
    if (resource !== undefined && (isRoot || own !== base) && !resources.has(own)) resources.set(own, resource);
    places.set(node, { base: own, refBase: !isRoot && readsRefAlone(node, parentDraft, held) ? base : own, draft, declared });
    for (const keyword of ['$anchor', '$dynamicAnchor'])
      if (typeof node[keyword] === 'string') declare(plainNameKey(`#${node[keyword]}`));
    // Only schema positions are schemas. Annotation values such as defaults
    // and examples are instance data, even when they contain $id or $anchor.
    for (const key of Object.keys(node)) {
      if (TRAVERSE_SCHEMA_OBJECTS.includes(key)) walk(node[key], own, draft, declared, resource, false);
      else if (TRAVERSE_SCHEMA_MAPS.includes(key) && isJsonObject(node[key])) {
        for (const child of Object.values(node[key])) walk(child, own, draft, declared, resource, false);
      }
      else if (TRAVERSE_SCHEMA_MAP_MAPS.includes(key) && admitsPropertyDependencies(propertyDependencies, draft)
        && isJsonObject(node[key])) {
        for (const inner of Object.values(node[key])) {
          if (!isJsonObject(inner)) continue;
          for (const child of Object.values(inner)) walk(child, own, draft, declared, resource, false);
        }
      }
    }
  };
  walk(start, startBase, startDraft, startDeclared, startResource, startResource !== undefined);
}

/**
 * The resource URI an identifier names against `base`, without its
 * fragment; undefined for one that is no URI reference.
 * @param {string} id
 * @param {string} base
 * @returns {string|undefined}
 */
function resourceBase(id, base) {
  try {
    return withoutFragment(new URL(referenceText(id), base).href);
  }
  catch (_e) {
    return undefined;
  }
}

/**
 * Resolve a `$ref` of an indexed document to the schema it names: the URI
 * the reference spells against `base` (the {@link SchemaPlace}'s `refBase`
 * of the object holding it) names a resource of the index, and its fragment
 * resolves inside that resource as {@link resolveSameDocumentRef} reads one —
 * a JSON Pointer from the resource's root (crossing into a resource embedded
 * below it, as the validator's does), a plain name among the resource's own.
 * A target the walk did not place (a pointer into a non-schema position) is
 * placed here, under the base and draft of the nearest placed object above
 * it. A reference to a document the index does not hold is not followed.
 * @param {string} ref - The reference as written
 * @param {string} base - The base it resolves against
 * @param {SchemaResources} index
 * @returns {object|boolean|undefined} The addressed schema, or undefined
 */
export function resolveSchemaReference(ref, base, index) {
  let url;
  try {
    url = new URL(isStringWhiteSpace(ref) ? '' : referenceText(ref), base);
  }
  catch (_e) {
    return undefined;
  }
  const resource = index.resources.get(withoutFragment(url.href));
  if (resource === undefined) return undefined;
  /** @type {unknown[]} */
  const trail = [];
  const target = followSameDocumentRef(url.hash === '' ? '#' : url.hash, resource.node, resource.names, trail);
  if (isJsonObject(target) && !index.places.has(target)) {
    let { base: at, draft, declared } = schemaPlace(index, resource.node);
    for (const passed of trail) {
      const place = index.places.get(/** @type {object} */ (passed));
      if (place !== undefined) ({ base: at, draft, declared } = place);
      else if (isJsonObject(passed) && typeof passed.$schema === 'string') {
        draft = detectSchemaDraft(passed, index.held);
        declared = dialectDraft(passed.$schema, index.held);
      }
    }
    placeSchemas(index, target, at, draft, declared, undefined, false);
  }
  return target;
}

/**
 * The place of a schema object of an indexed document; one the index does
 * not hold (a document that is no object) reads as the first document's
 * root.
 * @param {SchemaResources} index
 * @param {unknown} node
 * @returns {SchemaPlace}
 */
export function schemaPlace(index, node) {
  const place = index.places.get(/** @type {object} */ (node));
  if (place !== undefined) return place;
  const [base] = index.resources.keys();
  return { base, refBase: base, draft: null, declared: null };
}

/**
 * Collect the plain names of one schema document: a map from name to the
 * schema node that declares it, by an `$anchor`, a `$dynamicAnchor` or a
 * fragment-only identifier (`$id: '#foo'`, the draft-07 spelling of an
 * anchor, which the validator reads as a name in every draft, or the
 * draft-04 `id: '#foo'` where the validator reads `id`:
 * {@link identifierKeyword}), keyed as the URI spells the name — as the
 * validator keys it and {@link resolveSameDocumentRef} reads a reference to
 * it. The names of the document's own resource only: a subtree whose
 * identifier names a URI is an embedded resource with its own names
 * ({@link indexSchemaResources} indexes them all).
 * @param {object|boolean} root - The root schema of the document
 * @param {{ propertyDependencies?: boolean }} [options] - `propertyDependencies: true` also walks the
 *   subschemas of the `propertyDependencies` keyword (off, it is an unknown keyword and not walked)
 * @returns {Map<string, object>} name -> schema node
 */
export function collectSameDocumentAnchors(root, options = {}) {
  const index = indexSchemaResources(root, { propertyDependencies: options.propertyDependencies });
  return /** @type {{ names: Map<string, object> }} */ (index.resources.get(schemaPlace(index, root).base)).names;
}

/**
 * The plain name a fragment-only reference spells, as the validator's URL
 * parse spells it (`#a b` and `#a%20b` are both `a%20b`; `#%41` is not
 * `#A`). Undefined for a reference that is no plain name: one with a path,
 * an empty fragment, or a fragment that reads as a JSON Pointer (`#/a`,
 * `#%2Fa`).
 * @param {string} ref
 * @returns {string|undefined}
 */
function plainNameKey(ref) {
  const text = referenceText(ref);
  if (text.length < 2 || text[0] !== '#') return undefined;
  const href = new URL(text, 'jaren:/').href;
  const name = href.slice(href.indexOf('#') + 1);
  return name.replace(/%2f/gi, '/').startsWith('/') ? undefined : name;
}

/**
 * Resolve a same-document `$ref` — `#` (or a blank reference, which names the
 * document as `#` does), `#/` followed by a JSON Pointer, or
 * `#name` for a plain `$anchor` — to the schema it addresses, read from the
 * document's root. The reference
 * is read as the validator's URL parse reads it: the C0 controls and spaces
 * around it are dropped, and every tab and line break inside it. URI fragment
 * escapes are decoded once, before JSON Pointer token escapes. Refs into other
 * documents are not followed. A reference inside an embedded resource (a
 * subschema whose `$id` names a URI) resolves against that resource, not the
 * document: resolve it with {@link resolveSchemaReference}.
 * @param {string} ref - The reference
 * @param {object|boolean} root - The root schema being compiled
 * @param {Map<string, object>} [anchors] - The document's anchor map, from
 *   {@link collectSameDocumentAnchors}; omit to skip anchor resolution
 * @returns {object|boolean|undefined} The addressed schema, or undefined
 */
export function resolveSameDocumentRef(ref, root, anchors) {
  return followSameDocumentRef(ref, root, anchors, undefined);
}

/**
 * The text of a reference as the validator's URL parse reads it, before it
 * resolves: the C0 controls and spaces around it are dropped, and every tab
 * and line break inside it (the URL standard's reading). Exported for
 * `@jarenjs/emit`, which names a referenced type from this text.
 * @param {string} ref - The reference as written
 * @returns {string}
 */
export function referenceText(ref) {
  let start = 0;
  let end = ref.length;
  while (start < end && ref.charCodeAt(start) <= 0x20) start++;
  while (end > start && ref.charCodeAt(end - 1) <= 0x20) end--;
  return ref.slice(start, end).replace(/[\t\n\r]/g, '');
}

/**
 * {@link resolveSameDocumentRef}, collecting into `trail` every container a
 * JSON Pointer passes on the way to its target, the root first.
 * @param {string} ref
 * @param {object|boolean} root
 * @param {Map<string, object>|undefined} anchors
 * @param {unknown[]|undefined} trail
 * @returns {object|boolean|undefined}
 */
function followSameDocumentRef(ref, root, anchors, trail) {
  if (isStringWhiteSpace(ref)) return root;
  ref = referenceText(ref);
  if (ref === '' || ref === '#') return root;
  if (!ref.startsWith('#')) return undefined;
  let node = root;
  let tokens;
  const name = plainNameKey(ref);
  if (name !== undefined) return anchors?.get(name);
  try {
    const fragment = decodeURIComponent(ref.slice(1));
    if (!fragment.startsWith('/')) return undefined;
    tokens = parseJSONPointer(fragment);
  }
  catch (_e) {
    return undefined;
  }
  for (let i = 0; i < tokens.length; i++) {
    if (!isJsonContainer(node)) return undefined;
    trail?.push(node);
    node = node[tokens[i]];
  }
  return node;
}

/**
 * Resolve a per-node normalization switch at COMPILE time. Exported because
 * `@jarenjs/emit` has to answer the same question when it derives the accepted
 * and normalized type variants: two implementations of this rule would drift,
 * and a type that disagrees with the normalizer is worse than no type. `true` turns the
 * behavior on everywhere, `false` nowhere, and a predicate decides per schema
 * node — which is how a consumer expresses "trim these 34 string fields, not
 * the other 185" without the option becoming a whole-schema blunt instrument.
 * Because it runs during compilation, a predicate costs nothing at runtime.
 * @param {boolean|((node: Record<string, unknown>) => boolean)|undefined} option
 * @param {object} node - The schema node the switch applies to
 * @returns {boolean}
 */
export function resolveNormalizeSwitch(option, node) {
  if (option === true) return true;
  if (typeof option === 'function') return option(node) === true;
  return false;
}

/**
 * Compose a list of node steps into one function, skipping the empty case.
 * @param {Function[]} steps - The steps to run in order
 * @returns {Function|null} The composed step, or null when there is none
 */
function composeSteps(steps) {
  if (steps.length === 0) return null;
  if (steps.length === 1) return steps[0];
  return function runSteps(value) {
    let out = value;
    for (let i = 0; i < steps.length; i++)
      out = steps[i](out);
    return out;
  };
}

//#region where a default is filled

// A default fills an absent member, and every schema object that may apply
// at the object's place then reads that member: the object holding the
// default, the ones beside it (a `$ref` target, the other `allOf` branches)
// and the ones under a branch (`anyOf`, `oneOf`, `not`, `if`/`then`/`else`,
// `dependentSchemas`, `dependencies`, a dynamic reference's targets). One of
// them that refuses the member by its name — an
// `additionalProperties: false` it is not declared beside, an
// `unevaluatedProperties: false` it is not evaluated under — would refuse
// the normalized value where the validator accepted the input, so such a
// default is not filled. A branch's object counts, whichever branch the
// instance takes: which one applies is known only after validating.
// A place's schemas are read from the ones its parent's schemas apply to it
// (every object's `properties`, matching `patternProperties`,
// `additionalProperties`, the items keywords), so two branches that each
// describe a member are one place for that member's value.

/**
 * @typedef {object} DefaultPlace The schema objects that may apply at one place of an instance
 * @property {string} id - Its memo key: the same schema objects make the same place
 * @property {object[]} nodes - Every schema object that may apply there and reads its members or
 *   items ({@link PLACE_KEYWORDS}); the others refuse nothing and apply nothing below it
 * @property {(key: string) => boolean} admits - Whether none of them refuses a member named `key` by its name
 * @property {Map<string, DefaultPlace>} children - The places below it, by site
 */

/**
 * The draft a schema object is read under ({@link SchemaPlace}).
 * @param {object} node @param {object} ctx
 * @returns {number|null}
 */
function draftOf(node, ctx) {
  return schemaPlace(ctx.resources, node).draft;
}

/**
 * The pattern testers of a schema object's `patternProperties`, read as the
 * validator reads a pattern.
 * @param {any} node @param {object} ctx
 * @returns {[string, (key: string) => boolean][]}
 */
function patternsOf(node, ctx) {
  let testers = ctx.patterns.get(node);
  if (testers === undefined) {
    testers = isJsonObject(node.patternProperties)
      ? Object.getOwnPropertyNames(node.patternProperties).map((source) => [source, createSchemaPatternTester(source)])
      : [];
    ctx.patterns.set(node, testers);
  }
  return testers;
}

/**
 * Whether a member is declared beside an object's `additionalProperties`:
 * its `properties` name it or one of its `patternProperties` matches it.
 * @param {any} node @param {string} key @param {object} ctx
 * @returns {boolean}
 */
function declaresMember(node, key, ctx) {
  return (isJsonObject(node.properties) && hasOwn(node.properties, key))
    || patternsOf(node, ctx).some(([, matches]) => matches(key));
}

/**
 * The schema an object's `$ref` names in the document, resolved once.
 * @param {any} node @param {object} ctx
 * @returns {unknown}
 */
function refTarget(node, ctx) {
  if (ctx.targets.has(node)) return ctx.targets.get(node);
  const target = resolveSchemaReference(node.$ref, schemaPlace(ctx.resources, node).refBase, ctx.resources);
  ctx.targets.set(node, target);
  return target;
}

/**
 * The targets of an object's dynamic references (`$dynamicRef` from draft
 * 2020-12 on, `$recursiveRef` in 2019-09): the one each resolves to as a
 * `$ref`, and every object of the document declaring the anchor the dynamic
 * scope can resolve it to instead.
 * @param {any} node @param {number|null} draft @param {object} ctx
 * @returns {unknown[]}
 */
function dynamicTargets(node, draft, ctx) {
  const targets = [];
  for (const [keyword, anchor] of [['$dynamicRef', '$dynamicAnchor'], ['$recursiveRef', '$recursiveAnchor']]) {
    const ref = node[keyword];
    if (typeof ref !== 'string' || !admitsDynamicReference(/** @type {'$dynamicRef'|'$recursiveRef'} */ (keyword), draft)) continue;
    const target = resolveSchemaReference(ref, schemaPlace(ctx.resources, node).refBase, ctx.resources);
    if (target !== undefined) targets.push(target);
    const name = keyword === '$recursiveRef' ? true : ref.slice(ref.indexOf('#') + 1);
    const key = `${anchor}:${name}`;
    let declaring = ctx.anchors.get(key);
    if (declaring === undefined) {
      declaring = [...ctx.resources.places.keys()].filter((candidate) => candidate[anchor] === name);
      ctx.anchors.set(key, declaring);
    }
    targets.push(...declaring);
  }
  return targets;
}

/**
 * The subschemas that apply at the same place as a schema object, as the
 * validator reads them (`alone` where it reads only the object's `$ref`).
 * @param {any} node @param {object} ctx
 * @returns {{ alone: boolean, subschemas: unknown[] }}
 */
function inPlaceSubschemas(node, ctx) {
  const draft = draftOf(node, ctx);
  const subschemas = [];
  if (typeof node.$ref === 'string') subschemas.push(refTarget(node, ctx));
  if (readsRefAlone(node, draft, ctx.resources.held)) return { alone: true, subschemas };
  subschemas.push(...dynamicTargets(node, draft, ctx));
  for (const keyword of ['allOf', 'anyOf', 'oneOf'])
    if (Array.isArray(node[keyword])) subschemas.push(...node[keyword]);
  if (node.not !== undefined) subschemas.push(node.not);
  if (node.if !== undefined) subschemas.push(node.if, node.then, node.else);
  if (isJsonObject(node.dependentSchemas) && readsSince('dependentSchemas', draft))
    subschemas.push(...Object.values(node.dependentSchemas));
  if (isJsonObject(node.dependencies))
    subschemas.push(...Object.values(node.dependencies).filter((value) => !Array.isArray(value)));
  return { alone: false, subschemas };
}

/**
 * Whether a schema object evaluates a member on every way it passes, as
 * `unevaluatedProperties` reads the annotations below it: its own
 * `properties`, `patternProperties`, `additionalProperties` and (below the
 * object asking) `unevaluatedProperties`; a `$ref` target or an `allOf`
 * branch that does; every `anyOf`/`oneOf` branch and dynamic target; `if`
 * or `then`, and `else`. A `false` schema never passes, so it never leaves
 * the member unevaluated.
 * @param {unknown} node @param {string} key @param {object} ctx
 * @param {Set<object>} trail - The objects being asked, a cycle answering no
 * @param {boolean} [asking] - Whether `node` is the object whose `unevaluatedProperties` asks
 * @returns {boolean}
 */
function evaluatesMember(node, key, ctx, trail, asking = false) {
  if (node === false) return true;
  if (!isJsonObject(node) || trail.has(node)) return false;
  trail.add(node);
  const evaluates = (/** @type {unknown} */ schema) => evaluatesMember(schema, key, ctx, trail);
  const draft = draftOf(node, ctx);
  const target = typeof node.$ref === 'string' ? refTarget(node, ctx) : undefined;
  let answer;
  if (readsRefAlone(node, draft, ctx.resources.held)) answer = evaluates(target);
  else {
    const dynamic = dynamicTargets(node, draft, ctx);
    answer = declaresMember(node, key, ctx) || node.additionalProperties !== undefined
      || (!asking && node.unevaluatedProperties !== undefined && readsSince('unevaluatedProperties', draft))
      || evaluates(target)
      || (dynamic.length > 0 && dynamic.every(evaluates))
      || (Array.isArray(node.allOf) && node.allOf.some(evaluates))
      || (Array.isArray(node.anyOf) && node.anyOf.length > 0 && node.anyOf.every(evaluates))
      || (Array.isArray(node.oneOf) && node.oneOf.length > 0 && node.oneOf.every(evaluates))
      || (node.if !== undefined && (evaluates(node.if) || evaluates(node.then)) && evaluates(node.else));
  }
  trail.delete(node);
  return answer;
}

/**
 * Whether a schema object refuses a member by its name alone, whatever its
 * value: an `additionalProperties: false` it is not declared beside, or an
 * `unevaluatedProperties: false` (from draft 2019-09 on) it is not
 * evaluated under.
 * @param {any} node @param {string} key @param {object} ctx
 * @returns {boolean}
 */
function refusesMember(node, key, ctx) {
  if (node.additionalProperties === false && !declaresMember(node, key, ctx)) return true;
  return node.unevaluatedProperties === false && readsSince('unevaluatedProperties', draftOf(node, ctx))
    && !evaluatesMember(node, key, ctx, new Set(), true);
}

/**
 * A schema object's number in this compile, for a key naming it.
 * @param {object} node @param {object} ctx
 * @returns {number}
 */
function nodeId(node, ctx) {
  let id = ctx.nodeIds.get(node);
  if (id === undefined) ctx.nodeIds.set(node, id = ctx.nodeIds.size);
  return id;
}

/** The keywords through which a schema object refuses a member or applies a subschema below its place. */
const PLACE_KEYWORDS = ['properties', 'patternProperties', 'additionalProperties', 'unevaluatedProperties',
  'items', 'prefixItems', 'additionalItems', 'contains', 'unevaluatedItems'];

/**
 * The key naming a set of schema objects, the same for the same set.
 * @param {object[]} nodes @param {object} ctx
 * @returns {string}
 */
function nodesKey(nodes, ctx) {
  if (nodes.length === 1) return `|${nodeId(nodes[0], ctx)}`;
  return `|${[...new Set(nodes.map((node) => nodeId(node, ctx)))].sort((a, b) => a - b).join(',')}`;
}

/**
 * The place the given schema objects apply at, with every object that may
 * apply beside them. A place is the set of those objects that carry a
 * keyword reading its members or items, so two that share it are one.
 * @param {unknown[]} entries @param {object} ctx
 * @returns {DefaultPlace}
 */
function defaultPlace(entries, ctx) {
  const objects = entries.filter(isJsonObject);
  const entryKey = nodesKey(objects, ctx);
  let place = ctx.entryPlaces.get(entryKey);
  if (place !== undefined) return place;
  const nodes = [];
  const seen = new Set();
  const queue = objects;
  while (queue.length > 0) {
    const node = queue.pop();
    if (!isJsonObject(node) || seen.has(node)) continue;
    seen.add(node);
    const { alone, subschemas } = inPlaceSubschemas(node, ctx);
    if (!alone && PLACE_KEYWORDS.some((keyword) => node[keyword] !== undefined)) nodes.push(node);
    queue.push(...subschemas);
  }
  const id = nodesKey(nodes, ctx);
  place = ctx.defaultPlaces.get(id);
  if (place !== undefined) {
    ctx.entryPlaces.set(entryKey, place);
    return place;
  }
  const admitted = new Map();
  place = {
    id,
    nodes,
    admits(key) {
      let answer = admitted.get(key);
      if (answer === undefined) admitted.set(key, answer = !nodes.some((node) => refusesMember(node, key, ctx)));
      return answer;
    },
    children: new Map(),
  };
  ctx.defaultPlaces.set(id, place);
  ctx.entryPlaces.set(entryKey, place);
  return place;
}

/**
 * The place below `place` that a site of it reaches, from the subschemas
 * each of its objects applies there.
 * @param {DefaultPlace} place @param {string} site - The site's key
 * @param {(node: any, push: (schema: unknown) => void) => void} collect - Pushes an object's subschemas for the site
 * @param {object} ctx
 * @returns {DefaultPlace}
 */
function placeBelow(place, site, collect, ctx) {
  let child = place.children.get(site);
  if (child === undefined) {
    const entries = [];
    const push = (/** @type {unknown} */ schema) => { if (isJsonObject(schema)) entries.push(schema); };
    for (const node of place.nodes) {
      collect(node, push);
      if (node.unevaluatedProperties !== undefined && site.startsWith('p') && readsSince('unevaluatedProperties', draftOf(node, ctx)))
        push(node.unevaluatedProperties);
      if (node.unevaluatedItems !== undefined && site.startsWith('i') && readsSince('unevaluatedItems', draftOf(node, ctx)))
        push(node.unevaluatedItems);
      if (site.startsWith('i')) push(node.contains);
    }
    place.children.set(site, child = defaultPlace(entries, ctx));
  }
  return child;
}

/**
 * The place of a member's value, for a member named `key`.
 * @param {DefaultPlace} place @param {string} key @param {object} ctx
 * @returns {DefaultPlace}
 */
function memberPlace(place, key, ctx) {
  return placeBelow(place, `p:${key}`, (node, push) => {
    if (isJsonObject(node.properties) && hasOwn(node.properties, key)) push(node.properties[key]);
    for (const [source, matches] of patternsOf(node, ctx)) if (matches(key)) push(node.patternProperties[source]);
    if (!declaresMember(node, key, ctx)) push(node.additionalProperties);
  }, ctx);
}

/**
 * The place of the values of the members a `patternProperties` entry or an
 * `additionalProperties` of `holder` applies to: every subschema another
 * object may apply to such a member.
 * @param {DefaultPlace} place @param {any} holder @param {string|undefined} source - The pattern, undefined for `additionalProperties`
 * @param {object} ctx
 * @returns {DefaultPlace}
 */
function membersPlace(place, holder, source, ctx) {
  const matches = source === undefined
    ? (/** @type {string} */ key) => !declaresMember(holder, key, ctx)
    : createSchemaPatternTester(source);
  return placeBelow(place, `p${source === undefined ? '+' : '~'}${nodeId(holder, ctx)}:${source ?? ''}`, (node, push) => {
    if (isJsonObject(node.properties))
      for (const key of Object.getOwnPropertyNames(node.properties)) if (matches(key)) push(node.properties[key]);
    // the holder's own `additionalProperties` applies to no member one of
    // its patterns matches, and its patterns to no member it reads as additional
    if (source === undefined || node !== holder) push(node.additionalProperties);
    if (source !== undefined || node !== holder)
      for (const [pattern] of patternsOf(node, ctx)) push(node.patternProperties[pattern]);
  }, ctx);
}

/**
 * The tuple spelling an object's items are read in, as {@link buildArrayStep} reads it.
 * @param {any} node @param {object} ctx
 * @returns {{ prefix: unknown[], rest: unknown }}
 */
function itemsOf(node, ctx) {
  const itemsIsTuple = Array.isArray(node.items);
  const prefix = itemsIsTuple ? node.items : readPrefixItems({ declaredDraft: draftOf(node, ctx) }, node);
  return { prefix: Array.isArray(prefix) ? prefix : [], rest: itemsIsTuple ? node.additionalItems : node.items };
}

/**
 * The place of an item's value: the item at `index`, or with `rest`, every
 * item from `index` on.
 * @param {DefaultPlace} place @param {number} index @param {boolean} rest @param {object} ctx
 * @returns {DefaultPlace}
 */
function itemPlace(place, index, rest, ctx) {
  return placeBelow(place, `i${rest ? '+' : ''}${index}`, (node, push) => {
    const items = itemsOf(node, ctx);
    for (let i = index; i < items.prefix.length && (rest || i === index); i++) push(items.prefix[i]);
    if (rest || index >= items.prefix.length) push(items.rest);
  }, ctx);
}

/**
 * The context a subschema at a place below the one being compiled compiles
 * in: that place, reached through `site`; the same context where no
 * default is filled.
 * @param {any} ctx
 * @param {(place: DefaultPlace, ...rest: any[]) => DefaultPlace} site - {@link memberPlace}, {@link membersPlace} or {@link itemPlace}
 * @param {...any} args - The site's arguments, before the context
 * @returns {any}
 */
function below(ctx, site, ...args) {
  return ctx.defaultPlace === undefined ? ctx : { ...ctx, defaultPlace: site(ctx.defaultPlace, ...args, ctx) };
}

/**
 * Whether a document holds an object refusing a member by its name
 * (`additionalProperties: false`, `unevaluatedProperties: false`) anywhere,
 * a subschema a pointer reaches outside the schema positions included:
 * without one, every place admits every default.
 * @param {unknown} document
 * @returns {boolean}
 */
function refusesAnyMember(document) {
  const seen = new Set();
  const queue = [document];
  while (queue.length > 0) {
    const value = queue.pop();
    if (!isJsonContainer(value) || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) queue.push(value[i]);
      continue;
    }
    if (value.additionalProperties === false || value.unevaluatedProperties === false) return true;
    for (const key in value) if (hasOwn(value, key)) queue.push(value[key]);
  }
  return false;
}

/**
 * Whether a default of `holder` fills the member `key` at the place being
 * compiled; one a schema object there refuses is recorded as left unfilled.
 * @param {object} holder - The object whose `properties` declares the member
 * @param {string} key @param {object} ctx
 * @returns {boolean}
 */
function fillsDefault(holder, key, ctx) {
  if (ctx.defaultPlace === undefined || ctx.defaultPlace.admits(key)) return true;
  let keys = ctx.unfilled.get(holder);
  if (keys === undefined) ctx.unfilled.set(holder, keys = new Set());
  keys.add(key);
  return false;
}

//#endregion

/**
 * Build the object step: strip unknown members, normalize known ones, then
 * materialize defaults. That order is what makes the result stable - a
 * default is never stripped, and a stripped member never gets normalized.
 * @param {object} node - The schema node
 * @param {object} ctx - The compile context
 * @returns {Function|null} The step, or null when this node needs none
 */
function buildObjectStep(node, ctx) {
  const options = ctx.options;
  const properties = isJsonObject(node.properties) ? node.properties : null;
  const patternProperties = isJsonObject(node.patternProperties) ? node.patternProperties : null;
  const additional = node.additionalProperties;

  // Every declared name is recorded, including one whose subschema needs no
  // work: "declared but unchanged" and "not declared at all" are the same
  // lookup result otherwise, and stripping would delete a known member.
  // A null value means declared, nothing to do.
  const propertySteps = new Map();
  const defaults = [];
  let hasStep = false;
  if (properties !== null) {
    const keys = Object.getOwnPropertyNames(properties);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const sub = properties[key];
      const step = compileNode(sub, below(ctx, memberPlace, key));
      propertySteps.set(key, step);
      if (step !== null) hasStep = true;
      // Keep the property's step with its default. Matching pattern steps
      // are composed below so absent and supplied members normalize alike.
      if (isJsonObject(sub) && sub.default !== undefined && !readsRefAlone(sub, ctx.declaredDraft, ctx.resources.held)
        && resolveNormalizeSwitch(options.useDefaults, sub) && fillsDefault(node, key, ctx))
        defaults.push(key, sub.default, step);
    }
  }

  // Same for patterns: a pattern that matches makes a member known, whether
  // or not its subschema normalizes anything.
  const patternSteps = [];
  if (patternProperties !== null) {
    const sources = Object.getOwnPropertyNames(patternProperties);
    for (let i = 0; i < sources.length; i++) {
      const matches = createSchemaPatternTester(sources[i]);
      const step = compileNode(patternProperties[sources[i]], below(ctx, membersPlace, node, sources[i]));
      patternSteps.push(matches, step);
      if (step !== null) hasStep = true;
    }
  }

  const additionalStep = additional === undefined || typeof additional === 'boolean'
    ? null
    : compileNode(additional, below(ctx, membersPlace, node, undefined));

  // `true` strips only where the schema says the members are forbidden;
  // 'all' additionally strips members a declared shape simply does not
  // mention. Neither strips an object whose shape is undeclared - there,
  // every member is legitimately "additional".
  const declaresShape = properties !== null || patternProperties !== null;
  const strip = ctx.allowStrip && options.removeAdditional !== false
    && (additional === false || (options.removeAdditional === 'all' && declaresShape));

  const defaultCount = defaults.length;
  const patternCount = patternSteps.length;
  for (let i = 0; i < defaultCount; i += 3) {
    const steps = defaults[i + 2] === null ? [] : [defaults[i + 2]];
    for (let p = 0; p < patternCount; p += 2) {
      if (patternSteps[p + 1] !== null && patternSteps[p](defaults[i]))
        steps.push(patternSteps[p + 1]);
    }
    defaults[i + 2] = composeSteps(steps);
  }
  if (!hasStep && additionalStep === null && !strip && defaultCount === 0)
    return null;

  return function normalizeObject(value) {
    if (!isJsonObject(value)) return value;
    let out = value;
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const current = value[key];
      let next = current;
      // JSON Schema applies EVERY applicable subschema to a member, so a
      // member covered by `properties` and by one or more `patternProperties`
      // is normalized by all of them in turn. `additionalProperties` applies
      // only when nothing else did.
      // undefined = not declared; null = declared with nothing to do.
      const named = propertySteps.get(key);
      let covered = named !== undefined;
      if (named != null) next = named(next);
      for (let p = 0; p < patternCount; p += 2) {
        if (!patternSteps[p](key)) continue;
        covered = true;
        const patternStep = patternSteps[p + 1];
        if (patternStep !== null) next = patternStep(next);
      }
      if (!covered) {
        if (strip) {
          if (out === value) out = { ...value };
          delete out[key];
          continue;
        }
        if (additionalStep !== null) next = additionalStep(next);
      }
      if (next !== current) {
        if (out === value) out = { ...value };
        setObjectMember(out, key, next);
      }
    }
    for (let i = 0; i < defaultCount; i += 3) {
      const key = defaults[i];
      if (hasOwn(value, key)) continue;
      if (out === value) out = { ...value };
      // Each instance gets its own copy: a container default shared across
      // normalized documents would let a mutation of one leak into all. The
      // copy runs through the property and every matching pattern, in the
      // same order as a supplied value.
      const step = defaults[i + 2];
      const materialized = cloneJson(defaults[i + 1]);
      setObjectMember(out, key, step === null ? materialized : step(materialized));
    }
    return out;
  };
}

/**
 * Build the array step. Both tuple spellings are handled: draft 2020-12's
 * `prefixItems` + `items` (read only where the declared draft has
 * `prefixItems`), and draft-07's array-valued `items` + `additionalItems`.
 * @param {object} node - The schema node
 * @param {object} ctx - The compile context
 * @returns {Function|null} The step, or null when this node needs none
 */
function buildArrayStep(node, ctx) {
  const itemsIsTuple = Array.isArray(node.items);
  const prefixSource = itemsIsTuple ? node.items : readPrefixItems(ctx, node);
  const restSource = itemsIsTuple ? node.additionalItems : node.items;
  // A prefix with no work still occupies its declared positions: the tail
  // schema applies only after it, even when its step table was elided.
  const prefixLength = Array.isArray(prefixSource) ? prefixSource.length : 0;

  let prefixSteps = null;
  if (Array.isArray(prefixSource)) {
    prefixSteps = new Array(prefixSource.length);
    let used = false;
    for (let i = 0; i < prefixSource.length; i++) {
      prefixSteps[i] = compileNode(prefixSource[i], below(ctx, itemPlace, i, false));
      if (prefixSteps[i] !== null) used = true;
    }
    if (!used) prefixSteps = null;
  }

  const restStep = restSource === undefined || typeof restSource === 'boolean'
    ? null
    : compileNode(restSource, below(ctx, itemPlace, prefixLength, true));

  if (prefixSteps === null && restStep === null) return null;

  return function normalizeArray(value) {
    if (!Array.isArray(value)) return value;
    let out = value;
    for (let i = 0; i < value.length; i++) {
      const step = i < prefixLength ? (prefixSteps === null ? null : prefixSteps[i]) : restStep;
      if (step === null) continue;
      const current = value[i];
      const next = step(current);
      if (next !== current) {
        if (out === value) out = value.slice();
        out[i] = next;
      }
    }
    return out;
  };
}

/**
 * Whether `value` opens with the char code `open` once JSON whitespace
 * (space, tab, line feed, carriage return) is skipped.
 * @param {string} value
 * @param {number} open - The char code `{` or `[`
 * @returns {boolean}
 */
function opensWith(value, open) {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (!isWhitespaceCode(c)) return c === open;
  }
  return false;
}

/**
 * Build the JSON-text step: a string holding the JSON text of an object or
 * an array is replaced by the value it encodes, so the node's other steps
 * normalize the decoded container. A model's tool call delivers nested
 * structure this way, one quoted string where the schema wants an object.
 *
 * The step exists only where the string cannot be what was meant: the node's
 * own `type` names `object` or `array` and not `string`. A node without a
 * `type`, or one that admits a string, accepts the string as sent, and
 * decoding it would change a valid value. A node read as its `$ref` alone
 * (see {@link readsRefAlone}) builds no step of its own: its target decodes.
 *
 * Text that is not JSON, or encodes a scalar or the other container kind, is
 * returned unchanged so validation reports the string. The text is decoded
 * only when its first non-whitespace character opens a wanted container, so a
 * successful parse is that container and nothing else is attempted. Where
 * `trimStrings` applies, the trimmed text is read, as coercion reads it, so
 * padding the trim removes cannot leave text a second pass would decode.
 * @param {object} node - The schema node
 * @param {object} ctx - The compile context
 * @returns {Function|null} The step, or null when this node needs none
 */
function buildJsonTextStep(node, ctx) {
  if (!resolveNormalizeSwitch(ctx.options.coerceJsonText, node)) return null;
  const trim = resolveNormalizeSwitch(ctx.options.trimStrings, node);
  const types = typeof node.type === 'string' ? [node.type] : node.type;
  if (!Array.isArray(types) || types.includes('string')) return null;
  const wantsObject = types.includes('object');
  const wantsArray = types.includes('array');
  if (!wantsObject && !wantsArray) return null;

  return function normalizeJsonText(value) {
    if (typeof value !== 'string') return value;
    const source = trim ? value.trim() : value;
    if (!(wantsObject && opensWith(source, CC_LBRACE)) && !(wantsArray && opensWith(source, CC_LBRACKET))) return value;
    try {
      return JSON.parse(source);
    }
    catch (_e) {
      return value;
    }
  };
}

/**
 * Build the scalar step: trim, then coerce. Trimming runs first so that a
 * padded transport value (`' 42 '` for a numeric field) reaches coercion in
 * the shape the grammar accepts.
 *
 * Trimming applies to every string the walk reaches, not only to nodes typed
 * `string`, because the value that needs trimming is frequently the one
 * declared as a number; it is a switch, not a keyword, so it applies at a
 * node read as its `$ref` alone too, where the sibling `type` coerces nothing.
 * @param {object} node - The schema node
 * @param {object} ctx - The compile context
 * @param {boolean} refAlone - Whether the node is read as its `$ref` alone
 * @returns {Function|null} The step, or null when this node needs none
 */
function buildScalarStep(node, ctx, refAlone) {
  const options = ctx.options;
  const trim = resolveNormalizeSwitch(options.trimStrings, node);
  // A union `type` gives no single conversion target, so coercion is skipped
  // rather than guessed.
  const coerceTo = !refAlone && resolveNormalizeSwitch(options.coerceTypes, node) && typeof node.type === 'string'
    ? node.type
    : null;
  if (!trim && coerceTo === null) return null;

  if (coerceTo === null) {
    return function normalizeTrim(value) {
      return typeof value === 'string' ? value.trim() : value;
    };
  }
  if (!trim) {
    return function normalizeCoerce(value) {
      return coerceToType(value, coerceTo);
    };
  }
  return function normalizeTrimCoerce(value) {
    return coerceToType(typeof value === 'string' ? value.trim() : value, coerceTo);
  };
}

/**
 * Whether the validator reads `node` as its `$ref` alone: the node holds a
 * `$ref`, and the draft it is read under (its own `$schema`, else the
 * inherited one; draft-07 where the document declares none, as `compile`
 * reads it) ignores the keywords beside one ({@link appliesRefSiblings}).
 * Nothing beside that `$ref` normalizes: not a sibling `type`, `properties`,
 * `items`, `allOf` or `additionalProperties`, and not its `default`.
 * Exported for `@jarenjs/emit`, whose generated types read the same node
 * the same way.
 * @param {Record<string, any>} node - A schema object
 * @param {number|null} declaredDraft - The draft its parent is read under, or null when none is declared
 * @param {{ get(key: string): unknown }} [held] - The schemas a validator holds, a `$schema` of the
 *   node is read through ({@link SchemaResources}' `held`); its name alone without
 * @returns {boolean}
 */
export function readsRefAlone(node, declaredDraft, held = undefined) {
  if (typeof node.$ref !== 'string') return false;
  const draft = typeof node.$schema === 'string' ? detectSchemaDraft(node, held) : declaredDraft;
  return !appliesRefSiblings(draft ?? 7);
}

/**
 * Compile one schema node into a normalizer step, or null when the node
 * cannot change anything. Recursive schemas are handled by publishing a
 * deferring placeholder into the memo before the node is built, so a `$ref`
 * back to an ancestor resolves to a function that is complete by the time it
 * is called.
 * @param {object|boolean} node - The schema node
 * @param {object} ctx - The compile context
 * @returns {Function|null} The step, or null
 */
function compileNode(node, ctx) {
  if (!isJsonObject(node)) return null;
  // A schema that declares `$schema` is read per that draft, and the
  // subschemas below it inherit it, as the validator reads them. The
  // normalizer holds no meta-schemas: a dialect it does not know by name is
  // read as draft-07, where the validator reads one it holds by its
  // meta-schema.
  if (typeof node.$schema === 'string') {
    const declaredDraft = detectSchemaDraft(node, ctx.resources.held);
    if (declaredDraft !== ctx.declaredDraft) ctx = { ...ctx, declaredDraft };
  }

  // One node reached under two drafts (inline and as a reference target)
  // normalizes per draft, and at two places per place (the defaults it
  // fills: {@link defaultPlace}).
  const memoKey = `${ctx.allowStrip}${ctx.declaredDraft}${ctx.defaultPlace?.id ?? ''}`;
  let memo = ctx.memos.get(memoKey);
  if (memo === undefined) ctx.memos.set(memoKey, memo = new Map());
  const cached = memo.get(node);
  if (cached !== undefined) return cached;

  let built = null;
  const deferred = function normalizeDeferred(value) {
    return built === null ? value : built(value);
  };
  memo.set(node, deferred);

  const steps = [];

  // Before draft 2019-09, and in a document declaring no draft, the
  // validator reads a `$ref` alone: the keywords beside it apply nothing.
  // Such a node normalizes as its target and nothing else, so a sibling the
  // validator never reads cannot coerce, decode, strip or default a value
  // the reference accepts into one it refuses.
  const refAlone = readsRefAlone(node, ctx.declaredDraft, ctx.resources.held);

  // Decoding comes first: every other step of this node, the reference and
  // the `allOf` branches included, reads the decoded container.
  const jsonTextStep = refAlone ? null : buildJsonTextStep(node, ctx);
  if (jsonTextStep !== null) steps.push(jsonTextStep);

  if (typeof node.$ref === 'string') {
    // Resolved against the base of the resource holding the node, and read
    // in the draft its place in the document declares, as the validator
    // reads it.
    const target = refTarget(node, ctx);
    // A ref this module cannot follow is left alone rather than guessed at;
    // validation still resolves it through the full ref machinery.
    if (target !== undefined && target !== node) {
      const declaredDraft = isJsonObject(target) ? schemaPlace(ctx.resources, target).draft : ctx.declaredDraft;
      const step = compileNode(target, declaredDraft === ctx.declaredDraft ? ctx : { ...ctx, declaredDraft });
      if (step !== null) steps.push(step);
    }
  }

  // `allOf` branches all apply, so they compose, once and in declaration
  // order (the order is part of the contract: see the README). Stripping is
  // disabled for the whole subtree underneath: a branch declares only its own share of
  // the object, so what looks "additional" to it may be exactly what a
  // sibling branch declares. Composition-shaped schemas therefore keep their
  // members; only defaults, coercion and trimming flow through.
  if (!refAlone) {
    if (Array.isArray(node.allOf)) {
      const branchCtx = ctx.allowStrip ? { ...ctx, allowStrip: false } : ctx;
      for (let i = 0; i < node.allOf.length; i++) {
        const step = compileNode(node.allOf[i], branchCtx);
        if (step !== null) steps.push(step);
      }
    }

    const objectStep = buildObjectStep(node, ctx);
    if (objectStep !== null) steps.push(objectStep);

    const arrayStep = buildArrayStep(node, ctx);
    if (arrayStep !== null) steps.push(arrayStep);
  }

  const scalarStep = buildScalarStep(node, ctx, refAlone);
  if (scalarStep !== null) steps.push(scalarStep);

  built = composeSteps(steps);
  memo.set(node, built);
  // Callers that resolved this node while it was being built hold `deferred`;
  // everyone else gets the direct function.
  return built === null ? null : deferred;
}

/**
 * The compile context of a normalizer of `schema`: the options resolved,
 * the document's resources and, where defaults are filled, the place of its
 * root ({@link defaultPlace}).
 * @param {object|boolean} schema
 * @param {NormalizeOptions} options
 * @returns {any}
 */
function normalizerContext(schema, options) {
  admitNormalizeOptions(options);
  const resolved = {
    useDefaults: options.useDefaults,
    removeAdditional: options.removeAdditional === 'all'
      ? 'all'
      : options.removeAdditional === true,
    coerceTypes: options.coerceTypes,
    trimStrings: options.trimStrings,
    coerceJsonText: options.coerceJsonText,
  };
  const ctx = {
    options: resolved,
    /** The document's resources: the base each reference resolves against, the draft each node is read under */
    resources: indexSchemaResources(schema, { dialects: options.dialects }),
    /** @type {number|null} The draft the schema being compiled declares, or null when none does */
    declaredDraft: null,
    /** @type {Map<string, Map<object, Function|null>>} The compiled steps per stripping mode, draft and place */
    memos: new Map(),
    allowStrip: true,
    /** @type {DefaultPlace|undefined} The place being compiled, where defaults are filled */
    defaultPlace: undefined,
    /** @type {Map<string, DefaultPlace>} Every place met, by its id */
    defaultPlaces: new Map(),
    /** @type {Map<string, DefaultPlace>} Every place met, by the objects it was reached from */
    entryPlaces: new Map(),
    /** @type {Map<object, unknown>} Each `$ref`'s target */
    targets: new Map(),
    /** @type {Map<object, number>} Each schema object a place names, numbered */
    nodeIds: new Map(),
    /** @type {Map<object, [string, (key: string) => boolean][]>} Each object's pattern testers */
    patterns: new Map(),
    /** @type {Map<string, object[]>} The objects declaring each dynamic anchor */
    anchors: new Map(),
    /** @type {Map<object, Set<string>>} The members whose default a place refuses, by the object declaring them */
    unfilled: new Map(),
  };
  if ((resolved.useDefaults === true || typeof resolved.useDefaults === 'function') && refusesAnyMember(schema))
    ctx.defaultPlace = defaultPlace([schema], ctx);
  return ctx;
}

/**
 * The defaults `compileNormalizer(schema, options)` leaves unfilled at some
 * place of the document: one whose member a schema object that may apply
 * there refuses by its name (an `additionalProperties: false` it is not
 * declared beside, an `unevaluatedProperties: false` it is not evaluated
 * under). Exported for `@jarenjs/emit`, whose normalized types claim a
 * defaulted member present only where the normalizer fills it.
 * @param {object|boolean} schema - The schema a normalizer is compiled from
 * @param {NormalizeOptions} [options] - Its options (`useDefaults` and `dialects` decide)
 * @returns {Map<object, Set<string>>} The member names, by the schema object whose `properties` declares them
 * @throws {TypeError} As {@link compileNormalizer} does for `options`
 */
export function unfilledDefaults(schema, options = {}) {
  const ctx = normalizerContext(schema, options);
  compileNode(schema, ctx);
  return ctx.unfilled;
}

/** The members of `NormalizeOptions`; any other is refused. */
const NORMALIZE_OPTIONS = Object.freeze(['useDefaults', 'removeAdditional', 'coerceTypes', 'trimStrings', 'coerceJsonText', 'dialects']);

/**
 * Refuse a malformed options object before anything compiles: every
 * switch is opt-in, so a misspelt or mistyped one would leave the
 * normalization off without a word. A host programming error, so a
 * `TypeError` naming the nearest member.
 * @param {unknown} options
 */
function admitNormalizeOptions(options) {
  if (!isPlainOptions(options)) throw new TypeError('compileNormalizer: options must be a plain object');
  refuseUnknownMembers(options, NORMALIZE_OPTIONS,
    (key, hint) => new TypeError(`compileNormalizer: unknown option '${key}'${hint}`));
  for (const name of ['useDefaults', 'coerceTypes', 'trimStrings', 'coerceJsonText']) {
    const value = options[name];
    if (value !== undefined && typeof value !== 'boolean' && typeof value !== 'function')
      throw new TypeError(`compileNormalizer: '${name}' must be true, false or a function of the schema node`);
  }
  const strip = options.removeAdditional;
  if (strip !== undefined && typeof strip !== 'boolean' && strip !== 'all')
    throw new TypeError("compileNormalizer: 'removeAdditional' must be true, false or 'all'");
  heldDialects(options.dialects, 'compileNormalizer');
}

/**
 * Compile a JSON Schema into a normalizer: a function that returns a
 * normalized copy of its input, leaving the input untouched.
 *
 * Validation is unaffected and unchanged - normalize first, then hand the
 * result to a compiled validator:
 *
 * ```javascript
 * const normalize = compileNormalizer(schema, { useDefaults: true, trimStrings: true });
 * const validate = new JarenValidator({ collectErrors: true }).compile(schema);
 * const shaped = normalize(input);
 * const result = validate(shaped);
 * ```
 *
 * **What is normalized.** `properties`, `patternProperties`,
 * `additionalProperties`, `items`/`prefixItems`/`additionalItems`, `$ref`
 * within the document (resolved against the base of the resource holding it,
 * as the validator resolves it: {@link resolveSchemaReference}), and `allOf`
 * (composed, with stripping disabled inside it). Before draft 2019-09, and where no draft
 * is declared, a node holding a `$ref` normalizes as its target alone, as the
 * validator reads it: nothing beside the `$ref`, its `default` included. With `coerceJsonText`, a string holding
 * an object's or array's JSON text is decoded wherever such a node's `type`
 * wants that container and admits no string, at any depth, before the node's
 * other steps run on the decoded value. `allOf` branches run once, in
 * declaration order, each on the previous step's output, so a default
 * supplied by a later branch is not coerced by an earlier one until the next
 * application; keep `type` and `default` on one property schema, or list the
 * defaulting branch first, when one application must be enough. A materialized root default passes
 * through the same normalization steps as an explicitly supplied value.
 * A property default runs through that property's schema and every matching
 * `patternProperties` schema, in the same order as a supplied member. A
 * default is not filled where a schema object that may apply at its place —
 * beside it, or under a branch, which only validating decides — refuses its
 * member by its name: an `additionalProperties: false` it is not declared
 * beside, an `unevaluatedProperties: false` it is not evaluated under
 * ({@link unfilledDefaults}); the validator would refuse the normalized value.
 *
 * **Which dialect.** A `$schema` is read by its name: a URI naming a known
 * draft reads as that draft, and any other — a custom dialect — as draft-07.
 * A validator reads a custom dialect through the meta-schema it holds (one
 * extending 2020-12 reads as 2020-12); pass that validator as `dialects` to
 * read each `$schema` as its compile does.
 *
 * **What is not, and why.** `anyOf`, `oneOf`, `if`/`then`/`else` and `not`
 * are not descended: which branch applies is only known after validating,
 * and normalizing under a branch can change which branch validates. Nothing
 * arbitrary runs either - there is no transform hook, because an arbitrary
 * transform is application code, not schema semantics, and belongs on the
 * caller's side of the boundary.
 * @template [In=unknown]
 * @template [Out=In]
 * @param {object|boolean} schema - The schema to compile
 * @param {NormalizeOptions} [options] - Which normalizations to apply
 * @returns {Normalizer<In, Out>} The compiled normalizer
 * @throws {TypeError} When `options` is not a plain object, names a member
 *   outside `NormalizeOptions`, or gives one a value of the wrong type - a
 *   misspelt switch would otherwise compile a normalizer that does nothing
 *   (`dialects` that is no `JarenValidator` included)
 * @example
 * const normalize = compileNormalizer({
 *   type: 'object',
 *   properties: {
 *     name: { type: 'string' },
 *     port: { type: 'integer', default: 8080 },
 *   },
 *   additionalProperties: false,
 * }, { useDefaults: true, removeAdditional: true, coerceTypes: true, trimStrings: true });
 *
 * const input = { name: '  jaren  ', port: '9000', stray: 1 };
 * normalize(input);  // { name: 'jaren', port: 9000 }
 * input;             // { name: '  jaren  ', port: '9000', stray: 1 } - untouched
 */
export function compileNormalizer(schema, options = {}) {
  const ctx = normalizerContext(schema, options);
  const resolved = ctx.options;
  const step = compileNode(schema, ctx);

  // A root `default` answers the "the whole document was absent" case, which
  // no member walk can reach.
  const rootDefault = isJsonObject(schema) && schema.default !== undefined && !readsRefAlone(schema, null, ctx.resources.held)
    && resolveNormalizeSwitch(resolved.useDefaults, schema)
    ? schema.default
    : undefined;

  if (step === null && rootDefault === undefined)
    return function normalizeIdentity(data) { return data; };

  if (rootDefault === undefined) {
    return function normalize(data) { return step(data); };
  }
  return function normalizeWithRootDefault(data) {
    if (data === undefined) {
      const value = cloneJson(rootDefault);
      return step === null ? value : step(value);
    }
    return step === null ? data : step(data);
  };
}

//#endregion
