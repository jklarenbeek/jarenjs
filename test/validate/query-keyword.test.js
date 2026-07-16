import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  JarenValidator,
  ValidationError,
} from '@jarenjs/validate';

describe("Schema '$query' keyword (Jaren JSON Query assertions)", () => {

  describe('happy paths', () => {
    it('should assert invoice-total equality across fields', () => {
      const validate = new JarenValidator().compile({
        type: 'object',
        properties: {
          lines: { type: 'array', items: { type: 'object' } },
          total: { type: 'number' },
        },
        $query: { $eq: ['$.total', { $sum: '$.lines[*].amount' }] },
      });

      assert.strictEqual(validate({
        lines: [{ amount: 12.5 }, { amount: 7.5 }],
        total: 20,
      }), true);
      assert.strictEqual(validate({
        lines: [{ amount: 12.5 }, { amount: 7.5 }],
        total: 21,
      }), false);
      // no lines: $sum over the empty sequence is 0
      assert.strictEqual(validate({ lines: [], total: 0 }), true);
    });

    it('should quantify with $every over line items', () => {
      const validate = new JarenValidator().compile({
        $query: {
          $every: { l: '$.lines[*]' },
          $satisfies: { $gt: ['$l.qty', 0] },
        },
      });

      assert.strictEqual(validate({ lines: [{ qty: 1 }, { qty: 2 }] }), true);
      assert.strictEqual(validate({ lines: [{ qty: 1 }, { qty: 0 }] }), false);
      // $every is vacuously true over an empty tuple stream
      assert.strictEqual(validate({ lines: [] }), true);
    });

    it('should order dates by plain string comparison', () => {
      const validate = new JarenValidator().compile({
        type: 'object',
        $query: { $le: ['$.start', '$.end'] },
      });

      assert.strictEqual(validate({ start: '2026-01-01', end: '2026-12-31' }), true);
      assert.strictEqual(validate({ start: '2026-12-31', end: '2026-01-01' }), false);
    });

    it('should treat a bare JSONPath string as the degenerate query (EBV of the member)', () => {
      const validate = new JarenValidator().compile({ $query: '$.approved' });

      assert.strictEqual(validate({ approved: true }), true);
      assert.strictEqual(validate({ approved: false }), false);
      assert.strictEqual(validate({ approved: '' }), false);
      // missing member: empty sequence, EBV false
      assert.strictEqual(validate({}), false);
      // D3: an array or object member is a truthy singleton
      assert.strictEqual(validate({ approved: [] }), true);
    });

    it('should bind the $root external to the instance root', () => {
      const validate = new JarenValidator().compile({
        type: 'object',
        properties: {
          lines: {
            type: 'array',
            items: {
              type: 'object',
              $query: { $eq: ['$.currency', '$root.currency'] },
            },
          },
        },
      });

      assert.strictEqual(validate({
        currency: 'EUR',
        lines: [{ currency: 'EUR' }, { currency: 'EUR' }],
      }), true);
      assert.strictEqual(validate({
        currency: 'EUR',
        lines: [{ currency: 'EUR' }, { currency: 'USD' }],
      }), false);
    });

    it('should bind the $path external to the instance location', () => {
      const validate = new JarenValidator().compile({
        type: 'object',
        properties: {
          a: { $query: { $eq: ['$path', '/a'] } },
        },
      });
      assert.strictEqual(validate({ a: 1 }), true);

      // at the root the path is the empty pointer
      const atRoot = new JarenValidator().compile({ $query: { $eq: ['$path', ''] } });
      assert.strictEqual(atRoot({}), true);
    });

    it('should compose under properties and items with per-location data and path', () => {
      const validate = new JarenValidator().compile({
        type: 'object',
        properties: {
          pairs: {
            type: 'array',
            // each item sees ITS OWN object as $ and its own pointer as $path
            items: { $query: { $and: [
              { $le: ['$.lo', '$.hi'] },
              { $eq: ['$path', { $concat: ['/pairs/', { $string: '$.i' }] }] },
            ] } },
          },
        },
      });

      assert.strictEqual(validate({ pairs: [
        { lo: 1, hi: 2, i: 0 },
        { lo: 5, hi: 5, i: 1 },
      ] }), true);
      // second item violates its own lo <= hi - proves $ is the item
      assert.strictEqual(validate({ pairs: [
        { lo: 1, hi: 2, i: 0 },
        { lo: 9, hi: 5, i: 1 },
      ] }), false);
      // wrong index recorded - proves $path is per item
      assert.strictEqual(validate({ pairs: [{ lo: 1, hi: 2, i: 4 }] }), false);
    });

    it('should skip like every keyword when the instance location is undefined', () => {
      const validate = new JarenValidator().compile({ $query: '$.approved' });
      assert.strictEqual(validate(undefined), true);
    });
  });

  describe('failures and error reporting', () => {
    it('should report the $query keyword with instancePath and empty params on EBV false', () => {
      const jaren = new JarenValidator({ collectErrors: true });
      const validate = jaren.compile({
        type: 'object',
        properties: {
          invoice: {
            type: 'object',
            $query: { $eq: ['$.total', { $sum: '$.lines[*].amount' }] },
          },
        },
      });

      const good = validate({ invoice: { lines: [{ amount: 1 }], total: 1 } });
      assert.strictEqual(good.valid, true);
      assert.deepStrictEqual(good.errors, []);

      const bad = validate({ invoice: { lines: [{ amount: 1 }], total: 2 } });
      assert.strictEqual(bad.valid, false);
      assert.strictEqual(bad.errors.length, 1);
      const error = bad.errors[0];
      assert.strictEqual(error instanceof ValidationError, true);
      assert.strictEqual(error.keyword, '$query');
      assert.strictEqual(error.instancePath, '/invoice');
      assert.deepStrictEqual(error.params, {});
      assert.strictEqual(error.message, "must satisfy the '$query' assertion");
    });

    it('should just return false in boolean mode', () => {
      const validate = new JarenValidator().compile({ $query: false });
      assert.strictEqual(validate({ anything: 1 }), false);
    });
  });

  describe('runtime-error policy (JQ2xxx is a failed assertion, never a throw)', () => {
    it('should fail, not throw, on arithmetic over hostile data (JQ2001)', () => {
      const validate = new JarenValidator().compile({
        $query: { $gt: [{ $add: ['$.a', 1] }, 0] },
      });
      assert.strictEqual(validate({ a: 1 }), true);
      assert.strictEqual(validate({ a: 'not a number' }), false);
    });

    it('should fail, not throw, on a multi-item EBV (JQ2003)', () => {
      const validate = new JarenValidator().compile({ $query: '$.xs[*]' });
      assert.strictEqual(validate({ xs: [1] }), true);
      assert.strictEqual(validate({ xs: [1, 2] }), false);
    });

    it('should carry the JQ code and query docPath in the error params', () => {
      const jaren = new JarenValidator({ collectErrors: true });

      const arith = jaren.compile({ $query: { $gt: [{ $add: ['$.a', 1] }, 0] } });
      const arithResult = arith({ a: 'oops' });
      assert.strictEqual(arithResult.valid, false);
      assert.strictEqual(arithResult.errors[0].keyword, '$query');
      assert.strictEqual(arithResult.errors[0].instancePath, '');
      assert.deepStrictEqual(arithResult.errors[0].params, { code: 'JQ2001', docPath: '/$gt/0/$add/0' });

      const multi = jaren.compile({ $query: '$.xs[*]' });
      const multiResult = multi({ xs: [1, 2] });
      assert.strictEqual(multiResult.valid, false);
      // the whole result's EBV is undefined: the docPath is the query root
      assert.deepStrictEqual(multiResult.errors[0].params, { code: 'JQ2003', docPath: '' });
      assert.match(multiResult.errors[0].message, /JQ2003/);
    });
  });

  describe('compile errors (schema compile time, not validation time)', () => {
    it('should surface a malformed query document as a schema compile error', () => {
      assert.throws(
        () => new JarenValidator().compile({ $query: { $bogus: [1] } }),
        (e) => {
          assert.match(e.message, /invalid '\$query' document/);
          // the engine error rides along as the cause, code and docPath intact
          assert.strictEqual(e.cause.name, 'JsonQueryCompileError');
          assert.strictEqual(e.cause.code, 'JQ0002');
          return true;
        });
      // arity violation of a known operator
      assert.throws(
        () => new JarenValidator().compile({ $query: { $eq: [1] } }),
        (e) => e.cause?.code === 'JQ0003');
      // mixed $-and-plain keys
      assert.throws(
        () => new JarenValidator().compile({ $query: { $eq: [1, 1], plain: 1 } }),
        (e) => e.cause?.code === 'JQ0001');
    });

    it('should reject externals other than root and path by name', () => {
      assert.throws(
        () => new JarenValidator().compile({ $query: { $ge: ['$.price', '$minPrice'] } }),
        (e) => {
          assert.match(e.message, /'\$query' cannot bind external 'minPrice'/);
          return true;
        });
      // root and path themselves are of course fine
      assert.doesNotThrow(
        () => new JarenValidator().compile({ $query: { $and: [
          { $exists: '$root' }, { $exists: '$path' },
        ] } }));
    });
  });

  describe('recursion between the two compilers', () => {
    it('should resolve a $ref to a schema registered on the owning validator instance', () => {
      const jaren = new JarenValidator();
      jaren.addSchema({
        $id: 'https://jarenjs.dev/schemas/test/money',
        type: 'number',
        minimum: 0,
      });

      const validate = jaren.compile({
        type: 'object',
        $query: { $valid: ['$.lines[*].amount', { $ref: 'https://jarenjs.dev/schemas/test/money' }] },
      });

      assert.strictEqual(validate({ lines: [{ amount: 1 }, { amount: 2 }] }), true);
      assert.strictEqual(validate({ lines: [{ amount: 1 }, { amount: -2 }] }), false);
      // $valid is vacuously true over the empty sequence
      assert.strictEqual(validate({ lines: [] }), true);
    });

    it('should compile a schema literal that itself contains a $query keyword', () => {
      const validate = new JarenValidator().compile({
        type: 'object',
        $query: { $valid: ['$.child', {
          type: 'object',
          $query: { $le: ['$.lo', '$.hi'] },
        }] },
      });

      assert.strictEqual(validate({ child: { lo: 1, hi: 2 } }), true);
      assert.strictEqual(validate({ child: { lo: 3, hi: 2 } }), false);
    });

    it('should keep $assert failures inside the query a validation failure (JQ2008)', () => {
      const jaren = new JarenValidator({ collectErrors: true });
      const validate = jaren.compile({
        $query: { $exists: { $assert: ['$.price', { type: 'number' }] } },
      });

      assert.strictEqual(validate({ price: 10 }).valid, true);
      const result = validate({ price: 'text' });
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.errors[0].params.code, 'JQ2008');
    });
  });

  describe('composition with the rest of the vocabulary', () => {
    it('should evaluate beside the other keywords of the same schema object', () => {
      const validate = new JarenValidator().compile({
        type: 'object',
        required: ['total'],
        properties: { total: { type: 'number' } },
        $query: { $ge: ['$.total', 0] },
      });

      assert.strictEqual(validate({ total: 5 }), true);
      assert.strictEqual(validate({ total: -5 }), false); // $query fails
      assert.strictEqual(validate({}), false); // required fails
      assert.strictEqual(validate({ total: 'x' }), false); // properties/type fails
    });

    it('should apply as a $ref sibling in draft 2019-09+', () => {
      const jaren = new JarenValidator();
      jaren.addSchema({ $id: 'https://jarenjs.dev/schemas/test/base', type: 'object' });
      const validate = jaren.compile({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $ref: 'https://jarenjs.dev/schemas/test/base',
        $query: '$.ok',
      });

      assert.strictEqual(validate({ ok: true }), true);
      assert.strictEqual(validate({ ok: false }), false);
      assert.strictEqual(validate(42), false); // the $ref target still asserts
    });

    it('should not confuse a property named $query with the keyword', () => {
      const validate = new JarenValidator().compile({
        type: 'object',
        properties: {
          $query: { type: 'string' },
        },
      });

      assert.strictEqual(validate({ $query: 'just data' }), true);
      assert.strictEqual(validate({ $query: 42 }), false);
    });
  });
});
