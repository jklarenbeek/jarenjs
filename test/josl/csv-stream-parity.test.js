//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsvDocument, createCsvStreamReader, iterateCsvStream, CsvSyntaxError } from '@jarenjs/josl';

/** @param {string} text @param {any} options @param {number} size */
function chunked(text, options, size) {
  const reader = createCsvStreamReader(options);
  for (let i = 0; i < text.length; i += size) reader.feed(text.slice(i, i + size));
  return { rows: reader.end(), repairs: reader.repairs().map((/** @type {any} */ r) => `${r.code}@${r.line}:${r.column}`) };
}

describe('a chunked CSV read says what the whole document says', () => {
  it('reads repaired text the same at every chunk size', () => {
    // `""b` closes an empty quoted field and absorbs `b`; the next line opens a
    // quote that stays open to the end, newlines included
    const text = '""b\n"\n\n';
    const whole = parseCsvDocument(text, { repair: true });
    assert.deepEqual(whole.rows, [['b'], ['\n\n']]);
    for (const size of [1, 2, 3, 64]) {
      assert.deepEqual(chunked(text, { repair: true }, size).rows, [['b'], ['\n\n']], `chunks of ${size}`);
    }
  });

  it('counts a column from the start of its line when a bare CR ends the line before', () => {
    const text = 'a,b\r1,"x"y\r3,"z"w\r';
    const expected = ['CSV1006@1:4', 'CSV1002@2:5', 'CSV1006@2:7', 'CSV1002@3:5', 'CSV1006@3:7'];
    const whole = parseCsvDocument(text, { repair: true, headers: true });
    assert.deepEqual(whole.repairs.map((r) => `${r.code}@${r.line}:${r.column}`), expected);
    for (const size of [1, 4, 64]) {
      assert.deepEqual(chunked(text, { repair: true, headers: true }, size).repairs, expected, `chunks of ${size}`);
    }
    // the same table with LF endings reports the same columns
    const lf = parseCsvDocument('a,b\n1,"x"y\n3,"z"w\n', { repair: true, headers: true });
    assert.deepEqual(lf.repairs.map((r) => `${r.code}@${r.line}:${r.column}`), ['CSV1002@2:5', 'CSV1002@3:5']);
  });

  it('refuses stray text after a closing quote when its line ends, not when the stream does', async () => {
    let pulled = 0;
    async function* endless() {
      yield 'a,b\n"x"y,2\n';
      for (;;) {
        pulled++;
        if (pulled > 50) throw new Error('the reader never refused the stray quote');
        yield '1,2\n';
      }
    }
    await assert.rejects(async () => {
      for await (const _row of iterateCsvStream(endless(), { headers: true })) { /* drain */ }
    }, (/** @type {any} */ error) => {
      assert.ok(error instanceof CsvSyntaxError);
      assert.equal(error.code, 'CSV1002');
      assert.equal(error.line, 2);
      assert.equal(error.column, 3);
      return true;
    });
    assert.ok(pulled <= 1, `pulled ${pulled} chunks after the bad line`);
  });
});
