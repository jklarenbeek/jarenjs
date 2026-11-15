//@ts-check

/**
 * The reader's syntax layer: unfolding (CRLF plus a space or a tab, a
 * fold inside a UTF-8 sequence), line ends, parameters with quoted
 * values, nesting, strict UTF-8, line numbers and paths, every limit at
 * its exact boundary, and hostile inputs - each refused with its own
 * code, within its limit, without reading on.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseIcal, createIcalReader, IcalError, JoslLimitError } from '@jarenjs/josl/ical';
import { IcalMachine } from '../../packages/josl/src/ical-machine.js';
import { physicalLines, unfold } from './ical-reader.js';

const DIR = fileURLToPath(new URL('./fixtures/ical/', import.meta.url));
const enc = new TextEncoder();
const NO_LIMITS = { maxOctets: Infinity, maxComponents: Infinity, maxLineOctets: Infinity, maxParameters: Infinity, maxDepth: Infinity, maxProperties: Infinity };

/**
 * The calendar around some lines.
 * @param {string[]} lines
 * @param {string} [eol]
 */
const cal = (lines, eol = '\r\n') => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:p', ...lines, 'END:VCALENDAR', ''].join(eol);

/**
 * Every property line the machine reads, with its line and path.
 * @param {string | Uint8Array} input
 * @param {any} [limits]
 */
function lines(input, limits = NO_LIMITS) {
  /** @type {any[]} */
  const out = [];
  const walk = (/** @type {any} */ node) => {
    out.push(['BEGIN', node.name, node.line, node.path]);
    for (const prop of node.props)
      out.push([prop.name, prop.params, prop.value, prop.line, prop.path]);
    for (const child of node.children)
      walk(child);
  };
  const machine = new IcalMachine(limits, { property: (prop) => out.push([prop.name, prop.params, prop.value, prop.line, prop.path]),
    component: walk, lineFeed: (line) => out.push(['LF', line]) });
  machine.feed(input);
  machine.end();
  return out;
}

/**
 * The refusal of a whole read, by code (and line).
 * @param {string | Uint8Array} input
 * @param {string} code
 * @param {number} [line]
 * @param {any} [options]
 */
function refuses(input, code, line = undefined, options = undefined) {
  assert.throws(() => parseIcal(input, options), (/** @type {any} */ error) => {
    assert.ok(error instanceof IcalError || error instanceof JoslLimitError, String(error));
    assert.strictEqual(error.code, code, error.message);
    if (line !== undefined)
      assert.strictEqual(error.line, line, error.message);
    return true;
  });
}

describe('ical reader syntax: unfolding', () => {
  it('unfolds CRLF plus a space or a tab, and only those', () => {
    const { calendar } = parseIcal(cal(['BEGIN:VEVENT', 'UID:a', 'DTSTART:2026', ' 0302T09', '\t0000Z', 'SUMMARY:one', '  two', 'END:VEVENT']));
    assert.deepStrictEqual([calendar.components[0].start.instant, calendar.components[0].summary], ['2026-03-02T09:00:00Z', 'one two']);
  });

  it('unfolds a fold inside a UTF-8 sequence before it decodes', () => {
    const head = enc.encode('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:p\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20260302T090000Z\r\nSUMMARY:');
    const emoji = enc.encode('😀中');
    const tail = enc.encode('\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n');
    for (let cut = 1; cut < emoji.length; cut++) {
      const bytes = new Uint8Array([...head, ...emoji.subarray(0, cut), 0x0D, 0x0A, 0x20, ...emoji.subarray(cut), ...tail]);
      assert.strictEqual(parseIcal(bytes).calendar.components[0].summary, '😀中', `cut ${cut}`);
    }
  });

  it('unfolds every fixture to the lines the independent test reader unfolds', () => {
    for (const name of fs.readdirSync(DIR).filter((file) => file.endsWith('.ics'))) {
      const bytes = fs.readFileSync(`${DIR}${name}`);
      const text = bytes.toString('utf8');
      // the test reader refuses a fold inside a code point; compare where it reads
      if (text.includes('\uFFFD'))
        continue;
      const expected = unfold(physicalLines(text)).filter((line) => !/^(BEGIN|END):/.test(line));
      const read = lines(bytes).filter((entry) => entry[0] !== 'BEGIN').map(([name, params, value]) =>
        `${name}${params.map((/** @type {any} */ p) => `;${p.name}=${p.values.map((/** @type {string} */ v) => (/[:;,]/.test(v) ? `"${v}"` : v)).join(',')}`).join('')}:${value}`);
      assert.deepStrictEqual(read.map((line) => line.toUpperCase().split(':')[0]), expected.map((line) => line.toUpperCase().split(':')[0]), name);
      assert.deepStrictEqual(read.map((line) => line.slice(line.indexOf(':'))), expected.map((line) => line.slice(line.indexOf(':'))), name);
    }
  });

  it('numbers lines physically, a folded line by its first, and names each path', () => {
    const read = lines(cal(['BEGIN:VEVENT', 'SUMMARY:a', ' b', 'BEGIN:VALARM', 'ACTION:x', 'END:VALARM', 'BEGIN:VALARM', 'END:VALARM', 'X-A:1', 'END:VEVENT',
      'BEGIN:VEVENT', 'END:VEVENT']));
    assert.deepStrictEqual(read.map((entry) => [entry[0], entry.at(-2), entry.at(-1)]), [
      ['VERSION', 2, '/VCALENDAR/VERSION'], ['PRODID', 3, '/VCALENDAR/PRODID'],
      ['BEGIN', 4, '/VCALENDAR/VEVENT[0]'], ['SUMMARY', 5, '/VCALENDAR/VEVENT[0]/SUMMARY'], ['X-A', 12, '/VCALENDAR/VEVENT[0]/X-A'],
      ['BEGIN', 7, '/VCALENDAR/VEVENT[0]/VALARM[0]'], ['ACTION', 8, '/VCALENDAR/VEVENT[0]/VALARM[0]/ACTION'],
      ['BEGIN', 10, '/VCALENDAR/VEVENT[0]/VALARM[1]'], ['BEGIN', 14, '/VCALENDAR/VEVENT[1]']]);
  });

  it('reads names case-insensitively and keeps values as written', () => {
    const { calendar } = parseIcal('begin:vcalendar\r\nversion:2.0\r\nprodid:p\r\nbegin:vevent\r\nuid:A\r\ndtstart;value=date:20260302\r\nsummary:MiXed\r\nend:VEVENT\r\nend:vcalendar\r\n');
    assert.deepStrictEqual(calendar.components, [{ type: 'event', uid: 'A', start: { kind: 'date', date: '2026-03-02' }, summary: 'MiXed' }]);
  });

  it('skips a byte order mark at the start and empty lines, and reads a last line with no line break', () => {
    const bytes = new Uint8Array([0xEF, 0xBB, 0xBF, ...enc.encode('BEGIN:VCALENDAR\r\n\r\nVERSION:2.0\r\nPRODID:p\r\n\r\nEND:VCALENDAR')]);
    assert.deepStrictEqual(parseIcal(bytes).calendar, { prodId: 'p', components: [] });
    // a byte order mark later is text, and no name
    refuses('BEGIN:VCALENDAR\r\n\uFEFFVERSION:2.0\r\n', 'ICAL1002', 2);
    refuses(new Uint8Array([0xEF, 0xBB, ...enc.encode('BEGIN:VCALENDAR\r\n')]), 'ICAL1001', 1);
  });
});

describe('ical reader syntax: line ends', () => {
  it('reads a bare line feed as CRLF and reports each (ICAL1010); strict refuses it', () => {
    const text = cal(['BEGIN:VEVENT', 'UID:a', 'DTSTART:20260302T090000Z', 'SUMMARY:x', ' y', 'END:VEVENT'], '\n');
    const { calendar, report } = parseIcal(text);
    assert.strictEqual(calendar.components[0].summary, 'xy');
    assert.deepStrictEqual(report.unsupported.slice(0, 2).map((e) => [e.code, e.line, e.path]), [['ICAL1010', 1, ''], ['ICAL1010', 2, '/VCALENDAR']]);
    assert.strictEqual(report.counts.ICAL1010, 10);
    refuses(text, 'ICAL1010', 1, { strict: true });
  });

  it('refuses a carriage return no line feed follows (ICAL1004), mid-line or at the end', () => {
    refuses('BEGIN:VCALENDAR\r\nVERSION:2.0\rPRODID:p\r\nEND:VCALENDAR\r\n', 'ICAL1004', 2);
    refuses('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:p\r\nEND:VCALENDAR\r', 'ICAL1004');
  });

  it('refuses a control character other than a tab (ICAL1004), and reads a tab in a value', () => {
    refuses(cal(['X-A:a\u0001b']), 'ICAL1004', 4);
    refuses(cal(['X-A:a\u007Fb']), 'ICAL1004', 4);
    refuses(cal(['X-A:a\u0000b']), 'ICAL1004', 4);
    const { calendar } = parseIcal(cal(['BEGIN:VEVENT', 'UID:a', 'DTSTART:20260302T090000Z', 'SUMMARY:a\tb', 'END:VEVENT']));
    assert.strictEqual(calendar.components[0].summary, 'a\tb');
  });
});

describe('ical reader syntax: parameters', () => {
  it('reads quoted values holding colons, semicolons and commas, and lists of values', () => {
    const read = lines(cal(['X-LOC;X-ADDRESS="1 Main St, Town; Hall: A";X-LIST=a,"b:c",d;X-EMPTY=;X-Q="":geo:1,2']));
    assert.deepStrictEqual(read[2], ['X-LOC', [{ name: 'X-ADDRESS', values: ['1 Main St, Town; Hall: A'] }, { name: 'X-LIST', values: ['a', 'b:c', 'd'] },
      { name: 'X-EMPTY', values: [''] }, { name: 'X-Q', values: [''] }], 'geo:1,2', 4, '/VCALENDAR/X-LOC']);
  });

  for (const [title, line] of [['no equals sign', 'X-A;LANGUAGE:x'], ['no name', 'X-A;=en:x'], ['an unclosed quote', 'X-A;CN="abc:x'],
    ['text after a closing quote', 'X-A;CN="a"b:x'], ['a quote in an unquoted value', 'X-A;CN=a"b:x'], ['a bad name', 'X-A;C N=a:x']]) {
    it(`refuses a parameter with ${title} (ICAL1003)`, () => refuses(cal([line]), 'ICAL1003', 4));
  }

  for (const [title, line] of [['no colon', 'SUMMARY Hello'], ['no name', ':value'], ['a bad name', 'X_A:1'], ['BEGIN with no component', 'BEGIN:'],
    ['BEGIN with a parameter', 'BEGIN;X=1:VEVENT'], ['BEGIN naming no component', 'BEGIN:V EVENT']]) {
    it(`refuses a content line with ${title} (ICAL1002)`, () => refuses(cal([line]), 'ICAL1002', 4));
  }
});

describe('ical reader syntax: structure', () => {
  it('refuses an END that does not close the open component (ICAL1005)', () => {
    refuses(cal(['BEGIN:VEVENT', 'END:VTODO']), 'ICAL1005', 5);
    refuses(cal(['BEGIN:VEVENT', 'BEGIN:VALARM', 'END:VEVENT']), 'ICAL1005', 6);
    refuses('END:VCALENDAR\r\n', 'ICAL1005', 1);
  });

  it('refuses input that ends inside a component (ICAL1006), naming it', () => {
    assert.throws(() => parseIcal('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:p\r\nBEGIN:VEVENT\r\nUID:a\r\n'), (/** @type {any} */ error) =>
      error.code === 'ICAL1006' && error.docPath === '/VCALENDAR/VEVENT[0]' && /begun on line 4/.test(error.message));
    refuses('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n', 'ICAL1006');
  });

  it('refuses content outside the calendar (ICAL1007)', () => {
    refuses('VERSION:2.0\r\n', 'ICAL1007', 1);
    refuses('BEGIN:VEVENT\r\nEND:VEVENT\r\n', 'ICAL1007', 1);
    refuses(`${cal([])}X-A:1\r\n`, 'ICAL1007', 5);
    refuses(`${cal([])}${cal([])}`, 'ICAL1007', 5);
    refuses(cal(['BEGIN:VCALENDAR']), 'ICAL1007', 4);
    refuses('', 'ICAL1007');
    refuses('\r\n\r\n', 'ICAL1007');
  });
});

describe('ical reader syntax: UTF-8', () => {
  it('refuses octets that are not UTF-8 (ICAL1001) at their line, never replacing them', () => {
    for (const bad of [[0xFF], [0xC0, 0xAF], [0xED, 0xA0, 0x80], [0xE4, 0xB8]]) {
      const bytes = new Uint8Array([...enc.encode('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:p\r\nX-A:'), ...bad, ...enc.encode('\r\nEND:VCALENDAR\r\n')]);
      refuses(bytes, 'ICAL1001', 4);
    }
  });

  it('refuses a lone surrogate in text, and a text chunk ending on a high surrogate that octets follow', () => {
    refuses(cal(['X-A:\uD800x']), 'ICAL1001');
    refuses(cal(['X-A:\uDC00']), 'ICAL1001');
    refuses(cal(['X-A:😀\uD800x']), 'ICAL1001', 4);
    assert.throws(() => createIcalReader().feed(/** @type {any} */ (null)), /not null/);
    const reader = createIcalReader();
    reader.feed('BEGIN:VCALENDAR\r\nX-A:\uD83D');
    assert.throws(() => reader.feed(enc.encode('x')), (/** @type {any} */ error) => error.code === 'ICAL1001');
    const ending = createIcalReader();
    ending.feed('BEGIN:VCALENDAR\r\nX-A:\uD83D');
    assert.throws(() => ending.end(), (/** @type {any} */ error) => error.code === 'ICAL1001');
  });

  it('joins a surrogate pair split between text chunks', () => {
    const reader = createIcalReader();
    const text = cal(['BEGIN:VEVENT', 'UID:a', 'DTSTART:20260302T090000Z', 'SUMMARY:😀', 'END:VEVENT']);
    const cut = text.indexOf('😀') + 1;
    reader.feed(text.slice(0, cut));
    const first = reader.feed('');
    const rest = reader.feed(text.slice(cut));
    assert.deepStrictEqual([first.length, rest[0].summary], [0, '😀']);
  });
});

describe('ical reader: limits at their exact boundary', () => {
  const text = cal(['BEGIN:VEVENT', 'UID:a', 'DTSTART;TZID="UTC";VALUE=DATE-TIME:20260302T090000', 'X-LONG:', ` ${'é'.repeat(30)}`,
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'END:VALARM', 'END:VEVENT', 'BEGIN:VFREEBUSY', 'UID:f', 'END:VFREEBUSY']);
  const octets = enc.encode(text).length;
  // 'X-LONG:' + 60 octets of é; the VEVENT's 3 properties; VCALENDAR > VEVENT > VALARM; 3 components
  const needs = { maxOctets: octets, maxLineOctets: 67, maxParameters: 2, maxDepth: 3, maxComponents: 3, maxProperties: 3 };
  const codeOf = { maxOctets: 'ICAL2001', maxLineOctets: 'ICAL2004', maxParameters: 'ICAL2005', maxDepth: 'ICAL2006', maxComponents: 'ICAL2002', maxProperties: 'ICAL2007' };
  const lineOf = { maxOctets: 16, maxLineOctets: 7, maxParameters: 6, maxDepth: 9, maxComponents: 13, maxProperties: 7 };

  for (const [name, need] of Object.entries(needs)) {
    it(`${name} admits exactly what the calendar needs and refuses one less (${/** @type {any} */ (codeOf)[name]})`, () => {
      const provider = undefined;
      parseIcal(text, { [name]: need, provider });
      assert.throws(() => parseIcal(text, { [name]: need - 1 }), (/** @type {any} */ error) => {
        assert.ok(error instanceof JoslLimitError);
        assert.strictEqual(error.code, /** @type {any} */ (codeOf)[name]);
        assert.strictEqual(error.limit, need - 1);
        assert.strictEqual(error.line, /** @type {any} */ (lineOf)[name], error.message);
        return true;
      });
    });
  }
});

describe('ical reader: hostile input, refused within its limit', () => {
  it('a 10 MB line in 64 KB chunks stops at maxLineOctets, in the second chunk', () => {
    const reader = createIcalReader({ maxLineOctets: 100000 });
    reader.feed('BEGIN:VCALENDAR\r\nX-BOMB:');
    const chunk = 'x'.repeat(65536);
    let fed = 0;
    assert.throws(() => {
      for (; fed < 160; fed++)
        reader.feed(chunk);
    }, (/** @type {any} */ error) => error.code === 'ICAL2004' && error.line === 2);
    assert.strictEqual(fed, 1);
    assert.throws(() => reader.feed('x'), (/** @type {any} */ error) => error.code === 'ICAL1009');
  });

  it('a nesting bomb stops at maxDepth', () => {
    const bomb = `BEGIN:VCALENDAR\r\n${'BEGIN:X-N\r\n'.repeat(100000)}`;
    refuses(bomb, 'ICAL2006', 65, { maxDepth: 64 });
  });

  it('a property-count bomb stops at maxProperties', () => {
    const bomb = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\n${'X-P:1\r\n'.repeat(100000)}`;
    refuses(bomb, 'ICAL2007', 1003, { maxProperties: 1000 });
  });

  it('a component bomb stops at maxComponents, and a parameter bomb at maxParameters', () => {
    refuses(`BEGIN:VCALENDAR\r\n${'BEGIN:VEVENT\r\nEND:VEVENT\r\n'.repeat(100000)}`, 'ICAL2002', 2002, { maxComponents: 1000 });
    refuses(`BEGIN:VCALENDAR\r\nX-P${';A=1'.repeat(100000)}:x\r\n`, 'ICAL2005', 2, { maxParameters: 100 });
  });

  it('an endless stream stops at maxOctets, reading the octets before it', () => {
    const reader = createIcalReader({ maxOctets: 1000 });
    const seen = [];
    assert.throws(() => {
      for (let i = 0; i < 1000; i++)
        seen.push(...reader.feed('BEGIN:VEVENT\r\nUID:a\r\nDTSTART:20260302T090000Z\r\nEND:VEVENT\r\n'.replace(/^/, i === 0 ? 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:p\r\n' : '')));
    }, (/** @type {any} */ error) => error.code === 'ICAL2001');
    assert.ok(seen.length > 10 && seen.length < 20, String(seen.length));
  });

  it('reading grows with the input, not faster: 8x the events in under 16x the time', () => {
    const calendarOf = (/** @type {number} */ n) => cal(Array.from({ length: n }, (_, i) =>
      ['BEGIN:VEVENT', `UID:e${i}`, 'DTSTAMP:20260101T000000Z', `DTSTART:202603${String(1 + (i % 28)).padStart(2, '0')}T090000Z`, 'DURATION:PT1H',
        `SUMMARY:Event ${i}\\, with text`, 'X-A:1', 'END:VEVENT']).flat());
    const small = calendarOf(500);
    const large = calendarOf(4000);
    const time = (/** @type {string} */ text) => {
      const runs = [];
      for (let i = 0; i < 7; i++) {
        const start = performance.now();
        parseIcal(text);
        runs.push(performance.now() - start);
      }
      return runs.sort((a, b) => a - b)[3];
    };
    time(small);
    const ratio = time(large) / time(small);
    assert.ok(ratio < 16, `8x the input took ${ratio.toFixed(1)}x the time`);
  });
});
