//@ts-check

/**
 * A chunk boundary anywhere never changes what the reader reads: every
 * fixture fed split at every octet (inside UTF-8 sequences, CRLFs, folds
 * and escapes), at every code unit of its text, one octet at a time, and
 * in seeded random pieces, gives the same components, head and report -
 * or the same refusal, code, line and path. And every limit refuses
 * exactly below what the input needs, wherever the chunks break.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createIcalReader } from '@jarenjs/josl/ical';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';

const DIR = fileURLToPath(new URL('./fixtures/ical/', import.meta.url));
const provider = createIntlZoneProvider({ revision: 'chunks' });
const enc = new TextEncoder();

/** A small seeded generator (mulberry32). @param {number} seed */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Read chunks; the outcome as JSON text.
 * @param {(string | Uint8Array)[]} chunks
 * @param {any} [options]
 * @returns {string}
 */
function outcome(chunks, options = { provider }) {
  const reader = createIcalReader(options);
  /** @type {any[]} */
  const components = [];
  try {
    for (const chunk of chunks)
      components.push(...reader.feed(chunk));
    const { calendar, report } = reader.end();
    components.push(...calendar.components);
    return JSON.stringify({ head: [calendar.prodId, calendar.method], components, report });
  }
  catch (error) {
    const e = /** @type {any} */ (error);
    if (e.code === undefined)
      throw error;
    return JSON.stringify({ refused: [e.code, e.line, e.docPath ?? null, e.limit ?? null] });
  }
}


/**
 * Pieces at sorted offsets.
 * @template {string | Uint8Array} T
 * @param {T} whole
 * @param {number[]} cuts
 * @returns {T[]}
 */
function pieces(whole, cuts) {
  const out = [];
  let from = 0;
  for (const cut of [...cuts, whole.length]) {
    out.push(/** @type {T} */ (typeof whole === 'string' ? whole.slice(from, cut) : whole.subarray(from, cut)));
    from = cut;
  }
  return out;
}

const synthetic = /** @type {[string, string][]} */ ([
  ['escapes, folds and four-octet text', ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//A\\, B//EN', 'BEGIN:VEVENT', 'UID:e\\;1', 'DTSTART:20260302T090000Z',
    'SUMMARY:a\\,b\\;c\\\\d\\ne 😀😀😀', ' 中文 😀', 'DESCRIPTION:x', '\ty', 'X-A;Q="a:b,c":1', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n')],
  ['bare line feeds and report entries', ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:p', 'X-WR-CALNAME:n', 'BEGIN:VTODO', 'END:VTODO', 'BEGIN:VEVENT',
    'UID:s', 'DTSTART;TZID=Europe/Amsterdam:20260302T090000', 'RRULE:FREQ=WEEKLY;COUNT=3', 'END:VEVENT', 'BEGIN:VEVENT', 'UID:s',
    'RECURRENCE-ID;TZID=Europe/Amsterdam:20260309T090000', 'DTSTART;TZID=Europe/Amsterdam:20260309T100000', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:w', 'DTSTART;TZID=Nowhere/Land:20260302T090000', 'END:VEVENT', 'END:VCALENDAR', ''].join('\n')],
  ['a refusal mid-stream', ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:p', 'BEGIN:VEVENT', 'UID:a', 'DTSTART:20260302T090000Z', 'END:VEVENT',
    'BEGIN:VEVENT', 'X-A;CN="open:1', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n')],
  ['an unclosed component', ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:p', 'BEGIN:VEVENT', 'UID:a', 'DTSTART:20260302T090000Z', ''].join('\r\n')],
]);

const fixtures = [
  ...fs.readdirSync(DIR).filter((name) => name.endsWith('.ics')).sort().map((name) => [name, new Uint8Array(fs.readFileSync(`${DIR}${name}`))]),
  ...synthetic.map(([name, text]) => [name, enc.encode(text)]),
];

describe('ical reader: a chunk boundary anywhere never changes the result', () => {
  it('the fixtures split inside a four-octet sequence, a CRLF and space fold, a tab fold and a \\, escape', () => {
    const all = fixtures.map(([, bytes]) => Buffer.from(/** @type {Uint8Array} */ (bytes)).toString('latin1')).join('');
    for (const needle of [/\xF0\x9F\x98\x80/, /\r\n /, /\r\n\t/, /\\,/, /[^\r]\n/, /[\xC0-\xFF]\r\n [\x80-\xBF]/])
      assert.ok(needle.test(all), String(needle));
  });

  for (const [name, bytes] of /** @type {[string, Uint8Array][]} */ (fixtures)) {
    it(`${name}: every octet split, every code-unit split, one octet at a time, and 60 random cuts`, () => {
      const whole = outcome([bytes]);
      const text = new TextDecoder().decode(bytes);
      const textWhole = text.includes('\uFFFD') ? null : outcome([text]);
      if (textWhole !== null)
        assert.strictEqual(textWhole, whole, 'text and octets read alike');
      for (let cut = 0; cut <= bytes.length; cut++)
        assert.strictEqual(outcome(pieces(bytes, [cut])), whole, `octet split at ${cut}`);
      if (textWhole !== null) {
        for (let cut = 0; cut <= text.length; cut++)
          assert.strictEqual(outcome(pieces(text, [cut])), whole, `code-unit split at ${cut}`);
      }
      assert.strictEqual(outcome(Array.from(bytes, (_, i) => bytes.subarray(i, i + 1))), whole, 'one octet at a time');
      const next = random(bytes.length);
      for (let round = 0; round < 60; round++) {
        const cuts = Array.from({ length: 1 + Math.floor(next() * 12) }, () => Math.floor(next() * (bytes.length + 1))).sort((a, b) => a - b);
        assert.strictEqual(outcome(pieces(bytes, cuts)), whole, `cuts ${cuts.join(',')}`);
        if (textWhole !== null) {
          const textCuts = cuts.map((c) => Math.min(c, text.length));
          assert.strictEqual(outcome(pieces(text, textCuts)), whole, `text cuts ${textCuts.join(',')}`);
        }
      }
    });
  }
});

describe('ical reader: octet limits, fuzzed', () => {
  const LIMITS = /** @type {const} */ ([['maxOctets', 'ICAL2001'], ['maxLineOctets', 'ICAL2004'], ['maxParameters', 'ICAL2005'],
    ['maxDepth', 'ICAL2006'], ['maxComponents', 'ICAL2002'], ['maxProperties', 'ICAL2007']]);

  /**
   * The least value of a limit the input reads under.
   * @param {Uint8Array} bytes
   * @param {string} name
   */
  function need(bytes, name) {
    let low = 1;
    let high = bytes.length + 1;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (JSON.parse(outcome([bytes], { provider, [name]: mid })).refused?.[0]?.startsWith('ICAL200'))
        low = mid + 1;
      else
        high = mid;
    }
    return low;
  }

  for (const [name, bytes] of /** @type {[string, Uint8Array][]} */ (fixtures.filter(([file]) => /^(exporter-|series|kinds)/.test(String(file))))) {
    it(`${name}: each limit refuses below its need with its code, at every chunking, and admits from it`, () => {
      const whole = outcome([bytes]);
      const next = random(7 * bytes.length);
      for (const [limit, code] of LIMITS) {
        const least = need(bytes, limit);
        if (limit === 'maxOctets')
          assert.strictEqual(least, bytes.length);
        for (let round = 0; round < 12; round++) {
          const value = round === 0 ? least : round === 1 ? least - 1 : 1 + Math.floor(next() * least * 2);
          if (value < 1)
            continue;
          const options = { provider, [limit]: value };
          const expected = outcome([bytes], options);
          if (value >= least)
            assert.strictEqual(expected, whole, `${limit} ${value} reads the calendar whole`);
          else
            assert.strictEqual(JSON.parse(expected).refused[0], code, `${limit} ${value}`);
          const cuts = Array.from({ length: 1 + Math.floor(next() * 8) }, () => Math.floor(next() * (bytes.length + 1))).sort((a, b) => a - b);
          assert.strictEqual(outcome(pieces(bytes, cuts), options), expected, `${limit} ${value}, cuts ${cuts.join(',')}`);
        }
      }
    });
  }
});
