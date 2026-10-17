import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { compileXQuery, parseXQuery } from '@jarenjs/json/xquery';
import { JsonQueryRuntimeError } from '@jarenjs/json/query';

import { values, failsWith, failsAtRun } from './emitted.js';

// A date value is typed as the query is read: every use XQuery types as an
// error raises XQuery's code where it is evaluated, and a use whose operand
// may or may not be a date is refused by name.

const D = 'xs:date("2007-01-01")';
const DT = 'xs:dateTime("2007-01-01T00:00:00Z")';
const T = 'xs:time("08:00:00Z")';

/** asserts `text` raises `$error` (JQ2017) with XQuery's `code`, the message naming the position */
function raises(text, code, position, externals = {}) {
  assert.throws(() => compileXQuery(text)(null, externals), (e) => {
    assert.ok(e instanceof JsonQueryRuntimeError, `expected a runtime error, got ${e.name}: ${e.message}`);
    assert.strictEqual(e.code, 'JQ2017', e.message);
    assert.strictEqual(e.params.code, `err:${code}`, e.message);
    assert.ok(e.params.message.endsWith(`(position ${position})`), e.message);
    return true;
  });
}

describe('XQuery front-end: a date value is typed', () => {
  describe('its effective boolean value is FORG0006', () => {
    it('should raise in boolean() and not()', () => {
      raises(`boolean(${D})`, 'FORG0006', 0);
      raises(`fn:not(${T})`, 'FORG0006', 0);
      raises(`boolean((${D}, ${D}))`, 'FORG0006', 0);
    });

    it('should raise in a condition, a where clause, a quantifier and an and/or operand', () => {
      raises(`if (${T}) then 1 else 2`, 'FORG0006', 4);
      raises(`for $x in (1, 2) where ${T} return $x`, 'FORG0006', 23);
      raises(`some $x in (1, 2) satisfies ${D}`, 'FORG0006', 28);
      raises(`true() and ${DT}`, 'FORG0006', 11);
      raises(`${D} or true()`, 'FORG0006', 0);
    });

    it('should read the empty sequence as false, and raise only where it is evaluated', () => {
      assert.deepStrictEqual(values('boolean(xs:date(()))'), [false]);
      assert.deepStrictEqual(values(`if (false()) then boolean(${D}) else 1`), [1]);
      assert.deepStrictEqual(values(`if (exists(${D})) then 1 else 2`), [1]);
    });
  });

  describe('a string parameter does not take one (XPTY0004)', () => {
    it('should raise in every function F&O types a string argument of', () => {
      for (const call of [`string-length(${D})`, `substring(${D}, 1)`, `contains(${D}, "-")`, `contains("a", ${D})`,
        `starts-with(${D}, "2")`, `ends-with(${D}, "1")`, `upper-case(${T})`, `lower-case(${T})`, `normalize-space(${D})`,
        `matches(${D}, "2")`, `replace(${D}, "2", "3")`, `tokenize(${D}, "-")`, `substring-before(${D}, "-")`,
        `substring-after(${D}, "-")`, `translate(${D}, "0", "1")`, `compare(${D}, "a")`, `string-join(("a", "b"), ${T})`])
        raises(call, 'XPTY0004', 0);
    });

    it('should take the empty sequence, and leave the functions that atomize a date to it', () => {
      assert.deepStrictEqual(values('string-length(xs:date(()))'), [0]);
      assert.deepStrictEqual(values(`string(${D})`), ['2007-01-01']);
      assert.deepStrictEqual(values(`concat(${D}, "!")`), ['2007-01-01!']);
      assert.deepStrictEqual(values(`string-join((${D}, ${D}), " ")`), ['2007-01-01 2007-01-01']);
      assert.deepStrictEqual(values(`${D} || "!"`), ['2007-01-01!']);
      assert.deepStrictEqual(values(`count((${D}, ${T}))`), [2]);
    });
  });

  describe('arithmetic takes no date (XPTY0004), and a date difference is a duration', () => {
    it('should raise for a unary plus, a unary minus and an operator with a number', () => {
      raises(`+${D}`, 'XPTY0004', 0);
      assert.throws(() => compileXQuery(`-${D}`)(null), { code: 'JQ2001' });
      assert.throws(() => compileXQuery(`${D} + 1`)(null), { code: 'JQ2001' });
      assert.deepStrictEqual(values('+xs:date(())'), []);
    });

    it('should refuse the difference of two dates: a duration is outside the subset', () => {
      failsWith(`${D} - ${D}`, "unsupported construct 'date arithmetic'", 22);
      failsWith(`let $a := ${T}, $b := ${T} return $a - $b`, "unsupported construct 'date arithmetic'", 69);
    });
  });

  describe('a date compares only with a value of its type (XPTY0004)', () => {
    it('should compare two values of one type in time order', () => {
      assert.deepStrictEqual(values(`${D} lt xs:date("2007-01-02")`), [true]);
      assert.deepStrictEqual(values(`${T} = (${T}, xs:time("09:00:00Z"))`), [true]);
      assert.deepStrictEqual(values('max((xs:date("2000-01-01"), xs:date("2001-01-01")))'), ['2001-01-01']);
      raises('max((xs:date("2000-01-01"), xs:date("2001-01-01"))) = "2001-01-01"', 'XPTY0004', 52);
    });

    it('should raise for a string, a number, another date type or a value from outside', () => {
      raises(`${D} eq "2007-01-01"`, 'XPTY0004', 22);
      raises(`1 = ${D}`, 'XPTY0004', 2);
      raises(`${D} lt ${DT}`, 'XPTY0004', 22);
      raises(`${T} = $s`, 'XPTY0004', 21, { s: '08:00:00Z' });
    });

    it('should answer false where an operand is empty, as XQuery does', () => {
      assert.deepStrictEqual(values(`${D} = ()`), [false]);
      assert.deepStrictEqual(values(`xs:date(()) = "x"`), [false]);
    });
  });

  describe('a function or a clause that compares items reads a date only with its own type', () => {
    it('should refuse an argument or a key that may or may not hold a date', () => {
      failsWith(`min((${D}, ${T}))`, "unsupported construct 'fn:min of a value that may be a date'", 0);
      failsWith(`max((${D}, ${DT}))`, "unsupported construct 'fn:max of a value that may be a date'", 0);
      failsWith(`min((${D}, "2006-01-01"))`, "unsupported construct 'fn:min of a value that may be a date'", 0);
      failsWith(`distinct-values((${D}, $x))`, "unsupported construct 'fn:distinct-values of a value that may be a date'", 0);
      failsWith(`index-of((${D}, ${DT}), ${D})`, "unsupported construct 'fn:index-of of a value that may be a date'", 0);
      failsWith(`for $v in (${D}, "a") order by head($v) return $v`, "unsupported construct 'an order by key of a value that may be a date'", 48);
      failsWith(`for $v in (${D}, "2007-01-01") group by $k := $v return count($v)`,
        "unsupported construct 'a group by key of a value that may be a date'", 63);
    });

    it('should refuse an order by variable that may be a date where the engine ordered a key in a date\'s shape', () => {
      failsAtRun(`for $v in (${D}, "a") order by $v return $v`, {}, 'unsupported');
      failsAtRun(`for $v in (${D}, ${DT}) order by 1, $v descending return $v`, {}, 'unsupported');
      failsAtRun(`for $v in (${D}, $x) order by $v return $v`, { x: '2006-01-01' }, 'unsupported');
      // the engine's own refusals come first: a key of two items, a number and a string
      assert.throws(() => compileXQuery(`let $i := (${D}, ${T}) order by $i return $i`)(null), { code: 'JQ2005' });
      assert.throws(() => compileXQuery(`for $x in (1, "hello", ${D}) order by $x return $x`)(null), { code: 'JQ2005' });
      // no key in a date's shape is no date
      assert.deepStrictEqual(values('for $v in (xs:date($y?a), $x, "a") order by $v return $v', { x: 'b', y: {} }), ['a', 'b']);
      // a count after the order by would bind the name the key reads
      failsWith(`for $c in (${D}, "a") return for $v in (1, 2) order by $c count $c return $v`,
        "unsupported construct 'an order by key of a value that may be a date'", 72);
    });

    it('should find no date among values of another type, evaluating both operands', () => {
      assert.deepStrictEqual(values(`index-of((${D}), "2007-01-01")`), []);
      assert.deepStrictEqual(values(`index-of(("2007-01-01"), ${D})`), []);
      assert.deepStrictEqual(values(`index-of($x, ${D})`, { x: ['2007-01-01'] }), []);
      assert.deepStrictEqual(values(`index-of((${D}), ${DT})`), []);
      assert.throws(() => compileXQuery(`index-of((${D}), ("a", "b"))`)(null), { code: 'JQ2001' });
    });

    it('should answer over one date type, the empty sequence and values of no date as before', () => {
      const D2 = 'xs:date("2006-05-01")';
      assert.deepStrictEqual(values(`min((${D}, ${D2}))`), ['2006-05-01']);
      assert.deepStrictEqual(values(`max((${D}, ()))`), ['2007-01-01']);
      assert.deepStrictEqual(values('min(("b", "a"))'), ['a']);
      assert.deepStrictEqual(values(`distinct-values((${D}, ${D2}, ${D}))`), ['2007-01-01', '2006-05-01']);
      assert.deepStrictEqual(values(`index-of((${D2}, ${D}), ${D})`), [2]);
      assert.deepStrictEqual(values('index-of(("a", "b"), "b")'), [2]);
      assert.deepStrictEqual(values(`index-of((), ${D})`), []);
      assert.deepStrictEqual(values(`for $v in (${D}, ${D2}) order by $v return $v`), ['2006-05-01', '2007-01-01']);
      assert.deepStrictEqual(values(`for $v in (${D}, ${D2}, ${D}) group by $k := $v return count($v)`), [2, 1]);
      assert.deepStrictEqual(values('for $v in ("b", "a") order by $v return $v'), ['a', 'b']);
    });
  });

  describe('a guard emits its operand once', () => {
    // each shape nests `n` uses that guard an operand typed as a date
    const nested = {
      'unary plus': (n) => '+('.repeat(n) + D + ')'.repeat(n),
      'head of a unary plus': (n) => Array.from({ length: n }).reduce((e) => `head((+${e}))`, D),
      'a comparison': (n) => Array.from({ length: n }).reduce((e) => `(if (${e} eq 1) then ${D} else ${D})`, D),
      'a string argument': (n) => Array.from({ length: n }).reduce((e) => `(if (contains(${e}, "a")) then ${D} else ${D})`, D),
      'fn:boolean': (n) => Array.from({ length: n }).reduce((e) => `(if (boolean(${e})) then ${D} else ${D})`, D),
      'a condition': (n) => Array.from({ length: n }).reduce((e) => `(if (${e}) then ${D} else ${D})`, D),
    };

    it('should grow the emitted document linearly with the nesting', () => {
      for (const [name, text] of Object.entries(nested)) {
        const size = (n) => JSON.stringify(parseXQuery(text(n))).length;
        const ratio = size(16) / size(2);
        assert.ok(ratio < 12, `${name}: 8x the nesting emits ${ratio.toFixed(1)}x the document`);
      }
    });

    it('should still raise, and read a guarded empty operand as the empty sequence', () => {
      raises(`+(+(+${D}))`, 'XPTY0004', 4);
      assert.deepStrictEqual(values('+(+(xs:date(())))'), []);
      assert.deepStrictEqual(values(`(if (xs:date(()) eq 1) then ${D} else 3)`), [3]);
      assert.deepStrictEqual(values('contains(xs:date(()), "")'), [true]);
      assert.deepStrictEqual(values('let $d := xs:date(()) return contains($d, let $d := "x" return $d)'), [false]);
    });

    it('should bind a comparison\'s operands under a name no operand is read beneath', () => {
      raises(`let $ty_args := 1 return ${D} eq $ty_args`, 'XPTY0004', 47);
      assert.deepStrictEqual(values(`let $ty_args := () return ${D} = $ty_args`), [false]);
    });
  });

  describe('the type flows through bindings and the functions that pass items on', () => {
    it('should type a variable a let, a for or a quantifier binds, and the items head and its kin give', () => {
      raises(`let $d := ${D} return boolean($d)`, 'FORG0006', 39);
      raises(`for $d in (${D}, ${D}) return string-length($d)`, 'XPTY0004', 64);
      raises(`some $d in (${T}) satisfies $d = "x"`, 'XPTY0004', 47);
      raises(`boolean(head((${D}, ${D})))`, 'FORG0006', 0);
      raises(`boolean(subsequence((${D}), 1, 1))`, 'FORG0006', 0);
      raises(`boolean(for $x in 1 return ${D})`, 'FORG0006', 0);
      raises(`boolean(if (true()) then ${D} else ())`, 'FORG0006', 0);
    });

    it('should let a binding shadow a date variable, and end where its scope ends', () => {
      assert.deepStrictEqual(values(`let $d := ${D} let $d := "x" return boolean($d)`), [true]);
      assert.deepStrictEqual(values(`(for $d in ${D} return 1, boolean($d))`, { d: 'x' }), [1, true]);
      assert.deepStrictEqual(values(`let $d := ${D} return xs:string($d) = "2007-01-01"`), [true]);
    });

    it('should refuse a use whose operand may or may not hold a date', () => {
      failsWith(`for $x in (${D}, "a") return boolean($x)`, "unsupported construct 'the effective boolean value of a value that may be a date'", 46);
      failsWith(`string-length(if ($c) then ${D} else "a")`, "unsupported construct 'a string argument of fn:string-length of a value that may be a date'", 0);
      failsWith(`[${D}]?1 = "x"`, "unsupported construct 'a comparison of a value that may be a date'", 26);
      failsWith(`let $m := map { "d": ${D} } return $m?d eq "x"`, "unsupported construct 'a comparison of a value that may be a date'", 57);
      failsWith(`+(${D}, 1)`, "unsupported construct 'unary plus of a value that may be a date'", 0);
    });
  });
});
