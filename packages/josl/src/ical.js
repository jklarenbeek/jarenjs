//@ts-check

/**
 * `@jarenjs/josl/ical` - an iCalendar (RFC 5545) writer and reader over the
 * `@jarenjs/core/calendar` model: events (single, or a recurring series
 * with its extra dates, excluded dates and overrides) and free/busy
 * spans, written by kind - utc as `...Z`, date as `VALUE=DATE`, floating
 * with no zone, zoned converted to UTC under `zones: 'utc'`. Lines end
 * in CRLF and fold at 75 octets without splitting a code point; TEXT is
 * escaped; a member outside the documented subset is refused, never
 * written raw. `stringifyIcal` returns the whole calendar and
 * `createIcalWriter` writes it one component at a time; both run one
 * emitter. `parseIcal`, `createIcalReader` and `iterateIcal` read
 * iCalendar back into the same model through one engine, canonical
 * mode: what is outside the subset is reported, never silently
 * interpreted. See docs/ICAL.md.
 * @module
 */

import { resolveRuntime } from '@jarenjs/core/runtime';
import { utf8ByteLength } from '@jarenjs/core/string';
import { renderComponent } from './ical-map.js';
import { ICAL_CODES, ICAL_LIMIT_CODES, IcalError, escapeText, foldLine } from './ical-wire.js';
import { JoslLimitError, limitOption } from './limits.js';
import { ICAL_STREAM_WRITE, ICAL_WRITE, admitOptions } from './options.js';

const CALENDAR_KEYS = Object.freeze(['prodId', 'method', 'components']);
const METHODS = Object.freeze({ publish: 'PUBLISH' });
const TAIL = 'END:VCALENDAR\r\n';
const LAST_INSTANT = 253402300799000;

/**
 * The options both writers take.
 * @typedef {Object} IcalWriterOptions
 * @property {'utc'} [zones] - how zoned values are written; `'utc'`
 *   converts each to its UTC instant (the only mode in this release).
 *   Required as soon as a zoned value is written.
 * @property {import('@jarenjs/core/series').ZoneProvider | null} [provider] - the zone
 *   provider zoned values resolve through; defaults to `runtime.zoneProvider`
 * @property {Partial<import('@jarenjs/core/runtime').Runtime>} [runtime] - its
 *   `now()` is the DTSTAMP of a component that gives none
 * @property {[unknown, unknown]} [horizon] - the half-open span `[start, end)`
 *   (utc values or epoch milliseconds) a zoned recurring series is
 *   expanded over; without it such a series is refused
 * @property {import('@jarenjs/core/calendar').RecurrenceLimits} [limits] - the
 *   expansion's limits (the calendar layer's defaults when absent)
 * @property {number} [maxOctets] - the calendar's size in octets, line breaks included
 * @property {number} [maxComponents] - VEVENT and VFREEBUSY components, each override's VEVENT among them
 * @property {number} [maxRdates] - RDATE values, given and expanded
 */

/**
 * The incremental writer's options: the calendar's head, a chunk sink,
 * and the options {@link stringifyIcal} takes.
 * @typedef {IcalWriterOptions & { prodId: string, method?: 'publish', onChunk?: (chunk: string) => void }} IcalStreamWriterOptions
 */

/**
 * The head of a calendar: BEGIN, VERSION, PRODID and METHOD.
 * @param {unknown} prodId
 * @param {unknown} method
 * @param {string} at - the pointer the two members sit under
 * @returns {string}
 */
function headOf(prodId, method, at) {
  if (prodId === undefined)
    throw new IcalError('ICAL3001', 'a calendar names its product (prodId)', `${at}/prodId`);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${escapeText(prodId, `${at}/prodId`)}`];
  if (method !== undefined) {
    if (typeof method !== 'string' || !Object.hasOwn(METHODS, method))
      throw new IcalError('ICAL3002', `method is 'publish' or absent; ${String(method)} is outside the documented subset`, `${at}/method`);
    lines.push(`METHOD:${METHODS[method]}`);
  }
  return lines.map(foldLine).join('');
}

/**
 * An incremental iCalendar writer: components in, chunks out. A chunk is
 * a whole component (an event's overrides with it); a component that
 * would cross a limit, or that is refused, is never emitted, and the
 * writer then takes nothing more. With an `onChunk` sink the chunks
 * already sent before a refusal are a calendar's head and whole
 * components with no END:VCALENDAR - an unfinished calendar, never one
 * that reads as complete.
 */
export class IcalWriter {
  /** @type {'open' | 'ended' | 'failed'} */
  #state = 'open';
  /** @type {string[]} */
  #chunks = [];
  /** @type {((chunk: string) => void) | null} */
  #onChunk;
  #octets = 0;
  #components = 0;
  #rdates = 0;
  #index = 0;
  #limits;
  /** @type {import('./ical-map.js').MapContext} */
  #context;

  /**
   * @param {IcalStreamWriterOptions} options
   * @param {string} [at] - where the head's members sit in the caller's input
   */
  constructor(options, at = '/options') {
    const admitted = admitOptions(options, ICAL_STREAM_WRITE, 'createIcalWriter');
    this.#onChunk = admitted.onChunk ?? null;
    this.#limits = {
      maxOctets: limitOption(admitted, 'maxOctets'),
      maxComponents: limitOption(admitted, 'maxComponents'),
      maxRdates: limitOption(admitted, 'maxRdates'),
    };
    const runtime = resolveRuntime(admitted.runtime);
    let now;
    this.#context = {
      zones: admitted.zones ?? undefined,
      provider: admitted.provider ?? runtime.zoneProvider ?? null,
      horizon: admitted.horizon ?? undefined,
      limits: admitted.limits ?? undefined,
      now: () => {
        if (now === undefined) {
          const at = runtime.now();
          if (typeof at !== 'number' || !Number.isFinite(at) || at < 0 || at > LAST_INSTANT)
            throw new TypeError(`runtime.now() answered ${String(at)}, not an instant from 1970 to 9999`);
          now = Math.floor(at / 1000) * 1000;
        }
        return now;
      },
    };
    this.#emit(headOf(admitted.prodId, admitted.method, at), 0);
  }

  /**
   * Send or keep a chunk, after the size limit: the calendar's tail is
   * always kept room for, so an accepted component can always be closed.
   * @param {string} text
   * @param {number} tail - octets still owed after this chunk
   */
  #emit(text, tail) {
    const octets = utf8ByteLength(text);
    if (this.#octets + octets + tail > this.#limits.maxOctets) {
      this.#state = 'failed';
      throw new JoslLimitError('ICAL2001', ICAL_LIMIT_CODES.ICAL2001, this.#limits.maxOctets);
    }
    this.#octets += octets;
    if (this.#onChunk !== null)
      this.#onChunk(text);
    else
      this.#chunks.push(text);
  }

  /** Refuse a call on a writer that has ended or refused. */
  #open() {
    if (this.#state !== 'open')
      throw new IcalError('ICAL3018', `the writer has ${this.#state}`, `/components/${this.#index}`);
  }

  /**
   * Write one component: an event (`type: 'event'`) or a free/busy
   * component (`type: 'freebusy'`).
   * @param {Record<string, unknown>} component
   * @returns {this} The writer, for chaining
   * @throws {IcalError} for a component outside the model; the writer is then closed
   * @throws {JoslLimitError} for a limit it would cross; the writer is then closed
   */
  write(component) {
    this.#open();
    try {
      const rendered = renderComponent(component, this.#context, `/components/${this.#index}`);
      if (this.#components + rendered.components > this.#limits.maxComponents)
        throw new JoslLimitError('ICAL2002', ICAL_LIMIT_CODES.ICAL2002, this.#limits.maxComponents);
      if (this.#rdates + rendered.rdates > this.#limits.maxRdates)
        throw new JoslLimitError('ICAL2003', ICAL_LIMIT_CODES.ICAL2003, this.#limits.maxRdates);
      this.#emit(rendered.lines.map(foldLine).join(''), TAIL.length);
      this.#components += rendered.components;
      this.#rdates += rendered.rdates;
      this.#index++;
    }
    catch (error) {
      this.#state = 'failed';
      throw error;
    }
    return this;
  }

  /**
   * Write many components.
   * @param {Iterable<Record<string, unknown>>} components
   * @returns {this} The writer, for chaining
   */
  writeAll(components) {
    for (const component of components)
      this.write(component);
    return this;
  }

  /**
   * Concatenate the kept chunks; empty when an `onChunk` sink is set.
   * @returns {string} The calendar so far
   */
  toString() {
    return this.#chunks.join('');
  }

  /**
   * Close the calendar with END:VCALENDAR.
   * @returns {string} The whole calendar, or `''` with an `onChunk` sink
   */
  end() {
    this.#open();
    this.#emit(TAIL, 0);
    this.#state = 'ended';
    return this.toString();
  }
}

/**
 * Create an incremental iCalendar writer. The head (BEGIN:VCALENDAR,
 * VERSION, PRODID, METHOD) is written at once; `write` adds a component,
 * `end` closes the calendar.
 * @param {IcalStreamWriterOptions} options
 * @returns {IcalWriter}
 * @throws {TypeError} for an unknown or mistyped option, or a limit that is not a positive integer
 * @throws {IcalError} for a missing or malformed `prodId`, or a `method` outside the subset
 * @example
 * const writer = createIcalWriter({ prodId: '-//Example//Rota//EN' });
 * writer.write({ type: 'event', uid: 'shift-1', dtstamp: 0,
 *   start: { kind: 'utc', instant: '2026-03-02T08:00:00Z' }, duration: 'PT8H' });
 * writer.end().split('\r\n')[4]; // 'UID:shift-1'
 */
export function createIcalWriter(options) {
  return new IcalWriter(options);
}

/**
 * Write a whole calendar: `{ prodId, method?, components }`.
 * @param {{ prodId: string, method?: 'publish', components: Record<string, unknown>[] }} calendar
 * @param {IcalWriterOptions} [options]
 * @returns {string} The calendar, CRLF line endings
 * @throws {IcalError} for anything outside the documented model, with a pointer into it
 * @throws {JoslLimitError} for a limit the calendar would cross; nothing is returned truncated
 * @throws {TypeError} for an unknown or mistyped option
 * @example
 * stringifyIcal({
 *   prodId: '-//Example//Shop hours//EN',
 *   components: [{ type: 'event', uid: 'sale', dtstamp: 0, start: { kind: 'date', date: '2026-12-24' } }],
 * });
 * // 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Example//Shop hours//EN\r\nBEGIN:VEVENT\r\n'
 * // + 'UID:sale\r\nDTSTAMP:19700101T000000Z\r\nDTSTART;VALUE=DATE:20261224\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'
 */
export function stringifyIcal(calendar, options = undefined) {
  const admitted = admitOptions(options, ICAL_WRITE, 'stringifyIcal');
  if (calendar === null || typeof calendar !== 'object' || Array.isArray(calendar))
    throw new IcalError('ICAL3001', 'a calendar is { prodId, method?, components }', '');
  for (const key of Object.keys(calendar)) {
    if (!CALENDAR_KEYS.includes(key))
      throw new IcalError('ICAL3002', `a calendar carries no '${key}' in the documented subset`, `/${key}`);
  }
  const { components } = calendar;
  if (!Array.isArray(components))
    throw new IcalError('ICAL3001', 'a calendar has its components (a list, which may be empty)', '/components');
  const writer = new IcalWriter({ ...admitted, prodId: calendar.prodId, method: calendar.method }, '');
  return writer.writeAll(components).end();
}

export { ICAL_CODES, ICAL_LIMIT_CODES, IcalError, JoslLimitError };
export { parseIcal, createIcalReader, iterateIcal, IcalReader } from './ical-read.js';
