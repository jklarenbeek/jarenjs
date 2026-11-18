//@ts-check

/**
 * Loss-aware reading and editing: `parseIcal(text, { mode: 'lossless' })`
 * keeps a syntax tree of octet spans beside the same model and report,
 * and `patchIcal` re-emits every octet no edit reaches unchanged.
 *
 * The proofs are made on the octets, never through the module's own
 * helpers: an untouched input comes back equal byte for byte (the
 * fixtures, and a seeded set of generated files folded at odd offsets,
 * inside UTF-8 sequences, with CRLF and bare LF mixed, X- content,
 * VALARMs and VTIMEZONEs); an edited one equals the input outside the
 * lines the edit owns, and the lines it writes are spelled out here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseIcal, patchIcal, createIcalReader, iterateIcal, IcalError } from '@jarenjs/josl/ical';
import { expandSeries } from '@jarenjs/core/calendar';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const provider = createIntlZoneProvider({ revision: 'lossless' });
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { ignoreBOM: true });
const LOSSLESS = /** @type {const} */ ({ mode: 'lossless', provider });
const AMS = 'Europe/Amsterdam';
const zoned = (/** @type {string} */ date, /** @type {string} */ time) => ({ kind: 'zoned', date, time, zone: AMS });

/** Every `.ics` file of the reader's fixture directories, as octets; bare VTIMEZONEs wrapped in a calendar. */
function corpus() {
  /** @type {[string, Uint8Array][]} */
  const out = [];
  for (const dir of ['ical', 'ical-vtimezone', 'ical-rfc']) {
    for (const name of fs.readdirSync(`${FIXTURES}${dir}`).filter((file) => file.endsWith('.ics')).sort()) {
      let bytes = new Uint8Array(fs.readFileSync(`${FIXTURES}${dir}/${name}`));
      if (dir === 'ical-vtimezone')
        bytes = enc.encode(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:p\r\n${dec.decode(bytes)}END:VCALENDAR\r\n`);
      if (name !== 'rfc7986-erratum-conference.ics')
        out.push([`${dir}/${name}`, bytes]);
    }
  }
  return out;
}

/**
 * The model and report of a read, the provider left out (a function each read makes anew).
 * @param {ReturnType<typeof parseIcal>} read
 */
const modelOf = (read) => ({ calendar: read.calendar, report: read.report, compiled: Object.keys(read.zones.compiled),
  undeclared: read.zones.undeclared });

/**
 * Whether two octet runs are equal.
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 */
const same = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);

/**
 * The physical lines of a text, each with its line break.
 * @param {string} text
 */
const physical = (text) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/**
 * The lines one text has and the other has not, in order, after the
 * common head and tail: `{ removed, added }`.
 * @param {string} before
 * @param {string} after
 */
function lineDiff(before, after) {
  const a = physical(before);
  const b = physical(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head])
    head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail])
    tail++;
  return { removed: a.slice(head, a.length - tail), added: b.slice(head, b.length - tail) };
}

//#region a seeded generator of real-world-shaped calendars

/** @param {number} seed */
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

const WORDS = ['Stand-up', 'Overleg', 'Kassa 3', 'Inventaris', 'Ronde', '会议', 'Café', 'Équipe', 'Sprint 👟', 'Brug, oost', 'A; B', 'x\\y'];
const VTIMEZONE = ['BEGIN:VTIMEZONE', `TZID:${AMS}`, `X-LIC-LOCATION:${AMS}`, 'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200',
  'TZNAME:CEST', 'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT', 'BEGIN:STANDARD',
  'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET', 'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD', 'END:VTIMEZONE'];

/**
 * TEXT escaping, written out here.
 * @param {string} text
 */
const escape = (text) => text.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');

/**
 * Serialize logical lines with random folds (at any octet, inside a
 * UTF-8 sequence too, when `octets`), random CRLF or bare LF ends,
 * empty lines now and then, and a byte order mark sometimes.
 * @param {string[]} lines
 * @param {() => number} rnd
 * @param {boolean} octets
 */
function serialize(lines, rnd, octets) {
  /** @type {number[]} */
  const out = rnd() < 0.2 ? [0xEF, 0xBB, 0xBF] : [];
  for (const [i, line] of lines.entries()) {
    const eol = rnd() < 0.15 ? [0x0A] : [0x0D, 0x0A];
    const bytes = [...enc.encode(line)];
    let at = 0;
    let first = true;
    while (at < bytes.length) {
      let size = 1 + Math.floor(rnd() * (first ? 75 : 74));
      if (!octets) {
        // a code point is never split in a text
        while (at + size < bytes.length && (bytes[at + size] & 0xC0) === 0x80)
          size++;
      }
      if (!first)
        out.push(...eol, rnd() < 0.5 ? 0x20 : 0x09);
      out.push(...bytes.slice(at, at + size));
      at += size;
      first = false;
    }
    out.push(...eol);
    if (i < lines.length - 1 && rnd() < 0.05)
      out.push(...eol);
  }
  return new Uint8Array(out);
}

/**
 * A calendar of three to eight events.
 * @param {number} seed
 * @param {boolean} octets
 */
function generate(seed, octets) {
  const rnd = random(seed);
  const pick = (/** @type {any[]} */ list) => list[Math.floor(rnd() * list.length)];
  /** @type {{ uid: string, series: boolean, zoned: boolean, summary: string, name: string, params: string }[]} */
  const events = [];
  const lines = ['BEGIN:VCALENDAR', ...(rnd() < 0.5 ? ['VERSION:2.0', `PRODID:-//Fuzz//${seed}//EN`] : [`PRODID:-//Fuzz//${seed}//EN`, 'VERSION:2.0'])];
  if (rnd() < 0.5)
    lines.push('CALSCALE:GREGORIAN');
  lines.push(`X-WR-CALNAME:${pick(WORDS)} 📅`, `x-org-flag;X-A="a:b;c,d";x-b=e:${pick(WORDS)}`);
  lines.push(...VTIMEZONE);
  const n = 3 + Math.floor(rnd() * 6);
  for (let i = 0; i < n; i++) {
    const uid = `fuzz-${seed}-${i}@example.com`;
    const series = rnd() < 0.5;
    const isZoned = series || rnd() < 0.3;
    const summary = `${pick(WORDS)} ${i}`;
    const name = rnd() < 0.2 ? 'summary' : 'SUMMARY';
    const params = rnd() < 0.3 ? ';LANGUAGE=nl' : '';
    events.push({ uid, series, zoned: isZoned, summary, name, params });
    lines.push('BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20260301T000000Z');
    if (isZoned)
      lines.push(`DTSTART;TZID=${AMS}:20260302T090000`, `DTEND;TZID=${AMS}:20260302T093000`);
    else if (rnd() < 0.5)
      lines.push('DTSTART:20260302T080000Z', 'DURATION:PT1H');
    else
      lines.push('DTSTART;VALUE=DATE:20260302');
    if (series)
      lines.push('RRULE:FREQ=WEEKLY;COUNT=8;BYDAY=MO', ...(rnd() < 0.5 ? [`EXDATE;TZID=${AMS}:20260309T090000`] : []));
    lines.push(`${name}${params}:${escape(summary)}`);
    if (rnd() < 0.6)
      lines.push(`DESCRIPTION:${Array.from({ length: 4 + Math.floor(rnd() * 12) }, () => pick(WORDS)).map(escape).join(' ')}`);
    if (rnd() < 0.5)
      lines.push(`ATTENDEE;CN="Ops, Team";ROLE=REQ-PARTICIPANT:mailto:ops-${i}@example.com`, `X-SERVER-ID;X-KIND="a,b":${seed}-${i}`);
    if (rnd() < 0.4)
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT10M', `DESCRIPTION:${pick(WORDS)}`, `X-WR-ALARMUID:${uid}-a`, 'END:VALARM');
    lines.push('END:VEVENT');
    if (series && rnd() < 0.5) {
      lines.push('BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20260301T000000Z', `RECURRENCE-ID;TZID=${AMS}:20260316T090000`,
        `DTSTART;TZID=${AMS}:20260317T100000`, `DTEND;TZID=${AMS}:20260317T103000`, `${name}${params}:${escape(summary)}`, 'END:VEVENT');
    }
  }
  lines.push('END:VCALENDAR');
  const bytes = serialize(lines, rnd, octets);
  return { bytes, events, rnd };
}

//#endregion

describe('lossless reading keeps the tree beside the same model', () => {
  it('reads every fixture to the same model and report as the canonical mode, and keeps no tree there', () => {
    const files = corpus();
    assert.ok(files.length >= 35, `${files.length} fixture files`);
    for (const [name, bytes] of files) {
      const canonical = parseIcal(bytes, { provider });
      const lossless = parseIcal(bytes, LOSSLESS);
      assert.deepStrictEqual(modelOf(lossless), modelOf(canonical), name);
      assert.strictEqual('tree' in canonical, false, name);
      assert.ok(lossless.tree !== undefined, name);
      assert.strictEqual(lossless.tree.calendar, lossless.calendar, name);
    }
  });

  it('spans every property and component over its own lines, folded spelling and line break included', () => {
    const text = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:p\r\n\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20260302T080000Z\r\n'
      + 'summary;LANGUAGE=nl:hel\r\n\tlo\nX-A;X-B="c:d":e\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR';
    const { tree } = /** @type {any} */ (parseIcal(text, { mode: 'lossless' }));
    const of = (/** @type {number} */ from, /** @type {number} */ to) => dec.decode(tree.source.subarray(from, to));
    assert.strictEqual(tree.form, 'text');
    const event = tree.root.children[0];
    assert.deepStrictEqual(event.props.map((/** @type {any} */ prop) => of(prop.from, prop.to)),
      ['UID:a\r\n', 'DTSTART:20260302T080000Z\r\n', 'summary;LANGUAGE=nl:hel\r\n\tlo\n', 'X-A;X-B="c:d":e\r\n']);
    assert.deepStrictEqual(event.props.map((/** @type {any} */ prop) => [prop.name, prop.value]),
      [['UID', 'a'], ['DTSTART', '20260302T080000Z'], ['SUMMARY', 'hello'], ['X-A', 'e']]);
    assert.strictEqual(of(event.from, event.head), 'BEGIN:VEVENT\r\n');
    assert.strictEqual(of(event.tail, event.to), 'END:VEVENT\r\n');
    assert.strictEqual(of(event.children[0].from, event.children[0].to), 'BEGIN:VALARM\r\nACTION:DISPLAY\r\nEND:VALARM\r\n');
    // the empty line belongs to no span; the last line has no line break
    assert.strictEqual(of(tree.root.props[1].to, event.from), '\r\n');
    assert.strictEqual(of(tree.root.tail, tree.root.to), 'END:VCALENDAR');
  });

  it('is parseIcal\'s alone: the streaming entries take only the canonical mode', async () => {
    assert.throws(() => createIcalReader(/** @type {any} */ ({ mode: 'lossless' })), TypeError);
    await assert.rejects(async () => {
      for await (const item of iterateIcal(['BEGIN:VCALENDAR\r\n'], /** @type {any} */ ({ mode: 'lossless' })))
        assert.fail(String(item));
    }, TypeError);
    assert.throws(() => parseIcal('', /** @type {any} */ ({ mode: 'loose' })), TypeError);
    assert.strictEqual(createIcalReader({ mode: 'canonical' }).feed('').length, 0);
  });
});

describe('patchIcal re-emits every untouched octet unchanged', () => {
  it('gives every fixture back byte for byte, as octets and as text', () => {
    for (const [name, bytes] of corpus()) {
      const out = patchIcal(/** @type {any} */ (parseIcal(bytes, LOSSLESS).tree), []);
      assert.ok(out instanceof Uint8Array && same(out, bytes), name);
      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      }
      catch {
        continue; // folded inside a UTF-8 sequence: octets only
      }
      assert.strictEqual(patchIcal(/** @type {any} */ (parseIcal(text, LOSSLESS).tree)), text, name);
    }
  });

  it('gives back 120 generated calendars byte for byte, and each edit changes only its own lines', () => {
    let edits = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const octets = seed % 2 === 0;
      const { bytes, events, rnd } = generate(seed, octets);
      const input = octets ? bytes : dec.decode(bytes);
      const read = /** @type {any} */ (parseIcal(input, LOSSLESS));
      const untouched = patchIcal(read.tree, []);
      assert.ok(octets ? same(/** @type {Uint8Array} */ (untouched), bytes) : untouched === input, `seed ${seed}`);
      // a retitle replaces exactly the SUMMARY line, its name and parameters as written
      const event = events[Math.floor(rnd() * events.length)];
      const node = read.tree.root.children.find((/** @type {any} */ child) => child.name === 'VEVENT'
        && child.props.some((/** @type {any} */ prop) => prop.name === 'UID' && prop.value === event.uid)
        && !child.props.some((/** @type {any} */ prop) => prop.name === 'RECURRENCE-ID'));
      const summary = node.props.find((/** @type {any} */ prop) => prop.name === 'SUMMARY');
      const eol = read.tree.source[summary.to - 2] === 0x0D ? '\r\n' : '\n';
      const title = `Nieuw, ${seed}`;
      const patched = patchIcal(read.tree, [{ op: 'retitle', uid: event.uid, summary: title }]);
      const out = typeof patched === 'string' ? enc.encode(patched) : patched;
      const line = enc.encode(`${event.name}${event.params}:Nieuw\\, ${seed}${eol}`);
      const source = read.tree.source;
      assert.ok(same(out.subarray(0, summary.from), source.subarray(0, summary.from)), `seed ${seed}: the octets before`);
      assert.ok(same(out.subarray(summary.from, summary.from + line.length), line), `seed ${seed}: the new line`);
      assert.ok(same(out.subarray(summary.from + line.length), source.subarray(summary.to)), `seed ${seed}: the octets after`);
      const back = parseIcal(patched, { provider });
      const component = back.calendar.components.find((c) => (c.series?.uid ?? c.uid) === event.uid);
      assert.strictEqual(component?.summary, title, `seed ${seed}`);
      edits++;
      if (!event.series)
        continue;
      // an EXDATE is one line inserted, and nothing else moves
      const slot = '2026-03-23T09:00:00';
      const excluded = patchIcal(read.tree, [{ op: 'exdate', uid: event.uid, recurrenceId: slot }]);
      const outEx = typeof excluded === 'string' ? enc.encode(excluded) : excluded;
      const inserted = outEx.length - source.length;
      let at = 0;
      while (at < source.length && outEx[at] === source[at])
        at++;
      // the inserted line starts at a line start of the input
      while (at > 0 && source[at - 1] !== 0x0A)
        at--;
      assert.ok(same(outEx.subarray(at + inserted), source.subarray(at)), `seed ${seed}: the octets after the EXDATE`);
      assert.match(dec.decode(outEx.subarray(at, at + inserted)), /^EXDATE;TZID=Europe\/Amsterdam:20260323T090000\r?\n$/);
      const series = parseIcal(excluded, { provider }).calendar.components.find((c) => c.series?.uid === event.uid)?.series;
      assert.ok(series.exdates.some((/** @type {any} */ value) => value.date === '2026-03-23'), `seed ${seed}`);
      edits++;
    }
    assert.ok(edits > 150, `${edits} edits`);
  });

  it('copies the octets of a line folded inside a UTF-8 sequence into a new override unchanged', () => {
    const bytes = new Uint8Array(fs.readFileSync(`${FIXTURES}ical/exporter-webcal.ics`));
    const { tree } = /** @type {any} */ (parseIcal(bytes, LOSSLESS));
    const out = /** @type {Uint8Array} */ (patchIcal(tree, [{ op: 'move', uid: 'standup-7f3a@example.com',
      recurrenceId: '2026-03-30T09:00:00', start: zoned('2026-03-31', '10:00'), end: zoned('2026-03-31', '10:15') }]));
    const master = tree.root.children.find((/** @type {any} */ node) => node.name === 'VEVENT');
    const description = master.props.find((/** @type {any} */ prop) => prop.name === 'DESCRIPTION');
    const span = bytes.subarray(description.from, description.to);
    let count = 0;
    for (let i = 0; i + span.length <= out.length; i++) {
      if (same(out.subarray(i, i + span.length), span))
        count++;
    }
    assert.strictEqual(count, 2, 'the series\' DESCRIPTION octets, and their copy in the new override');
  });
});

describe('each edit changes only the lines it owns', () => {
  const text = fs.readFileSync(`${FIXTURES}ical/exporter-webcal.ics`, 'utf8');
  const read = /** @type {any} */ (parseIcal(text, LOSSLESS));
  const S = 'standup-7f3a@example.com';
  /**
   * Patch the fixture, and read the result back.
   * @param {any[]} edits
   */
  const patch = (edits) => {
    const out = /** @type {string} */ (patchIcal(read.tree, edits));
    const back = parseIcal(out, { provider });
    return { diff: lineDiff(text, out), back, series: back.calendar.components.find((c) => c.series?.uid === S)?.series };
  };

  it('retitle replaces the SUMMARY line; describe and relocate add or remove one line', () => {
    let result = patch([{ op: 'retitle', uid: S, summary: 'Stand-up, room 2' }]);
    assert.deepStrictEqual(result.diff, { removed: ['SUMMARY:Stand-up\r\n'], added: ['SUMMARY:Stand-up\\, room 2\r\n'] });
    assert.strictEqual(result.back.calendar.components.find((c) => c.series?.uid === S)?.summary, 'Stand-up, room 2');
    result = patch([{ op: 'describe', uid: S, recurrenceId: '2026-03-16T09:00:00', description: 'Moved; see mail' }]);
    assert.deepStrictEqual(result.diff, { removed: [], added: ['DESCRIPTION:Moved\\; see mail\r\n'] });
    result = patch([{ op: 'relocate', uid: 'holiday-kingsday@example.com', location: 'Dam' }]);
    assert.deepStrictEqual(result.diff, { removed: [], added: ['LOCATION:Dam\r\n'] });
    assert.strictEqual(result.back.calendar.components.find((c) => c.uid === 'holiday-kingsday@example.com')?.location, 'Dam');
    result = patch([{ op: 'describe', uid: S, recurrenceId: '2026-03-16T09:00:00', description: null }]);
    assert.deepStrictEqual(result.diff, { removed: [], added: [] }, 'no DESCRIPTION to remove');
    result = patch([{ op: 'retitle', uid: S, recurrenceId: '2026-03-23T09:00:00', summary: null }]);
    assert.deepStrictEqual(result.diff, { removed: ['SUMMARY:Stand-up\r\n'], added: [] });
  });

  it('a long new text is folded at 75 octets with the line break of the line it replaces', () => {
    const lf = text.replaceAll('\r\n', '\n');
    const title = 'Stand-up 👋 '.repeat(8);
    const out = /** @type {string} */ (patchIcal(/** @type {any} */ (parseIcal(lf, LOSSLESS).tree), [{ op: 'retitle', uid: S, summary: title }]));
    const { removed, added } = lineDiff(lf, out);
    assert.deepStrictEqual(removed, ['SUMMARY:Stand-up\n']);
    assert.ok(added.length > 1 && added.every((line) => line.endsWith('\n') && !line.endsWith('\r\n') && enc.encode(line).length <= 76));
    assert.ok(added.slice(1).every((line) => line.startsWith(' ')));
    assert.strictEqual(parseIcal(out, { provider }).calendar.components.find((c) => c.series?.uid === S)?.summary, title);
  });

  it('cancel writes an EXDATE for a slot with no VEVENT of its own, and STATUS:CANCELLED on one that has', () => {
    let result = patch([{ op: 'cancel', uid: S, recurrenceId: '2026-03-09T09:00:00' }]);
    assert.deepStrictEqual(result.diff, { removed: [], added: ['EXDATE;TZID=Europe/Amsterdam:20260309T090000\r\n'] });
    assert.deepStrictEqual(result.series.exdates.map((/** @type {any} */ value) => value.date), ['2026-04-06', '2026-03-09']);
    result = patch([{ op: 'cancel', uid: S, recurrenceId: '2026-03-16T09:00:00' }]);
    assert.deepStrictEqual(result.diff, { removed: ['STATUS:CONFIRMED\r\n'], added: ['STATUS:CANCELLED\r\n'] });
    assert.deepStrictEqual(result.series.overrides.find((/** @type {any} */ o) => o.recurrenceId === '2026-03-16T09:00:00'),
      { recurrenceId: '2026-03-16T09:00:00', status: 'cancelled' });
    // already cancelled or excluded: nothing to write
    assert.deepStrictEqual(patch([{ op: 'cancel', uid: S, recurrenceId: '2026-03-23T09:00:00' }]).diff, { removed: [], added: [] });
    assert.deepStrictEqual(patch([{ op: 'cancel', uid: S, recurrenceId: '2026-04-06T09:00:00' }]).diff, { removed: [], added: [] });
    // the whole event
    result = patch([{ op: 'cancel', uid: 'holiday-kingsday@example.com' }]);
    assert.deepStrictEqual(result.diff, { removed: [], added: ['STATUS:CANCELLED\r\n'] });
    assert.strictEqual(result.back.calendar.components.find((c) => c.uid === 'holiday-kingsday@example.com')?.status, 'cancelled');
  });

  it('exdate adds one EXDATE after the last one', () => {
    const result = patch([{ op: 'exdate', uid: S, recurrenceId: '2026-03-30T09:00:00' }]);
    assert.deepStrictEqual(result.diff, { removed: [], added: ['EXDATE;TZID=Europe/Amsterdam:20260330T090000\r\n'] });
    const lines = physical(/** @type {string} */ (patchIcal(read.tree, [{ op: 'exdate', uid: S, recurrenceId: '2026-03-30T09:00:00' }])));
    const first = lines.indexOf('EXDATE;TZID=Europe/Amsterdam:20260406T090000\r\n');
    assert.strictEqual(lines[first + 1], 'EXDATE;TZID=Europe/Amsterdam:20260330T090000\r\n');
  });

  it('move edits an occurrence\'s own VEVENT in place, or adds one copied from the series', () => {
    let result = patch([{ op: 'move', uid: S, recurrenceId: '2026-03-16T09:00:00', start: zoned('2026-03-18', '10:00'),
      end: zoned('2026-03-18', '10:20') }]);
    assert.deepStrictEqual(result.diff, {
      removed: ['DTSTART;TZID=Europe/Amsterdam:20260317T100000\r\n', 'DTEND;TZID=Europe/Amsterdam:20260317T101500\r\n'],
      added: ['DTSTART;TZID=Europe/Amsterdam:20260318T100000\r\n', 'DTEND;TZID=Europe/Amsterdam:20260318T102000\r\n'] });
    result = patch([{ op: 'move', uid: S, recurrenceId: '2026-03-30T09:00:00', start: zoned('2026-03-31', '10:00'),
      end: zoned('2026-03-31', '10:15'), dtstamp: Date.parse('2026-03-20T12:00:00Z') }]);
    assert.strictEqual(result.diff.removed.length, 0);
    const added = result.diff.added.join('');
    const master = text.slice(text.indexOf('BEGIN:VEVENT\r\nDTSTART;TZID=Europe/Amsterdam:20260302'), text.indexOf('END:VEVENT\r\n') + 12);
    const expected = master
      .replace('DTSTART;TZID=Europe/Amsterdam:20260302T090000\r\n', 'RECURRENCE-ID;TZID=Europe/Amsterdam:20260330T090000\r\nDTSTART;TZID=Europe/Amsterdam:20260331T100000\r\n')
      .replace('DTEND;TZID=Europe/Amsterdam:20260302T091500\r\n', 'DTEND;TZID=Europe/Amsterdam:20260331T101500\r\n')
      .replace(/RRULE:[^\r]*\r\n/, '').replace(/EXDATE;[^\r]*\r\n/, '')
      .replace('DTSTAMP:20260301T080000Z', 'DTSTAMP:20260320T120000Z');
    // the new VEVENT follows the last VEVENT of its UID; the diff may align on a shared BEGIN line
    assert.ok(added === expected || added === `${expected.slice('BEGIN:VEVENT\r\n'.length)}BEGIN:VEVENT\r\n`, added);
    assert.deepStrictEqual(result.series.overrides.find((/** @type {any} */ o) => o.recurrenceId === '2026-03-30T09:00:00'),
      { recurrenceId: '2026-03-30T09:00:00', status: 'moved', start: zoned('2026-03-31', '10:00:00'), end: zoned('2026-03-31', '10:15:00') });
    assert.strictEqual(result.back.report.counts.ICAL1016, 3, 'the new DTSTAMP is reported against the series\', as any override\'s');
  });

  it('remove takes exactly the lines of the event, or of one occurrence\'s own VEVENT', () => {
    let result = patch([{ op: 'remove', uid: 'holiday-kingsday@example.com' }]);
    assert.strictEqual(result.diff.added.length, 0);
    assert.deepStrictEqual(result.diff.removed.map((line) => line.split(/[:;]/)[0]),
      ['BEGIN', 'DTSTART', 'DTEND', 'DTSTAMP', 'UID', 'SUMMARY', 'TRANSP', 'END']);
    assert.strictEqual(result.back.calendar.components.length, 1);
    result = patch([{ op: 'remove', uid: S, recurrenceId: '2026-03-23T09:00:00' }]);
    assert.strictEqual(result.diff.removed.length, 10);
    assert.deepStrictEqual(result.series.overrides.map((/** @type {any} */ o) => o.recurrenceId), ['2026-03-16T09:00:00']);
    result = patch([{ op: 'remove', uid: S }]);
    assert.strictEqual(result.back.calendar.components.length, 1);
    assert.strictEqual(parseIcal(text, { provider }).report.counts.ICAL1013, 1, 'the series\' VALARM');
    assert.strictEqual(result.back.report.counts.ICAL1013, undefined, 'gone with its event');
  });

  it('a replaced line keeps its name and parameters as written; only its value changes', () => {
    const spelled = text.replace('STATUS:CONFIRMED\r\nSUMMARY:Stand-up\r\nTRANSP:OPAQUE\r\nEND:VEVENT', 'status;X-SRC="a:b":CONFIRMED\r\nSUMMARY:Stand-up\r\nTRANSP:OPAQUE\r\nEND:VEVENT')
      .replace('DTSTART;TZID=Europe/Amsterdam:20260317T100000', 'DTSTART;X-ORIG=1;TZID=Europe/Amsterdam:20260317T100000');
    const { tree: own } = /** @type {any} */ (parseIcal(spelled, LOSSLESS));
    let out = /** @type {string} */ (patchIcal(own, [{ op: 'cancel', uid: S, recurrenceId: '2026-03-16T09:00:00' }]));
    assert.deepStrictEqual(lineDiff(spelled, out), { removed: ['status;X-SRC="a:b":CONFIRMED\r\n'], added: ['status;X-SRC="a:b":CANCELLED\r\n'] });
    out = /** @type {string} */ (patchIcal(own, [{ op: 'move', uid: S, recurrenceId: '2026-03-16T09:00:00', start: zoned('2026-03-18', '10:00'),
      duration: 'PT15M', dtstamp: Date.parse('2026-03-02T00:00:00Z') }]));
    assert.deepStrictEqual(lineDiff(spelled, out), {
      removed: ['DTSTART;X-ORIG=1;TZID=Europe/Amsterdam:20260317T100000\r\n', 'DTEND;TZID=Europe/Amsterdam:20260317T101500\r\n',
        'DTSTAMP:20260301T080000Z\r\n'],
      added: ['DTSTART;X-ORIG=1;TZID=Europe/Amsterdam:20260318T100000\r\n', 'DURATION:PT15M\r\n', 'DTSTAMP:20260302T000000Z\r\n'] });
  });

  it('spells a new time with the series\' own TZID, quoted where the grammar needs it', () => {
    const tzid = '/example.org/zones:Europe/Amsterdam';
    const quoted = text.replaceAll('TZID:Europe/Amsterdam', `TZID:${tzid}`).replaceAll('TZID=Europe/Amsterdam', `TZID="${tzid}"`);
    const out = /** @type {string} */ (patchIcal(/** @type {any} */ (parseIcal(quoted, LOSSLESS).tree), [{ op: 'exdate', uid: S, recurrenceId: '2026-03-30T09:00:00' }]));
    assert.deepStrictEqual(lineDiff(quoted, out), { removed: [], added: [`EXDATE;TZID="${tzid}":20260330T090000\r\n`] });
    assert.strictEqual(parseIcal(out, { provider }).calendar.components.find((c) => c.series?.uid === S)?.series.exdates.length, 2);
  });

  it('applies several edits in one pass, and the output can be read and patched again', () => {
    const once = /** @type {string} */ (patchIcal(read.tree, [
      { op: 'retitle', uid: S, summary: 'Daily' },
      { op: 'exdate', uid: S, recurrenceId: '2026-03-09T09:00:00' },
      { op: 'relocate', uid: 'holiday-kingsday@example.com', location: 'Dam' },
    ]));
    const { removed, added } = lineDiff(text, once);
    assert.strictEqual(removed.length + added.length > 0, true);
    const twice = /** @type {string} */ (patchIcal(/** @type {any} */ (parseIcal(once, LOSSLESS).tree), [{ op: 'cancel', uid: S, recurrenceId: '2026-03-30T09:00:00' }]));
    const series = parseIcal(twice, { provider }).calendar.components.find((c) => c.series?.uid === S);
    assert.strictEqual(series?.summary, 'Daily');
    assert.deepStrictEqual(series?.series.exdates.map((/** @type {any} */ v) => v.date), ['2026-04-06', '2026-03-09', '2026-03-30']);
    assert.deepStrictEqual(lineDiff(once, twice), { removed: [], added: ['EXDATE;TZID=Europe/Amsterdam:20260330T090000\r\n'] });
  });
});

describe('RANGE=THISANDFUTURE is read into its series and edited around', () => {
  const text = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:p', 'BEGIN:VEVENT', 'UID:r', 'DTSTAMP:20260101T000000Z',
    'DTSTART:20260302T090000', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY;COUNT=6', 'SUMMARY:Ronde', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:r', 'DTSTAMP:20260101T000000Z', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20260323T090000',
    'DTSTART:20260323T100000', 'DURATION:PT30M', 'SUMMARY:Ronde', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
  const { tree } = /** @type {any} */ (parseIcal(text, LOSSLESS));
  const horizon = [{ kind: 'floating', date: '2026-03-01', time: '00:00' }, { kind: 'floating', date: '2026-06-01', time: '00:00' }];
  /** `id start-end` of each occurrence the text's series makes. @param {string} out */
  const rows = (out) => expandSeries(/** @type {any} */ (parseIcal(out).calendar.components[0]).series, { horizon: /** @type {any} */ (horizon) })
    .occurrences.map((o) => `${o.recurrenceId.slice(5, 10)} ${/** @type {any} */ (o.start).date.slice(5)} ${/** @type {any} */ (o.start).time.slice(0, 5)}-${/** @type {any} */ (o.end).time.slice(0, 5)}`);
  const before = ['03-02 03-02 09:00-10:00', '03-09 03-09 09:00-10:00', '03-16 03-16 09:00-10:00', '03-23 03-23 10:00-10:30',
    '03-30 03-30 10:00-10:30', '04-06 04-06 10:00-10:30'];

  it('re-emits the override as written; the series it reads expands it', () => {
    assert.strictEqual(patchIcal(tree), text);
    assert.deepStrictEqual(rows(text), before);
    const out = /** @type {string} */ (patchIcal(tree, [{ op: 'retitle', uid: 'r', summary: 'Ronde 2' },
      { op: 'cancel', uid: 'r', recurrenceId: '2026-03-09T09:00:00' }]));
    assert.ok(out.includes('RECURRENCE-ID;RANGE=THISANDFUTURE:20260323T090000\r\n'));
    assert.deepStrictEqual(lineDiff(text, out), { removed: ['SUMMARY:Ronde\r\n'], added: ['SUMMARY:Ronde 2\r\n', 'EXDATE:20260309T090000\r\n'] });
    assert.deepStrictEqual(rows(out), before.filter((row) => !row.startsWith('03-09')));
  });

  it('edits a later occurrence as any other: cancelled, excluded, or moved with the range\'s length', () => {
    const later = '2026-03-30T09:00:00';
    for (const op of /** @type {const} */ (['cancel', 'exdate'])) {
      const out = /** @type {string} */ (patchIcal(tree, [{ op, uid: 'r', recurrenceId: later }]));
      assert.deepStrictEqual(lineDiff(text, out), { removed: [], added: ['EXDATE:20260330T090000\r\n'] }, op);
      assert.deepStrictEqual(rows(out), before.filter((row) => !row.startsWith('03-30')), op);
    }
    // a new VEVENT copied from the series would carry its DURATION:PT1H; it ends by the range's 30 minutes instead
    const moved = /** @type {string} */ (patchIcal(tree, [{ op: 'move', uid: 'r', recurrenceId: later, start: { kind: 'floating', date: '2026-04-01', time: '08:00' } }]));
    assert.ok(moved.includes('RECURRENCE-ID:20260330T090000\r\nDTSTART:20260401T080000\r\nDTEND:20260401T083000\r\n'));
    assert.deepStrictEqual(rows(moved), before.map((row) => (row.startsWith('03-30') ? '03-30 04-01 08:00-08:30' : row)));
    // given a duration, it keeps that
    const given = /** @type {string} */ (patchIcal(tree, [{ op: 'move', uid: 'r', recurrenceId: later, start: { kind: 'floating', date: '2026-04-01', time: '08:00' }, duration: 'PT1H' }]));
    assert.deepStrictEqual(rows(given), before.map((row) => (row.startsWith('03-30') ? '03-30 04-01 08:00-09:00' : row)));
  });

  it('moves the range\'s own slot: a new DTSTART of the range, and so a new shift of every later slot', () => {
    const id = '2026-03-23T09:00:00';
    const out = /** @type {string} */ (patchIcal(tree, [{ op: 'move', uid: 'r', recurrenceId: id, start: { kind: 'floating', date: '2026-03-24', time: '08:00' } }]));
    assert.deepStrictEqual(lineDiff(text, out), { removed: ['DTSTART:20260323T100000\r\n'], added: ['DTSTART:20260324T080000\r\n'] });
    // the edited intent: 03-23 and every later slot a day less an hour after their own
    assert.deepStrictEqual(rows(out), [...before.slice(0, 3), '03-23 03-24 08:00-08:30', '03-30 03-31 08:00-08:30', '04-06 04-07 08:00-08:30']);
  });

  it('cancels or excludes the range\'s own slot only: an EXDATE of it beside the range, which still applies to every later slot', () => {
    const id = '2026-03-23T09:00:00';
    for (const op of /** @type {const} */ (['cancel', 'exdate'])) {
      const out = /** @type {string} */ (patchIcal(tree, [{ op, uid: 'r', recurrenceId: id }]));
      // RFC 5545 §3.8.5.1: the EXDATE removes the one instance; the RANGE=THISANDFUTURE VEVENT stays as written
      assert.deepStrictEqual(lineDiff(text, out), { removed: [], added: ['EXDATE:20260323T090000\r\n'] }, op);
      assert.ok(out.includes('RECURRENCE-ID;RANGE=THISANDFUTURE:20260323T090000\r\nDTSTART:20260323T100000\r\n'), op);
      // the edited intent: the expansion before, less 03-23
      assert.deepStrictEqual(rows(out), before.filter((row) => !row.startsWith('03-23')), op);
      // once excluded, a second exclusion changes nothing
      const again = /** @type {string} */ (patchIcal(/** @type {any} */ (parseIcal(out, LOSSLESS)).tree, [{ op, uid: 'r', recurrenceId: id }]));
      assert.strictEqual(again, out, op);
    }
  });

  it('excludes a range\'s own slot the same way when it is the last, before another range, or before a slot with its own VEVENT', () => {
    const exdated = (/** @type {string} */ source, /** @type {'cancel' | 'exdate'} */ op) => {
      const out = /** @type {string} */ (patchIcal(/** @type {any} */ (parseIcal(source, LOSSLESS)).tree, [{ op, uid: 'r', recurrenceId: '2026-03-23T09:00:00' }]));
      assert.deepStrictEqual(lineDiff(source, out), { removed: [], added: ['EXDATE:20260323T090000\r\n'] });
      return out;
    };
    const last = text.replace('RRULE:FREQ=WEEKLY;COUNT=6', 'RRULE:FREQ=WEEKLY;COUNT=4');
    assert.deepStrictEqual(rows(exdated(last, 'cancel')), before.slice(0, 3));
    const two = text.replace('END:VCALENDAR', ['BEGIN:VEVENT', 'UID:r', 'DTSTAMP:20260101T000000Z', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20260330T090000',
      'DTSTART:20260330T120000', 'DURATION:PT1H', 'SUMMARY:Ronde', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'));
    assert.deepStrictEqual(rows(exdated(two, 'exdate')), [...before.slice(0, 3), '03-30 03-30 12:00-13:00', '04-06 04-06 12:00-13:00']);
    const next = text.replace('END:VCALENDAR', ['BEGIN:VEVENT', 'UID:r', 'DTSTAMP:20260101T000000Z', 'RECURRENCE-ID:20260330T090000',
      'DTSTART:20260330T140000', 'DURATION:PT30M', 'SUMMARY:Ronde', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'));
    assert.deepStrictEqual(rows(exdated(next, 'cancel')), [...before.slice(0, 3), '03-30 03-30 14:00-14:30', '04-06 04-06 10:00-10:30']);
    const ended = text.replace('DTSTART:20260323T100000\r\nDURATION:PT30M', 'DTSTART:20260323T100000\r\nDTEND:20260323T103000');
    assert.deepStrictEqual(rows(exdated(ended, 'cancel')), before.filter((row) => !row.startsWith('03-23')));
    const hourly = text.replace('RRULE:FREQ=WEEKLY;COUNT=6', 'RRULE:FREQ=HOURLY;COUNT=40').replace('DTSTART:20260302T090000', 'DTSTART:20260323T000000');
    const sub = rows(exdated(hourly, 'cancel'));
    assert.deepStrictEqual([sub.length, sub.slice(8, 10)], [39, ['03-23 03-23 08:00-09:00', '03-23 03-23 11:00-11:30']]);
  });

  it('excludes a zoned range\'s own slot by an EXDATE in its zone, the later slots still moved by its wall-clock shift', () => {
    const zonedText = text.replaceAll('DTSTART:2026', 'DTSTART;TZID=Europe/Amsterdam:2026').replace('RECURRENCE-ID;RANGE=THISANDFUTURE:', 'RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe/Amsterdam:');
    const instants = (/** @type {string} */ out) => expandSeries(/** @type {any} */ (parseIcal(out, { provider }).calendar.components[0]).series,
      { horizon: [Date.UTC(2026, 2, 1), Date.UTC(2026, 5, 1)], provider }).occurrences.map((o) => `${o.recurrenceId} ${new Date(/** @type {any} */ (o.instants).start).toISOString()}`);
    const out = /** @type {string} */ (patchIcal(/** @type {any} */ (parseIcal(zonedText, LOSSLESS)).tree, [{ op: 'exdate', uid: 'r', recurrenceId: '2026-03-23T09:00:00' }]));
    assert.deepStrictEqual(lineDiff(zonedText, out), { removed: [], added: ['EXDATE;TZID=Europe/Amsterdam:20260323T090000\r\n'] });
    // the edited intent: 03-30 and 04-06 still start at 10:00 Amsterdam, now summer time (08:00Z)
    assert.deepStrictEqual(instants(out), instants(zonedText).filter((row) => !row.startsWith('2026-03-23')));
    assert.ok(instants(out).includes('2026-03-30T09:00:00 2026-03-30T08:00:00.000Z'));
  });

  it('refuses to exclude the slot of a range the series never makes (ICAL4004): it is an orphan, applied nowhere', () => {
    const orphan = text.replace('RECURRENCE-ID;RANGE=THISANDFUTURE:20260323T090000', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20260324T090000')
      .replace('DTSTART:20260323T100000', 'DTSTART:20260324T100000');
    for (const op of /** @type {const} */ (['cancel', 'exdate'])) {
      assert.throws(() => patchIcal(/** @type {any} */ (parseIcal(orphan, LOSSLESS)).tree, [{ op, uid: 'r', recurrenceId: '2026-03-24T09:00:00' }]),
        { code: 'ICAL4004', docPath: '/edits/0/recurrenceId' }, op);
    }
  });

  it('edits the range\'s own text, or removes it, as written', () => {
    const id = '2026-03-23T09:00:00';
    assert.ok(/** @type {string} */ (patchIcal(tree, [{ op: 'retitle', uid: 'r', recurrenceId: id, summary: 'Later' }]))
      .includes('RANGE=THISANDFUTURE'));
    const removed = /** @type {string} */ (patchIcal(tree, [{ op: 'remove', uid: 'r', recurrenceId: id }]));
    assert.ok(!removed.includes('RANGE'));
    assert.deepStrictEqual(rows(removed).slice(3), ['03-23 03-23 09:00-10:00', '03-30 03-30 09:00-10:00', '04-06 04-06 09:00-10:00']);
  });
});

describe('an edit the tree cannot hold is refused with its code', () => {
  const text = fs.readFileSync(`${FIXTURES}ical/exporter-webcal.ics`, 'utf8');
  const { tree } = /** @type {any} */ (parseIcal(text, LOSSLESS));
  const S = 'standup-7f3a@example.com';
  const refuses = (/** @type {any} */ edits, /** @type {string} */ code, /** @type {string} */ docPath, /** @type {any} */ on = tree) =>
    assert.throws(() => patchIcal(on, edits), (/** @type {any} */ error) => {
      assert.ok(error instanceof IcalError);
      assert.strictEqual(error.code, code, error.message);
      assert.strictEqual(error.docPath, docPath, error.message);
      return true;
    });

  it('ICAL4011: a tree parseIcal did not return; ICAL4001: an edit outside the documented ones', () => {
    refuses([], 'ICAL4011', '', { ...tree });
    refuses([], 'ICAL4011', '', parseIcal(text));
    refuses('x', 'ICAL4001', '/edits');
    refuses([null], 'ICAL4001', '/edits/0');
    refuses([{ op: 'rename', uid: S }], 'ICAL4001', '/edits/0/op');
    refuses([{ op: 'retitle', uid: S, summary: 'x', colour: 'red' }], 'ICAL4001', '/edits/0/colour');
    refuses([{ op: 'retitle', uid: '', summary: 'x' }], 'ICAL4001', '/edits/0/uid');
    refuses([{ op: 'retitle', uid: S, summary: 5 }], 'ICAL4001', '/edits/0/summary');
    refuses([{ op: 'exdate', uid: S }], 'ICAL4001', '/edits/0/recurrenceId');
    refuses([{ op: 'cancel', uid: S, recurrenceId: 5 }], 'ICAL4001', '/edits/0/recurrenceId');
    refuses([{ op: 'move', uid: S, recurrenceId: '2026-03-09T09:00:00' }], 'ICAL4001', '/edits/0/start');
    refuses([{ op: 'move', uid: S, recurrenceId: '2026-03-09T09:00:00', start: { kind: 'zoned' } }], 'ICAL4001', '/edits/0/start');
    refuses([{ op: 'move', uid: S, recurrenceId: '2026-03-09T09:00:00', start: zoned('2026-03-10', '09:00'), duration: 'PT1H',
      dtstamp: { kind: 'date', date: '2026-03-01' } }], 'ICAL4001', '/edits/0/dtstamp');
  });

  it('ICAL4002/4003: no VEVENT, or more than one, holds what an edit names', () => {
    refuses([{ op: 'retitle', uid: 'nobody', summary: 'x' }], 'ICAL4002', '/edits/0/uid');
    refuses([{ op: 'retitle', uid: S, recurrenceId: '2026-03-09T09:00:00', summary: 'x' }], 'ICAL4002', '/edits/0/recurrenceId');
    refuses([{ op: 'remove', uid: S, recurrenceId: '2026-03-09T09:00:00' }], 'ICAL4002', '/edits/0/recurrenceId');
    const twice = parseIcal(text.replace('UID:holiday-kingsday@example.com', `UID:${S}`), LOSSLESS).tree;
    refuses([{ op: 'retitle', uid: S, summary: 'x' }], 'ICAL4003', '/edits/0', twice);
  });

  it('ICAL4004: not recurring, a slot the series never makes, or a cancelled one moved', () => {
    refuses([{ op: 'cancel', uid: 'holiday-kingsday@example.com', recurrenceId: '2026-04-27' }], 'ICAL4004', '/edits/0/recurrenceId');
    refuses([{ op: 'exdate', uid: S, recurrenceId: '2026-03-10T09:00:00' }], 'ICAL4004', '/edits/0/recurrenceId');
    refuses([{ op: 'exdate', uid: S, recurrenceId: '2026-03-09' }], 'ICAL4004', '/edits/0/recurrenceId');
    refuses([{ op: 'cancel', uid: S, recurrenceId: '2026-05-04T09:00:00' }], 'ICAL4004', '/edits/0/recurrenceId');
    refuses([{ op: 'move', uid: S, recurrenceId: '2026-03-23T09:00:00', start: zoned('2026-03-24', '09:00'), duration: 'PT15M' }],
      'ICAL4004', '/edits/0/recurrenceId');
    refuses([{ op: 'move', uid: S, recurrenceId: '2026-04-06T09:00:00', start: zoned('2026-04-07', '09:00'), end: zoned('2026-04-07', '09:15') }],
      'ICAL4004', '/edits/0/recurrenceId');
  });

  it('ICAL4006: an event the read withheld has no occurrences to check, and its text still edits', () => {
    const withheld = parseIcal(text, { mode: 'lossless', vtimezone: 'provider' });
    assert.strictEqual(withheld.calendar.components.length, 1, 'no provider for its TZID: the zoned series is withheld');
    refuses([{ op: 'cancel', uid: S, recurrenceId: '2026-03-09T09:00:00' }], 'ICAL4006', '/edits/0', withheld.tree);
    const out = /** @type {string} */ (patchIcal(/** @type {any} */ (withheld.tree), [{ op: 'retitle', uid: S, summary: 'Kept' }]));
    assert.deepStrictEqual(lineDiff(text, out), { removed: ['SUMMARY:Stand-up\r\n'], added: ['SUMMARY:Kept\r\n'] });
  });

  it('ICAL4006: an occurrence\'s own VEVENT the read withheld, while its series was read', () => {
    const extra = 'BEGIN:VEVENT\r\nUID:standup-7f3a@example.com\r\nDTSTAMP:20260301T000000Z\r\n'
      + 'RECURRENCE-ID;TZID=Europe/Amsterdam:20260330T090000\r\nSUMMARY:No start\r\nEND:VEVENT\r\n';
    const withheld = parseIcal(text.replace('END:VCALENDAR', `${extra}END:VCALENDAR`), LOSSLESS);
    const series = withheld.calendar.components.find((c) => c.series?.uid === S)?.series;
    assert.ok(series !== undefined && !series.overrides.some((/** @type {any} */ o) => o.recurrenceId === '2026-03-30T09:00:00'));
    refuses([{ op: 'cancel', uid: S, recurrenceId: '2026-03-30T09:00:00' }], 'ICAL4006', '/edits/0', withheld.tree);
    refuses([{ op: 'move', uid: S, recurrenceId: '2026-03-30T09:00:00', start: zoned('2026-03-31', '10:00'), duration: 'PT15M' }],
      'ICAL4006', '/edits/0', withheld.tree);
    assert.ok(patchIcal(/** @type {any} */ (withheld.tree), [{ op: 'retitle', uid: S, recurrenceId: '2026-03-30T09:00:00', summary: 'Its own text' }]));
  });

  it('ICAL4007: content the edit would lose', () => {
    const altrep = parseIcal(text.replace('SUMMARY:Stand-up\r\nTRANSP:OPAQUE\r\nDESCRIPTION', 'SUMMARY;ALTREP="cid:s":Stand-up\r\nTRANSP:OPAQUE\r\nDESCRIPTION'), LOSSLESS).tree;
    refuses([{ op: 'retitle', uid: S, summary: 'x' }], 'ICAL4007', '/edits/0/summary', altrep);
    const repeated = parseIcal(text.replace('SUMMARY:King\'s Day', 'SUMMARY:King\'s Day\r\nSUMMARY:Koningsdag'), LOSSLESS).tree;
    refuses([{ op: 'retitle', uid: 'holiday-kingsday@example.com', summary: 'x' }], 'ICAL4007', '/edits/0/summary', repeated);
    refuses([{ op: 'exdate', uid: S, recurrenceId: '2026-03-16T09:00:00' }], 'ICAL4007', '/edits/0/recurrenceId');
  });

  it('ICAL4008/4009 and the writer\'s own codes: a moved time of another kind, no end for a DTEND, a bad length', () => {
    const at = '2026-03-30T09:00:00';
    refuses([{ op: 'move', uid: S, recurrenceId: at, start: { kind: 'utc', instant: '2026-03-31T08:00:00Z' }, duration: 'PT15M' }], 'ICAL4008', '/edits/0/start');
    refuses([{ op: 'move', uid: S, recurrenceId: at, start: { kind: 'zoned', date: '2026-03-31', time: '10:00', zone: 'Europe/London' }, duration: 'PT15M' }],
      'ICAL4008', '/edits/0/start');
    refuses([{ op: 'move', uid: S, recurrenceId: at, start: zoned('2026-03-31', '10:00') }], 'ICAL4009', '/edits/0');
    refuses([{ op: 'move', uid: S, recurrenceId: '2026-03-16T09:00:00', start: zoned('2026-03-31', '10:00') }], 'ICAL4009', '/edits/0');
    refuses([{ op: 'move', uid: S, recurrenceId: at, start: zoned('2026-03-31', '10:00'), end: zoned('2026-03-31', '09:00') }], 'ICAL3007', '/edits/0/end');
    refuses([{ op: 'move', uid: S, recurrenceId: at, start: zoned('2026-03-31', '10:00'), end: zoned('2026-03-31', '11:00'), duration: 'PT1H' }],
      'ICAL3007', '/edits/0');
    refuses([{ op: 'move', uid: S, recurrenceId: at, start: zoned('2026-03-31', '10:00:00.5'), duration: 'PT1H' }], 'ICAL3006', '/edits/0/start');
    refuses([{ op: 'move', uid: S, recurrenceId: at, start: zoned('2026-03-31', '10:00'), duration: '1 hour' }], 'ICAL3003', '/edits/0/duration');
    refuses([{ op: 'retitle', uid: S, summary: 'bell \u0007' }], 'ICAL3004', '/edits/0/summary');
  });

  it('ICAL4010: two edits that reach one line, one occurrence, or a removed event', () => {
    refuses([{ op: 'retitle', uid: S, summary: 'a' }, { op: 'retitle', uid: S, summary: 'b' }], 'ICAL4010', '/edits/1');
    refuses([{ op: 'cancel', uid: S, recurrenceId: '2026-03-09T09:00:00' }, { op: 'exdate', uid: S, recurrenceId: '2026-03-09T09:00:00' }], 'ICAL4010', '/edits/1');
    refuses([{ op: 'remove', uid: S }, { op: 'retitle', uid: S, summary: 'b' }], 'ICAL4010', '/edits/1');
    refuses([{ op: 'remove', uid: S, recurrenceId: '2026-03-16T09:00:00' }, { op: 'retitle', uid: S, recurrenceId: '2026-03-16T09:00:00', summary: 'a' }],
      'ICAL4010', '/edits/1');
    refuses([{ op: 'move', uid: S, recurrenceId: '2026-03-16T09:00:00', start: zoned('2026-03-18', '10:00'), end: zoned('2026-03-18', '10:15') },
      { op: 'cancel', uid: S, recurrenceId: '2026-03-16T09:00:00' }], 'ICAL4010', '/edits/1');
    refuses([{ op: 'retitle', uid: S, summary: 'b' }, { op: 'remove', uid: S }], 'ICAL4010', '/edits/1');
    // two occurrences, or two properties, are two things
    assert.ok(patchIcal(tree, [{ op: 'exdate', uid: S, recurrenceId: '2026-03-09T09:00:00' }, { op: 'exdate', uid: S, recurrenceId: '2026-03-30T09:00:00' },
      { op: 'retitle', uid: S, summary: 'b' }, { op: 'describe', uid: S, description: 'c' }]));
  });

  it('ICAL4012: an edit after which the read would withhold the event', () => {
    // a date series' occurrence moved with a time's duration: the read withholds an event on a date that lasts PT1H
    const dates = /** @type {any} */ (parseIcal(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:p', 'BEGIN:VEVENT', 'UID:d', 'DTSTAMP:20260101T000000Z',
      'DTSTART;VALUE=DATE:20260302', 'RRULE:FREQ=DAILY;COUNT=3', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n'), LOSSLESS)).tree;
    refuses([{ op: 'move', uid: 'd', recurrenceId: '2026-03-03', start: { kind: 'date', date: '2026-03-05' }, duration: 'PT1H' }], 'ICAL4012', '/edits/0', dates);
    // a zoned override's own DURATION that ends in the second pass of a repeated hour now reads, as its duration
    assert.ok(patchIcal(tree, [{ op: 'move', uid: S, recurrenceId: '2026-03-30T09:00:00', start: zoned('2026-10-25', '01:30'), duration: 'PT2H' }]));
    // as does one that ends anywhere else, and an end
    assert.ok(patchIcal(tree, [{ op: 'move', uid: S, recurrenceId: '2026-03-30T09:00:00', start: zoned('2026-03-31', '10:00'), duration: 'PT30M' }]));
    assert.ok(patchIcal(tree, [{ op: 'move', uid: S, recurrenceId: '2026-03-30T09:00:00', start: zoned('2026-03-31', '10:00'), end: zoned('2026-03-31', '10:30') }]));
  });
});

describe('lossless parse and patch grow linearly', () => {
  /** @param {number} n */
  const calendar = (n) => {
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:p'];
    for (let i = 0; i < n; i++) {
      lines.push('BEGIN:VEVENT', `UID:e${i}`, 'DTSTAMP:20260101T000000Z', `DTSTART:2026${String(1 + (i % 12)).padStart(2, '0')}10T090000Z`,
        'DURATION:PT1H', `SUMMARY:Event ${i}`, `X-NOTE;X-A="b:c":${'n'.repeat(60)}`, 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT5M', 'END:VALARM', 'END:VEVENT');
    }
    lines.push('END:VCALENDAR', '');
    return lines.join('\r\n');
  };
  /** @param {string} text */
  const work = (text) => {
    const started = performance.now();
    const { tree } = /** @type {any} */ (parseIcal(text, { mode: 'lossless' }));
    patchIcal(tree, [{ op: 'retitle', uid: 'e7', summary: 'x' }, { op: 'remove', uid: 'e9' }]);
    return performance.now() - started;
  };
  it('an 8x larger file costs well under 64x (no quadratic step)', () => {
    const small = calendar(250);
    const large = calendar(2000);
    work(small);
    work(large);
    const median = (/** @type {string} */ text) => [0, 1, 2, 3, 4].map(() => work(text)).sort((a, b) => a - b)[2];
    const ratio = median(large) / median(small);
    assert.ok(ratio < 24, `8x the events took ${ratio.toFixed(1)}x the time`);
  });
});
