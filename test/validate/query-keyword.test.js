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

  describe('runtime-error policy (a data-shaped JQ2xxx is a failed assertion; a limit is thrown)', () => {
    it('should fail, not throw, on every data-shaped code (JQ2001-JQ2005, JQ2008)', () => {
      const jaren = new JarenValidator({ collectErrors: true });
      const cases = [
        [{ $add: ['$.a', 1] }, { a: 'x' }, 'JQ2001', '/$add/0'],
        [{ $idiv: ['$.a', 0] }, { a: 1 }, 'JQ2002', '/$idiv'],
        ['$.xs[*]', { xs: [1, 2] }, 'JQ2003', ''],
        [{ $exists: { $map: [['$.k', 1]] } }, { k: 1 }, 'JQ2004', '/$exists/$map/0/0'],
        [{ $sort: '$.xs[*]' }, { xs: [1, 'a'] }, 'JQ2005', '/$sort'],
        [{ $assert: ['$.a', { type: 'string' }] }, { a: 1 }, 'JQ2008', '/$assert'],
      ];
      const seen = cases.map(([query, data]) => {
        const result = jaren.compile({ $query: query })(data);
        return [result.valid, result.errors[0]?.params];
      });
      assert.deepStrictEqual(seen, cases.map(([, , code, docPath]) => [false, { code, docPath }]));
    });

    it('should throw an execution limit (JQ2007), so not never reads it as success', () => {
      const range = { $gt: [{ $count: { $reverse: { $range: [0, '$.n'] } } }, 0] };
      for (const collectErrors of [false, true]) {
        const jaren = new JarenValidator({ collectErrors });
        const holds = jaren.compile({ $query: range });
        const negated = jaren.compile({ not: { $query: range } });
        const valid = (r) => (typeof r === 'object' ? r.valid : r);
        assert.deepStrictEqual([valid(holds({ n: 10 })), valid(negated({ n: 10 }))], [true, false]);
        assert.throws(() => holds({ n: 2000000 }),
          { name: 'JsonQueryRuntimeError', code: 'JQ2007', docPath: '/$gt/0/$count/$reverse/$range' });
        assert.throws(() => negated({ n: 2000000 }), { name: 'JsonQueryRuntimeError', code: 'JQ2007' });
      }
    });

    it('should compile a schema literal whose $query refuses only null', () => {
      const onNull = { $if: [{ $eq: ['$', null] }, 2000000, 3] };
      const literal = { $query: { $gt: [{ $count: { $range: [0, onNull] } }, 0] } };
      for (const collectErrors of [false, true]) {
        const validate = new JarenValidator({ collectErrors }).compile({ $query: { $valid: ['$.a', literal] } });
        const valid = (r) => (typeof r === 'object' ? r.valid : r);
        assert.strictEqual(valid(validate({ a: 5 })), true);
        assert.throws(() => validate({ a: null }), { name: 'JsonQueryRuntimeError', code: 'JQ2007' });
      }
    });

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
    /** The refusal a compile throws, as the plain fields a host or a model reads. */
    const refusal = (schema) => {
      try {
        new JarenValidator().compile(schema);
      }
      catch (e) {
        return { name: e.name, code: e.code, docPath: e.docPath, message: e.message,
          cause: { name: e.cause?.name, code: e.cause?.code, docPath: e.cause?.docPath } };
      }
      return null;
    };
    const ROOT = 'https://github.com/jklarenbeek/jarenjs#';

    it('refuses a malformed query document with the query compiler\'s code, located under $query', () => {
      assert.deepStrictEqual(refusal({ $query: { $bogus: [1] } }), {
        name: 'SchemaCompileError', code: 'JQ0002', docPath: `${ROOT}/%24query`,
        message: `JQ0002: invalid '$query' document: unknown operator '$bogus' at ${ROOT}/%24query`,
        cause: { name: 'JsonQueryCompileError', code: 'JQ0002', docPath: '' },
      });
      // arity violation of a known operator, located at the operator
      assert.deepStrictEqual(refusal({ $query: { $eq: [1] } }), {
        name: 'SchemaCompileError', code: 'JQ0003', docPath: `${ROOT}/%24query/%24eq`,
        message: `JQ0003: invalid '$query' document: '$eq' takes exactly 2 operand(s), got 1 at ${ROOT}/%24query/%24eq`,
        cause: { name: 'JsonQueryCompileError', code: 'JQ0003', docPath: '/$eq' },
      });
      // mixed $-and-plain keys
      assert.deepStrictEqual(refusal({ $query: { $eq: [1, 1], plain: 1 } }).code, 'JQ0001');
    });

    it('refuses an external other than root and path where the query names it (JQ0005)', () => {
      assert.deepStrictEqual(refusal({ $query: { $ge: ['$.price', '$minPrice'] } }), {
        name: 'SchemaCompileError', code: 'JQ0005', docPath: `${ROOT}/%24query/%24ge/1`,
        message: `JQ0005: invalid '$query' document: '$minPrice' is neither bound by an enclosing phrase nor a declared external (declared externals: 'root', 'path') at ${ROOT}/%24query/%24ge/1`,
        cause: { name: 'JsonQueryCompileError', code: 'JQ0005', docPath: '/$ge/1' },
      });
      // a nested $query: the schema location is spelled as a URI fragment
      assert.deepStrictEqual(refusal({ $id: 'https://x.test/order', properties: { 'unit price': {
        $query: { $and: [{ $exists: '$root' }, { $gt: ['$', '$floor'] }] } } } }).docPath,
      'https://x.test/order#/properties/unit%20price/%24query/%24and/1/%24gt/1');
      // root and path themselves are of course fine
      assert.doesNotThrow(
        () => new JarenValidator().compile({ $query: { $and: [
          { $exists: '$root' }, { $exists: '$path' },
        ] } }));
    });

    it('keeps the recursive-literal refusal reachable through the cause chain', () => {
      const jaren = new JarenValidator();
      jaren.addSchema({ $id: 'https://x.test/r', $query: { $valid: ['$', { $ref: 'https://x.test/r' }] } });
      assert.throws(() => jaren.compile({ $ref: 'https://x.test/r' })(1), (e) => {
        assert.strictEqual(e.name, 'SchemaCompileError');
        assert.strictEqual(e.code, 'JQ0009');
        assert.strictEqual(e.cause.code, 'JQ0009');
        assert.match(e.message, /recursive schema compilation through a query literal is not supported/);
        return true;
      });
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
