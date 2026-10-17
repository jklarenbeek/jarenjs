//@ts-check

import { isArrayClass, isObjectClass, isStringType } from '@jarenjs/core';
import { SCHEMA_VALUE_KEYWORDS, SCHEMA_MAP_KEYWORDS, SCHEMA_LIST_KEYWORDS } from '@jarenjs/core/schema';

/**
 * Whether a keyword value is a `$data` reference: an object whose `$data` is
 * a pointer string (empty for the root, relative or absolute). An object with
 * any other `$data` member is a plain value.
 * @param {*} value - The keyword value
 * @returns {boolean}
 */
export function isDollarDataRef(value) {
  return isObjectClass(value) && isStringType(value.$data);
}

/** Reference walks accept legacy additionalItems, but do not register contentSchema. */
const REFERENCE_VALUES = /* @__PURE__ */ SCHEMA_VALUE_KEYWORDS.filter((key) => key !== 'contentSchema');
export const TRAVERSE_SCHEMA_OBJECTS = /* @__PURE__ */ REFERENCE_VALUES.concat(SCHEMA_LIST_KEYWORDS, ['additionalItems']);

/** Reference registration also visits definitions and its compatibility containers. */
export const TRAVERSE_SCHEMA_MAPS = /* @__PURE__ */ SCHEMA_MAP_KEYWORDS
  .concat(['dependencies', 'dependentRequired', 'definitions', '$defs', 'components']);

/**
 * Keywords whose value is a map of maps: the outer names are member names of
 * the instance, the inner names are member values, and the innermost values are
 * the subschemas. Neither level holds keywords.
 */
export const TRAVERSE_SCHEMA_MAP_MAPS = /* @__PURE__ */ Object.freeze(['propertyDependencies']);

/**
 * The draft that introduced a keyword the validator compiles only from that
 * draft on: a document that declares an older draft reads it as an unknown
 * keyword, one that declares none reads it.
 */
export const ASSERTION_SINCE = Object.freeze({
  prefixItems: 2020, dependentRequired: 2019, dependentSchemas: 2019, minContains: 2019, maxContains: 2019,
  unevaluatedProperties: 2019, unevaluatedItems: 2019,
});

/**
 * Whether a place reads a keyword as the draft that introduced it does
 * ({@link ASSERTION_SINCE}): its document declares no draft, or that draft
 * or a later one. Every other keyword is read wherever it appears.
 * @param {string} keyword
 * @param {number|null|undefined} declaredDraft - The draft the place's document declares, or null when it declares none
 * @returns {boolean}
 */
export function readsSince(keyword, declaredDraft) {
  const since = Object.hasOwn(ASSERTION_SINCE, keyword) ? /** @type {Record<string, number>} */ (ASSERTION_SINCE)[keyword] : undefined;
  return since === undefined || declaredDraft == null || declaredDraft >= since;
}

/** The vocabulary meta-schemas each draft publishes beside its dialect. */
const META_2019 = ['core', 'applicator', 'validation', 'meta-data', 'format', 'content'];
const META_2020 = ['core', 'applicator', 'unevaluated', 'validation', 'meta-data', 'format-annotation', 'format-assertion', 'content'];

/** The hyper-schema, link and output meta-schemas each draft publishes beside its dialect. */
const HYPER_2019 = ['hyper-schema', 'links', 'meta/hyper-schema', 'output/schema', 'output/hyper-schema'];
const HYPER_2020 = ['hyper-schema', 'links', 'meta/hyper-schema', 'output/schema'];

/**
 * The dialects this package reads by name, each URI as published but for its
 * scheme and an empty fragment (see {@link officialUri}): every meta-schema
 * json-schema.org publishes for a draft (its dialect, its vocabulary
 * meta-schemas, its hyper-schema, link and output schemas), and the Jaren
 * 2020-12 dialect (2020-12 plus the `$query` vocabulary this package
 * implements).
 * The draft-next dialect, the one that defines `propertyDependencies`, is
 * read as the newest draft this package implements (2020-12).
 * @type {ReadonlyMap<string, number>}
 */
const KNOWN_DIALECTS = /* @__PURE__ */ new Map([
  ...['schema', 'hyper-schema', 'links'].map((name) => /** @type {[string, number]} */ ([`//json-schema.org/draft-06/${name}`, 6])),
  ...['schema', 'hyper-schema', 'links', 'hyper-schema-output'].map((name) => /** @type {[string, number]} */ ([`//json-schema.org/draft-07/${name}`, 7])),
  ['//json-schema.org/draft/2019-09/schema', 2019],
  ...META_2019.map((name) => /** @type {[string, number]} */ ([`//json-schema.org/draft/2019-09/meta/${name}`, 2019])),
  ...HYPER_2019.map((name) => /** @type {[string, number]} */ ([`//json-schema.org/draft/2019-09/${name}`, 2019])),
  ['//json-schema.org/draft/2020-12/schema', 2020],
  ...META_2020.map((name) => /** @type {[string, number]} */ ([`//json-schema.org/draft/2020-12/meta/${name}`, 2020])),
  ...HYPER_2020.map((name) => /** @type {[string, number]} */ ([`//json-schema.org/draft/2020-12/${name}`, 2020])),
  ['//json-schema.org/draft/next/schema', 2020],
  ['//json-schema.org/draft/next/output/schema', 2020],
  ...META_2020.map((name) => /** @type {[string, number]} */ ([`//json-schema.org/draft/next/meta/${name}`, 2020])),
  ['//jarenjs.dev/schemas/2020-12/schema', 2020],
  ['//jarenjs.dev/schemas/2020-12/meta/query', 2020],
]);

/** A URI's scheme and authority: the user part, then the host and port. */
const SCHEME_AUTHORITY = /^([a-z][a-z0-9+.-]*:)(?:\/\/((?:[^/?#@]*@)?)([^/?#]*))?/i;

/**
 * A URI with its scheme and its host in lower case, as RFC 3986 reads them
 * (both are case-insensitive): every URI a validator holds a schema under,
 * and every URI it looks one up by, is read through this one spelling. The
 * user part, the path, the query, the fragment and every percent-encoding
 * keep their case; text that is no absolute URI is returned as written.
 * @param {string} uri
 * @returns {string}
 */
export function caselessUri(uri) {
  const head = SCHEME_AUTHORITY.exec(uri);
  if (head === null) return uri;
  const [all, scheme, user = '', host] = head;
  const lowered = scheme.toLowerCase() + (host === undefined ? ''
    : `//${user}${host.replace(/%[0-9a-f]{2}|[A-Z]+/gi, (part) => part[0] === '%' ? part : part.toLowerCase())}`);
  return lowered === all ? uri : lowered + uri.slice(all.length);
}

/**
 * The key a validator holds a schema document under: its URI read by
 * {@link caselessUri}, with an empty fragment when it has none.
 * @param {string} uri
 * @returns {string}
 */
export function heldUriKey(uri) {
  const key = caselessUri(uri);
  return key.includes('#') ? key : `${key}#`;
}

/**
 * A URI as the dialect and vocabulary tables compare it: read by
 * {@link caselessUri}, `http:` and `https:` alike, and a URI and the same URI
 * with an empty fragment (`…/schema#`) alike. Anything else, the path
 * included, is compared exactly.
 * @param {string} uri
 * @returns {string}
 */
function officialUri(uri) {
  const key = caselessUri(uri);
  const rest = /^https?:\/\//.test(key) ? key.slice(key.indexOf(':') + 1) : key;
  return rest.endsWith('#') ? rest.slice(0, -1) : rest;
}

/** The validation vocabulary of each draft that has vocabularies. */
const VALIDATION_VOCABULARIES = /* @__PURE__ */ new Set([
  '//json-schema.org/draft/2019-09/vocab/validation',
  '//json-schema.org/draft/2020-12/vocab/validation',
  '//json-schema.org/draft/next/vocab/validation',
]);

/** The format-assertion vocabulary (2020-12 on; 2019-09 has none). */
const FORMAT_ASSERTION_VOCABULARIES = /* @__PURE__ */ new Set([
  '//json-schema.org/draft/2020-12/vocab/format-assertion',
  '//json-schema.org/draft/next/vocab/format-assertion',
]);

/**
 * Which of the vocabularies this package switches on a meta-schema's
 * `$vocabulary` declares, each matched by its exact URI (`http:`/`https:`
 * and an empty fragment read alike). A vocabulary declared `false` is
 * declared too: `false` only lets a validator that does not implement it go
 * on without it.
 * @param {Record<string, unknown>} vocabulary - A meta-schema's `$vocabulary`
 * @returns {{ validation: boolean, formatAssertion: boolean }}
 */
export function declaredVocabularies(vocabulary) {
  let validation = false;
  let formatAssertion = false;
  for (const uri of Object.keys(vocabulary)) {
    const key = officialUri(uri);
    if (VALIDATION_VOCABULARIES.has(key)) validation = true;
    else if (FORMAT_ASSERTION_VOCABULARIES.has(key)) formatAssertion = true;
  }
  return { validation, formatAssertion };
}

/**
 * The draft a `$schema` URI names, or null when it names none this package
 * knows. A URI of the dialect table names its draft. Any other URI names the
 * draft of the meta-schema it identifies, when `held` holds one: that
 * meta-schema's own `$schema` is read the same way, so a dialect that
 * extends 2020-12 under a URI of its own is read as 2020-12.
 * @param {string} uri - The `$schema` value
 * @param {{ get(key: string): unknown }} [held] - The schemas a validator holds, by URI
 * @returns {number|null}
 */
export function dialectDraft(uri, held = undefined) {
  /** @type {Set<string>|undefined} */
  let seen;
  for (;;) {
    const known = KNOWN_DIALECTS.get(officialUri(uri));
    if (known !== undefined) return known;
    // only an absolute URI can name a schema a validator holds
    if (held === undefined || !/^[a-z][a-z0-9+.-]*:/i.test(uri)) return null;
    const key = heldUriKey(uri);
    if (seen?.has(key)) return null;
    (seen ??= new Set()).add(key);
    const meta = held.get(key) ?? (key.endsWith('#') ? held.get(key.slice(0, -1)) : undefined);
    if (meta === null || typeof meta !== 'object' || typeof (/** @type {any} */ (meta)).$schema !== 'string') return null;
    uri = /** @type {any} */ (meta).$schema;
  }
}

/**
 * Detects the JSON Schema draft version from the schema's $schema property:
 * the draft its URI names ({@link dialectDraft}), read through the
 * meta-schemas `held` holds. A `$schema` that names no draft this package
 * knows — an unregistered dialect, or one whose meta-schema leads to none —
 * is read as draft-07.
 * @param {object} schema - The JSON schema
 * @param {{ get(key: string): unknown }} [held] - The schemas a validator holds, by URI
 * @returns {number} - The draft version (6, 7, 2019, or 2020)
 */
export function detectSchemaDraft(schema, held = undefined) {
  if (!schema || typeof schema !== 'object') return 7; // default to draft7
  const uri = /** @type {any} */ (schema).$schema;
  return (typeof uri === 'string' ? dialectDraft(uri, held) : null) ?? 7;
}

/**
 * Whether `propertyDependencies` is a keyword at a schema location: the
 * `propertyDependencies` option is on and the location's document does not
 * declare a draft older than 2020-12. Everywhere else it is an unknown
 * keyword, whose value is not walked, registered or compiled.
 * @param {boolean|null|undefined} enabled - The `propertyDependencies` option
 * @param {number|null} declaredDraft - The draft the document declares, or null when it declares none
 * @returns {boolean}
 */
export function admitsPropertyDependencies(enabled, declaredDraft) {
  return enabled === true && (declaredDraft == null || declaredDraft >= 2020);
}

/**
 * The `prefixItems` array a schema applies, or `undefined`. A document that
 * declares a draft before 2020-12 via `$schema` treats `prefixItems` as an
 * unknown keyword; a document that declares none reads it. The validator's
 * item keywords and the normalizer read it through this one predicate.
 * @param {{ declaredDraft: number|null }} schemaObj - The compiled object, or anything carrying its declared draft
 * @param {any} jsonSchema
 * @returns {unknown[] | undefined}
 */
export function readPrefixItems(schemaObj, jsonSchema) {
  const prefixItems = jsonSchema.prefixItems;
  return !readsSince('prefixItems', schemaObj.declaredDraft) || !(isArrayClass(prefixItems) && prefixItems.length >= 1)
    ? undefined
    : prefixItems;
}
