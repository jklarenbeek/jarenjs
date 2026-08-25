//@ts-check
/**
 * @file The R\*Tree physical mapping: `derive: 'bbox'` with
 * `physical: 'rtree'` (MODEL-FORMAT §2.1).
 *
 * The claim under test is not speed — `benchmark/spatial.js` publishes
 * that, read AND write. It is that the logical model and the physical
 * mapping are genuinely separable: the same document, the same query,
 * the same answers, a different shape on disk. So everything here is
 * either "the two mappings answer identically" or "the one place they
 * legitimately differ, pinned".
 *
 * The one legitimate difference is exactness. An R\*Tree stores
 * coordinates as 32-bit floats rounded OUTWARD, so the stored box is a
 * SUPERSET of the row's — no false negatives, which is what the implied
 * conjunct needs (D8), but not a decision. `$bbox-intersects` is
 * therefore refined rather than exact under this mapping, and
 * `strict: true` is `JD0010` where the column mapping reported a native
 * plan.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  openStore, normalizeModel, planCollection, sqliteDialect,
  planMigration, migrate, registerDeriveFunctions, schemaShapeOf, compareShapeToModel,
} from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { wasmDriver } from '@jarenjs/db/wasm';

import { tempDbPath, declaringWasmHandle, recordingDriver } from './helpers.js';

const SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    at: { type: 'array', items: { type: 'number' } },
    kind: { type: 'string' },
  },
};

/** The two models under test: one column set, two shapes on disk. */
const model = (physical) => ({
  $model: '0.1',
  collections: {
    places: {
      schema: SCHEMA,
      key: '/id',
      indexes: [
        { name: 'by_box', path: '$.at', derive: 'bbox', ...(physical === undefined ? {} : { physical }) },
        { name: 'by_kind', path: '$.kind' },
      ],
    },
  },
});

const COLUMNS = model('columns');
const RTREE = model('rtree');

/** The virtual table one `$.at` box column set is realized as. */
const VIRTUAL = 'places_gx_at_bbox_rtree';
const TRIGGERS = [`${VIRTUAL}_ai`, `${VIRTUAL}_au`, `${VIRTUAL}_ad`];

const REGION = {
  type: 'Polygon',
  coordinates: [[[4.7, 52.30], [5.1, 52.30], [5.1, 52.45], [4.7, 52.45], [4.7, 52.30]]],
};

const DOCS = [
  { id: 'ams', at: [4.9041, 52.3676], kind: 'city' },
  { id: 'rtm', at: [4.4777, 51.9244], kind: 'city' },
  { id: 'utr', at: [5.1214, 52.0907], kind: 'city' },
  { id: 'hil', at: [5.1714, 52.2292], kind: 'town' },
  // no bounded position at all: absent, and non-finite (which JSON
  // writes as `null`, so it stops being a position)
  { id: 'nowhere', kind: 'ghost' },
  { id: 'broken', at: [Number.NaN, 1], kind: 'ghost' },
];

const where = (predicate, extra = {}) =>
  ({ $for: { it: '$[*]' }, $where: predicate, ...extra, $return: '$it' });

const WITHIN = where({ $within: ['$it.at', REGION] });
const INTERSECTS = where({ '$bbox-intersects': ['$it.at', REGION] });

/** Open a store over `DOCS` under one mapping. */
async function seeded(document, options = {}) {
  const store = await openStore(document, { driver: nodeDriver(), ...options });
  const places = store.collection('places');
  for (const doc of DOCS) await places.insert(doc);
  return { store, places };
}

/** Read the virtual table on a second connection over the same file. */
async function readVirtual(dbPath, table = VIRTUAL) {
  const connection = await nodeDriver().open(dbPath, {});
  await registerDeriveFunctions(connection);
  const statement = await connection.prepare(
    `SELECT "id", "minx", "maxx", "miny", "maxy" FROM "${table}" ORDER BY "id"`);
  const rows = await statement.all([]);
  const keys = await (await connection.prepare(
    'SELECT "rowid" AS rid, "key" FROM "places" ORDER BY "rowid"')).all([]);
  await connection.close();
  const byRid = new Map(keys.map((row) => [Number(row.rid), String(row.key)]));
  return rows.map((row) => ({ key: byRid.get(Number(row.id)) ?? null, ...row }));
}

describe('the R*Tree physical mapping — the shape on disk', () => {
  it('keeps the four columns, drops the B-tree over them, and adds one virtual table', () => {
    const columns = planCollection('places',
      normalizeModel(COLUMNS).get('places'), sqliteDialect);
    const rtree = planCollection('places',
      normalizeModel(RTREE).get('places'), sqliteDialect);

    // the columns are IDENTICAL — they stay the box's one definition,
    // and the triggers read them rather than restating the expression
    assert.deepStrictEqual(rtree.generated, columns.generated);

    assert.deepStrictEqual(columns.expected.indexes.map((i) => i.name),
      ['places_by_box', 'places_by_kind']);
    assert.deepStrictEqual(rtree.expected.indexes.map((i) => i.name), ['places_by_kind'],
      'the virtual table IS the index; a B-tree over the same columns would be paid twice');

    assert.deepStrictEqual(columns.virtualTables, []);
    assert.deepStrictEqual(rtree.virtualTables.map((v) => v.name), [VIRTUAL]);
    assert.deepStrictEqual(rtree.virtualTables[0].triggers.map((t) => t.name), TRIGGERS);
    assert.deepStrictEqual(rtree.virtualTables[0].columns, ['minx', 'maxx', 'miny', 'maxy']);
  });

  it('the trigger body READS the derived columns — the box has one definition', () => {
    const rtree = planCollection('places',
      normalizeModel(RTREE).get('places'), sqliteDialect);
    for (const trigger of rtree.virtualTables[0].triggers) {
      assert.ok(!/jaren_bbox_/.test(trigger.sql),
        `${trigger.name} restates the box expression instead of reading the column:\n${trigger.sql}`);
    }
    const insert = rtree.virtualTables[0].triggers[0].sql;
    assert.match(insert, /NEW\."gx_at_bbox_w" IS NOT NULL/,
      'without the guard an R*Tree coerces NULL to 0.0 and every unbounded row lands on Null Island');
    assert.match(insert, /NEW\."gx_at_bbox_w", NEW\."gx_at_bbox_e", NEW\."gx_at_bbox_s", NEW\."gx_at_bbox_n"/);
  });

  it('one virtual table per COLUMN SET, not per index (§2.1 rule 5)', () => {
    const shared = {
      $model: '0.1',
      collections: {
        places: {
          schema: SCHEMA,
          key: '/id',
          indexes: [
            { name: 'by_box', path: '$.at', derive: 'bbox', physical: 'rtree' },
            { name: 'also_box', path: '$.at', derive: 'bbox', physical: 'rtree' },
          ],
        },
      },
    };
    const plan = planCollection('places', normalizeModel(shared).get('places'), sqliteDialect);
    assert.deepStrictEqual(plan.virtualTables.map((v) => v.name), [VIRTUAL]);
    assert.deepStrictEqual(plan.expected.indexes, []);
  });

  it('the store creates exactly the planned objects, and nothing else it owns', async () => {
    const temp = tempDbPath();
    try {
      const { store } = await seeded(RTREE, { path: temp.dbPath });
      await store.close();
      const connection = await nodeDriver().open(temp.dbPath, {});
      await registerDeriveFunctions(connection);
      const rows = await (await connection.prepare(
        "SELECT type, name FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type, name")).all([]);
      await connection.close();
      assert.deepStrictEqual(rows.map((row) => `${row.type} ${row.name}`), [
        'index places_by_kind',
        'table places',
        `table ${VIRTUAL}`,
        // the three shadow tables are the module's own storage, not
        // model objects: deterministic from the name, and dropped with it
        `table ${VIRTUAL}_node`,
        `table ${VIRTUAL}_parent`,
        `table ${VIRTUAL}_rowid`,
        ...[...TRIGGERS].sort().map((name) => `trigger ${name}`),
      ]);
    }
    finally { temp.cleanup(); }
  });
});

describe('the R*Tree stays in sync — every write path, through the triggers', () => {
  it('a document with no bounded position is ABSENT, not at Null Island', async () => {
    const temp = tempDbPath();
    try {
      const { store } = await seeded(RTREE, { path: temp.dbPath });
      await store.close();
      const rows = await readVirtual(temp.dbPath);
      assert.deepStrictEqual(rows.map((row) => row.key), ['ams', 'rtm', 'utr', 'hil'],
        'the unbounded rows are not in the index at all');
      for (const row of rows) {
        assert.ok(Number.isFinite(row.minx) && row.minx !== 0,
          `${row.key} landed at ${row.minx} — the NULL guard did not hold`);
      }
    }
    finally { temp.cleanup(); }
  });

  it('insert, upsert, patch (translated AND fallback) and delete all keep it in sync',
    async () => {
      const temp = tempDbPath();
      try {
        const store = await openStore(RTREE, { driver: nodeDriver(), path: temp.dbPath });
        const places = store.collection('places');
        const boxes = async () => (await readVirtual(temp.dbPath))
          .map((row) => `${row.key}:${row.minx.toFixed(3)}`);

        await places.insert({ id: 'a', at: [1, 1], kind: 'x' });
        await store.close();
        assert.deepStrictEqual(await boxes(), ['a:1.000'], 'insert');

        const second = await openStore(RTREE, { driver: nodeDriver(), path: temp.dbPath });
        const again = second.collection('places');
        await again.put({ id: 'a', at: [2, 2], kind: 'x' });
        await second.close();
        assert.deepStrictEqual(await boxes(), ['a:2.000'], 'upsert');

        const third = await openStore(RTREE, { driver: nodeDriver(), path: temp.dbPath });
        const t = third.collection('places');
        // a translated patch is an UPDATE with a json_set expression
        await t.patch('a', [{ op: 'replace', path: '/at/0', value: 3 }]);
        const translated = third.stats?.('places') ?? null;
        await third.close();
        assert.deepStrictEqual(await boxes(), ['a:3.000'], 'translated patch');

        const fourth = await openStore(RTREE, { driver: nodeDriver(), path: temp.dbPath });
        const f = fourth.collection('places');
        // a whole-document replacement through the fallback shape
        await f.patch('a', [{ op: 'replace', path: '/at', value: [4, 4] }]);
        await f.insert({ id: 'b', at: [9, 9], kind: 'x' });
        await f.delete('b');
        await fourth.close();
        assert.deepStrictEqual(await boxes(), ['a:4.000'], 'patch fallback, insert and delete');
        assert.ok(translated === null || typeof translated === 'object');

        // and the row leaves the index when its geometry does
        const fifth = await openStore(RTREE, { driver: nodeDriver(), path: temp.dbPath });
        await fifth.collection('places').patch('a', [{ op: 'remove', path: '/at' }]);
        await fifth.close();
        assert.deepStrictEqual(await boxes(), [],
          'a document that loses its geometry leaves the index rather than keeping a stale box');
      }
      finally { temp.cleanup(); }
    });

  it('an R*Tree REFUSES an inverted box, and the derivation can never produce one', async () => {
    const temp = tempDbPath();
    try {
      const { store } = await seeded(RTREE, { path: temp.dbPath });
      await store.close();
      const connection = await nodeDriver().open(temp.dbPath, {});
      await registerDeriveFunctions(connection);
      // the mapping's own safety net: a box whose west edge is east of
      // its east edge fails the WRITE here and would store happily under
      // the column mapping. The kernel's box is `[minLon, minLat,
      // maxLon, maxLat]` by construction, so this can only ever be a
      // derivation bug — and this is where it would surface
      await assert.rejects(
        async () => connection.exec(`INSERT INTO "${VIRTUAL}" VALUES (9999, 5.0, 1.0, 1.0, 5.0)`),
        (error) => {
          assert.match(String(error.message), /rtree constraint failed/);
          return true;
        });
      // and the boxes the store actually wrote are all well-formed
      const rows = await (await connection.prepare(
        `SELECT count(*) AS bad FROM "${VIRTUAL}" WHERE "minx" > "maxx" OR "miny" > "maxy"`
      )).get([]);
      await connection.close();
      assert.strictEqual(Number(rows.bad), 0);
    }
    finally { temp.cleanup(); }
  });

  it('packages/db writes the virtual table through NO JavaScript path (D1/D-c)', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = new URL('../../packages/db/src/', import.meta.url).pathname;
    const files = readdirSync(root, { recursive: true })
      .filter((name) => String(name).endsWith('.js'));
    const offenders = [];
    for (const name of files) {
      const text = readFileSync(join(root, String(name)), 'utf8');
      // the ONLY place that mentions the virtual table's own columns is
      // the dialect's spelling spec and the emitter's probe
      if (/INSERT INTO[^\n]*rtree|_rtree["'`]?\s*\)?\s*\.run|insertBox/i.test(text))
        offenders.push(String(name));
    }
    assert.deepStrictEqual(offenders, [],
      'the sync is three declared triggers; a second write path is exactly what D1 forbids');
  });
});

describe('the plan: a rowid subquery, not a join', () => {
  it('$within pushes the same box, spelled over the virtual table', async () => {
    const { store, places } = await seeded(RTREE);
    try {
      const explained = await places.explain(WITHIN);
      assert.deepStrictEqual(explained.prefilters, [{
        construct: '$within', via: 'rtree',
        columns: ['minx', 'maxx', 'miny', 'maxy'], exact: false,
      }]);
      assert.deepStrictEqual(explained.indexes, [VIRTUAL]);
      assert.match(explained.sql,
        new RegExp(`"rowid" IN \\(SELECT "id" FROM "${VIRTUAL}" WHERE "minx" <= \\? `
          + 'AND "maxx" >= \\? AND "miny" <= \\? AND "maxy" >= \\?\\)'));
      assert.ok(!/\bJOIN\b/i.test(explained.sql),
        'a join would need join support in the emitter; a conjunct needs none');
      assert.ok(!/\bEXISTS\b/i.test(explained.sql),
        'a correlated EXISTS defeats the virtual table index entirely');
      assert.match(explained.scanNarrative, /VIRTUAL TABLE INDEX/);
    }
    finally { await store.close(); }
  });

  it('a bounded $distance uses the same conjunct', async () => {
    const { store, places } = await seeded(RTREE);
    try {
      const document = where({ $le: [{ $distance: ['$it.at', [4.9, 52.37]] }, 5000] });
      const explained = await places.explain(document);
      assert.deepStrictEqual(explained.prefilters.map((p) => [p.construct, p.via, p.exact]),
        [['$distance', 'rtree', false]]);
      assert.deepStrictEqual(await places.execute(document), DOCS[0]);
    }
    finally { await store.close(); }
  });

  it('a geohash promotion is untouched by this mapping — an R*Tree carries numbers',
    async () => {
      const document = {
        $model: '0.1',
        collections: {
          places: {
            schema: SCHEMA,
            key: '/id',
            indexes: [
              { name: 'by_box', path: '$.at', derive: 'bbox', physical: 'rtree' },
              { name: 'by_cell', path: '$.at', derive: 'geohash', precision: 6 },
            ],
          },
        },
      };
      const { store, places } = await seeded(document);
      try {
        const explained = await places.explain(where(
          { '$starts-with': [{ $geohash: ['$it.at', 6] }, 'u17b'] }));
        assert.deepStrictEqual(explained.prefilters.map((p) => [p.construct, p.via]),
          [['$starts-with', 'columns']]);
        assert.deepStrictEqual(explained.indexes, ['places_by_cell']);
      }
      finally { await store.close(); }
    });
});

describe('$bbox-intersects stops being exact — the one honest divergence (D-d)', () => {
  it('exact over the columns, refined over the R*Tree, and identical rows', async () => {
    const columns = await seeded(COLUMNS);
    const rtree = await seeded(RTREE);
    try {
      const a = await columns.places.explain(INTERSECTS);
      const b = await rtree.places.explain(INTERSECTS);
      assert.strictEqual(a.prefilters[0].exact, true, 'the derived columns ARE B(row)');
      assert.strictEqual(b.prefilters[0].exact, false,
        'the R*Tree stores 32-bit floats rounded outward: a superset, not a decision');
      assert.strictEqual(a.residual, null);
      assert.strictEqual(b.residual.mode, 'set');
      assert.match(b.residual.reasons[0].reason, /32-bit floats rounded OUTWARD/);

      assert.deepStrictEqual(await rtree.places.execute(INTERSECTS),
        await columns.places.execute(INTERSECTS),
        'the refinement is what makes the answers identical');
    }
    finally {
      await columns.store.close();
      await rtree.store.close();
    }
  });

  it("strict: true is native over the columns and JD0010 over the R*Tree", async () => {
    const columns = await seeded(COLUMNS);
    const rtree = await seeded(RTREE);
    try {
      assert.deepStrictEqual(
        await columns.places.execute(INTERSECTS, { strict: true }),
        await columns.places.execute(INTERSECTS));
      await assert.rejects(async () => rtree.places.execute(INTERSECTS, { strict: true }),
        (error) => {
          assert.strictEqual(error.code, 'JD0010');
          assert.match(error.message, /\$bbox-intersects/);
          return true;
        });
    }
    finally {
      await columns.store.close();
      await rtree.store.close();
    }
  });

  it('the 32-bit rounding is OUTWARD, so the stored box has no false negatives', async () => {
    const temp = tempDbPath();
    try {
      const { store } = await seeded(RTREE, { path: temp.dbPath });
      await store.close();
      const rows = await readVirtual(temp.dbPath);
      const byKey = new Map(rows.map((row) => [row.key, row]));
      for (const doc of DOCS.filter((d) => Array.isArray(d.at) && Number.isFinite(d.at[0]))) {
        const row = byKey.get(doc.id);
        assert.ok(row.minx <= doc.at[0] && row.maxx >= doc.at[0]
          && row.miny <= doc.at[1] && row.maxy >= doc.at[1],
          `${doc.id}: the stored box ${JSON.stringify(row)} does not contain ${doc.at}`);
      }
    }
    finally { temp.cleanup(); }
  });
});

describe('the two mappings answer identically — the whole point', () => {
  const QUERIES = {
    within: WITHIN,
    intersects: INTERSECTS,
    'distance 5 km': where({ $le: [{ $distance: ['$it.at', [4.9, 52.37]] }, 5000] }),
    'within and a conjunct': where({ $and: [{ $within: ['$it.at', REGION] },
      { $eq: ['$it.kind', 'city'] }] }),
    'within or a conjunct': where({ $or: [{ $within: ['$it.at', REGION] },
      { $eq: ['$it.kind', 'town'] }] }),
    'a projection over the match': { $for: { it: '$[*]' },
      $where: { $within: ['$it.at', REGION] }, $return: '$it.id' },
    'ordered and limited': where({ '$bbox-intersects': ['$it.at', REGION] },
      { $orderby: ['$it.id'] }),
    'nothing matches': where({ $within: ['$it.at',
      { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] }] }),
  };

  it('every query, both mappings, the same answer', async () => {
    const columns = await seeded(COLUMNS);
    const rtree = await seeded(RTREE);
    try {
      for (const [name, document] of Object.entries(QUERIES)) {
        assert.deepStrictEqual(await rtree.places.execute(document),
          await columns.places.execute(document), name);
      }
    }
    finally {
      await columns.store.close();
      await rtree.store.close();
    }
  });

  it('a NEGATED box test is refused under both mappings — negating a superset drops rows',
    async () => {
      const rtree = await seeded(RTREE);
      try {
        const document = where({ $not: { $within: ['$it.at', REGION] } });
        const explained = await rtree.places.explain(document);
        assert.deepStrictEqual(explained.prefilters, []);
        // `broken` comes back with the coordinate JSON can carry: a
        // non-finite number is written as `null` and stops being one
        assert.deepStrictEqual(await rtree.places.execute(document),
          [DOCS[1], DOCS[2], DOCS[3], DOCS[4],
            { id: 'broken', at: [null, 1], kind: 'ghost' }]);
      }
      finally { await rtree.store.close(); }
    });
});

describe('verify, never alter: drift in both directions', () => {
  it('a second open over the same file runs no DDL and reports no difference', async () => {
    const temp = tempDbPath();
    try {
      const isDdl = (sql) => /^\s*(CREATE|ALTER|DROP)\b/i.test(sql);
      const first = recordingDriver(nodeDriver());
      const store = await openStore(RTREE, { driver: first.driver, path: temp.dbPath });
      await store.collection('places').insert(DOCS[0]);
      await store.close();
      assert.ok(first.executed.some(isDdl), 'the first open creates the shape');

      const second = recordingDriver(nodeDriver());
      const reopened = await openStore(RTREE, { driver: second.driver, path: temp.dbPath });
      assert.deepStrictEqual(await reopened.collection('places').get('ams'), DOCS[0]);
      await reopened.close();
      assert.deepStrictEqual(second.executed.filter(isDdl), [],
        'the second open verifies and alters nothing');
    }
    finally { temp.cleanup(); }
  });

  it('an rtree-mapped file opened with a columns model is JD0002 naming the difference',
    async () => {
      const temp = tempDbPath();
      try {
        const store = await openStore(RTREE, { driver: nodeDriver(), path: temp.dbPath });
        await store.close();
        await assert.rejects(
          openStore(COLUMNS, { driver: nodeDriver(), path: temp.dbPath }),
          (error) => {
            assert.strictEqual(error.code, 'JD0002');
            assert.match(error.message, /places_by_box|places_gx_at_bbox_rtree_a/);
            return true;
          });
      }
      finally { temp.cleanup(); }
    });

  it('a columns-mapped file opened with an rtree model is JD0002 naming the difference',
    async () => {
      const temp = tempDbPath();
      try {
        const store = await openStore(COLUMNS, { driver: nodeDriver(), path: temp.dbPath });
        await store.close();
        await assert.rejects(
          openStore(RTREE, { driver: nodeDriver(), path: temp.dbPath }),
          (error) => {
            assert.strictEqual(error.code, 'JD0002');
            assert.match(error.message, /places_by_box|places_gx_at_bbox_rtree/);
            return true;
          });
      }
      finally { temp.cleanup(); }
    });

  it('a MISSING virtual table is drift, even with every trigger in place', async () => {
    const temp = tempDbPath();
    try {
      const store = await openStore(RTREE, { driver: nodeDriver(), path: temp.dbPath });
      await store.close();
      // drop the virtual table alone: the triggers survive, so only the
      // added look can catch this
      const connection = await nodeDriver().open(temp.dbPath, {});
      await registerDeriveFunctions(connection);
      await connection.exec(`DROP TABLE "${VIRTUAL}"`);
      await connection.close();
      await assert.rejects(
        openStore(RTREE, { driver: nodeDriver(), path: temp.dbPath }),
        (error) => {
          assert.strictEqual(error.code, 'JD0002');
          assert.match(error.message, new RegExp(`virtual table '${VIRTUAL}'`));
          return true;
        });
    }
    finally { temp.cleanup(); }
  });
});

describe('the stored-column branch (bun): the same trigger text, unchanged', () => {
  /**
   * The forced-incapable branch. `bun:sqlite` exposes no `function`, so
   * the Bun binding declares `deterministicIndexableFunctions: false`
   * and its derived columns are ordinary ones the store writes. The
   * trigger reads those columns through `NEW` exactly as it reads a
   * generated one — which is the property this file exists to check,
   * because D-c chose "the trigger reads the column" over "the trigger
   * restates the box expression" partly for it.
   */
  const storedDriver = () => wasmDriver(declaringWasmHandle({
    userFunctions: false, deterministicIndexableFunctions: false, sessions: false,
  }));

  it('the trigger text is IDENTICAL on both derived-column mappings', () => {
    const virtualPlan = planCollection('places',
      normalizeModel(RTREE).get('places'), sqliteDialect);
    const storedPlan = planCollection('places',
      normalizeModel(RTREE).get('places'), sqliteDialect, { derived: 'stored' });
    assert.notDeepStrictEqual(
      virtualPlan.generated.map((c) => c.expression),
      storedPlan.generated.map((c) => c.expression),
      'the two column mappings really do differ');
    assert.deepStrictEqual(
      storedPlan.virtualTables[0].triggers, virtualPlan.virtualTables[0].triggers,
      'the box has one definition and the trigger reads it, so the sync is mapping-blind');
    assert.strictEqual(storedPlan.virtualTables[0].fillSql, virtualPlan.virtualTables[0].fillSql);
  });

  it('the R*Tree is kept in sync by the same triggers over stored columns', async () => {
    const store = await openStore(RTREE, { driver: storedDriver() });
    const places = store.collection('places');
    try {
      for (const doc of DOCS) await places.insert(doc);
      const explained = await places.explain(WITHIN);
      assert.deepStrictEqual(explained.prefilters.map((p) => [p.construct, p.via]),
        [['$within', 'rtree']]);
      assert.deepStrictEqual(await places.execute(WITHIN), DOCS[0]);
      await places.patch('ams', [{ op: 'replace', path: '/at', value: [0, 0] }]);
      assert.strictEqual(await places.execute(WITHIN), undefined,
        'the patch moved the point out of the region, and the index followed it');
      await places.patch('rtm', [{ op: 'replace', path: '/at', value: [4.9, 52.37] }]);
      assert.deepStrictEqual(await places.execute(WITHIN),
        { id: 'rtm', at: [4.9, 52.37], kind: 'city' },
        'and it followed a point INTO the region too');
    }
    finally { await store.close(); }
  });
});

describe('the incapable driver falls back to columns — and says so (D-e)', () => {
  /**
   * A wasm handle that declares no R*Tree. The capability is read from
   * the library's compile options, so this forces the branch the way a
   * build without the module would present it.
   */
  const noRtreeDriver = () => {
    const driver = wasmDriver(declaringWasmHandle({}));
    return {
      ...driver,
      open: async (path, options) => {
        const connection = await driver.open(path, options);
        return { ...connection,
          capabilities: Object.freeze({ ...connection.capabilities, rtree: false }) };
      },
    };
  };

  it('the same model plans the B-tree shape, and explain() reports via: columns',
    async () => {
      const store = await openStore(RTREE, { driver: noRtreeDriver() });
      const places = store.collection('places');
      try {
        assert.strictEqual(store.capabilities.rtree, false);
        for (const doc of DOCS) await places.insert(doc);
        const explained = await places.explain(WITHIN);
        assert.deepStrictEqual(explained.prefilters.map((p) => [p.construct, p.via]),
          [['$within', 'columns']],
          'a report, not a degradation: the surface says which shape ran');
        assert.deepStrictEqual(explained.indexes, ['places_by_box']);
        assert.deepStrictEqual(await places.execute(WITHIN), DOCS[0],
          'nothing about the answer changed');
        // and the exactness follows the shape that RAN, not the declaration
        const intersects = await places.explain(INTERSECTS);
        assert.strictEqual(intersects.prefilters[0].exact, true);
      }
      finally { await store.close(); }
    });
});

describe('changing the mapping is a migration, not an open', () => {
  const planned = (from, to) => planMigration(from, to,
    { dialect: sqliteDialect, id: 'physical' }).migration;

  it('columns → rtree creates the virtual table, the triggers and a backfill', () => {
    const migration = planned(COLUMNS, RTREE);
    const notes = migration.steps.map((step) => step.note);
    assert.deepStrictEqual(migration.steps.map((step) => step.kind),
      ['ddl', 'ddl', 'ddl', 'ddl', 'ddl', 'sql'], notes.join('\n'));
    assert.match(migration.steps[0].sql, /DROP INDEX "places_by_box"/);
    assert.match(migration.steps[1].sql, new RegExp(`CREATE VIRTUAL TABLE "${VIRTUAL}"`));
    assert.match(migration.steps[5].sql,
      new RegExp(`INSERT INTO "${VIRTUAL}"[\\s\\S]*SELECT[\\s\\S]*FROM "places"`));
    assert.match(migration.steps[5].sql, /IS NOT NULL/);
  });

  it('rtree → columns drops all four objects and creates the B-tree', () => {
    const migration = planned(RTREE, COLUMNS);
    const sql = migration.steps.map((step) => step.sql).join('\n');
    for (const trigger of TRIGGERS) assert.match(sql, new RegExp(`DROP TRIGGER "${trigger}"`));
    assert.match(sql, new RegExp(`DROP TABLE "${VIRTUAL}"`));
    assert.match(sql, /CREATE INDEX "places_by_box"/);
  });

  it('the migration runs, the index is correct afterwards, and a replay is a no-op',
    async () => {
      const temp = tempDbPath();
      try {
        const store = await openStore(COLUMNS, { driver: nodeDriver(), path: temp.dbPath });
        for (const doc of DOCS) await store.collection('places').insert(doc);
        await store.close();

        const migration = planned(COLUMNS, RTREE);
        const first = await migrate({ driver: nodeDriver(), path: temp.dbPath }, [migration],
          { baseline: COLUMNS, model: RTREE });
        assert.strictEqual(first.applied.length, 1);

        // the backfill put exactly the bounded rows in, and nothing else
        const rows = await readVirtual(temp.dbPath);
        assert.deepStrictEqual(rows.map((row) => row.key), ['ams', 'rtm', 'utr', 'hil']);

        // the migrated file now VERIFIES against the target model
        const reopened = await openStore(RTREE, { driver: nodeDriver(), path: temp.dbPath });
        assert.deepStrictEqual(await reopened.collection('places').execute(WITHIN), DOCS[0]);
        await reopened.close();

        const replay = await migrate({ driver: nodeDriver(), path: temp.dbPath }, [migration],
          { baseline: COLUMNS, model: RTREE });
        assert.deepStrictEqual(replay.applied, []);
      }
      finally { temp.cleanup(); }
    });

  it('a whole-schema comparison sees the shadow tables and is not tripped by them',
    async () => {
      const temp = tempDbPath();
      try {
        const store = await openStore(COLUMNS, { driver: nodeDriver(), path: temp.dbPath });
        for (const doc of DOCS) await store.collection('places').insert(doc);
        await store.close();
        await migrate({ driver: nodeDriver(), path: temp.dbPath }, [planned(COLUMNS, RTREE)],
          { baseline: COLUMNS, model: RTREE });

        const connection = await nodeDriver().open(temp.dbPath, {});
        await registerDeriveFunctions(connection);
        const dump = await schemaShapeOf(connection);
        // the module's three shadow tables ARE in the dump — they carry
        // SQL text — and they are deterministic from the virtual table's
        // name, so a migrated database and a fresh one agree about them
        assert.deepStrictEqual(
          dump.filter((row) => row.type === 'table' && row.name.startsWith(`${VIRTUAL}_`))
            .map((row) => row.name),
          [`${VIRTUAL}_node`, `${VIRTUAL}_parent`, `${VIRTUAL}_rowid`]);
        const difference = await compareShapeToModel(nodeDriver(), connection, RTREE);
        await connection.close();
        assert.strictEqual(difference, null, String(difference));
      }
      finally { temp.cleanup(); }
    });

  it('no collection change produces a REBUILD step — the one step that would renumber rowids',
    async () => {
      // F7: a rebuild copies rows into a new table and SQLite renumbers
      // the rowids, which is exactly what an R*Tree keys on. The shipped
      // planner never rebuilds a COLLECTION (only an entity, and an
      // entity has no derived index), so the hazard cannot arise today —
      // this is the pin that makes a future collection rebuild confront
      // it instead of shipping a silently corrupt index.
      const shapes = [
        [COLUMNS, RTREE], [RTREE, COLUMNS],
        [COLUMNS, model(undefined)], [RTREE, { $model: '0.1', collections: {
          places: { schema: { ...SCHEMA, properties: { ...SCHEMA.properties,
            extra: { type: 'string' } } }, key: '/id', indexes: [] } } }],
      ];
      for (const [from, to] of shapes) {
        const migration = planMigration(from, to,
          { dialect: sqliteDialect, id: 'probe' }).migration;
        assert.deepStrictEqual(
          migration.steps.filter((step) => step.kind === 'rebuild'), [],
          `${JSON.stringify(from.collections.places.indexes)} -> `
          + `${JSON.stringify(to.collections.places.indexes)}`);
      }

      // and the fact itself, so the note above is checkable: a
      // rebuild-style copy DOES renumber
      const temp = tempDbPath();
      try {
        const store = await openStore(COLUMNS, { driver: nodeDriver(), path: temp.dbPath });
        for (const doc of DOCS) await store.collection('places').insert(doc);
        await store.collection('places').delete('rtm');
        await store.close();
        const connection = await nodeDriver().open(temp.dbPath, {});
        await registerDeriveFunctions(connection);
        const rowids = async (table) => (await (await connection.prepare(
          `SELECT "rowid" AS rid, "key" FROM "${table}" ORDER BY "key"`)).all([]))
          .map((row) => Number(row.rid));
        const before = await rowids('places');
        await connection.exec('CREATE TABLE "copy" ("key" TEXT PRIMARY KEY, "doc" BLOB NOT NULL) STRICT');
        await connection.exec('INSERT INTO "copy" ("key", "doc") SELECT "key", "doc" FROM "places"');
        const after = await rowids('copy');
        await connection.close();
        assert.notDeepStrictEqual(after, before,
          'a rebuild-style copy renumbers rowids — which is what an R*Tree keys on');
      }
      finally { temp.cleanup(); }
    });

  it('dropping the collection leaves no virtual table and no shadow table behind (F6)',
    async () => {
      const temp = tempDbPath();
      try {
        const store = await openStore(RTREE, { driver: nodeDriver(), path: temp.dbPath });
        for (const doc of DOCS) await store.collection('places').insert(doc);
        await store.close();

        const empty = {
          $model: '0.1',
          collections: { other: { schema: { type: 'object' }, key: null, identity: 'integer' } },
        };
        await migrate({ driver: nodeDriver(), path: temp.dbPath },
          [planMigration(RTREE, empty, { dialect: sqliteDialect, id: 'drop' }).migration],
          { baseline: RTREE, model: empty });

        const connection = await nodeDriver().open(temp.dbPath, {});
        const rows = await (await connection.prepare(
          "SELECT name FROM sqlite_schema WHERE name LIKE '%rtree%'")).all([]);
        await connection.close();
        assert.deepStrictEqual(rows, [],
          'a leftover virtual table is a stale index a later probe would read');
      }
      finally { temp.cleanup(); }
    });
});
