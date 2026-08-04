//@ts-check
/**
 * @file `analyzeQuery` — the published normalized form (QUERY-FORMAT.md
 * Appendix C). The analysis record's shape, its freezing guarantee, the
 * schema-without-hook analysis mode (with compilation proven strict and
 * byte-for-byte unaffected), and the single-normalization composition
 * `compileJsonQuery(doc, { analysis: true })`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  analyzeQuery, compileJsonQuery, AST_VERSION, NODE_KINDS,
  JsonQueryCompileError,
} from '@jarenjs/json/query';

const SCHEMA_DOC = {
  $for: { b: '$.store.book[*]' },
  $where: { $valid: ['$b', { type: 'object', required: ['isbn'] }] },
  $return: '$b.title',
};

describe('analyzeQuery', () => {
  it('returns the documented record shape, frozen at every level', () => {
    const analysis = analyzeQuery({
      $for: { b: '$.items[*]' },
      $where: { $gt: ['$b.price', '$limit'] },
      $return: { title: '$b.title' },
    });
    assert.strictEqual(analysis.astVersion, AST_VERSION);
    assert.strictEqual(typeof analysis.frameSize, 'number');
    assert.strictEqual(Object.isFrozen(analysis), true);
    assert.strictEqual(Object.isFrozen(analysis.root), true);
    assert.strictEqual(analysis.root.kind, 'flwor');
    assert.deepStrictEqual(analysis.externals.map((e) => e.name), ['limit']);
    assert.strictEqual(typeof analysis.externals[0].slot, 'number');
    assert.deepStrictEqual(analysis.dependencies.externals, ['limit']);
    assert.deepStrictEqual([...analysis.dependencies.operators], ['$gt']);
    assert.strictEqual(analysis.limits, null);
  });

  it('applies the same JQ0xxx rejections compilation does', () => {
    assert.throws(() => analyzeQuery({ title: 'x', $where: true }),
      (e) => e instanceof JsonQueryCompileError && e.code === 'JQ0001');
    assert.throws(() => analyzeQuery({ $frobnicate: 1 }),
      (e) => e instanceof JsonQueryCompileError && e.code === 'JQ0002');
  });

  it('analyses schema operators WITHOUT a type-test hook (test is null)', () => {
    const analysis = analyzeQuery(SCHEMA_DOC);
    const where = analysis.root.where;
    assert.strictEqual(where.name, '$valid');
    const schemaArg = where.args[1];
    assert.strictEqual(schemaArg.kind, 'raw');
    assert.deepStrictEqual(schemaArg.value, { type: 'object', required: ['isbn'] });
    assert.strictEqual(schemaArg.test, null);
  });

  it('compiles the predicate when the hook IS supplied to analysis', () => {
    const analysis = analyzeQuery(SCHEMA_DOC, {
      compileTypeTest: () => () => true,
    });
    assert.strictEqual(typeof analysis.root.where.args[1].test, 'function');
  });

  it('compilation stays strict: the same document is still JQ0008 without the hook', () => {
    assert.throws(() => compileJsonQuery(SCHEMA_DOC),
      (e) => e instanceof JsonQueryCompileError && e.code === 'JQ0008');
    // and the `analysis: true` compile option does not weaken it
    assert.throws(() => compileJsonQuery(SCHEMA_DOC, { analysis: true }),
      (e) => e instanceof JsonQueryCompileError && e.code === 'JQ0008');
  });

  it('compileJsonQuery({ analysis: true }) exposes the record from one normalization', () => {
    const query = compileJsonQuery({ $eq: ['$.a', '$x'] }, { analysis: true });
    assert.strictEqual(query.analysis.astVersion, AST_VERSION);
    assert.strictEqual(query.analysis.root.kind, 'op');
    assert.deepStrictEqual(query.analysis.dependencies.externals, ['x']);
    // the record matches what analyzeQuery reports for the same document
    const direct = analyzeQuery({ $eq: ['$.a', '$x'] });
    assert.deepStrictEqual(query.analysis.dependencies, direct.dependencies);
    assert.strictEqual(query.analysis.frameSize, direct.frameSize);
    // without the flag, nothing is exposed
    assert.strictEqual(compileJsonQuery('$.a').analysis, undefined);
    // and the compiled query still executes
    assert.strictEqual(query({ a: 1 }, { x: 1 }), true);
  });

  it('externals report in first-appearance order with their slots', () => {
    const analysis = analyzeQuery({ $seq: ['$beta', '$alpha', '$beta'] });
    assert.deepStrictEqual(analysis.externals.map((e) => e.name), ['beta', 'alpha']);
    assert.strictEqual(analysis.externals[0].slot < analysis.externals[1].slot, true);
  });

  it('NODE_KINDS is the frozen sorted twelve-kind list', () => {
    assert.strictEqual(Object.isFrozen(NODE_KINDS), true);
    assert.strictEqual(NODE_KINDS.length, 12);
    assert.deepStrictEqual([...NODE_KINDS], [...NODE_KINDS].sort());
  });

  it('normalized limits ride along', () => {
    const analysis = analyzeQuery('$.a', { limits: { steps: 100 } });
    assert.strictEqual(analysis.limits.steps, 100);
    assert.strictEqual(analysis.limits.depth, null);
  });
});
