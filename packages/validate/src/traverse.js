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
  decodeJSONPointerSegment,
} from '@jarenjs/json/pointer';

import {
  TRAVERSE_SCHEMA_OBJECTS,
  TRAVERSE_SCHEMA_MAPS,
  TRAVERSE_SCHEMA_MAP_MAPS,
  dialectDraft,
  admitsPropertyDependencies,
  caselessUri,
  identifierKeyword,
  identifierText,
} from './schema-keywords.js';
import { admitsDynamicReference } from './dynamic-ref.js';
import { DEFAULT_ORIGIN, encodeJsonPointerPath, withoutFragment } from './origin.js';

import { SchemaCompileError } from './errors.js';

function decodeJsonPointerKey(key) {
  // Lenient decode: `$ref` fragments arrive here unvalidated, so a stray
  // `~` must pass through instead of throwing like the strict parser does.
  // The percent-decode is this site's own: these keys arrive from a URI
  // fragment, which the plain reference-token decode knows nothing about.
  // A `%` that starts no escape is read as written: a reference spelling
  // one is refused where it is parsed (`JK0010`), so only a key `addSchema`
  // was handed can hold one, and reading the held keys must not throw.
  let text = key;
  if (key.includes('%')) {
    try {
      text = decodeURIComponent(key);
    }
    catch (_e) {
      // as written
    }
  }
  return decodeJSONPointerSegment(text);
}

/**
 * Where a keyword of the schema object a URI names sits, as the location a
 * refusal names (`https://a.test/s.json#/properties/a/%24ref`), or a member
 * or item inside the keyword's value (`…#/properties/a`).
 * @param {string} uri - The schema object's URI
 * @param {string} keyword
 * @param {...(string|number)} members - The member names and item indexes inside the value
 * @returns {string}
 */
export function keywordLocation(uri, keyword, ...members) {
  let location = encodeJsonPointerPath(uri.includes('#') ? uri : `${uri}#`, keyword);
  for (const member of members) location = encodeJsonPointerPath(location, String(member));
  return location;
}

/**
 * A schema location as a compile refusal names it: a place in the document
 * the compile was handed (held under `origin`) by its pointer into that
 * document (`#/…`), as the walks name it; a place in any other document or
 * embedded resource by its absolute URI.
 * @param {string} location - The place, an absolute URI with a pointer fragment
 * @param {string} origin - The URI the compiled document is held under
 * @returns {string}
 */
export function compiledLocation(location, origin) {
  const hash = origin.indexOf('#');
  const document = hash === -1 ? origin : origin.slice(0, hash);
  return location.startsWith(`${document}#`) ? location.slice(document.length) : location;
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
  constructor(id, leftUri, fragment) {
    this.id = id;
    this.leftUri = leftUri;
    this.fragment = fragment;
  }
}

/**
 * The parses {@link createJsonPointer} made while {@link withParsedPointers}
 * runs, by the anchor flags of the options read, then the base, then the
 * reference: a compile resolves one reference against one base many times
 * over (the walks, the compiler, each hop of a chain), and a parse reads
 * nothing else. `null` outside such a run.
 * @type {Map<string, Map<string, JsonPointer>>[]|null}
 */
let parsedPointers = null;

/**
 * Run `fn`, keeping every parse {@link createJsonPointer} makes until it
 * returns; a run nested in another keeps the outer one's.
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
export function withParsedPointers(fn) {
  const outer = parsedPointers;
  parsedPointers ??= [new Map(), new Map(), new Map(), new Map()];
  try {
    return fn();
  }
  finally {
    parsedPointers = outer;
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
  const byBase = parsedPointers === null || typeof refUri !== 'string' || typeof baseUri !== 'string' ? undefined
    : parsedPointers[(opts.anchorsAllowed == true ? 2 : 0) + (opts.anchorsGlobal == true ? 1 : 0)];
  let byRef;
  if (byBase !== undefined) {
    byRef = byBase.get(baseUri);
    if (byRef === undefined) byBase.set(baseUri, byRef = new Map());
    const known = byRef.get(refUri);
    if (known !== undefined) return new JsonPointer(known.id, known.leftUri, known.fragment);
  }
  try {
    const pointer = parseJsonPointer(refUri, baseUri, opts);
    if (byRef !== undefined) byRef.set(refUri, new JsonPointer(pointer.id, pointer.leftUri, pointer.fragment));
    return pointer;
  }
  catch (e) {
    // `URL` refuses what is no URI with a `TypeError`, and a pointer whose `%` starts no
    // escape is refused with a `URIError`; nothing else here throws either.
    if (!(e instanceof TypeError || e instanceof URIError)) throw e;
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
          baseUri + '#',
          refFragment
        );
      } else {
        // No fragment: simple concatenation
        const resolvedId = baseUri.endsWith('/')
          ? baseUri + refUri
          : baseUri + '/' + refUri;
        return new JsonPointer(resolvedId + '#', resolvedId + '#', null);
      }
    } else {
      // Re-throw the original error if we can't handle it
      throw e;
    }
  }

  // the URL standard lowers the scheme, and the host of a web scheme; every
  // other host is lowered here, so each URI is held and looked up by one spelling.
  // The query is part of that spelling: `a.json?v=1` and `a.json?v=2` are two
  // documents, and neither is `a.json`.
  const href = url.href;
  const [leftUri, fragment] = atFragment(href.startsWith('https:') || href.startsWith('http:') ? href : caselessUri(href));

  if (!isStringWhiteSpace(fragment)) {
    // a json pointer, which a URI fragment percent-encodes: a fragment that
    // decodes to `/…` is one (`#%2F$defs%2Fx` is `#/$defs/x`), and its
    // `%2F`s separate tokens as its `/`s do; every other escape is decoded
    // once, with the token that holds it.
    const pointer = fragment.includes('%') ? fragment.replace(/%2f/gi, '/') : fragment;
    if (pointer.startsWith('/')) {
      // a `%` that starts no escape (`#/a%b`) makes it no URI reference: every
      // read of the pointer decodes its tokens, and that one cannot be decoded
      if (pointer.includes('%')) decodeURIComponent(pointer);
      return new JsonPointer(`${leftUri}#${pointer}`, `${leftUri}#`, pointer);
    }
    // or a plain name (an `$anchor`, a `$dynamicAnchor`, a draft-07 `$id:
    // '#name'`), keyed as the URI spells it: an anchor and a reference to
    // it are spelled alike, whatever characters the name holds.
    if (opts.anchorsAllowed == true) {
      return opts.anchorsGlobal == true
        ? new JsonPointer(`#${fragment}`, `${leftUri}#`, fragment)
        : new JsonPointer(`${leftUri}#${fragment}`, `${leftUri}#`, fragment);
    }
  }
  return new JsonPointer(`${leftUri}#`, `${leftUri}#`, null);
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
 * @property {WeakMap<object, string>} dialectUris - For a place under a
 *   `$schema` (the nearest one on the way to it, its document's or an
 *   embedded resource's), that URI: the compiler reads the vocabularies its
 *   meta-schema declares there (`ValidationRoot#optionsAt`)
 * @property {Map<string, string>} unread - The identifiers a place writes
 *   but no keyword declares (a draft-04 `id` under a declared later draft,
 *   an anchor spelled as a JSON Pointer), each with why: a refusal to
 *   resolve a reference to one says so
 * @property {Map<string, string>} contested - The identifiers two different
 *   registered places declare, each with what names both: a compile that
 *   reads one is refused (`JK0012`), as it would answer by whichever place
 *   was registered first
 * @property {WeakMap<object, string[]|null|undefined>} refs - For a schema
 *   object of a registered document that holds a reference (`$ref`,
 *   `$dynamicRef`, `$recursiveRef`): the place of its `$ref`, then the
 *   targets a compile that builds the object asks for; `null` where they
 *   are not known, and a compile that reaches the object reads every schema
 *   the validator holds. Every schema object a walk read has an entry
 *   (`undefined` where it holds no reference): an object without one below
 *   such a place is data, or lies below a keyword no draft defines, where
 *   no walk goes
 * @property {WeakMap<object, string>} idBases - For an identified schema
 *   object, the base its identifier was read against: a compile that builds
 *   the object as a reference target reads it against the same
 * @property {WeakSet<object>} [rooted] - The documents held under a plain
 *   name alone (`…#root`, where no schema is held for them under the URI
 *   before the fragment): each is the document of its own places, which are
 *   named below that name (`…#root/definitions/s`, {@link underOwnName})
 * @property {WeakMap<object, Set<string>>} [ownRefs] - Per schema object of
 *   such a document, the reference keywords spelled below its name: the only
 *   references that read a place so named ({@link spellsHeldPlace})
 * @property {HeldKept} [kept] - What is kept of the schemas the validator
 *   holds, dropped by the next registration
 */

/**
 * What is kept of the schemas a validator holds until the next registration.
 * What a place reaches is a fact of the place and the id it is read under;
 * what builds what (`above`, `builders`, `always`) is read from the held
 * set alone, when the first compile after a registration reads every key:
 * none of it depends on the compiles that came before.
 * @typedef {object} HeldKept
 * @property {Map<string, any>} at - The value each held key, and each
 *   target met in a held schema, names where it is written ({@link placeAt})
 * @property {Map<object, string[]>} names - The held keys naming each
 *   schema object
 * @property {Map<any, string[]|null>} below - What a compile that reaches a
 *   place reaches next ({@link reachBelow}), `null` where that is not
 *   known: per schema object, and, for a place walked when a reference
 *   named it, per id naming it
 * @property {Map<object, object|string>} above - For each held schema
 *   object, what is built above it: the nearest object a key names, or the
 *   id a place no key names was read under
 * @property {Map<string, (object|string)[]>} builders - Per target, what a
 *   compile may build it at once from, each the object a key names or the
 *   id of a place no key names: the ones at or above a lone `$ref` to it at
 *   an item position (the item shortcut resolves such a reference, to the
 *   end of the chain it starts, when its holder compiles), and the ones
 *   that are a `$ref` to it themselves (a link of such a chain)
 * @property {{ dollarData: boolean, unevaluated: boolean, dynamic: boolean, canElide: boolean }} [scan] -
 *   The features of the held schemas (`ValidationRoot`)
 * @property {Set<object>} [scanned] - The held schema objects that scan read
 * @property {string[]} always - What every compile reaches: the keys of the
 *   held schemas whose identifier is no URI reference (the build refuses the
 *   first, `JK0010`)
 * @property {string[]} unknown - What every compile that holds a reference
 *   reaches besides: the keys and the ids of the places whose references
 *   are not known (what their build builds at once is not known either)
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
export function keptRefBase(places, schema, reading) {
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
 * @param {Map<string, string>} [sites] - Where to record the first `$ref` of
 *   the document naming each target (its location in the document)
 * @param {Map<object, string[]|null|undefined>|WeakMap<object, string[]|null|undefined>} [refs] -
 *   Where to record, for each object holding a reference, the place of its
 *   `$ref` and the targets a compile that builds it asks for
 *   ({@link SchemaPlaces}), and each schema object the walk reads
 * @param {WeakMap<object, string>} [idBases] - Where to record the base each
 *   identifier was read against ({@link SchemaPlaces})
 * @returns {string} The document's own id
 */
export function storeSchemaIdsInMap(schemas, baseUri, schema, opts = new JsonPointerOptions(), onReference = undefined, places = undefined, defaultDraft = null, onFault = undefined, held = undefined, sites = undefined, refs = undefined, idBases = undefined) {
  if (!isObjectClass(schema)) {
    const { id } = createJsonPointer(baseUri, undefined, opts);
    schemas.set(id, schema);
    return id;
  }

  // A root `$id` read without a JSON Pointer fragment ({@link identifierText}):
  // one that is only such a fragment names nothing, as no `$id` does.
  const rootId = isStringType(schema.$id) && !isStringWhiteSpace(schema.$id) ? identifierText(schema.$id) : undefined;
  const { id: rootUri } = createJsonPointer(rootId, baseUri, opts, '$id', '#/%24id');
  if (rootId === undefined) {
    // A URI only a reference names (a `null` placeholder) holds no schema.
    const held = schemas.get(rootUri);
    if (held != null && held !== schema)
      throw new SchemaCompileError('JK0012',
        `the document has no $id, and the URI it is read under, '${rootUri}', names another schema the validator holds; give it an $id of its own`);

    schemas.set(rootUri, schema);
  }

  /** The base the root's `$id` was read against. */
  const given = baseUri;
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
   * Record that what a compile of a place asks for is not known, where the
   * walk leaves part of it unread that a compile may read, and that part
   * holds a reference-shaped object.
   * @param {object} obj - The place
   * @param {any} unread - What the walk leaves unread of it
   */
  const unknown = (obj, unread) => {
    // (read as a compile's own document is: with nothing recorded, any such object ends it)
    if (reachBelow([unread], false, declared, declared) === null) refs?.set(obj, null);
  };
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
      // the walk leaves the place; a compile that reaches it may build it
      unknown(obj, obj);
      return false;
    }
    schemas.set(id, obj);
    if (!declared.has(id)) declared.set(id, place);
    return true;
  };
  /**
   * Record why an identifier written here names nothing, so a refusal to
   * resolve a reference to it says so (`JK0009`).
   * @param {string} text - The identifier as written
   * @param {string} against - The base it resolves against
   * @param {string} why - What names nothing, and the repair
   */
  const unread = (text, against, why) => {
    if (places === undefined) return;
    try {
      places.unread.set(createJsonPointer(text, against, opts).id, why);
    }
    catch (_e) {
      // no URI reference: no reference can name it either
    }
  };

  // A `$schema` is read through the meta-schemas this walk registers and the
  // ones the validator already holds.
  const dialects = { get: (/** @type {string} */ key) => schemas.get(key) ?? held?.get(key) };
  /** @type {{ obj: any, base: string, path: string, draft: number|null, foreign: boolean, dialect: string|undefined, dialectUri: string|undefined }[]} */
  const queue = [{ obj: schema, base: rootUri, path: '#', draft: null, foreign: false, dialect: undefined, dialectUri: undefined }];
  while (queue.length > 0) {
    // @ts-ignore
    const { obj, base, path, draft: inheritedDraft, foreign: inheritedForeign, dialect: inheritedDialect, dialectUri: inheritedUri } = queue.shift();
    // The draft a document declares is inherited by everything below it. A
    // `$schema` that names no draft yet is read as draft-07 and foreign here,
    // and is kept, so a compile that holds its meta-schema reads it by that.
    const named = isStringType(obj.$schema) ? dialectDraft(obj.$schema, dialects) : undefined;
    const draft = named === undefined ? inheritedDraft : named ?? 7;
    places?.drafts.set(obj, draft);
    // a schema object a walk read is told from one no walk read ({@link reachedKeys})
    if (refs && !refs.has(obj)) refs.set(obj, undefined);
    const foreign = named === undefined ? inheritedForeign : named === null;
    if (foreign) places?.foreign.add(obj);
    else places?.foreign.delete(obj);
    const dialect = named === undefined ? inheritedDialect : named === null ? obj.$schema : undefined;
    if (dialect !== undefined) places?.dialects.set(obj, dialect);
    else places?.dialects.delete(obj);
    // the dialect whose vocabularies the place is read under
    const dialectUri = isStringType(obj.$schema) ? obj.$schema : inheritedUri;
    if (dialectUri !== undefined) places?.dialectUris.set(obj, dialectUri);
    else places?.dialectUris.delete(obj);

    // `$id`, or the draft-04 `id` where no known draft is declared
    const declaredDraft = foreign ? null : draft;
    const idName = identifierKeyword(obj, declaredDraft);
    const idKeyword = idName === undefined ? undefined : obj[idName];
    // read without a JSON Pointer fragment, which names nothing: the place
    // the pointer spells keeps its own name
    const idText = isStringType(idKeyword) && !isStringWhiteSpace(idKeyword) ? identifierText(idKeyword) : undefined;
    const hasId = idText !== undefined;
    if (idText !== idKeyword && isStringType(idKeyword) && idName !== undefined)
      unread(idKeyword, base, pointerIdentifier(idName, idKeyword, path));
    if (idName === undefined && isStringType(obj.id) && !isStringWhiteSpace(obj.id))
      unread(obj.id, base, `it is named only by id at '${encodeJsonPointerPath(path, 'id')}', which from draft-06 on is no keyword and names nothing; spell it ${draft !== null && draft >= 2019 && /^#[^/]/.test(obj.id) ? `$anchor: '${obj.id.slice(1)}'` : `$id: '${obj.id}'`}`);
    if (hasId) {
      let id;
      // the root's `$id` was resolved once, against the base it is read under
      if (obj === schema && idName === '$id') id = rootUri;
      else try {
        ({ id } = createJsonPointer(idText, base, opts, idName, encodeJsonPointerPath(path, idName)));
      }
      catch (e) {
        fault(e);
        continue;
      }
      if (!declare(id, obj, path, idName))
        continue;
      idBases?.set(obj, obj === schema && idName === '$id' ? given : base);

      // A document's URI is held with and without its empty fragment. An
      // identifier that holds a fragment (`…/s.json#name`) has no second
      // spelling: a `#` after it would name nothing a URI reference spells.
      if (id.indexOf('#') === id.length - 1) {
        const altId = id.slice(0, -1);
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
      const { id, fragment } = createJsonPointer(`#${obj.$anchor}`, baseUri, opts);
      // a name spelled as a JSON Pointer would shadow the place the pointer
      // names: it declares nothing, and `#/…` stays a pointer
      if (pointerShaped(fragment))
        unread(`#${obj.$anchor}`, baseUri, pointerAnchor('$anchor', obj.$anchor, path));
      else {
        if (!declare(id, obj, path, '$anchor'))
          continue;
        // we reset the baseUri when the $anchor property is set.
        if (!id.startsWith('#')) // except when anchors are global
          baseUri = id;
      }
    }

    // Handle $dynamicAnchor (draft 2020-12) - similar to $anchor but for $dynamicRef
    if (opts.anchorsAllowed == true && isStringType(obj.$dynamicAnchor) && !isStringWhiteSpace(obj.$dynamicAnchor)) {
      const { id, fragment } = createJsonPointer(`#${obj.$dynamicAnchor}`, baseUri, opts);
      if (pointerShaped(fragment))
        unread(`#${obj.$dynamicAnchor}`, baseUri, pointerAnchor('$dynamicAnchor', obj.$dynamicAnchor, path));
      else if (!declare(id, obj, path, '$dynamicAnchor'))
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
    const referenceAt = reference === undefined ? undefined : encodeJsonPointerPath(path, '$ref');
    if (reference !== undefined) {
      try {
        target = createJsonPointer(reference, keepsBase ? base : baseUri, opts, '$ref', referenceAt);
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
      if (keepsBase && createJsonPointer(reference, baseUri, opts, '$ref', referenceAt).id !== ref) places?.keptRefs.add(ref);
      else places?.keptRefs.delete(ref);
      if (!schemas.has(ref))
        schemas.set(ref, null);
      if (sites !== undefined && !sites.has(ref)) sites.set(ref, referenceAt);
      if (onReference !== undefined) onReference(target, referenceAt, keepsBase && draft === null);

      // Don't continue here - we need to process other schemas in the same
      // parent object (like definitions) even if this one has a $ref.
      // The $ref just means we don't traverse INTO this object's properties,
      // but siblings should still be processed.
    }

    // What a compile that builds this object asks for: the place of its
    // `$ref`, then the target each of its references names, read against
    // the base its identifier sets and against the one it leaves. Where a
    // reference is no URI reference, or the object was recorded with other
    // targets (two documents hold it under two bases), they are not known.
    if (refs !== undefined && (reference !== undefined || isStringType(obj.$dynamicRef) || isStringType(obj.$recursiveRef))) {
      /** @type {string[]|null} */
      let asked = null;
      if (reference === undefined || target !== undefined) {
        // the place names a registered document's reference, below the id its place is walked
        // under; a compile's own are located by `sites`
        // (a place walked when named, and a document held under a plain name alone, are named by that id)
        asked = [referenceAt === undefined || refs instanceof Map ? ''
          : (rootUri.indexOf('/', rootUri.indexOf('#')) !== -1 || places?.rooted?.has(schema) ? rootUri : `${withoutFragment(rootUri)}#`) + referenceAt.slice(1)];
        try {
          for (const keyword of REFERENCE_KEYWORDS) {
            if (!isStringType(obj[keyword])) continue;
            const text = schemaReference(obj, keyword);
            asked.push(createJsonPointer(text, baseUri, opts).id);
            if (base !== baseUri) asked.push(createJsonPointer(text, base, opts).id);
          }
        }
        catch (_e) {
          asked = null;
        }
      }
      const known = refs.get(obj);
      // an object read twice (shared by two places, or two documents) asks for the same where its
      // targets are the same, and its first place names it
      refs.set(obj, known === undefined ? asked : known && asked && String(known.slice(1)) === String(asked.slice(1)) ? known : null);
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

            queue.push({ obj: item, base: baseUri, path: nextpath, draft, foreign, dialect, dialectUri });
          }
        }
        else {
          const nextpath = encodeJsonPointerPath(path, key);

          queue.push({ obj: value, base: baseUri, path: nextpath, draft, foreign, dialect, dialectUri });
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

          queue.push({ obj: item, base: baseUri, path: nextpath, draft, foreign, dialect, dialectUri });
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

            queue.push({ obj: item, base: baseUri, path: nextpath, draft, foreign, dialect, dialectUri });
          }
        }
      }
      // The walk leaves the keyword where it reads it as none; a compile may
      // read it all the same: one that holds the meta-schema of a dialect
      // this walk could not resolve, one of a validator that reads the
      // keyword in a meta-schema it holds (`addMetaSchema` walks without it).
      else if (TRAVERSE_SCHEMA_MAP_MAPS.includes(key))
        unknown(obj, value);
    }
  }

  return rootUri;
}

/**
 * A document held under a plain name alone — its root `$id` holds a
 * fragment (`#root`, `…/r.json#root`), and the URI before the fragment is
 * not its own in the validator: a compile's document, another held schema
 * or none has it — with every reference to itself spelled below that name:
 * `#` as `…#root`, `#/definitions/s` as `…#root/definitions/s`. Read
 * against the URI before the fragment, such a reference names a place of
 * whichever document holds that URI.
 *
 * The references rewritten are the `$ref` and the `$dynamicRef` of the
 * schema objects of the document's own resource, where a registration walk
 * reads schema objects ({@link storeSchemaIdsInMap}). A reference to a plain
 * name is left, the name being the document's own registration, and so is
 * everything in an embedded resource (a subschema whose identifier names
 * another URI: its `#` is that resource); the `$ref` beside such an
 * identifier is the document's where the nearest `$schema` declares no
 * draft from 2019-09 on. Only the objects on the way to a rewritten
 * reference are copied.
 * @param {object} document - The document, its root `$id` resolved
 * @param {string} name - The key the document is held under (`…#root`)
 * @param {JsonPointerOptions} opts
 * @param {{ get(key: string): unknown }} held - The schemas the validator
 *   holds: a `$schema` naming one is read by that meta-schema's own
 * @param {WeakMap<object, object>} originals - Where to record, per copy, the object it was made of
 * @param {WeakMap<object, Set<string>>} own - Where to record, per copy, the reference keywords spelled below the name
 * @returns {object} The copy, or `document` where it holds no such reference
 */
export function underOwnName(document, name, opts, held, originals, own) {
  /**
   * A value of the document: a schema object (kind 0), a list of them (1), a map of them (2) or a map of such maps (3).
   * @typedef {{ value: any, kind: number, draft: number|null, parents: [Frame, string|number][], copy: any }} Frame
   */
  /** @type {Map<object, Frame>} */
  const frames = new Map();
  /** @type {Frame[]} */
  const open = [];
  /** @type {[Frame, string, string][]} The references to rewrite: the schema object, the keyword, the new text */
  const rewritten = [];
  const enter = (/** @type {any} */ value, /** @type {number} */ kind, /** @type {number|null} */ draft, /** @type {Frame} */ parent = undefined, /** @type {string|number} */ key = undefined) => {
    let frame = frames.get(value);
    if (frame === undefined) {
      frames.set(value, frame = { value, kind, draft, parents: [], copy: undefined });
      open.push(frame);
    }
    if (parent !== undefined) frame.parents.push([parent, key]);
  };
  enter(document, 0, null);
  const { leftUri: resource } = createJsonPointer(name, undefined, opts);
  while (open.length > 0) {
    const frame = /** @type {Frame} */ (open.pop());
    const { value, kind } = frame;
    if (kind !== 0) {
      for (const [key, item] of Array.isArray(value) ? value.entries() : Object.entries(value))
        if (isObjectClass(item) && !Array.isArray(item)) enter(item, kind === 3 ? 2 : 0, frame.draft, frame, key);
      continue;
    }
    const declared = isStringType(value.$schema) ? dialectDraft(value.$schema, held) : undefined;
    const draft = declared === undefined ? frame.draft : declared;
    // a subschema whose identifier names another URI starts a resource of its own
    let embedded = false;
    const keyword = frame.parents.length > 0 ? identifierKeyword(value, draft) : undefined;
    if (keyword !== undefined && !isStringWhiteSpace(value[keyword])) {
      try {
        const text = identifierText(value[keyword]);
        embedded = text !== undefined && createJsonPointer(text, name, opts).leftUri !== resource;
      }
      catch (_e) {
        embedded = true; // no URI reference: the walk refuses it and reads nothing below
      }
    }
    for (const reference of embedded ? draft === null || draft < 2019 ? ['$ref'] : [] : ['$ref', '$dynamicRef']) {
      if (!hasSchemaReference(value, reference)) continue;
      const text = schemaReference(value, /** @type {'$ref'} */ (reference));
      // a same-document reference, as the URL parse reads one (the controls and spaces before it are no part of it)
      if (!/^[\0- ]*#/.test(text)) continue;
      try {
        const { fragment } = createJsonPointer(text, name, opts);
        if (fragment === null) rewritten.push([frame, reference, name]);
        else if (fragment[0] === '/') rewritten.push([frame, reference, name + fragment]);
      }
      catch (_e) {
        // no URI reference: refused by the compile that reads it
      }
    }
    if (embedded) continue;
    for (const [key, child] of Object.entries(value)) {
      if (child === null || typeof child !== 'object') continue;
      if (TRAVERSE_SCHEMA_OBJECTS.includes(key)) enter(child, Array.isArray(child) ? 1 : 0, draft, frame, key);
      else if (Array.isArray(child)) continue;
      else if (TRAVERSE_SCHEMA_MAPS.includes(key)) enter(child, 2, draft, frame, key);
      else if (TRAVERSE_SCHEMA_MAP_MAPS.includes(key)) enter(child, 3, draft, frame, key);
    }
  }
  /** Copy a value once; the copy of a copy is recorded as made of the first object. @param {Frame} frame @returns {boolean} Whether this call copied it */
  const copy = (frame) => {
    if (frame.copy !== undefined) return false;
    frame.copy = Array.isArray(frame.value) ? frame.value.slice() : { ...frame.value };
    originals.set(frame.copy, originals.get(frame.value) ?? frame.value);
    return true;
  };
  /** @type {Frame[]} */
  const linking = [];
  for (const [frame, keyword, text] of rewritten) {
    if (copy(frame)) linking.push(frame);
    frame.copy[keyword] = text;
    own.set(frame.copy, (own.get(frame.copy) ?? new Set()).add(keyword));
  }
  // every value on the way to a copy is copied too, and holds the copy
  while (linking.length > 0) {
    const frame = /** @type {Frame} */ (linking.pop());
    for (const [parent, key] of frame.parents) {
      if (copy(parent)) linking.push(parent);
      parent.copy[key] = frame.copy;
    }
  }
  return /** @type {Frame} */ (frames.get(document)).copy ?? document;
}

const UNHELD = 'no schema the validator holds has that URI; register it with addSchema, load it with compileAsync, or fix the reference';

/**
 * The identifier a schema object declares where a compile computes a base
 * or a resource from it, read as the walk reads it: a non-empty `$id`, else
 * the draft-04 `id` where the object's document declares no known draft
 * ({@link identifierKeyword}), each without a JSON Pointer fragment
 * ({@link identifierText}).
 * @param {any} schema - A schema object
 * @param {number|null} declaredDraft - The known draft its document declares
 *   ({@link declaredDraftOf}), null for none or an unknown one
 * @returns {any} The `$id` or the `id`, or undefined
 */
export function identifierOf(schema, declaredDraft) {
  if (!isObjectClass(schema)) return undefined;
  if (schema.$id) return isStringType(schema.$id) ? identifierText(schema.$id) : schema.$id;
  return identifierKeyword(schema, declaredDraft) === 'id' && !isStringWhiteSpace(schema.id) ? identifierText(schema.id) : undefined;
}

/**
 * The known draft a walked schema object's document declares: null for
 * none, for a `$schema` naming no draft this package knows, and for a place
 * no walk recorded.
 * @param {object} schema
 * @param {{ drafts?: WeakMap<object, number|null>, foreign?: WeakSet<object> }|undefined} places
 * @returns {number|null}
 */
export function declaredDraftOf(schema, places) {
  return places?.foreign?.has(schema) ? null : places?.drafts?.get(schema) ?? null;
}

/**
 * Whether a fragment the URL parse read is a JSON Pointer: a plain name
 * spelled like one names nothing.
 * @param {string|null|undefined} fragment
 * @returns {boolean}
 */
function pointerShaped(fragment) {
  return typeof fragment === 'string' && fragment.startsWith('/');
}

/**
 * Why a reference spelled as a pointer-shaped anchor names nothing.
 * @param {string} keyword - `$anchor` or `$dynamicAnchor`
 * @param {string} name - The anchor as written
 * @param {string} path - The place declaring it
 * @returns {string}
 */
function pointerAnchor(keyword, name, path) {
  return `'#${name}' is a JSON Pointer, and the ${keyword} '${name}' at '${encodeJsonPointerPath(path, keyword)}' spelled like it names nothing; give the anchor a plain name (a letter or '_', then letters, digits, '-', '.', '_')`;
}

/**
 * Why a reference spelled as the pointer an identifier's fragment spells
 * does not reach the place declaring it.
 * @param {string} keyword - `$id` or `id`
 * @param {string} id - The identifier as written
 * @param {string} path - The place declaring it
 * @returns {string}
 */
function pointerIdentifier(keyword, id, path) {
  return `the fragment of the ${keyword} '${id}' at '${encodeJsonPointerPath(path, keyword)}' is a JSON Pointer, which names no place: the pointer reads the document; name the place with $anchor (draft-07 and earlier: an $id fragment with a plain name)`;
}

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
 * A refusal to resolve a reference (`JK0008`, `JK0009`), located at the
 * `$ref` that names the target; any other error as it is.
 * @param {unknown} error
 * @param {string|undefined} place - The `$ref`, as `docPath`
 * @returns {unknown}
 */
export function locatedRefusal(error, place) {
  return place !== undefined && error instanceof SchemaCompileError && error.docPath === undefined
    && (error.code === 'JK0008' || error.code === 'JK0009')
    ? new SchemaCompileError(error.code, error.reason, place) : error;
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
 * @param {boolean} [tentative] - Answer `undefined` instead of refusing
 *   when no schema the map holds has the reference's document URI
 * @returns {{id: string, schema: any}|undefined}
 * @throws {SchemaCompileError} `JK0009` when no schema the map holds has
 *   that URI, or its pointer misses; `JK0012` when the identifier it is read
 *   through names two registered places
 */
export function resolveRefSchemaShallow(schemas, refUri, baseUri, opts = new JsonPointerOptions(), places = undefined, tentative = false) {
  const { id: base, leftUri: document, fragment: spelt } = createJsonPointer(refUri, baseUri, opts);
  const id = base;
  // A document held under a plain name alone is the document of that name
  // and of every place below it (`…#root/definitions/s`): the pointer is
  // read from it, whatever is held under the URI before the fragment.
  const rooted = places?.rooted;
  const start = rooted === undefined || spelt == null || spelt[0] === '/' ? -1 : pointerStart(schemas, base, rooted);
  const leftUri = start === -1 ? document : base.slice(0, start);
  const fragment = start === -1 ? spelt : base.slice(start) || null;
  // a URI only a reference names (a `null` placeholder) holds no schema; a
  // plain name the map holds resolves whoever holds the URI before it (the
  // name of a document held under plain names alone, or of a place in one)
  if (schemas.get(leftUri) == null && (fragment == null || fragment[0] === '/' || schemas.get(base) == null)) {
    if (tentative) return undefined;
    throw unresolvedReference(id);
  }
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
    if (schemas.get(base) != null) {
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
  // The tokens as the reference spells them, for the id of the place.
  const spelled = fragment.split('/').slice(1);

  // Traverse the schema based on the JSON pointer. The place reached is
  // named from the last resource the pointer enters (an identifier naming a
  // URI starts one), as the walk registered it: two places below one
  // identifier are two places, and a loop is told from a chain by them. A
  // fragment-only identifier names its own object and starts no resource.
  let current = '';
  let resource = leftUri;
  let from = 0;
  /** The identifier's URI when the place the pointer ends at declares one */
  let declared;
  for (let n = 0; n < fragments.length; n++) {
    const part = fragments[n];
    current = current + '/' + part;
    if (!isBoolOrObjectClass(schema[part]) && !Array.isArray(schema[part]))
      throw unresolvedReference(id, false, `'${current}' is not a schema in '${leftUri}'; fix the pointer`);

    schema = schema[part];
    declared = undefined;
    const identifier = identifierOf(schema, declaredDraftOf(schema, places));
    if (isStringType(identifier) && !isStringWhiteSpace(identifier)) {
      const named = createJsonPointer(identifier, resource, opts, schema.$id ? '$id' : 'id');
      if (!identifier.startsWith('#')) {
        resource = named.leftUri;
        from = n + 1;
        declared = named.id;
      }
      else if (named.fragment != null && !named.fragment.startsWith('/'))
        declared = named.id;
    }
  }

  return { id: declared ?? (from === spelled.length ? resource : `${resource}/${spelled.slice(from).join('/')}`), schema };
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

/** The keywords whose value names another schema. */
const REFERENCE_KEYWORDS = /** @type {const} */ (['$ref', '$dynamicRef', '$recursiveRef']);

/**
 * The value a schema id names where it is written: the entry of its
 * document walked by its JSON Pointer, or its own entry where it has none.
 * @param {Map<string, any>} schemas
 * @param {string} id - A resolved reference, or a key of the map
 * @param {WeakSet<object>} [rooted] - The documents held under a plain name
 *   alone ({@link pointerStart})
 * @returns {any}
 */
export function placeAt(schemas, id, rooted) {
  const start = pointerStart(schemas, id, rooted);
  if (start === -1 || start === id.length) return schemas.get(id);
  let node = schemas.get(id.slice(0, start));
  for (const part of decodeJsonPointerPath(id.slice(start))) node = node?.[part];
  return node;
}

/**
 * Where the JSON Pointer of a schema id starts: after the `#` of its
 * document (`…/s.json#/a`), or after the plain name of a document held
 * under that name alone (`…#root/a`, {@link SchemaPlaces} `rooted`); the
 * id's length where the id is such a name, and -1 where it holds no pointer.
 * @param {Map<string, any>} schemas
 * @param {string} id - A resolved reference, or a key of the map
 * @param {WeakSet<object>} [rooted] - The documents held under a plain name alone
 * @returns {number}
 */
export function pointerStart(schemas, id, rooted) {
  const hash = id.indexOf('#');
  if (hash === -1) return -1;
  if (id[hash + 1] === '/') return hash + 1;
  if (rooted === undefined) return -1;
  // (a name may hold a `/` itself: the longest key of the map decides nothing, the first rooted one does)
  for (let slash = id.indexOf('/', hash); ; slash = id.indexOf('/', slash + 1)) {
    const key = slash === -1 ? id : id.slice(0, slash);
    if (rooted.has(schemas.get(key))) return key.length;
    if (slash === -1) return -1;
  }
}

/**
 * Whether a reference names a place below the name of a document held under
 * a plain name alone (`…#root/definitions/s`) from anywhere but that
 * document's own references, which alone are spelled so ({@link
 * underOwnName}): read as a URI, such a fragment is one plain name that
 * nothing declares, so the reference is refused as one to such a name.
 * @param {Map<string, any>} schemas
 * @param {string} id - The reference, resolved
 * @param {SchemaPlaces|undefined} places - What the walks read
 * @param {object} holder - The schema object holding the reference
 * @param {string} keyword - Its keyword
 * @returns {boolean}
 */
export function spellsHeldPlace(schemas, id, places, holder, keyword) {
  const rooted = places?.rooted;
  if (rooted === undefined) return false;
  const start = pointerStart(schemas, id, rooted);
  return start !== -1 && start < id.length && id[start - 1] !== '#' && places?.ownRefs?.get(holder)?.has(keyword) !== true;
}

/**
 * The name of the document held under a plain name alone ({@link
 * pointerStart}) that a base lies in (`…#root`, for `…#root` or
 * `…#root/properties/n`), or undefined: the document a `$recursiveRef: "#"`
 * there names, which the URI before the name does not hold.
 * @param {Map<string, any>} schemas
 * @param {string} base
 * @param {WeakSet<object>} [rooted]
 * @returns {string|undefined}
 */
export function heldNameOf(schemas, base, rooted) {
  const start = rooted === undefined ? -1 : pointerStart(schemas, base, rooted);
  return start === -1 || base[start - 1] === '#' ? undefined : base.slice(0, start);
}

/**
 * The base the place a pointer id names is built against at its key's turn:
 * its document's, or the one the nearest identifier above the place sets,
 * each read against the base its walk read it against. The pointer's tokens
 * are decoded as every pointer read decodes them ({@link decodeJsonPointerPath}):
 * a member whose name holds `/`, `~` or a character a URI fragment escapes
 * is followed as any other, and so is one named `""`.
 * @param {Map<string, any>} schemas
 * @param {string} id - A key holding a JSON Pointer fragment
 * @param {SchemaPlaces} places - What the walks read
 * @returns {string}
 */
export function pointerBase(schemas, id, places) {
  const start = pointerStart(schemas, id, places.rooted);
  let base = documentBase(id, start);
  // (the document: under its plain name, or under its URI with the empty fragment)
  let node = schemas.get(start !== -1 && id[start - 1] !== '#' ? base : `${base}#`);
  for (const part of decodeJsonPointerPath(id.slice(Math.max(start, 0)))) {
    if (!node) break;
    const identifier = identifierOf(node, declaredDraftOf(node, places));
    if (identifier) {
      const { id: resolved } = createJsonPointer(identifier, places.idBases.get(node) ?? base, undefined, node.$id ? '$id' : 'id');
      base = resolved.endsWith('#') ? resolved.slice(0, -1) : resolved;
    }
    // (a member a keyword does not spell is looked for among the definitions)
    node = node[part] || node.$defs?.[part] || node.definitions?.[part];
  }
  return base;
}

/**
 * The base a place directly in the document of a pointer id is built
 * against: the document's URI without its empty fragment, or the plain name
 * a document is held under alone.
 * @param {string} id - A key holding a JSON Pointer
 * @param {number} start - Where its pointer starts ({@link pointerStart})
 * @returns {string}
 */
function documentBase(id, start) {
  return id.slice(0, id[start - 1] === '#' ? start - 1 : start);
}

/**
 * What a compile that reads `start` reaches next: the target of every
 * reference at and below it, as a walk recorded them, and the keys naming
 * the registered schema objects met, each followed by the place of the
 * `$ref` naming it (`''` for none). `null` where a reference whose targets
 * are not known is met, or, unless `lax`, a reference-shaped object no walk
 * recorded.
 * @param {any[]} start - The values to read
 * @param {boolean} held - Whether `start` is one place of a held schema:
 *   a registered schema object met below it is left to the keys naming it
 * @param {{ get(key: object): string[]|null|undefined }} refs - What the walks recorded
 * @param {Map<object, string[]>} names - The held keys naming each schema object
 * @param {Map<object, object|string>} [above] - Where to record `owner` as
 *   what is built above each object read
 * @param {Map<string, (object|string)[]>} [builders] - Where to record
 *   `owner` as a builder of each target `start` names itself, and of each a
 *   lone `$ref` at an item position below it names
 * @param {object|string} [owner] - What a compile builds `start` as: the
 *   object, where a key names it, else the id it is read under
 * @param {boolean} [lax] - Whether a reference-shaped object no walk
 *   recorded is passed over: below a place whose walk recorded every
 *   reference a compile of it asks for, it is data, or lies below a keyword
 *   no draft defines, and is compiled only when a reference names its place
 * @returns {string[]|null}
 */
function reachBelow(start, held, refs, names, above, builders, owner = start[0], lax) {
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  const stack = start.slice();
  while (stack.length) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object' || seen.has(node)) continue;
    if (seen.size) above?.set(node, owner);
    seen.add(node);
    if (!Array.isArray(node)) {
      const keys = names.get(node);
      if (keys) {
        for (const key of keys) out.push(key, '');
        if (held && seen.size > 1) continue;
      }
      const asked = refs.get(node);
      if (asked === null || (asked === undefined && !lax && (isStringType(node.$ref) || isStringType(node.$dynamicRef) || isStringType(node.$recursiveRef)))) return null;
      for (let i = 1; asked && i < asked.length; i++) out.push(asked[i], asked[0]);
      for (const item of builders ? [seen.size > 1 || node, node.items, node.prefixItems].flat() : []) {
        const lone = isObjectClass(item) && (item === node || Object.keys(item).length === 1) ? refs.get(item) : undefined;
        for (let i = 1; lone && i < lone.length; i++) builders.set(lone[i], [...builders.get(lone[i]) ?? [], owner]);
      }
    }
    for (const value of Object.values(node)) stack.push(value);
  }
  return out;
}

/**
 * The keys and targets a compile reaches of the schemas a validator holds:
 * the ones the references of the documents it was handed name, the ones the
 * references at and below each such target's place name, and the keys
 * naming every registered schema object on the way, each with the place of
 * the first `$ref` met naming it (`''` for none). A compile resolves and
 * builds only those. `undefined` when it meets a reference whose targets
 * are not known ({@link reachBelow}): it then reads every schema it holds.
 *
 * A target no walk read — a place below a keyword no draft defines, as an
 * operation's schema in a contract document or a member of an OpenAPI
 * document's `components/schemas` — is walked when a reference names it,
 * as a registration walks a document: under the id that names it, under
 * the compile's options and from no declared draft, registering nothing.
 * What its references ask for is read from that walk. Its targets are not
 * known where the walk throws (a reference that is no URI reference),
 * where the place declares an identifier of its own (no walk registered
 * it, and a compile reads it by what it has built), or where an identifier
 * above it sets another base than its document's: the place is then read
 * strictly, and a reference-shaped object in it ends the reach.
 *
 * The keys naming a registered schema object that brings one of them into
 * being are among them too, without what else that object reaches: the one
 * around it (a place is built as a member of the document around it, at
 * that document's turn) and the ones that build it at once (a lone `$ref`
 * at an item position), through every place such a reference builds on the
 * way, a place no key names being followed by its id. Built in the order a
 * compile of everything builds them, each comes into being where it did,
 * so which references are resolved on first use, and count toward the
 * reference depth bound, does not change.
 *
 * Two kinds of held place are among them whatever the compile reaches: the
 * schemas whose identifier is no URI reference, the first of which the
 * build then refuses (`JK0010`), as it refused every compile; and, for a
 * compile that holds a reference, the places whose references are not
 * known, whose build may bring any place into being.
 *
 * What a place of the held schemas reaches is read once per held set and
 * kept in `places.kept` until the next registration; what builds what is
 * read when the first compile after a registration reads every held key.
 * @param {any[]} roots - The documents the compile was handed
 * @param {Map<object, string[]|null>} own - What the walks of those documents recorded
 * @param {SchemaPlaces} places - What the walks of the registered documents read
 * @param {Map<string, any>} held - The schemas the validator holds
 * @param {JsonPointerOptions} opts - The options the compile walks a document under
 * @returns {Map<string, string|null>|undefined} Each with the place of the
 *   `$ref` naming it, `''` for none, `null` for one entered only because
 *   its references are not known or its identifier is no URI reference
 */
export function reachedKeys(roots, own, places, held, opts) {
  const first = !places.kept;
  const { at, names, below, above, builders, always, unknown } = places.kept ??= { at: new Map(), names: new Map(), below: new Map(), above: new Map(), builders: new Map(), always: [], unknown: [] };
  // what builds what is read from the held set alone: while every key it holds is read
  let up = first ? above : undefined;
  /**
   * What the place an id names reaches next, read once per held set.
   * @param {string} id
   * @returns {string[]|null}
   */
  const read = (id) => {
    let place = at.get(id);
    // only a place the held schemas have is kept: a compile's own targets are as many as its compiles
    if (place == null && (place = placeAt(held, id, places.rooted)) != null) at.set(id, place);
    // a place no key names is read once too; what is no schema object reaches nothing
    let next = below.get(below.has(place) ? place : id);
    if (next !== undefined) return next;
    const by = up && builders;
    const owner = names.has(place) ? place : id;
    // what a walk read is read once; any other place once per id naming it
    const walked = !isObjectClass(place) || places.refs.has(place);
    if (!walked) {
      // No walk read the place: it is walked now under the id that names
      // it, where its key builds it against its document's base and it
      // declares no identifier of its own.
      const fresh = new WeakMap();
      const identified = new Map();
      try {
        if (pointerBase(held, id, places) === documentBase(id, pointerStart(held, id, places.rooted))) {
          storeSchemaIdsInMap(new Map(), id, place, opts, undefined, undefined, null, undefined, held, undefined, fresh, identified);
          if (!identified.size) {
            below.set(id, next = reachBelow([place], true, fresh, names, up, by, owner, true));
            return next;
          }
        }
      }
      catch (_e) {
        // an identifier or a reference that is no URI reference
      }
    }
    // a place a walk read asks for what the walk recorded; one that is not walked now
    // holds no reference it is known to ask for
    below.set(walked ? place : id, next = reachBelow([place], true, places.refs, names, up, by, owner, walked));
    return next;
  };
  if (first) {
    for (const [key, value] of held) {
      const place = placeAt(held, key, places.rooted);
      at.set(key, place);
      if (place !== null && typeof place === 'object') names.set(place, [...names.get(place) ?? [], key]);
      const identifier = identifierOf(value, declaredDraftOf(value, places));
      try {
        if (identifier) createJsonPointer(identifier, key);
      }
      catch (_e) {
        always.push(key);
      }
    }
    // Every named place is read for what builds on it, and so is what an
    // item reference builds at once. One whose references are not known is
    // built by every compile that holds a reference: what it builds at once
    // is not known either.
    for (const key of held.keys()) if (read(key) === null) unknown.push(key);
    for (const id of builders.keys()) if (read(id) === null) unknown.push(id);
    up = undefined;
  }
  /** @type {Map<string, string|null>} */
  const reached = new Map();
  /** @type {string[]} */
  const queue = [];
  /** @type {string[]|null|undefined} */
  let next = reachBelow(roots, false, own, names);
  for (let n = 0; next !== null; n++) {
    for (let i = 0; i < next.length; i += 2) {
      if (reached.has(next[i])) continue;
      reached.set(next[i], next[i + 1]);
      queue.push(next[i]);
    }
    if (n === queue.length) {
      // the keys added here are read in their turn: what brings them into being is built too
      // (a compile without a reference calls nothing that another build could have built before it;
      // entered without a place, `null`, such a schema and what builds it: the failures a build passes on are
      // not the compile's there, `#precompileRefs`)
      for (const id of queue.length ? [...always, ...unknown] : always) if (!reached.has(id)) reached.set(id, null);
      for (const [key, place] of reached) {
        for (const from of [above.get(at.get(key)), ...builders.get(key) ?? []]) {
          // (the object a key names, or the id of a place no key names: followed to what builds that)
          for (const name of typeof from === 'string' ? [from] : names.get(from) ?? []) if (!reached.has(name)) reached.set(name, place && '');
        }
      }
      return reached;
    }
    next = read(queue[n]);
  }
  return undefined;
}

/**
 * Resolve the `null` placeholders the walks left in `schemas`: every one, or,
 * for a compile that reaches only some of the schemas its validator holds,
 * the ones it reaches; the others stay `null`, which reads as not held.
 * @param {Map<string, any>} schemas
 * @param {JsonPointerOptions} [opts]
 * @param {SchemaPlaces} [places] - What the walks read
 * @param {number|null} [reading] - The draft the compile reads a place that
 *   declares none under
 * @param {Map<string, string>} [sites] - The `$ref` that names each target in
 *   the compiled document: a refusal to resolve one is located there
 * @param {Map<string, string>} [reached] - The keys and targets the compile
 *   reaches ({@link reachedKeys}), each with the place of the `$ref` naming
 *   it in a registered document: a refusal to resolve one is located there
 * @throws {SchemaCompileError} `JK0008` for a target of a draft-07 `$ref`
 *   whose `$id` does not set its base that nothing resolves, `JK0009` for
 *   any other target nothing resolves
 */
export function restoreSchemaRefsInMap(schemas, opts = new JsonPointerOptions(), places = undefined, reading = null, sites = undefined, reached = undefined) {
  for (const [id, item] of schemas.entries()) {
    // a target this compile does not reach is left to the compile that does
    if (item != null || reached?.has(id) === false)
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
      if (finalId !== id && schemas.get(finalId) == null) {
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
        const unread = kept ? undefined : places?.unread.get(id);
        throw locatedRefusal(unread !== undefined ? unresolvedReference(id, false, unread)
          : failure !== undefined && !kept ? failure : unresolvedReference(id, kept), sites?.get(id) ?? (reached?.get(id) || undefined));
      }

      schemas.set(id, schema);
    }
  }
}

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
 * Whether a schema reached through a `$ref` is a pure hop that
 * {@link resolveRefSchemaDeep} follows and flattens away: a `$ref` with no
 * keyword beside it that asserts.
 * @param {any} item - The schema a reference reached
 * @param {TraverseOptions} opts
 * @returns {boolean}
 */
export function isReferenceHop(item, opts) {
  return isObjectClass(item) && hasSchemaReference(item, '$ref') && !hasRefSiblings(item, opts.propertyDependencies === true);
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
 * @param {boolean} [tentative] - Answer `undefined` instead of refusing
 *   when a hop names a document the map holds no schema under
 *   ({@link resolveRefSchemaShallow})
 * @returns {{id: string, schema: any}|undefined}
 * @throws {RefCycleError} when the chain comes back to an id it visited
 */
export function resolveRefSchemaDeep(schemas, baseUri, refschema, opts = new TraverseOptions(), clean = undefined, places = undefined, reading = null, tentative = false) {
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
      if (item !== refschema && !isReferenceHop(item, opts))
        return { id: base, schema: item };
      const ref = schemaReference(item, '$ref');
      // a hop of a chain spelling a place below a held document's name from outside it names nothing
      if (item !== refschema && places?.rooted !== undefined) {
        const { id: spelt } = createJsonPointer(ref, base, opts);
        if (spellsHeldPlace(schemas, spelt, places, item, '$ref')) {
          if (tentative) return undefined;
          throw locatedRefusal(unresolvedReference(spelt), keywordLocation(base, '$ref'));
        }
      }
      const hop = resolveRefSchemaShallow(schemas, ref, base, opts, places, tentative);
      if (hop === undefined) return undefined;
      const { id, schema } = hop;

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
 * @property {WeakSet<object>} [rooted] - the documents held under a plain
 *   name alone ({@link SchemaPlaces})
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
  // The subschemas a keyword applies to members or items are read on a
  // stack of their own, each before the keys after it (as `canFail` would
  // recurse into them), so a chain nested past the host stack is read too.
  /** @type {{ schema: Record<string, any>, keys: string[], at: number }[]} */
  const open = [];
  let next = schema;
  for (;;) {
    if (next !== true) {
      if (!isObjectClass(next) || hasSchemaReference(next, '$ref') || appliesDynamicReference(next, '$recursiveRef', reading))
        return false;
      open.push({ schema: next, keys: Object.keys(next), at: 0 });
    }
    next = undefined;
    while (next === undefined && open.length > 0) {
      const frame = open[open.length - 1];
      if (frame.at === frame.keys.length) {
        open.pop();
        continue;
      }
      const key = frame.keys[frame.at++];
      if (PASS_THROUGH_KEYWORDS.has(key)) next = frame.schema[key];
      else if (canFail(key, frame.schema[key], reading)) return false;
    }
    if (next === undefined) return true;
  }
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
  // what the walks read, for the identifiers a pointer passes on its way
  const read = /** @type {SchemaPlaces} */ (/** @type {unknown} */ ({ drafts: reading.drafts, foreign: reading.foreign, contested: new Map(), rooted: reading.rooted }));
  let schema = root;
  let base = rootId;
  let at = rootId;
  let rootResource;
  // Each step visits a new (schema, base) pair, of which a document has
  // finitely many; the cap only ends a walk whose bases never repeat.
  for (let steps = 0; steps <= schemas.size * 4 + 64; steps++) {
    if (!isObjectClass(schema)) return;
    const identifier = identifierOf(schema, declaredDraftOf(schema, reading));
    if (isStringType(identifier) && !isStringWhiteSpace(identifier)) {
      base = createJsonPointer(identifier, base, opts, schema.$id ? '$id' : 'id').id;
      at = base;
    }
    rootResource ??= withoutFragment(base);
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
        if (withoutFragment(base) !== rootResource || typeof dynamic !== 'string' || !dynamic.startsWith('#')
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
      target = resolveRefSchemaShallow(schemas, ref, base, opts, read);
    }
    catch {
      return; // a target not loaded is reported where it is used
    }
    schema = target.schema;
    base = at = target.id;
  }
}
