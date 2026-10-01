//@ts-check
/**
 * @file The query engine's English message catalog: one template per
 * `query/*` message id an error can carry. Every `JQ` error the engine
 * raises names its sentence as a `messageId` and the values in it as
 * `params`; its `reason` is that template rendered here, so the English
 * text and the catalog cannot drift apart. `renderQueryMessage` renders
 * the same error through another catalog — a `@jarenjs/locales` pack
 * mirrors these keys one for one — and the contract catalog is the
 * pattern this follows (CONTRACT-FORMAT §7).
 *
 * A value inside a message is a param, never pasted into the template.
 * A param may itself be a message reference (`{ messageId, params }`):
 * the description of an item the engine met (`query/item/*`) is one, so
 * "got a string" is translated whole. Text another component produced —
 * a path parser's or a host function's message — is a `{detail}` param
 * and stays as it came.
 */

import { compileMessageCatalog } from '@jarenjs/core/message';
import { isJsonObject } from '@jarenjs/core/object';

import { JsonQueryCompileError, JsonQueryRuntimeError } from './errors.js';

/**
 * The plain English catalog: message id → template (`{param}`
 * placeholders; `{{` is a literal `{`). Exported for the locale packs to
 * mirror key for key.
 */
export const queryMessagesEn = Object.freeze({
  // a reason that names no message of its own: an error a host or another
  // package built with the bare constructor
  'query/reason': '{reason}',
  'query/detail': '{detail}',

  // what an item is, quoted inside other messages
  'query/item/sequence': 'a sequence of {count} items',
  'query/item/empty': 'the empty sequence',
  'query/item/null': 'null',
  'query/item/array': 'an array',
  'query/item/object': 'an object',
  'query/item/string': 'a string',
  'query/item/number': 'a number',
  'query/item/boolean': 'a boolean',
  'query/item/other': 'a {type}',

  // JQ0001–JQ0011: the document
  'query/mixed-keys': 'an object cannot mix $-prefixed and plain keys',
  'query/unknown-operator': "unknown operator '{key}'",
  'query/unknown-operator-suggest': "unknown operator '{key}' (did you mean '{suggestion}'?)",
  'query/unknown-operator-use': "unknown operator '{key}' (use {use})",
  'query/unknown-operator-none': "unknown operator '{key}' (no operator does this in jaren-query)",
  // the {use} of query/unknown-operator-use when it is more than an
  // operator's name: the composition this language spells the guess with
  'query/use/head-of-reverse': '$head of $reverse',
  'query/use/jsonpath-filter': 'a JSONPath filter like $[?(@.x > 1)] or $where in a $for',
  'query/use/for-return': 'a $for phrase with $return',
  'query/use/for-phrase': 'a $for phrase',
  'query/use/sort-objects': '$sort (sorts scalars; order objects via a $for over a sorted key)',
  'query/use/sort-scalars': '$sort (scalars only)',
  'query/use/entries-get': '$entries then $get',
  'query/use/geo-parse-text': '$geo-parse to read one, $geo-text to write one',
  'query/use/bbox-intersects': '$bbox-intersects (boxes only — real overlay is deliberately absent)',
  'query/use/renderer': 'the renderer — the language cannot make a projected coordinate at all, so a measurement can never land on one; measurement here is geodesic',
  'query/use/renderer-project': "the renderer, as for '$project'",
  'query/use/similarity': '$similarity (higher is closer; there is no distance metric)',
  'query/use/knn-desc': "$orderby on a $similarity key with $dir 'desc', then $subsequence for the k",
  'query/use/knn': '$orderby on a $similarity key, then $subsequence',
  'query/use/top-k': '$orderby then $subsequence',
  'query/use/resample-fill': "$resample with a 'fill'",
  'query/use/resample-locf': "$resample with fill 'locf'",
  'query/use/resample-linear': "$resample with fill 'linear'",
  'query/use/rolling-mean': "$rolling with aggregate 'mean'",
  'query/phrase-keys': 'invalid phrase key combination ({keys})',
  'query/phrase-alone': "'{key}' cannot form a phrase on its own",
  'query/operands-array': "'{op}' takes an array of expressions",
  'query/operands-exactly': "'{op}' takes exactly {min} operand(s), got {count}",
  'query/operands-at-least': "'{op}' takes at least {min} operand(s), got {count}",
  'query/operands-range': "'{op}' takes {min} to {max} operand(s), got {count}",
  'query/variable-name-expected': 'expected a variable name string',
  'query/variable-name-invalid': "'{name}' is not a valid variable name",
  'query/variable-duplicate': "duplicate binding of variable '{name}' within one phrase",
  'query/bindings-object': "'{clause}' takes an object of variable bindings",
  'query/bindings-empty': "'{clause}' requires at least one binding",
  'query/extended-let': "the extended binding form is not available in '$let'",
  'query/extended-quantifier': 'the extended binding form is not available in quantifiers',
  'query/window-kind': "'$window' must be 'tumbling' or 'sliding'",
  'query/window-size-required': "a '$window' binding requires '$size'",
  'query/window-size': "'$size' must be a positive integer",
  'query/window-step': "'$step' must be a positive integer",
  'query/window-required': "'$size'/'$step' require '$window'",
  'query/for-key': "'{key}' is not a valid key of an extended '$for' binding",
  'query/for-in-required': "an extended '$for' binding requires '$in'",
  'query/for-at': "'$at' takes a variable name string",
  'query/for-allowing-empty': "'$allowing-empty' takes a boolean",
  'query/orderby-spec': "'$orderby' takes a key spec or a non-empty array of key specs",
  'query/orderby-spec-key': "'{key}' is not a valid key of an $orderby key spec",
  'query/orderby-spec-key-required': "an explicit $orderby key spec requires '$key'",
  'query/orderby-dir': "'$dir' must be 'asc' or 'desc'",
  'query/orderby-empty': "'$empty' must be 'least' or 'greatest'",
  'query/collation-name': "'$collation' must be a registered collation name",
  'query/collation-unregistered': "'$collation' names no registered collation '{name}'",
  'query/fold-binding': "'$fold' takes exactly one accumulator binding",
  'query/as-object': "'$as' takes an object of variable-name to schema members",
  'query/as-empty': "'$as' requires at least one member",
  'query/as-unbound': "'$as' names '{name}', which is not bound by this phrase's '$for'/'$let'",
  'query/count-variable': "'$count' takes a variable name string",
  'query/map-entry': 'a $map entry must be an array of exactly two expressions',
  'query/call-arguments': "'$call' requires ['name', ...argument expressions]",
  'query/call-unregistered': "'$call' names no registered function '{name}'",
  'query/apply-arguments': "'$apply' takes [selector] or [selector, mode]",
  'query/apply-mode': "the '$apply' mode must be a literal string",
  'query/document-value': 'a query document cannot contain a {type}',
  'query/invalid-path': "'{path}' is not a valid path or escape",
  'query/invalid-path-detail': "'{path}' is not a valid path: {detail}",
  'query/unbound-variable': "'${name}' is neither bound by an enclosing phrase nor a declared external (declared externals: {declared})",
  'query/unbound-variable-closed': "'${name}' is neither bound by an enclosing phrase nor a declared external (this query was compiled closed-world, declaring no externals)",
  'query/version-unknown': 'unknown query format version {version}',
  'query/version-envelope': "the version envelope requires exactly the keys '$query' and '$expr'",
  'query/schema-no-compiler': 'schema operators require a type-test compiler (options.compileTypeTest)',
  'query/schema-invalid': 'invalid schema literal: {detail}',
  'query/schema-no-predicate': 'the type-test compiler did not return a predicate function',
  'query/depth-limit': 'the query nests {depth} expressions deep, more than limits.depth ({limit})',
  'query/spec-member-required': "'{name}' needs a spec member '{member}'",
  'query/spec-invalid': "'{name}' spec: {detail}",
  'query/date-pattern': "'$date-format' pattern: {detail}",
  'query/time-bucket-invalid': "'$time-bucket': {detail}",
  'query/lexical-arguments': '$lexical needs [provider, text expression, literal request]',
  'query/lexical-unregistered': "lexical provider '{name}' is not registered",
  'query/lexical-rejected': 'lexical provider rejected the request',
  'query/lexical-no-request': 'lexical provider did not compile a request',
  'query/series-spec-object': "'{operator}' takes a literal spec object, got {got}",
  'query/series-spec-member': "'{operator}' has no spec member '{name}'; it admits {allowed}",
  'query/series-spec-member-suggest': "'{operator}' has no spec member '{name}' (did you mean '{suggestion}'?); it admits {allowed}",
  'query/series-member-enum': "'{member}' is {allowed}, got {got}",
  'query/series-member-number': "'{member}' is a finite number, got {got}",
  'query/series-member-instant': "'{member}' is epoch milliseconds or an RFC 3339 string, got {got}",
  'query/series-member-duration': "'{member}' is a duration string or a count of milliseconds, got {got}",
  'query/series-member-path': "'{member}' is a singular path into the row, got {got}",
  'query/series-member-path-detail': "'{member}': {detail}",
  'query/series-member-not-path': "'{member}': is not a path",
  'query/series-member-whole-row': "'{member}' selects the whole row rather than a member of it",
  'query/series-member-singular': "'{member}' is a singular path — one name or index per segment, no wildcard, descendant or filter",
  'query/series-zone': "'zone' is an IANA zone name, got {got}",
  'query/series-zone-provider': "the zone '{zone}' needs a time-zone provider: this suite bundles no tzdb, so a named zone is compiled with options.zoneProvider (toParts / toEpoch). 'UTC' and a numeric 'offset' need none",
  'query/series-calendar': 'the calendar context: {detail}',

  // JQ2001–JQ2012: evaluation
  'query/expected-string': 'expected a string, got {got}',
  'query/expected-number': 'expected a number, got {got}',
  'query/cast-string': 'cannot cast {got} to a string',
  'query/cast-number': 'cannot cast {got} to a number',
  'query/not-json-number': "'{value}' is not a JSON number",
  'query/arithmetic-operand': 'arithmetic requires a number operand, got {got}',
  'query/aggregate-not-number': 'aggregate items must be numbers, got {got}',
  // a database aggregate pushed down to SQL counts its nulls but sees no item
  'query/aggregate-null': 'an aggregate requires numbers or strings, got null',
  'query/minmax-mixed': "'$min'/'$max' items must be all numbers or all strings, got {got}",
  'query/sort-mixed': "'$sort' items must be all numbers or all strings, got {got}",
  'query/regex-invalid': "'{pattern}' is not a valid I-Regexp pattern",
  'query/replace-empty-match': "'$replace' pattern '{pattern}' matches the zero-length string",
  'query/range-bounds': "'$range' bounds must be safe integers, got {got}",
  'query/range-guard': "'$range' of {count} items exceeds the {limit}-item resource guard",
  'query/index-of-item': "'$index-of' takes a single search item, got {got}",
  'query/expected-datetime': 'expected an RFC 3339 date, time, or date-time string, got {got}',
  'query/no-date-component': "'{value}' carries no date component",
  'query/no-time-component': "'{value}' carries no time component",
  'query/calendar-unit': "expected a calendar unit ('year', 'month', 'day', ...), got {got}",
  'query/expected-duration': 'expected an ISO 8601 duration, got {got}',
  'query/expected-units': 'expected a number of units, got {got}',
  'query/expected-date-pattern': 'expected a date pattern, got {got}',
  'query/datetime-epoch': "'$datetime' takes epoch milliseconds, got {got}",
  'query/datetime-range': '{value} is outside the range RFC 3339 can spell',
  'query/span-no-date': 'cannot measure a span from a value with no date',
  'query/expected-bucket-width': 'expected a bucket width, got {got}',
  'query/expected-geo': 'expected a GeoJSON value or a [longitude, latitude] position, got {got}',
  'query/expected-wkt': 'expected a Well-Known Text string, got {got}',
  'query/expected-geohash': 'expected a geohash cell string, got {got}',
  'query/geohash-precision': 'a geohash precision must be an integer from 1 to 12, got {got}',
  'query/simplify-tolerance': 'a simplification tolerance is a non-negative number of degrees, got {got}',
  'query/expected-vector': 'expected a vector (an array of numbers), got {got}',
  'query/expected-vector-item': 'expected a vector (an array of numbers), got {got} at index {index}',
  'query/expected-series': 'expected a series (records with an instant and a reading), got {got}',
  'query/expected-interval': 'expected an interval record {{ start, end }, got {got}',
  'query/member-cardinality': "member '{name}' evaluated to {count} items; an object member takes exactly one",
  'query/groupby-key': 'a $groupby key must be the empty sequence or a single item, got {got}',
  'query/lexical-text': 'lexical text must be one string',
  'query/idiv-zero': "'$idiv' by zero",
  'query/mod-zero': "'$mod' by zero",
  'query/ebv-sequence': 'the effective boolean value of a sequence of two or more items is undefined',
  'query/map-key': 'a $map key must evaluate to a single string, got {got}',
  'query/orderby-key': 'an $orderby key must be the empty sequence, a number, or a string, got {got}',
  'query/orderby-number-string': 'cannot order a number against a string in $orderby',
  'query/orderby-string-number': 'cannot order a string against a number in $orderby',
  'query/external-unbound': "external parameter '{name}' was not bound",
  'query/assert-failed': "'$assert' failed: {got} does not satisfy the schema",
  'query/assert-failed-item': "'$assert' failed: item {index} ({got}) does not satisfy the schema",
  'query/as-failed': "variable '{name}' failed its '$as' schema: {got} does not satisfy it",
  'query/as-failed-item': "variable '{name}' failed its '$as' schema: item {index} ({got}) does not satisfy it",
  'query/fold-limit': 'a fold accumulator exceeded {limit} items (limits.sequenceItems)',
  'query/phrase-limit': 'a phrase materialized more than {limit} items (limits.sequenceItems)',
  'query/steps-limit': 'the query exceeded limits.steps ({limit} expression evaluations)',
  'query/result-limit': 'the query result has {count} items, more than limits.resultItems ({limit})',
  'query/function-threw': "registered function '{name}' threw: {detail}",
  'query/operator-threw': "registered operator '{name}' failed: {detail}",
  'query/input-undefined': 'the input document is undefined, which is not a JSON value',
  'query/lexical-threw': 'lexical provider threw',
  'query/lexical-result': 'lexical provider returned an invalid or incomplete result',
});

/** The compiled English catalog (module-level singleton). */
export const queryCatalogEn = compileMessageCatalog(queryMessagesEn);

/**
 * A message reference: a message id and its params, rendered by the
 * catalog that renders the message holding it.
 * @param {string} messageId
 * @param {Record<string, any>} [params]
 * @returns {{ messageId: string, params: Record<string, any> }}
 */
export function messageRef(messageId, params = {}) {
  return Object.freeze({ messageId, params: Object.freeze(params) });
}

/** @param {any} value @returns {value is { messageId: string, params: Record<string, any> }} */
const isMessageRef = (value) => isJsonObject(value) && typeof value.messageId === 'string'
  && Object.keys(value).length === 2 && isJsonObject(value.params);

/** Compiled locale catalogs, by the pack object they were compiled from. */
const compiledPacks = new WeakMap();

/** @param {Record<string, any>} catalog @returns {Readonly<Record<string, (params: object) => string>>} */
function compiled(catalog) {
  if (catalog === queryCatalogEn) return queryCatalogEn;
  let out = compiledPacks.get(catalog);
  if (out === undefined) compiledPacks.set(catalog, out = compileMessageCatalog(catalog));
  return out;
}

/**
 * Render a message id and its params through a catalog: message
 * references among the params first, then the template. A catalog
 * without the id renders the English one.
 * @param {string} messageId
 * @param {Record<string, any>} params
 * @param {Record<string, any>} [catalog] - a plain catalog (a locale pack)
 *   or a compiled one; English by default
 * @returns {string}
 */
export function renderQueryMessageId(messageId, params, catalog = queryCatalogEn) {
  const target = compiled(catalog);
  /** @type {Record<string, any>} */
  const resolved = {};
  for (const name of Object.keys(params ?? {})) {
    const value = params[name];
    resolved[name] = isMessageRef(value) ? renderQueryMessageId(value.messageId, value.params, catalog) : value;
  }
  const template = Object.hasOwn(target, messageId) ? target[messageId]
    : Object.hasOwn(queryCatalogEn, messageId) ? queryCatalogEn[messageId] : null;
  return template === null ? String(resolved.reason ?? messageId) : template(resolved);
}

/**
 * The message of a query error (`JsonQueryCompileError`,
 * `JsonQueryRuntimeError`) in a catalog's language: its `messageId` and
 * `params` rendered through `catalog` — a `@jarenjs/locales` pack, say —
 * or in English. The error's own `reason` is the English rendering.
 * @param {{ messageId?: string, params?: Record<string, any>, reason?: string }} error
 * @param {Record<string, any>} [catalog] - a locale pack, plain or compiled
 * @returns {string}
 * @example
 * import { nl } from '@jarenjs/locales';
 * try { compileJsonQuery({ $nope: 1 }); }
 * catch (error) { renderQueryMessage(error, nl); } // "onbekende operator '$nope' (bedoelde je '$some'?)"
 */
export function renderQueryMessage(error, catalog = undefined) {
  const messageId = typeof error?.messageId === 'string' ? error.messageId : 'query/reason';
  const params = isJsonObject(error?.params) ? error.params : { reason: String(error?.reason ?? '') };
  return renderQueryMessageId(messageId, params, catalog ?? queryCatalogEn);
}

/**
 * A compile-time query error whose reason is a catalog message.
 * @param {string} code
 * @param {string} messageId
 * @param {Record<string, any>} params
 * @param {string} docPath
 * @param {{ cause?: unknown }} [options]
 * @returns {JsonQueryCompileError}
 */
export function queryCompileError(code, messageId, params, docPath, options = undefined) {
  return new JsonQueryCompileError(code, renderQueryMessageId(messageId, params), docPath,
    { ...options, messageId, params });
}

/**
 * A runtime query error whose reason is a catalog message.
 * @param {string} code
 * @param {string} messageId
 * @param {Record<string, any>} params
 * @param {string} docPath
 * @param {{ cause?: unknown }} [options]
 * @returns {JsonQueryRuntimeError}
 */
export function queryRuntimeError(code, messageId, params, docPath, options = undefined) {
  return new JsonQueryRuntimeError(code, renderQueryMessageId(messageId, params), docPath,
    { ...options, messageId, params });
}
