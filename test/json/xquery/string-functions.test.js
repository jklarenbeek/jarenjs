import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { compileXQuery } from '@jarenjs/json/xquery';
import { growthRatio } from '../../lib/growth.js';

import { validated, values, failsAtRun, failsWith } from './emitted.js';

const FACE = String.fromCodePoint(0x1F600);

describe('XQuery front-end fn:substring-before, fn:substring-after and fn:translate', () => {
  it('should emit the engine operators', () => {
    assert.deepStrictEqual(validated('substring-before($s, "-")'), { '$substring-before': ['$s', '-'] });
    assert.deepStrictEqual(validated('fn:substring-after($s, "-")'), { '$substring-after': ['$s', '-'] });
    assert.deepStrictEqual(validated('translate($s, "abc", "ABC")'), { '$translate': ['$s', 'abc', 'ABC'] });
  });

  it('should answer as F&O, the zero-length and empty operands included', () => {
    assert.deepStrictEqual(values('substring-before("tattoo", "attoo")'), ['t']);
    assert.deepStrictEqual(values('substring-after("tattoo", "tat")'), ['too']);
    assert.deepStrictEqual(values('substring-before("abc", "")'), ['']);
    assert.deepStrictEqual(values('substring-after("abc", "")'), ['abc']);
    assert.deepStrictEqual(values('substring-before((), "a")'), ['']);
    assert.deepStrictEqual(values('substring-after("abc", ())'), ['abc']);
    assert.deepStrictEqual(values('substring-after("abc", "x")'), ['']);
    assert.deepStrictEqual(values('translate("bar", "abc", "ABC")'), ['BAr']);
    assert.deepStrictEqual(values('translate("--aaa--", "abc-", "ABC")'), ['AAA']);
    assert.deepStrictEqual(values('translate((), "a", "b")'), ['']);
  });

  it('should keep a surrogate pair whole', () => {
    assert.deepStrictEqual(values('substring-after($s, $t)', { s: `a${FACE}b`, t: FACE }), ['b']);
    assert.deepStrictEqual(values('translate($s, $m, "x")', { s: `a${FACE}`, m: FACE }), ['ax']);
  });

  it('should refuse a translation map that is not one string, and the arities F&O has with a collation', () => {
    failsAtRun('translate("a", (), "b")');
    failsAtRun('translate("abc", 1, "x")');
    failsWith('substring-before("a", "b", "c")', "unsupported function 'substring-before#3'", 0);
    failsWith('fn:substring-after("a")', "unsupported function 'fn:substring-after#1'", 0);
    failsWith('translate("a", "b")', "unsupported function 'translate#2'", 0);
  });
});

describe('XQuery front-end fn:tokenize reads the text once', () => {
  // the plain-text mapping this replaces probed every position against
  // the separator: an eightfold longer text cost about sixty-four times
  it('should split an eightfold longer text in about eightfold time', () => {
    const query = compileXQuery('tokenize($s, ",")');
    const ratio = growthRatio((s) => query(null, { s }), 'ab,'.repeat(1000), 'ab,'.repeat(8000), { limit: 24 });
    assert.ok(ratio < 24, `${ratio} times the cost for 8 times the text`);
  });
});
