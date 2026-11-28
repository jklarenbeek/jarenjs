import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { compileJsonQuery, queryJson, JsonQueryRuntimeError } from '@jarenjs/json/query';

// $replace's fourth operand: where it is true the replacement is F&O's
// fn:replace template - `$N` a capture group, `\\` and `\$` escapes -
// read by F&O's rules for N (S the pattern's capturing groups): 0 the
// whole match, 1 to S that group ('' where it did not match), S < N <= 9
// '', and N > S, N > 9 the last digit as text, the rest read again; a
// `$` not before a digit or a `\` before anything but `\` and `$` (F&O's
// FORX0004) is JQ2001.
// The replacements are String.raw: a JSON query string has no escapes of
// its own but the leading '$$' (QUERY-FORMAT section 3.2).

const template = (input, pattern, replacement) => queryJson({ $replace: [input, pattern, replacement, true] }, null);

describe('$replace with an F&O template', () => {
  it('should insert the whole match for $0 and each group for $N', () => {
    assert.strictEqual(template('abracadabra', 'a(.)', 'a$1$1'), 'abbraccaddabbra');
    assert.strictEqual(template('Now SEND OUT', '[A-Z][A-Z]+', '$$0$0'), 'Now SENDSEND OUTOUT');
    assert.strictEqual(template('15/01/24', '(.{2})/(.{2})/(.{2})', '$$3$2$1'), '240115');
  });

  it('should insert "" for a group that did not match', () => {
    assert.strictEqual(template('abcd', '(ab)|(a)', '[1=$1][2=$2]'), '[1=ab][2=]cd');
    assert.strictEqual(template('abcdefghijk', '(a)|(b)|(c)|(d)|(e)|(f)|(g)|(h)|(i)|(j)', '$$1'), 'ak');
  });

  it('should insert "" for a number above the groups up to 9, and read a larger one without its last digit', () => {
    assert.strictEqual(template('abc', 'b', '[$1]'), 'a[]c');
    assert.strictEqual(template('abc', '(b)', '[$9]'), 'a[]c');
    assert.strictEqual(template('abc', '(b)', '[$12]'), 'a[b2]c');
    assert.strictEqual(template('abc', '(b)', '[$012]'), 'a[b2]c');
    assert.strictEqual(template('abc', 'b', '[$10]'), 'a[0]c');
    assert.strictEqual(template('abcde', '(a)(b)(c)(d)(e)', '$$23'), 'b3');
    const fifteen = '(((((((((((((((a)))))))))))))))';
    assert.strictEqual(template('xax', fifteen, '|$1$15|$1520|'), 'x|aa|a20|x');
    const sixteen = '(((((((((((((((a)(b)))))))))))))))';
    assert.strictEqual(template('abc', sixteen, '($14.$15.$16.$17)'), '(ab.a.b.ab7)c');
  });

  it('should read \\\\ and \\$ as text, and every other character as itself', () => {
    assert.strictEqual(template('abc', 'b', String.raw`\\`), String.raw`a\c`);
    assert.strictEqual(template('abc', '(b)', String.raw`\$1`), 'a$1c');
    assert.strictEqual(template('abc', '(b)', String.raw`\\$1`), String.raw`a\bc`);
    assert.strictEqual(template('abc', 'b', String.raw`x\$y\\z`), String.raw`ax$y\zc`);
  });

  it('should raise JQ2001 for a replacement F&O refuses, naming it', () => {
    for (const replacement of ['x$', '$$', '$$x', '$$ 1', '\\', String.raw`\n`, String.raw`\1`, '\\\\\\', String.raw`$$1\n`, String.raw`a\\$`]) {
      const written = replacement.startsWith('$$') ? replacement.slice(1) : replacement;
      assert.throws(() => template('abc', '(b)', replacement), (e) => e instanceof JsonQueryRuntimeError
        && e.code === 'JQ2001' && e.docPath === '/$replace/2' && e.messageId === 'query/replace-template-invalid'
        && e.params.replacement === written
        && e.message.includes(`the replacement '${written}' holds a '$' not before a digit or a '\\' not before '\\' or '$'`));
    }
    assert.strictEqual(queryJson({ $replace: ['abc', 'b', 'x$', false] }, null), 'ax$c');
    assert.strictEqual(queryJson({ $replace: ['abc', 'b', 'x$'] }, null), 'ax$c');
  });

  it('should read a refused replacement once, raising for it on every call, and the next one afresh', () => {
    const q = compileJsonQuery({ $replace: ['$.s', '(b)', '$.r', true] });
    for (let k = 0; k < 2; k++)
      assert.throws(() => q({ s: 'abc', r: 'x$' }, {}), (e) => e.code === 'JQ2001' && e.params.replacement === 'x$');
    assert.strictEqual(q({ s: 'abc', r: '<$1>' }, {}), 'a<b>c');
    assert.throws(() => q({ s: 'abc', r: '\\' }, {}), (e) => e.messageId === 'query/replace-template-invalid');
    assert.strictEqual(q({ s: 'abc', r: '<$1>' }, {}), 'a<b>c');
  });

  it('should take the replacement literally where the fourth operand is false', () => {
    assert.strictEqual(queryJson({ $replace: ['abc', '(b)', '$$1', false] }, null), 'a$1c');
    const q = compileJsonQuery({ $replace: ['$.s', '$.p', '$.r', '$.t'] });
    assert.strictEqual(q({ s: 'abc', p: '(b)', r: '<$1>', t: true }, {}), 'a<b>c');
    assert.strictEqual(q({ s: 'abc', p: '(b)', r: '<$1>', t: false }, {}), 'a<$1>c');
    assert.strictEqual(q({ s: 'abc', p: '(c)', r: '<$1>', t: true }, {}), 'ab<c>');
    assert.strictEqual(q({ s: 'abc', p: '(c)', r: '[$1]', t: true }, {}), 'ab[c]');
  });

  it('should read a long run of digits in time that grows with its length', () => {
    const q = compileJsonQuery({ $replace: ['$.s', '(b)', '$.r', true] });
    // a fresh replacement per call, so no cached template is measured
    const time = (n) => {
      let best = Infinity;
      for (let round = 0; round < 3; round++) {
        const t0 = process.hrtime.bigint();
        for (let k = 0; k < 10; k++)
          assert.strictEqual(q({ s: 'abc', r: '$' + '7'.repeat(n) + 'x'.repeat(round * 10 + k) }, {}).length, n + 1 + round * 10 + k);
        best = Math.min(best, Number(process.hrtime.bigint() - t0));
      }
      return best;
    };
    time(1e4);
    const growth = time(8e4) / time(1e4);
    assert.ok(growth < 24, `an eightfold longer run took ${growth.toFixed(1)}x as long`);
  });

  it('should raise the errors of three operands', () => {
    const fails = (doc, docPath) => assert.throws(() => queryJson(doc, null), (e) =>
      e instanceof JsonQueryRuntimeError && e.code === 'JQ2001' && e.docPath === docPath);
    fails({ $replace: ['abc', 'x*', '$$1', true] }, '/$replace/1');
    fails({ $replace: ['abc', 'a(', '$$1', true] }, '/$replace/1');
    fails({ $replace: ['abc', 'b', 1, true] }, '/$replace/2');
    assert.throws(() => compileJsonQuery({ $replace: ['a', 'a', 'b', true, 1] }), (e) => e.code === 'JQ0003');
  });
});
