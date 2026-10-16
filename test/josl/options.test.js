import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual, throws, ok, rejects } from 'node:assert';

import {
  parseCsv,
  parseCsvDocument,
  sniffCsvDialect,
  stringifyCsv,
  stringifyCsvChunks,
  createCsvStreamReader,
  parseCsvStream,
  iterateCsvStream,
  stringifyCsvStream,
  createCsvStreamWriter,
  parseJosl,
  parseToml,
  parseJoslCst,
  parseTomlCst,
  createStreamReader,
  parseJoslStream,
  iterateJoslStream,
  stringifyJosl,
  stringifyToml,
  createStreamWriter,
  stringifyJoslChunks,
  stringifyJoslStream,
  toGbnf,
  parseJsonx,
  stringifyJsonx,
  createJsonxStreamReader,
  parseJsonxStream,
} from '@jarenjs/josl';
import { createCsvRowFormatter } from '@jarenjs/josl/csv';

/** The exact refusal: a TypeError with this message. @param {() => unknown} fn @param {string} message */
const refuses = (fn, message) => throws(fn, (e) => e instanceof TypeError && e.message === message);

/** Drain an async iterable. @param {AsyncIterable<any>} source */
async function drain(source) {
  const out = [];
  for await (const item of source) out.push(item);
  return out;
}

describe('josl: a misspelt or mistyped option is refused, never ignored', () => {
  it('refuses the members that used to change a parse or disable a guard in silence', () => {
    const wide = Array.from({ length: 50 }, (_, i) => 'c' + i).join(',') + '\n';
    refuses(() => parseCsv(wide, { maxColumn: 10 }), "parseCsv: unknown option 'maxColumn' — did you mean 'maxColumns'?");
    refuses(() => parseCsv('a;b\n1;2', { delimeter: ';' }), "parseCsv: unknown option 'delimeter' — did you mean 'delimiter'?");
    refuses(() => parseJosl('a = [[[1]]]', { maxDepht: 2 }), "parseJosl: unknown option 'maxDepht' — did you mean 'maxDepth'?");
    refuses(() => stringifyCsv([{ a: 1 }], { heder: false }), "stringifyCsv: unknown option 'heder' — did you mean 'header'?");
    refuses(() => stringifyCsv([{ a: 1 }], { header: 'no' }), 'options.header must be true or false');
    refuses(() => parseCsv('a,b\n1,2', { headers: 'yes' }), 'options.headers must be true, false or an array of column names');
    refuses(() => parseJsonx('{a:1}', { mode: 'JSON' }), "options.mode must be 'jsonx' or 'json'");
    refuses(() => stringifyJsonx({ a: 1 }, { mode: 'JSON' }), "options.mode must be 'jsonx' or 'json'");
    refuses(() => parseJosl('a = 1', { mode: 'TOML' }), "options.mode must be 'josl' or 'toml'");
  });

  it('refuses a limit on parseJsonx by naming the stream reader that enforces it', () => {
    for (const limit of ['maxDepth', 'maxTotalBytes', 'maxTokenBytes', 'maxRetainedValues']) {
      refuses(() => parseJsonx('[1]', { [limit]: 64 }),
        `parseJsonx: '${limit}' is a limit of the JSONX stream reader — read with createJsonxStreamReader or parseJsonxStream to enforce it`);
    }
    deepStrictEqual(parseJsonxReaderEnforces(), 'JSONX2003');
  });

  it('refuses options that are not a plain object, and reads null as none', () => {
    refuses(() => parseCsv('a', 'headers'), 'parseCsv: options must be a plain object');
    refuses(() => parseJosl('a = 1', ['toml']), 'parseJosl: options must be a plain object');
    deepStrictEqual(parseCsv('a,b', null), [['a', 'b']]);
    deepStrictEqual(parseJosl('a = 1', null), { a: 1 });
    strictEqual(stringifyCsv([[1, 2]], null), '1,2\r\n');
    deepStrictEqual(parseJsonx('[1]', null), [1]);
    deepStrictEqual(parseCsv('a,b', Object.assign(Object.create(null), { headers: ['x', 'y'] })), [{ x: 'a', y: 'b' }]);
    deepStrictEqual(parseCsv('a,b', { headers: undefined, typed: undefined }), [['a', 'b']]);
  });

  it('refuses wrong-typed switches and callbacks on every family', () => {
    refuses(() => parseCsv('a', { repair: 'yes' }), 'options.repair must be true or false');
    refuses(() => parseCsv('a', { onRepair: 'log' }), 'options.onRepair must be a function');
    refuses(() => createJsonxStreamReader({ partialText: 1 }), 'options.partialText must be true or false');
    refuses(() => stringifyJosl({ a: null }, { onNull: 'skip' }), "options.onNull must be 'error' or 'omit'");
    refuses(() => stringifyJosl({ a: /x/ }, { onRegExp: true }), "options.onRegExp must be 'error' or 'string'");
    refuses(() => createStreamWriter({ buffer: 'no' }), 'options.buffer must be true or false');
    refuses(() => toGbnf({ mode: 'TOML' }), "options.mode must be 'josl' or 'toml'");
    refuses(() => stringifyJsonx([1], { indent: true }), 'options.indent must be a number or a string');
    refuses(() => createCsvStreamWriter({ onChunk: 'sink' }), 'options.onChunk must be a function');
    refuses(() => createCsvRowFormatter({ fields: 'a,b' }), 'options.fields must be an array of column names');
  });
});

/** The stream reader enforces the limit parseJsonx refuses. */
function parseJsonxReaderEnforces() {
  const reader = createJsonxStreamReader({ maxDepth: 1 });
  try {
    reader.feed('[[1]]');
    reader.end();
    return 'none';
  }
  catch (e) {
    return /** @type {any} */ (e).code;
  }
}

describe('josl: every entry point admits exactly its own table', () => {
  it('the CSV readers', async () => {
    const all = { delimiter: ';', quote: "'", comment: '#', headers: true, repair: true, trim: true, typed: true,
      emptyAsNull: true, skipEmptyLines: true, onEvent: () => {}, onRepair: () => {},
      maxTotalBytes: 100, maxRecordBytes: 100, maxFieldBytes: 100, maxColumns: 10 };
    const text = "# note\na;b\n1;'x'\n";
    const rows = [{ a: 1, b: 'x' }];
    deepStrictEqual(parseCsv(text, all), rows);
    const reader = createCsvStreamReader(all);
    reader.feed(text);
    deepStrictEqual(reader.end(), rows);
    deepStrictEqual(await parseCsvStream([text], all), rows);
    deepStrictEqual(await drain(iterateCsvStream([text], { ...all, signal: new AbortController().signal })), rows);
    deepStrictEqual(parseCsvDocument(text, { ...all, delimiter: 'auto', headers: 'auto' }).rows, rows);
    strictEqual(sniffCsvDialect(text, { ...all, delimiter: 'auto' }).delimiter, ';');
    refuses(() => parseCsv(text, { ...all, signal: null }), "parseCsv: unknown option 'signal'; the options are "
      + 'delimiter, quote, comment, headers, repair, trim, typed, emptyAsNull, skipEmptyLines, onEvent, onRepair, '
      + 'maxTotalBytes, maxRecordBytes, maxFieldBytes, maxColumns');
    refuses(() => createCsvStreamReader({ header: true }), "createCsvStreamReader: unknown option 'header' — did you mean 'headers'?");
    await rejects(parseCsvStream([text], { types: true }), { message: "parseCsvStream: unknown option 'types' — did you mean 'typed'?" });
    await rejects(drain(iterateCsvStream([text], { signl: null })), { message: "iterateCsvStream: unknown option 'signl' — did you mean 'signal'?" });
    refuses(() => parseCsvDocument(text, { delimter: 'auto' }), "parseCsvDocument: unknown option 'delimter' — did you mean 'delimiter'?");
    refuses(() => sniffCsvDialect(text, { quotes: '"' }), "sniffCsvDialect: unknown option 'quotes' — did you mean 'quote'?");
    refuses(() => parseCsv(text, { headers: 'auto' }), 'options.headers must be true, false or an array of column names');
  });

  it('the CSV writers', async () => {
    const all = { delimiter: ';', quote: '"', newline: '\n', fields: ['a', 'b'], header: true, neutralizeFormulas: true };
    const rows = [{ a: '=1', b: 'x;y' }];
    const text = 'a;b\n\'=1;"x;y"\n';
    strictEqual(stringifyCsv(rows, all), text);
    strictEqual([...stringifyCsvChunks(rows, all)].join(''), text);
    strictEqual((await drain(stringifyCsvStream(rows, { ...all, signal: null }))).join(''), text);
    const chunks = [];
    const writer = createCsvStreamWriter({ ...all, onChunk: (c) => chunks.push(c) });
    writer.write(rows[0]);
    writer.end();
    strictEqual(chunks.join(''), text);
    strictEqual(createCsvRowFormatter(all).lines(rows[0]).join(''), text);
    refuses(() => stringifyCsv(rows, { onChunk: () => {} }), "stringifyCsv: unknown option 'onChunk'; the options are "
      + 'delimiter, quote, newline, fields, header, neutralizeFormulas');
    refuses(() => [...stringifyCsvChunks(rows, { newLine: '\n' })], "stringifyCsvChunks: unknown option 'newLine' — did you mean 'newline'?");
    await rejects(drain(stringifyCsvStream(rows, { signal: null, neutralize: true })),
      { message: "stringifyCsvStream: unknown option 'neutralize' — did you mean 'neutralizeFormulas'?" });
    refuses(() => createCsvStreamWriter({ fields: ['a'], onchunk: () => {} }),
      "createCsvStreamWriter: unknown option 'onchunk' — did you mean 'onChunk'?");
  });

  it('the JOSL and TOML readers', async () => {
    const all = { mode: 'josl', onEvent: () => {}, maxTotalBytes: 100, maxRecordBytes: 100, maxTokenBytes: 100,
      maxDepth: 4, maxRetainedValues: 100 };
    const text = 'a = [1]\n';
    deepStrictEqual(parseJosl(text, all), { a: [1] });
    const reader = createStreamReader(all);
    reader.feed(text);
    deepStrictEqual(reader.end(), { a: [1] });
    deepStrictEqual(await parseJoslStream([text], all), { a: [1] });
    deepStrictEqual(await drain(iterateJoslStream(['[[]]\na = 1\n'], { ...all, signal: null })), [{ a: 1 }]);
    const { mode, ...tomlAll } = all;
    strictEqual(mode, 'josl');
    deepStrictEqual(parseToml(text, tomlAll), { a: [1] });
    deepStrictEqual(parseJoslCst(text, { mode: 'toml', onEvent: () => {} }).toJSON(), { a: [1] });
    deepStrictEqual(parseTomlCst(text, { onEvent: () => {} }).toJSON(), { a: [1] });
    // parseToml is TOML by name: a mode would be ignored, so it is refused
    refuses(() => parseToml(text, { mode: 'josl' }), "parseToml: unknown option 'mode'; the options are "
      + 'onEvent, maxTotalBytes, maxRecordBytes, maxTokenBytes, maxDepth, maxRetainedValues');
    refuses(() => parseTomlCst(text, { mode: 'josl' }), "parseTomlCst: unknown option 'mode'; the options are onEvent");
    // a CST enforces no limits, so it does not take them
    refuses(() => parseJoslCst(text, { maxDepth: 2 }), "parseJoslCst: unknown option 'maxDepth'; the options are mode, onEvent");
    refuses(() => createStreamReader({ onevent: () => {} }), "createStreamReader: unknown option 'onevent' — did you mean 'onEvent'?");
    await rejects(parseJoslStream([text], { signal: null }), { message: /^parseJoslStream: unknown option 'signal'/ });
    await rejects(drain(iterateJoslStream([text], { detachRoot: () => {} })), { message: /^iterateJoslStream: unknown option 'detachRoot'/ });
  });

  it('the JOSL and TOML writers, and the grammar', async () => {
    const value = { a: null, r: /x/ };
    strictEqual(stringifyJosl(value, { mode: 'toml', onNull: 'omit', onRegExp: 'string' }), 'r = "/x/"\n');
    strictEqual(stringifyToml(value, { onNull: 'omit', onRegExp: 'string' }), 'r = "/x/"\n');
    strictEqual([...stringifyJoslChunks([{ a: 1 }], { mode: 'josl', onNull: 'error', onRegExp: 'error' })].join(''), '[[]]\na = 1\n');
    strictEqual((await drain(stringifyJoslStream([{ a: 1 }], { signal: null, onNull: 'omit' }))).join(''), '[[]]\na = 1\n');
    const chunks = [];
    const writer = createStreamWriter({ mode: 'josl', onNull: 'error', onRegExp: 'error', onChunk: (c) => chunks.push(c), buffer: false });
    writer.pair('a', 1);
    writer.end();
    strictEqual(chunks.join(''), 'a = 1\n');
    ok(toGbnf({ mode: 'toml' }).length > 0);
    refuses(() => stringifyToml(value, { mode: 'toml' }), "stringifyToml: unknown option 'mode'; the options are onNull, onRegExp");
    refuses(() => stringifyJosl(value, { onnull: 'omit' }), "stringifyJosl: unknown option 'onnull' — did you mean 'onNull'?");
    refuses(() => [...stringifyJoslChunks([{ a: 1 }], { signal: null })], /** @type {string} */ (
      "stringifyJoslChunks: unknown option 'signal'; the options are mode, onNull, onRegExp"));
    await rejects(drain(stringifyJoslStream([{ a: 1 }], { buffer: false })), { message: /^stringifyJoslStream: unknown option 'buffer'/ });
    refuses(() => createStreamWriter({ onChunks: () => {} }), "createStreamWriter: unknown option 'onChunks' — did you mean 'onChunk'?");
    refuses(() => toGbnf({ toml: true }), "toGbnf: unknown option 'toml'; the options are mode");
  });

  it('the JSONX reader, stream reader and writer', async () => {
    const events = [];
    deepStrictEqual(parseJsonx('{"a": 1}', { mode: 'json', onEvent: (e) => events.push(e.type) }), { a: 1 });
    ok(events.length > 0);
    const all = { mode: 'jsonx', onEvent: () => {}, partialText: true, detach: ['a'], maxTotalBytes: 100,
      maxTokenBytes: 100, maxDepth: 4, maxRetainedValues: 100 };
    const reader = createJsonxStreamReader(all);
    reader.feed('{"a": [1], "b": 2}');
    deepStrictEqual(reader.end(), { b: 2 });
    deepStrictEqual(await parseJsonxStream(['{"b": 2}'], all), { b: 2 });
    strictEqual(stringifyJsonx({ a: 1 }, { mode: 'json', indent: 2 }), '{\n  "a": 1\n}');
    strictEqual(stringifyJsonx({ a: 1n }, { mode: 'jsonx', indent: '' }), '{"a":1n}');
    refuses(() => parseJsonx('[1]', { partialText: true }), "parseJsonx: unknown option 'partialText'; the options are mode, onEvent, fences, duplicateKeys");
    refuses(() => createJsonxStreamReader({ detatch: ['a'] }), "createJsonxStreamReader: unknown option 'detatch' — did you mean 'detach'?");
    await rejects(parseJsonxStream(['[1]'], { mod: 'json' }), { message: "parseJsonxStream: unknown option 'mod' — did you mean 'mode'?" });
    refuses(() => stringifyJsonx({}, { indnt: 2 }), "stringifyJsonx: unknown option 'indnt' — did you mean 'indent'?");
  });
});
