//@ts-check
/**
 * @file One binder for every statement the query layer runs. A
 * parameter slot is bound by `slotValue` — a literal binds itself, an
 * external binds the caller's value, and a DERIVED slot binds what the
 * binder computes from a bound value (one edge of a region's box) —
 * and a slot whose bound value the database cannot take diverts the
 * call to the residual. Both engines must reach that one rule: the
 * entity engine once carried an inline twin of it that only ever saw
 * plain slots, and this file pushes a derived slot through its
 * `execute()` so the twin cannot come back unnoticed.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  openStore, createQueryState, createEntityQueryEngine, createQueryEngine,
  normalizeEntities, explainMapping, planEntityQuery, normalizeModel, planCollection,
} from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

import { tempDbPath } from './helpers.js';

const MODEL = {
  $model: '0.1',
  entities: {
    Item: {
      schema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', 'x-entity': { key: true } },
          n: { type: 'integer' },
        },
      },
    },
  },
};

const DOCUMENT = { $for: { i: '$.Item[*]' }, $where: { $eq: ['$i.n', '$bound'] }, $return: '$i' };

/** A region whose western edge is 5 — the value the derived slot must bind. */
const REGION = { type: 'Polygon', coordinates: [[[5, 52], [6, 52], [6, 53], [5, 53], [5, 52]]] };

describe('every engine binds through slotValue (a derived slot through entity execute)', () => {
  it('a synthetic derived slot binds the box edge, and a boxless value diverts', async () => {
    const temp = tempDbPath();
    try {
      const store = await openStore(MODEL, { driver: nodeDriver(), path: temp.dbPath });
      const items = store.entity('Item');
      await items.create({ id: 'five', n: 5 });
      await items.create({ id: 'six', n: 6 });
      await store.close();

      const connection = await nodeDriver().open(temp.dbPath, {});
      try {
        const entities = normalizeEntities(MODEL);
        const mapping = explainMapping(MODEL);
        const state = createQueryState();
        const engine = createEntityQueryEngine({ connection, entities, mapping, state });

        // the entity planner never emits a derived slot itself, so the
        // entry is seeded into the cache with the plain external slot
        // swapped for a derived one over the same statement text
        const planned = planEntityQuery(DOCUMENT, entities, mapping);
        assert.strictEqual(planned.mode, 'native');
        const natural = await engine.explain(DOCUMENT);
        // the external form binds the value twice (a typeof guard, then
        // the comparison) — both become the derived slot
        assert.strictEqual((natural.sql.match(/\?/g) ?? []).length, 2);
        const derived = { derived: { kind: 'bboxAxis', external: 'region', axis: 'w' } };
        state.cache.set(['E', DOCUMENT, connection.dialect.name, true], {
          planned,
          sql: natural.sql,
          slots: [derived, derived],
          statement: null,
          setResidual: null,
          fetchers: null,
        });

        const bound = await engine.execute(DOCUMENT, { externals: { region: REGION, bound: 5 } });
        assert.deepStrictEqual(bound, { id: 'five', n: 5 },
          'the derived slot binds the western edge of the region (5), which selects the row');

        // no box → the slot has no bindable value → the residual answers
        // from the document's own external
        const diverted = await engine.execute(DOCUMENT,
          { externals: { region: 'not geography', bound: 6 } });
        assert.deepStrictEqual(diverted, { id: 'six', n: 6 });
      }
      finally {
        await connection.close();
      }
    }
    finally {
      temp.cleanup();
    }
  });
});

// ————— The fourth slot kind: a scalar the DATABASE answers —————

const SERIES_MODEL = {
  $model: '0.1',
  collections: {
    sample: {
      schema: {
        type: 'object',
        properties: {
          series: { type: 'string' }, at: { type: 'integer' }, value: { type: 'number' },
        },
      },
      key: null,
      identity: 'integer',
      indexes: [{ name: 'by_series_at', path: ['$.series', '$.at'] }],
    },
  },
};
const ASOF = { $asof: [{ $const: [{ at: 50, series: 'a', value: 0 }] }, '$[*]', { by: '$.series' }] };

describe('a TYPED slot binds what a seek answered, and only that', () => {
  it("refuses an anchor of another type before the statement it would bind", async () => {
    const temp = tempDbPath();
    try {
      const store = await openStore(SERIES_MODEL, { driver: nodeDriver(), path: temp.dbPath });
      const sample = store.collection('sample');
      for (let i = 0; i < 6; i++) await sample.insert({ series: 'a', at: i * 10, value: i });
      await store.close();

      const connection = await nodeDriver().open(temp.dbPath, {});
      try {
        const collection = normalizeModel(SERIES_MODEL).get('sample');
        const physicalPlan = planCollection('sample', collection, connection.dialect);
        const state = createQueryState();
        const engine = createQueryEngine({ connection, state, collection, physicalPlan });
        // the plan asks the database for its lower anchor, and answers
        const first = await engine.execute(ASOF);
        assert.strictEqual(first.right.at, 50);
        const explained = await engine.explain(ASOF);
        // the batch's own bounds, and the anchor between them
        assert.deepStrictEqual(explained.params, [
          { literal: 50 }, { typed: { seek: 'asof.lower', type: 'number' } }, { literal: 'a' }]);
        assert.strictEqual(explained.series.counts.statements, 2);

        // the same entry, with a seek that answers a STRING: the column
        // it reads is declared integer, so this is a defect below the
        // store — and a comparison of text against an epoch would
        // answer wrong rather than fail
        const key = ['C', ASOF, 'sample', connection.dialect.name, false, true, null];
        const entry = state.cache.get(key);
        assert.strictEqual(entry.seeks.length, 1);
        entry.seeks[0] = { ...entry.seeks[0],
          sql: 'SELECT \'nope\' AS "anchor"', slots: [], statement: null };
        await assert.rejects(async () => engine.execute(ASOF),
          (error) => /** @type {any} */ (error).code === 'JD2086'
            && /declared number and the database answered string/.test(error.reason));

        // and one that answers NOTHING binds the probe it seeked from,
        // which excludes only rows it proved are not there
        entry.seeks[0] = { ...entry.seeks[0],
          sql: 'SELECT MAX("gx_at") AS "anchor" FROM "sample" WHERE 0',
          slots: [], statement: null };
        assert.deepStrictEqual(await engine.execute(ASOF), first);
      }
      finally {
        connection.close();
      }
    }
    finally {
      temp.cleanup();
    }
  });
});
