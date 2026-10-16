//@ts-check
//#region closed option sets
// Every public reader and writer entry point admits its options against its
// own table before anything runs: a member outside the table - a misspelt
// `delimeter` that would change the parse, a `maxDepht` that would disable a
// hostile-input guard - and a value of the wrong type (`headers: 'yes'`,
// `mode: 'JSON'`) are refused rather than ignored. A refusal is a
// `TypeError`, the caller's programming error, as an out-of-range limit
// already is (limits.js); an unknown member's message names the nearest
// valid one through `@jarenjs/core/object`. The values the machines already
// validate where they read them (the limits, the CSV reader's
// single-character delimiter, quote and comment, the JSONX `detach`
// pattern) are typed there, once. `undefined` and `null` options mean no
// options, and a member set to `undefined` is absent.

import { isPlainOptions, refuseUnknownMembers } from '@jarenjs/core/object';

/**
 * A member's rule: whether a present value is admitted, and what the
 * refusal says it must be.
 * @typedef {readonly [(value: any) => boolean, string]} Rule
 */

/** @typedef {Readonly<Record<string, Rule>>} OptionTable */

/**
 * A rule: `admits` judges a present value (`null` included - each rule says
 * whether `null` keeps the default), `what` completes "must be ...".
 * @param {(value: any) => boolean} admits @param {string} what @returns {Rule}
 */
const rule = (admits, what) => Object.freeze(/** @type {Rule} */ ([admits, what]));

/** Validated where the value is read (limits.js, the CSV and JSONX machines). */
const READ_DOWNSTREAM = rule(() => true, '');
const BOOLEAN = rule((v) => v === null || typeof v === 'boolean', 'true or false');
const CALLBACK = rule((v) => v === null || typeof v === 'function', 'a function');
const SIGNAL = rule((v) => v === null || (typeof v === 'object' && typeof v.aborted === 'boolean'), 'an AbortSignal');
const TEXT = rule((v) => v === null || typeof v === 'string', 'a string');

/**
 * One of a closed set of strings (`null` keeps the default).
 * @param {...string} values
 * @returns {Rule}
 */
function oneOf(...values) {
  return rule((v) => v === null || values.includes(v), values.map((v) => `'${v}'`).join(' or '));
}

/** @param {readonly string[]} names @returns {Record<string, Rule>} */
const limits = (names) => Object.fromEntries(names.map((name) => [name, READ_DOWNSTREAM]));

/** @param {Record<string, Rule>} rules @returns {OptionTable} */
const table = (rules) => Object.freeze(rules);

/** @param {OptionTable} from @param {readonly string[]} names @returns {OptionTable} */
const without = (from, names) =>
  table(Object.fromEntries(Object.entries(from).filter(([name]) => !names.includes(name))));

//#region the tables

/** The CSV reader: `parseCsv`, `createCsvStreamReader`, `parseCsvStream`. */
export const CSV_READ = table({
  delimiter: READ_DOWNSTREAM,
  quote: READ_DOWNSTREAM,
  comment: READ_DOWNSTREAM,
  headers: rule((v) => v === null || typeof v === 'boolean' || Array.isArray(v), 'true, false or an array of column names'),
  repair: BOOLEAN,
  trim: BOOLEAN,
  typed: BOOLEAN,
  emptyAsNull: BOOLEAN,
  skipEmptyLines: BOOLEAN,
  onEvent: CALLBACK,
  onRepair: CALLBACK,
  ...limits(['maxTotalBytes', 'maxRecordBytes', 'maxFieldBytes', 'maxColumns']),
});

/** `iterateCsvStream`: the reader, plus cancellation. */
export const CSV_ITERATE = table({ ...CSV_READ, signal: SIGNAL });

/** `parseCsvDocument` and `sniffCsvDialect`: the reader, with `'auto'` delimiter and headers. */
export const CSV_DOCUMENT = table({
  ...CSV_READ,
  headers: rule((v) => v === null || v === 'auto' || typeof v === 'boolean' || Array.isArray(v),
    "true, false, 'auto' or an array of column names"),
});

/** The CSV writer: `stringifyCsv`, `stringifyCsvChunks`, `createCsvRowFormatter`. */
export const CSV_WRITE = table({
  delimiter: TEXT,
  quote: TEXT,
  newline: TEXT,
  fields: rule((v) => v === null || Array.isArray(v), 'an array of column names'),
  header: BOOLEAN,
  neutralizeFormulas: BOOLEAN,
});

/** `createCsvStreamWriter`: the writer, plus a chunk sink. */
export const CSV_STREAM_WRITE = table({ ...CSV_WRITE, onChunk: CALLBACK });

/** `stringifyCsvStream`: the writer, plus cancellation. */
export const CSV_PULL_WRITE = table({ ...CSV_WRITE, signal: SIGNAL });

/** The JOSL reader: `parseJosl`, `createStreamReader`, `parseJoslStream`. */
export const JOSL_READ = table({
  mode: oneOf('josl', 'toml'),
  onEvent: CALLBACK,
  ...limits(['maxTotalBytes', 'maxRecordBytes', 'maxTokenBytes', 'maxDepth', 'maxRetainedValues']),
});

/** `parseToml`: the reader minus `mode`, which it fixes to `'toml'`. */
export const TOML_READ = without(JOSL_READ, ['mode']);

/** `iterateJoslStream`: the reader, plus cancellation. */
export const JOSL_ITERATE = table({ ...JOSL_READ, signal: SIGNAL });

/** `parseJoslCst`: the grammar and the event sink - a CST enforces no limits. */
export const CST_READ = table({ mode: JOSL_READ.mode, onEvent: CALLBACK });

/** `parseTomlCst`: the event sink. */
export const TOML_CST_READ = without(CST_READ, ['mode']);

/** The JOSL writer: `stringifyJosl`, `stringifyJoslChunks`. */
export const JOSL_WRITE = table({
  mode: oneOf('josl', 'toml'),
  onNull: oneOf('error', 'omit'),
  onRegExp: oneOf('error', 'string'),
});

/** `stringifyToml`: the writer minus `mode`. */
export const TOML_WRITE = without(JOSL_WRITE, ['mode']);

/** `createStreamWriter`: the writer, plus a chunk sink and buffering. */
export const JOSL_STREAM_WRITE = table({ ...JOSL_WRITE, onChunk: CALLBACK, buffer: BOOLEAN });

/** `stringifyJoslStream`: the writer, plus cancellation. */
export const JOSL_PULL_WRITE = table({ ...JOSL_WRITE, signal: SIGNAL });

/** `toGbnf`: the grammar's dialect. */
export const GBNF = table({ mode: oneOf('josl', 'toml') });

/** The JSONX dialect and event sink, which both readers take. */
const JSONX_GRAMMAR = table({ mode: oneOf('jsonx', 'json'), onEvent: CALLBACK });

/**
 * `parseJsonx`: the grammar and the two readings of a model's reply (the
 * limits are the stream reader's).
 */
export const JSONX_READ = table({
  ...JSONX_GRAMMAR,
  fences: oneOf('error', 'strip'),
  duplicateKeys: oneOf('last', 'error'),
});

/** The JSONX stream reader: `createJsonxStreamReader`, `parseJsonxStream`. */
export const JSONX_STREAM_READ = table({
  ...JSONX_GRAMMAR,
  partialText: BOOLEAN,
  detach: READ_DOWNSTREAM,
  ...limits(['maxTotalBytes', 'maxTokenBytes', 'maxDepth', 'maxRetainedValues']),
});

/** `stringifyJsonx`: the dialect and the indentation. */
export const JSONX_WRITE = table({
  mode: oneOf('jsonx', 'json'),
  indent: rule((v) => v === null || typeof v === 'number' || typeof v === 'string', 'a number or a string'),
});

//#endregion

/**
 * Admit an entry point's options: `undefined` and `null` are none; anything
 * else must be a plain object whose every member the table names, each
 * present value passing its rule.
 * @param {unknown} options - The caller's options
 * @param {OptionTable} rules - The entry point's table
 * @param {string} owner - The entry point, for the refusal
 * @param {(key: string, hint: string) => Error} [unknown] - The refusal of
 *   a member the table does not name, when the entry point words it itself
 * @returns {Record<string, any>} The options, unchanged
 * @throws {TypeError} When the options are not a plain object, name a
 *   member the table does not, or give one a value of the wrong type
 */
export function admitOptions(options, rules, owner, unknown = undefined) {
  if (options === undefined || options === null)
    return {};
  if (!isPlainOptions(options))
    throw new TypeError(`${owner}: options must be a plain object`);
  refuseUnknownMembers(options, Object.keys(rules),
    unknown ?? ((key, hint) => new TypeError(`${owner}: unknown option '${key}'${hint}`)));
  for (const key of Object.keys(options)) {
    const value = options[key];
    if (value === undefined)
      continue;
    const [admits, what] = rules[key];
    if (!admits(value))
      throw new TypeError(`options.${key} must be ${what}`);
  }
  return options;
}

//#endregion
