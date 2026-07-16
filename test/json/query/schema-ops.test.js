import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  compileJsonQuery,
  JsonQueryCompileError,
  JsonQueryRuntimeError,
} from '@jarenjs/json/query';

// Engine-side tests of the schema operators (QUERY-FORMAT.md sections 6.8
// and 8.11) with a STUB type-test compiler: this file must never import
// @jarenjs/validate - the engine's hook contract is validator-agnostic
// and the real integration lives in test/json/query-validate.test.js.

// A minimal structural interpreter of the schema shapes these tests use;
// records every (schemaJson, docPath) call for the once-per-literal and
// verbatim/freeze assertions.
function makeStubHook(calls = []) {
  const hook = (schemaJson, docPath) => {
    calls.push({ schema: schemaJson, docPath });
    if (schemaJson === false)
      return () => false;
    if (schemaJson === true || typeof schemaJson !== 'object' || schemaJson === null)
      return () => true;
    return (value) => {
      if (schemaJson.type === 'number' && typeof value !== 'number')
        return false;
      if (schemaJson.type === 'string' && typeof value !== 'string')
        return false;
      if (schemaJson.type === 'object') {
        if (typeof value !== 'object' || value === null || Array.isArray(value))
          return false;
        for (const name of schemaJson.required ?? []) {
          if (!Object.hasOwn(value, name))
            return false;
        }
      }
      return true;
    };
  };
  hook.calls = calls;
  return hook;
}

function compileWithStub(doc) {
  return compileJsonQuery(doc, { compileTypeTest: makeStubHook() });
}

function compileFails(doc, options, code, docPath) {
  assert.throws(() => compileJsonQuery(doc, options), (e) => {
    assert.strictEqual(e instanceof JsonQueryCompileError, true, `expected JsonQueryCompileError, got ${e.name}: ${e.message}`);
    assert.strictEqual(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    if (docPath !== undefined)
      assert.strictEqual(e.docPath, docPath, `expected docPath '${docPath}', got '${e.docPath}'`);
    return true;
  });
}

function runtimeFails(query, data, code, docPath) {
  assert.throws(() => query(data), (e) => {
    assert.strictEqual(e instanceof JsonQueryRuntimeError, true, `expected JsonQueryRuntimeError, got ${e.name}: ${e.message}`);
    assert.strictEqual(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    if (docPath !== undefined)
      assert.strictEqual(e.docPath, docPath, `expected docPath '${docPath}', got '${e.docPath}'`);
    return true;
  });
}

const data = {
  nums: [1, 2, 3],
  mixed: [1, 'two', 3],
  books: [
    { title: 'A', isbn: 'i1', price: 3 },
    { title: 'B', price: 4 },
  ],
};

describe('Jaren JSON Query schema operators (stub hook)', () => {

  //#region $valid (section 8.11)

  describe('$valid', () => {
    it('should be true iff every item satisfies the schema', () => {
      const q = compileWithStub({ $valid: ['$.nums[*]', { type: 'number' }] });
      assert.strictEqual(q(data), true);
      assert.strictEqual(compileWithStub({ $valid: ['$.mixed[*]', { type: 'number' }] })(data), false);
    });

    it('should validate per item, never the sequence itself', () => {
      // three number items against {"type": "number"} - an array schema
      // would reject each item
      const q = compileWithStub({ $valid: [{ $seq: [1, 2, 3] }, { type: 'number' }] });
      assert.strictEqual(q(null), true);
      // a single array ITEM ($const) is one item of type array
      assert.strictEqual(
        compileWithStub({ $valid: [{ $const: [1, 2] }, { type: 'number' }] })(null),
        false);
    });

    it('should be vacuously true over the empty sequence', () => {
      assert.strictEqual(compileWithStub({ $valid: ['$.missing', false] })(data), true);
    });

    it('should use the singleton fast path for ONE-cardinality operands', () => {
      assert.strictEqual(compileWithStub({ $valid: [42, { type: 'number' }] })(null), true);
      assert.strictEqual(compileWithStub({ $valid: [42, { type: 'string' }] })(null), false);
    });

    it('should reject bad arity and shape with JQ0003', () => {
      compileFails({ $valid: ['$.a'] }, { compileTypeTest: makeStubHook() }, 'JQ0003', '/$valid');
      compileFails({ $valid: ['$.a', true, true] }, { compileTypeTest: makeStubHook() }, 'JQ0003', '/$valid');
      compileFails({ $valid: 'nope' }, { compileTypeTest: makeStubHook() }, 'JQ0003', '/$valid');
    });
  });

  //#endregion

  //#region $assert (section 8.11)

  describe('$assert', () => {
    it('should be the identity when every item satisfies the schema', () => {
      const q = compileWithStub({ $assert: ['$.nums[*]', { type: 'number' }] });
      assert.deepStrictEqual(q(data), [1, 2, 3]);
      // empty operand: nothing to fail, empty result
      assert.strictEqual(compileWithStub({ $assert: ['$.missing', false] })(data), undefined);
    });

    it('should raise JQ2008 at the operator docPath on the first failing item', () => {
      runtimeFails(compileWithStub({ $assert: ['$.mixed[*]', { type: 'number' }] }), data,
        'JQ2008', '/$assert');
      runtimeFails(compileWithStub({ a: { $assert: ['$.mixed[1]', { type: 'number' }] } }), data,
        'JQ2008', '/a/$assert');
    });

    it('should preserve the operand cardinality on the singleton fast path', () => {
      const q = compileWithStub({ $assert: [{ $add: [1, 2] }, { type: 'number' }] });
      assert.strictEqual(q(null), 3);
    });
  });

  //#endregion

  //#region $as (section 6.8)

  describe('$as', () => {
    it('should validate a $for variable as its one bound item, per tuple', () => {
      const ok = compileWithStub({
        $for: { b: '$.books[*]' },
        $as: { b: { type: 'object', required: ['price'] } },
        $return: '$b.price',
      });
      assert.deepStrictEqual(ok(data), [3, 4]);

      const bad = compileWithStub({
        $for: { b: '$.books[*]' },
        $as: { b: { type: 'object', required: ['isbn'] } },
        $return: '$b.title',
      });
      runtimeFails(bad, data, 'JQ2008', '/$as/b');
    });

    it('should validate a $let variable per item of its bound sequence', () => {
      const ok = compileWithStub({
        $let: { xs: '$.nums[*]' },
        $as: { xs: { type: 'number' } },
        $return: { $sum: '$xs' },
      });
      assert.strictEqual(ok(data), 6);

      const bad = compileWithStub({
        $let: { xs: '$.mixed[*]' },
        $as: { xs: { type: 'number' } },
        $return: { $count: '$xs' },
      });
      runtimeFails(bad, data, 'JQ2008', '/$as/xs');
    });

    it('should pass vacuously over an empty $let sequence', () => {
      const q = compileWithStub({
        $let: { xs: '$.missing[*]' },
        $as: { xs: false },
        $return: { $count: '$xs' },
      });
      assert.strictEqual(q(data), 0);
    });

    it('should apply between $let and $where: a tuple $where would drop still asserts', () => {
      const q = compileWithStub({
        $for: { b: '$.books[*]' },
        $as: { b: { type: 'object', required: ['isbn'] } },
        $where: { $exists: '$b.isbn' }, // would drop the failing book
        $return: '$b.title',
      });
      runtimeFails(q, data, 'JQ2008', '/$as/b');
    });

    it('should accept $at position names and cooperate with barriers', () => {
      const q = compileWithStub({
        $for: { b: { $in: '$.books[*]', $at: 'i' } },
        $as: { b: { type: 'object', required: ['price'] }, i: { type: 'number' } },
        $orderby: { $key: '$b.price', $dir: 'desc' },
        $return: '$b.price',
      });
      assert.deepStrictEqual(q(data), [4, 3]);
    });

    it('should reject a name not bound by the phrase with JQ0005', () => {
      compileFails(
        { $for: { b: '$.books[*]' }, $as: { nope: true }, $return: '$b' },
        { compileTypeTest: makeStubHook() }, 'JQ0005', '/$as/nope');
      // enclosing-phrase bindings do not count: $as asserts THIS phrase
      compileFails(
        { $for: { outer: '$.books[*]' },
          $return: { $let: { x: 1 }, $as: { outer: true }, $return: '$x' } },
        { compileTypeTest: makeStubHook() }, 'JQ0005', '/$return/$as/outer');
    });

    it('should reject bad clause shapes with JQ0003', () => {
      const opts = { compileTypeTest: makeStubHook() };
      compileFails({ $for: { b: '$.books[*]' }, $as: [], $return: '$b' }, opts, 'JQ0003', '/$as');
      compileFails({ $for: { b: '$.books[*]' }, $as: {}, $return: '$b' }, opts, 'JQ0003', '/$as');
      compileFails({ $as: { b: true }, $return: '$b' }, opts, 'JQ0003', '');
      compileFails({ $as: { b: true } }, opts, 'JQ0003', '');
    });
  });

  //#endregion

  //#region the hook contract (JQ0008/JQ0009, raw semantics)

  describe('the compileTypeTest hook contract', () => {
    it('should raise JQ0008 when a schema construct is present and no hook is installed', () => {
      compileFails({ $valid: ['$.a', true] }, undefined, 'JQ0008', '/$valid');
      compileFails({ $assert: ['$.a', true] }, {}, 'JQ0008', '/$assert');
      compileFails({ $for: { x: '$.a[*]' }, $as: { x: true }, $return: '$x' }, {}, 'JQ0008', '/$as/x');
    });

    it('should compile hook-free queries exactly as before', () => {
      assert.strictEqual(compileJsonQuery({ $sum: '$.nums[*]' })(data), 6);
    });

    it('should wrap a hook rejection into JQ0009 at the operator docPath', () => {
      const throwing = () => {
        throw new Error('bad schema');
      };
      compileFails({ $valid: ['$.a', { type: 5 }] }, { compileTypeTest: throwing }, 'JQ0009', '/$valid');
      compileFails(
        { $for: { x: '$.a[*]' }, $as: { x: { type: 5 } }, $return: '$x' },
        { compileTypeTest: throwing }, 'JQ0009', '/$as/x');
    });

    it('should treat a hook returning a non-function as JQ0009', () => {
      compileFails({ $valid: ['$.a', true] }, { compileTypeTest: () => 'nope' }, 'JQ0009', '/$valid');
    });

    it('should pass the schema argument verbatim: operator shapes inside stay literal', () => {
      const hook = makeStubHook();
      // {"$eq": ...} and {"$ref": ...} are JSON Schema data here, never
      // normalized as expressions (they would be JQ0002/JQ0003 if they were)
      const schema = { $eq: ['$x', 1], $ref: '#/$defs/x', $defs: { x: true } };
      compileJsonQuery({ $valid: ['$.a', schema] }, { compileTypeTest: hook });
      assert.strictEqual(hook.calls.length, 1);
      assert.deepStrictEqual(hook.calls[0].schema, schema);
      assert.strictEqual(hook.calls[0].docPath, '/$valid/1');
    });

    it('should call the hook once per schema literal, at compile time', () => {
      const hook = makeStubHook();
      const q = compileJsonQuery({
        $for: { b: '$.books[*]' },
        $as: { b: { type: 'object' } },
        $where: { $valid: ['$b.price', { type: 'number' }] },
        $return: { $assert: ['$b.title', { type: 'string' }] },
      }, { compileTypeTest: hook });
      assert.deepStrictEqual(hook.calls.map((c) => c.docPath),
        ['/$as/b', '/$where/$valid/1', '/$return/$assert/1']);
      q(data);
      q(data); // evaluation never re-invokes the hook
      assert.strictEqual(hook.calls.length, 3);
    });

    it('should hand the hook a deeply frozen copy, decoupled from the caller document', () => {
      const hook = makeStubHook();
      const schema = { type: 'object', required: ['isbn'] };
      const doc = { $valid: ['$.books[0]', schema] };
      const q = compileJsonQuery(doc, { compileTypeTest: hook });
      const received = hook.calls[0].schema;
      assert.notStrictEqual(received, schema, 'must be a copy, not the caller object');
      assert.strictEqual(Object.isFrozen(received), true);
      assert.strictEqual(Object.isFrozen(received.required), true);
      assert.strictEqual(Object.isFrozen(schema), false, 'the caller object is never frozen');
      // mutating the caller's schema after compile has no effect
      schema.required.push('nope');
      assert.strictEqual(q(data), true);
    });
  });

  //#endregion
});
