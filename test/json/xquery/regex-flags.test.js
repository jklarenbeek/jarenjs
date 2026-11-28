import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { validated, values, failsAtRun, failsWith } from './emitted.js';

// F&O's regular-expression flags on fn:matches, fn:replace and
// fn:tokenize: a literal pattern is rewritten into the I-Regexp that
// matches what it matches under the flags; what no I-Regexp can say is
// refused by name.

// an XQuery string literal: no escapes but the doubled quote
const literal = (text) => `"${text.replace(/"/g, '""')}"`;
const matches = (s, pattern, flags) => values(`matches(${literal(s)}, ${literal(pattern)}, ${literal(flags)})`)[0];
const emitted = (pattern, flags) => validated(`matches($s, ${literal(pattern)}, ${literal(flags)})`).$search[1];

describe('XQuery front-end regular-expression flags', () => {
  it('should read no flags as the call without them, for each function', () => {
    assert.deepStrictEqual(validated('matches($s, "a.", "")'), { '$search': ['$s', 'a.'] });
    assert.deepStrictEqual(validated('replace($s, "a", "\\$", "")'), { '$replace': ['$s', 'a', '$$'] });
    assert.deepStrictEqual(validated('fn:tokenize($s, ",", "")'), { '$tokenize': ['$s', ','] });
    assert.deepStrictEqual(values('replace("abracadabra", "bra", "*", "")'), ['a*cada*']);
  });

  describe('i', () => {
    it('should match a letter in either case, in and out of a class, a negated class excluding both', () => {
      assert.strictEqual(emitted('ABC', 'i'), '[Aa][Bb][Cc]');
      assert.strictEqual(matches('abc', 'ABC', 'i'), true);
      assert.strictEqual(matches('aBc', '^abc$', 'i'), true);
      assert.strictEqual(matches('abd', 'ABC', 'i'), false);
      assert.strictEqual(emitted('[^Q]', 'i'), '[^Qq]');
      assert.strictEqual(matches('Q', '[^Q]', 'i'), false);
      assert.strictEqual(matches('q', '[^Q]', 'i'), false);
      assert.strictEqual(matches('r', '[^Q]', 'i'), true);
      assert.strictEqual(emitted('[x-z0-9]', 'i'), '[x-z0-9XYZ]');
      assert.strictEqual(matches('Y', '^[x-z]$', 'i'), true);
      assert.strictEqual(matches('W', '^[x-z]$', 'i'), false);
    });

    it('should leave a category escape as it is', () => {
      assert.strictEqual(emitted('\\p{Lu}', 'i'), '\\p{Lu}');
      assert.strictEqual(matches('m', '\\p{Lu}', 'i'), false);
      assert.strictEqual(matches('m', '\\P{Lu}', 'i'), true);
      assert.strictEqual(emitted('[\\p{Ll}z]', 'i'), '[\\p{Ll}zZ]');
      assert.strictEqual(matches('Q', '[\\p{Ll}z]', 'i'), false);
    });

    it('should match the Kelvin sign with k and the long s with s, and nothing else outside ASCII', () => {
      assert.strictEqual(emitted('k', 'i'), '[kKK]');
      assert.strictEqual(emitted('S', 'i'), '[Ssſ]');
      assert.strictEqual(matches('K', 'K', 'i'), true);
      assert.strictEqual(matches('K', '^[j-l]$', 'i'), true);
      assert.strictEqual(matches('K', 'k', ''), false);
      assert.strictEqual(matches('ſ', 's', 'i'), true);
      assert.strictEqual(matches('ſ', '[r-t]', 'i'), true);
      assert.strictEqual(matches('ſ', 'f', 'i'), false);
      for (const dotted of ['İ', 'ı'])
        assert.strictEqual(matches(dotted, '[a-h]|[j-z]', 'i'), false);
    });

    it('should keep a dash, an escape and a quantifier where they were', () => {
      assert.strictEqual(emitted('[a-]', 'i'), '[a\\-A]');
      assert.strictEqual(matches('-', '^[a-]$', 'i'), true);
      assert.strictEqual(emitted('[^-b]', 'i'), '[^\\-bB]');
      assert.strictEqual(matches('B', '[^-b]', 'i'), false);
      assert.strictEqual(emitted('a\\.b{2}', 'i'), '[aA]\\.[bB]{2}');
      assert.strictEqual(matches('A.BB', '^a\\.b{2}$', 'i'), true);
    });

    it('should refuse the letter i and characters outside ASCII, whose case variants F&O leaves to a reading', () => {
      for (const pattern of ['i', 'I', '[h-j]', '[A-Z]', '[!-~]'])
        failsWith(`matches($s, "${pattern}", "i")`, "unsupported construct 'matches flag i with the letter i'", 0);
      for (const pattern of ['é', '[a-ÿ]', 'İ'])
        failsWith(`matches($s, "${pattern}", "i")`, "unsupported construct 'matches flag i with a character outside ASCII'", 0);
    });
  });

  it('should let s read a dot outside a class as every character', () => {
    assert.strictEqual(emitted('a.b', 's'), 'a[\\p{L}\\P{L}]b');
    assert.strictEqual(matches('a\nb', 'a.b', 's'), true);
    assert.strictEqual(matches('a\rb', '^a.b$', 's'), true);
    assert.strictEqual(matches('a\nb', 'a.b', ''), false);
    assert.strictEqual(emitted('[.]\\.', 's'), '[.]\\.');
    assert.strictEqual(matches('a\nb', 'a[.]b', 's'), false);
  });

  it('should let x remove the white space outside a class, before the pattern is read', () => {
    assert.strictEqual(emitted(' hello[ ]world ', 'x'), 'hello[ ]world');
    assert.strictEqual(matches('hello world', 'he ll o[ ]worl d', 'x'), true);
    assert.strictEqual(matches('helloworld', 'he ll o worl d', 'x'), true);
    assert.strictEqual(emitted('a\\ .', 'x'), 'a\\.');
    assert.strictEqual(emitted('\\p{ L u }+\n\t\r', 'x'), '\\p{Lu}+');
    assert.strictEqual(emitted('a{2, 3}', 'x'), 'a{2,3}');
    assert.strictEqual(emitted('[ \\]]', 'x'), '[ \\]]');
  });

  it('should read m where the pattern has no anchor, and refuse it beside one', () => {
    assert.strictEqual(emitted('b', 'm'), 'b');
    assert.strictEqual(emitted('[$^]', 'm'), '[$^]');
    assert.strictEqual(matches('a$', '[$^]', 'm'), true);
    failsWith('matches($s, "^b", "m")', "unsupported construct 'matches flag m with an anchor'", 0);
    failsWith('matches($s, "a$", "sm")', "unsupported construct 'matches flag m with an anchor'", 0);
  });

  it('should combine the flags, and write a pattern that starts with a dollar escaped', () => {
    assert.strictEqual(emitted(' a . ', 'six'), '[aA][\\p{L}\\P{L}]');
    assert.strictEqual(matches('A\n', 'a .', 'xsi'), true);
    assert.deepStrictEqual(validated('matches($s, "$", "s")'), { '$search': ['$s', '$$'] });
    assert.strictEqual(matches('a', '$', 's'), true);
  });

  it('should read q as plain text, with i its letters in either case and s, m, x no effect', () => {
    assert.strictEqual(matches('x[Y-z]', 'X[y-Z]', 'qi'), true);
    assert.strictEqual(emitted('X[y-Z]', 'qi'), '[Xx]\\[[yY]-[Zz]\\]');
    assert.strictEqual(matches('abracadabra', '(?:abra(?:cad)?)*', 'q'), false);
    assert.strictEqual(matches('a(?:b', '(?:', 'q'), true);
    assert.strictEqual(emitted('^a b$', 'qmsx'), '\\^a b[$]');
    assert.deepStrictEqual(values('fn:tokenize("A.BRA.CADA.BRA", "a.", "qi")'), ['', 'BR', 'CAD', 'BRA']);
    failsWith('matches($s, "i", "qi")', "unsupported construct 'matches flag i with the letter i'", 0);
  });

  it('should rewrite the pattern of replace and tokenize alike', () => {
    assert.deepStrictEqual(values('replace("aBc", "b", "*", "i")'), ['a*c']);
    assert.deepStrictEqual(validated('replace($s, " b ", "*", "ix")'), { '$replace': ['$s', '[bB]', '*'] });
    assert.deepStrictEqual(values('tokenize("aXbxc", "x", "i")'), ['a', 'b', 'c']);
    assert.deepStrictEqual(values('tokenize("a\nb", ".", "s")'), ['', '', '', '']);
    assert.deepStrictEqual(values('tokenize("a\nb", "\n.", "s")'), ['a', '']);
    failsAtRun('replace("abc", "x*", "y", "i")');
    failsAtRun('tokenize("abc", " ", "x")');
  });

  it("should take a replacement literally under q, and read F&O's escapes in it otherwise", () => {
    assert.deepStrictEqual(values('replace("abracadabra", "a", "$1", "q")'), ['$1br$1c$1d$1br$1']);
    assert.deepStrictEqual(values('replace("a/b/c", "/", "\\", "q")'), ['a\\b\\c']);
    assert.deepStrictEqual(values('replace("aB", "b", "$0", "qi")'), ['a$0']);
    assert.deepStrictEqual(values('replace("aB", "b", "\\\\", "i")'), ['a\\']);
    assert.deepStrictEqual(validated('replace($s, "(b)", "$1", "i")'), { '$replace': ['$s', '([bB])', '$$1', true] });
    assert.deepStrictEqual(validated('replace($s, "b", $r, "i")'), { '$replace': ['$s', '[bB]', '$r', true] });
  });

  it('should refuse a pattern or flags computed when the query runs, and a pattern no I-Regexp reads', () => {
    failsWith('matches($s, $p, "i")', "unsupported construct 'matches flag i with a computed pattern'", 0);
    failsWith('replace($s, $p, "*", "xq")', "unsupported construct 'replace flag x with a computed pattern'", 0);
    failsWith('matches($s, "a", $f)', "unsupported construct 'matches flags other than a literal'", 0);
    failsWith('matches($s, "hello\\ sworld", "x")', "unsupported construct 'matches flag x with a pattern that is no I-Regexp'", 0);
    failsWith('matches($s, "(a)\\1", "i")', "unsupported construct 'matches flag i with a pattern that is no I-Regexp'", 0);
    failsWith('matches($s, "[A-Z-[OI]]", "si")', "unsupported construct 'matches flag s with a pattern that is no I-Regexp'", 0);
    // the grammar admits these, a RegExp does not
    failsWith('matches($s, "[z-a]", "s")', "unsupported construct 'matches flag s with a pattern that is no I-Regexp'", 0);
    failsWith('tokenize($s, "a{3,2}", "x")', "unsupported construct 'tokenize flag x with a pattern that is no I-Regexp'", 0);
  });

  it('should raise FORX0001 for a letter F&O does not define and XPTY0004 for the empty sequence, when the call runs', () => {
    failsAtRun('matches("a", "a", "p")', {}, 'err:FORX0001');
    failsAtRun('replace("a", "a", "b", "X")', {}, 'err:FORX0001');
    failsAtRun('matches("a", "a", " ")', {}, 'err:FORX0001');
    failsAtRun('matches("a", "a", ())', {}, 'err:XPTY0004');
    assert.deepStrictEqual(values('if (false()) then matches("a", "a", "p") else 1'), [1]);
  });

  it('should refuse the arities F&O does not have', () => {
    failsWith('matches($s)', "unsupported function 'matches#1'", 0);
    failsWith('matches($s, "a", "", ())', "unsupported function 'matches#4'", 0);
    failsWith('replace($s, "a", "b", "", ())', "unsupported function 'replace#5'", 0);
  });
});
