//@ts-check
/**
 * @file The validator's reading of a schema document's references, for a
 * reader that resolves them without compiling the schema: the resources a
 * document holds (each embedded `$id` starts one) with their plain names,
 * the base each schema object's `$ref` resolves against, a same-document
 * `$ref` read from the document's root, and whether a `$ref` is read alone.
 * Beside them, two readings such a reader takes without the validator: the
 * draft a `$schema` declares ({@link detectSchemaDraft}) and a `pattern`
 * string ({@link createSchemaPatternTester}).
 *
 * The normalizer, `@jarenjs/emit`, the strict profile, `@jarenjs/contract`,
 * `@jarenjs/forms` and `@jarenjs/db` resolve references through these
 * functions, so a reference names for each of them what it names for the
 * validator. This module imports neither the validator nor `@jarenjs/json`'s
 * index and query compiler: Node's loader loads every module a static
 * import names, so a reader that imports `@jarenjs/validate/references`
 * loads this reading alone. `@jarenjs/validate/normalize` re-exports every
 * function here and loads the validator, which checks its defaults.
 */

import { isJsonContainer, isJsonObject } from '@jarenjs/core/object';
import { isStringWhiteSpace } from '@jarenjs/core/string';
import { parseJSONPointer } from '@jarenjs/json/pointer';
import {
  TRAVERSE_SCHEMA_OBJECTS,
  TRAVERSE_SCHEMA_MAPS,
  TRAVERSE_SCHEMA_MAP_MAPS,
  admitsPropertyDependencies,
  detectSchemaDraft,
  dialectDraft,
  identifierKeyword,
  identifierText,
} from './schema-keywords.js';
import { createSchemaPatternTester } from './string.js';
import { DEFAULT_ORIGIN, encodeJsonPointerPath, withoutFragment } from './origin.js';
import { appliesRefSiblings } from './dynamic-ref.js';
import { heldDialects } from './validator-state.js';

export { createSchemaPatternTester, detectSchemaDraft };

/**
 * @typedef {object} SchemaPlace Where one schema object of a document sits
 * @property {string} base - The base URI of the resource holding it: its own, when its identifier starts one
 * @property {string} refBase - The base its `$ref` resolves against: `base`, or the enclosing
 *   resource's where its identifier sits beside a `$ref` read alone (before draft 2019-09)
 * @property {number|null} draft - The draft it is read under: the nearest `$schema` at or above
 *   it ({@link detectSchemaDraft}), null where none is declared
 * @property {number|null} declared - The known draft its document declares ({@link dialectDraft}),
 *   null for none or an unknown one
 * @property {string|undefined} pointer - Its fragment in the resource at `base` (`#/properties/a`),
 *   undefined where a pointer reached it outside the schema positions
 * @property {string|undefined} dialect - The `$schema` governing it: the nearest at or above it in
 *   its document, undefined for none (or where a pointer reached it outside the schema positions)
 */

/**
 * @typedef {object} SchemaResources The schema resources of one or more documents
 * @property {Map<object, SchemaPlace>} places - Every schema object, by identity
 * @property {Map<string, { node: object|boolean, names: Map<string, object> }>} resources - Each
 *   resource by its base URI (no fragment): its root and its plain names
 * @property {{ get(key: string): unknown }} [held] - The schemas a validator holds, by URI, a
 *   `$schema` is read through ({@link heldDialects}); absent where it is read by its name alone
 * @property {Set<string>} named - The `$schema` URIs the documents name
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
 * scope would make a type or a profile disagree with the normalizer.
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
  const index = options.into ?? { places: new Map(), resources: new Map(), named: new Set() };
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
  const { places, resources, held, named } = index;
  const seen = new Set();
  /**
   * @param {any} node @param {string} base @param {number|null} parentDraft
   * @param {number|null} parentDeclared
   * @param {{ node: object|boolean, names: Map<string, object> }|undefined} resource
   * @param {boolean} isRoot
   * @param {string|undefined} at - Its JSON Pointer in the resource holding it, as a URI fragment spells it
   * @param {string|undefined} parentDialect - The `$schema` governing the place above it
   */
  const walk = (node, base, parentDraft, parentDeclared, resource, isRoot, at, parentDialect) => {
    if (!isJsonContainer(node) || seen.has(node) || places.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i], base, parentDraft, parentDeclared, resource, false, at === undefined ? at : `${at}/${i}`, parentDialect);
      return;
    }
    const dialect = typeof node.$schema === 'string' ? node.$schema : parentDialect;
    // The draft a document declares is inherited by everything below it.
    if (typeof node.$schema === 'string') named.add(node.$schema);
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
    // a resource's root is its URI's empty fragment
    if (resource !== undefined && (isRoot || own !== base)) at = '';
    places.set(node, { base: own, refBase: !isRoot && readsRefAlone(node, parentDraft, held) ? base : own, draft, declared,
      pointer: at === undefined ? undefined : `#${at}`, dialect });
    for (const keyword of ['$anchor', '$dynamicAnchor'])
      if (typeof node[keyword] === 'string') declare(plainNameKey(`#${node[keyword]}`));
    // Only schema positions are schemas. Annotation values such as defaults
    // and examples are instance data, even when they contain $id or $anchor.
    const pointerOf = (/** @type {string} */ key, /** @type {string[]} */ [member, inner] = []) => {
      if (at === undefined) return at;
      const path = encodeJsonPointerPath(at, key);
      return member === undefined ? path : inner === undefined ? encodeJsonPointerPath(path, member) : encodeJsonPointerPath(encodeJsonPointerPath(path, member), inner);
    };
    for (const key of Object.keys(node)) {
      if (TRAVERSE_SCHEMA_OBJECTS.includes(key)) walk(node[key], own, draft, declared, resource, false, pointerOf(key), dialect);
      else if (TRAVERSE_SCHEMA_MAPS.includes(key) && isJsonObject(node[key])) {
        for (const member of Object.keys(node[key])) walk(node[key][member], own, draft, declared, resource, false, pointerOf(key, [member]), dialect);
      }
      else if (TRAVERSE_SCHEMA_MAP_MAPS.includes(key) && admitsPropertyDependencies(propertyDependencies, draft)
        && isJsonObject(node[key])) {
        for (const member of Object.keys(node[key])) {
          const inner = node[key][member];
          if (!isJsonObject(inner)) continue;
          for (const name of Object.keys(inner)) walk(inner[name], own, draft, declared, resource, false, pointerOf(key, [member, name]), dialect);
        }
      }
    }
  };
  // a subtree a pointer reached outside the schema positions has no pointer of its own here
  walk(start, startBase, startDraft, startDeclared, startResource, startResource !== undefined, startResource === undefined ? undefined : '', undefined);
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
 * Whether the validator reads `node` as its `$ref` alone: the node holds a
 * `$ref`, and the draft it is read under (its own `$schema`, else the
 * inherited one; draft-07 where the document declares none, as `compile`
 * reads it) ignores the keywords beside one ({@link appliesRefSiblings}).
 * The normalizer normalizes nothing beside that `$ref`: not a sibling
 * `type`, `properties`, `items`, `allOf` or `additionalProperties`, and
 * not its `default`.
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
