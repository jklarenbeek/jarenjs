//@ts-check

/**
 * The vendored RFC example corpus (fixtures/ical-rfc: RFC 5545's
 * component and object examples, RFC 7986's property examples and RFC
 * 7808's time zone responses, with the section 4 objects and VTIMEZONE
 * examples vendored earlier) through both paths:
 *
 * - read -> write (canonical): the model read writes to a calendar that
 *   reads back to the same model (a cancelled slot reads back as the
 *   EXDATE the writer spells it as, making the same occurrences) and
 *   writes again to the same octets;
 * - read -> patch (lossless): the octets come back unchanged, as octets
 *   and as text.
 *
 * See fixtures/ical-rfc/PROVENANCE.md for what each file is.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseIcal, patchIcal, stringifyIcal } from '@jarenjs/josl/ical';
import { expandSeries } from '@jarenjs/core/calendar';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const provider = createIntlZoneProvider({ revision: 'corpus' });
const HORIZON = /** @type {[number, number]} */ ([Date.UTC(1990, 0, 1), Date.UTC(2040, 0, 1)]);
const RFC = ['rfc5545-3.4-object', 'rfc5545-3.6.1-vevent-1', 'rfc5545-3.6.1-vevent-2', 'rfc5545-3.6.1-vevent-3', 'rfc5545-3.6.1-vevent-4',
  'rfc5545-3.6.2-vtodo-1', 'rfc5545-3.6.2-vtodo-2', 'rfc5545-3.6.3-vjournal', 'rfc5545-3.6.4-vfreebusy-1', 'rfc5545-3.6.4-vfreebusy-2',
  'rfc5545-3.6.4-vfreebusy-3', 'rfc5545-3.6.6-valarm-1', 'rfc5545-3.6.6-valarm-2', 'rfc5545-3.6.6-valarm-3', 'rfc5545-4-object-1',
  'rfc5545-4-object-5', 'rfc5545-4-object-6', 'rfc7808-5.3.1-zone', 'rfc7808-5.3.3-alias', 'rfc7808-5.3.4-truncated',
  'rfc7986-erratum-conference', 'rfc7986-properties'];

/** The corpus: the RFC files here, the section 4 objects, and the VTIMEZONE examples in a calendar. */
function corpus() {
  /** @type {[string, Uint8Array][]} */
  const out = RFC.filter((name) => !name.includes('erratum'))
    .map((name) => [`ical-rfc/${name}.ics`, new Uint8Array(fs.readFileSync(`${FIXTURES}ical-rfc/${name}.ics`))]);
  for (const name of ['meeting', 'interop', 'todo'])
    out.push([`ical/rfc5545-section4-${name}.ics`, new Uint8Array(fs.readFileSync(`${FIXTURES}ical/rfc5545-section4-${name}.ics`))]);
  for (let i = 1; i <= 5; i++) {
    const zone = fs.readFileSync(`${FIXTURES}ical-vtimezone/rfc5545-vtimezone-${i}.ics`, 'utf8');
    out.push([`ical-vtimezone/rfc5545-vtimezone-${i}.ics`, new TextEncoder().encode(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:p\r\n${zone}END:VCALENDAR\r\n`)]);
  }
  return out;
}

/**
 * Write a model under the zones of its read.
 * @param {ReturnType<typeof parseIcal>} read
 */
const write = (read) => stringifyIcal(read.calendar, { zones: 'embed', provider: read.zones.provider, horizon: HORIZON });

/**
 * The occurrences of every series of a model, by UID.
 * @param {ReturnType<typeof parseIcal>} read
 */
function occurrences(read) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const component of read.calendar.components) {
    if (component.series === undefined)
      continue;
    const kind = component.series.base?.dtstart?.kind ?? component.series.rdates[0]?.kind ?? component.series.rdates[0]?.start?.kind;
    const horizon = kind === 'date' || kind === 'floating' ? [{ kind: 'date', date: '1990-01-01' }, { kind: 'date', date: '2040-01-01' }] : HORIZON;
    out[component.series.uid] = expandSeries(component.series, { horizon, provider: read.zones.provider }).occurrences;
  }
  return out;
}

describe('the RFC example corpus', () => {
  it('holds every vendored file, each listed in PROVENANCE.md', () => {
    const files = fs.readdirSync(`${FIXTURES}ical-rfc`).filter((name) => name.endsWith('.ics')).map((name) => name.slice(0, -4)).sort();
    assert.deepStrictEqual(files, [...RFC].sort());
    const provenance = fs.readFileSync(`${FIXTURES}ical-rfc/PROVENANCE.md`, 'utf8');
    for (const name of RFC)
      assert.ok(provenance.includes(`${name}.ics`), name);
  });

  for (const [name, bytes] of corpus()) {
    it(`${name}: read -> patch gives its octets back, and read -> write is a fixpoint`, () => {
      const read = parseIcal(bytes, { mode: 'lossless', provider });
      assert.ok(same(/** @type {Uint8Array} */ (patchIcal(/** @type {any} */ (read.tree))), bytes));
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      assert.strictEqual(patchIcal(/** @type {any} */ (parseIcal(text, { mode: 'lossless', provider }).tree)), text);
      const written = write(read);
      const back = parseIcal(written, { provider });
      assert.deepStrictEqual(back.report.unsupported, [], 'what the writer writes reads with no report entry');
      const cancelled = read.calendar.components.some((c) => c.series?.overrides.some((/** @type {any} */ o) => o.status === 'cancelled'));
      if (cancelled)
        assert.deepStrictEqual(occurrences(back), occurrences(read));
      else
        assert.deepStrictEqual(back.calendar, read.calendar);
      assert.strictEqual(write(back), written);
    });
  }

  it('refuses the RFC 7986 example whose parameter list ends in ";:" (ICAL1003), as its grammar requires', () => {
    const text = fs.readFileSync(`${FIXTURES}ical-rfc/rfc7986-erratum-conference.ics`, 'utf8');
    assert.throws(() => parseIcal(text, { mode: 'lossless' }), { code: 'ICAL1003' });
  });
});

/**
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 */
function same(a, b) {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
