import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { compileJsonQuery, queryJson, JsonQueryCompileError, JsonQueryRuntimeError } from '@jarenjs/json/query';
import { growthRatio } from '../../lib/growth.js';

// $substring-before, $substring-after, $translate and $tokenize: the string
// operators that find a position (QUERY-FORMAT.md section 8.7), each held
// to F&O's answer on the edges F&O names, and to work linear in the text.

const EMPTY = { $seq: [] };
const FACE = '\u{1F600}';

function compileFails(doc, docPath) {
  assert.throws(() => compileJsonQuery(doc), (e) => {
    assert.ok(e instanceof JsonQueryCompileError, `expected a compile error, got ${e.name}: ${e.message}`);
    assert.strictEqual(e.code, 'JQ0003', e.message);
    assert.strictEqual(e.docPath, docPath);
    return true;
  });
}

function runtimeFails(doc, docPath, externals) {
  assert.throws(() => queryJson(doc, null, externals), (e) => {
    assert.ok(e instanceof JsonQueryRuntimeError, `expected a runtime error, got ${e.name}: ${e.message}`);
    assert.strictEqual(e.code, 'JQ2001', e.message);
    assert.strictEqual(e.docPath, docPath);
    return true;
  });
}

/** the result sequence of `doc` as an array */
const items = (doc, externals) => compileJsonQuery([doc])(null, externals);

/** the one result of `doc`, run over no document */
const answer = (doc, data = null) => queryJson(doc, data);

describe('$substring-before / $substring-after', () => {
  it('should cut at the first occurrence (fn:substring-before, fn:substring-after)', () => {
    assert.strictEqual(answer({ '$substring-before': ['tattoo', 'attoo'] }), 't');
    assert.strictEqual(answer({ '$substring-before': ['tattoo', 'tatto'] }), '');
    assert.strictEqual(answer({ '$substring-after': ['tattoo', 'tat'] }), 'too');
    assert.strictEqual(answer({ '$substring-after': ['tattoo', 'tattoo'] }), '');
    assert.strictEqual(answer({ '$substring-before': ['a-b-c', '-'] }), 'a');
    assert.strictEqual(answer({ '$substring-after': ['a-b-c', '-'] }), 'b-c');
  });

  it('should answer "" for a text without the string', () => {
    assert.strictEqual(answer({ '$substring-before': ['abc', 'x'] }), '');
    assert.strictEqual(answer({ '$substring-after': ['abc', 'x'] }), '');
  });

  it('should find the zero-length string at the start', () => {
    assert.strictEqual(answer({ '$substring-before': ['abc', ''] }), '');
    assert.strictEqual(answer({ '$substring-after': ['abc', ''] }), 'abc');
    assert.strictEqual(answer({ '$substring-before': ['', ''] }), '');
    assert.strictEqual(answer({ '$substring-after': ['', ''] }), '');
  });

  it('should read the empty sequence as ""', () => {
    assert.strictEqual(answer({ '$substring-before': [EMPTY, 'a'] }), '');
    assert.strictEqual(answer({ '$substring-after': ['abc', EMPTY] }), 'abc');
    assert.strictEqual(answer({ '$substring-after': ['$.missing', 'a'] }, {}), '');
  });

  it('should keep a surrogate pair whole', () => {
    assert.strictEqual(answer({ '$substring-before': [`a${FACE}b`, 'b'] }), `a${FACE}`);
    assert.strictEqual(answer({ '$substring-after': [`a${FACE}b`, FACE] }), 'b');
    assert.strictEqual(answer({ '$substring-before': [`a${FACE}b`, FACE] }), 'a');
  });

  it('should refuse an operand that is not one string, and an arity it does not have', () => {
    runtimeFails({ '$substring-before': [1, 'a'] }, '/$substring-before/0');
    runtimeFails({ '$substring-after': ['a', { $seq: ['a', 'b'] }] }, '/$substring-after/1');
    compileFails({ '$substring-before': ['a'] }, '/$substring-before');
    compileFails({ '$substring-after': ['a', 'b', 'c'] }, '/$substring-after');
  });
});

describe('$translate', () => {
  it('should map code points by position, removing those past the translation (fn:translate)', () => {
    assert.strictEqual(answer({ $translate: ['bar', 'abc', 'ABC'] }), 'BAr');
    assert.strictEqual(answer({ $translate: ['--aaa--', 'abc-', 'ABC'] }), 'AAA');
    assert.strictEqual(answer({ $translate: ['abcdabc', 'abc', 'AB'] }), 'ABdAB');
  });

  it('should let the first occurrence in the map decide', () => {
    assert.strictEqual(answer({ $translate: ['aaa', 'aa', 'xy'] }), 'xxx');
    assert.strictEqual(answer({ $translate: ['ab', 'aba', 'xyz'] }), 'xy');
  });

  it('should leave the text as it is under an empty map, and give "" for the empty text', () => {
    assert.strictEqual(answer({ $translate: ['abc', '', 'xyz'] }), 'abc');
    assert.strictEqual(answer({ $translate: ['', 'a', 'b'] }), '');
    assert.strictEqual(answer({ $translate: [EMPTY, 'a', 'b'] }), '');
  });

  it('should count code points, a surrogate pair as one', () => {
    assert.strictEqual(answer({ $translate: [`a${FACE}b`, `${FACE}a`, 'xy'] }), 'yxb');
    assert.strictEqual(answer({ $translate: ['abc', 'b', FACE] }), `a${FACE}c`);
    assert.strictEqual(answer({ $translate: [`${FACE}${FACE}`, FACE, ''] }), '');
  });

  it('should refuse a map or translation that is not one string, the empty sequence included', () => {
    runtimeFails({ $translate: ['a', EMPTY, 'b'] }, '/$translate/1');
    runtimeFails({ $translate: ['a', 'b', EMPTY] }, '/$translate/2');
    runtimeFails({ $translate: ['a', 1, 'b'] }, '/$translate/1');
    runtimeFails({ $translate: [1, 'a', 'b'] }, '/$translate/0');
    compileFails({ $translate: ['a', 'b'] }, '/$translate');
  });
});

describe('$tokenize', () => {
  it('should split at the matches, keeping the empty pieces (fn:tokenize#2)', () => {
    assert.deepStrictEqual(items({ $tokenize: ['a,b,,c', ','] }), ['a', 'b', '', 'c']);
    assert.deepStrictEqual(items({ $tokenize: [',a,', ','] }), ['', 'a', '']);
    assert.deepStrictEqual(items({ $tokenize: ['abc', ','] }), ['abc']);
    assert.deepStrictEqual(items({ $tokenize: ['The cat sat', '[ ]+'] }), ['The', 'cat', 'sat']);
  });

  it('should take matches left to right, the first alternative at a position', () => {
    assert.deepStrictEqual(items({ $tokenize: ['abracadabra', '(ab)|(a)'] }), ['', 'r', 'c', 'd', 'r', '']);
    assert.deepStrictEqual(items({ $tokenize: ['aaa', 'aa'] }), ['', 'a']);
    assert.deepStrictEqual(items({ $tokenize: ['aXbXXc', 'X+'] }), ['a', 'b', 'c']);
  });

  it('should give no pieces for the empty text, whatever the pattern', () => {
    assert.deepStrictEqual(items({ $tokenize: ['', ','] }), []);
    assert.deepStrictEqual(items({ $tokenize: [EMPTY, ','] }), []);
    assert.deepStrictEqual(items({ $tokenize: ['', '['] }), []);
    assert.deepStrictEqual(items({ $tokenize: ['$s', '$p'] }, { s: '', p: 'a*' }), []);
  });

  it('should count code points and match a surrogate pair whole', () => {
    assert.deepStrictEqual(items({ $tokenize: [`x${FACE}y${FACE}`, FACE] }), ['x', 'y', '']);
    assert.deepStrictEqual(items({ $tokenize: [`a${FACE}b`, '.'] }), ['', '', '', '']);
  });

  it('should refuse a pattern that matches the zero-length string, or is no I-Regexp (FORX0003, FORX0002)', () => {
    runtimeFails({ $tokenize: ['abba', '.?'] }, '/$tokenize/1');
    runtimeFails({ $tokenize: ['ab', ''] }, '/$tokenize/1');
    runtimeFails({ $tokenize: ['ab', '['] }, '/$tokenize/1');
    runtimeFails({ $tokenize: ['a b', '\\s'] }, '/$tokenize/1');
    runtimeFails({ $tokenize: ['ab', '$p'] }, '/$tokenize/1', { p: 'b*' });
    runtimeFails({ $tokenize: ['ab', '$p'] }, '/$tokenize/1', { p: '(' });
  });

  it('should answer a computed pattern as a literal one, the pattern changing between calls', () => {
    const query = compileJsonQuery([{ $tokenize: ['$s', '$p'] }]);
    assert.deepStrictEqual(query(null, { s: 'a-b,c', p: '-' }), ['a', 'b,c']);
    assert.deepStrictEqual(query(null, { s: 'a-b,c', p: ',' }), ['a-b', 'c']);
    assert.deepStrictEqual(query(null, { s: 'a-b,c', p: ',' }), ['a-b', 'c']);
  });

  it('should refuse a text or pattern that is not one string, the empty pattern sequence included', () => {
    runtimeFails({ $tokenize: [1, ','] }, '/$tokenize/0');
    runtimeFails({ $tokenize: ['a', EMPTY] }, '/$tokenize/1');
    runtimeFails({ $tokenize: ['a', 1] }, '/$tokenize/1');
    compileFails({ $tokenize: ['a'] }, '/$tokenize');
    compileFails({ $tokenize: ['a', ',', 'q'] }, '/$tokenize');
  });

  it('should be reached from the alias a guess at a split operator names', () => {
    assert.throws(() => compileJsonQuery({ $split: ['a,b', ','] }), /use '\$tokenize'/);
  });
});

describe('the position operators read their text once', () => {
  // An eightfold longer text costs about eight times as much; a scan that
  // probes every position against the rest of the text, about sixty-four.
  const LIMIT = 24;
  const cases = [
    ['$substring-before', { '$substring-before': ['$s', 'z'] }, (n) => 'ab'.repeat(n) + 'z'],
    ['$substring-after', { '$substring-after': ['$s', 'z'] }, (n) => 'ab'.repeat(n) + 'z'],
    ['$translate', { $translate: ['$s', 'abc', 'xyz'] }, (n) => 'abcd'.repeat(n)],
    ['$tokenize', { $tokenize: ['$s', ','] }, (n) => 'ab,'.repeat(n)],
    ['$tokenize over a computed pattern', { $tokenize: ['$s', '$p'] }, (n) => 'ab,'.repeat(n)],
  ];
  for (const [name, doc, text] of cases) {
    it(`${name}: linear in the text`, () => {
      const query = compileJsonQuery(doc);
      const run = (s) => query(null, { s, p: ',' });
      const ratio = growthRatio(run, text(1000), text(8000), { limit: LIMIT });
      assert.ok(ratio < LIMIT, `${name}: ${ratio} times the cost for 8 times the text`);
    });
  }
});
