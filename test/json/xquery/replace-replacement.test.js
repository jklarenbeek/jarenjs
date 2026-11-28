import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { validated, values, failsAtRun } from './emitted.js';

// fn:replace reads its replacement the way F&O reads it: `\\` is a
// backslash and `\$` a dollar sign, every other character itself, and
// `$N` a capture group (the engine's `$replace` with a fourth operand
// `true`); a replacement F&O refuses (a `$` not before a digit, a `\`
// before anything but `\` and `$`) is err:FORX0004 when the call runs
// where it is written in the query, and the engine's JQ2001 where it is
// computed.
// Under the flag `q` the replacement is literal text. The queries are
// String.raw: XQuery string literals have no backslash escapes of their
// own.

const FORX0004 = (text) => failsAtRun(text, {}, 'err:FORX0004');

describe('XQuery front-end fn:replace replacement', () => {
  it('should read \\\\ as one backslash and \\$ as a dollar sign', () => {
    assert.deepStrictEqual(values(String.raw`replace("abc", "b", "\\")`), [String.raw`a\c`]);
    assert.deepStrictEqual(values(String.raw`replace("abc", "b", "\$")`), ['a$c']);
    assert.deepStrictEqual(values(String.raw`replace("abc", "b", "x\\y\$z")`), [String.raw`ax\y$zc`]);
    assert.deepStrictEqual(values(String.raw`replace("abc", "b", "\\\$")`), [String.raw`a\$c`]);
    assert.deepStrictEqual(values(String.raw`replace("a$b", "[$]", "\$\$")`), ['a$$b']);
    assert.deepStrictEqual(values(String.raw`fn:replace("abracadabra", "a", "\$")`), ['$br$c$d$br$']);
    assert.deepStrictEqual(values(String.raw`fn:replace("abracadabra", "a", "\\")`), [String.raw`\br\c\d\br\ `.trimEnd()]);
  });

  it('should emit the text it reads, a leading $ doubled, and the template reading only for a capture reference', () => {
    assert.deepStrictEqual(validated(String.raw`replace($s, "b", "\$x")`), { '$replace': ['$s', 'b', '$$x'] });
    assert.deepStrictEqual(values(String.raw`replace("abc", "b", "\$x")`), ['a$xc']);
    assert.deepStrictEqual(validated(String.raw`replace($s, "b", "\\")`), { '$replace': ['$s', 'b', '\\'] });
    assert.deepStrictEqual(validated('replace($s, "b", "x")'), { '$replace': ['$s', 'b', 'x'] });
    assert.deepStrictEqual(validated(String.raw`replace($s, "(b)", "\\$1")`), { '$replace': ['$s', '(b)', String.raw`\\$1`, true] });
    assert.deepStrictEqual(validated('replace($s, "b", $r)'), { '$replace': ['$s', 'b', '$r', true] });
  });

  it('should read a capture reference by F&O\'s rules', () => {
    assert.deepStrictEqual(values('replace("abracadabra", "a(.)", "a$1$1")'), ['abbraccaddabbra']);
    assert.deepStrictEqual(values('fn:replace("abcd", "(ab)|(a)", "[1=$1][2=$2]")'), ['[1=ab][2=]cd']);
    assert.deepStrictEqual(values(String.raw`fn:replace("abracadabra", "(a)", "\$$1")`), ['$abr$ac$ad$abr$a']);
    assert.deepStrictEqual(values(`replace("Now, let's SEND OUT for QUICHE!!", "[A-Z][A-Z]+", "$0$0")`), ["Now, let's SENDSEND OUTOUT for QUICHEQUICHE!!"]);
    assert.deepStrictEqual(values("replace('abcd', '^a(.).$|^a...$', '$1')"), ['']);
    assert.deepStrictEqual(values("replace('abcdefghijk', '(a)|(b)|(c)|(d)|(e)|(f)|(g)|(h)|(i)|(j)', '$1')"), ['ak']);
    assert.deepStrictEqual(values("replace('15/01/24', '(.{2})/(.{2})/(.{2})', '$3$2$1')"), ['240115']);
    assert.deepStrictEqual(values("replace('abc123', '([a-z])', '$1x')"), ['axbxcx123']);
    assert.deepStrictEqual(values('replace("abc", "b", "[$1]")'), ['a[]c']);
    assert.deepStrictEqual(values(String.raw`replace("abc", "(b)", "\\$1")`), [String.raw`a\bc`]);
  });

  it('should raise err:FORX0004 where F&O refuses the replacement, before a capture reference', () => {
    FORX0004(String.raw`fn:replace("abracadabra", "bra", "\")`);
    FORX0004('fn:replace("abracadabra", "bra", "$y")');
    FORX0004(String.raw`replace("input", "in", "thisIsInvalid\")`);
    FORX0004('replace("input", "(input)", "thisIsInvalid$")');
    FORX0004(String.raw`replace("input", "in", "thisIsInvalid\ ")`);
    FORX0004('replace("input", "in", "thisIsInvalid$ ")');
    FORX0004(String.raw`replace("a a a ", "(a )", "replacment: \1")`);
    for (const replacement of ['$', 'x$', '$x', String.raw`\n`, String.raw`\\\ `.trimEnd(), String.raw`$1\n`, String.raw`\n$1`])
      FORX0004(`replace("abc", "(b)", "${replacement}")`);
    FORX0004(String.raw`replace("abc", "x*", "\")`);
    assert.deepStrictEqual(validated('replace($s, "b", "$")'), { '$error': ['err:FORX0004', "fn:replace: invalid replacement '$'"] });
  });

  it('should answer the error of a pattern the engine raises on beside a capture reference', () => {
    failsAtRun('replace("abc", "x*", "$1")');
    failsAtRun('replace("abracadabra", ".*?", "$1")');
  });

  it('should read the replacement the same way under flags other than q', () => {
    assert.deepStrictEqual(values(String.raw`replace("aBc", "b", "\\", "i")`), [String.raw`a\c`]);
    assert.deepStrictEqual(values(String.raw`replace("aBc", "b", "\$", "i")`), ['a$c']);
    assert.deepStrictEqual(values(String.raw`replace("abc", "b", "\\", "")`), [String.raw`a\c`]);
    assert.deepStrictEqual(values(String.raw`replace("ab", " b", "\$", "x")`), ['a$']);
    assert.deepStrictEqual(values('replace("aBc", "(b)", "<$1>", "i")'), ['a<B>c']);
    assert.deepStrictEqual(values('fn:replace("abracadabra", "((((( ((((( (((((a))))) ))))) )))))", "|$1$15|", "x")'), ['|aa|br|aa|c|aa|d|aa|br|aa|']);
    assert.deepStrictEqual(values('fn:replace("abracadabra", "((((( ((((( (((((a))))) ))))) )))))", "$1520", "x")'), ['a20bra20ca20da20bra20']);
    assert.deepStrictEqual(values('fn:replace("abracadabra", "((((( ((((( (((((a)(b))))) ))))) )))))", "($14.$15.$16.$17)", "x")'), ['(ab.a.b.ab7)racad(ab.a.b.ab7)ra']);
    assert.deepStrictEqual(values('fn:replace("abracadabra", "((((( ((((( (((((a))))) ))))) )))))", "$1$1", "x")'), ['aabraacaadaabraa']);
    FORX0004(String.raw`replace("abc", "b", "\", "s")`);
    assert.deepStrictEqual(values('replace("aBc", "(b)", $r, "i")', { r: '[$1]' }), ['a[B]c']);
  });

  it('should take the replacement literally under q', () => {
    assert.deepStrictEqual(values(String.raw`replace("abc", "b", "\\", "q")`), [String.raw`a\\c`]);
    assert.deepStrictEqual(values(String.raw`replace("abc", "b", "\$1", "q")`), [String.raw`a\$1c`]);
    assert.deepStrictEqual(values(String.raw`replace("abc", "b", "\", "q")`), [String.raw`a\c`]);
    assert.deepStrictEqual(values('replace("abc", "b", $r, "q")', { r: '$1' }), ['a$1c']);
  });

  it('should read a computed replacement as the engine\'s template', () => {
    assert.deepStrictEqual(values('replace("abc", "(b)", $r)', { r: String.raw`<\\$1\$>` }), [String.raw`a<\b$>c`]);
    assert.deepStrictEqual(values('replace("abc", "b", $r)', { r: '$1' }), ['ac']);
    assert.deepStrictEqual(values('replace("abc", "b", $r)', { r: 'x' }), ['axc']);
    // F&O's FORX0004 is the engine's JQ2001 here: the front-end maps no engine code to XQuery's
    failsAtRun('replace("abc", "b", $r)', { r: 'x$' });
    failsAtRun('replace("abc", "b", $r)', { r: String.raw`\n` });
    failsAtRun('replace("aBc", "b", $r, "i")', { r: '$' });
    assert.deepStrictEqual(values('replace("abc", "b", $r, "q")', { r: 'x$' }), ['ax$c']);
  });
});
