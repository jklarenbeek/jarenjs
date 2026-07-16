import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compileJsonQuery,
  JsonQueryCompileError,
} from '@jarenjs/json/query';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, '..', 'fixtures', 'query-format');

// asserts compileJsonQuery(doc) throws a JsonQueryCompileError with the
// exact code and docPath
function failsWith(doc, code, docPath) {
  assert.throws(() => compileJsonQuery(doc), (e) => {
    assert.strictEqual(e instanceof JsonQueryCompileError, true, `expected JsonQueryCompileError, got ${e.name}: ${e.message}`);
    assert.strictEqual(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    if (docPath !== undefined)
      assert.strictEqual(e.docPath, docPath, `expected docPath '${docPath}', got '${e.docPath}'`);
    assert.strictEqual(e.message.startsWith(`${e.code}: `), true, 'message must start with the code');
    assert.strictEqual(e.message.endsWith(` at ${e.docPath}`), true, 'message must end with the docPath');
    return true;
  });
}

describe('Jaren JSON Query normalizer', () => {

  describe('JQ0001 - mixed keys', () => {
    it('should reject an object mixing $-prefixed and plain keys', () => {
      failsWith({ title: '$b.title', $where: true }, 'JQ0001', '');
    });

    it('should point at the nested mixed object', () => {
      failsWith({ a: { x: 1, $y: 2 } }, 'JQ0001', '/a');
      failsWith([1, { $const: 1, plain: 2 }], 'JQ0001', '/1');
    });
  });

  describe('JQ0002 - unknown operators', () => {
    it('should reject an unknown operator key', () => {
      failsWith({ $frobnicate: 1 }, 'JQ0002', '');
      failsWith({ a: { $nope: [] } }, 'JQ0002', '/a');
    });

    it('should reject the reserved keys $valid/$assert/$as', () => {
      failsWith({ $valid: 1 }, 'JQ0002', '');
      failsWith({ $assert: 1 }, 'JQ0002', '');
      failsWith({ $as: 'string' }, 'JQ0002', '');
    });

    it('should reject $query/$expr outside the top level as unknown', () => {
      failsWith({ a: { $query: '0.1', $expr: 1 } }, 'JQ0002', '/a');
    });

    it('should prefer JQ0002 when a bad key combination contains an unknown key', () => {
      failsWith({ $eq: [1, 1], $bogus: 1 }, 'JQ0002', '');
    });
  });

  describe('JQ0003 - bad shapes and arities', () => {
    it('should enforce comparison and arithmetic arity of exactly 2', () => {
      failsWith({ $eq: [1, 2, 3] }, 'JQ0003', '/$eq');
      failsWith({ $lt: [1] }, 'JQ0003', '/$lt');
      failsWith({ $add: 1 }, 'JQ0003', '/$add');
      failsWith({ $mod: [1, 2, 3] }, 'JQ0003', '/$mod');
    });

    it('should enforce $if arity 2-3', () => {
      failsWith({ $if: [true] }, 'JQ0003', '/$if');
      failsWith({ $if: [true, 1, 2, 3] }, 'JQ0003', '/$if');
      failsWith({ $if: true }, 'JQ0003', '/$if');
    });

    it('should enforce $and/$or arity of at least 1', () => {
      failsWith({ $and: [] }, 'JQ0003', '/$and');
      failsWith({ $or: [] }, 'JQ0003', '/$or');
    });

    it('should require an array for $seq and $concat', () => {
      failsWith({ $seq: 1 }, 'JQ0003', '/$seq');
      failsWith({ $concat: 'ab' }, 'JQ0003', '/$concat');
    });

    it('should require $map entries to be pairs', () => {
      failsWith({ $map: 1 }, 'JQ0003', '/$map');
      failsWith({ $map: [['k']] }, 'JQ0003', '/$map/0');
      failsWith({ $map: [['k', 1, 2]] }, 'JQ0003', '/$map/0');
      failsWith({ $map: [['k', 1], 'not-a-pair'] }, 'JQ0003', '/$map/1');
    });

    it('should validate the $let binding object', () => {
      failsWith({ $let: 1, $return: 1 }, 'JQ0003', '/$let');
      failsWith({ $let: [], $return: 1 }, 'JQ0003', '/$let');
      failsWith({ $let: {}, $return: 1 }, 'JQ0003', '/$let');
      failsWith({ $let: { '9x': 1 }, $return: 1 }, 'JQ0003', '/$let/9x');
      failsWith({ $let: { 'a-b': 1 }, $return: 1 }, 'JQ0003', '/$let/a-b');
    });

    it('should validate the $for binding object', () => {
      failsWith({ $for: '$.store.book[*]', $return: '$b' }, 'JQ0003', '/$for');
      failsWith({ $for: {}, $return: 1 }, 'JQ0003', '/$for');
      failsWith({ $for: { '9x': 1 }, $return: 1 }, 'JQ0003', '/$for/9x');
    });

    it('should validate the extended $in/$at binding form', () => {
      failsWith({ $for: { b: { $in: '$.a[*]' } }, $return: '$b' }, 'JQ0003', '/$for/b');
      failsWith({ $for: { b: { $at: 'i' } }, $return: '$b' }, 'JQ0003', '/$for/b');
      failsWith({ $for: { b: { $in: 1, $at: 'i', $seq: [] } }, $return: '$b' }, 'JQ0003', '/$for/b');
      failsWith({ $for: { b: { $in: 1, $at: 9 } }, $return: '$b' }, 'JQ0003', '/$for/b/$at');
      failsWith({ $for: { b: { $in: 1, $at: '9x' } }, $return: '$b' }, 'JQ0003', '/$for/b/$at');
    });

    it('should reject the extended binding form in $let and quantifiers', () => {
      failsWith({ $let: { b: { $in: '$.a[*]', $at: 'i' } }, $return: '$b' }, 'JQ0003', '/$let/b');
      failsWith({ $some: { b: { $in: '$.a[*]', $at: 'i' } }, $satisfies: true }, 'JQ0003', '/$some/b');
    });

    it('should validate the $groupby binding object', () => {
      failsWith({ $for: { b: '$.a[*]' }, $groupby: 1, $return: '$b' }, 'JQ0003', '/$groupby');
      failsWith({ $for: { b: '$.a[*]' }, $groupby: {}, $return: '$b' }, 'JQ0003', '/$groupby');
      failsWith({ $for: { b: '$.a[*]' }, $groupby: { '9x': '$b' }, $return: '$b' }, 'JQ0003', '/$groupby/9x');
    });

    it('should validate $orderby key specs', () => {
      failsWith({ $for: { b: '$.a[*]' }, $orderby: [], $return: '$b' }, 'JQ0003', '/$orderby');
      failsWith({ $for: { b: '$.a[*]' }, $orderby: { $key: '$b', $dir: 'ascending' }, $return: '$b' }, 'JQ0003', '/$orderby/$dir');
      failsWith({ $for: { b: '$.a[*]' }, $orderby: { $key: '$b', $empty: 'first' }, $return: '$b' }, 'JQ0003', '/$orderby/$empty');
      failsWith({ $for: { b: '$.a[*]' }, $orderby: { $dir: 'desc' }, $return: '$b' }, 'JQ0003', '/$orderby');
      failsWith({ $for: { b: '$.a[*]' }, $orderby: { $key: '$b', $desc: true }, $return: '$b' }, 'JQ0003', '/$orderby');
      failsWith({ $for: { b: '$.a[*]' }, $orderby: ['$b', { $dir: 'desc' }], $return: '$b' }, 'JQ0003', '/$orderby/1');
    });

    it('should validate the $count clause name', () => {
      failsWith({ $for: { b: '$.a[*]' }, $count: 5, $return: '$b' }, 'JQ0003', '/$count');
      failsWith({ $for: { b: '$.a[*]' }, $count: '9x', $return: '$b' }, 'JQ0003', '/$count');
    });

    it('should validate quantifier binding objects', () => {
      failsWith({ $some: 1, $satisfies: true }, 'JQ0003', '/$some');
      failsWith({ $every: {}, $satisfies: true }, 'JQ0003', '/$every');
      failsWith({ $some: { '9x': 1 }, $satisfies: true }, 'JQ0003', '/$some/9x');
    });

    it('should reject FLWOR clause keys that cannot form a phrase alone', () => {
      failsWith({ $return: 1 }, 'JQ0003', '');
      failsWith({ $let: { x: 1 } }, 'JQ0003', '');
      failsWith({ $where: true }, 'JQ0003', '');
      failsWith({ $satisfies: true }, 'JQ0003', '');
    });

    it('should reject known keys in an invalid combination', () => {
      failsWith({ $eq: [1, 1], $lt: [1, 2] }, 'JQ0003', '');
      failsWith({ $some: { b: 1 }, $every: { b: 1 }, $satisfies: true }, 'JQ0003', '');
      failsWith({ $where: true, $satisfies: true }, 'JQ0003', '');
    });

    it('should enforce the envelope shape', () => {
      failsWith({ $query: '0.1' }, 'JQ0003', '');
      failsWith({ $expr: 1 }, 'JQ0003', '');
      failsWith({ $query: '0.1', $expr: 1, $extra: 1 }, 'JQ0003', '');
    });
  });

  describe('JQ0004 - malformed query strings', () => {
    it('should reject strings that match no form of Rule 2', () => {
      failsWith('$9foo', 'JQ0004', '');
      failsWith('$ x', 'JQ0004', '');
      failsWith({ a: '$-b' }, 'JQ0004', '/a');
    });

    it('should reject grammatically invalid absolute paths', () => {
      failsWith('$.store[', 'JQ0004', '');
      failsWith('$..', 'JQ0004', '');
      failsWith({ $seq: ['$.a', '$[0 5]'] }, 'JQ0004', '/$seq/1');
    });

    it('should reject grammatically invalid variable-rooted segments', () => {
      failsWith('$b[', 'JQ0004', '');
      failsWith('$b.', 'JQ0004', '');
      failsWith('$b[?]', 'JQ0004', '');
    });
  });

  describe('JQ0006 - version envelope', () => {
    it('should reject unknown versions', () => {
      failsWith({ $query: '0.2', $expr: 1 }, 'JQ0006', '/$query');
    });

    it('should reject non-string versions', () => {
      failsWith({ $query: 0.1, $expr: 1 }, 'JQ0006', '/$query');
      failsWith({ $query: null, $expr: 1 }, 'JQ0006', '/$query');
    });

    it('should accept the 0.1 envelope and locate errors under /$expr', () => {
      assert.strictEqual(compileJsonQuery({ $query: '0.1', $expr: 42 })(null), 42);
      failsWith({ $query: '0.1', $expr: { $eq: [1] } }, 'JQ0003', '/$expr/$eq');
    });
  });

  describe('JQ0007 - duplicate bindings, and shadowing', () => {
    it('should reject duplicate bindings across a phrase\'s clauses', () => {
      failsWith({ $for: { b: '$.a[*]' }, $let: { b: 1 }, $return: '$b' }, 'JQ0007', '/$let/b');
      failsWith({ $for: { b: { $in: '$.a[*]', $at: 'b' } }, $return: '$b' }, 'JQ0007', '/$for/b/$at');
      failsWith({ $for: { b: { $in: '$.a[*]', $at: 'i' }, i: 1 }, $return: '$b' }, 'JQ0007', '/$for/i');
      failsWith({ $for: { b: '$.a[*]' }, $groupby: { b: '$b.x' }, $return: '$b' }, 'JQ0007', '/$groupby/b');
      failsWith({ $for: { n: '$.a[*]' }, $count: 'n', $return: '$n' }, 'JQ0007', '/$count');
      failsWith({ $let: { x: 1 }, $count: 'x', $return: '$x' }, 'JQ0007', '/$count');
    });

    it('should allow rebinding a name from an enclosing phrase (shadowing)', () => {
      const q = compileJsonQuery({
        $let: { a: 1 },
        $return: { outer: '$a', inner: { $let: { a: 2 }, $return: '$a' } },
      });
      assert.deepStrictEqual(q(null), { outer: 1, inner: 2 });
    });

    it('should allow a $let name to shadow an external of the same name', () => {
      const q = compileJsonQuery({
        $let: { x: '$x' }, // the source '$x' is free: an external
        $return: '$x', // this '$x' is the binding
      });
      assert.deepStrictEqual(q.externals, ['x']);
      assert.strictEqual(q(null, { x: 41 }), 41);
    });
  });

  describe('the operator registry vocabulary', () => {
    it('should compile every FLWOR clause and quantifier phrase', () => {
      assert.strictEqual(typeof compileJsonQuery({ $for: { b: '$.a[*]' }, $return: '$b' }), 'function');
      assert.strictEqual(typeof compileJsonQuery({ $let: { b: 1 }, $where: true, $return: '$b' }), 'function');
      assert.strictEqual(typeof compileJsonQuery({ $for: { b: '$.a[*]' }, $orderby: '$b', $return: '$b' }), 'function');
      assert.strictEqual(typeof compileJsonQuery({ $some: { b: '$.a[*]' }, $satisfies: true }), 'function');
      assert.strictEqual(typeof compileJsonQuery({ $every: { b: '$.a[*]' }, $satisfies: true }), 'function');
    });

    it('should compile every operator of the section-8 vocabulary', () => {
      // one document per operator family (full semantics are covered by
      // operators.test.js); compiling proves the registry declares them all
      assert.strictEqual(typeof compileJsonQuery({ $seq: [{ $count: 1 }, { $sum: 1 }, { $avg: 1 }, { $min: 1 }, { $max: 1 }] }), 'function');
      assert.strictEqual(typeof compileJsonQuery({
        $seq: [
          { '$string-join': [['a'], ','] }, { $substring: ['a', 0, 1] }, { $contains: ['a', 'a'] },
          { '$starts-with': ['a', 'a'] }, { '$ends-with': ['a', 'a'] }, { $upper: 'a' }, { $lower: 'A' },
          { '$string-length': 'a' }, { '$normalize-space': ' a ' },
          { $match: ['a', 'a'] }, { $search: ['a', 'a'] }, { $replace: ['a', 'a', 'b'] },
        ],
      }), 'function');
      assert.strictEqual(typeof compileJsonQuery({
        $seq: [
          { $distinct: 1 }, { $reverse: 1 }, { $sort: 1 }, { $head: 1 }, { $tail: 1 },
          { $subsequence: [1, 0] }, { '$index-of': [1, 1] }, { $range: [1, 2] }, { $get: [1, 0] },
        ],
      }), 'function');
      assert.strictEqual(typeof compileJsonQuery({
        $seq: [
          { '$is-string': 1 }, { '$is-number': 1 }, { '$is-boolean': 1 }, { '$is-null': 1 },
          { '$is-array': 1 }, { '$is-object': 1 },
          { $string: 1 }, { $number: 1 }, { $boolean: 1 },
          { $coalesce: [1] }, { $default: [1, 2] },
        ],
      }), 'function');
    });

    it('should enforce the registry arities (JQ0003)', () => {
      failsWith({ '$string-join': [] }, 'JQ0003', '/$string-join');
      failsWith({ '$string-join': [['a'], ',', '!'] }, 'JQ0003', '/$string-join');
      failsWith({ $substring: ['a'] }, 'JQ0003', '/$substring');
      failsWith({ $substring: ['a', 0, 1, 2] }, 'JQ0003', '/$substring');
      failsWith({ $substring: 'a' }, 'JQ0003', '/$substring');
      failsWith({ $replace: ['a', 'b'] }, 'JQ0003', '/$replace');
      failsWith({ $contains: ['a'] }, 'JQ0003', '/$contains');
      failsWith({ $subsequence: [1] }, 'JQ0003', '/$subsequence');
      failsWith({ '$index-of': [1] }, 'JQ0003', '/$index-of');
      failsWith({ $range: [1, 2, 3] }, 'JQ0003', '/$range');
      failsWith({ $get: [1] }, 'JQ0003', '/$get');
      failsWith({ $coalesce: [] }, 'JQ0003', '/$coalesce');
      failsWith({ $coalesce: 1 }, 'JQ0003', '/$coalesce');
      failsWith({ $default: [1] }, 'JQ0003', '/$default');
      failsWith({ $default: [1, 2, 3] }, 'JQ0003', '/$default');
    });

    it('should suggest a near-miss operator on JQ0002 (Levenshtein <= 2)', () => {
      assert.throws(() => compileJsonQuery({ $stirng: 1 }), (e) => {
        assert.strictEqual(e.code, 'JQ0002');
        assert.strictEqual(e.message.includes("did you mean '$string'?"), true, e.message);
        return true;
      });
      assert.throws(() => compileJsonQuery({ $counts: 'x' }), (e) => {
        assert.strictEqual(e.code, 'JQ0002');
        assert.strictEqual(e.message.includes("did you mean '$count'?"), true, e.message);
        return true;
      });
      // multi-key objects with an unknown key get the suggestion too
      assert.throws(() => compileJsonQuery({ $fore: { b: '$.a[*]' }, $return: '$b' }), (e) => {
        assert.strictEqual(e.code, 'JQ0002');
        assert.strictEqual(e.message.includes("did you mean '$for'?"), true, e.message);
        return true;
      });
    });

    it('should not suggest anything for distant unknown keys', () => {
      assert.throws(() => compileJsonQuery({ $frobnicate: 1 }), (e) => {
        assert.strictEqual(e.code, 'JQ0002');
        assert.strictEqual(e.message.includes('did you mean'), false, e.message);
        return true;
      });
    });
  });

  describe('escape hatches', () => {
    it('should unescape $$ strings into literals', () => {
      assert.strictEqual(compileJsonQuery('$$price')(null), '$price');
      assert.strictEqual(compileJsonQuery('$$$x')(null), '$$x');
      assert.strictEqual(compileJsonQuery('$$')(null), '$');
    });

    it('should keep $const values verbatim and unevaluated', () => {
      const q = compileJsonQuery({ $const: { $for: 'kept verbatim', price: null, s: '$.a' } });
      assert.deepStrictEqual(q({ a: 1 }), { $for: 'kept verbatim', price: null, s: '$.a' });
    });

    it('should deep-copy the $const value (mutating the input later changes nothing)', () => {
      const doc = { $const: { keep: [1, 2] } };
      const q = compileJsonQuery(doc);
      doc.$const.keep.push(3);
      doc.$const.added = true;
      assert.deepStrictEqual(q(null), { keep: [1, 2] });
    });

    it('should return a frozen $const value', () => {
      const q = compileJsonQuery({ $const: { a: [1] } });
      const v = q(null);
      assert.strictEqual(Object.isFrozen(v), true);
      assert.strictEqual(Object.isFrozen(v.a), true);
    });

    it('should normalize $map pairs as expressions', () => {
      const q = compileJsonQuery({ $map: [['$$dollar-key', 1], [{ $concat: ['a', 'b'] }, 2]] });
      assert.deepStrictEqual(q(null), { '$dollar-key': 1, ab: 2 });
    });
  });

  describe('externals collection', () => {
    it('should collect free names in order of first appearance', () => {
      const q = compileJsonQuery({ $seq: ['$beta', '$alpha', '$beta', '$gamma.x'] });
      assert.deepStrictEqual(q.externals, ['beta', 'alpha', 'gamma']);
    });

    it('should not collect bound names', () => {
      const q = compileJsonQuery({ $let: { a: '$ext' }, $return: ['$a', '$other'] });
      assert.deepStrictEqual(q.externals, ['ext', 'other']);
    });

    it('should expose no externals for a closed query', () => {
      assert.deepStrictEqual(compileJsonQuery('$.a.b').externals, []);
    });
  });

  describe('valid fixtures', () => {
    // With the operator library complete, every valid/ fixture compiles.
    const names = fs.readdirSync(path.join(fixturesDir, 'valid')).filter((n) => n.endsWith('.json')).sort();
    for (const name of names) {
      const doc = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'valid', name), 'utf8'));
      it(`should compile ${name}`, () => {
        assert.strictEqual(typeof compileJsonQuery(doc), 'function');
      });
    }
  });
});
