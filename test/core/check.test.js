//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { checkOutcome, composeChecks } from '@jarenjs/core/check';
import { compileJsonQuery, JsonQueryCompileError } from '@jarenjs/json/query';

function compileGate(compile) {
  return (doc) => {
    try {
      compile(doc);
      return true;
    }
    catch (err) {
      const e = /** @type {any} */ (err);
      return { valid: false, errors: [{ code: e.code, docPath: e.docPath, message: e.message }] };
    }
  };
}

describe('core — composeChecks', function () {
  it('passes a value through every check; the first invalid wins', function () {
    const positive = (n) => n > 0;
    const even = (n) => (n % 2 === 0 ? true : { valid: false, errors: [{ message: 'odd' }] });
    const check = composeChecks(positive, even);
    assert.deepStrictEqual(check(4), { valid: true, errors: [] });
    assert.deepStrictEqual(check(3), { valid: false, errors: [{ message: 'odd' }] });
    assert.deepStrictEqual(check(-2), { valid: false, errors: [] },
      'the bare-boolean check reports invalid with no errors, and short-circuits before "even"');
  });

  it('order matters: the earlier failing check is the one reported', function () {
    const a = () => ({ valid: false, errors: [{ message: 'A' }] });
    const b = () => ({ valid: false, errors: [{ message: 'B' }] });
    assert.deepStrictEqual(composeChecks(a, b)(0).errors, [{ message: 'A' }]);
    assert.deepStrictEqual(composeChecks(b, a)(0).errors, [{ message: 'B' }]);
  });

  it('mixes boolean and {valid,errors} checks freely', function () {
    const check = composeChecks((v) => typeof v === 'object', (v) => v.ok === true);
    assert.strictEqual(check({ ok: true }).valid, true);
    assert.strictEqual(check(42).valid, false);
  });

  it('a JarenValidator schema check composes with an engine compile gate', function () {
    // schema: a jaren-query is any JSON; the compile gate is the real
    // semantic check. A structurally-fine value that names an unknown
    // operator passes the schema and fails the gate.
    const schemaCheck = () => true;
    const check = composeChecks(schemaCheck, compileGate(compileJsonQuery));
    assert.strictEqual(check({ $for: { b: '$.x[*]' }, $return: '$b' }).valid, true);
    const bad = check({ $bogus: [1] });
    assert.strictEqual(bad.valid, false);
    assert.strictEqual(bad.errors[0].code, 'JQ0002', 'the query engine\'s own code survives');
    assert.strictEqual(typeof bad.errors[0].docPath, 'string');
  });
});

describe('core — the compile-gate adapter reads the real error shape', function () {
  it('a JQ compile error exposes code and docPath', function () {
    let caught;
    try { compileJsonQuery({ $bogus: [1] }); }
    catch (err) { caught = err; }
    assert.ok(caught instanceof JsonQueryCompileError);
    assert.strictEqual(typeof /** @type {any} */ (caught).code, 'string');
    assert.strictEqual(typeof /** @type {any} */ (caught).docPath, 'string');
    assert.strictEqual(checkOutcome(compileGate(compileJsonQuery)({ $bogus: [1] })).valid, false);
  });
});

it('accepts strict true only and preserves first-failure error identity', () => {
  for (const value of [1, 'true', {}, { valid: 1 }, null, undefined]) assert.equal(checkOutcome(value).valid, false);
  assert.equal(checkOutcome(true).valid, true);
  assert.equal(checkOutcome({ valid: true }).valid, true);
  const errors = [{ message: 'original' }]; let later = 0;
  assert.equal(composeChecks(() => ({valid:false, errors}), () => { later++; return true; })(0).errors, errors);
  assert.equal(later, 0);
});
