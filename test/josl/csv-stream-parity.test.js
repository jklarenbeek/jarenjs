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
  it('hands a record over the moment its line break arrives, however long the field before it', () => {
    // the rows read after each chunk, for chunks the reader may hold back
    const steps = [
      [['"a"', '\n'], [0, 1]],
      [['"a"', '\r\n'], [0, 1]],
      [['"ab', 'cd', '"\n'], [0, 0, 1]],
      [['"ab', 'cd"', '\n'], [0, 0, 1]],
      [['"ab', 'c""d', '"', '\n'], [0, 0, 0, 1]],
      [['"ab\n', 'cd', '"\n'], [0, 0, 1]],
      [['"a"b', 'c', '\n'], [0, 0, 1]],
      [['"a"b', 'c', '\rx'], [0, 0, 1]],
      [['"a"b', 'c', ',d\n'], [0, 0, 1]],
    ];
    for (const [chunks, expected] of /** @type {[string[], number[]][]} */ (steps)) {
      const reader = createCsvStreamReader({ repair: true });
      const seen = chunks.map((chunk) => (reader.feed(chunk), reader.rows().length));
      assert.deepEqual(seen, expected, JSON.stringify(chunks));
    }
  });

  it('refuses an oversized field while it is still being fed, not when the stream ends', () => {
    for (const limit of ['maxFieldBytes', 'maxRecordBytes']) {
      for (const head of ['"', '"a"']) {
        const reader = createCsvStreamReader({ [limit]: 100 });
        let fed = 0;
        assert.throws(() => {
          for (; fed < 50; fed++) reader.feed(fed === 0 ? head + 'b'.repeat(10) : 'b'.repeat(10));
        }, (/** @type {any} */ e) => e.code === (limit === 'maxFieldBytes' ? 'CSV2003' : 'CSV2002'), `${limit} after ${head}`);
        assert.ok(fed < 50, `${limit} after ${head}: refused at chunk ${fed}`);
      }
    }
  });

  it('reads a long field the same at every chunk size when the chunks around it hold no quote', () => {
    const run = 'b'.repeat(40);
    const texts = [
      `"${run}`,
      `"a"${run}`,
      `"${run}"\n"${run}""${run}",x\n`,
      `"a"${run},c\n"${run}"${run}"\n`,
      `h1,h2\n"${run}\n${run}"${run}\r\nx,"y"${run}"z"\n`,
    ];
    for (const text of texts) {
      for (const options of [{ repair: true }, { repair: true, headers: true }]) {
        const whole = parseCsvDocument(text, options);
        const expected = { rows: whole.rows, repairs: whole.repairs.map((r) => `${r.code}@${r.line}:${r.column}`) };
        for (const size of [1, 7, 16, 41, 64]) {
          assert.deepEqual(chunked(text, options, size), expected, `${JSON.stringify(text)} in chunks of ${size}`);
        }
      }
    }
  });

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

  it('skips a comment line that holds the quote character, wherever the chunks split it', () => {
    const text = 'a,b\n# note,"x\nc,"d\ne"\nf,g\n';
    const expected = [['a', 'b'], ['c', 'd\ne'], ['f', 'g']];
    for (const options of [{ comment: '#' }, { comment: '#', repair: true }]) {
      assert.deepEqual(parseCsvDocument(text, options).rows, expected);
      for (const size of [1, 2, 5, 9, 1000]) {
        assert.deepEqual(chunked(text, options, size).rows, expected, `chunks of ${size}`);
      }
    }
  });

  it('hands over the record after a comment line that holds the quote character as its line break arrives', () => {
    const steps = [
      [['a,b\n', '# note,"x\n', 'c,d\n'], [1, 1, 2]],
      [['a,b\n', '# n,', '"x\n', 'c,d\n'], [1, 1, 1, 2]],
      [['# n,"x\r', '\nc,d\n', 'e,f\n'], [0, 1, 2]],
    ];
    for (const [chunks, expected] of /** @type {[string[], number[]][]} */ (steps)) {
      const reader = createCsvStreamReader({ comment: '#' });
      const seen = chunks.map((chunk) => (reader.feed(chunk), reader.rows().length));
      assert.deepEqual(seen, expected, JSON.stringify(chunks));
    }
  });

  it('reports a maxFieldBytes refusal on the line a whole read reports, past a comment holding a quote', () => {
    const text = `a\n# x,"q\nb\n${'x'.repeat(44)}\n`;
    const options = { comment: '#', maxFieldBytes: 30 };
    const lineOf = (/** @type {() => unknown} */ read) => {
      try {
        read();
      }
      catch (error) {
        return /** @type {any} */ (error).code + '@' + /** @type {any} */ (error).line;
      }
      return 'read';
    };
    assert.equal(lineOf(() => parseCsvDocument(text, options)), 'CSV2003@4');
    for (const size of [1, 3, 5, 1000]) {
      assert.equal(lineOf(() => chunked(text, options, size)), 'CSV2003@4', `chunks of ${size}`);
    }
  });

  it('reads records whose pending head is long the same at every chunk size', () => {
    const run = 'b'.repeat(700);
    const texts = [
      `# ${run},"${run}\na,b\n`,
      `a,${run}"${run}\r${run}\r\n${run}\n`,
      `"${run}"x"${run}\n${run}","${run}"y\n`,
      `x\n"${run}\n${run}""${run}"\r${run}"z\n`,
      `${run},${run}\r${run}`,
      `${run}#a,${'c'.repeat(696)},"q\nr"\nz\n`,
      `${'b'.repeat(699)},#a,"q\nr"\nz\n`,
    ];
    for (const text of texts) {
      for (const options of [{ comment: '#', repair: true }, { comment: '#', repair: true, headers: true }]) {
        const whole = parseCsvDocument(text, options);
        const expected = { rows: whole.rows, repairs: whole.repairs.map((r) => `${r.code}@${r.line}:${r.column}`) };
        for (const size of [100, 511, 513, 700, 1500]) {
          assert.deepEqual(chunked(text, options, size), expected, `${JSON.stringify(text.slice(0, 20))} in chunks of ${size}`);
        }
      }
    }
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
