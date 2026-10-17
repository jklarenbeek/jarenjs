import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { compileXQuery } from '@jarenjs/json/xquery';
import { JsonQueryRuntimeError } from '@jarenjs/json/query';

import { values, failsWith } from './emitted.js';

// A date value is typed as the query is read: every use XQuery types as an
// error raises XQuery's code where it is evaluated, and a use whose operand
// may or may not be a date is refused by name.

const D = 'xs:date("2007-01-01")';
const DT = 'xs:dateTime("2007-01-01T00:00:00Z")';
const T = 'xs:time("08:00:00Z")';

/** asserts `text` raises JQ2001 naming XQuery's `code` and the position */
function raises(text, code, position, externals = {}) {
  assert.throws(() => compileXQuery(text)(null, externals), (e) => {
    assert.ok(e instanceof JsonQueryRuntimeError, `expected a runtime error, got ${e.name}: ${e.message}`);
    assert.strictEqual(e.code, 'JQ2001', e.message);
    assert.ok(e.message.includes(`${code}: `), e.message);
    assert.ok(e.message.includes(`(position ${position})`), e.message);
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
