//@ts-check
/**
 * @file One meaning of `quote: null` on every CSV reader and writer: it
 * keeps the default `"`, as `null` does for the delimiter, and `quote: ''`
 * is the one spelling of no quoting. The readers used to read `null` as
 * no quoting while the writers read it as `"`, so one dialect did not
 * read back what it wrote.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCsv, parseCsvDocument, sniffCsvDialect, stringifyCsv, stringifyCsvChunks, createCsvRowFormatter,
} from '../../packages/josl/src/csv.js';
import {
  createCsvStreamReader, parseCsvStream, iterateCsvStream, stringifyCsvStream, createCsvStreamWriter,
} from '../../packages/josl/src/csv-stream.js';

const rows = [['x,y', 'say "hi"'], ['1', '']];
const written = '"x,y","say ""hi"""\r\n1,\r\n';

/** @param {any} options @returns {Promise<string[]>} every writer's document */
async function everyWriter(options) {
  const pulled = [];
  for await (const chunk of stringifyCsvStream(rows, options)) pulled.push(chunk);
  const formatter = createCsvRowFormatter(options);
  return [
    stringifyCsv(rows, options),
    [...stringifyCsvChunks(rows, options)].join(''),
    pulled.join(''),
    createCsvStreamWriter(options).writeAll(rows).end(),
    rows.flatMap((row) => formatter.lines(row)).join('') + formatter.tail(),
  ];
}

/** @param {string} text @param {any} options @returns {Promise<unknown[]>} every reader's records */
async function everyReader(text, options) {
  const pushed = createCsvStreamReader(options);
  for (const ch of text) pushed.feed(ch);
  const iterated = [];
  for await (const row of iterateCsvStream([text.slice(0, 3), text.slice(3)], options)) iterated.push(row);
  return [
    parseCsv(text, options),
    parseCsvDocument(text, { ...options, headers: false }).rows,
    pushed.end(),
    await parseCsvStream([text.slice(0, 5), text.slice(5)], options),
    iterated,
  ];
}

describe('quote: null keeps the default on every reader and writer', () => {
  it('round-trips the reproduction', () => {
    assert.deepEqual(parseCsv(stringifyCsv([['x,y']], { quote: null }), { quote: null }), [['x,y']]);
  });

  it('every writer writes the default quote', async () => {
    assert.deepEqual(await everyWriter({ quote: null }), Array(5).fill(written));
  });

  it('every reader reads the default quote, and reads back what was written', async () => {
    assert.deepEqual(await everyReader(written, { quote: null }), Array(5).fill(rows));
    assert.deepEqual(parseCsv('"a",b', { quote: null }), [['a', 'b']]);
  });

  it('a dialect read with quote: null names the default quote', () => {
    assert.equal(sniffCsvDialect('a,b\n1,2', { quote: null }).quote, '"');
    assert.equal(parseCsvDocument('a,b', { quote: null, headers: false }).dialect.quote, '"');
    assert.equal(parseCsvDocument('a,b', { quote: null, headers: 'auto' }).dialect.quote, '"');
  });

  it('a strict read with quote: null holds a stray quote to the default rules', () => {
    assert.throws(() => parseCsv('"a', { quote: null }), { code: 'CSV1001' });
  });
});

describe('quote: \'\' still turns quoting off on both sides', () => {
  it('writers write every cell bare and readers read a quote as text', async () => {
    assert.deepEqual(await everyWriter({ quote: '' }), Array(5).fill('x,y,say "hi"\r\n1,\r\n'));
    assert.deepEqual(await everyReader('"a",b\r\n', { quote: '' }), Array(5).fill([['"a"', 'b']]));
    assert.equal(sniffCsvDialect('a,b\n1,2', { quote: '' }).quote, '');
  });

  it('quoteAll with quote \'\' is still refused, and with quote null still quotes with "', () => {
    assert.throws(() => stringifyCsv([['a']], { quoteAll: true, quote: '' }), TypeError);
    assert.equal(stringifyCsv([['a', 'b']], { quoteAll: true, quote: null }), '"a","b"\r\n');
  });

  it('an undefined quote is the default, and a custom quote is read and written', async () => {
    assert.deepEqual(await everyReader(written, {}), Array(5).fill(rows));
    assert.deepEqual(parseCsv(stringifyCsv([['x,y']], { quote: "'" }), { quote: "'" }), [['x,y']]);
  });
});
