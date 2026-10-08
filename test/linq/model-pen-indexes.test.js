//@ts-check
/**
 * @file The model pen's entity indexes: `.indexes([index(…)])` on an entity's
 * object builder, lifted by `defineModel` onto the entity declaration, with a
 * `where` captured from a predicate lambda as the query grammar the store
 * lowers. The emitted document is the hand-written one, and the store opened
 * over it refuses exactly the rows the hand-written index refuses. What the
 * store would refuse and the builder can see is refused at build: a member
 * outside the grammar (`JL0101`), an option that needs a generated column, an
 * expression, a path that is not one top-level member, and `.indexes()` where
 * no declaration would carry it (`JL0102`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as m from '@jarenjs/linq/model';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { ONE_ACTIVE, SHIFT_ROWS, SHIFT_VERDICTS, createVerdicts } from '../db/invariant-oracle.js';

/** The motivating entity's members. */
const shift = () => m.object({ id: m.string().key(), employeeId: m.string(), day: m.string(), status: m.string().optional() });
const SCHEMA = { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } }, employeeId: { type: 'string' },
  day: { type: 'string' }, status: { type: 'string' } }, required: ['id', 'employeeId', 'day'], additionalProperties: false };

/** The code a build raises. @param {() => unknown} build */
const codeOf = (build) => {
  try { build(); return null; }
  catch (error) { return /** @type {any} */ (error).code; }
};

describe('entity indexes in the model pen', () => {
  it('declares the motivating index: the emitted document is the hand-written one, and the store enforces it', async () => {
    const Shift = shift().indexes([m.index([(s) => s.employeeId, (s) => s.get('day')],
      { name: 'one_active', unique: true, where: (s) => s.status.in(['active', 'pending']) })]);
    const model = m.defineModel({ entities: { Shift } });
    assert.deepStrictEqual(model, { $model: '0.1', entities: { Shift: { schema: SCHEMA, indexes: [ONE_ACTIVE] } } });
    const store = await openStore(model, { driver: nodeDriver() });
    try { assert.deepEqual(await createVerdicts(store.entity('Shift'), SHIFT_ROWS), SHIFT_VERDICTS); }
    finally { await store.close(); }
  });

  it('names an index by its members, takes JSONPath strings and raw entries, and keeps a query document verbatim', () => {
    const where = { $eq: ['$.status', 'active'] };
    const model = m.defineModel({ entities: { Shift: shift().indexes([
      m.index(['$.employeeId', '$.day'], { where }),
      { name: 'by_day', path: '$.day', unique: false },
    ]) } });
    assert.deepStrictEqual(model.entities.Shift.indexes,
      [{ name: 'by_employeeId_day', path: ['$.employeeId', '$.day'], where }, { name: 'by_day', path: '$.day', unique: false }]);
  });

  it('reads a member named like a surface method, through get(), as the path the store reads', () => {
    const entry = m.index((d) => d.get('at'), { where: (d) => d.get('at').eq('x') });
    // a collection keeps the path as captured; a condition reads members as $.<member>
    assert.deepStrictEqual(entry, { name: 'by_at', path: "$['at']", where: { $eq: ['$.at', 'x'] } });
    const model = m.defineModel({ entities: { A: m.object({ id: m.string().key(), at: m.string() }).indexes([entry]) } });
    assert.deepStrictEqual(model.entities.A.indexes, [{ name: 'by_at', path: '$.at', where: { $eq: ['$.at', 'x'] } }]);
  });

  it('takes a condition on a collection index too', () => {
    const spec = m.collection(m.object({ a: m.string(), s: m.string() }), { key: (d) => d.a,
      indexes: [m.index((d) => d.s, { unique: true, where: (d) => d.s.in(['x', 'y']) }), { name: 'raw', path: '$.a', where: { $ne: ['$.a', 'z'] } }] });
    assert.deepStrictEqual(spec.indexes, [{ name: 'by_s', path: '$.s', unique: true, where: { $eq: ['$.s', { $seq: ['x', 'y'] }] } },
      { name: 'raw', path: '$.a', where: { $ne: ['$.a', 'z'] } }]);
  });

  it('refuses what the store would refuse and the builder can see', () => {
    const define = (/** @type {any[]} */ entries) => () => m.defineModel({ entities: { Shift: shift().indexes(entries) } });
    assert.equal(codeOf(define([{ name: 'x', path: '$.day', uniqe: true }])), 'JL0101');
    assert.equal(codeOf(define([{ name: 'x', path: '$.day', unique: 1 }])), 'JL0101');
    assert.equal(codeOf(define([{ name: 'x', path: '$.day', where: 'status = 1' }])), 'JL0101');
    assert.equal(codeOf(define([{ name: 'x', path: [] }])), 'JL0101');
    assert.equal(codeOf(() => m.index((s) => s.day, { uniqe: true })), 'JL0101');
    assert.equal(codeOf(() => m.index('$.day', { where: '"status" = 1' })), 'JL0101');
    assert.equal(codeOf(() => m.index('$.day', { where: (s) => s.status })), 'JL0102');
    assert.equal(codeOf(define([m.index('$.day', { derive: 'geohash' })])), 'JL0102');
    assert.equal(codeOf(define([m.expressionIndex({ call: 'lower', args: ['$.day'] })])), 'JL0102');
    assert.equal(codeOf(define([m.index('$.profile.city')])), 'JL0102');
    assert.equal(codeOf(define([m.index((s) => s.get('has space'))])), 'JL0102');
    assert.equal(codeOf(() => shift().indexes(/** @type {any} */ ({}))), 'JL0101');
    assert.equal(codeOf(() => m.string().indexes([])), 'JL0102');
  });

  it('refuses indexes() where no declaration carries it: on a nested member, and on a collection', () => {
    assert.throws(() => m.defineModel({ entities: { A: m.object({ id: m.string().key(), p: m.object({ c: m.string() }).indexes([m.index('$.c')]) }) } }),
      (/** @type {any} */ error) => error.code === 'JL0102' && error.docPath === '/entities/A' && /indexes\(\) on entities\.A\.p /.test(error.message));
    assert.throws(() => m.collection(m.object({ a: m.string() }).indexes([m.index('$.a')]), { key: '/a' }),
      (/** @type {any} */ error) => error.code === 'JL0102' && /indexes\(\) on collection\(\) /.test(error.message));
    assert.throws(() => m.collection(m.object({ a: m.string(), p: m.object({ c: m.string() }).indexes([]) }), { key: '/a' }),
      (/** @type {any} */ error) => error.code === 'JL0102' && /indexes\(\) on collection\(\)\.p /.test(error.message));
  });

  it('points a collection() under entities at the entity spelling', () => {
    assert.throws(() => m.defineModel({ entities: { A: m.collection(m.object({ id: m.string() }), { key: '/id', indexes: [] }) } }),
      (/** @type {any} */ error) => error.code === 'JL0102' && /\.indexes\(\[index\(/.test(error.message));
  });
});
