//@ts-check
/**
 * @file `annotateTypes` — the optional type pass over the published
 * normalized form (Appendix C.8). The contract under test: a NEW frozen
 * tree with a tag on every node, the input never mutated, `typeOf`
 * consulted for paths, the declared operator families propagating, and
 * everything undeclared honestly `unknown` — never a wrong tag.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { analyzeQuery, annotateTypes, TYPE_TAGS } from '@jarenjs/json/query';

/** Annotate a document with an optional typeOf hook. */
const typed = (doc, typeOf) => annotateTypes(analyzeQuery(doc), { typeOf }).root;

describe('annotateTypes', () => {
  it('returns a new frozen tree and never mutates the input', () => {
    const analysis = analyzeQuery({ $eq: ['$.a', 1] });
    const annotated = annotateTypes(analysis);
    assert.notStrictEqual(annotated, analysis);
    assert.notStrictEqual(annotated.root, analysis.root);
    assert.strictEqual(Object.hasOwn(analysis.root, 'type'), false);
    assert.strictEqual(Object.isFrozen(annotated), true);
    assert.strictEqual(Object.isFrozen(annotated.root), true);
    assert.strictEqual(annotated.astVersion, analysis.astVersion);
  });

  it('literals type themselves, integers precisely', () => {
    const root = typed({ $seq: [1, 1.5, 'x', true, null] });
    const tags = root.args.map((a) => a.type.type);
    assert.deepStrictEqual(tags, ['integer', 'number', 'string', 'boolean', 'null']);
  });

  it('constructors are object/array; quantifiers are boolean', () => {
    assert.strictEqual(typed({ a: 1 }).type.type, 'object');
    assert.strictEqual(typed([1, 2]).type.type, 'array');
    assert.strictEqual(typed({ $map: [['$.k', 1]] }).type.type, 'object');
    const quant = typed({ $some: { b: '$.items[*]' }, $satisfies: '$b' });
    assert.deepStrictEqual(quant.type, { type: 'boolean', optional: false });
  });

  it('paths ask typeOf: tag-name, object and null answers all work', () => {
    const byName = typed('$.age', () => 'integer');
    assert.strictEqual(byName.type.type, 'integer');
    const byObject = typed('$.age', () => ({ type: 'string', optional: true }));
    assert.deepStrictEqual(byObject.type, { type: 'string', optional: true });
    const unknown = typed('$.age');
    assert.strictEqual(unknown.type.type, 'unknown');
    // a sloppy hook answer degrades to unknown, never a throw
    assert.strictEqual(typed('$.age', () => 'flavour').type.type, 'unknown');
  });

  it('typeOf receives the path node itself', () => {
    let seen = null;
    typed('$.store.book', (node) => { seen = node; return null; });
    assert.strictEqual(seen.kind, 'path');
    assert.strictEqual(seen.singular, true);
  });

  it('the declared families propagate: comparison, arithmetic, string, aggregate', () => {
    assert.strictEqual(typed({ $eq: ['$.a', 1] }).type.type, 'boolean');
    assert.strictEqual(typed({ $add: [1, 2] }).type.type, 'number');
    assert.strictEqual(typed({ $idiv: [7, 2] }).type.type, 'integer');
    assert.strictEqual(typed({ $upper: '$.name' }).type.type, 'string');
    assert.strictEqual(typed({ '$string-length': '$.name' }).type.type, 'integer');
    assert.strictEqual(typed({ '$starts-with': ['$.name', 'A'] }).type.type, 'boolean');
    assert.strictEqual(typed({ $match: ['$.name', 'a.*'] }).type.type, 'boolean');
    assert.strictEqual(typed({ $count: '$.items[*]' }).type.type, 'integer');
    assert.strictEqual(typed({ $sum: '$.items[*]' }).type.type, 'number');
  });

  it('$min/$max follow their operand family and stay unknown otherwise', () => {
    assert.strictEqual(
      typed({ $min: '$.prices[*]' }, () => 'number').type.type, 'number');
    assert.strictEqual(
      typed({ $min: '$.names[*]' }, () => 'string').type.type, 'string');
    assert.strictEqual(typed({ $min: '$.mystery[*]' }).type.type, 'unknown');
  });

  it('undeclared operators yield unknown, never a guess', () => {
    assert.strictEqual(typed({ $distinct: '$.items[*]' }).type.type, 'unknown');
    assert.strictEqual(typed({ $string: '$.a' }).type.type, 'unknown');
  });

  it('let and flwor carry their item type; fold joins with the return', () => {
    const letNode = typed({ $let: { v: 1 }, $return: { $add: ['$v', 1] } });
    assert.strictEqual(letNode.type.type, 'number');
    const flwor = typed({ $for: { b: '$.items[*]' }, $return: { $upper: '$b.name' } });
    assert.strictEqual(flwor.type.type, 'string');
    assert.strictEqual(flwor.type.optional, true); // CARD_MANY phrase
    const fold = typed({
      $fold: { acc: 0 }, $for: { b: '$.items[*]' },
      $return: { $add: ['$acc', '$b.n'] },
    });
    assert.strictEqual(fold.type.type, 'number'); // integer ∨ number
  });

  it('schema-analysis trees annotate too (raw nodes are unknown)', () => {
    const root = typed({ $valid: ['$.a', { type: 'string' }] });
    assert.strictEqual(root.args[1].kind, 'raw');
    assert.strictEqual(root.args[1].type.type, 'unknown');
  });

  it('TYPE_TAGS is the closed sorted lattice', () => {
    assert.strictEqual(Object.isFrozen(TYPE_TAGS), true);
    assert.deepStrictEqual([...TYPE_TAGS], [...TYPE_TAGS].sort());
    assert.strictEqual(TYPE_TAGS.includes('unknown'), true);
    assert.strictEqual(TYPE_TAGS.length, 8);
  });
});
