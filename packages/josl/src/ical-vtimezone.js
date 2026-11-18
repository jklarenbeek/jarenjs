//@ts-check

//#region VTIMEZONE: read into a zone provider, written from one
// The calendar layer compiles and writes zone definitions as neutral
// JSON (`compileVtimezone`, `vtimezoneFor`); this module is the
// iCalendar side of both directions.
//
// - Reading: a parsed VTIMEZONE is mapped onto that JSON (what it holds
//   outside the definition is reported, as everywhere else) and compiled
//   over the reader's zone horizon. Under `vtimezone: 'embedded'` (the
//   default, RFC 5545's: the file's definition is authoritative for the
//   file) a TZID the file defines resolves through its compiled
//   definition; under `'provider'` through the caller's provider, as
//   before. Either way a definition that disagrees with the provider for
//   an IANA name, over the span the file's values use it, is reported.
// - A value the file names outside what its definition covers (before
//   the earliest onset, past TZUNTIL or the zone horizon) resolves
//   through the caller's provider when it knows the IANA name, and is
//   refused when resolved otherwise; either way it is reported (`ICAL1024`).
// - Writing: a zone used under `zones: 'embed'` becomes a VTIMEZONE of
//   RDATE onsets over the writer's horizon and two days either side,
//   ending in TZUNTIL; under `onsets: 'rrule'` each run of yearly onsets
//   on the nth or last weekday of a month is one RRULE observance.

import { CalendarError, compileVtimezone, isZone } from '@jarenjs/core/calendar';
import { hashContent } from '@jarenjs/core/string';
import { IcalError, escapeText } from './ical-wire.js';

const HOUR = 3600000;
const DAY = 86400000;
const WEEK = 7 * DAY;
/** How far a wall clock's instants may lie from it: a compiled zone refuses a wall clock this near either end. */
const REACH = 26 * HOUR;
/** The form of an IANA zone name; a TZID of any other form is never asked of the provider. */
export const IANA_FORM = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;
const DATE_TIME_FORM = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/;
const OFFSET_FORM = /^([+-])(\d{2})(\d{2})(\d{2})?$/;
/** The zone horizon a reader compiles over when the caller names none. */
export const ZONE_HORIZON = Object.freeze([Date.UTC(1900, 0, 1), Date.UTC(2100, 0, 1)]);

/** Properties of a VTIMEZONE read without changing an instant. */
const ZONE_INFORMATIONAL = Object.freeze(['LAST-MODIFIED', 'TZURL']);
/** Properties of an observance read without changing an instant. */
const OBSERVANCE_INFORMATIONAL = Object.freeze(['COMMENT']);

/**
 * Refuse a VTIMEZONE the mapping cannot read; the reader reports it.
 * @param {string} reason
 * @param {{ path: string, line: number }} at
 * @returns {never}
 */
function unreadable(reason, at) {
  throw new IcalError('ICAL1014', reason, at.path, undefined, at.line);
}

/**
 * Unescape TEXT (RFC 5545 §3.3.11).
 * @param {import('./ical-machine.js').IcalProperty} prop
 * @returns {string}
 */
function textOf(prop) {
  return prop.value.replace(/\\(.?)/g, (all, next) => {
    if (next === 'n' || next === 'N')
      return '\n';
    if (next === '\\' || next === ';' || next === ',')
      return next;
    return unreadable(`${prop.name} holds the escape ${all}, which TEXT does not define`, prop);
  });
}

/**
 * A DATE-TIME value as `YYYY-MM-DDTHH:MM:SS` (with `Z` for UTC).
 * @param {string} text
 * @param {import('./ical-machine.js').IcalProperty} prop
 * @returns {string}
 */
function timeText(text, prop) {
  const form = DATE_TIME_FORM.exec(text);
  if (form === null)
    unreadable(`${prop.name} is a DATE-TIME (YYYYMMDDTHHMMSS), not '${text}'`, prop);
  return `${form[1]}-${form[2]}-${form[3]}T${form[4]}:${form[5]}:${form[6]}${form[7]}`;
}

/**
 * Report the parameters of a property in a VTIMEZONE: VALUE=DATE-TIME
 * is the default spelled out; anything else is outside the subset.
 * @param {import('./ical-machine.js').IcalProperty} prop
 * @param {any} report
 */
function checkParams(prop, report) {
  for (const param of prop.params) {
    if (param.name === 'VALUE' && (prop.name === 'DTSTART' || prop.name === 'RDATE')) {
      if (param.values.length !== 1 || param.values[0].toUpperCase() !== 'DATE-TIME')
        unreadable(`${prop.name} of an observance is a DATE-TIME, not VALUE=${param.values.join(',')}`, prop);
      continue;
    }
    report.add('ICAL1012', `${prop.name};${param.name}`, `${prop.path};${param.name}`, prop.line,
      `the parameter ${param.name} of ${prop.name} is outside the subset; ${prop.name} is read without it`);
  }
}

/**
 * Map a parsed VTIMEZONE onto the calendar layer's zone definition.
 * Properties and components that change no instant and are outside the
 * subset are reported; one that is missing, repeated or misspelt makes
 * the VTIMEZONE unreadable (`ICAL1014`).
 * @param {import('./ical-machine.js').IcalNode} node
 * @param {any} report
 * @returns {import('@jarenjs/core/calendar').VtimezoneDefinition}
 */
export function definitionOf(node, report) {
  /** @type {Record<string, any>} */
  const definition = { observances: [] };
  for (const prop of node.props) {
    if (prop.name === 'TZID' || prop.name === 'TZUNTIL') {
      const member = prop.name === 'TZID' ? 'tzid' : 'until';
      if (definition[member] !== undefined)
        unreadable(`a VTIMEZONE holds ${prop.name} once; it is given again`, prop);
      checkParams(prop, report);
      definition[member] = member === 'tzid' ? textOf(prop) : timeText(prop.value, prop);
    }
    else if (!ZONE_INFORMATIONAL.includes(prop.name))
      report.add('ICAL1011', prop.name, prop.path, prop.line, `${prop.name} in VTIMEZONE is outside the subset; it is left out`);
  }
  if (definition.tzid === undefined)
    unreadable('a VTIMEZONE names its TZID', node);
  for (const child of node.children) {
    if (child.name !== 'STANDARD' && child.name !== 'DAYLIGHT') {
      report.add('ICAL1013', child.name, child.path, child.line, `${child.name} inside VTIMEZONE is outside the subset; it is left out with everything inside it`);
      continue;
    }
    definition.observances.push(observanceOf(child, report));
  }
  return /** @type {any} */ (definition);
}

/**
 * One STANDARD or DAYLIGHT block.
 * @param {import('./ical-machine.js').IcalNode} node
 * @param {any} report
 * @returns {import('@jarenjs/core/calendar').VtimezoneObservance}
 */
function observanceOf(node, report) {
  for (const child of node.children) {
    report.add('ICAL1013', child.name, child.path, child.line, `${child.name} inside ${node.name} is outside the subset; it is left out with everything inside it`);
  }
  /** @type {Record<string, any>} */
  const out = { type: node.name === 'DAYLIGHT' ? 'daylight' : 'standard' };
  const once = (/** @type {string} */ member, /** @type {import('./ical-machine.js').IcalProperty} */ prop, /** @type {unknown} */ value) => {
    if (out[member] !== undefined)
      unreadable(`${node.name} holds ${prop.name} once; it is given again`, prop);
    out[member] = value;
  };
  for (const prop of node.props) {
    if (prop.name === 'DTSTART' || prop.name === 'RDATE' || prop.name === 'TZOFFSETFROM' || prop.name === 'TZOFFSETTO'
      || prop.name === 'RRULE' || prop.name === 'TZNAME')
      checkParams(prop, report);
    switch (prop.name) {
      case 'DTSTART': once('start', prop, timeText(prop.value, prop)); break;
      case 'TZOFFSETFROM': once('offsetFrom', prop, offsetText(prop)); break;
      case 'TZOFFSETTO': once('offsetTo', prop, offsetText(prop)); break;
      case 'RRULE': once('rrule', prop, prop.value); break;
      case 'TZNAME': out.name ??= textOf(prop); break;
      case 'RDATE':
        out.rdates = [...(out.rdates ?? []), ...prop.value.split(',').map((text) => timeText(text, prop))];
        break;
      default:
        if (!OBSERVANCE_INFORMATIONAL.includes(prop.name))
          report.add('ICAL1011', prop.name, prop.path, prop.line, `${prop.name} in ${node.name} is outside the subset; it is left out`);
    }
  }
  for (const [member, name] of [['start', 'DTSTART'], ['offsetFrom', 'TZOFFSETFROM'], ['offsetTo', 'TZOFFSETTO']]) {
    if (out[member] === undefined)
      unreadable(`${node.name} has a ${name}`, node);
  }
  return /** @type {any} */ (out);
}

/**
 * TZOFFSETFROM or TZOFFSETTO, `+HHMM[SS]`, as `+HH:MM[:SS]`.
 * @param {import('./ical-machine.js').IcalProperty} prop
 * @returns {string}
 */
function offsetText(prop) {
  const form = OFFSET_FORM.exec(prop.value);
  if (form === null)
    unreadable(`${prop.name} is a UTC offset (+HHMM or +HHMMSS), not '${prop.value}'`, prop);
  return `${form[1]}${form[2]}:${form[3]}${form[4] === undefined ? '' : `:${form[4]}`}`;
}

/**
 * The content lines of a zone definition, unfolded.
 * @param {import('@jarenjs/core/calendar').VtimezoneDefinition} definition
 * @returns {string[]}
 */
export function renderVtimezone(definition) {
  const time = (/** @type {string} */ text) => text.replace(/[-:]/g, '');
  const lines = ['BEGIN:VTIMEZONE', `TZID:${escapeText(definition.tzid, '/tzid')}`];
  if (definition.until !== undefined)
    lines.push(`TZUNTIL:${time(definition.until)}`);
  for (const observance of definition.observances) {
    const name = observance.type === 'daylight' ? 'DAYLIGHT' : 'STANDARD';
    lines.push(`BEGIN:${name}`, `DTSTART:${time(observance.start)}`, `TZOFFSETFROM:${observance.offsetFrom.replace(/:/g, '')}`,
      `TZOFFSETTO:${observance.offsetTo.replace(/:/g, '')}`);
    if (observance.rrule !== undefined)
      lines.push(`RRULE:${observance.rrule}`);
    if (observance.rdates !== undefined && observance.rdates.length > 0)
      lines.push(`RDATE:${observance.rdates.map(time).join(',')}`);
    lines.push(`END:${name}`);
  }
  lines.push('END:VTIMEZONE');
  return lines;
}

/** The fewest yearly onsets an RRULE observance stands for; fewer stay RDATEs, which are shorter. */
const RULED_RUN = 3;
const WEEKDAYS = Object.freeze(['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']);

/**
 * Milliseconds east of UTC an offset text (`+01:00`, `-03:30:15`) names.
 * @param {string} text
 * @returns {number}
 */
function offsetMs(text) {
  const [h, m, sec = '0'] = text.slice(1).split(':');
  return (text[0] === '-' ? -1 : 1) * ((Number(h) * 60 + Number(m)) * 60 + Number(sec)) * 1000;
}

/**
 * The yearly rule an onset fits: its month, weekday and time, and the
 * ordinals of that weekday in the month it is (the nth, and -1 when it is
 * the last).
 * @param {string} wall - `YYYY-MM-DDTHH:MM:SS`
 */
function onsetShape(wall) {
  const year = Number(wall.slice(0, 4));
  const month = Number(wall.slice(5, 7));
  const day = Number(wall.slice(8, 10));
  const ordinals = [Math.ceil(day / 7), ...(day + 7 > monthLength(year, month) ? [-1] : [])];
  return { year, month, weekday: dayOf(year, month, day).getUTCDay(), time: wall.slice(11), ordinals };
}

/**
 * A civil date as a Date at its midnight UTC, any year from 0.
 * @param {number} year
 * @param {number} month
 * @param {number} day
 */
function dayOf(year, month, day) {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date;
}

/** @param {number} year @param {number} month */
const monthLength = (year, month) => dayOf(year, month + 1, 0).getUTCDate();

/**
 * The onset of a yearly rule in a year, as a wall clock: the nth (or the
 * last) weekday of the month at a time.
 * @param {number} year
 * @param {number} month
 * @param {number} weekday
 * @param {number} ordinal
 * @param {string} time
 * @returns {string | undefined} undefined when the month has no such day
 */
function ruleOnset(year, month, weekday, ordinal, time) {
  const length = monthLength(year, month);
  const first = dayOf(year, month, 1).getUTCDay();
  const firstDay = 1 + ((weekday - first + 7) % 7);
  const day = ordinal === -1 ? firstDay + 7 * Math.floor((length - firstDay) / 7) : firstDay + 7 * (ordinal - 1);
  if (day > length)
    return undefined;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${time}`;
}

/**
 * A zone definition of RDATE onsets rewritten with RRULE observances
 * (RFC 5545 §3.6.5): each run of three or more onsets of one observance
 * in consecutive years on the same weekday of the same month at the same
 * time - the nth (`BYDAY=2SU`) or the last (`BYDAY=-1SU`) - becomes one
 * observance, DTSTART its first onset and FREQ=YEARLY;BYMONTH;BYDAY, with
 * UNTIL (UTC) at its last onset where the rule would go on inside the
 * definition, where that observance is shorter than the run's RDATEs; the
 * onsets no run covers stay RDATEs. The rewrite is compiled and its
 * transitions compared with the original's over the horizon; any
 * difference, or a rewrite no shorter than the original, keeps the original.
 * @param {import('@jarenjs/core/calendar').VtimezoneDefinition} definition - as `vtimezoneFor` writes it
 * @param {[number, number]} horizon - the span it was written over
 * @returns {import('@jarenjs/core/calendar').VtimezoneDefinition}
 */
export function ruledDefinition(definition, horizon) {
  const end = definition.until === undefined ? Infinity : Date.parse(definition.until);
  /** @type {any[]} */
  const observances = [];
  let ruled = false;
  for (const observance of definition.observances) {
    const onsets = [observance.start, ...(observance.rdates ?? [])];
    const { type, offsetFrom, offsetTo } = observance;
    const from = offsetMs(offsetFrom);
    /** @type {{ i: number, j: number, rule: string }[]} */
    const runs = [];
    let i = 0;
    while (i < onsets.length) {
      const first = onsetShape(onsets[i]);
      let ordinals = first.ordinals;
      let j = i + 1;
      while (j < onsets.length) {
        const next = onsetShape(onsets[j]);
        const common = ordinals.filter((n) => next.ordinals.includes(n));
        if (next.year !== first.year + (j - i) || next.month !== first.month || next.weekday !== first.weekday || next.time !== first.time
          || common.length === 0)
          break;
        ordinals = common;
        j++;
      }
      if (j - i < RULED_RUN || offsetFrom === offsetTo) {
        i++;
        continue;
      }
      const ordinal = ordinals.includes(-1) ? -1 : ordinals[0];
      let rule = `FREQ=YEARLY;BYMONTH=${first.month};BYDAY=${ordinal}${WEEKDAYS[first.weekday]}`;
      const after = ruleOnset(first.year + (j - i), first.month, first.weekday, ordinal, first.time);
      if (after === undefined || Date.parse(`${after}Z`) - from < end) {
        const until = new Date(Date.parse(`${onsets[j - 1]}Z`) - from).toISOString();
        rule += `;UNTIL=${until.slice(0, 19).replace(/[-:]/g, '')}Z`;
      }
      runs.push({ i, j, rule });
      i = j;
    }
    // which runs to write as rules: the choice whose observances are shortest (a run
    // costs a whole observance, its onsets as RDATEs 16 octets each)
    /** @param {number} mask */
    const chosen = (mask) => {
      const own = runs.filter((_, k) => (mask & (1 << k)) !== 0);
      const rest = onsets.filter((_, at) => !own.some((run) => at >= run.i && at < run.j));
      return [...own.map((run) => ({ type, start: onsets[run.i], offsetFrom, offsetTo, rrule: run.rule })),
        ...(rest.length === 0 ? [] : [{ type, start: rest[0], offsetFrom, offsetTo, ...(observance.rdates === undefined ? {} : { rdates: rest.slice(1) }) }])];
    };
    const size = (/** @type {any[]} */ list) => renderVtimezone({ tzid: '', observances: list }).join('\r\n').length;
    let best = chosen(0);
    // runs of one observance are few (one per rule the zone has had): every choice is tried up to 2^10
    for (let mask = 1; mask < 2 ** Math.min(runs.length, 10); mask++) {
      const candidate = chosen(mask);
      if (size(candidate) < size(best))
        best = candidate;
    }
    ruled ||= best.some((entry) => entry.rrule !== undefined);
    observances.push(...best);
  }
  if (!ruled)
    return definition;
  const rewritten = { ...definition, observances };
  const transitions = (/** @type {any} */ value) => {
    try {
      return JSON.stringify(compileVtimezone(value, { horizon }).transitions);
    }
    catch (error) {
      if (error instanceof CalendarError)
        return undefined;
      throw error;
    }
  };
  const want = transitions(definition);
  const length = (/** @type {any} */ value) => renderVtimezone(value).join('\r\n').length;
  return want !== undefined && transitions(rewritten) === want && length(rewritten) < length(definition) ? rewritten : definition;
}

/**
 * A TZID parameter value: quoted when it holds `;`, `:` or `,`.
 * @param {string} zone
 * @param {string} path
 * @returns {string}
 */
export function tzidParam(zone, path) {
  if (/["\p{Cc}]/u.test(zone))
    throw new IcalError('ICAL3003', 'a zone name written as a TZID holds no quote or control character', path);
  return /[;:,]/.test(zone) ? `"${zone}"` : zone;
}

/**
 * @typedef {Object} ZoneUse
 * @property {number} low - the earliest wall clock a value names (milliseconds read as if UTC)
 * @property {number} high - the latest
 * @property {boolean} open - a recurring series starts in it: its occurrences run on to the zone horizon's end
 */

/**
 * What a read knows of zones: the definitions compiled from the file,
 * the TZIDs its values used, and the provider those values resolve
 * through.
 */
export class ZoneTable {
  /** @type {Map<string, { zone: import('@jarenjs/core/calendar').CompiledZone, path: string, line: number }>} */
  #compiled = new Map();
  /** @type {Map<string, ZoneUse>} */
  #used = new Map();
  #embedded;
  #horizon;
  #limits;
  #fallback;
  /** @type {{ size: number, identity: any } | null} */
  #identity = null;
  /** The provider a read's zoned values resolve through. */
  provider;

  /**
   * @param {'embedded' | 'provider'} mode
   * @param {[unknown, unknown]} horizon
   * @param {any} limits
   * @param {any} fallback - the caller's provider, or null
   */
  constructor(mode, horizon, limits, fallback) {
    this.#embedded = mode === 'embedded';
    this.#horizon = horizon;
    this.#limits = limits;
    this.#fallback = fallback;
    const other = (/** @type {string} */ zone) => {
      if (fallback === null)
        throw new TypeError(`no VTIMEZONE of the file defines '${zone}', and no zone provider was given`);
      return fallback;
    };
    /**
     * Ask the file's definition of a zone, or the caller's provider; where
     * the definition is silent (JY0024) the provider answers a name it knows.
     * @template T
     * @param {string} zone
     * @param {(provider: any) => T} ask
     * @returns {T}
     */
    const route = (zone, ask) => {
      const own = this.#embedded ? this.#compiled.get(zone) : undefined;
      if (own === undefined)
        return ask(other(zone));
      try {
        return ask(own.zone);
      }
      catch (error) {
        if (!(error instanceof CalendarError) || error.code !== 'JY0024' || !this.#knows(zone))
          throw error;
        return ask(fallback);
      }
    };
    this.provider = Object.freeze({
      toParts: (/** @type {number} */ epoch, /** @type {string} */ zone) => route(zone, (p) => p.toParts(epoch, zone)),
      toEpoch: (/** @type {any} */ parts, /** @type {string} */ zone, /** @type {string} */ disambiguation) =>
        route(zone, (p) => p.toEpoch(parts, zone, disambiguation)),
      candidates: (/** @type {any} */ parts, /** @type {string} */ zone) => route(zone, (p) => {
        if (typeof p.candidates !== 'function')
          throw new TypeError('the zone provider has no candidates(parts, zone)');
        return p.candidates(parts, zone);
      }),
      // a compiled definition lists its changes, so a sub-daily zoned walk
      // asks it per wall-clock hour; a provider that lists none (Intl) is
      // answered for with one entry at `from`, which the walk reads as "may
      // change here" and so resolves time by time, as without the member
      offsetChanges: (/** @type {number} */ from, /** @type {number} */ to, /** @type {string} */ zone) => route(zone, (p) => {
        if (typeof p.offsetChanges === 'function')
          return p.offsetChanges(from, to, zone);
        return [{ at: from, before: p.toParts(from, zone).offset, after: p.toParts(to, zone).offset }];
      }),
      get identity() {
        return identityOf();
      },
    });
    const identityOf = () => {
      if (!this.#embedded || this.#compiled.size === 0)
        return fallback?.identity;
      if (this.#identity?.size !== this.#compiled.size) {
        const own = [...this.#compiled.values()].map(({ zone }) => `${zone.identity.name}=${zone.identity.revision}`).sort();
        const other = fallback?.identity === undefined ? '' : `${fallback.identity.name}=${fallback.identity.revision}`;
        this.#identity = { size: this.#compiled.size, identity: Object.freeze({ name: 'vtimezone', revision: hashContent(JSON.stringify([own, other])) }) };
      }
      return this.#identity.identity;
    };
  }

  /** @type {Map<string, boolean>} */
  #known = new Map();

  /**
   * Whether the caller's provider knows a TZID as an IANA name.
   * @param {string} tzid
   * @returns {boolean}
   */
  #knows(tzid) {
    let known = this.#known.get(tzid);
    if (known === undefined) {
      known = this.#fallback !== null && IANA_FORM.test(tzid) && isZone(tzid, this.#fallback);
      this.#known.set(tzid, known);
    }
    return known;
  }

  /**
   * Compile a VTIMEZONE; one that cannot be compiled, or a second one of
   * a TZID, is reported and its TZID resolves as an undefined one does.
   * @param {import('./ical-machine.js').IcalNode} node
   * @param {any} report
   */
  define(node, report) {
    let definition;
    try {
      definition = definitionOf(node, report);
    }
    catch (error) {
      // under strict an entry of the mapping is its own refusal, not this one
      if (!(error instanceof IcalError) || error.code !== 'ICAL1014')
        throw error;
      report.add('ICAL1014', 'VTIMEZONE', node.path, node.line, `the VTIMEZONE cannot be compiled: ${error.reason}; ${fallbackNote(this.#embedded)}`);
      return;
    }
    const { tzid } = definition;
    if (this.#compiled.has(tzid)) {
      report.add('ICAL1014', 'VTIMEZONE', node.path, node.line, `a second VTIMEZONE of the TZID '${tzid}'; the first is kept`);
      return;
    }
    let zone;
    try {
      zone = compileVtimezone(definition, { horizon: this.#horizon, ...(this.#limits !== undefined ? { limits: this.#limits } : {}) });
    }
    catch (error) {
      if (!(error instanceof CalendarError))
        throw error;
      report.add('ICAL1014', 'VTIMEZONE', node.path, node.line,
        `the VTIMEZONE of '${tzid}' cannot be compiled: ${error.code} ${error.reason}; ${fallbackNote(this.#embedded)}`, error);
      return;
    }
    if (zone.status === 'incomplete') {
      report.add('ICAL1014', 'VTIMEZONE', node.path, node.line, `the VTIMEZONE of '${tzid}' stopped at ${zone.limit}; it is compiled only to `
        + `${new Date(zone.horizon.end).toISOString()}, and past that its instants are refused, never guessed`);
    }
    this.#compiled.set(tzid, { zone, path: node.path, line: node.line });
  }

  /**
   * Whether a TZID resolves through the file's own definition.
   * @param {string} tzid
   * @returns {boolean}
   */
  embedded(tzid) {
    return this.#embedded && this.#compiled.has(tzid);
  }

  /**
   * Note a wall clock a value names in a zone; `open` for a recurring
   * series' start, whose occurrences run on to the zone horizon's end.
   * @param {string} tzid
   * @param {number} wall
   * @param {boolean} [open]
   */
  use(tzid, wall, open = false) {
    const seen = this.#used.get(tzid);
    if (seen !== undefined) {
      seen.low = Math.min(seen.low, wall);
      seen.high = Math.max(seen.high, wall);
      seen.open ||= open;
    }
    else if (this.#used.size < 1024)
      this.#used.set(tzid, { low: wall, high: wall, open });
  }

  /**
   * Report, for every definition the file's values use: values outside
   * what it covers (under `'embedded'`), and, for an IANA name, where it
   * disagrees with the caller's provider over the span the values use
   * it, sampled a week apart and on both sides of every change the
   * definition makes.
   * @param {any} report
   */
  compare(report) {
    const fallback = this.#fallback;
    for (const [tzid, { zone, path, line }] of this.#compiled) {
      const use = this.#used.get(tzid);
      if (use === undefined)
        continue;
      const { start, end } = zone.horizon;
      if (this.#embedded && (use.low - REACH < start || use.high + REACH >= end)) {
        report.add('ICAL1024', 'VTIMEZONE', path, line, `values in '${tzid}' from ${new Date(use.low).toISOString().slice(0, 19)} `
          + `to ${new Date(use.high).toISOString().slice(0, 19)} (wall clock) reach outside what its VTIMEZONE covers `
          + `(${new Date(start).toISOString()} to ${new Date(end).toISOString()}); `
          + (this.#knows(tzid) ? 'the provider answers there' : 'there they are refused when resolved (JY0024), never guessed'));
      }
      if (fallback === null || !this.#knows(tzid))
        continue;
      const low = Math.max(start, use.low - DAY);
      const high = Math.min(end - 1, use.open ? Infinity : use.high + DAY);
      const found = firstDisagreement(zone, fallback, tzid, low, high);
      if (found === null)
        continue;
      const shown = (/** @type {number} */ minutes) => {
        const sign = minutes < 0 ? '-' : '+';
        const m = Math.abs(Math.round(minutes));
        return `${sign}${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      };
      report.add('ICAL1023', 'VTIMEZONE', path, line, `the VTIMEZONE of '${tzid}' and the provider disagree at ${new Date(found.at).toISOString()} `
        + `(${shown(found.file)} in the file, ${shown(found.provider)} by the provider); `
        + (this.#embedded ? "the file's definition is used (vtimezone: 'embedded')" : "the provider is used (vtimezone: 'provider')"));
    }
  }

  /**
   * The zones a read ends with.
   * @returns {{ provider: any, compiled: Record<string, import('@jarenjs/core/calendar').CompiledZone>, undeclared: string[] }}
   */
  summary() {
    /** @type {Record<string, any>} */
    const compiled = {};
    for (const [tzid, { zone }] of this.#compiled)
      compiled[tzid] = zone;
    const undeclared = [...this.#used.keys()].filter((tzid) => !this.#compiled.has(tzid));
    return { provider: this.provider, compiled, undeclared };
  }
}

/**
 * @param {boolean} embedded
 * @returns {string}
 */
const fallbackNote = (embedded) => (embedded
  ? 'a TZID it would define resolves through the provider when it names an IANA zone the provider knows, and is withheld otherwise'
  : 'its TZID resolves through the provider (vtimezone: \'provider\')');

/**
 * The first instant in `[low, high]` where a compiled definition and a
 * provider give different offsets, or null.
 * @param {import('@jarenjs/core/calendar').CompiledZone} zone
 * @param {any} provider
 * @param {string} tzid
 * @param {number} low
 * @param {number} high
 * @returns {{ at: number, file: number, provider: number } | null}
 */
function firstDisagreement(zone, provider, tzid, low, high) {
  const points = [];
  for (let at = low; at <= high; at += WEEK)
    points.push(at);
  for (const change of zone.transitions) {
    if (change.at - 1000 >= low && change.at <= high)
      points.push(change.at - 1000, change.at);
  }
  points.sort((a, b) => a - b);
  /** The two offsets at an instant, in seconds; null where the provider answers none. @param {number} at */
  const both = (at) => {
    try {
      return { file: zone.toParts(at, tzid).offset, provider: provider.toParts(at, tzid).offset };
    }
    catch {
      return null;
    }
  };
  const differ = (/** @type {{ file: number, provider: number } | null} */ pair) => pair !== null && Math.round(pair.file * 60) !== Math.round(pair.provider * 60);
  let agreed = null;
  for (const at of points) {
    const pair = both(at);
    if (!differ(pair)) {
      agreed = at;
      continue;
    }
    // the first second they disagree, between the last point they agreed and this one
    let lo = agreed ?? at;
    let hi = at;
    while (hi - lo > 1000) {
      const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
      if (differ(both(mid)))
        hi = mid;
      else
        lo = mid;
    }
    return { at: hi, .../** @type {{ file: number, provider: number }} */ (both(hi)) };
  }
  return null;
}
//#endregion
