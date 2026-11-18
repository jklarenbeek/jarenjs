//@ts-check
/**
 * @file Declared temporal members (MODEL-FORMAT §2, `temporals`): the one
 * place a calendar value of `@jarenjs/core/calendar` becomes the columns a
 * table keys it by and the CHECK that holds every writer to its kind.
 *
 * A value keeps the spelling it was written in, in the document. Its key is
 * the one spelling of that value, so two spellings of one value are one key
 * and the key's order is the value's: a `date` its date, a `date-range` its
 * two dates, a `floating` value its wall clock padded to seconds and three
 * fraction digits, a `utc` value its instant padded likewise. Each of those
 * is a GENERATED column both engines spell the same way, from the member's
 * text alone (no date or zone arithmetic in SQL), so no writer can leave it
 * stale. A `zoned` value's key is the instant it resolves to, which takes a
 * zone database: the store computes it in JavaScript through its zone
 * provider under the declared policy and writes it beside the provider's
 * identity (`tk_<name>$<policy>`), so a key a later revision would move is known
 * by its stamp. A zoned key only narrows: the engine decides every row, and a
 * row stamped by another provider is always a candidate.
 */

import { parseTemporal, toUtc, RESOLUTION_POLICIES } from '@jarenjs/core/calendar';

/** The five calendar kinds a member may be declared. */
export const TEMPORAL_KINDS = Object.freeze(['date', 'floating', 'utc', 'zoned', 'date-range']);

/** The policies a zoned declaration resolves a gap or fold under. */
export const TEMPORAL_POLICIES = RESOLUTION_POLICIES;

/** Each kind's own members, `kind` first: a value holds these and no other. */
const MEMBERS = Object.freeze({
  date: ['kind', 'date'], floating: ['kind', 'date', 'time'], utc: ['kind', 'instant'],
  zoned: ['kind', 'date', 'time', 'zone'], 'date-range': ['kind', 'start', 'end'],
});

/** The least and greatest instant a calendar value spells: 0000-01-01 and
 * 9999-12-31T23:59:59.999Z, in epoch milliseconds. */
export const INSTANT_MIN = -62167219200000;
export const INSTANT_MAX = 253402300799999;

/**
 * The columns one declaration keys its member by. A zoned member's stamp is
 * named after its policy: a key resolved under another policy is another
 * key, so a changed policy is a new column whose rows no key reads yet.
 * @param {{ name: string, kind: string, policy?: string }} temporal
 * @returns {{ key: string, end?: string, stamp?: string }}
 */
export function temporalColumns(temporal) {
  const key = `tk_${temporal.name}`;
  if (temporal.kind === 'date-range') return { key, end: `${key}$end` };
  if (temporal.kind === 'zoned') return { key, stamp: `${key}$${temporal.policy}` };
  return { key };
}

/**
 * The stamp a zoned key is written beside: the provider's identity as one
 * text, `["<name>","<revision>"]`.
 * @param {{ name: string, revision: string }} identity
 * @returns {string}
 */
export function stampOf(identity) {
  return JSON.stringify([identity.name, identity.revision]);
}

/**
 * The SQL one declaration plans: its key columns (each a generated column
 * over the document, or a column the store writes), and its CHECK.
 * @param {any} temporal - the normalized declaration
 * @param {any} dialect
 * @param {string} docColumn
 * @returns {{ generated: any[], derived: any[], sql: string, shapeSql: string }}
 */
export function planTemporal(temporal, dialect, docColumn) {
  const spell = dialect.temporal;
  const doc = dialect.quoteIdentifier(docColumn);
  const q = dialect.quoteIdentifier;
  /** @param {string} [member] */
  const pathOf = (member) => dialect.jsonPathText(member === undefined ? temporal.segments : [...temporal.segments, { name: member }]);
  /** @param {string} member */
  const text = (member) => spell.textOf(doc, pathOf(member));
  const columns = temporalColumns(temporal);
  const textType = dialect.typeFor('string', 'generated');
  /** @param {string} name @param {string} expression */
  const keyColumn = (name, expression) => ({ name, type: textType, kind: 'text', pathText: null,
    expression: spell.keyText(expression), canonical: `${temporal.canonical}\u0000${name}`, temporal: temporal.name });
  /** @type {any[]} */
  const generated = [];
  /** @type {any[]} */
  const derived = [];
  /** @type {string[]} */
  const terms = [];
  /** The terms over the columns the store writes, apart: the shape alone is
   * what an existing table's rows are counted against. @type {string[]} */
  const keyTerms = [];
  /** @param {string} member @param {string} form */
  const textMember = (member, form) => {
    terms.push(`${spell.is(spell.typeOf(doc, pathOf(member)), spell.textType)}`, spell.matches(text(member), form));
  };
  switch (temporal.kind) {
    case 'date':
      generated.push(keyColumn(columns.key, text('date')));
      textMember('date', 'date');
      break;
    case 'date-range':
      generated.push(keyColumn(columns.key, text('start')), keyColumn(/** @type {string} */ (columns.end), text('end')));
      textMember('start', 'date');
      textMember('end', 'date');
      terms.push(`${spell.keyText(text('start'))} < ${spell.keyText(text('end'))}`);
      break;
    case 'floating':
      generated.push(keyColumn(columns.key, `${text('date')} || 'T' || ${canonicalTimeSql(text('time'))}`));
      textMember('date', 'date');
      textMember('time', 'time');
      break;
    case 'utc':
      generated.push(keyColumn(columns.key, canonicalInstantSql(text('instant'))));
      textMember('instant', 'instant');
      break;
    case 'zoned': {
      const key = q(columns.key);
      generated.push(
        { name: columns.key, type: spell.epochType, stored: true, pathText: null, canonical: `${temporal.canonical}\u0000${columns.key}`, temporal: temporal.name },
        { name: columns.stamp, type: spell.stampType, stored: true, pathText: null, canonical: `${temporal.canonical}\u0000${columns.stamp}`, temporal: temporal.name });
      derived.push(
        { name: columns.key, derive: 'zoned-instant', segments: temporal.segments, policy: temporal.policy, temporal: temporal.name },
        { name: columns.stamp, derive: 'zoned-stamp', segments: temporal.segments, policy: temporal.policy, temporal: temporal.name });
      textMember('date', 'date');
      textMember('time', 'time');
      // a key may be absent — a backfill with no zone provider, a writer
      // that writes the document alone — and the row is then read as one
      // another provider keyed: a candidate the engine decides
      terms.push(`${spell.is(spell.typeOf(doc, pathOf('zone')), spell.textType)}`, `${text('zone')} <> ''`);
      keyTerms.push(`(${key} IS NULL OR (${key} >= ${INSTANT_MIN} AND ${key} <= ${INSTANT_MAX}))`);
      break;
    }
    default:
      throw new TypeError(`temporal: no plan for the kind '${temporal.kind}'`);
  }
  const stored = generated.filter((column) => column.stored === true).map((column) => `${q(column.name)} IS NULL`);
  const absent = stored.length === 0 ? spell.booleanTrue : stored.join(' AND ');
  const typeOf = spell.typeOf(doc, pathOf());
  const present = [`${typeOf} = 'object'`, spell.is(text('kind'), `'${temporal.kind}'`),
    spell.rest(doc, pathOf(), MEMBERS[/** @type {keyof typeof MEMBERS} */ (temporal.kind)]), ...terms];
  const sql = `CASE WHEN ${typeOf} IS NULL THEN ${absent} ELSE ${[...present, ...keyTerms].join(' AND ')} END`;
  const shapeSql = `CASE WHEN ${typeOf} IS NULL THEN ${spell.booleanTrue} ELSE ${present.join(' AND ')} END`;
  return { generated, derived, sql, shapeSql };
}

/** A time the calendar admits (`HH:MM`, `HH:MM:SS`, `.f` to `.fff`) padded to
 * `HH:MM:SS.fff` by its length alone — the SQL twin of the query engine's `$wall`.
 * @param {string} time */
function canonicalTimeSql(time) {
  return `CASE WHEN length(${time}) = 5 THEN ${time} || ':00.000' WHEN length(${time}) = 8 THEN ${time} || '.000' `
    + `WHEN length(${time}) = 10 THEN ${time} || '00' WHEN length(${time}) = 11 THEN ${time} || '0' ELSE ${time} END`;
}

/** An instant the calendar admits padded to `YYYY-MM-DDTHH:MM:SS.fffZ` by its
 * length alone. @param {string} instant */
function canonicalInstantSql(instant) {
  return `CASE WHEN length(${instant}) = 20 THEN substr(${instant}, 1, 19) || '.000Z' `
    + `WHEN length(${instant}) = 22 THEN substr(${instant}, 1, 21) || '00Z' `
    + `WHEN length(${instant}) = 23 THEN substr(${instant}, 1, 22) || '0Z' ELSE ${instant} END`;
}

/**
 * The one spelling of a utc instant, `YYYY-MM-DDTHH:MM:SS.fffZ`, from epoch
 * milliseconds — what a `utc` key holds for that instant — or `null` for an
 * instant no calendar value spells.
 * @param {number} epoch
 * @returns {string | null}
 */
export function instantKey(epoch) {
  if (!Number.isSafeInteger(epoch) || epoch < INSTANT_MIN || epoch > INSTANT_MAX) return null;
  return new Date(epoch).toISOString();
}

/**
 * Whether a text is a day the calendar has, `YYYY-MM-DD` (`2026-02-30` is
 * not one).
 * @param {string} text
 * @returns {boolean}
 */
export function isCalendarDate(text) {
  try {
    parseTemporal({ kind: 'date', date: text });
    return true;
  }
  catch {
    return false;
  }
}

/**
 * Why a member would not be stored under its declaration, or `null`: absent
 * is fine; present, it is a value of the declared kind as its constructor
 * admits it — and a zoned one resolves under the declared policy in the
 * store's zone provider.
 * @param {any} temporal
 * @param {unknown} member - the member as the database will hold it
 * @param {any} provider - the store's zone provider, or `null`
 * @returns {string | null}
 */
export function temporalFault(temporal, member, provider) {
  if (member === undefined) return null;
  let value;
  try {
    value = parseTemporal(/** @type {any} */ (member));
  }
  catch (e) {
    return `is not a calendar value (${/** @type {any} */ (e).code ?? 'refused'}: ${/** @type {any} */ (e).message})`;
  }
  if (value.kind !== temporal.kind) return `is a ${value.kind} value, and the member is declared ${temporal.kind}`;
  if (value.kind === 'zoned') {
    try {
      toUtc(value, { provider, policy: temporal.policy });
    }
    catch (e) {
      return `resolves to no instant under '${temporal.policy}' (${/** @type {any} */ (e).code ?? 'refused'}: ${/** @type {any} */ (e).message})`;
    }
  }
  return null;
}

/**
 * The value of a column the store writes for a zoned member: its instant, or
 * the stamp of the provider that resolved it. `null` for an absent member.
 * @param {{ derive: string, policy?: string }} column
 * @param {unknown} member - the member as stored
 * @param {any} provider
 * @returns {number | string | null}
 */
export function zonedValueFor(column, member, provider) {
  if (member === undefined || member === null) return null;
  const resolved = toUtc(parseTemporal(/** @type {any} */ (member)), { provider, policy: /** @type {any} */ (column.policy) });
  return column.derive === 'zoned-instant' ? /** @type {any} */ (resolved).instant : stampOf(/** @type {any} */ (resolved).provider);
}

/** Whether a stored derived column is a zoned key. @param {{ derive?: string }} column */
export const isZonedColumn = (column) => column.derive === 'zoned-instant' || column.derive === 'zoned-stamp';

