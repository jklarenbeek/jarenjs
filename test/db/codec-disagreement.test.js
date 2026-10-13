//@ts-check
/**
 * @file A schema that disagrees with its column's codec. The planner reads the
 * property's type and the ordering and aggregate gates read what the column
 * stores, so a property typed `string` over a `boolean` column answered a
 * string operator natively where the engine raises `JQ2001`. The model refuses
 * the disagreement (`JD0005`) at the column's codec, for every shape; a
 * property whose type admits the kind its codec decodes, and one that names no
 * type, are untouched.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEntities } from '@jarenjs/db';
import { adopted } from './helpers.js';
import { REFUSED_CLAIM_WORLDS, FAMILY_MATRIX_WORLDS } from './oracle/join-worlds.js';

const KEY = { 'x-entity': { key: true } };
const column = (/** @type {string} */ name, /** @type {string} */ codec, /** @type {string} */ policy = 'reject') => ({ name, codec, null: policy });

/** One `E` over table `e` whose member `v` is typed by `claim` over a column of `codec`. */
const entities = (/** @type {any} */ claim, /** @type {string} */ codec, policy = 'reject') => ({ E: {
  schema: { type: 'object', properties: { id: { type: 'integer', ...KEY }, v: claim } },
  physical: { table: 'e', columns: { id: column('id', 'integer'), v: column('v', codec, policy) } } } });
const modelOf = (/** @type {any} */ claim, /** @type {string} */ codec) => ({ $model: '0.1', entities: entities(claim, codec) });

describe('a property typed over a column whose codec decodes another kind', () => {
  it('a string property over a boolean column is refused at the model, where a native $contains over it answered a row the engine raises on', async () => {
    await assert.rejects(adopted('CREATE TABLE e(id INTEGER PRIMARY KEY, v INTEGER NOT NULL); INSERT INTO e VALUES (1,1),(2,0)',
      entities({ type: 'string' }, 'boolean')), {
      code: 'JD0005', docPath: '/entities/E/physical/columns/v/codec',
      message: /'v' is typed string but its 'boolean' codec decodes a boolean/ });
  });

  it('the same column typed boolean keeps the engine\'s refusal of a string operator over it', async () => {
    const { store, close } = await adopted('CREATE TABLE e(id INTEGER PRIMARY KEY, v INTEGER NOT NULL); INSERT INTO e VALUES (1,1),(2,0)',
      entities({ type: 'boolean' }, 'boolean'));
    try {
      const document = [{ $for: { e: '$.E[*]' }, $where: { $contains: ['$e.v', '1'] }, $return: '$e.id' }];
      assert.equal((await store.explain(document)).mode, 'set');
      await assert.rejects(Promise.resolve().then(() => store.execute(document)), { code: 'JQ2001' });
    }
    finally { await close(); }
  });

  it('every claim over a codec of another kind is refused, naming the property, its types and the codec', () => {
    assert.equal(REFUSED_CLAIM_WORLDS.length, 30);
    for (const world of REFUSED_CLAIM_WORLDS) {
      assert.throws(() => normalizeEntities(world.model(null)), { code: 'JD0005', docPath: '/entities/A/physical/columns/v/codec',
        message: /^JD0005: 'v' is typed [a-z |]+ but its '[a-z]+' codec decodes an? [a-z]+; / }, world.name);
    }
  });

  it('an integer claim over each codec that decodes a string is refused', () => {
    for (const codec of ['bigint', 'decimal', 'uuid', 'blob-hex', 'epoch-ms', 'local-timestamp', 'instant']) {
      assert.throws(() => normalizeEntities(modelOf({ type: 'integer' }, codec)),
        { code: 'JD0005', docPath: '/entities/E/physical/columns/v/codec', message: new RegExp(`'v' is typed integer but its '${codec}' codec decodes a string`) }, codec);
    }
  });

  it('every claim over a codec of its kind is accepted', () => {
    assert.equal(FAMILY_MATRIX_WORLDS.length, 30);
    for (const world of FAMILY_MATRIX_WORLDS) assert.doesNotThrow(() => normalizeEntities(world.model(null)), world.name);
  });

  it('the refusal reads the declared type as the schema spells it: a nullable scalar, a union, a $ref', () => {
    const refused = [
      [{ type: ['string', 'null'] }, 'boolean', 'string'],
      [{ type: ['integer', 'null'] }, 'text', 'integer'],
      [{ type: ['integer', 'boolean'] }, 'text', 'integer or boolean'],
      [{ type: 'object' }, 'text', 'object'],
      [{ allOf: [{ type: 'string' }] }, 'integer', 'string'],
    ];
    for (const [claim, codec, named] of /** @type {[any, string, string][]} */ (refused)) {
      assert.throws(() => normalizeEntities(modelOf(claim, codec)),
        { code: 'JD0005', message: new RegExp(`is typed ${named} but its '${codec}' codec`) }, JSON.stringify(claim));
    }
    const accepted = [
      [{ type: ['string', 'null'] }, 'text'], [{ type: ['integer', 'string'] }, 'text'], [{ type: ['string', 'boolean'] }, 'boolean'],
      [{ type: 'number' }, 'integer'], [{ type: 'integer' }, 'number'], [{ type: 'string', format: 'date-time' }, 'epoch-ms'],
      [{ type: 'string' }, 'bigint'], [{ type: 'string' }, 'decimal'], [{ type: 'string' }, 'uuid'], [{ type: 'string' }, 'blob-hex'],
      [{ type: 'string' }, 'instant'], [{ type: 'string' }, 'local-timestamp'],
      [{ type: 'object' }, 'json'], [{ type: 'string' }, 'json'], [{ type: 'array' }, 'json'], [{ allOf: [{ type: 'string' }] }, 'text'],
      [{}, 'boolean'], [{ enum: ['a', 'b'] }, 'text'], [{ type: 'null' }, 'text'],
    ];
    for (const [claim, codec] of /** @type {[any, string][]} */ (accepted)) {
      assert.doesNotThrow(() => normalizeEntities(modelOf(claim, codec)), `${JSON.stringify(claim)} over ${codec}`);
    }
  });

  it('a key is judged like any other property', () => {
    assert.throws(() => normalizeEntities({ $model: '0.1', entities: { E: {
      schema: { type: 'object', properties: { id: { type: 'string', ...KEY } } },
      physical: { table: 'e', columns: { id: column('id', 'integer') } } } } }),
    { code: 'JD0005', docPath: '/entities/E/physical/columns/id/codec', message: /'id' is typed string but its 'integer' codec decodes a number/ });
  });
});
