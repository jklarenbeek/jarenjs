import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { parseCsv, stringifyCsv, createCsvRowFormatter } from '@jarenjs/josl/csv';
import { parseCsvStream, stringifyCsvStream } from '@jarenjs/josl/csv-stream';

// A reader drops a byte order mark at the start of a document, so a cell
// that begins with U+FEFF at the very start must be written quoted for the
// text to survive a round trip.

describe('CSV cells that begin with a byte order mark', function () {
  const mark = '﻿';

  it('quotes every cell that begins with the mark, wherever it sits', function () {
    assert.strictEqual(stringifyCsv([[mark + 'a', mark], [mark + 'b', 'x']]), `"${mark}a","${mark}"\r\n"${mark}b",x\r\n`);
  });

  it('round-trips the mark through the whole-text and the streaming reader', async function () {
    const rows = [[mark + 'a', mark], [mark + 'b', 'x']];
    const text = stringifyCsv(rows);
    assert.deepStrictEqual(parseCsv(text), rows);
    async function* chunks() { yield text.slice(0, 3); yield text.slice(3); }
    assert.deepStrictEqual(await parseCsvStream(chunks()), rows);
  });

  it('quotes a header name that begins with the mark, and the streaming writer agrees', async function () {
    const text = stringifyCsv([{ [mark + 'k']: 1 }]);
    assert.strictEqual(text, `"${mark}k"\r\n1\r\n`);
    assert.deepStrictEqual(parseCsv(text, { headers: true }), [{ [mark + 'k']: '1' }]);
    let streamed = '';
    for await (const chunk of stringifyCsvStream([{ [mark + 'k']: 1 }])) streamed += chunk;
    assert.strictEqual(streamed, text);
  });

  it('leaves a cell with the mark inside it unquoted', function () {
    assert.strictEqual(stringifyCsv([['a', 'b' + mark + 'c']]), `a,b${mark}c\r\n`);
  });

  it('formats alike on every use of one row formatter, in any order', function () {
    const formatter = createCsvRowFormatter();
    const first = formatter.lines([mark + 'a', 'x']);
    const second = formatter.lines([mark + 'a', 'x']);
    assert.deepStrictEqual(second, first);
    assert.deepStrictEqual(first, [`"${mark}a",x\r\n`]);
    assert.deepStrictEqual(createCsvRowFormatter().lines(['x', mark + 'a']), [`x,"${mark}a"\r\n`]);
  });
});
