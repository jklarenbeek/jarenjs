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
    assert.deepStrictEqual(check(-2), { valid: false, errors: [{ code: 'JG2001', docPath: '',
      message: 'the value was rejected by a check that named no error' }] },
      'the bare-boolean check reports invalid with its one coded error, and short-circuits before "even"');
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

describe('core — an invalid outcome always names an error', function () {
  const unnamed = { code: 'JG2001', docPath: '', message: 'the value was rejected by a check that named no error' };

  it('false, {valid:false}, empty errors and non-boolean answers carry one coded error', function () {
    for (const answer of [false, { valid: false }, { valid: false, errors: [] }, { valid: false, errors: null },
      {}, { valid: 1 }, 1, 'true', null, undefined])
      assert.deepStrictEqual(checkOutcome(answer), { valid: false, errors: [unnamed] }, JSON.stringify(answer));
  });

  it('each synthesized error is a fresh plain object a model reads through JSON', function () {
    const a = checkOutcome(false).errors[0], b = checkOutcome(false).errors[0];
    assert.notStrictEqual(a, b);
    assert.strictEqual(Object.getPrototypeOf(a), Object.prototype);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), unnamed);
  });

  it('an outcome that carries errors, and every valid one, answers as before', function () {
    const errors = [{ message: 'x' }];
    assert.strictEqual(checkOutcome({ valid: false, errors }).errors, errors);
    assert.deepStrictEqual(checkOutcome(true), { valid: true, errors: [] });
    assert.deepStrictEqual(checkOutcome({ valid: true }), { valid: true, errors: [] });
    assert.deepStrictEqual(checkOutcome({ valid: true, errors: [{ message: 'w' }] }), { valid: true, errors: [{ message: 'w' }] });
  });

  it('errors is always a list: one error outside a list is the list of it, and text names no error', function () {
    const one = { code: 'X1', docPath: '/a', message: 'x' };
    assert.deepStrictEqual(checkOutcome({ valid: false, errors: one }), { valid: false, errors: [one] });
    assert.strictEqual(checkOutcome({ valid: false, errors: one }).errors[0], one);
    // an empty error object is one error, as it is inside a list
    assert.deepStrictEqual(checkOutcome({ valid: false, errors: {} }), { valid: false, errors: [{}] });
    for (const errors of ['text', '', 0, 5, true, false, () => 'x'])
      assert.deepStrictEqual(checkOutcome({ valid: false, errors }), { valid: false, errors: [unnamed] }, String(errors));
    // a valid answer keeps the same reading, with no list as none
    assert.deepStrictEqual(checkOutcome({ valid: true, errors: one }), { valid: true, errors: [one] });
    for (const errors of ['text', 0, true, null])
      assert.deepStrictEqual(checkOutcome({ valid: true, errors }), { valid: true, errors: [] }, String(errors));
    // composeChecks answers the same list
    assert.deepStrictEqual(composeChecks(() => ({ valid: false, errors: 'bad' }))(1), { valid: false, errors: [unnamed] });
    assert.deepStrictEqual(composeChecks(() => ({ valid: false, errors: one }))(1).errors.slice(), [one]);
  });

  it('composeChecks reports the bare-false check with the coded error and short-circuits', function () {
    let later = 0;
    const check = composeChecks((n) => n > 0, () => { later++; return true; });
    assert.deepStrictEqual(check(-2), { valid: false, errors: [unnamed] });
    assert.strictEqual(later, 0);
    assert.deepStrictEqual(check(2), { valid: true, errors: [] });
  });

  it('a thenable answer is refused JG0001 naming the repair, never read as invalid', async function () {
    let rejectedLater = false;
    const rejecting = Promise.reject(new Error('late')).finally(() => { rejectedLater = true; });
    for (const answer of [Promise.resolve(true), Promise.resolve({ valid: false }), { then() {} }, rejecting])
      assert.throws(() => checkOutcome(answer), (e) => e instanceof Error && e.name === 'CheckOutcomeError'
        && e.code === 'JG0001'
        && e.message === 'JG0001: a check answered a promise, which has not settled — await the check and pass its settled answer');
    assert.throws(() => composeChecks(async () => true)(1), { code: 'JG0001' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(rejectedLater, true, 'the refused promise settled without an unhandled rejection');
  });
});
