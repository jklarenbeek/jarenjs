//@ts-check

//#region Recurrence rule grammar
// RFC 5545 §3.3.10 RECUR, read from its text ('FREQ=WEEKLY;BYDAY=MO,WE')
// or from its JSON form ({ FREQ: 'WEEKLY', BYDAY: ['MO', 'WE'] }) into
// one canonical frozen JSON rule. The JSON form uses the rule part names
// as keys, so a fault has the same path in both: `rrule.BYMONTHDAY[2]`
// is the third value of BYMONTHDAY whichever form spelled it.
//
// Every frequency is read and checked in full here; which frequencies
// are enumerated is the compiler's question, not the grammar's.

import { CalendarError } from './errors.js';
import { admitValue } from './model.js';

/** The seven frequencies, finest first. */
export const FREQUENCIES = Object.freeze(['SECONDLY', 'MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);

/** Weekday names in ISO order: index 0 is Monday, 6 is Sunday. */
export const WEEKDAYS = Object.freeze(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);

/** The order the canonical text and JSON write the parts in. */
const PART_ORDER = Object.freeze(['FREQ', 'UNTIL', 'COUNT', 'INTERVAL', 'BYSECOND', 'BYMINUTE', 'BYHOUR', 'BYDAY',
  'BYMONTHDAY', 'BYYEARDAY', 'BYWEEKNO', 'BYMONTH', 'BYSETPOS', 'WKST']);

/**
 * The numeric list parts: lowest and highest magnitude, whether a sign
 * is taken (a signed part counts from the end with a minus and never
 * takes 0), and the most digits the grammar spells.
 * @type {Readonly<Record<string, readonly [number, number, boolean, number]>>}
 */
const NUMBER_LISTS = Object.freeze({
  BYSECOND: [0, 60, false, 2],
  BYMINUTE: [0, 59, false, 2],
  BYHOUR: [0, 23, false, 2],
  BYMONTHDAY: [1, 31, true, 2],
  BYYEARDAY: [1, 366, true, 3],
  BYWEEKNO: [1, 53, true, 2],
  BYMONTH: [1, 12, false, 2],
  BYSETPOS: [1, 366, true, 3],
});

/** The BY parts BYSETPOS needs at least one of. */
const BY_PARTS = Object.freeze(['BYSECOND', 'BYMINUTE', 'BYHOUR', 'BYDAY', 'BYMONTHDAY', 'BYYEARDAY', 'BYWEEKNO', 'BYMONTH']);

const BYDAY_FORM = /^([+-]?)(\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/;
const UNTIL_FORM = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/;

/**
 * A rule in its canonical JSON form: the part names as keys, lists
 * sorted and without repeats, and INTERVAL=1 and WKST=MO (the defaults)
 * left out.
 * @typedef {Object} RRuleJson
 * @property {'SECONDLY'|'MINUTELY'|'HOURLY'|'DAILY'|'WEEKLY'|'MONTHLY'|'YEARLY'} FREQ
 * @property {import('./model.js').DateValue | import('./model.js').FloatingValue | import('./model.js').UtcValue} [UNTIL]
 * @property {number} [COUNT]
 * @property {number} [INTERVAL]
 * @property {readonly number[]} [BYSECOND]
 * @property {readonly number[]} [BYMINUTE]
 * @property {readonly number[]} [BYHOUR]
 * @property {readonly string[]} [BYDAY] - `'MO'`, `'1MO'`, `'-1FR'`
 * @property {readonly number[]} [BYMONTHDAY]
 * @property {readonly number[]} [BYYEARDAY]
 * @property {readonly number[]} [BYWEEKNO]
 * @property {readonly number[]} [BYMONTH]
 * @property {readonly number[]} [BYSETPOS]
 * @property {'MO'|'TU'|'WE'|'TH'|'FR'|'SA'|'SU'} [WKST]
 */

/** @param {unknown} value @returns {string} */
const shown = (value) => (typeof value === 'string' ? `'${value}'` : String(value));

/**
 * @param {'JY0015'|'JY0016'|'JY0017'|'JY0018'} code
 * @param {string} reason
 * @param {string} path
 */
const fault = (code, reason, path) => new CalendarError(code, reason, path);

/**
 * Split RRULE text into its parts, each value still text. A part named
 * twice, an unknown part and an empty part are refused here.
 * @param {string} text
 * @returns {Record<string, string>}
 */
function splitText(text) {
  const body = text.replace(/^RRULE:/i, '');
  if (body === '')
    throw fault('JY0015', 'the rule is empty; it needs at least FREQ', 'rrule');
  /** @type {Record<string, string>} */
  const parts = {};
  const segments = body.split(';');
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const equals = segment.indexOf('=');
    if (equals <= 0)
      throw fault('JY0015', `rule part ${i + 1} (${shown(segment)}) is not NAME=VALUE`, 'rrule');
    const name = segment.slice(0, equals).toUpperCase();
    if (!PART_ORDER.includes(name))
      throw fault('JY0015', `${shown(segment.slice(0, equals))} is not a rule part of RFC 5545`, `rrule.${name}`);
    if (Object.hasOwn(parts, name))
      throw fault('JY0017', `${name} is given twice; each rule part is given once`, `rrule.${name}`);
    const value = segment.slice(equals + 1);
    if (value === '')
      throw fault('JY0015', `${name} has no value`, `rrule.${name}`);
    parts[name] = value;
  }
  return parts;
}

/**
 * Read a number in a list or a count from text: digits with an optional
 * sign, at most `digits` long.
 * @param {string} text
 * @param {number} digits
 * @param {boolean} signed - whether the part takes a sign
 * @param {string} path
 * @returns {number}
 */
function readInteger(text, digits, signed, path) {
  const form = /^([+-]?)(\d+)$/.exec(text);
  if (form === null || form[2].length > digits)
    throw fault('JY0015', `${shown(text)} is not a whole number of at most ${digits} digits`, path);
  const magnitude = Number(form[2]);
  if (form[1] !== '' && (!signed || magnitude === 0))
    throw fault('JY0016', `${shown(text)} carries a sign ${signed ? 'on a zero' : 'this part does not take'}`, path);
  return form[1] === '-' ? -magnitude : magnitude;
}

/**
 * The UNTIL text (`19971224`, `19971224T000000`, `19971224T000000Z`) as
 * the temporal value it names.
 * @param {string} text
 * @returns {unknown}
 */
function untilFromText(text) {
  const form = UNTIL_FORM.exec(text.toUpperCase());
  if (form === null) {
    throw fault('JY0015', `UNTIL is spelled YYYYMMDD, YYYYMMDDTHHMMSS or YYYYMMDDTHHMMSSZ, not ${shown(text)}`,
      'rrule.UNTIL');
  }
  const date = `${form[1]}-${form[2]}-${form[3]}`;
  if (form[4] === undefined)
    return { kind: 'date', date };
  const time = `${form[4]}:${form[5]}:${form[6]}`;
  return form[7] === 'Z' ? { kind: 'utc', instant: `${date}T${time}Z` } : { kind: 'floating', date, time };
}

/**
 * The rule's parts as JSON values, from either form. Text values are
 * converted; JSON values are taken as given and checked by
 * {@link checkParts}.
 * @param {unknown} rule
 * @returns {Record<string, unknown>}
 */
function partsOf(rule) {
  if (typeof rule === 'string') {
    const text = splitText(rule);
    /** @type {Record<string, unknown>} */
    const parts = {};
    for (const [name, value] of Object.entries(text)) {
      if (name === 'FREQ' || name === 'WKST')
        parts[name] = value.toUpperCase();
      else if (name === 'UNTIL')
        parts[name] = untilFromText(value);
      else if (name === 'COUNT' || name === 'INTERVAL')
        parts[name] = /^[+-]?\d+$/.test(value) ? Number(value) : value;
      else if (name === 'BYDAY')
        parts[name] = value.toUpperCase().split(',');
      else {
        const [, , signed, digits] = NUMBER_LISTS[name];
        parts[name] = value.split(',').map((item, i) => readInteger(item, digits, signed, `rrule.${name}[${i}]`));
      }
    }
    return parts;
  }
  if (rule === null || typeof rule !== 'object' || Array.isArray(rule))
    throw fault('JY0015', 'the rule is RRULE text or its JSON form { FREQ, ... }', 'rrule');
  const parts = /** @type {Record<string, unknown>} */ (rule);
  for (const name of Object.keys(parts)) {
    if (!PART_ORDER.includes(name))
      throw fault('JY0015', `${shown(name)} is not a rule part of RFC 5545 (part names are upper case)`, `rrule.${name}`);
  }
  return parts;
}

/**
 * Check one numeric list against its range and sign; answer it sorted,
 * without repeats.
 * @param {string} name
 * @param {unknown} list
 * @returns {readonly number[]}
 */
function checkNumberList(name, list) {
  const [low, high, signed] = NUMBER_LISTS[name];
  if (!Array.isArray(list) || list.length === 0)
    throw fault('JY0015', `${name} is a non-empty list of whole numbers`, `rrule.${name}`);
  for (let i = 0; i < list.length; i++) {
    const value = list[i];
    const path = `rrule.${name}[${i}]`;
    if (!Number.isInteger(value))
      throw fault('JY0015', `${shown(value)} is not a whole number`, path);
    if (name === 'BYSECOND' && value === 60)
      throw new CalendarError('JY0009', 'BYSECOND=60 names a leap second, which this layer does not admit', path);
    const magnitude = Math.abs(value);
    if ((value < 0 && !signed) || magnitude < low || magnitude > high || (signed && value === 0)) {
      throw fault('JY0016', `${name} takes ${signed ? `${low} to ${high} or -${high} to -${low}` : `${low} to ${high}`}, not ${value}`,
        path);
    }
  }
  return Object.freeze([...new Set(/** @type {number[]} */ (list))].sort((a, b) => a - b));
}

/**
 * Check BYDAY; answer it canonical (`'1MO'`, `'-1FR'`, no `+`, no
 * leading zero), sorted by weekday and then ordinal, without repeats.
 * @param {unknown} list
 * @returns {readonly string[]}
 */
function checkByDay(list) {
  if (!Array.isArray(list) || list.length === 0)
    throw fault('JY0015', 'BYDAY is a non-empty list of weekdays such as MO or -1FR', 'rrule.BYDAY');
  /** @type {Map<string, [number, number]>} */
  const seen = new Map();
  for (let i = 0; i < list.length; i++) {
    const path = `rrule.BYDAY[${i}]`;
    const form = typeof list[i] === 'string' ? BYDAY_FORM.exec(list[i]) : null;
    if (form === null || (form[1] !== '' && form[2] === undefined))
      throw fault('JY0015', `${shown(list[i])} is not a weekday (SU, MO, TU, WE, TH, FR, SA) with an optional signed ordinal`, path);
    const ordinal = form[2] === undefined ? 0 : Number(form[2]) * (form[1] === '-' ? -1 : 1);
    if (form[2] !== undefined && (ordinal === 0 || Math.abs(ordinal) > 53))
      throw fault('JY0016', `the ordinal of ${shown(list[i])} is 1 to 53 or -53 to -1`, path);
    const weekday = WEEKDAYS.indexOf(form[3]);
    seen.set(`${ordinal === 0 ? '' : ordinal}${form[3]}`, [weekday, ordinal]);
  }
  return Object.freeze([...seen.entries()]
    .sort(([, a], [, b]) => a[0] - b[0] || a[1] - b[1])
    .map(([spelling]) => spelling));
}

/**
 * Check a positive whole number part (COUNT, INTERVAL).
 * @param {string} name
 * @param {unknown} value
 * @returns {number}
 */
function checkPositive(name, value) {
  if (!Number.isSafeInteger(value))
    throw fault('JY0015', `${name} is a whole number, not ${shown(value)}`, `rrule.${name}`);
  if (/** @type {number} */ (value) < 1)
    throw fault('JY0016', `${name} is a positive whole number, not ${value}`, `rrule.${name}`);
  return /** @type {number} */ (value);
}

/**
 * Check UNTIL: a date, floating or utc value on whole seconds (the text
 * form spells no fraction).
 * @param {unknown} value
 * @returns {NonNullable<RRuleJson['UNTIL']>}
 */
function checkUntil(value) {
  let admitted;
  try {
    admitted = admitValue(value, 'start', '');
  }
  catch (error) {
    const coded = /** @type {CalendarError} */ (error);
    throw new CalendarError(coded.code, `UNTIL: ${coded.reason}`, 'rrule.UNTIL');
  }
  const until = /** @type {any} */ (admitted.value);
  if (until.kind !== 'date' && until.kind !== 'floating' && until.kind !== 'utc')
    throw fault('JY0015', `UNTIL is a date, floating or utc value, not ${until.kind}`, 'rrule.UNTIL');
  const fraction = until.kind === 'floating' ? admitted.time?.seconds ?? 0 : (admitted.epoch ?? 0) / 1000;
  if (!Number.isInteger(fraction))
    throw fault('JY0015', 'UNTIL falls on a whole second; RRULE text spells no fraction', 'rrule.UNTIL');
  return until;
}

/**
 * Read and check a rule in either form: every part's spelling, range and
 * sign, then the parts that do not go together. Faults are found in
 * that order, each part in canonical order, so one rule always names
 * the same fault.
 * @param {unknown} rule - RRULE text (with or without `RRULE:`) or its JSON form
 * @returns {RRuleJson} frozen, canonical
 * @throws {CalendarError} `JY0015` spelling, `JY0016` range or sign,
 *   `JY0017` a part twice (text only; JSON keys are unique), `JY0018`
 *   parts that do not go together, `JY0009` BYSECOND=60
 */
export function readRRule(rule) {
  const parts = partsOf(rule);
  /** @type {Record<string, unknown>} */
  const out = {};
  if (!Object.hasOwn(parts, 'FREQ'))
    throw fault('JY0015', 'the rule names no FREQ', 'rrule.FREQ');
  for (const name of PART_ORDER) {
    if (!Object.hasOwn(parts, name))
      continue;
    const value = parts[name];
    switch (name) {
      case 'FREQ':
        if (typeof value !== 'string' || !FREQUENCIES.includes(value))
          throw fault('JY0015', `FREQ is one of ${FREQUENCIES.join(', ')}, not ${shown(value)}`, 'rrule.FREQ');
        out.FREQ = value;
        break;
      case 'WKST':
        if (typeof value !== 'string' || !WEEKDAYS.includes(value))
          throw fault('JY0015', `WKST is one of ${WEEKDAYS.join(', ')}, not ${shown(value)}`, 'rrule.WKST');
        if (value !== 'MO')
          out.WKST = value;
        break;
      case 'UNTIL':
        out.UNTIL = checkUntil(value);
        break;
      case 'COUNT':
        out.COUNT = checkPositive(name, value);
        break;
      case 'INTERVAL': {
        const interval = checkPositive(name, value);
        if (interval !== 1)
          out.INTERVAL = interval;
        break;
      }
      case 'BYDAY':
        out.BYDAY = checkByDay(value);
        break;
      default:
        out[name] = checkNumberList(name, value);
    }
  }
  checkCombinations(out, parts);
  return /** @type {RRuleJson} */ (Object.freeze(out));
}

/**
 * The cross-part rules of §3.3.10.
 * @param {Record<string, any>} rule - the checked parts
 * @param {Record<string, any>} given - the parts as given, for BYDAY's index
 */
function checkCombinations(rule, given) {
  const freq = rule.FREQ;
  if (rule.COUNT !== undefined && rule.UNTIL !== undefined)
    throw fault('JY0018', 'COUNT and UNTIL do not go together; a rule ends by one or the other', 'rrule.COUNT');
  if (rule.BYWEEKNO !== undefined && freq !== 'YEARLY')
    throw fault('JY0018', `BYWEEKNO goes only with FREQ=YEARLY, not ${freq}`, 'rrule.BYWEEKNO');
  if (rule.BYYEARDAY !== undefined && (freq === 'DAILY' || freq === 'WEEKLY' || freq === 'MONTHLY'))
    throw fault('JY0018', `BYYEARDAY does not go with FREQ=${freq}`, 'rrule.BYYEARDAY');
  if (rule.BYMONTHDAY !== undefined && freq === 'WEEKLY')
    throw fault('JY0018', 'BYMONTHDAY does not go with FREQ=WEEKLY', 'rrule.BYMONTHDAY');
  if (rule.BYDAY !== undefined) {
    const list = /** @type {string[]} */ (given.BYDAY).map((item) => String(item).toUpperCase());
    const ordinal = list.findIndex((item) => /\d/.test(item));
    if (ordinal >= 0 && freq !== 'MONTHLY' && freq !== 'YEARLY') {
      throw fault('JY0018', `an ordinal weekday (${list[ordinal]}) goes only with FREQ=MONTHLY or YEARLY, not ${freq}`,
        `rrule.BYDAY[${ordinal}]`);
    }
    if (ordinal >= 0 && rule.BYWEEKNO !== undefined) {
      throw fault('JY0018', `an ordinal weekday (${list[ordinal]}) does not go with BYWEEKNO`,
        `rrule.BYDAY[${ordinal}]`);
    }
  }
  if (rule.BYSETPOS !== undefined && !BY_PARTS.some((name) => rule[name] !== undefined))
    throw fault('JY0018', 'BYSETPOS picks from the set another BY part makes; the rule has none', 'rrule.BYSETPOS');
}

/** @param {number} n @param {number} [width] */
const pad = (n, width = 2) => String(n).padStart(width, '0');

/**
 * UNTIL as RRULE text.
 * @param {NonNullable<RRuleJson['UNTIL']>} until
 * @returns {string}
 */
function untilText(until) {
  if (until.kind === 'date')
    return until.date.replaceAll('-', '');
  if (until.kind === 'floating') {
    const [h, m, s = '00'] = until.time.split(':');
    return `${until.date.replaceAll('-', '')}T${h}${m}${pad(Number(s))}`;
  }
  const epoch = Date.parse(until.instant);
  const at = new Date(epoch);
  return `${pad(at.getUTCFullYear(), 4)}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}T${
    pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}Z`;
}

/**
 * Write a rule as canonical RRULE text: parts in one fixed order (FREQ
 * first), lists sorted without repeats, defaults left out. Text, JSON
 * and a compiled recurrence that hold the same rule write the same text.
 * @param {string | RRuleJson | { readonly rrule: RRuleJson }} rule - RRULE
 *   text, its JSON form, or a compiled recurrence
 * @returns {string}
 * @throws {CalendarError} what {@link readRRule} refuses
 * @example
 * formatRRule('freq=weekly;byday=we,mo;interval=1'); // 'FREQ=WEEKLY;BYDAY=MO,WE'
 */
export function formatRRule(rule) {
  const json = readRRule(rule !== null && typeof rule === 'object' && /** @type {any} */ (rule).kind === 'recurrence'
    ? /** @type {any} */ (rule).rrule : rule);
  const out = [];
  for (const name of PART_ORDER) {
    const value = json[name];
    if (value === undefined)
      continue;
    out.push(`${name}=${name === 'UNTIL' ? untilText(value) : Array.isArray(value) ? value.join(',') : value}`);
  }
  return out.join(';');
}
//#endregion
