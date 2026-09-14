/** Public CSV export-policy qualification, reused by source and installed hosts. */
import assert from 'node:assert/strict';
import { stringifyCsv, stringifyCsvChunks, parseCsv, createCsvRowFormatter, formatCsvValue } from '@jarenjs/josl/csv';
import { stringifyCsvStream, createCsvStreamWriter, iterateCsvStream } from '@jarenjs/josl/csv-stream';

const row = ['=1+1', '+1', '-1', '@SUM(A1)', '\tvalue', '\rvalue', '\nvalue', -1, -2n, "'=1+1", 'plain', null, undefined, '', 0, false, ' =no', '＝full'];
const text = ["'=1+1", "'+1", "'-1", "'@SUM(A1)", "'\tvalue", "'\rvalue", "'\nvalue", "'-1", "'-2", "'=1+1", 'plain', '', '', '', '0', 'false', ' =no', '＝full'];

export function qualifyCsvPolicy() {
  const original = '=1+1,+1,-1,@SUM(A1),"\tvalue","\rvalue","\nvalue",-1,-2,\'=1+1,plain,,,,0,false," =no",＝full\r\n';
  assert.equal(stringifyCsv([row]), original);
  assert.equal(stringifyCsv([row], { neutralizeFormulas: false }), original);
  assert.deepEqual(parseCsv(stringifyCsv([row], { neutralizeFormulas: true })), [text]);
  assert.equal(formatCsvValue('=1+1'), '=1+1');
  const fields = ['=header', '+header', '-header', '@header', '\theader', '\rheader', '\nheader'];
  const expectedHeader = ["'=header", "'+header", "'-header", "'@header", "'\theader", "'\rheader", "'\nheader"];
  const options = { fields, neutralizeFormulas: true };
  assert.deepEqual(parseCsv(stringifyCsv([], options)), [expectedHeader]);
  assert.deepEqual(parseCsv(stringifyCsv([Object.fromEntries(fields.map(field => [field, '=value']))], options)),
    [expectedHeader, Array(7).fill("'=value")]);
  const formatter = createCsvRowFormatter(options);
  assert.deepEqual(parseCsv(formatter.tail()), [expectedHeader]); assert.equal(formatter.tail(), '');
  assert.deepEqual(fields, ['=header', '+header', '-header', '@header', '\theader', '\rheader', '\nheader']);
}

export function qualifyCsvDialects() {
  const rows = [['=1;"2\n3', -12, "'already", null]];
  assert.equal(stringifyCsv(rows, { neutralizeFormulas: true, delimiter: ';' }), '"\'=1;""2\n3";\'-12;\'already;\r\n');
  const custom = { neutralizeFormulas: true, delimiter: ';', quote: "'", newline: '\n' };
  assert.equal(stringifyCsv([['=a;b', -3]], custom), "'''=a;b';'''-3'\n");
  assert.deepEqual(parseCsv(stringifyCsv(rows, custom), { delimiter: ';', quote: "'" }), [["'=1;\"2\n3", "'-12", "'already", '']]);
  assert.equal(stringifyCsv([['=a,b', '-1']], { neutralizeFormulas: true, quote: '' }), "'=a,b,'-1\r\n");
  assert.equal(stringifyCsv([{ '=header': '=value' }], { neutralizeFormulas: true, header: false }), "'=value\r\n");
}

export async function qualifyCsvWriters() {
  for (const [rows, options] of [
    [[row], { neutralizeFormulas: true }],
    [[row], {}],
    [[{ '=header': '=a,"b\nc', value: -1 }], { neutralizeFormulas: true }],
    [[], { fields: ['=header', '-header'], neutralizeFormulas: true }],
    [[['=a;b', "'@already"]], { neutralizeFormulas: true, delimiter: ';', quote: "'", newline: '\n' }],
  ]) {
    const whole = stringifyCsv(rows, options);
    assert.equal([...stringifyCsvChunks(rows, options)].join(''), whole);
    const pulled = [];
    for await (const chunk of stringifyCsvStream((async function* () { yield* rows; })(), options)) pulled.push(chunk);
    assert.equal(pulled.join(''), whole);
    const writer = createCsvStreamWriter(options); writer.writeAll(rows); assert.equal(writer.end(), whole);
    const chunks = [], sink = createCsvStreamWriter({ ...options, onChunk: chunk => chunks.push(chunk) });
    for (const record of rows) sink.write(record);
    assert.equal(sink.end(), ''); assert.equal(chunks.join(''), whole);
    const bytes = new TextEncoder().encode(whole), expected = parseCsv(whole, options);
    // Independent reader oracle across every byte split, including UTF-8,
    // embedded CR/LF, quote escapes and the apostrophe prefix boundary.
    for (let split = 0; split <= bytes.length; split++) {
      const actual = [], decoder = new TextDecoder();
      const chunks = [decoder.decode(bytes.slice(0, split), { stream: true }), decoder.decode(bytes.slice(split))];
      for await (const parsed of iterateCsvStream(chunks, options)) actual.push(parsed);
      assert.deepEqual(actual, expected);
    }
  }
}
