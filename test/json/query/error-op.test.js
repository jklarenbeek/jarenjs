import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  compileJsonQuery, queryJson, renderQueryMessage, queryMessagesEn, JsonQueryCompileError, JsonQueryRuntimeError,
} from '@jarenjs/json/query';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';

// $error (QUERY-FORMAT.md section 8.17): the query raises an error of its
// own, JQ2017, carrying the code and the message the document gave.

/** the error `run` throws, asserted to be a runtime error */
function thrown(run) {
  try {
    run();
  }
  catch (e) {
    assert.ok(e instanceof JsonQueryRuntimeError, `expected a runtime error, got ${e.name}: ${e.message}`);
    return e;
  }
  assert.fail('expected the query to raise');
}

describe('$error', () => {
  it('should raise JQ2017 with the code and the message as members', () => {
    const e = thrown(() => queryJson({ $error: ['E-LIMIT', 'the order is over its limit'] }, null));
    assert.strictEqual(e.code, 'JQ2017');
    assert.strictEqual(e.docPath, '/$error');
    assert.strictEqual(e.messageId, 'query/raised-message');
    assert.deepStrictEqual(e.params, { code: 'E-LIMIT', message: 'the order is over its limit' });
    assert.strictEqual(e.reason, 'E-LIMIT: the order is over its limit');
    assert.strictEqual(e.message, 'JQ2017: E-LIMIT: the order is over its limit at /$error');
  });

  it('should raise with the code alone when no message is given, or the message is empty', () => {
    for (const doc of [{ $error: ['E1'] }, { $error: ['E1', ''] }, { $error: ['E1', { $seq: [] }] }]) {
      const e = thrown(() => queryJson(doc, null));
      assert.strictEqual(e.code, 'JQ2017');
      assert.strictEqual(e.messageId, 'query/raised');
      assert.deepStrictEqual(e.params, { code: 'E1' });
      assert.strictEqual(e.reason, 'E1');
    }
  });

  it('should carry the third operand as the items of its value', () => {
    const items = (value) => thrown(() => queryJson({ $error: ['E1', 'm', value] }, { a: [1, 2] })).params.value;
    assert.deepStrictEqual(items('$.a'), [[1, 2]]);
    assert.deepStrictEqual(items('$.a[*]'), [1, 2]);
    assert.deepStrictEqual(items({ $seq: [] }), []);
    assert.deepStrictEqual(items(null), [null]);
  });

  it('should compute its operands when the query runs', () => {
    const query = compileJsonQuery({ $error: [{ $concat: ['E-', '$.kind'] }, { $concat: ['bad ', '$.kind'] }] });
    const e = thrown(() => query({ kind: 'size' }));
    assert.deepStrictEqual(e.params, { code: 'E-size', message: 'bad size' });
  });

  it('should never raise while the query compiles, a constant one included', () => {
    assert.doesNotThrow(() => compileJsonQuery({ $error: ['E1', 'constant'] }));
    // only an evaluated $error raises
    assert.strictEqual(queryJson({ $if: [false, { $error: ['E1'] }, 'fine'] }, null), 'fine');
    assert.strictEqual(queryJson({ $coalesce: ['first', { $error: ['E1'] }] }, null), 'first');
  });

  it('should raise in every way a compiled query is run', () => {
    const query = compileJsonQuery({ $if: ['$.bad', { $error: ['E1', 'bad'] }, 1] });
    for (const run of [query, query.items, query.first, query.exists, query.ebv]) {
      const e = thrown(() => run({ bad: true }));
      assert.strictEqual(e.code, 'JQ2017');
      assert.deepStrictEqual(e.params, { code: 'E1', message: 'bad' });
    }
    assert.strictEqual(query({ bad: false }), 1);
  });

  it('should raise wherever it is evaluated: under an aggregate, an existence test, a FLWOR', () => {
    for (const doc of [
      { $count: { $error: ['E1'] } },
      { $exists: { $error: ['E1'] } },
      { $empty: { $error: ['E1'] } },
      { $for: { x: { $seq: [1, 2] } }, $return: { $if: [{ $eq: ['$x', 2] }, { $error: ['E1'] }, '$x'] } },
      { a: { $error: ['E1'] } },
    ]) {
      const e = thrown(() => queryJson(doc, null));
      assert.strictEqual(e.code, 'JQ2017', JSON.stringify(doc));
    }
  });

  it('should refuse a code that is not one string, and a message that is not a string (JQ2001)', () => {
    for (const [doc, docPath] of [
      [{ $error: [1] }, '/$error/0'],
      [{ $error: [{ $seq: [] }] }, '/$error/0'],
      [{ $error: [{ $seq: ['a', 'b'] }] }, '/$error/0'],
      [{ $error: ['E1', 2] }, '/$error/1'],
    ]) {
      const e = thrown(() => queryJson(doc, null));
      assert.strictEqual(e.code, 'JQ2001', JSON.stringify(doc));
      assert.strictEqual(e.messageId, 'query/expected-string');
      assert.strictEqual(e.docPath, docPath);
    }
  });

  it('should refuse no operand and more than three when the query compiles (JQ0003)', () => {
    for (const doc of [{ $error: [] }, { $error: ['a', 'b', 'c', 'd'] }, { $error: 'E1' }]) {
      assert.throws(() => compileJsonQuery(doc), (e) => e instanceof JsonQueryCompileError && e.code === 'JQ0003',
        JSON.stringify(doc));
    }
  });

  it('should point a writer who guesses another name at $error', () => {
    for (const name of ['$throw', '$raise']) {
      assert.throws(() => compileJsonQuery({ [name]: ['E1'] }), (e) => e.code === 'JQ0002'
        && e.messageId === 'query/unknown-operator-use' && e.params.use === "'$error'", name);
    }
  });

  it('should render through any catalog with the carried code and message unchanged', () => {
    const e = thrown(() => queryJson({ $error: ['E1', 'over the limit'] }, null));
    const catalog = { ...queryMessagesEn, 'query/raised-message': '[{code}] {message}' };
    assert.strictEqual(renderQueryMessage(e, catalog), '[E1] over the limit');
  });

  it('should reach a JSLT rule body as the rule\'s runtime error, wrapping it', () => {
    const sheet = compileJsltStylesheet([{ match: '$', body: { $error: ['E1', 'no'] } }]);
    assert.throws(() => sheet({}), (e) => {
      assert.strictEqual(e.code, 'JT2004');
      assert.strictEqual(e.cause.code, 'JQ2017');
      assert.deepStrictEqual(e.cause.params, { code: 'E1', message: 'no' });
      return true;
    });
  });
});
