import {
  isBoolOrObjectClass,
  hasSchemaReference,
  hasRefSiblings,
  REF_SIBLING_KEYWORDS,
} from './tools.js';

import { getSchemaFormatCompiler } from './format.js';

import {
  isBoolishType,
} from '@jarenjs/core/number';

import {
  isObjectClass,
  isStringType,
} from '@jarenjs/core';

import {
  isStringWhiteSpace,
} from '@jarenjs/core/string';

import {
  isValidHtmlIdentifier,
} from '@jarenjs/core/text';

import {
  encodeJSONPointerSegment,
  decodeJSONPointerSegment,
} from '@jarenjs/json/pointer';

import {
  TRAVERSE_SCHEMA_OBJECTS,
  TRAVERSE_SCHEMA_MAPS,
  TRAVERSE_SCHEMA_MAP_MAPS,
  detectSchemaDraft,
  admitsPropertyDependencies,
} from './schema-keywords.js';

import { SchemaCompileError } from './errors.js';

function encodeJsonPointerKey(key) {
  return encodeURIComponent(encodeJSONPointerSegment(key));
}

export function encodeJsonPointerPath(path, key, index) {
  return index == null
    ? `${path}/${encodeJsonPointerKey(key)}`
    : `${path}/${encodeJsonPointerKey(key)}/${encodeJsonPointerKey(String(index))}`;
}

function decodeJsonPointerKey(key) {
  // Lenient decode: `$ref` fragments arrive here unvalidated, so a stray
  // `~` must pass through instead of throwing like the strict parser does.
  // The percent-decode is this site's own: these keys arrive from a URI
  // fragment, which the plain reference-token decode knows nothing about.
  return decodeJSONPointerSegment(decodeURIComponent(key));
}

export function decodeJsonPointerPath(path) {
  // split and remove the leading empty string
  return path.split('/').map(decodeJsonPointerKey).splice(1);
}

class JsonPointerOptions {
  constructor(anchorsGlobal = false, anchorsAllowed = true, skipErrors = true) {
    this.anchorsGlobal = anchorsGlobal;
    this.anchorsAllowed = anchorsAllowed;
    this.skipErrors = skipErrors;
  }
}

class JsonPointer {
  constructor(id, search, leftUri, fragment) {
    this.id = id;
    this.search = search;
    this.leftUri = leftUri;
    this.fragment = fragment;
  }
}

export function createJsonPointer(refUri, baseUri, opts = new JsonPointerOptions()) {
  let url;
  try {
    url = !isStringType(refUri) || isStringWhiteSpace(refUri)
      ? new URL(baseUri)
      : !isStringType(baseUri) || isStringWhiteSpace(baseUri)
        ? new URL(refUri)
        : new URL(refUri, baseUri);
  } catch (e) {
    // Handle case where baseUri is a relative reference (not a valid URL)
    // Only apply manual resolution when baseUri is a plain identifier (no scheme, no /)
    const isRelativeBase = isStringType(baseUri) && !/^[a-z][a-z0-9+.-]*:/i.test(baseUri);
    
    if (isStringType(refUri) && isRelativeBase) {
      // If refUri is absolute (has a scheme), use it as-is
      if (/^[a-z][a-z0-9+.-]*:/i.test(refUri)) {
        url = new URL(refUri);
      } else if (refUri.startsWith('#')) {
        // Fragment-only reference: combine with baseUri
        const effectiveBase = baseUri;
        url = new URL(refUri, 'http://example.com/' + effectiveBase);
        // Restore the original baseUri in the result
        const href = url.href.replace('http://example.com/', '');
        const [, fragment] = href.split('#');
        return new JsonPointer(
          effectiveBase + refUri,
          undefined,
          effectiveBase + '#',
          fragment || null
        );
      } else if (refUri.includes('#')) {
        // refUri has a fragment: manual resolution
        const [refBase, refFragment] = refUri.split('#');
        const resolvedId = baseUri.endsWith('/') 
          ? baseUri + refBase + '#' + refFragment
          : baseUri + '/' + refBase + '#' + refFragment;
        return new JsonPointer(
          resolvedId,
          undefined,
          baseUri + '#',
          refFragment
        );
      } else {
        // No fragment: simple concatenation
        const resolvedId = baseUri.endsWith('/')
          ? baseUri + refUri
          : baseUri + '/' + refUri;
        return new JsonPointer(resolvedId + '#', undefined, resolvedId + '#', null);
      }
    } else {
      // Re-throw the original error if we can't handle it
      throw e;
    }
  }

  const [uri, fragment] = url.href.split('#');
  const [leftUri, search] = uri.split('?');

  if (!isStringWhiteSpace(fragment)) {
    // this is a sort of $anchor and we are karen about it and thus not use isStringAnchor().
    if (opts.anchorsAllowed == true && isValidHtmlIdentifier(fragment)) {
      return opts.anchorsGlobal == true
        ? new JsonPointer(`#${fragment}`, search, `${leftUri}#`, fragment)
        : new JsonPointer(`${leftUri}#${fragment}`, search, `${leftUri}#`, fragment);
    }
    // or a json pointer
    else if (fragment.startsWith('/')) {
      return new JsonPointer(`${leftUri}#${fragment}`, search, `${leftUri}#`, fragment);
    }
  }
  return new JsonPointer(`${leftUri}#`, search, `${leftUri}#`, null);
}

/**
 * Register a schema document's identifiers (`$id`/`id`, `$anchor`,
 * `$dynamicAnchor`) in `schemas`, and every `$ref` target it names as a
 * `null` placeholder that {@link restoreSchemaRefsInMap} resolves.
 * @param {Map<string, any>} schemas - The map to register into
 * @param {string} baseUri - The URI the document was retrieved from
 * @param {any} schema - The document
 * @param {JsonPointerOptions} [opts]
 * @param {(target: JsonPointer, location: string) => void} [onReference] -
 *   Offered the resolved target of every `$ref` and `$dynamicRef` the walk
 *   reaches, with the reference's location in the document as a URI
 *   fragment (`#/properties/a/%24ref`)
 * @returns {string} The document's own id
 */
export function storeSchemaIdsInMap(schemas, baseUri, schema, opts = new JsonPointerOptions(), onReference = undefined) {
  if (!isObjectClass(schema)) {
    const { id } = createJsonPointer(baseUri, undefined, opts);
    schemas.set(id, schema);
    return id;
  }

  const { id: rootUri } = createJsonPointer(schema.$id, baseUri, opts);
  if (!isStringType(schema.$id) || isStringWhiteSpace(schema.$id)) {
    if (schemas.has(rootUri) && schemas.get(rootUri) !== schema)
      throw new Error(`Schema '${rootUri}' already exists`);

    schemas.set(rootUri, schema);
  }

  baseUri = rootUri;

  const queue = [{ obj: schema, base: rootUri, path: '#', draft: null }];
  while (queue.length > 0) {
    // @ts-ignore
    const { obj, base, path, draft: inheritedDraft } = queue.shift();
    // The draft a document declares is inherited by everything below it.
    const draft = isStringType(obj.$schema) ? detectSchemaDraft(obj) : inheritedDraft;

    // Handle $id (draft 6+) or id (draft 4) for identifying subschemas
    const idKeyword = isStringType(obj.$id) ? obj.$id : isStringType(obj.id) ? obj.id : undefined;
    if (isStringType(idKeyword) && !isStringWhiteSpace(idKeyword)) {
      const { id } = createJsonPointer(idKeyword, base, opts);
      if (!schemas.has(id))
        schemas.set(id, obj);
      else if (schemas.get(id) == null || schemas.get(id) === obj)
        schemas.set(id, obj);
      else
        throw new Error(`Schema '${id}' for path '${path}' in '${base}' already exists`);

      // CHECK: Also store under alternate ID (with/without # suffix) for absolute URIs only
      if (!id.startsWith('#')) {
        const altId = id.endsWith('#') ? id.slice(0, -1) : id + '#';
        if (!schemas.has(altId)) {
          schemas.set(altId, obj);
        }
      }

      // we reset the baseUri when the $id property is set.
      baseUri = id;
    }
    else
      baseUri = base;

    if (isStringType(obj.$anchor) && !isStringWhiteSpace(obj.$anchor)) {
      const { id } = createJsonPointer(`#${obj.$anchor}`, baseUri, opts);
      if (!schemas.has(id))
        schemas.set(id, obj);
      else if (schemas.get(id) == null || schemas.get(id) === obj)
        schemas.set(id, obj);
      else
        throw new Error(`Schema '${id}' for path '${path}' in '${base}' already exists`);

      // we reset the baseUri when the $anchor property is set.
      if (!id.startsWith('#')) // except when anchors are global
        baseUri = id;
    }

    // Handle $dynamicAnchor (draft 2020-12) - similar to $anchor but for $dynamicRef
    if (isStringType(obj.$dynamicAnchor) && !isStringWhiteSpace(obj.$dynamicAnchor)) {
      const { id } = createJsonPointer(`#${obj.$dynamicAnchor}`, baseUri, opts);
      if (!schemas.has(id))
        schemas.set(id, obj);
      else if (schemas.get(id) == null || schemas.get(id) === obj)
        schemas.set(id, obj);
      else
        throw new Error(`Schema '${id}' for path '${path}' in '${base}' already exists`);

      // Note: $dynamicAnchor does NOT change the baseUri like $anchor does
      // It's only used for $dynamicRef resolution
    }

    if (onReference !== undefined && hasSchemaReference(obj, '$dynamicRef'))
      onReference(createJsonPointer(obj.$dynamicRef, baseUri, opts), encodeJsonPointerPath(path, '$dynamicRef'));

    if (isStringType(obj.$ref) && !isStringWhiteSpace(obj.$ref)) {
      const target = createJsonPointer(obj.$ref, baseUri, opts);
      const ref = target.id;
      if (!schemas.has(ref))
        schemas.set(ref, null);
      if (onReference !== undefined) onReference(target, encodeJsonPointerPath(path, '$ref'));

      // Don't continue here - we need to process other schemas in the same
      // parent object (like definitions) even if this one has a $ref.
      // The $ref just means we don't traverse INTO this object's properties,
      // but siblings should still be processed.
    }

    // iterate through all properties
    for (const [key, value] of Object.entries(obj)) {
      if (!isObjectClass(value) && !Array.isArray(value))
        continue;

      // is the property a schema object to traverse in?
      if (TRAVERSE_SCHEMA_OBJECTS.includes(key)) {
        if (Array.isArray(value)) {
          const len = value.length;
          for (let index = 0; index < len; index++) {
            const item = value[index];
            const nextpath = encodeJsonPointerPath(path, key, index);

            if (isBoolishType(item))
              continue;
            if (!isObjectClass(item)) {
              if (opts.skipErrors === true)
                continue;
              else
                throw new Error(`${nextpath} is not a schema`);
            }

            queue.push({ obj: item, base: baseUri, path: nextpath, draft });
          }
        }
        else {
          const nextpath = encodeJsonPointerPath(path, key);

          queue.push({ obj: value, base: baseUri, path: nextpath, draft });
        }
      }
      // or is the property a map of key and schema objects?
      else if (TRAVERSE_SCHEMA_MAPS.includes(key)) {
        if (Array.isArray(value))
          continue;

        for (const [index, item] of Object.entries(value)) {
          const nextpath = encodeJsonPointerPath(path, key, index);
          if (isBoolishType(item))
            continue;
          if (!isObjectClass(item)) {
            if (opts.skipErrors === true)
              continue;
            else
              throw new Error(`${nextpath} is not a schema`);
          }

          queue.push({ obj: item, base: baseUri, path: nextpath, draft });
        }
      }
      // or a map of maps (member name -> member value -> schema objects)?
      else if (TRAVERSE_SCHEMA_MAP_MAPS.includes(key) && admitsPropertyDependencies(opts.propertyDependencies, draft)) {
        if (Array.isArray(value))
          continue;

        for (const [outer, inner] of Object.entries(value)) {
          if (!isObjectClass(inner) || Array.isArray(inner))
            continue;
          const outerPath = encodeJsonPointerPath(path, key, outer);
          for (const [index, item] of Object.entries(inner)) {
            const nextpath = encodeJsonPointerPath(outerPath, index);
            if (isBoolishType(item))
              continue;
            if (!isObjectClass(item)) {
              if (opts.skipErrors === true)
                continue;
              else
                throw new Error(`${nextpath} is not a schema`);
            }

            queue.push({ obj: item, base: baseUri, path: nextpath, draft });
          }
        }
      }
    }
  }

  return rootUri;
}

export function resolveRefSchemaShallow(schemas, refUri, baseUri, opts = new JsonPointerOptions()) {
  let { id: base, leftUri, fragment } = createJsonPointer(refUri, baseUri, opts);
  if (!schemas.has(leftUri))
    throw new Error(`The root of reference: '$ref': '${base}', is not found in init-cache`);

  // get the document from cache
  let schema = schemas.get(leftUri);

  // If there is no fragment, return the whole schema
  if (isStringWhiteSpace(fragment)) {
    return { id: base, schema };
  }

  // If the fragment is a plain name anchor (not a JSON pointer starting with /),
  // look it up directly in the schemas map as a location-independent identifier
  if (!fragment.startsWith('/')) {
    // The anchor could be stored as just the fragment (e.g., "#foo") or as a full URI
    // Try the full id first (which includes the base URI)
    if (schemas.has(base)) {
      return { id: base, schema: schemas.get(base) };
    }
    // Try the scoped anchor format: baseUri + fragment (e.g., "https://example.com/schema#foo")
    // This handles anchors stored with anchorsGlobal: false
    const scopedAnchorId = `${leftUri}${fragment}`;
    if (schemas.has(scopedAnchorId)) {
      return { id: scopedAnchorId, schema: schemas.get(scopedAnchorId) };
    }
    // Try just the fragment with hash (global anchor format)
    const fragmentWithHash = `#${fragment}`;
    if (schemas.has(fragmentWithHash)) {
      return { id: fragmentWithHash, schema: schemas.get(fragmentWithHash) };
    }
    // Fall through to JSON pointer traversal for backward compatibility
  }

  // Decode and resolve the JSON pointer
  const fragments = decodeJsonPointerPath(fragment);

  // Traverse the schema based on the JSON pointer
  let current = '';
  for (const part of fragments) {
    current = current + '/' + part;
    if (!isBoolOrObjectClass(schema[part]) && !Array.isArray(schema[part]))
      throw new Error(`The '${current}' is not a valid schema in '${leftUri}'`);

    schema = schema[part];
    if (isObjectClass(schema) && isStringType(schema.$id) && !isStringWhiteSpace(schema.$id)) {
      const { id } = createJsonPointer(schema.$id, base, opts);
      base = id;
    }
  }

  return { id: base, schema };
}

/**
 * A loop of references that never reads the instance (`JK0001`). The compile
 * paths that tolerate a reference not resolvable yet must not tolerate this
 * one: no later resolution changes it.
 */
export class RefCycleError extends SchemaCompileError {
  /** @param {string[]} ids - the ids on the loop, the first repeated at the end */
  constructor(ids) {
    super('JK0001', ids.length === 2 && ids[0] === ids[1]
      ? `$ref cycle: ${ids[0]} refers to itself and never reads the instance`
      : `$ref cycle: ${ids.join(' -> ')} never reads the instance`);
  }
}

/**
 * Whether an error is a {@link RefCycleError}.
 * @param {unknown} error - The thrown value
 * @returns {boolean}
 */
export function isRefCycleError(error) {
  return error instanceof RefCycleError;
}

export function restoreSchemaRefsInMap(schemas, opts = new JsonPointerOptions()) {
  for (const [id, item] of schemas.entries()) {
    if (item != null)
      continue;

    // Try to use resolveRefSchemaDeep to flatten ref chains
    // This resolves a→b→c into a→c, eliminating chain traversal at validation time
    // If deep resolution fails (e.g., remote ref not loaded yet), fall back to shallow
    try {
      const { id: finalId, schema: finalSchema } = resolveRefSchemaDeep(
        schemas,
        id,
        { $ref: id },
        opts
      );

      if (finalSchema == null)
        throw new Error(`Can not resolve schema for '${id}'`);

      // Store the final resolved schema (flattened ref chain)
      schemas.set(id, finalSchema);

      // Also store under the final ID for direct access if not already present
      if (finalId !== id && !schemas.has(finalId)) {
        schemas.set(finalId, finalSchema);
      }
    } catch (_e) {
      // If deep resolution fails (remote ref not loaded), fall back to shallow resolution
      // This preserves the original behavior for unresolved refs
      const { schema } = resolveRefSchemaShallow(schemas, id, null, opts);
      if (schema == null)
        throw new Error(`Can not resolve schema for '${id}'`);

      schemas.set(id, schema);
    }
  }
}

export class TraverseOptions extends JsonPointerOptions {
  constructor(
    origin = 'https://github.com/jklarenbeek/jarenjs',
    mergeSchemas = true,
    anchorsGlobal = false,
    anchorsAllowed = true,
    skipErrors = true,
    propertyDependencies = false
  ) {
    super(anchorsGlobal, anchorsAllowed, skipErrors);
    this.origin = origin;
    this.mergeSchemas = mergeSchemas;
    /** Whether the `propertyDependencies` keyword is on: its subschemas are then registered and walked */
    this.propertyDependencies = propertyDependencies;
  }
}

/**
 * The traversal options to use under a validation option set: `traverse`
 * itself, or a copy of it carrying the `propertyDependencies` switch when the
 * validation options turn the keyword on and `traverse` does not say so.
 * @param {TraverseOptions} traverse
 * @param {boolean|null|undefined} propertyDependencies - The validation option
 * @returns {TraverseOptions}
 */
export function traverseOptionsFor(traverse, propertyDependencies) {
  return propertyDependencies === true && traverse.propertyDependencies !== true
    ? Object.assign(new TraverseOptions(), traverse, { propertyDependencies: true })
    : traverse;
}

/**
 * Follow a chain of pure `$ref` hops to its end and flatten it.
 * @param {Map<string, any>} schemas - The schema map
 * @param {string} baseUri - The base the first reference resolves against
 * @param {any} refschema - The schema holding the first `$ref`
 * @param {TraverseOptions} [opts]
 * @param {Set<string>} [clean] - For a caller that only checks for loops: ids
 *   already walked to a schema without references (reaching one ends the walk
 *   early, and the answer is then not the flattened schema); every id of a
 *   chain that ends there is added
 * @returns {{id: string, schema: any}}
 * @throws {RefCycleError} when the chain comes back to an id it visited
 */
export function resolveRefSchemaDeep(schemas, baseUri, refschema, opts = new TraverseOptions(), clean = undefined) {
  if (!isObjectClass(refschema))
    return { id: baseUri, schema: refschema };

  if (!hasSchemaReference(refschema, '$ref'))
    return { id: baseUri, schema: refschema };

  const queue = [{ item: refschema, base: baseUri }];
  const seen = new Map();
  let result = {};
  /** @param {{id: string, schema: any}} answer */
  const finish = (answer) => {
    if (clean !== undefined) for (const known of seen.keys()) clean.add(known);
    return answer;
  };

  while (queue.length > 0) {
    // @ts-ignore
    const { item, base } = queue.shift();
    if (!isObjectClass(item))
      return finish({ id: base, schema: item });

    // A pure `$ref` hop is flattened away: only the `$ref` is kept to
    // resolve it, the other (annotation) keywords of this item are
    // discarded. A target reached THROUGH the chain that asserts
    // keywords beside its `$ref` is the end of what may be flattened:
    // draft 2019-09+ applies those siblings alongside the reference, so
    // collapsing the chain past them would drop assertions (an OpenAPI
    // document schema is nothing but such hops). The item is kept as
    // written and compiled as a schema object, where the resource's
    // draft decides whether its siblings assert (draft-07 ignores them).
    if (hasSchemaReference(item, '$ref')) {
      if (item !== refschema && hasRefSiblings(item, opts.propertyDependencies === true))
        return { id: base, schema: item };
      const ref = item.$ref;
      const { id, schema } = resolveRefSchemaShallow(schemas, ref, base, opts);

      // A hop back to an id already visited is a loop of pure references: no
      // schema on it reads the instance, so no answer is reachable.
      if (seen.has(id))
        throw new RefCycleError([...[...seen.keys()].slice(seen.get(id)), id]);

      seen.set(id, seen.size);

      // A chain that stopped at a schema asserting beside its `$ref` is not
      // recorded: that schema continues the chain when it is the first item.
      if (clean !== undefined) {
        if (clean.has(id))
          return finish({ id, schema });
      }

      queue.push({ item: schema, base: id });
    } else {
      // No $ref in this item, merge as normal
      result = opts.mergeSchemas == true
        ? { ...item, ...result }
        : { ...item };
      return finish({ id: base, schema: result });
    }
  }

  throw new Error(`The json schema '${baseUri}' can not be resolved!`);
}

/**
 * @typedef {object} InstanceReading - what decides whether a keyword compiles
 *   to a validator, for one compilation
 * @property {{ formatAssertion?: boolean|null, contentValidation?: boolean|null,
 *   propertyDependencies?: boolean|null }} options - the compilation's validation options
 * @property {Record<string, any>} formats - the format compilers registered on the validator
 */

// Keywords applying one subschema to members or items: with a `true` or `{}`
// subschema they pass every instance.
const PASS_THROUGH_KEYWORDS = new Set(['items', 'additionalItems', 'additionalProperties',
  'propertyNames', 'unevaluatedItems', 'unevaluatedProperties']);

/**
 * Whether a keyword of a schema object can fail an instance, read the way the
 * compiler reads it: it is one of the keywords a `$ref` carries as an
 * asserting sibling (`REF_SIBLING_KEYWORDS`, and `propertyDependencies` while
 * that option is on), except `format` while it compiles to no validator
 * (formats annotate, or no compiler is registered under the name), the
 * content keywords while content is not validated, and a keyword applying a
 * subschema that passes everything to members or items. Every other key
 * (annotations, identifiers, `$defs`, unknown and `x-*` keywords) compiles to
 * no validator.
 * @param {string} key
 * @param {any} value
 * @param {InstanceReading} reading
 * @returns {boolean}
 */
function canFail(key, value, reading) {
  if (key === 'propertyDependencies') return reading.options.propertyDependencies === true;
  if (!REF_SIBLING_KEYWORDS.includes(key)) return false;
  if (key === 'format')
    return reading.options.formatAssertion !== false && getSchemaFormatCompiler(reading.formats, value) != null;
  if (key === 'contentEncoding' || key === 'contentMediaType') return reading.options.contentValidation === true;
  if (PASS_THROUGH_KEYWORDS.has(key)) return !passesEverything(value, reading);
  return true;
}

/**
 * Whether a subschema passes every instance without reading it: `true`, or
 * an object none of whose keywords can fail or refers anywhere.
 * @param {any} schema
 * @param {InstanceReading} reading
 * @returns {boolean}
 */
function passesEverything(schema, reading) {
  if (schema === true) return true;
  if (!isObjectClass(schema) || hasSchemaReference(schema, '$ref') || hasSchemaReference(schema, '$recursiveRef'))
    return false;
  for (const key of Object.keys(schema)) {
    if (canFail(key, schema[key], reading)) return false;
  }
  return true;
}

/**
 * The index of the member of an in-place applicator list reached on every
 * instance: the first one, after the leading members that cannot answer
 * before the next one runs. `allOf` stops at a failing member, so it skips
 * only members that pass everything; `anyOf` stops at a passing member, so
 * it skips only `false`; `oneOf` stops at a second passing member, so it
 * skips `false` and at most one member that passes everything.
 * @param {string} key - `allOf`, `anyOf` or `oneOf`
 * @param {any[]} members
 * @param {InstanceReading} reading
 * @returns {number}
 */
function firstReachedMember(key, members, reading) {
  let passing = 0;
  let i = 0;
  for (; i < members.length - 1; i++) {
    const member = members[i];
    if (member === false && key !== 'allOf') continue;
    if (key === 'anyOf' || !passesEverything(member, reading)) break;
    if (key === 'oneOf' && ++passing > 1) break;
  }
  return i;
}

/**
 * The subschema a schema object evaluates first on every instance, without
 * descending into it and before anything else it asserts can decide the
 * answer: the member `firstReachedMember` picks of its only `allOf`, `anyOf`
 * or `oneOf`, its only `not`, its `if` when a `then` or an `else` is beside
 * it, or the target of its only `$dynamicRef` or `$recursiveRef` (marked by
 * the key). Keywords that cannot fail (`canFail`) are passed over; a schema
 * with any other keyword answers before reaching it on some instance.
 * @param {Record<string, any>} schema
 * @param {InstanceReading} reading
 * @returns {[string, any] | undefined} the subschema's pointer suffix and value
 */
function firstInPlaceSubschema(schema, reading) {
  let first;
  for (const key of Object.keys(schema)) {
    if (key === '$recursiveRef') {
      if (first !== undefined) return undefined;
      first = [key, schema[key]];
      continue;
    }
    if (!canFail(key, schema[key], reading)) continue;
    if ((key === 'then' || key === 'else') && Object.hasOwn(schema, 'if')) continue;
    if (first !== undefined) return undefined;
    if (key === 'allOf' || key === 'anyOf' || key === 'oneOf') {
      const members = schema[key];
      if (!Array.isArray(members) || members.length === 0) return undefined;
      const i = firstReachedMember(key, members, reading);
      first = [`${key}/${i}`, members[i]];
    }
    else if (key === 'not') first = ['not', schema.not];
    else if (key === 'if' && (Object.hasOwn(schema, 'then') || Object.hasOwn(schema, 'else')))
      first = ['if', schema.if];
    else if (key === '$dynamicRef') first = [key, schema[key]];
    else return undefined;
  }
  return first;
}

/**
 * The part of a schema id before its fragment: the resource it lies in.
 * @param {string} id
 * @returns {string}
 */
function resourceOf(id) {
  const hash = id.indexOf('#');
  return hash === -1 ? id : id.slice(0, hash);
}

/**
 * Refuses a root schema whose evaluation, on every instance, comes back to a
 * schema it is still evaluating without having read the instance: following
 * the `$ref` (always evaluated first) or the one in-place applicator each
 * schema evaluates first returns to a schema already on the way. Such a
 * validator decides nothing on any instance. A `$dynamicRef` or
 * `$recursiveRef` is followed like a `$ref` while the walk stays in the root
 * resource, where its dynamic target is its static one; elsewhere the walk
 * stops. A loop that only some instances reach is not refused here; the
 * reference depth bound refuses it where an instance reaches it.
 * @param {Map<string, any>} schemas - The schema map
 * @param {string} rootId - The id the root schema is compiled under
 * @param {any} root - The root schema
 * @param {InstanceReading} reading - The compilation's options and formats
 * @param {TraverseOptions} [opts]
 * @throws {RefCycleError} naming the schema locations on the loop
 */
export function assertRootReadsInstance(schemas, rootId, root, reading, opts = new TraverseOptions()) {
  /** @type {Map<object, Map<string, number>>} */
  const visited = new Map();
  const ids = [];
  let schema = root;
  let base = rootId;
  let at = rootId;
  let rootResource;
  // Each step visits a new (schema, base) pair, of which a document has
  // finitely many; the cap only ends a walk whose bases never repeat.
  for (let steps = 0; steps <= schemas.size * 4 + 64; steps++) {
    if (!isObjectClass(schema)) return;
    if (isStringType(schema.$id) && !isStringWhiteSpace(schema.$id)) {
      base = createJsonPointer(schema.$id, base, opts).id;
      at = base;
    }
    rootResource ??= resourceOf(base);
    const location = at.includes('#') ? at : at + '#';
    let bases = visited.get(schema);
    const seen = bases?.get(base);
    if (seen !== undefined)
      throw new RefCycleError([...ids.slice(seen), location]);
    if (bases === undefined) visited.set(schema, bases = new Map());
    bases.set(base, ids.length);
    ids.push(location);

    let ref;
    if (hasSchemaReference(schema, '$ref'))
      ref = schema.$ref;
    else {
      const first = firstInPlaceSubschema(schema, reading);
      if (first === undefined) return;
      if (first[0] === '$dynamicRef' || first[0] === '$recursiveRef') {
        const dynamic = first[1];
        if (resourceOf(base) !== rootResource || typeof dynamic !== 'string' || !dynamic.startsWith('#')
          || (first[0] === '$recursiveRef' && dynamic !== '#'))
          return;
        ref = dynamic;
      }
      else {
        at = `${location}/${first[0]}`;
        schema = first[1];
        continue;
      }
    }
    let target;
    try {
      target = resolveRefSchemaShallow(schemas, ref, base, opts);
    }
    catch {
      return; // a target not loaded is reported where it is used
    }
    schema = target.schema;
    base = at = target.id;
  }
}
