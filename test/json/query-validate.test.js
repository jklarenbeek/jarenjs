import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// CYCLE CHECK: this file is the ONLY place where @jarenjs/json and
// @jarenjs/validate meet. The dependency direction is validate -> json,
// one way: `grep -r "@jarenjs/validate" packages/json/src` must stay
// empty, and the test below asserts exactly that. The engine's schema
// operators reach the validator solely through the compileTypeTest hook
// (QUERY-FORMAT.md section 8.11).
import {
  compileJsonQuery,
  queryJson,
  JsonQueryCompileError,
  JsonQueryRuntimeError,
} from '@jarenjs/json/query';
import { createTypeTestCompiler } from '@jarenjs/validate/query';
import { JarenValidator } from '@jarenjs/validate';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jsonSrcDir = path.join(__dirname, '..', '..', 'packages', 'json', 'src');
const fixturesDir = path.join(__dirname, 'fixtures', 'query-format');

// The bookstore example from RFC 9535, section 1.5, plus the ratings
// array of the spec's join examples (QUERY-FORMAT.md appendix A)
const bookstore = {
  store: {
    book: [
      { category: 'reference', author: 'Nigel Rees', title: 'Sayings of the Century', price: 8.95 },
      { category: 'fiction', author: 'Evelyn Waugh', title: 'Sword of Honour', price: 12.99 },
      { category: 'fiction', author: 'Herman Melville', title: 'Moby Dick', isbn: '0-553-21311-3', price: 8.99 },
      { category: 'fiction', author: 'J. R. R. Tolkien', title: 'The Lord of the Rings', isbn: '0-395-19395-8', price: 22.99 },
    ],
    bicycle: { color: 'red', price: 399 },
  },
  ratings: [
    { isbn: '0-553-21311-3', stars: 4 },
    { isbn: '0-395-19395-8', stars: 5 },
    { isbn: '0-395-19395-8', stars: 3 },
  ],
};

describe('Jaren JSON Query x @jarenjs/validate integration', () => {

  it('should keep packages/json free of any @jarenjs/validate import (no cycle)', () => {
    // a module specifier is always quoted ('...' or "..."); prose mentions
    // in comments are fine, importing the validator is not
    const importSpecifier = /['"]@jarenjs\/validate/;
    const offenders = [];
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        }
        else if (entry.name.endsWith('.js')) {
          if (importSpecifier.test(fs.readFileSync(full, 'utf8')))
            offenders.push(full);
        }
      }
    })(jsonSrcDir);
    assert.deepStrictEqual(offenders, [],
      '@jarenjs/json must never import @jarenjs/validate (validate -> json is the only direction)');
  });

  describe('createTypeTestCompiler', () => {
    it('should compile $valid/$assert through a fresh default validator', () => {
      const compileTypeTest = createTypeTestCompiler();
      const q = compileJsonQuery({
        allPriced: { $valid: ['$.store.book[*]', { type: 'object', required: ['price'] }] },
        allRated: { $valid: ['$.store.book[*]', { type: 'object', required: ['isbn'] }] },
        color: { $assert: ['$.store.bicycle.color', { type: 'string', minLength: 1 }] },
      }, { compileTypeTest });
      assert.deepStrictEqual(q(bookstore), { allPriced: true, allRated: false, color: 'red' });
    });

    it('should enforce $as assertions with real schemas', () => {
      const compileTypeTest = createTypeTestCompiler();
      const q = compileJsonQuery({
        $for: { b: '$.store.book[*]' },
        $as: { b: { type: 'object', required: ['isbn'] } },
        $return: '$b.title',
      }, { compileTypeTest });
      assert.throws(() => q(bookstore), (e) => {
        assert.strictEqual(e instanceof JsonQueryRuntimeError, true);
        assert.strictEqual(e.code, 'JQ2008');
        assert.strictEqual(e.docPath, '/$as/b');
        return true;
      });
    });

    it('should resolve $defs/$ref inside a schema literal', () => {
      const compileTypeTest = createTypeTestCompiler();
      const q = compileJsonQuery({
        $valid: ['$.store.book[*]', {
          $defs: { money: { type: 'number', exclusiveMinimum: 0 } },
          type: 'object',
          properties: { price: { $ref: '#/$defs/money' } },
          required: ['price'],
        }],
      }, { compileTypeTest });
      assert.strictEqual(q(bookstore), true);
      assert.strictEqual(q({ store: { book: [{ price: -1 }] } }), false);
    });

    it('should resolve a registered remote schema through a supplied validator instance', () => {
      const validator = new JarenValidator();
      validator.addSchema({
        $id: 'https://jarenjs.dev/schemas/test/stars',
        type: 'number',
        minimum: 0,
        maximum: 5,
      });
      const compileTypeTest = createTypeTestCompiler(validator);
      const q = compileJsonQuery(
        { $valid: ['$.ratings[*].stars', { $ref: 'https://jarenjs.dev/schemas/test/stars' }] },
        { compileTypeTest });
      assert.strictEqual(q(bookstore), true);
      assert.strictEqual(q({ ratings: [{ stars: 9 }] }), false);
    });

    it('should accept a validator factory', () => {
      const compileTypeTest = createTypeTestCompiler(() => new JarenValidator());
      assert.strictEqual(
        compileJsonQuery({ $valid: [1, { type: 'integer' }] }, { compileTypeTest })(null),
        true);
    });

    it('should stay boolean even on an error-collecting validator instance', () => {
      const compileTypeTest = createTypeTestCompiler(new JarenValidator({ collectErrors: true }));
      const q = compileJsonQuery({ $valid: ['$.store.bicycle.price', { type: 'number' }] }, { compileTypeTest });
      assert.strictEqual(q(bookstore), true);
      assert.strictEqual(
        compileJsonQuery({ $valid: ['x', { type: 'number' }] }, { compileTypeTest })(null),
        false);
    });

    it('should surface an invalid schema literal as JQ0009 at compile time', () => {
      const compileTypeTest = createTypeTestCompiler();
      for (const badSchema of [{ pattern: '[' }, { $ref: '#/$defs/missing' }, { type: 'nonsense' }]) {
        assert.throws(() => compileJsonQuery({ $valid: ['$.a', badSchema] }, { compileTypeTest }), (e) => {
          assert.strictEqual(e instanceof JsonQueryCompileError, true, `expected JsonQueryCompileError for ${JSON.stringify(badSchema)}`);
          assert.strictEqual(e.code, 'JQ0009', `expected JQ0009, got ${e.code}: ${e.message}`);
          assert.strictEqual(e.docPath, '/$valid');
          return true;
        });
      }
    });
  });

  describe("the spec's worked example (appendix A.9)", () => {
    const fixture = JSON.parse(fs.readFileSync(
      path.join(fixturesDir, 'valid', 'example-9-schema-as.json'), 'utf8'));

    it('should run the committed fixture end-to-end', () => {
      const q = compileJsonQuery(fixture, { compileTypeTest: createTypeTestCompiler() });
      assert.deepStrictEqual(q(bookstore), [
        { title: 'Moby Dick', stars: 4 },
        { title: 'The Lord of the Rings', stars: 5 },
        { title: 'The Lord of the Rings', stars: 3 },
      ]);
    });

    it('should filter (not fail) on implausible ratings via $valid', () => {
      const doctored = structuredClone(bookstore);
      doctored.ratings.push({ isbn: '0-553-21311-3', stars: 11 });
      const q = compileJsonQuery(fixture, { compileTypeTest: createTypeTestCompiler() });
      // the 11-star rating drops out in $where; $as stays satisfied
      assert.deepStrictEqual(q(doctored).length, 3);
    });

    it('should assert (not filter) on a malformed book via $as', () => {
      const doctored = structuredClone(bookstore);
      // an isbn-bearing book without a price passes the path filter but
      // violates the $as schema: JQ2008, not a dropped tuple
      doctored.store.book.push({ isbn: 'i-broken', title: 'No Price' });
      const q = compileJsonQuery(fixture, { compileTypeTest: createTypeTestCompiler() });
      assert.throws(() => q(doctored), (e) => e.code === 'JQ2008' && e.docPath === '/$as/b');
    });

    it('should be JQ0008 without a hook, also through queryJson', () => {
      assert.throws(() => queryJson(fixture, bookstore), (e) => {
        assert.strictEqual(e instanceof JsonQueryCompileError, true);
        assert.strictEqual(e.code, 'JQ0008');
        return true;
      });
    });
  });
});
