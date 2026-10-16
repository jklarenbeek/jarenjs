import {
  isBoolOrObjectClass,
  hasSchemaReference,
  schemaReference,
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
  encodeJSONPointerSegment,
  decodeJSONPointerSegment,
} from '@jarenjs/json/pointer';

import {
  TRAVERSE_SCHEMA_OBJECTS,
  TRAVERSE_SCHEMA_MAPS,
  TRAVERSE_SCHEMA_MAP_MAPS,
  dialectDraft,
  admitsPropertyDependencies,
} from './schema-keywords.js';
import { admitsDynamicReference } from './dynamic-ref.js';

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

/**
 * Where a keyword of the schema object a URI names sits, as the location a
 * refusal names (`https://a.test/s.json#/properties/a/%24ref`).
 * @param {string} uri - The schema object's URI
 * @param {string} keyword
 * @returns {string}
 */
export function keywordLocation(uri, keyword) {
  return encodeJsonPointerPath(uri.includes('#') ? uri : `${uri}#`, keyword);
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

/**
 * Resolve a reference or an identifier against a base and split the result
 * into the parts the resolver keys schemas by.
 * @param {string|undefined} refUri - The reference or identifier as written
 * @param {string|undefined} baseUri - The base it resolves against
 * @param {JsonPointerOptions} [opts]
 * @param {string} [keyword] - The keyword the text is the value of, named by a refusal
 * @param {string} [location] - Where that keyword is in the schema, named by a refusal
 * @returns {JsonPointer}
 * @throws {SchemaCompileError} `JK0010` when the text, or the base, is not a valid URI
 */
export function createJsonPointer(refUri, baseUri, opts = new JsonPointerOptions(), keyword = undefined, location = undefined) {
  try {
    return parseJsonPointer(refUri, baseUri, opts);
  }
  catch (e) {
    // `URL` refuses what is no URI with a `TypeError`; nothing else here throws one.
    if (!(e instanceof TypeError)) throw e;
    const repairBase = 'correct the origin or the $id that names it';
    if (!isStringType(refUri) || isStringWhiteSpace(refUri))
      throw new SchemaCompileError('JK0010', `the base '${baseUri}' is not a valid URI; ${repairBase}`, undefined, { cause: e });
    const named = `${keyword === undefined ? '' : keyword + ' '}'${refUri}'`;
    const reason = isStringType(baseUri) && /^[a-z][a-z0-9+.-]*:/i.test(baseUri) && !URL.canParse(baseUri)
      ? `${named} resolves against '${baseUri}', which is not a valid URI; ${repairBase}`
      : `${named} is not a valid URI reference; correct it, percent-encoding any character a URI does not allow`;
    throw new SchemaCompileError('JK0010', reason, location, { cause: e });
  }
}

/**
 * The parse {@link createJsonPointer} refuses coded.
 * @param {string|undefined} refUri
 * @param {string|undefined} baseUri
 * @param {JsonPointerOptions} opts
 * @returns {JsonPointer}
 */
function parseJsonPointer(refUri, baseUri, opts) {
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
        const [, fragment] = atFragment(href);
        return new JsonPointer(
          effectiveBase + refUri,
          undefined,
          effectiveBase + '#',
          fragment || null
        );
      } else if (refUri.includes('#')) {
        // refUri has a fragment: manual resolution
        const [refBase, refFragment] = atFragment(refUri);
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

  const [uri, fragment] = atFragment(url.href);
  const [leftUri, search] = uri.split('?');

  if (!isStringWhiteSpace(fragment)) {
    // a json pointer, which a URI fragment percent-encodes: a fragment that
    // decodes to `/…` is one (`#%2F$defs%2Fx` is `#/$defs/x`), and its
    // `%2F`s separate tokens as its `/`s do; every other escape is decoded
    // once, with the token that holds it.
    const pointer = fragment.replace(/%2f/gi, '/');
    if (pointer.startsWith('/'))
      return new JsonPointer(`${leftUri}#${pointer}`, search, `${leftUri}#`, pointer);
    // or a plain name (an `$anchor`, a `$dynamicAnchor`, a draft-07 `$id:
    // '#name'`), keyed as the URI spells it: an anchor and a reference to
    // it are spelled alike, whatever characters the name holds.
    if (opts.anchorsAllowed == true) {
      return opts.anchorsGlobal == true
        ? new JsonPointer(`#${fragment}`, search, `${leftUri}#`, fragment)
        : new JsonPointer(`${leftUri}#${fragment}`, search, `${leftUri}#`, fragment);
    }
  }
  return new JsonPointer(`${leftUri}#`, search, `${leftUri}#`, null);
}

/**
 * Split a URI at its first `#`: a fragment may hold another.
 * @param {string} uri
 * @returns {[string, string|undefined]} The URI before it, and the fragment (`undefined` for none)
 */
function atFragment(uri) {
  const hash = uri.indexOf('#');
  return hash === -1 ? [uri, undefined] : [uri.slice(0, hash), uri.slice(hash + 1)];
}

/**
 * What the walks of one validator read at each schema object's place, so the
 * compiler reads the same.
 * @typedef {object} SchemaPlaces
 * @property {WeakMap<object, number|null>} drafts - The draft each place
 *   declares (the nearest `$schema` on the way to it), `null` for none: a
 *   reference target is compiled under it
 * @property {WeakMap<object, string>} refBases - For a `$ref` beside an `$id`
 *   that does not set its base (before 2019-09), the base it resolves against
 * @property {Set<string>} keptRefs - The targets such a `$ref` names that its
 *   `$id` would have placed elsewhere: a refusal to resolve one says why
 * @property {WeakMap<object, string>} undecidedBases - For a `$ref` beside an
 *   `$id` in a place no draft is known for (a document registered before a
 *   compile names one), the base it resolves against when a compile reads
 *   it before 2019-09
 * @property {Set<string>} lateTargets - The targets such a `$ref` names only
 *   when read from 2019-09 on: a compile that reads it before 2019-09 does
 *   not need them
 * @property {WeakSet<object>} foreign - The places whose nearest `$schema`
 *   names no draft this package knows: their dynamic references are read as
 *   where no draft is declared
 * @property {WeakMap<object, string>} dialects - For a place whose nearest
 *   `$schema` names a dialect the walk could not resolve (its meta-schema not
 *   held yet), that URI: a compile that holds the meta-schema reads the place
 *   by it ({@link placeDraftOf}, {@link readsForeign})
 * @property {Map<string, string>} contested - The identifiers two different
 *   registered places declare, each with what names both: a compile that
 *   reads one is refused (`JK0012`), as it would answer by whichever place
 *   was registered first
 */

/**
 * The draft a recorded place is read under by one compilation: the draft its
 * walk recorded, unless its `$schema` named a dialect the walk could not
 * resolve and `held` now holds that dialect's meta-schema.
 * @param {{ drafts?: WeakMap<object, number|null>, dialects?: WeakMap<object, string> }|undefined} places - What the walks read
 * @param {object} place - A walked schema object
 * @param {{ get(key: string): unknown }} [held] - The compilation's schemas by URI
 * @returns {number|null|undefined} The draft, null when its place declares
 *   none, undefined for a place no walk recorded
 */
export function placeDraftOf(places, place, held) {
  const dialect = places?.dialects?.get(place);
  return (dialect === undefined ? null : dialectDraft(dialect, held)) ?? places?.drafts?.get(place);
}

/**
 * Whether a recorded place lies under a `$schema` that names no draft this
 * package knows, as one compilation reads it ({@link placeDraftOf}).
 * @param {{ foreign?: WeakSet<object>, dialects?: WeakMap<object, string> }|undefined} places - What the walks read
 * @param {object} place - A walked schema object
 * @param {{ get(key: string): unknown }} [held] - The compilation's schemas by URI
 * @returns {boolean}
 */
export function readsForeign(places, place, held) {
  if (places?.foreign?.has(place) !== true) return false;
  const dialect = places.dialects?.get(place);
  return dialect === undefined || dialectDraft(dialect, held) === null;
}

/**
 * The base the `$ref` of a schema object resolves against when the `$id`
 * beside it does not set it, as one compile reads the object.
 * @param {SchemaPlaces|undefined} places - What the walks read
 * @param {any} schema - The schema object holding the `$ref`
 * @param {number|null} reading - The draft the compile reads a place that
 *   declares none under, `null` when no compile is reading it
 * @returns {string|undefined}
 */
function keptRefBase(places, schema, reading) {
  return places?.refBases.get(schema)
    ?? (reading !== null && reading < 2019 ? places?.undecidedBases.get(schema) : undefined);
}

/**
 * Register a schema document's identifiers (`$id`/`id`, `$anchor`,
 * `$dynamicAnchor`) in `schemas`, and every `$ref` target it names as a
 * `null` placeholder that {@link restoreSchemaRefsInMap} resolves.
 * @param {Map<string, any>} schemas - The map to register into
 * @param {string} baseUri - The URI the document was retrieved from
 * @param {any} schema - The document
 * @param {JsonPointerOptions} [opts]
 * @param {(target: JsonPointer, location: string, undecided: boolean) => void} [onReference] -
 *   Offered the resolved target of every `$ref` the walk reaches, and of
 *   every `$dynamicRef` whose place declares a draft that defines it (or
 *   none), with the reference's location in the document as a URI
 *   fragment (`#/properties/a/%24ref`), and whether it is the target a
 *   `$ref` beside an `$id` names in a place that declares no draft, read
 *   under `defaultDraft` before 2019-09
 * @param {SchemaPlaces} [places] - Where to record what each schema
 *   object's place reads, for the compiler to read the same
 * @param {number|null} [defaultDraft] - The draft a place that declares none
 *   is read under (`compile` reads its schema's document as draft-07 when it
 *   declares none); `null` when unknown, as for a document registered before
 *   any compile names its draft
 * @param {(error: Error, twice?: { id: string, first: any, second: any, firstAt: string|undefined, secondAt: string }) => void} [onFault] -
 *   Offered each refusal of a place below the document's root (an `$id` or
 *   a `$ref` that is no URI reference, an identifier an earlier place of the
 *   document declares) instead of throwing it, with, for an identifier
 *   declared twice, the identifier and both places; the walk then goes on
 *   past it: a refused `$ref` registers no target, and a refused identifier
 *   nothing at or below its place (an identifier declared twice keeps its
 *   first place)
 * @param {Map<string, any>} [held] - The schemas the validator already
 *   holds: a `$schema` naming one of them, or one `schemas` holds, is read
 *   by that meta-schema's own `$schema`
 * @returns {string} The document's own id
 */
export function storeSchemaIdsInMap(schemas, baseUri, schema, opts = new JsonPointerOptions(), onReference = undefined, places = undefined, defaultDraft = null, onFault = undefined, held = undefined) {
  if (!isObjectClass(schema)) {
    const { id } = createJsonPointer(baseUri, undefined, opts);
    schemas.set(id, schema);
    return id;
  }

  const { id: rootUri } = createJsonPointer(schema.$id, baseUri, opts, '$id', '#/%24id');
  if (!isStringType(schema.$id) || isStringWhiteSpace(schema.$id)) {
    // A URI only a reference names (a `null` placeholder) holds no schema.
    const held = schemas.get(rootUri);
    if (held != null && held !== schema)
      throw new SchemaCompileError('JK0012',
        `the document has no $id, and the URI it is read under, '${rootUri}', names another schema the validator holds; give it an $id of its own`);

    schemas.set(rootUri, schema);
  }

  baseUri = rootUri;

  /**
   * Refuse a place, or offer the refusal to `onFault` and go on.
   * @param {Error} error
   * @param {{ id: string, first: any, second: any, firstAt: string|undefined, secondAt: string }} [twice] -
   *   For an identifier declared twice: it, both places and their locations
   */
  const fault = (error, twice = undefined) => {
    if (onFault === undefined) throw error;
    onFault(error, twice);
  };
  /** Where this walk registered each identifier: the keyword declaring it. */
  const declared = new Map();
  /**
   * Register one identifier of the document: a second place declaring it
   * is refused (`JK0012`), naming both.
   * @param {string} id
   * @param {object} obj - The place declaring it
   * @param {string} path
   * @param {string} keyword - The keyword declaring it there
   * @returns {boolean} Whether it was registered
   */
  const declare = (id, obj, path, keyword) => {
    const held = schemas.get(id);
    const place = encodeJsonPointerPath(path, keyword);
    if (held != null && held !== obj) {
      const first = declared.get(id);
      fault(new SchemaCompileError('JK0012', first === undefined
        ? `${keyword} declares '${id}', which names another schema the validator holds; give one of them another name`
        : `'${id}' is declared twice (first at '${first}'); give one of them another name`, place),
      { id, first: held, second: obj, firstAt: first, secondAt: place });
      return false;
    }
    schemas.set(id, obj);
    if (!declared.has(id)) declared.set(id, place);
    return true;
  };

  // A `$schema` is read through the meta-schemas this walk registers and the
  // ones the validator already holds.
  const dialects = { get: (/** @type {string} */ key) => schemas.get(key) ?? held?.get(key) };
  /** @type {{ obj: any, base: string, path: string, draft: number|null, foreign: boolean, dialect: string|undefined }[]} */
  const queue = [{ obj: schema, base: rootUri, path: '#', draft: null, foreign: false, dialect: undefined }];
  while (queue.length > 0) {
    // @ts-ignore
    const { obj, base, path, draft: inheritedDraft, foreign: inheritedForeign, dialect: inheritedDialect } = queue.shift();
    // The draft a document declares is inherited by everything below it. A
    // `$schema` that names no draft yet is read as draft-07 and foreign here,
    // and is kept, so a compile that holds its meta-schema reads it by that.
    const named = isStringType(obj.$schema) ? dialectDraft(obj.$schema, dialects) : undefined;
    const draft = named === undefined ? inheritedDraft : named ?? 7;
    places?.drafts.set(obj, draft);
    const foreign = named === undefined ? inheritedForeign : named === null;
    if (foreign) places?.foreign.add(obj);
    else places?.foreign.delete(obj);
    const dialect = named === undefined ? inheritedDialect : named === null ? obj.$schema : undefined;
    if (dialect !== undefined) places?.dialects.set(obj, dialect);
    else places?.dialects.delete(obj);

    // Handle $id (draft 6+) or id (draft 4) for identifying subschemas
    const idKeyword = isStringType(obj.$id) ? obj.$id : isStringType(obj.id) ? obj.id : undefined;
    const hasId = isStringType(idKeyword) && !isStringWhiteSpace(idKeyword);
    if (hasId) {
      const idName = isStringType(obj.$id) ? '$id' : 'id';
      let id;
      try {
        ({ id } = createJsonPointer(idKeyword, base, opts, idName, encodeJsonPointerPath(path, idName)));
      }
      catch (e) {
        fault(e);
        continue;
      }
      if (!declare(id, obj, path, idName))
        continue;

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

    // Where anchors are not allowed, a plain-name fragment names the
    // document: an anchor declares nothing.
    if (opts.anchorsAllowed == true && isStringType(obj.$anchor) && !isStringWhiteSpace(obj.$anchor)) {
      const { id } = createJsonPointer(`#${obj.$anchor}`, baseUri, opts);
      if (!declare(id, obj, path, '$anchor'))
        continue;

      // we reset the baseUri when the $anchor property is set.
      if (!id.startsWith('#')) // except when anchors are global
        baseUri = id;
    }

    // Handle $dynamicAnchor (draft 2020-12) - similar to $anchor but for $dynamicRef
    if (opts.anchorsAllowed == true && isStringType(obj.$dynamicAnchor) && !isStringWhiteSpace(obj.$dynamicAnchor)) {
      const { id } = createJsonPointer(`#${obj.$dynamicAnchor}`, baseUri, opts);
      if (!declare(id, obj, path, '$dynamicAnchor'))
        continue;

      // Note: $dynamicAnchor does NOT change the baseUri like $anchor does
      // It's only used for $dynamicRef resolution
    }

    if (onReference !== undefined && hasSchemaReference(obj, '$dynamicRef') && admitsDynamicReference('$dynamicRef', foreign ? null : draft))
      onReference(createJsonPointer(schemaReference(obj, '$dynamicRef'), baseUri, opts, '$dynamicRef', encodeJsonPointerPath(path, '$dynamicRef')), encodeJsonPointerPath(path, '$dynamicRef'), false);

    // Before 2019-09 a `$ref` replaces its schema object: an `$id` beside it
    // names the object but does not set the base the reference resolves
    // against.
    const reading = draft ?? defaultDraft;
    const keepsBase = hasId && reading !== null && reading < 2019;
    let target;
    const reference = hasSchemaReference(obj, '$ref') ? schemaReference(obj, '$ref') : undefined;
    if (reference !== undefined) {
      try {
        target = createJsonPointer(reference, keepsBase ? base : baseUri, opts, '$ref', encodeJsonPointerPath(path, '$ref'));
      }
      catch (e) {
        fault(e);
      }
    }
    if (target !== undefined) {
      const ref = target.id;
      if (keepsBase) places?.refBases.set(obj, base);
      else places?.refBases.delete(obj);
      // A place no draft is known for is read by each compile under the
      // draft that compile names: both readings are kept.
      const undecided = hasId && reading === null;
      if (undecided) places?.undecidedBases.set(obj, base);
      else places?.undecidedBases.delete(obj);
      if (undecided && createJsonPointer(reference, base, opts).id !== ref) places?.lateTargets.add(ref);
      else places?.lateTargets.delete(ref);
      // The latest walk to name a target decides whether a refusal to
      // resolve it says why the `$id` was not its base.
      if (keepsBase && createJsonPointer(reference, baseUri, opts, '$ref', encodeJsonPointerPath(path, '$ref')).id !== ref) places?.keptRefs.add(ref);
      else places?.keptRefs.delete(ref);
      if (!schemas.has(ref))
        schemas.set(ref, null);
      if (onReference !== undefined) onReference(target, encodeJsonPointerPath(path, '$ref'), keepsBase && draft === null);

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

            queue.push({ obj: item, base: baseUri, path: nextpath, draft, foreign, dialect });
          }
        }
        else {
          const nextpath = encodeJsonPointerPath(path, key);

          queue.push({ obj: value, base: baseUri, path: nextpath, draft, foreign, dialect });
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

          queue.push({ obj: item, base: baseUri, path: nextpath, draft, foreign, dialect });
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

            queue.push({ obj: item, base: baseUri, path: nextpath, draft, foreign, dialect });
          }
        }
      }
    }
  }

  return rootUri;
}

const UNHELD = 'no schema the validator holds has that URI; register it with addSchema, load it with compileAsync, or fix the reference';

/**
 * Refuse reading an identifier two registered places declare (`JK0012`):
 * the answer would be the first registered place's, whichever was meant.
 * @param {SchemaPlaces|undefined} places - What the walks read
 * @param {string} id - The identifier a reference is resolved through
 * @throws {SchemaCompileError} `JK0012` when the identifier is contested
 */
function refuseContested(places, id) {
  const names = places?.contested.get(id);
  if (names !== undefined)
    throw new SchemaCompileError('JK0012',
      `'${id}' names two schemas (${names}), and this compile reads it, which would answer by the one registered first; give one of them another name`);
}

/**
 * Refuse a reference whose document, or plain-name anchor, two registered
 * places declare (`JK0012`). A JSON Pointer fragment is read through the
 * document's identifier.
 * @param {SchemaPlaces|undefined} places - What the walks read
 * @param {string} ref - The reference, resolved
 * @throws {SchemaCompileError} `JK0012` when it is read through a contested identifier
 */
export function refuseContestedReference(places, ref) {
  if (places === undefined || places.contested.size === 0) return;
  const hash = ref.indexOf('#');
  refuseContested(places, hash === -1 ? `${ref}#` : ref.slice(0, hash + 1));
  if (hash !== -1 && hash < ref.length - 1 && ref[hash + 1] !== '/') refuseContested(places, ref);
}

/**
 * Whether an error is the refusal of a contested identifier.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isContestedRefusal(error) {
  return error instanceof SchemaCompileError && error.code === 'JK0012';
}

/**
 * The refusal of a reference that resolves to no schema: `JK0009`, or
 * `JK0008` for a draft-07 `$ref` whose sibling `$id` did not set its base.
 * @param {string} id - The reference, resolved
 * @param {boolean} [ignoredId] - Whether a draft-07 `$ref` ignored the `$id` beside it
 * @param {string} [why] - What does not resolve and the repair
 * @returns {SchemaCompileError}
 */
export function unresolvedReference(id, ignoredId = false, why = UNHELD) {
  return ignoredId
    ? new SchemaCompileError('JK0008', `Can not resolve schema for '${id}': a draft-07 $ref ignores the $id beside it; register that URI, or declare $schema 2019-09 or later`)
    : new SchemaCompileError('JK0009', `Can not resolve schema for '${id}': ${why}`);
}

/**
 * Resolve one reference to the schema it names, without following the
 * target's own reference.
 * @param {Map<string, any>} schemas
 * @param {string} refUri - The reference
 * @param {string|null} baseUri - The base it resolves against
 * @param {JsonPointerOptions} [opts]
 * @param {SchemaPlaces} [places] - What the walks read: an identifier two
 *   registered places declare is refused
 * @returns {{id: string, schema: any}}
 * @throws {SchemaCompileError} `JK0009` when no schema the map holds has
 *   that URI, or its pointer misses; `JK0012` when the identifier it is read
 *   through names two registered places
 */
export function resolveRefSchemaShallow(schemas, refUri, baseUri, opts = new JsonPointerOptions(), places = undefined) {
  let { id: base, leftUri, fragment } = createJsonPointer(refUri, baseUri, opts);
  const id = base;
  if (!schemas.has(leftUri))
    throw unresolvedReference(id);
  refuseContested(places, leftUri);

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
      refuseContested(places, base);
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
    // A plain name no anchor declares names nothing: read as a pointer it
    // has no reference tokens and would name the whole document.
    throw unresolvedReference(id);
  }

  // Decode and resolve the JSON pointer
  const fragments = decodeJsonPointerPath(fragment);

  // Traverse the schema based on the JSON pointer
  let current = '';
  for (const part of fragments) {
    current = current + '/' + part;
    if (!isBoolOrObjectClass(schema[part]) && !Array.isArray(schema[part]))
      throw unresolvedReference(id, false, `'${current}' is not a schema in '${leftUri}'; fix the pointer`);

    schema = schema[part];
    if (isObjectClass(schema) && isStringType(schema.$id) && !isStringWhiteSpace(schema.$id)) {
      const { id } = createJsonPointer(schema.$id, base, opts, '$id');
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

/**
 * Resolve every `null` placeholder the walks left in `schemas`.
 * @param {Map<string, any>} schemas
 * @param {JsonPointerOptions} [opts]
 * @param {SchemaPlaces} [places] - What the walks read
 * @param {number|null} [reading] - The draft the compile reads a place that
 *   declares none under
 * @throws {SchemaCompileError} `JK0008` for a target of a draft-07 `$ref`
 *   whose `$id` does not set its base that nothing resolves, `JK0009` for
 *   any other target nothing resolves
 */
export function restoreSchemaRefsInMap(schemas, opts = new JsonPointerOptions(), places = undefined, reading = null) {
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
        opts,
        undefined,
        places,
        reading
      );

      if (finalSchema == null)
        throw unresolvedReference(id);

      // Store the final resolved schema (flattened ref chain)
      schemas.set(id, finalSchema);

      // Also store under the final ID for direct access if not already present
      if (finalId !== id && !schemas.has(finalId)) {
        schemas.set(finalId, finalSchema);
      }
    } catch (_e) {
      // If deep resolution fails (remote ref not loaded), fall back to shallow resolution
      // This preserves the original behavior for unresolved refs
      const kept = places?.keptRefs.has(id);
      let schema = null;
      let failure;
      try {
        ({ schema } = resolveRefSchemaShallow(schemas, id, null, opts, places));
      }
      catch (e) {
        failure = e;
      }
      // A target read through a contested identifier is refused by the
      // compile that reads it, not by every compile on the validator.
      if (isContestedRefusal(failure)) {
        schemas.delete(id);
        continue;
      }
      if (schema == null) {
        // What only the 2019-09 reading of an undeclared document names, a
        // compile reading it before 2019-09 does not need.
        if (reading !== null && reading < 2019 && places?.lateTargets.has(id)) {
          schemas.delete(id);
          continue;
        }
        throw failure !== undefined && !kept ? failure : unresolvedReference(id, kept);
      }

      schemas.set(id, schema);
    }
  }
}

/** The base a schema without `$id` sits under when the host names no `origin`. */
export const DEFAULT_ORIGIN = 'https://github.com/jklarenbeek/jarenjs';

export class TraverseOptions extends JsonPointerOptions {
  constructor(
    origin = DEFAULT_ORIGIN,
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
 * @param {SchemaPlaces} [places] - What the walks read: the base a hop's
 *   `$ref` resolves against when its `$id` does not set it
 * @param {number|null} [reading] - The draft the compile reads a place that
 *   declares none under, `null` outside a compile
 * @returns {{id: string, schema: any}}
 * @throws {RefCycleError} when the chain comes back to an id it visited
 */
export function resolveRefSchemaDeep(schemas, baseUri, refschema, opts = new TraverseOptions(), clean = undefined, places = undefined, reading = null) {
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
      const ref = schemaReference(item, '$ref');
      const { id, schema } = resolveRefSchemaShallow(schemas, ref, base, opts, places);

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

      queue.push({ item: schema, base: keptRefBase(places, schema, reading) ?? id });
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
 * @property {WeakMap<object, number|null>} [drafts] - the draft each walked
 *   schema object's place declares ({@link SchemaPlaces}); a place it does
 *   not hold reads every keyword
 * @property {WeakSet<object>} [foreign] - the places whose `$schema` names no
 *   draft this package knows ({@link SchemaPlaces})
 * @property {WeakMap<object, string>} [dialects] - the `$schema` a place's
 *   walk could not resolve ({@link SchemaPlaces})
 * @property {{ get(key: string): unknown }} [held] - the compilation's
 *   schemas by URI, which may resolve it
 */

/**
 * Whether a schema object applies its dynamic reference, read the way the
 * compiler reads it: one is written, and the draft its place declares
 * defines the keyword (or it declares none).
 * @param {Record<string, any>} schema
 * @param {'$recursiveRef'|'$dynamicRef'} keyword
 * @param {InstanceReading} reading
 * @returns {boolean}
 */
function appliesDynamicReference(schema, keyword, reading) {
  return hasSchemaReference(schema, keyword)
    && admitsDynamicReference(keyword, readsForeign(reading, schema, reading.held) ? null : placeDraftOf(reading, schema, reading.held) ?? null);
}

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
  if (!isObjectClass(schema) || hasSchemaReference(schema, '$ref') || appliesDynamicReference(schema, '$recursiveRef', reading))
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
    if (key === '$recursiveRef' || key === '$dynamicRef') {
      if (!appliesDynamicReference(schema, key, reading)) continue;
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
      base = createJsonPointer(schema.$id, base, opts, '$id').id;
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
      ref = schemaReference(schema, '$ref');
    else {
      const first = firstInPlaceSubschema(schema, reading);
      if (first === undefined) return;
      if (first[0] === '$dynamicRef' || first[0] === '$recursiveRef') {
        const dynamic = first[0] === '$dynamicRef' ? schemaReference(schema, '$dynamicRef') : first[1];
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
