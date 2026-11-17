import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual, throws, rejects } from 'node:assert';

import { stringifyCsv, stringifyCsvChunks, createCsvRowFormatter, parseCsv } from '@jarenjs/josl/csv';
import { stringifyCsvStream, createCsvStreamWriter } from '@jarenjs/josl/csv-stream';

/** @param {AsyncIterable<string>} chunks @returns {Promise<string>} */
async function drain(chunks) {
  let out = '';
  for await (const chunk of chunks)
    out += chunk;
  return out;
}

// every field shape the formatter converts: text, the empty string, the three
// absent values, numbers, a bigint, both booleans, and text that needs an escape
const shapes = ['a', '', null, undefined, Number.NaN, 1, -2.5, 3n, true, false, 'x,y', 'he said "hi"', 'a\r\nb', ' pad '];
const quoted = '"a","","","","","1","-2.5","3","true","false","x,y","he said ""hi""","a\r\nb"," pad "\r\n';
const cells = ['a', '', '', '', '', '1', '-2.5', '3', 'true', 'false', 'x,y', 'he said "hi"', 'a\r\nb', ' pad '];

describe('csv: quoteAll quotes every written field', () => {
  it('keeps the default bytes when absent, false or null', () => {
    const rows = [shapes, { a: 1, 'b,c': 'x' }, [], ['']];
    const original = stringifyCsv(rows);
    strictEqual(original, 'a,,,,,1,-2.5,3,true,false,"x,y","he said ""hi""","a\r\nb"," pad "\r\na,"b,c"\r\n1,x\r\n\r\n\r\n');
    strictEqual(stringifyCsv(rows, { quoteAll: false }), original);
    strictEqual(stringifyCsv(rows, { quoteAll: null }), original);
  });

  it('quotes text, empty, absent, numeric and boolean fields alike', () => {
    strictEqual(stringifyCsv([shapes], { quoteAll: true }), quoted);
    const when = new Date(Date.UTC(2026, 0, 2));
    strictEqual(stringifyCsv([[when, { k: 'v' }, [1, 2]]], { quoteAll: true }),
      '"2026-01-02T00:00:00.000Z","{""k"":""v""}","[1,2]"\r\n');
  });

  it('writes an absent field as "" exactly as the empty string', () => {
    // a reader cannot tell the two apart in either mode: the default writes
    // both bare and empty, quoteAll writes both as ""
    strictEqual(stringifyCsv([['', null, undefined]], { quoteAll: true }), '"","",""\r\n');
    strictEqual(stringifyCsv([{ a: '', b: null }, { a: undefined }], { quoteAll: true }), '"a","b"\r\n"",""\r\n"",""\r\n');
  });

  it('quotes a lone empty field but leaves a record of no fields an empty line', () => {
    strictEqual(stringifyCsv([[]], { quoteAll: true }), '\r\n');
    strictEqual(stringifyCsv([['']], { quoteAll: true }), '""\r\n');
    strictEqual(stringifyCsv([[null]], { quoteAll: true }), '""\r\n');
    deepStrictEqual(parseCsv(stringifyCsv([[''], ['b']], { quoteAll: true })), [[''], ['b']]);
  });

  it('quotes the header row, whether it comes from object keys or an explicit field list', () => {
    strictEqual(stringifyCsv([{ id: 1, name: 'x' }], { quoteAll: true }), '"id","name"\r\n"1","x"\r\n');
    strictEqual(stringifyCsv([], { fields: ['id', 'na"me'], quoteAll: true }), '"id","na""me"\r\n');
    const formatter = createCsvRowFormatter({ fields: ['id'], quoteAll: true });
    strictEqual(formatter.tail(), '"id"\r\n');
    strictEqual(stringifyCsv([{ id: 1 }], { header: false, quoteAll: true }), '"1"\r\n');
  });

  it('puts the neutralizing prefix inside the quotes', () => {
    strictEqual(stringifyCsv([['=1+2', -12, "'=already", 'plain']], { quoteAll: true, neutralizeFormulas: true }),
      '"\'=1+2","\'-12","\'=already","plain"\r\n');
    strictEqual(stringifyCsv([], { fields: ['=h'], quoteAll: true, neutralizeFormulas: true }), '"\'=h"\r\n');
  });

  it('uses a custom quote, delimiter and terminator, doubling the quote inside', () => {
    const custom = { quoteAll: true, neutralizeFormulas: true, quote: "'", delimiter: ';', newline: '\n' };
    strictEqual(stringifyCsv([['=a', "it's", 1]], custom), "'''=a';'it''s';'1'\n");
    deepStrictEqual(parseCsv(stringifyCsv([['=a', "it's", 1]], custom), { quote: "'", delimiter: ';' }), [["'=a", "it's", '1']]);
    strictEqual(stringifyCsv([['a', 'b']], { quoteAll: true, quote: null }), '"a","b"\r\n', 'a null quote keeps the default');
  });

  it('agrees across every writer', async () => {
    const rows = [{ id: 1, note: 'x,y' }, { id: null, note: 'he said "hi"' }];
    const options = { quoteAll: true };
    const whole = stringifyCsv(rows, options);
    strictEqual(whole, '"id","note"\r\n"1","x,y"\r\n"","he said ""hi"""\r\n');
    strictEqual([...stringifyCsvChunks(rows, options)].join(''), whole);
    strictEqual(await drain(stringifyCsvStream(rows, options)), whole);
    strictEqual(createCsvStreamWriter(options).writeAll(rows).end(), whole);
    const formatter = createCsvRowFormatter(options);
    strictEqual(rows.flatMap((row) => formatter.lines(row)).join('') + formatter.tail(), whole);
  });

  it('reads back to the same cell text', () => {
    deepStrictEqual(parseCsv(stringifyCsv([shapes, shapes], { quoteAll: true })), [cells, cells]);
    const header = cells.map((_, i) => `c${i}`);
    const record = Object.fromEntries(header.map((name, i) => [name, shapes[i]]));
    const expected = Object.fromEntries(header.map((name, i) => [name, cells[i]]));
    deepStrictEqual(parseCsv(stringifyCsv([record], { quoteAll: true }), { headers: true }), [expected]);
    // a quoted cell is never coerced, so typed reading keeps the text, and
    // only emptyAsNull reads "" as null
    deepStrictEqual(parseCsv(stringifyCsv([[1, true, '']], { quoteAll: true }), { typed: true }), [['1', 'true', '']]);
    deepStrictEqual(parseCsv(stringifyCsv([[1, null, '']], { quoteAll: true }), { emptyAsNull: true }), [['1', null, null]]);
  });

  it('refuses a quoteAll that is not a boolean, at every writer', async () => {
    const message = 'options.quoteAll must be true or false';
    for (const value of ['yes', 1, 'true'])
      for (const write of [
        (/** @type {any} */ options) => stringifyCsv([['a']], options),
        (/** @type {any} */ options) => [...stringifyCsvChunks([['a']], options)],
        (/** @type {any} */ options) => createCsvRowFormatter(options),
        (/** @type {any} */ options) => createCsvStreamWriter(options),
      ])
        throws(() => write({ quoteAll: value }), { name: 'TypeError', message });
    await rejects(drain(stringifyCsvStream([['a']], /** @type {any} */ ({ quoteAll: 'yes' }))), { name: 'TypeError', message });
  });

  it('refuses quoteAll with quoting disabled, which could not quote any field', async () => {
    const message = "options.quote must be a quote character when quoteAll is true; quote '' disables quoting";
    const options = { quoteAll: true, quote: '' };
    throws(() => stringifyCsv([['a']], options), { name: 'TypeError', message });
    throws(() => [...stringifyCsvChunks([['a']], options)], { name: 'TypeError', message });
    throws(() => createCsvRowFormatter(options), { name: 'TypeError', message });
    throws(() => createCsvStreamWriter(options), { name: 'TypeError', message });
    await rejects(drain(stringifyCsvStream([['a']], options)), { name: 'TypeError', message });
    strictEqual(stringifyCsv([['a,b']], { quoteAll: false, quote: '' }), 'a,b\r\n', 'quoting disabled still writes bare without quoteAll');
  });
});
