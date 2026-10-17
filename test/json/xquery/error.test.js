import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { compileXQuery } from '@jarenjs/json/xquery';
import { JsonQueryRuntimeError } from '@jarenjs/json/query';

import { validated, values, failsWith } from './emitted.js';

// fn:error and the front-end's own runtime refusals: each raises the
// engine's $error (JQ2017) with XQuery's code and a message that reads the
// refusal itself (XQUERY-FRONTEND.md sections 3 and 4.10).

const ERR = 'http://www.w3.org/2005/xqt-errors';

/** the JQ2017 error `text` raises when it runs */
function raised(text, externals = {}) {
  validated(text);
  try {
    compileXQuery(`[${text}]`)(null, externals);
  }
  catch (e) {
    assert.ok(e instanceof JsonQueryRuntimeError, `expected a runtime error, got ${e.name}: ${e.message}`);
    assert.strictEqual(e.code, 'JQ2017', e.message);
    return e;
  }
  assert.fail(`expected ${text} to raise`);
}

describe('fn:error', () => {
  it('should map every arity onto $error, err:FOER0000 the code it defaults to', () => {
    assert.deepStrictEqual(validated('fn:error()'), { $error: ['err:FOER0000'] });
    assert.deepStrictEqual(validated('error(())'), { $error: ['err:FOER0000'] });
    assert.deepStrictEqual(validated('error((), "no stock")'), { $error: ['err:FOER0000', 'no stock'] });
    assert.deepStrictEqual(validated(`error(QName("${ERR}", "err:FOCH0004"), "d", 7)`),
      { $error: ['err:FOCH0004', 'd', 7] });
  });

  it('should carry the QName as its code: err: in the errors namespace, the local name in none, an EQName otherwise', () => {
    const code = (text) => raised(text).params.code;
    assert.strictEqual(code(`fn:error(fn:QName('${ERR}', 'err:FODT0001'))`), 'err:FODT0001');
    assert.strictEqual(code(`fn:error(fn:QName('${ERR}', 'other:FODT0001'))`), 'err:FODT0001');
    assert.strictEqual(code('error(QName("", "local"), "description")'), 'local');
    assert.strictEqual(code("fn:error(fn:QName('http://www.example.com/HR', 'myerr:toohighsal'))"),
      'Q{http://www.example.com/HR}toohighsal');
    assert.strictEqual(code('fn:error(xs:QName("err:FOER0000"))'), 'err:FOER0000');
    assert.strictEqual(code('fn:error(xs:QName(" onlyAnNCName "))'), 'onlyAnNCName');
  });

  it('should raise with the description as the message and the error object as the value', () => {
    const e = raised('error(QName("", "XPDY6666"), "description", ("error", "object"))');
    assert.deepStrictEqual(e.params, { code: 'XPDY6666', message: 'description', value: ['error', 'object'] });
    assert.strictEqual(e.message, 'JQ2017: XPDY6666: description at /0/$error');
    assert.deepStrictEqual(raised('error((), $d)', { d: 'computed' }).params, { code: 'err:FOER0000', message: 'computed' });
  });

  it('should raise only where it is evaluated', () => {
    assert.deepStrictEqual(values('if (true()) then 1 else error()'), [1]);
    assert.deepStrictEqual(values('if (false()) then error((), "description") else true()'), [true]);
    assert.deepStrictEqual(values('for $x in (1, 2) return if ($x eq 3) then error() else $x'), [1, 2]);
    assert.strictEqual(raised('for $x in (1, 2) return if ($x eq 2) then error() else $x').params.code, 'err:FOER0000');
  });

  it('should give no value to type: a branch that raises leaves the other branch\'s date type', () => {
    const text = 'string-length(if ($ok) then xs:date("2000-01-01") else error())';
    assert.strictEqual(raised(text, { ok: true }).params.code, 'err:XPTY0004');
    assert.strictEqual(raised(text, { ok: false }).params.code, 'err:FOER0000');
  });

  it('should raise XQuery\'s type error for a code that is not a QName', () => {
    for (const text of ['fn:error("Wrong Argument Type")', 'error(1)', 'error(true(), "d")', 'error(xs:date("2000-01-01"))']) {
      const e = raised(text);
      assert.strictEqual(e.params.code, 'err:XPTY0004', text);
      assert.strictEqual(e.params.message, 'fn:error takes an xs:QName as its code');
    }
    assert.strictEqual(raised('error((), xs:date("2000-01-01"))').params.code, 'err:XPTY0004');
  });

  it('should refuse a code it cannot read as the query is read', () => {
    failsWith('error($code)', "unsupported construct 'fn:error code other than a QName constructor'", 0);
    failsWith('error(QName("", "a") || "b")', "unsupported construct 'fn:error code other than a QName constructor'", 0);
    failsWith('error(QName($uri, "a"))', "unsupported construct 'a QName of a computed name'", 6);
    failsWith('error(xs:QName("x:y"))', "unsupported construct 'xs:QName with the prefix x'", 6);
    failsWith('error(QName("", "p:a"))', "unsupported construct 'a QName with a prefix and no namespace'", 6);
    failsWith('error(QName("", "1a"))', "unsupported construct 'a QName that is not a name'", 6);
    failsWith('error(QName("", "a"), "d", "o", "x")', "unsupported function 'error#4'", 0);
  });

  it('should leave a QName anywhere else unsupported, as before', () => {
    failsWith('string(QName("", "a"))', "unsupported function 'QName'", 7);
    failsWith('error((QName("", "a")))', "unsupported function 'QName'", 7);
    failsWith('error((), QName("", "a"))', "unsupported function 'QName'", 10);
    failsWith('xs:QName("a")', "unsupported function 'xs:QName'", 0);
  });
});

describe('the front-end\'s runtime refusals', () => {
  it('should raise a failed cast as XQuery\'s code with the cast as the message, never as a number cast', () => {
    const e = raised('xs:integer("abc")');
    assert.deepStrictEqual(e.params, { code: 'err:FORG0001', message: 'xs:integer: abc' });
    assert.strictEqual(e.message, 'JQ2017: err:FORG0001: xs:integer: abc at /0/$error');
    assert.doesNotMatch(e.message, /JSON number/);
    assert.deepStrictEqual(raised('xs:integer($x)', { x: 'abc' }).params, { code: 'err:FORG0001', message: 'xs:integer: abc' });
  });

  it('should name the code each failed cast has in XQuery', () => {
    const code = (text, externals) => raised(text, externals).params.code;
    assert.strictEqual(code('xs:boolean($x)', { x: 'maybe' }), 'err:FORG0001');
    assert.strictEqual(code('xs:long($x)', { x: 1e20 }), 'err:FORG0001');
    assert.strictEqual(code('xs:byte(300)'), 'err:FORG0001');
    assert.strictEqual(code('xs:integer(xs:double("NaN"))'), 'err:FOCA0002');
    assert.strictEqual(code('xs:decimal($x)', { x: 'INF' }), 'err:FORG0001');
    assert.strictEqual(code('xs:integer($x)', { x: null }), 'err:XPTY0004');
    assert.strictEqual(code('xs:integer((1, 2))'), 'err:XPTY0004');
    assert.deepStrictEqual(raised('xs:integer($x)', { x: [1] }).params,
      { code: 'err:XPTY0004', message: 'xs:integer: the operand is not one atomic value' });
    assert.strictEqual(code('() cast as xs:integer'), 'err:XPTY0004');
    assert.strictEqual(code('xs:date(1)'), 'err:XPTY0004');
    assert.strictEqual(code('xs:date($x)', { x: true }), 'err:XPTY0004');
    assert.strictEqual(code('xs:date("2000-01-01T00:00:00Z")'), 'err:FORG0001');
    assert.strictEqual(code('xs:date($x)', { x: 'May 31' }), 'err:FORG0001');
    assert.strictEqual(code('xs:time(xs:date("2000-01-01"))'), 'err:XPTY0004');
  });

  it('should raise a value outside the front-end\'s date domain as unsupported, which XQuery does not raise', () => {
    const e = raised('xs:date($x)', { x: '1999-05-31Z' });
    assert.deepStrictEqual(e.params, { code: 'unsupported', message: 'xs:date: 1999-05-31Z is a value the front-end does not read' });
  });

  it('should raise the type error of a date use, a position and a tokenize flag with XQuery\'s code', () => {
    assert.deepStrictEqual(raised('boolean(xs:date("2000-01-01"))').params,
      { code: 'err:FORG0006', message: 'an xs:date has no effective boolean value (position 1)' });
    assert.deepStrictEqual(raised('remove((1, 2, 3), 1.5)').params,
      { code: 'err:XPTY0004', message: 'fn:remove: position 1.5' });
    assert.deepStrictEqual(raised('tokenize("a", "b", "t")').params,
      { code: 'err:FORX0001', message: "fn:tokenize: invalid flags 't'" });
  });
});
