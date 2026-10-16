//@ts-check
import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual, ok, throws, rejects } from 'node:assert';

import { parseJsonx, createJsonxStreamReader, parseJsonxStream, JsonxSyntaxError, JSONX_CODES } from '@jarenjs/josl';
import * as jsonxPath from '@jarenjs/josl/jsonx';
import * as streamPath from '@jarenjs/josl/jsonx-stream';

/**
 * Every condition the JSONX readers refuse as syntax, with its code: [text,
 * strict JSON mode, code, 1-based line, 1-based column].
 * @type {[string, boolean, string, number, number][]}
 */
const CASES = [
  ['[', false, 'JSONX1001', 1, 2],
  ['{"a":', true, 'JSONX1001', 1, 6],
  ['', false, 'JSONX1001', 1, 1],
  ['1 2', false, 'JSONX1002', 1, 3],
  ['{1:2}', true, 'JSONX1003', 1, 2],
  ['{"a":1,}', false, 'JSONX1003', 1, 8],
  ['{', false, 'JSONX1003', 1, 2],
  ['{"a" 1}', false, 'JSONX1004', 1, 6],
  ['{"a"', false, 'JSONX1004', 1, 5],
  ['[1 2]', true, 'JSONX1005', 1, 4],
  ['{"a":1 "b":2}', false, 'JSONX1005', 1, 8],
  ['[1}', false, 'JSONX1005', 1, 3],
  ['{"a":1]', false, 'JSONX1005', 1, 7],
  ['[1', false, 'JSONX1006', 1, 3],
  ['{"a":1', false, 'JSONX1006', 1, 7],
  ['[1,]', true, 'JSONX1007', 1, 4],
  ['[tru]', false, 'JSONX1007', 1, 2],
  ['\n\n  [1,\n  x]', false, 'JSONX1007', 4, 3],
  ['[1x]', false, 'JSONX1008', 1, 3],
  ['[01]', true, 'JSONX1008', 1, 3],
  ['[1n]', true, 'JSONX1008', 1, 3],
  ['["abc', false, 'JSONX1009', 1, 6],
  ['["\\x"]', false, 'JSONX1010', 1, 3],
  ['"\\u12"', false, 'JSONX1010', 1, 2],
  ['"ab\\', false, 'JSONX1010', 1, 4],
  ['"a\tb"', true, 'JSONX1011', 1, 3],
  ['[-]', false, 'JSONX1012', 1, 2],
  ['[1.5n]', false, 'JSONX1013', 1, 2],
  ['[2026-02-30]', false, 'JSONX1014', 1, 2],
  ['[25:00:00]', false, 'JSONX1014', 1, 2],
  ['[2026-07-18T25:00:00Z]', false, 'JSONX1014', 1, 22],
  ['[/abc\n]', false, 'JSONX1015', 1, 2],
  ['[/abc', false, 'JSONX1015', 1, 2],
  ['[/(/]', false, 'JSONX1016', 1, 2],
  ['[inf]', true, 'JSONX1017', 1, 2],
  ['[nan]', true, 'JSONX1017', 1, 2],
  ['[/a/]', true, 'JSONX1017', 1, 2],
  ['[+1]', true, 'JSONX1017', 1, 2],
];

/** @param {() => unknown} fn @returns {any} */
function caught(fn) {
  try { fn(); }
  catch (e) { return e; }
  throw new Error('expected a refusal');
}

/** The 0-based offset of a 1-based line and column. @param {string} text @param {number} line @param {number} column */
function offsetOf(text, line, column) {
  let start = 0;
  for (let l = 1; l < line; l++) start = text.indexOf('\n', start) + 1;
  return start + column - 1;
}

/** @param {any} e */
const fields = (e) => ({ jsonx: e instanceof JsonxSyntaxError, code: e.code, line: e.line, column: e.column, offset: e.offset, message: e.message });

describe('JSONX syntax refusals carry a stable code and an offset', () => {
  it('every condition has its code, in both readers, whole and fed a character at a time', () => {
    for (const [text, json, code, line, column] of CASES) {
      const options = json ? { mode: /** @type {'json'} */ ('json') } : undefined;
      const parsed = fields(caught(() => parseJsonx(text, options)));
      deepStrictEqual([parsed.jsonx, parsed.code, parsed.line, parsed.column, parsed.offset],
        [true, code, line, column, offsetOf(text, line, column)], JSON.stringify(text));
      const whole = fields(caught(() => {
        const reader = createJsonxStreamReader(options);
        reader.feed(text);
        reader.end();
      }));
      deepStrictEqual(whole, parsed, `stream whole ${JSON.stringify(text)}`);
      const byChar = fields(caught(() => {
        const reader = createJsonxStreamReader(options);
        for (const ch of text) reader.feed(ch);
        reader.end();
      }));
      deepStrictEqual(byChar, parsed, `stream by char ${JSON.stringify(text)}`);
    }
  });

  it('the message is the one it was, without the code', () => {
    strictEqual(caught(() => parseJsonx('{"a":1,}')).message, 'expected a string key at line 1, column 8');
  });

  it('the stream offset counts past what the reader has already let go', () => {
    const reader = createJsonxStreamReader();
    const e = caught(() => {
      reader.feed('[1, 2,\n 3, ');
      reader.feed('4, x]');
      reader.end();
    });
    deepStrictEqual([e.code, e.line, e.column, e.offset], ['JSONX1007', 2, 8, 14]);
  });

  it('the code table lists every code once, frozen, from each entry point', () => {
    deepStrictEqual(Object.keys(JSONX_CODES), Array.from({ length: 18 }, (_, i) => `JSONX${1001 + i}`));
    ok(Object.isFrozen(JSONX_CODES));
    strictEqual(jsonxPath.JSONX_CODES, JSONX_CODES);
    strictEqual(streamPath.JSONX_CODES, JSONX_CODES);
    const seen = new Set(CASES.map((c) => c[2]));
    for (const code of Object.keys(JSONX_CODES))
      ok(seen.has(code) || code === 'JSONX1018', `${code} has a case`);
  });
});

const FENCED = '```json\n{"a": 1}\n```';

describe("parseJsonx { fences: 'strip' } reads a reply wrapped in one Markdown code fence", () => {
  const strip = { fences: /** @type {'strip'} */ ('strip') };

  it('strips one surrounding fence, with or without an info string', () => {
    deepStrictEqual(parseJsonx(FENCED, strip), { a: 1 });
    deepStrictEqual(parseJsonx('```\n[1, 2]\n```', strip), [1, 2]);
    deepStrictEqual(parseJsonx('```JSON\r\n{"a": 1}\r\n```\r\n', strip), { a: 1 });
    deepStrictEqual(parseJsonx('  \n```json\n{"a": 1}\n```\n  ', strip), { a: 1 });
    deepStrictEqual(parseJsonx('~~~json\n1\n~~~', strip), 1);
    deepStrictEqual(parseJsonx('````json\n"```"\n````', strip), '```');
    deepStrictEqual(parseJsonx(FENCED, { ...strip, mode: 'json' }), { a: 1 });
  });

  it('reads an unfenced text as it is', () => {
    deepStrictEqual(parseJsonx('{"a": 1}', strip), { a: 1 });
    deepStrictEqual(parseJsonx(' "```" ', strip), '```');
  });

  it('locates an error inside the fence in the original text', () => {
    const text = '```json\n{"a": 1,}\n```';
    deepStrictEqual(fields(caught(() => parseJsonx(text, strip))), {
      jsonx: true, code: 'JSONX1003', line: 2, column: 9, offset: 16,
      message: 'expected a string key at line 2, column 9',
    });
    const unterminated = caught(() => parseJsonx('```json\n[1,\n2\n```', strip));
    deepStrictEqual([unterminated.code, unterminated.line, unterminated.column, unterminated.offset], ['JSONX1006', 4, 1, 14]);
  });

  it('leaves prose, an unclosed, short, mismatched or mid-line fence unstripped, refused as before', () => {
    for (const text of ['Here it is:\n```json\n{}\n```', '```json\n{"a": 1}', '```json\n{"a": 1}```', '```json\n{}\n```\nDone.',
      '````\n1\n```', '```\n1\n~~~', '``\n1\n``', '```js`x\n1\n```'])
      deepStrictEqual([caught(() => parseJsonx(text, strip)).code, caught(() => parseJsonx(text, strip)).message],
        [caught(() => parseJsonx(text)).code, caught(() => parseJsonx(text)).message], text);
  });

  it('is off by default, and fences: "error" is the default', () => {
    for (const options of [undefined, { fences: /** @type {'error'} */ ('error') }])
      deepStrictEqual([caught(() => parseJsonx(FENCED, options)).code, caught(() => parseJsonx(FENCED, options)).line,
        caught(() => parseJsonx(FENCED, options)).column], ['JSONX1007', 1, 1]);
  });

  it('reports events with the paths of the unfenced document', () => {
    const fenced = [], plain = [];
    parseJsonx(FENCED, { ...strip, onEvent: (e) => fenced.push(e) });
    parseJsonx('{"a": 1}', { onEvent: (e) => plain.push(e) });
    deepStrictEqual(fenced, plain);
  });
});

describe("parseJsonx { duplicateKeys: 'error' } refuses a member named twice", () => {
  const strict = { duplicateKeys: /** @type {'error'} */ ('error') };

  it('refuses the second member at its key', () => {
    deepStrictEqual(fields(caught(() => parseJsonx('{"a":1,"a":2}', strict))), {
      jsonx: true, code: 'JSONX1018', line: 1, column: 8, offset: 7,
      message: 'duplicate key "a" at line 1, column 8 (name each member once)',
    });
    strictEqual(caught(() => parseJsonx('{"a":1,"\\u0061":2}', strict)).code, 'JSONX1018');
    strictEqual(caught(() => parseJsonx('{"o":{"a":1,\n "a":2}}', { ...strict, mode: 'json' })).line, 2);
    strictEqual(caught(() => parseJsonx('{"__proto__":1,"__proto__":2}', strict)).code, 'JSONX1018');
    strictEqual(caught(() => parseJsonx('{"a":{},"a":1}', strict)).code, 'JSONX1018');
  });

  it('admits the same name in different objects, a single __proto__, and names differing by case', () => {
    deepStrictEqual(parseJsonx('{"a":{"a":1},"b":[{"a":2},{"a":3}]}', strict), { a: { a: 1 }, b: [{ a: 2 }, { a: 3 }] });
    const proto = parseJsonx('{"__proto__":{"x":1}}', strict);
    ok(Object.hasOwn(proto, '__proto__'));
    strictEqual(Object.getPrototypeOf(proto), Object.prototype);
    deepStrictEqual(parseJsonx('{"a":1,"A":2}', strict), { a: 1, A: 2 });
  });

  it('keeps the last member by default, as JSON.parse does', () => {
    deepStrictEqual(parseJsonx('{"a":1,"a":2}'), { a: 2 });
    deepStrictEqual(parseJsonx('{"a":1,"a":2}', { duplicateKeys: 'last' }), { a: 2 });
  });
});

describe('the reply options are parseJsonx options', () => {
  it('refuses a value outside each closed set', () => {
    throws(() => parseJsonx('1', /** @type {any} */ ({ fences: 'yes' })), { name: 'TypeError', message: "options.fences must be 'error' or 'strip'" });
    throws(() => parseJsonx('1', /** @type {any} */ ({ duplicateKeys: true })), { name: 'TypeError', message: "options.duplicateKeys must be 'last' or 'error'" });
  });

  it('the stream reader, which does not apply them, refuses them by name', async () => {
    throws(() => createJsonxStreamReader(/** @type {any} */ ({ fences: 'strip' })), { name: 'TypeError',
      message: "createJsonxStreamReader: 'fences' is a parseJsonx option — read the whole text with parseJsonx to apply it" });
    await rejects(parseJsonxStream(['1'], /** @type {any} */ ({ duplicateKeys: 'error' })), { name: 'TypeError',
      message: "parseJsonxStream: 'duplicateKeys' is a parseJsonx option — read the whole text with parseJsonx to apply it" });
    throws(() => createJsonxStreamReader(/** @type {any} */ ({ detatch: ['a'] })), { message: /unknown option 'detatch' — did you mean 'detach'\?/ });
  });
});
