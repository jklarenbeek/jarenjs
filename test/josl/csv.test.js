import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual, throws, ok } from 'node:assert';

import {
  parseCsv,
  parseJosl,
  parseCsvDocument,
  stringifyCsv,
  stringifyCsvChunks,
  sniffCsvDialect,
  formatCsvValue,
  coerceCsvValue,
  createCsvStreamReader,
  parseCsvStream,
  iterateCsvStream,
  createCsvStreamWriter,
  CsvSyntaxError,
  LocalDate,
  LocalDateTime,
} from '@jarenjs/josl';

//#region reading

describe('csv: RFC 4180 reading', () => {
  it('uses an explicit delimiter when detecting a header', () => {
    const text = 'a;b,c\n1;x,y';
    strictEqual(sniffCsvDialect(text, { delimiter: ';' }).delimiter, ';');
    deepStrictEqual(parseCsvDocument(text, { delimiter: ';', headers: 'auto' }).rows,
      [{ a: '1', 'b,c': 'x,y' }]);
  });
  it('reads records and fields', () => {
    deepStrictEqual(parseCsv('a,b,c\n1,2,3'), [['a', 'b', 'c'], ['1', '2', '3']]);
    deepStrictEqual(parseCsv('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
    deepStrictEqual(parseCsv(''), []);
    deepStrictEqual(parseCsv('a'), [['a']]);
  });

  it('does not invent a record for the trailing terminator', () => {
    deepStrictEqual(parseCsv('a,b\n1,2\n'), [['a', 'b'], ['1', '2']]);
    deepStrictEqual(parseCsv('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
  });

  it('keeps a blank line as a record of one empty field', () => {
    // RFC 4180 has no notion of a blank line; it is a one-field record
    deepStrictEqual(parseCsv('a\n\nb'), [['a'], [''], ['b']]);
    deepStrictEqual(parseCsv('a\n\nb', { skipEmptyLines: true }), [['a'], ['b']]);
  });

  it('reads quoted fields', () => {
    deepStrictEqual(parseCsv('"x,y",z'), [['x,y', 'z']]);
    deepStrictEqual(parseCsv('"he said ""hi""",z'), [['he said "hi"', 'z']]);
    deepStrictEqual(parseCsv('"line1\nline2",z'), [['line1\nline2', 'z']]);
    deepStrictEqual(parseCsv('"",x'), [['', 'x']]);
    deepStrictEqual(parseCsv('"a""""b"'), [['a""b']]);
  });

  it('keeps empty fields at either edge', () => {
    deepStrictEqual(parseCsv('a,,b'), [['a', '', 'b']]);
    deepStrictEqual(parseCsv(',a'), [['', 'a']]);
    deepStrictEqual(parseCsv('a,'), [['a', '']]);
  });

  it('strips a leading BOM', () => {
    deepStrictEqual(parseCsv('﻿a,b'), [['a', 'b']]);
  });

  it('honours the dialect options', () => {
    deepStrictEqual(parseCsv('a;b', { delimiter: ';' }), [['a', 'b']]);
    deepStrictEqual(parseCsv('a\tb', { delimiter: '\t' }), [['a', 'b']]);
    deepStrictEqual(parseCsv("'a,b',c", { quote: "'" }), [['a,b', 'c']]);
    deepStrictEqual(parseCsv('"a",b', { quote: null }), [['"a"', 'b']]);
    deepStrictEqual(parseCsv('# note\na,b', { comment: '#' }), [['a', 'b']]);
    throws(() => parseCsv('a', { delimiter: ',,' }), TypeError);
  });

  it('trims only unquoted fields', () => {
    deepStrictEqual(parseCsv(' a , b ', { trim: true }), [['a', 'b']]);
    // quoting IS the author saying the whitespace is data
    deepStrictEqual(parseCsv('" a ", b ', { trim: true }), [[' a ', 'b']]);
  });

  it('reads header-keyed records', () => {
    deepStrictEqual(parseCsv('a,b\n1,2', { headers: true }), [{ a: '1', b: '2' }]);
    deepStrictEqual(parseCsv('1,2', { headers: ['x', 'y'] }), [{ x: '1', y: '2' }]);
    deepStrictEqual(parseCsv('a,b', { headers: true }), []);
  });

  it('never lets a header poison the prototype', () => {
    const rows = parseCsv('__proto__,b\n1,2', { headers: true });
    strictEqual(rows.length, 1);
    // an object LITERAL with __proto__ would set the prototype instead of
    // a member, which is the whole hazard, so build the expectation the
    // only way that carries an own property of that name
    strictEqual(Object.getOwnPropertyDescriptor(rows[0], '__proto__').value, '1');
    strictEqual(rows[0].b, '2');
    strictEqual(Object.getPrototypeOf(rows[0]), Object.prototype);
    strictEqual(Object.hasOwn(rows[0], '__proto__'), true);
    strictEqual({}.b, undefined);
  });
});

describe('csv: typed values', () => {
  it('coerces the unambiguous JOSL value types', () => {
    deepStrictEqual(parseCsv('1,2.5,-3e2,true,FALSE,null', { typed: true }),
      [[1, 2.5, -300, true, false, null]]);
  });

  it('promotes an unsafe integer to bigint rather than rounding it', () => {
    const [[v]] = parseCsv('123456789012345678901234567890', { typed: true });
    strictEqual(typeof v, 'bigint');
    strictEqual(v, 123456789012345678901234567890n);
  });

  it('keeps a leading zero as a string', () => {
    // postcodes and zero-padded ids do not survive becoming Numbers
    deepStrictEqual(parseCsv('007,0,0.5,-01', { typed: true }), [['007', 0, 0.5, '-01']]);
  });

  it('reads ISO dates as the JOSL value classes', () => {
    const [[date, dt, offset]] =
      parseCsv('2026-07-27,2026-07-27T08:30:00,2026-07-27T08:30:00Z', { typed: true });
    ok(date instanceof LocalDate);
    strictEqual(String(date), '2026-07-27');
    ok(dt instanceof LocalDateTime);
    strictEqual(String(dt), '2026-07-27T08:30:00');
    ok(offset instanceof Date);
    strictEqual(offset.toISOString(), '2026-07-27T08:30:00.000Z');
    // an impossible date is text, not a value
    deepStrictEqual(parseCsv('2026-02-30', { typed: true }), [['2026-02-30']]);
  });

  it('never coerces a quoted cell', () => {
    deepStrictEqual(parseCsv('"1","true","2026-07-27"', { typed: true }),
      [['1', 'true', '2026-07-27']]);
  });

  it('preserves early years and fractional instants across JOSL and typed CSV', async () => {
    const cases = [
      ['0099-01-02T03:04:05Z', '0099-01-02T03:04:05.000Z'],
      ['0000-02-29T00:00:00Z', '0000-02-29T00:00:00.000Z'],
      ['0099-12-31t23:30:00-01:00', '0100-01-01T00:30:00.000Z'],
      ['2026-01-01 00:00:00.9999z', '2026-01-01T00:00:00.999Z'],
    ];
    for (const [text, expected] of cases) {
      strictEqual(coerceCsvValue(text).toISOString(), expected);
      strictEqual(parseJosl(`at = ${text}`).at.toISOString(), expected);
      strictEqual(parseCsv(text, { typed: true })[0][0].toISOString(), expected);
      strictEqual((await parseCsvStream([...text], { typed: true }))[0][0].toISOString(), expected);
    }
  });

  it('keeps invalid offset instants as text instead of normalizing them', () => {
    for (const text of ['2026-01-01T00:00:00+24:00', '2026-01-01T00:00:00+01:99',
      '2026-01-01T00:00:00-00:60']) {
      strictEqual(coerceCsvValue(text), text);
      deepStrictEqual(parseCsv(text, { typed: true }), [[text]]);
    }
  });

  it('exposes the coercion on its own', () => {
    strictEqual(coerceCsvValue('42'), 42);
    strictEqual(coerceCsvValue('x'), 'x');
    strictEqual(coerceCsvValue(''), '');
  });

  it('maps empty cells to null on request', () => {
    deepStrictEqual(parseCsv('a,,b', { emptyAsNull: true }), [['a', null, 'b']]);
  });
});

//#endregion

//#region strict vs repair

describe('csv: strict mode rejects damage', () => {
  const bad = (text, code, options) => {
    throws(() => parseCsv(text, options), (e) => {
      ok(e instanceof CsvSyntaxError, `expected CsvSyntaxError, got ${e.name}`);
      strictEqual(e.code, code);
      ok(e.line >= 1 && e.column >= 1);
      ok(typeof e.hint === 'string');
      return true;
    });
  };

  it('rejects an unterminated quoted field', () => bad('a,"abc', 'CSV1001'));
  it('rejects text after a closing quote', () => bad('"ab"c,d', 'CSV1002'));
  it('rejects an unescaped inner quote', () => bad('"he said "hi" ok"', 'CSV1003'));
  it('rejects a bare carriage return', () => bad('a,b\r1,2', 'CSV1006'));
  it('rejects a short record', () => bad('a,b\n1', 'CSV1004', { headers: true }));
  it('rejects a long record', () => bad('a,b\n1,2,3', 'CSV1005', { headers: true }));
  it('rejects a duplicate header', () => bad('a,a\n1,2', 'CSV1007', { headers: true }));
  it('rejects an empty header name', () => bad('a,,c\n1,2,3', 'CSV1008', { headers: true }));
});

describe('csv: repair mode heals and reports', () => {
  const heal = (text, options) => {
    const doc = parseCsvDocument(text, { repair: true, ...options });
    return { rows: doc.rows, codes: doc.repairs.map((r) => r.code) };
  };

  it('closes an unterminated quoted field, keeping the text', () => {
    deepStrictEqual(heal('a,"abc'), { rows: [['a', 'abc']], codes: ['CSV1001'] });
  });

  it('absorbs stray text after a closing quote, keeping the columns', () => {
    // the record's column count is what a consumer indexes by, so it wins
    deepStrictEqual(heal('"ab"c,d'), { rows: [['abc', 'd']], codes: ['CSV1002'] });
  });

  it('keeps an inner quote literal when another quote follows before a break', () => {
    deepStrictEqual(heal('"he said "hi" ok",z'),
      { rows: [['he said "hi" ok', 'z']], codes: ['CSV1003', 'CSV1003'] });
  });

  it('ends a record on a bare carriage return', () => {
    deepStrictEqual(heal('a,b\r1,2'), { rows: [['a', 'b'], ['1', '2']], codes: ['CSV1006'] });
  });

  it('leaves a short record short rather than inventing cells', () => {
    const { rows, codes } = heal('a,b,c\n1,2', { headers: true });
    deepStrictEqual(codes, ['CSV1004']);
    deepStrictEqual(rows, [{ a: '1', b: '2' }]);
    strictEqual(Object.hasOwn(rows[0], 'c'), false);
  });

  it('widens the header for a long record', () => {
    const doc = parseCsvDocument('a,b\n1,2,3', { repair: true, headers: true });
    deepStrictEqual(doc.repairs.map((r) => r.code), ['CSV1005']);
    deepStrictEqual(doc.rows, [{ a: '1', b: '2', column_3: '3' }]);
    deepStrictEqual(doc.fields, ['a', 'b', 'column_3']);
  });

  it('uniquifies duplicate and empty header names', () => {
    deepStrictEqual(heal('a,a\n1,2', { headers: true }),
      { rows: [{ a: '1', a_2: '2' }], codes: ['CSV1007'] });
    deepStrictEqual(heal('a,,c\n1,2,3', { headers: true }),
      { rows: [{ a: '1', column_2: '2', c: '3' }], codes: ['CSV1008'] });
  });

  it('reports every repair with a position', () => {
    const doc = parseCsvDocument('a,b\n1,"oops', { repair: true, headers: true });
    strictEqual(doc.repairs.length, 1);
    const [r] = doc.repairs;
    strictEqual(r.code, 'CSV1001');
    strictEqual(r.line, 2);
    ok(typeof r.message === 'string' && r.message.length > 0);
  });

  it('feeds repairs to the sinks', () => {
    const seen = [];
    const events = [];
    parseCsv('a,"oops', { repair: true, onRepair: (r) => seen.push(r.code), onEvent: (e) => events.push(e.type) });
    deepStrictEqual(seen, ['CSV1001']);
    ok(events.includes('repair'));
  });
});

//#endregion

//#region dialect sniffing

describe('csv: dialect sniffing', () => {
  it('finds the delimiter by record-width consistency', () => {
    strictEqual(sniffCsvDialect('name;age\nalice;30\nbob;25').delimiter, ';');
    strictEqual(sniffCsvDialect('a\tb\n1\t2\n3\t4').delimiter, '\t');
    strictEqual(sniffCsvDialect('a,b\n1,2\n3,4').delimiter, ',');
    strictEqual(sniffCsvDialect('a|b\n1|2\n3|4').delimiter, '|');
  });

  it('is not fooled by a separator that appears inside values', () => {
    // every record has one comma, but only the semicolon splits evenly
    const text = 'city;note\nParis;a, b, c\nBerlin;d, e, f\nRome;g, h, i';
    strictEqual(sniffCsvDialect(text).delimiter, ';');
  });

  it('detects a header only when the rows below disagree with it', () => {
    strictEqual(sniffCsvDialect('name,age\nalice,30\nbob,25').headers, true);
    // all-text tables give no evidence, and inventing a header would eat a row
    strictEqual(sniffCsvDialect('alice,paris\nbob,rome').headers, false);
    strictEqual(sniffCsvDialect('1,2\n3,4\n5,6').headers, false);
  });

  it('drives parseCsvDocument through delimiter: auto', () => {
    const doc = parseCsvDocument('a;b\n1;2', { delimiter: 'auto', headers: 'auto' });
    strictEqual(doc.dialect.delimiter, ';');
    deepStrictEqual(doc.rows, [{ a: '1', b: '2' }]);
  });
});

//#endregion

//#region streaming

describe('csv: streaming', () => {
  const DOCS = [
    'a,b,c\n1,2,3\n"x,y",z,"he said ""hi"""\n4,5,6\n',
    'a,b\r\n1,2\r\n"multi\nline",4\r\n',
    '"only one field"',
    'a\n\nb\n',
    'trailing,\n,leading\n',
    'a,b\r1,2\r3,4\r',
    'a,"unclosed',
    '"ab"c,d\n1,2\n',
  ];

  it('chunked feeding matches whole-document parsing at every chunk size', () => {
    const attempt = (fn) => {
      try {
        return { ok: fn() };
      }
      catch (e) {
        return { err: e.code ?? e.name };
      }
    };
    for (const doc of DOCS) {
      for (const headers of [false, true]) {
        for (const repair of [false, true]) {
          const options = { headers, repair };
          const expected = attempt(() => parseCsv(doc, options));
          for (const size of [1, 2, 3, 5, 7, 16, 64]) {
            const got = attempt(() => {
              const reader = createCsvStreamReader(options);
              for (let i = 0; i < doc.length; i += size)
                reader.feed(doc.slice(i, i + size));
              return reader.end();
            });
            deepStrictEqual(got, expected,
              `${JSON.stringify(doc)} size ${size} headers ${headers} repair ${repair}`);
          }
        }
      }
    }
  });

  it('exposes partial results while reading', () => {
    const reader = createCsvStreamReader({ headers: true });
    reader.feed('a,b\n1,2\n3,');
    deepStrictEqual(reader.fields(), ['a', 'b']);
    deepStrictEqual(reader.rows(), [{ a: '1', b: '2' }]);
    deepStrictEqual(reader.repairs(), []);
    reader.feed('4\n');
    deepStrictEqual(reader.end(), [{ a: '1', b: '2' }, { a: '3', b: '4' }]);
  });

  it('reports repairs made mid-stream', () => {
    const reader = createCsvStreamReader({ headers: true, repair: true });
    reader.feed('a,a\n1,2\n');
    deepStrictEqual(reader.repairs().map((r) => r.code), ['CSV1007']);
    reader.end();
  });

  it('emits events in document order', () => {
    const events = [];
    const reader = createCsvStreamReader({
      headers: true,
      onEvent: (e) => events.push(e.type === 'row' ? [e.type, e.index, e.record] : [e.type, e.fields]),
    });
    reader.feed('a,b\n1,2\n3,4\n');
    reader.end();
    deepStrictEqual(events, [
      ['header', ['a', 'b']],
      ['row', 0, { a: '1', b: '2' }],
      ['row', 1, { a: '3', b: '4' }],
    ]);
  });

  it('rejects feeding after end', () => {
    const reader = createCsvStreamReader();
    reader.end();
    throws(() => reader.feed('a'), /cannot feed after end/);
  });

  it('reads an async iterable', async () => {
    async function* source() {
      yield 'a,b\n1,';
      yield '2\n';
    }
    deepStrictEqual(await parseCsvStream(source(), { headers: true }), [{ a: '1', b: '2' }]);
    deepStrictEqual(await parseCsvStream(['a,b\n1,2\n']), [['a', 'b'], ['1', '2']]);
  });

  it('iterates records without retaining them', async () => {
    const seen = [];
    for await (const row of iterateCsvStream(['a,b\n1,', '2\n3,4\n'], { headers: true }))
      seen.push(row);
    deepStrictEqual(seen, [{ a: '1', b: '2' }, { a: '3', b: '4' }]);
  });
});

//#endregion

//#region writing

describe('csv: writing', () => {
  it('quotes only what has to be quoted', () => {
    strictEqual(stringifyCsv([['a', 'b']]), 'a,b\r\n');
    strictEqual(stringifyCsv([['x,y']]), '"x,y"\r\n');
    strictEqual(stringifyCsv([['a"b']]), '"a""b"\r\n');
    strictEqual(stringifyCsv([['a\nb']]), '"a\nb"\r\n');
    strictEqual(stringifyCsv([[' pad ']]), '" pad "\r\n');
  });

  it('writes a header for object records', () => {
    strictEqual(stringifyCsv([{ a: 1, b: 2 }, { a: 3, b: 4 }]), 'a,b\r\n1,2\r\n3,4\r\n');
    strictEqual(stringifyCsv([{ a: 1 }], { header: false }), '1\r\n');
    strictEqual(stringifyCsv([{ a: 1, b: 2 }], { fields: ['b'] }), 'b\r\n2\r\n');
  });

  it('renders the JOSL value types', () => {
    strictEqual(formatCsvValue(null), '');
    strictEqual(formatCsvValue(undefined), '');
    strictEqual(formatCsvValue(10n), '10');
    strictEqual(formatCsvValue(true), 'true');
    strictEqual(formatCsvValue(new LocalDate(2026, 7, 27)), '2026-07-27');
    strictEqual(formatCsvValue(new Date(0)), '1970-01-01T00:00:00.000Z');
    strictEqual(formatCsvValue(Infinity), '');
  });

  it('honours the newline and delimiter options', () => {
    strictEqual(stringifyCsv([['a', 'b']], { newline: '\n' }), 'a,b\n');
    strictEqual(stringifyCsv([['a', 'b']], { delimiter: ';' }), 'a;b\r\n');
    // the delimiter decides what has to be quoted
    strictEqual(stringifyCsv([['a,b']], { delimiter: ';' }), 'a,b\r\n');
  });

  it('yields one record per chunk', () => {
    deepStrictEqual([...stringifyCsvChunks([{ a: 1 }, { a: 2 }])], ['a\r\n', '1\r\n', '2\r\n']);
  });

  it('writes incrementally', () => {
    const writer = createCsvStreamWriter();
    writer.write({ a: 1, b: 2 }).write({ a: 3, b: 4 });
    strictEqual(writer.end(), 'a,b\r\n1,2\r\n3,4\r\n');

    const chunks = [];
    const sink = createCsvStreamWriter({ onChunk: (c) => chunks.push(c) });
    sink.writeAll([['a'], ['1']]);
    deepStrictEqual(chunks, ['a\r\n', '1\r\n']);
    strictEqual(sink.end(), '');
  });

  it('writes a nested object or array cell as its JSON text, never its toString', () => {
    strictEqual(stringifyCsv([{ a: { b: 1 }, c: [1, 2], d: Object.create(null) }]), 'a,c,d\r\n"{""b"":1}","[1,2]",{}\r\n');
    strictEqual(stringifyCsv([[{ b: 1 }, [1, 2], 3]]), '"{""b"":1}","[1,2]",3\r\n');
    deepStrictEqual(parseCsv(stringifyCsv([{ a: { b: 1 } }]), { headers: true }), [{ a: '{"b":1}' }], 'the reader hands the JSON text back');
    class Money { toString() { return '€1.50'; } }
    strictEqual(stringifyCsv([[new Money()]]), '€1.50\r\n', 'a value that renders itself still does');
  });

  it('round-trips values that need every escape', () => {
    const rows = [{
      plain: 'x',
      comma: 'a,b',
      quote: 'he said "hi"',
      newline: 'line1\nline2',
      padded: ' pad ',
      empty: '',
    }];
    deepStrictEqual(parseCsv(stringifyCsv(rows), { headers: true }), rows);
  });
});

//#endregion
