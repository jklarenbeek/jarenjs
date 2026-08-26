//@ts-check

/**
 * The calendar language: `dateMessagesEn`, `compileDateLocale`, the
 * opt-in `Intl` provider, and the two properties that decide whether
 * repository-owned data was worth the bytes - a formatter compiled once
 * costs nothing per date, and a server-rendered page is the same bytes
 * whatever the host's locale and timezone are.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  dateMessagesEn,
  compileDateLocale,
  createIntlDateLocale,
  RELATIVE_UNITS,
  nl,
  ar,
  ja,
  ru,
} from '@jarenjs/locales';
import { compileMessageCatalog } from '@jarenjs/core/message';
import { compileDateFormat, parseRFC3339Parts } from '@jarenjs/core/dates';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Run one module snippet in a child node with a chosen environment. */
function runNode(source, env = {}) {
  return execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

describe('@jarenjs/locales date messages', () => {
  it('is a closed key set: 12 months, 7 weekdays, 2 markers, 7 units, 4 named days, 6 formats', () => {
    const keys = Object.keys(dateMessagesEn);
    assert.strictEqual(keys.length, 64);

    const months = keys.filter((k) => k.startsWith('date/month/'));
    const weekdays = keys.filter((k) => k.startsWith('date/weekday/'));
    const meridiem = keys.filter((k) => k.startsWith('date/meridiem/'));
    const relative = keys.filter((k) => k.startsWith('date/relative/'));
    const formats = keys.filter((k) => k.startsWith('format/name/'));
    assert.strictEqual(months.length, 24);
    assert.strictEqual(weekdays.length, 14);
    assert.strictEqual(meridiem.length, 2);
    assert.strictEqual(relative.length, 18);
    assert.strictEqual(formats.length, 6);
    assert.strictEqual(months.length + weekdays.length + meridiem.length
      + relative.length + formats.length, keys.length);

    // the month number is zero-padded so the keys sort the way a
    // calendar reads, and the weekday index is the one core's EEEE token
    // looks a name up by
    assert.ok(keys.includes('date/month/01/wide'));
    assert.ok(keys.includes('date/month/12/short'));
    assert.ok(keys.includes('date/weekday/0/wide'));
    assert.ok(keys.includes('date/weekday/6/short'));
    for (const unit of RELATIVE_UNITS) {
      assert.ok(keys.includes(`date/relative/${unit}/past`), unit);
      assert.ok(keys.includes(`date/relative/${unit}/future`), unit);
    }
  });

  it('compiles English names in calendar order', () => {
    const { names } = compileDateLocale();
    assert.strictEqual(names.months.length, 12);
    assert.strictEqual(names.monthsShort.length, 12);
    assert.strictEqual(names.weekdays.length, 7);
    assert.strictEqual(names.weekdaysShort.length, 7);
    assert.strictEqual(names.meridiem.length, 2);
    assert.strictEqual(names.months[0], 'January');
    assert.strictEqual(names.months[11], 'December');
    assert.strictEqual(names.monthsShort[6], 'Jul');
    assert.strictEqual(names.weekdays[0], 'Sunday');
    assert.strictEqual(names.weekdays[6], 'Saturday');
    assert.strictEqual(names.weekdaysShort[3], 'Wed');
    assert.deepStrictEqual([...names.meridiem], ['AM', 'PM']);
    // frozen, because a formatter closes over them for its lifetime
    assert.ok(Object.isFrozen(names));
    assert.ok(Object.isFrozen(names.months));
  });
});

describe('@jarenjs/locales compileDateLocale — the name tokens', () => {
  // 2026-07-05 is a Sunday, so weekday index 0 is exercised too
  const sunday = parseRFC3339Parts('2026-07-05T14:30:05Z');

  it('renders every name token core refuses to invent', () => {
    const { names } = compileDateLocale();
    const format = compileDateFormat("EEEE, d MMMM yyyy 'at' h:mm a (EEE, MMM)", names);
    assert.strictEqual(format(sunday), 'Sunday, 5 July 2026 at 2:30 PM (Sun, Jul)');
  });

  it('renders Latin, RTL and CJK packs from the same pattern', () => {
    const pattern = 'EEEE d MMMM yyyy';
    assert.strictEqual(
      compileDateFormat(pattern, compileDateLocale(nl).names)(sunday),
      'zondag 5 juli 2026');
    assert.strictEqual(
      compileDateFormat(pattern, compileDateLocale(ar).names)(sunday),
      'الأحد 5 يوليو 2026');
    assert.strictEqual(
      compileDateFormat(pattern, compileDateLocale(ja).names)(sunday),
      '日曜日 5 7月 2026');
    // Russian carries the FORMAT (genitive) month, because the array
    // feeds a pattern rather than a standalone label
    assert.strictEqual(
      compileDateFormat('d MMMM yyyy', compileDateLocale(ru).names)(sunday),
      '5 июля 2026');
  });

  it('the meridiem marker follows the hour', () => {
    const format = compileDateFormat('a', compileDateLocale(nl).names);
    assert.strictEqual(format(parseRFC3339Parts('2026-07-05T09:00:00Z')), 'a.m.');
    assert.strictEqual(format(parseRFC3339Parts('2026-07-05T21:00:00Z')), 'p.m.');
  });

  it('compiles once: the catalog is read at compile time and never again', () => {
    // every entry counts its own renders, so a formatter that re-read a
    // name per date would move the number on any host at any speed
    let reads = 0;
    /** @type {Record<string, any>} */
    const counting = {};
    for (const key of Object.keys(dateMessagesEn)) {
      const entry = dateMessagesEn[key];
      counting[key] = (p) => {
        reads += 1;
        return typeof entry === 'function' ? entry(p) : entry;
      };
    }

    const locale = compileDateLocale(counting);
    const afterCompile = reads;
    // 24 month + 14 weekday + 2 meridiem + 4 named day + 6 format names,
    // each read exactly once; the 14 relative phrases stay closures
    assert.strictEqual(afterCompile, 50);

    const format = compileDateFormat('EEEE d MMMM yyyy a', locale.names);
    for (let i = 0; i < 1000; ++i) {
      format(sunday);
      locale.formatName('date-time');
    }
    assert.strictEqual(reads, afterCompile, 'formatting re-read the catalog');
  });
});

describe('@jarenjs/locales compileDateLocale — relative phrases', () => {
  it('takes an explicit signed amount and reads no clock', () => {
    const en = compileDateLocale();
    assert.strictEqual(en.relative(-3, 'day'), '3 days ago');
    assert.strictEqual(en.relative(3, 'day'), 'in 3 days');
    assert.strictEqual(en.relative(-1, 'hour'), '1 hour ago');
    assert.strictEqual(en.relative(1, 'hour'), 'in 1 hour');

    // nothing here may ask what time it is: the amount IS the input
    const realNow = Date.now;
    let clockReads = 0;
    Date.now = () => { clockReads += 1; return realNow.call(Date); };
    try {
      const locale = compileDateLocale(nl);
      locale.relative(-5, 'minute');
      locale.relative(2, 'year', { numeric: 'auto' });
      compileDateFormat('EEEE MMMM a', locale.names);
    }
    finally {
      Date.now = realNow;
    }
    assert.strictEqual(clockReads, 0);
  });

  it('phrases every unit in both directions, singular and plural', () => {
    const en = compileDateLocale();
    /** unit -> [past 1, past 2, future 1, future 2] */
    const table = {
      second: ['1 second ago', '2 seconds ago', 'in 1 second', 'in 2 seconds'],
      minute: ['1 minute ago', '2 minutes ago', 'in 1 minute', 'in 2 minutes'],
      hour: ['1 hour ago', '2 hours ago', 'in 1 hour', 'in 2 hours'],
      day: ['1 day ago', '2 days ago', 'in 1 day', 'in 2 days'],
      week: ['1 week ago', '2 weeks ago', 'in 1 week', 'in 2 weeks'],
      month: ['1 month ago', '2 months ago', 'in 1 month', 'in 2 months'],
      year: ['1 year ago', '2 years ago', 'in 1 year', 'in 2 years'],
    };
    assert.deepStrictEqual(Object.keys(table), [...RELATIVE_UNITS]);
    for (const [unit, [pastOne, pastTwo, futureOne, futureTwo]] of Object.entries(table)) {
      assert.strictEqual(en.relative(-1, unit), pastOne);
      assert.strictEqual(en.relative(-2, unit), pastTwo);
      assert.strictEqual(en.relative(1, unit), futureOne);
      assert.strictEqual(en.relative(2, unit), futureTwo);
    }
  });

  it("'auto' reaches for a named day only where it is exact", () => {
    const en = compileDateLocale();
    const auto = { numeric: 'auto' };
    assert.strictEqual(en.relative(-1, 'day', auto), 'yesterday');
    assert.strictEqual(en.relative(0, 'day', auto), 'today');
    assert.strictEqual(en.relative(1, 'day', auto), 'tomorrow');
    assert.strictEqual(en.relative(0, 'second', auto), 'now');
    // two days is not a named day, and a zero-minute offset is not now:
    // it is anything within the minute
    assert.strictEqual(en.relative(-2, 'day', auto), '2 days ago');
    assert.strictEqual(en.relative(0, 'minute', auto), 'in 0 minutes');
    assert.strictEqual(en.relative(0, 'month', auto), 'in 0 months');
    // the default is the numeric phrasing
    assert.strictEqual(en.relative(-1, 'day'), '1 day ago');
  });

  it('a signed zero is the one zero', () => {
    const en = compileDateLocale();
    assert.strictEqual(en.relative(-0, 'day'), 'in 0 days');
    assert.strictEqual(en.relative(0, 'day'), 'in 0 days');
    assert.strictEqual(compileDateLocale(nl).relative(-0, 'week'), 'over 0 weken');
  });

  it('refuses a fractional amount, an unsupported unit and an unknown mode', () => {
    const en = compileDateLocale();
    assert.throws(() => en.relative(1.5, 'day'), /whole number of units/);
    assert.throws(() => en.relative(NaN, 'day'), /whole number of units/);
    assert.throws(() => en.relative(Infinity, 'day'), /whole number of units/);
    assert.throws(() => en.relative(1, 'fortnight'), /unsupported relative unit/);
    assert.throws(() => en.relative(1, 'quarter'), /unsupported relative unit/);
    // an inherited member name is not a unit
    assert.throws(() => en.relative(1, 'constructor'), /unsupported relative unit/);
    assert.throws(() => en.relative(1, 'day', { numeric: 'never' }), /unknown relative numeric mode/);
  });

  it('every pack phrases its own plural and case edges', () => {
    // Dutch: 'uur' and 'jaar' take no plural after a numeral
    const dutch = compileDateLocale(nl);
    assert.strictEqual(dutch.relative(-1, 'second'), '1 seconde geleden');
    assert.strictEqual(dutch.relative(-2, 'second'), '2 seconden geleden');
    assert.strictEqual(dutch.relative(-2, 'hour'), '2 uur geleden');
    assert.strictEqual(dutch.relative(5, 'year'), 'over 5 jaar');
    assert.strictEqual(dutch.relative(-21, 'day'), '21 dagen geleden');

    // Russian: the accusative one/few/many, and 'one' recurring at 21
    const russian = compileDateLocale(ru);
    assert.strictEqual(russian.relative(-0, 'day'), 'через 0 дней');
    assert.strictEqual(russian.relative(-1, 'day'), '1 день назад');
    assert.strictEqual(russian.relative(-2, 'day'), '2 дня назад');
    assert.strictEqual(russian.relative(-5, 'day'), '5 дней назад');
    assert.strictEqual(russian.relative(-21, 'day'), '21 день назад');
    assert.strictEqual(russian.relative(-22, 'day'), '22 дня назад');
    assert.strictEqual(russian.relative(21, 'year'), 'через 21 год');
    assert.strictEqual(russian.relative(5, 'year'), 'через 5 лет');

    // Arabic: one and two carry no numeral at all, three to ten take the
    // broken plural, eleven to ninety-nine the accusative singular
    const arabic = compileDateLocale(ar);
    assert.strictEqual(arabic.relative(-1, 'day'), 'قبل يوم واحد');
    assert.strictEqual(arabic.relative(-2, 'day'), 'قبل يومين');
    assert.strictEqual(arabic.relative(-5, 'day'), 'قبل 5 أيام');
    assert.strictEqual(arabic.relative(-21, 'day'), 'قبل 21 يومًا');
    assert.strictEqual(arabic.relative(-100, 'day'), 'قبل 100 يوم');
    assert.strictEqual(arabic.relative(2, 'year'), 'خلال سنتين');

    // Japanese counts through a counter and has no plural at all
    const japanese = compileDateLocale(ja);
    assert.strictEqual(japanese.relative(-1, 'day'), '1 日前');
    assert.strictEqual(japanese.relative(-5, 'day'), '5 日前');
    assert.strictEqual(japanese.relative(21, 'month'), '21 か月後');
  });
});

describe('@jarenjs/locales compileDateLocale — validation and fallback', () => {
  it('falls back to English per missing key, for a partial catalog', () => {
    const partial = compileDateLocale({
      'date/month/01/wide': 'Januari',
      'date/relative/day/past': (p) => `${p.value} dae gelede`,
      'format/name/date': 'datum',
    });
    assert.strictEqual(partial.names.months[0], 'Januari');
    assert.strictEqual(partial.names.months[1], 'February');
    assert.strictEqual(partial.relative(-2, 'day'), '2 dae gelede');
    assert.strictEqual(partial.relative(2, 'day'), 'in 2 days');
    assert.strictEqual(partial.formatName('date'), 'datum');
    assert.strictEqual(partial.formatName('time'), 'time');
  });

  it('takes an already-compiled catalog as readily as a pack', () => {
    const compiled = compileMessageCatalog(nl);
    assert.deepStrictEqual(
      [...compileDateLocale(compiled).names.months],
      [...compileDateLocale(nl).names.months]);
  });

  it('refuses an entry that does not render readable text', () => {
    assert.throws(() => compileDateLocale({ 'date/month/03/wide': () => '' }),
      /'date\/month\/03\/wide' must render a non-empty string/);
    assert.throws(() => compileDateLocale({ 'date/weekday/2/short': () => 42 }),
      /'date\/weekday\/2\/short' must render a non-empty string/);
    assert.throws(() => compileDateLocale({ 'date/meridiem/pm': () => null }),
      /'date\/meridiem\/pm' must render a non-empty string/);
  });

  it('names an unknown format nothing at all, so a caller can fall back', () => {
    const en = compileDateLocale();
    assert.strictEqual(en.formatName('date'), 'date');
    assert.strictEqual(en.formatName('time'), 'time');
    assert.strictEqual(en.formatName('date-time'), 'date and time');
    assert.strictEqual(en.formatName('iso-date'), 'ISO date');
    assert.strictEqual(en.formatName('iso-time'), 'ISO time');
    assert.strictEqual(en.formatName('iso-date-time'), 'ISO date and time');
    assert.strictEqual(en.formatName('email'), undefined);
    assert.strictEqual(en.formatName('constructor'), undefined);
    assert.strictEqual(en.formatName(/** @type {any} */ (undefined)), undefined);
    assert.strictEqual(compileDateLocale(nl).formatName('date-time'), 'datum en tijd');
  });
});

describe('@jarenjs/locales createIntlDateLocale — the opt-in provider', () => {
  it('answers the same SHAPE, never asserted as the same text', () => {
    const intl = createIntlDateLocale('nl-NL');
    assert.strictEqual(intl.names.months.length, 12);
    assert.strictEqual(intl.names.monthsShort.length, 12);
    assert.strictEqual(intl.names.weekdays.length, 7);
    assert.strictEqual(intl.names.weekdaysShort.length, 7);
    assert.strictEqual(intl.names.meridiem.length, 2);
    for (const name of [...intl.names.months, ...intl.names.weekdays, ...intl.names.meridiem]) {
      assert.strictEqual(typeof name, 'string');
      assert.ok(name.length > 0);
    }
    assert.ok(Object.isFrozen(intl.names));
    // it plugs into the same formatter
    const text = compileDateFormat('EEEE d MMMM yyyy', intl.names)(
      parseRFC3339Parts('2026-07-05T00:00:00Z'));
    assert.strictEqual(typeof text, 'string');
    assert.ok(text.includes('2026'));
    // and the relative phrases are strings, whatever this ICU spells
    assert.strictEqual(typeof intl.relative(-3, 'day'), 'string');
    assert.strictEqual(typeof intl.relative(1, 'day', { numeric: 'auto' }), 'string');
  });

  it('refuses exactly what the repository provider refuses', () => {
    const intl = createIntlDateLocale('en-US');
    assert.throws(() => intl.relative(1.5, 'day'), /whole number of units/);
    assert.throws(() => intl.relative(1, 'fortnight'), /unsupported relative unit/);
    assert.throws(() => intl.relative(1, 'constructor'), /unsupported relative unit/);
    assert.throws(() => intl.relative(1, 'day', { numeric: 'never' }), /unknown relative numeric mode/);
  });

  it('carries the repository format names, because ICU has none', () => {
    const intl = createIntlDateLocale('en-US');
    assert.strictEqual(intl.formatName('date-time'), 'date and time');
    assert.strictEqual(intl.formatName('email'), undefined);
    assert.strictEqual(intl.formatName('constructor'), undefined);
    const overridden = createIntlDateLocale('nl-NL', {
      formatNames: { 'date-time': 'datum en tijd' },
    });
    assert.strictEqual(overridden.formatName('date-time'), 'datum en tijd');
    assert.strictEqual(overridden.formatName('date'), 'date');
  });

  it('pins the Gregorian calendar, so a non-Gregorian default locale still names Gregorian months', () => {
    const saudi = createIntlDateLocale('ar-SA');
    assert.strictEqual(saudi.names.months.length, 12);
    assert.notStrictEqual(saudi.names.months[0], saudi.names.months[6]);
  });

  it('appears only by explicit construction: the default path never touches Intl', () => {
    // the counter is the proof, not a source grep: a Proxy over the
    // global records any property read, so an Intl object built anywhere
    // under `@jarenjs/locales/dates` would move it
    const probe = runNode(`
      let touched = 0;
      globalThis.Intl = new Proxy(Intl, { get(t, k) { touched += 1; return Reflect.get(t, k); } });
      const { compileDateLocale } = await import('@jarenjs/locales/dates');
      const locale = compileDateLocale();
      locale.relative(-3, 'day');
      locale.relative(-1, 'day', { numeric: 'auto' });
      locale.formatName('date-time');
      const afterDefault = touched;
      const { createIntlDateLocale } = await import('@jarenjs/locales/intl-dates');
      const importedOnly = touched;
      createIntlDateLocale('nl-NL').relative(-3, 'day');
      console.log(JSON.stringify({ afterDefault, importedOnly, afterIntl: touched }));
    `);
    const counts = JSON.parse(probe);
    assert.strictEqual(counts.afterDefault, 0, 'the default provider reached for Intl');
    assert.strictEqual(counts.importedOnly, 0, 'importing the Intl provider allocated at module load');
    assert.ok(counts.afterIntl > 0, 'the Intl provider did not use Intl');
  });
});

describe('@jarenjs/locales — server-rendered bytes do not move with the host', () => {
  // one page's worth of calendar language: names through a compiled
  // formatter, both relative directions, a named day and a format name
  const RENDER = `
    import { renderToString } from '@jarenjs/view';
    import { compileDateFormat, parseRFC3339Parts } from '@jarenjs/core/dates';
    import { compileDateLocale, nl, ru, ar, ja } from '@jarenjs/locales';
    import { compileMessageCatalog, validateField, buildFormModel } from '@jarenjs/forms';
    const at = parseRFC3339Parts('2026-07-05T14:30:05Z');
    const model = buildFormModel({ type: 'object',
      properties: { when: { type: 'string', format: 'date-time' } } });
    const rows = [];
    for (const [code, pack] of [['nl', nl], ['ru', ru], ['ar', ar], ['ja', ja]]) {
      const dates = compileDateLocale(pack);
      const long = compileDateFormat("EEEE d MMMM yyyy 'om' HH:mm a", dates.names);
      const short = compileDateFormat('EEE d MMM yy', dates.names);
      const error = validateField(model.children[0], 'nope', compileMessageCatalog(pack))[0];
      rows.push(['li', { class: 'row', lang: code }, [
        long(at), ' / ', short(at),
        ' / ', dates.relative(-3, 'day'), ' / ', dates.relative(21, 'month'),
        ' / ', dates.relative(-1, 'day', { numeric: 'auto' }),
        ' / ', error.message,
      ]]);
    }
    console.log(renderToString(['ul', {}, rows]));
  `;

  it('renders identical bytes under a different timezone and host locale', () => {
    const utc = runNode(RENDER, { TZ: 'UTC', LANG: 'C', LC_ALL: 'C' });
    const kiritimati = runNode(RENDER, {
      TZ: 'Pacific/Kiritimati', LANG: 'ru_RU.UTF-8', LC_ALL: 'ru_RU.UTF-8',
    });
    assert.strictEqual(utc, kiritimati);
    // and it really did render the calendar language, not an empty list
    assert.match(utc, /zondag 5 juli 2026/);
    assert.match(utc, /5 июля 2026/);
    assert.match(utc, /datum en tijd/);
    assert.match(utc, /الأحد/);
    assert.match(utc, /日曜日/);
  });
});
