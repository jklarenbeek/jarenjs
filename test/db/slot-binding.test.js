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
  openStore, createQueryState, createEntityQueryEngine, normalizeEntities, explainMapping,
  planEntityQuery,
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
