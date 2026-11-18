//@ts-check
/**
 * @file A declared temporal member's CHECK and key spellings (MODEL-FORMAT
 * §2, `temporals`), both engines': its JSON type by name, its text, a text
 * held to one of the calendar's forms, no member beyond the kind's own, a
 * key's text in the order the table keys it by, and the member a stored
 * CHECK reads. They live beside the seam that plans them
 * (`@jarenjs/db/temporals`) rather than in the dialects, so a store that
 * declares no temporal member carries none of them.
 */
import { stringLiteral } from '../dialect.js';

/** The GLOB alternatives a calendar value's text is one of, by form (SQLite). */
const DIGIT2 = '[0-9][0-9]';
const DATE_GLOB = `${DIGIT2}${DIGIT2}-${DIGIT2}-${DIGIT2}`;
const FRACTIONS = ['', '.[0-9]', `.${DIGIT2}`, `.${DIGIT2}[0-9]`];
/** @type {Record<string, string[]>} */
const TEMPORAL_GLOBS = {
  date: [DATE_GLOB],
  time: [`${DIGIT2}:${DIGIT2}`, ...FRACTIONS.map((fraction) => `${DIGIT2}:${DIGIT2}:${DIGIT2}${fraction}`)],
  instant: FRACTIONS.map((fraction) => `${DATE_GLOB}T${DIGIT2}:${DIGIT2}:${DIGIT2}${fraction}Z`),
};

/** The regular expression a calendar value's text matches, by form (PostgreSQL). */
const TEMPORAL_DATE = '[0-9]{4}-[0-9]{2}-[0-9]{2}';
/** @type {Record<string, string>} */
const TEMPORAL_PATTERNS = {
  date: `^${TEMPORAL_DATE}$`,
  time: '^[0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]{1,3})?)?$',
  instant: `^${TEMPORAL_DATE}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,3})?Z$`,
};

/**
 * @typedef {{ typeOf: (doc: string, path: string) => string, textType: string,
 *   textOf: (doc: string, path: string) => string, is: (a: string, b: string) => string,
 *   matches: (sql: string, form: string) => string,
 *   rest: (doc: string, path: string, members: string[]) => string,
 *   keyText: (sql: string) => string, epochType: string, stampType: string, booleanTrue: string,
 *   checkPath: (sql: string) => { name: string }[] | null }} TemporalSpelling
 */

/** @param {any} dialect @returns {TemporalSpelling} */
const sqliteSpelling = (dialect) => Object.freeze({
  typeOf: dialect.jsonTypeName,
  textType: "'text'",
  textOf: (/** @type {string} */ doc, /** @type {string} */ path) => `json_extract(${doc}, ${stringLiteral(path)})`,
  is: (/** @type {string} */ a, /** @type {string} */ b) => `${a} IS ${b}`,
  matches: (/** @type {string} */ sql, /** @type {string} */ form) =>
    `(${TEMPORAL_GLOBS[form].map((glob) => `${sql} GLOB '${glob}'`).join(' OR ')})`,
  rest: (/** @type {string} */ doc, /** @type {string} */ path, /** @type {string[]} */ members) =>
    `json_remove(json_extract(${doc}, ${stringLiteral(path)}), ${members.map((member) => stringLiteral(dialect.jsonPathText([{ name: member }]))).join(', ')}) = '{}'`,
  keyText: (/** @type {string} */ sql) => sql,
  epochType: 'INTEGER',
  stampType: 'TEXT',
  booleanTrue: '1',
  // the member a temporal CHECK reads, out of the CHECK's first test
  checkPath: (/** @type {string} */ sql) => {
    const match = /^CASE WHEN json_type\("doc", '((?:[^']|'')*)'\) IS NULL THEN /.exec(String(sql));
    const segments = match === null ? null : dialect.pathOfText(match[1].replace(/''/g, "'"));
    return segments === null || segments.some((/** @type {any} */ segment) => !('name' in segment)) ? null : segments;
  },
});

/** @param {any} dialect @returns {TemporalSpelling} */
const postgresSpelling = (dialect) => Object.freeze({
  typeOf: (/** @type {string} */ doc, /** @type {string} */ path) => `jsonb_typeof((${doc} #> ${stringLiteral(path)}))`,
  textType: "'string'",
  textOf: (/** @type {string} */ doc, /** @type {string} */ path) => `(${doc} #>> ${stringLiteral(path)})`,
  // spelled as the server keeps it, which reads it back so
  is: (/** @type {string} */ a, /** @type {string} */ b) => `(NOT (${a} IS DISTINCT FROM ${b}))`,
  matches: (/** @type {string} */ sql, /** @type {string} */ form) => `${sql} ~ '${TEMPORAL_PATTERNS[form]}'`,
  rest: (/** @type {string} */ doc, /** @type {string} */ path, /** @type {string[]} */ members) =>
    `(${members.reduce((held, member) => `(${held} - ${stringLiteral(member)})`, `(${doc} #> ${stringLiteral(path)})`)} = '{}'::jsonb)`,
  keyText: (/** @type {string} */ sql) => `((${sql}) COLLATE "C")`,
  epochType: 'bigint',
  stampType: 'text COLLATE "C"',
  booleanTrue: 'true',
  // the member a temporal CHECK reads, out of the CHECK's first test, as
  // this dialect writes it or the server keeps it (every step a name)
  checkPath: (/** @type {string} */ sql) => {
    const match = /^\s*CASE\s+WHEN\s+\(*jsonb_typeof\(\(\s*(?:"doc"|doc)\s*#>\s*'\{((?:[^']|'')*)\}'(?:::text\[\])?\s*\)\)\s*IS NULL/.exec(String(sql));
    return match === null ? null : dialect.pathOfText(`{${match[1].replace(/''/g, "'")}}`);
  },
});

/** @type {WeakMap<object, TemporalSpelling>} */
const SPELLINGS = new WeakMap();

/**
 * A dialect's temporal spelling.
 * @param {any} dialect
 * @returns {TemporalSpelling}
 */
export function temporalSpelling(dialect) {
  let spelling = SPELLINGS.get(dialect);
  if (spelling === undefined) {
    if (dialect.name !== 'sqlite' && dialect.name !== 'postgres')
      throw new TypeError(`temporal: the dialect '${dialect.name}' spells no temporal member`);
    spelling = dialect.name === 'sqlite' ? sqliteSpelling(dialect) : postgresSpelling(dialect);
    SPELLINGS.set(dialect, spelling);
  }
  return spelling;
}
