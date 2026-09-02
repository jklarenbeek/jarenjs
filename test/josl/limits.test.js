import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual, throws, ok } from 'node:assert';

import {
  parseCsv,
  createCsvStreamReader,
  parseJosl,
  createStreamReader,
  createJsonxStreamReader,
  JoslLimitError,
  CSV_LIMIT_CODES,
  JOSL_LIMIT_CODES,
  JSONX_LIMIT_CODES,
} from '@jarenjs/josl';

/**
 * Feed a document one character at a time — the split every limit must
 * survive — through a reader factory, and answer what it did.
 * @param {(options: object) => { feed(chunk: string): void, end(): any }} make
 * @param {string} text
 * @param {object} options
 */
function fedByOne(make, text, options) {
  const reader = make(options);
  for (const ch of text)
    reader.feed(ch);
  return reader.end();
}

/** The code a limited read throws, or null when it passes. */
function codeOf(fn) {
  try {
    fn();
    return null;
  }
  catch (e) {
    if (!(e instanceof JoslLimitError))
      throw e;
    return e.code;
  }
}

describe('limits: the tables and the option rule', () => {
  it('names the codes with their option, and every option is a positive integer or Infinity', () => {
    deepStrictEqual(Object.keys(CSV_LIMIT_CODES), ['CSV2001', 'CSV2002', 'CSV2003', 'CSV2004']);
    deepStrictEqual(Object.keys(JOSL_LIMIT_CODES), ['JOSL2001', 'JOSL2002', 'JOSL2003', 'JOSL2004', 'JOSL2005']);
    deepStrictEqual(Object.keys(JSONX_LIMIT_CODES), ['JSONX2001', 'JSONX2002', 'JSONX2003', 'JSONX2004']);
    ok(Object.isFrozen(CSV_LIMIT_CODES) && Object.isFrozen(JOSL_LIMIT_CODES) && Object.isFrozen(JSONX_LIMIT_CODES));
    for (const bad of [0, -1, 1.5, '10', NaN]) {
      throws(() => parseCsv('a', { maxTotalBytes: bad }), TypeError, `csv ${String(bad)}`);
      throws(() => parseJosl('a = 1', { maxDepth: bad }), TypeError, `josl ${String(bad)}`);
      throws(() => createJsonxStreamReader({ maxTokenBytes: bad }), TypeError, `jsonx ${String(bad)}`);
    }
    // Infinity and absence are the same: no limit
    deepStrictEqual(parseCsv('a,b\n1,2', { maxTotalBytes: Infinity, maxColumns: Infinity }), [['a', 'b'], ['1', '2']]);
    const e = new JoslLimitError('CSV2003', 'a field exceeds maxFieldBytes', 8, 3);
    strictEqual(e.name, 'JoslLimitError');
    strictEqual(e.message, 'CSV2003: a field exceeds maxFieldBytes (maxFieldBytes 8) at line 3');
    strictEqual(e.limit, 8);
    strictEqual(e.line, 3);
  });
});

describe('limits: CSV', () => {
  const make = (options) => createCsvStreamReader(options);

  it('CSV2001 maxTotalBytes counts UTF-8 bytes: exact passes, one more refuses, whole and by the character', () => {
    const text = 'a,b\nhé,ü\n'; // 'é' and 'ü' are two bytes each: 11 bytes, 9 code units
    strictEqual(new TextEncoder().encode(text).byteLength, 11);
    deepStrictEqual(parseCsv(text, { maxTotalBytes: 11 }), [['a', 'b'], ['hé', 'ü']]);
    strictEqual(codeOf(() => parseCsv(text, { maxTotalBytes: 10 })), 'CSV2001');
    deepStrictEqual(fedByOne(make, text, { maxTotalBytes: 11 }), [['a', 'b'], ['hé', 'ü']]);
    strictEqual(codeOf(() => fedByOne(make, text, { maxTotalBytes: 10 })), 'CSV2001');
    strictEqual(codeOf(() => fedByOne(make, text, { maxTotalBytes: 9 })), 'CSV2001', 'nine code units are not nine bytes');
  });

  it('CSV2002 maxRecordBytes bounds one record, quoted newlines included, before the record is concatenated', () => {
    const doc = 'a,b\n"multi\nline",4\n';
    deepStrictEqual(parseCsv(doc, { maxRecordBytes: 15 }), [['a', 'b'], ['multi\nline', '4']]);
    strictEqual(codeOf(() => parseCsv(doc, { maxRecordBytes: 14 })), 'CSV2002');
    deepStrictEqual(fedByOne(make, doc, { maxRecordBytes: 15 }), [['a', 'b'], ['multi\nline', '4']]);
    strictEqual(codeOf(() => fedByOne(make, doc, { maxRecordBytes: 14 })), 'CSV2002');
    // a record that never terminates is refused while it is still being cut
    const reader = createCsvStreamReader({ maxRecordBytes: 8 });
    reader.feed('"');
    let code = null;
    try {
      for (let i = 0; i < 20; i++)
        reader.feed('x');
    }
    catch (e) {
      code = e instanceof JoslLimitError ? e.code : e;
    }
    strictEqual(code, 'CSV2002', 'an open quoted field crossed the bound one character at a time');
  });

  it('CSV2003 maxFieldBytes bounds one field: a huge quoted field split into one-character chunks, a plain field, a doubled quote, multi-byte text', () => {
    const quoted = 'a,b\n"' + 'x'.repeat(16) + '",2\n';
    deepStrictEqual(fedByOne(make, quoted, { maxFieldBytes: 18 })[1][0], 'x'.repeat(16));
    strictEqual(codeOf(() => fedByOne(make, quoted, { maxFieldBytes: 17 })), 'CSV2003');
    strictEqual(codeOf(() => parseCsv(quoted, { maxFieldBytes: 17 })), 'CSV2003');
    const plain = 'a,b\n' + 'y'.repeat(16) + ',2\n';
    deepStrictEqual(parseCsv(plain, { maxFieldBytes: 16 })[1][0], 'y'.repeat(16));
    strictEqual(codeOf(() => parseCsv(plain, { maxFieldBytes: 15 })), 'CSV2003');
    strictEqual(codeOf(() => fedByOne(make, plain, { maxFieldBytes: 15 })), 'CSV2003');
    const escaped = 'a\n"' + 'z'.repeat(6) + '""' + 'z'.repeat(6) + '"\n';
    strictEqual(codeOf(() => parseCsv(escaped, { maxFieldBytes: 10 })), 'CSV2003', 'checked before the escaped halves are joined');
    deepStrictEqual(parseCsv(escaped, { maxFieldBytes: 16 })[1], ['zzzzzz"zzzzzz']);
    const wide = 'a\n' + 'é'.repeat(4) + '\n'; // 8 bytes, 4 code units
    deepStrictEqual(parseCsv(wide, { maxFieldBytes: 8 })[1], ['éééé']);
    strictEqual(codeOf(() => parseCsv(wide, { maxFieldBytes: 7 })), 'CSV2003');
    strictEqual(codeOf(() => parseCsv(wide, { maxFieldBytes: 4 })), 'CSV2003', 'four code units are eight bytes');
  });

  it('CSV2004 maxColumns bounds a record before its extra cell is pushed, in strict and repair mode alike', () => {
    deepStrictEqual(parseCsv('a,b,c\n1,2,3\n', { maxColumns: 3 }), [['a', 'b', 'c'], ['1', '2', '3']]);
    strictEqual(codeOf(() => parseCsv('a,b,c\n1,2,3,4\n', { maxColumns: 3 })), 'CSV2004');
    strictEqual(codeOf(() => fedByOne(make, 'a,b,c\n1,2,3,4\n', { maxColumns: 3 })), 'CSV2004');
    strictEqual(codeOf(() => parseCsv('a,b,c\n1,2,3,4\n', { maxColumns: 3, repair: true, headers: true })), 'CSV2004',
      'a limit is never a repair');
    const many = Array.from({ length: 1000 }, (_, i) => i).join(',') + '\n';
    strictEqual(codeOf(() => parseCsv(many, { maxColumns: 999 })), 'CSV2004');
    strictEqual(parseCsv(many, { maxColumns: 1000 })[0].length, 1000);
  });
});

describe('limits: JOSL', () => {
  const make = (options) => createStreamReader(options);

  it('JOSL2001 maxTotalBytes counts UTF-8 bytes across chunks', () => {
    const text = 'k = "hé"\n'; // 10 bytes, 9 code units
    deepStrictEqual(parseJosl(text, { maxTotalBytes: 10 }), { k: 'hé' });
    strictEqual(codeOf(() => parseJosl(text, { maxTotalBytes: 9 })), 'JOSL2001');
    deepStrictEqual(fedByOne(make, text, { maxTotalBytes: 10 }), { k: 'hé' });
    strictEqual(codeOf(() => fedByOne(make, text, { maxTotalBytes: 9 })), 'JOSL2001');
  });

  it('JOSL2002 maxRecordBytes bounds one logical line, a multi-line string included, while it is still being cut', () => {
    const line = 'k = "' + 'x'.repeat(10) + '"\n'; // 17 bytes with the newline; the line itself 16
    deepStrictEqual(fedByOne(make, line, { maxRecordBytes: 16 }), { k: 'x'.repeat(10) });
    strictEqual(codeOf(() => fedByOne(make, line, { maxRecordBytes: 15 })), 'JOSL2002');
    strictEqual(codeOf(() => parseJosl(line, { maxRecordBytes: 15 })), 'JOSL2002');
    const ml = 'k = """\nab\ncd"""\n';
    deepStrictEqual(parseJosl(ml, { maxRecordBytes: 16 }), { k: 'ab\ncd' });
    strictEqual(codeOf(() => parseJosl(ml, { maxRecordBytes: 15 })), 'JOSL2002');
    // an unterminated line is refused chunk by chunk, before any newline
    const reader = createStreamReader({ maxRecordBytes: 8 });
    reader.feed('k = "');
    let code = null;
    try {
      for (let i = 0; i < 20; i++)
        reader.feed('y');
    }
    catch (e) {
      code = e instanceof JoslLimitError ? e.code : e;
    }
    strictEqual(code, 'JOSL2002');
  });

  it('JOSL2003 maxTokenBytes bounds a string token or a key, in UTF-8 bytes', () => {
    deepStrictEqual(parseJosl('k = "éé"\n', { maxTokenBytes: 6 }), { k: 'éé' });
    strictEqual(codeOf(() => parseJosl('k = "éé"\n', { maxTokenBytes: 5 })), 'JOSL2003', 'the quoted token is six bytes');
    strictEqual(codeOf(() => parseJosl("k = 'abcdef'\n", { maxTokenBytes: 7 })), 'JOSL2003', 'eight bytes with its quotes');
    deepStrictEqual(parseJosl("k = 'abcde'\n", { maxTokenBytes: 7 }), { k: 'abcde' });
    strictEqual(codeOf(() => parseJosl('longkey = 1\n', { maxTokenBytes: 6 })), 'JOSL2003');
    deepStrictEqual(parseJosl('longky = 1\n', { maxTokenBytes: 6 }), { longky: 1 });
    strictEqual(codeOf(() => parseJosl('k = """\nabcdefgh"""\n', { maxTokenBytes: 8 })), 'JOSL2003');
    strictEqual(codeOf(() => fedByOne(make, 'k = "abcdefgh"\n', { maxTokenBytes: 9 })), 'JOSL2003');
  });

  it('JOSL2004 maxDepth bounds inline nesting and header path depth', () => {
    deepStrictEqual(parseJosl('k = [[[1]]]\n', { maxDepth: 3 }), { k: [[[1]]] });
    strictEqual(codeOf(() => parseJosl('k = [[[1]]]\n', { maxDepth: 2 })), 'JOSL2004');
    strictEqual(codeOf(() => parseJosl('k = { a = { b = { c = 1 } } }\n', { maxDepth: 2 })), 'JOSL2004');
    deepStrictEqual(parseJosl('[a.b.c]\nx = 1\n', { maxDepth: 3 }), { a: { b: { c: { x: 1 } } } });
    strictEqual(codeOf(() => parseJosl('[a.b.c]\nx = 1\n', { maxDepth: 2 })), 'JOSL2004');
    strictEqual(codeOf(() => fedByOne(make, 'k = [[[[1]]]]\n', { maxDepth: 3 })), 'JOSL2004');
  });

  it('JOSL2005 maxRetainedValues counts what the root holds: pairs, array elements, tables, root items', () => {
    deepStrictEqual(parseJosl('a = 1\nb = [1, 2]\n', { maxRetainedValues: 4 }), { a: 1, b: [1, 2] });
    strictEqual(codeOf(() => parseJosl('a = 1\nb = [1, 2]\n', { maxRetainedValues: 3 })), 'JOSL2005');
    strictEqual(codeOf(() => parseJosl('[t]\na = 1\nb = 2\n', { maxRetainedValues: 2 })), 'JOSL2005');
    deepStrictEqual(parseJosl('[t]\na = 1\nb = 2\n', { maxRetainedValues: 3 }), { t: { a: 1, b: 2 } });
    strictEqual(codeOf(() => parseJosl('[[]]\na = 1\n[[]]\na = 2\n', { maxRetainedValues: 3 })), 'JOSL2005');
    deepStrictEqual(parseJosl('[[]]\na = 1\n[[]]\na = 2\n', { maxRetainedValues: 4 }), [{ a: 1 }, { a: 2 }]);
  });
});

describe('limits: JSONX (the stream reader)', () => {
  const make = (options) => createJsonxStreamReader(options);
  /** The whole text in one feed — the stream reader is the limited surface. */
  const parseJsonx = (text, options) => {
    const reader = make(options);
    reader.feed(text);
    return reader.end();
  };

  it('JSONX2001 maxTotalBytes counts UTF-8 bytes across chunks', () => {
    const text = '{"k":"hé"}'; // 11 bytes, 10 code units
    deepStrictEqual(parseJsonx(text, { maxTotalBytes: 11 }), { k: 'hé' });
    strictEqual(codeOf(() => parseJsonx(text, { maxTotalBytes: 10 })), 'JSONX2001');
    deepStrictEqual(fedByOne(make, text, { maxTotalBytes: 11 }), { k: 'hé' });
    strictEqual(codeOf(() => fedByOne(make, text, { maxTotalBytes: 10 })), 'JSONX2001');
  });

  it('JSONX2002 maxTokenBytes bounds a string, a key, a number and a regexp, refused while the token is still arriving', () => {
    deepStrictEqual(fedByOne(make, '{"k":"abcdef"}', { maxTokenBytes: 8 }), { k: 'abcdef' });
    strictEqual(codeOf(() => fedByOne(make, '{"k":"abcdefg"}', { maxTokenBytes: 8 })), 'JSONX2002');
    strictEqual(codeOf(() => parseJsonx('{"k":"abcdefg"}', { maxTokenBytes: 8 })), 'JSONX2002');
    strictEqual(codeOf(() => parseJsonx('{"longkey":1}', { maxTokenBytes: 8 })), 'JSONX2002');
    strictEqual(codeOf(() => parseJsonx('[123456789]', { maxTokenBytes: 8 })), 'JSONX2002');
    deepStrictEqual(parseJsonx('[12345678]', { maxTokenBytes: 8 }), [12345678]);
    strictEqual(codeOf(() => parseJsonx('[/abcdefg/i]', { maxTokenBytes: 8 })), 'JSONX2002');
    strictEqual(codeOf(() => parseJsonx('["éééé"]', { maxTokenBytes: 9 })), 'JSONX2002', 'six code units, ten bytes');
    // a string that never closes is refused by the chunk that crosses the bound
    const reader = createJsonxStreamReader({ maxTokenBytes: 8 });
    reader.feed('["');
    let code = null;
    try {
      for (let i = 0; i < 20; i++)
        reader.feed('q');
    }
    catch (e) {
      code = e instanceof JoslLimitError ? e.code : e;
    }
    strictEqual(code, 'JSONX2002');
  });

  it('JSONX2003 maxDepth bounds container nesting', () => {
    deepStrictEqual(parseJsonx('[[[1]]]', { maxDepth: 3 }), [[[1]]]);
    strictEqual(codeOf(() => parseJsonx('[[[1]]]', { maxDepth: 2 })), 'JSONX2003');
    strictEqual(codeOf(() => parseJsonx('{"a":{"b":{"c":1}}}', { maxDepth: 2 })), 'JSONX2003');
    strictEqual(codeOf(() => fedByOne(make, '[[[[1]]]]', { maxDepth: 3 })), 'JSONX2003');
  });

  it('JSONX2004 maxRetainedValues counts linked values only: a detached value is never retained', () => {
    deepStrictEqual(parseJsonx('{"a":1,"b":[1,2]}', { maxRetainedValues: 4 }), { a: 1, b: [1, 2] });
    strictEqual(codeOf(() => parseJsonx('{"a":1,"b":[1,2]}', { maxRetainedValues: 3 })), 'JSONX2004');
    const reader = createJsonxStreamReader({ detach: ['rows', '*'], maxRetainedValues: 1 });
    reader.feed('{"rows":[{"n":1},{"n":2},{"n":3}]}');
    deepStrictEqual(reader.end(), { rows: [] }, 'three detached records never counted');
    strictEqual(codeOf(() => parseJsonx('{"rows":[{"n":1},{"n":2}]}', { maxRetainedValues: 3 })), 'JSONX2004');
  });
});
