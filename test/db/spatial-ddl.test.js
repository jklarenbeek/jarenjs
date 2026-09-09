//@ts-check
/**
 * @file Derived spatial index kinds: `indexes[].derive` in the model
 * document, the two physical mappings a driver's capability selects (a
 * virtual generated column over a registered deterministic function,
 * or a stored column the store writes), the refusals, the NULL rule
 * for a value with no bounded position, the drift a file moved between
 * the two mappings legitimately reports, the migration that adds one —
 * and the two-run check: a second open over the same FILE runs no DDL
 * and reports no difference.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  openStore, normalizeModel, planCollection, sqliteDialect, createDialect,
  planMigration, migrate, registerDeriveFunctions,
} from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { wasmDriver } from '@jarenjs/db/wasm';
import { geohashEncode } from '@jarenjs/core/geo';
import {
  tempDbPath, declaringWasmHandle, recordingDriver, fullDoubleDialect,
} from './helpers.js';

const SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    at: { type: 'array', items: { type: 'number' } },
    geometry: { type: 'object' },
    name: { type: 'string' },
  },
};

const model = (indexes) => ({
  $model: '0.1',
  collections: { places: { schema: SCHEMA, key: '/id', indexes } },
});

const SPATIAL = model([
  { name: 'by_cell', path: '$.at', derive: 'geohash', precision: 7 },
  { name: 'by_box', path: '$.geometry', derive: 'bbox' },
]);

const DERIVED_COLUMNS = ['gx_at_gh7', 'gx_geometry_bbox_w', 'gx_geometry_bbox_s',
  'gx_geometry_bbox_e', 'gx_geometry_bbox_n'];

/**
 * The forced-incapable branch. `bun:sqlite` exposes no `function`, so
 * the Bun binding declares `deterministicIndexableFunctions: false` and
 * its derived columns are stored rather than generated. The SAME code
 * path runs here — only the declaration differs, not the binding
 * underneath — so the real Bun binding is covered by this, not by a
 * separate run.
 */
const storedDriver = () => wasmDriver(declaringWasmHandle({
  userFunctions: false, deterministicIndexableFunctions: false, sessions: false,
}));

const AMSTERDAM = [4.9041, 52.3676];
const ROTTERDAM = [4.4777, 51.9244];

const DOCS = [
  { id: 'ams', at: AMSTERDAM, geometry: { type: 'Point', coordinates: AMSTERDAM } },
  { id: 'rtm', at: ROTTERDAM, geometry: { type: 'Point', coordinates: ROTTERDAM } },
  // one value that cannot be bounded, and one with no member at all
  {
    id: 'broken',
    at: [Number.NaN, 1],
    geometry: { type: 'Point', coordinates: [Number.NaN, 1] },
  },
  { id: 'absent', name: 'nowhere' },
];

/**
 * Every derived column of every row of a stored database, keyed by
 * document key — read straight out of the table, because what is
 * physically stored is the whole question. The reading connection
 * registers the functions first: a table whose column expression calls
 * one this connection does not have cannot even be SELECTed.
 * @param {string} dbPath
 * @param {string[]} [columns]
 * @returns {Promise<Record<string, any>>}
 */
async function derivedRows(dbPath, columns = DERIVED_COLUMNS) {
  const connection = await nodeDriver().open(dbPath, {});
  await registerDeriveFunctions(connection);
  const names = ['key', ...columns].map((name) => sqliteDialect.quoteIdentifier(name));
  const statement = await connection.prepare(
    `SELECT ${names.join(', ')} FROM "places" ORDER BY "key"`);
  const rows = await statement.all([]);
  await connection.close();
  return Object.fromEntries(rows.map((row) => [row.key,
    Object.fromEntries(columns.map((name) => [name, row[name]]))]));
}

/**
 * Open a store on a fresh file, run `work`, close, and hand back the
 * path so the columns can be read.
 * @param {any} driver
 * @param {any} document
 * @param {(collection: any, store: any) => Promise<void>} work
 * @returns {Promise<{ dbPath: string, cleanup: () => void }>}
 */
async function seeded(driver, document, work) {
  const temp = tempDbPath();
  const store = await openStore(document, { driver, path: temp.dbPath });
  await work(store.collection('places'), store);
  await store.close();
  return temp;
}

describe('the derive declaration', () => {
  const refusal = (indexes, member) => {
    let thrown = null;
    try {
      planCollection('places', normalizeModel(model(indexes)).get('places'), sqliteDialect);
    }
    catch (error) {
      thrown = error;
    }
    assert.ok(thrown !== null, `expected a refusal for ${JSON.stringify(indexes)}`);
    assert.strictEqual(thrown.code, 'JD0004', thrown.message);
    assert.strictEqual(thrown.docPath, member);
    return thrown;
  };

  it('refuses a geohash index with no precision — there is no safe default', () => {
    const error = refusal([{ name: 'by_cell', path: '$.at', derive: 'geohash' }],
      '/collections/places/indexes/0/precision');
    assert.match(error.message, /1\.\.12/);
    assert.match(error.message, /query radius/);
  });

  it('refuses a precision outside 1..12, and a non-integer one', () => {
    for (const precision of [0, 13, 7.5, '7']) {
      refusal([{ name: 'by_cell', path: '$.at', derive: 'geohash', precision }],
        '/collections/places/indexes/0/precision');
    }
  });

  it('refuses precision beside a bbox index, and precision with no derive at all', () => {
    refusal([{ name: 'by_box', path: '$.geometry', derive: 'bbox', precision: 7 }],
      '/collections/places/indexes/0/precision');
    refusal([{ name: 'by_name', path: '$.name', precision: 7 }],
      '/collections/places/indexes/0/precision');
  });

  it('refuses unique beside any derive: distinct positions share a cell', () => {
    refusal([{ name: 'by_cell', path: '$.at', derive: 'geohash', precision: 7, unique: true }],
      '/collections/places/indexes/0/unique');
    refusal([{ name: 'by_box', path: '$.geometry', derive: 'bbox', unique: true }],
      '/collections/places/indexes/0/unique');
  });

  it('refuses a non-singular path, exactly as an undecorated index does', () => {
    refusal([{ name: 'by_cell', path: '$.trips[*].at', derive: 'geohash', precision: 7 }],
      '/collections/places/indexes/0/path');
  });

  it('refuses a derive over a path the schema types as a scalar', () => {
    const error = refusal(
      [{ name: 'by_cell', path: '$.name', derive: 'geohash', precision: 7 }],
      '/collections/places/indexes/0/derive');
    assert.match(error.message, /typed 'string'/);
  });

  it("refuses physical anywhere but on a bbox index, and refuses an unknown value", () => {
    refusal([{ name: 'by_cell', path: '$.at', derive: 'geohash', precision: 7,
      physical: 'rtree' }], '/collections/places/indexes/0/physical');
    refusal([{ name: 'by_name', path: '$.name', physical: 'rtree' }],
      '/collections/places/indexes/0/physical');
    const unknown = refusal([{ name: 'by_box', path: '$.geometry', derive: 'bbox',
      physical: 'quadtree' }], '/collections/places/indexes/0/physical');
    assert.match(unknown.message, /closed set/);
  });

  it('refuses two indexes over one column set asking for two shapes on disk', () => {
    const error = refusal([
      { name: 'by_box', path: '$.geometry', derive: 'bbox' },
      { name: 'also_box', path: '$.geometry', derive: 'bbox', physical: 'rtree' },
    ], '/collections/places/indexes/1/physical');
    assert.match(error.message, /one shape on disk/);
  });

  it('refuses an unknown derive value and a composite derived path', () => {
    refusal([{ name: 'by_cell', path: '$.at', derive: 'quadkey', precision: 7 }],
      '/collections/places/indexes/0/derive');
    refusal([{ name: 'by_cell', path: ['$.at', '$.geometry'], derive: 'bbox' }],
      '/collections/places/indexes/0/path');
  });
});

describe('the physical mapping', () => {
  const planned = (mapping) => planCollection('places',
    normalizeModel(SPATIAL).get('places'), sqliteDialect,
    mapping === undefined ? undefined : { derived: mapping });

  it('the capable branch: virtual generated columns over registered functions', () => {
    assert.deepStrictEqual(planned().createSql, [
      'CREATE TABLE "places" ('
      + '"key" TEXT PRIMARY KEY, '
      + '"doc" BLOB NOT NULL, '
      + '"gx_at_gh7" TEXT GENERATED ALWAYS AS '
      + '(jaren_geohash(json(("doc" -> \'$."at"\')), 7)) VIRTUAL, '
      + '"gx_geometry_bbox_w" REAL GENERATED ALWAYS AS '
      + '(jaren_bbox_w(json(("doc" -> \'$."geometry"\')))) VIRTUAL, '
      + '"gx_geometry_bbox_s" REAL GENERATED ALWAYS AS '
      + '(jaren_bbox_s(json(("doc" -> \'$."geometry"\')))) VIRTUAL, '
      + '"gx_geometry_bbox_e" REAL GENERATED ALWAYS AS '
      + '(jaren_bbox_e(json(("doc" -> \'$."geometry"\')))) VIRTUAL, '
      + '"gx_geometry_bbox_n" REAL GENERATED ALWAYS AS '
      + '(jaren_bbox_n(json(("doc" -> \'$."geometry"\')))) VIRTUAL'
      + ') STRICT',
      'CREATE INDEX "places_by_cell" ON "places" ("gx_at_gh7")',
      'CREATE INDEX "places_by_box" ON "places" '
      + '("gx_geometry_bbox_w", "gx_geometry_bbox_e", "gx_geometry_bbox_s", "gx_geometry_bbox_n")',
    ]);
  });

  it('the incapable branch: the same columns, ordinary, written by the store', () => {
    assert.strictEqual(planned('stored').createSql[0],
      'CREATE TABLE "places" ('
      + '"key" TEXT PRIMARY KEY, '
      + '"doc" BLOB NOT NULL, '
      + '"gx_at_gh7" TEXT, '
      + '"gx_geometry_bbox_w" REAL, '
      + '"gx_geometry_bbox_s" REAL, '
      + '"gx_geometry_bbox_e" REAL, '
      + '"gx_geometry_bbox_n" REAL'
      + ') STRICT');
    assert.deepStrictEqual(
      planned('stored').expected.columns.filter((column) => column.generated), [],
      'a stored derived column is not a generated one, and verifyShape compares that flag');
    assert.strictEqual(
      planned().expected.columns.filter((column) => column.generated).length, 5);
  });

  it('the bbox index covers (w, e, s, n) — the order the intersection test reads', () => {
    const index = planned().expected.indexes.find((i) => i.name === 'places_by_box');
    assert.deepStrictEqual(index.columns, [
      'gx_geometry_bbox_w', 'gx_geometry_bbox_e',
      'gx_geometry_bbox_s', 'gx_geometry_bbox_n',
    ]);
    assert.strictEqual(index.unique, false);
  });

  it('two geohash indexes over one path share a column at one precision, not at two', () => {
    const shared = planCollection('places', normalizeModel(model([
      { name: 'a', path: '$.at', derive: 'geohash', precision: 7 },
      { name: 'b', path: '$.at', derive: 'geohash', precision: 7 },
    ])).get('places'), sqliteDialect);
    assert.deepStrictEqual(shared.generated.map((c) => c.name), ['gx_at_gh7']);
    assert.deepStrictEqual(shared.expected.indexes.map((i) => i.columns),
      [['gx_at_gh7'], ['gx_at_gh7']]);

    const split = planCollection('places', normalizeModel(model([
      { name: 'a', path: '$.at', derive: 'geohash', precision: 5 },
      { name: 'b', path: '$.at', derive: 'geohash', precision: 9 },
    ])).get('places'), sqliteDialect);
    assert.deepStrictEqual(split.generated.map((c) => c.name), ['gx_at_gh5', 'gx_at_gh9']);
  });

  it('a plain index over the same path keeps its own column', () => {
    const plan = planCollection('places', normalizeModel(model([
      { name: 'a', path: '$.at', derive: 'geohash', precision: 7 },
      { name: 'b', path: '$.at' },
    ])).get('places'), sqliteDialect);
    assert.deepStrictEqual(plan.generated.map((c) => c.name), ['gx_at_gh7', 'gx_at']);
  });

  it('the dialect seam holds: the same model spells differently through the double', () => {
    const create = planCollection('places',
      normalizeModel(SPATIAL).get('places'), fullDoubleDialect(createDialect)).createSql[0];
    assert.match(create,
      /\[gx_at_gh7\] VALTYPE GENERATED ALWAYS AS \(CELL\(JTEXT\(JX\(\[doc\], '\/at'\)\), 7\)\)/);
    assert.match(create, /BOX_W\(JTEXT\(JX\(\[doc\], '\/geometry'\)\)\)/);
  });
});

describe('derived values, both physical mappings', () => {
  for (const [branch, makeDriver] of [['virtual', nodeDriver], ['stored', storedDriver]]) {
    it(`${branch}: the columns carry the cell and the box`, async () => {
      const temp = await seeded(makeDriver(), SPATIAL, async (places) => {
        for (const doc of DOCS) await places.insert(doc);
      });
      try {
        const rows = await derivedRows(temp.dbPath);
        assert.strictEqual(rows.ams.gx_at_gh7, geohashEncode(AMSTERDAM[0], AMSTERDAM[1], 7));
        assert.strictEqual(rows.rtm.gx_at_gh7, geohashEncode(ROTTERDAM[0], ROTTERDAM[1], 7));
        assert.deepStrictEqual([
          rows.ams.gx_geometry_bbox_w, rows.ams.gx_geometry_bbox_s,
          rows.ams.gx_geometry_bbox_e, rows.ams.gx_geometry_bbox_n,
        ], [AMSTERDAM[0], AMSTERDAM[1], AMSTERDAM[0], AMSTERDAM[1]]);
      }
      finally { temp.cleanup(); }
    });

    it(`${branch}: a non-finite coordinate and a missing member are SQL NULL`, async () => {
      const temp = await seeded(makeDriver(), SPATIAL, async (places) => {
        for (const doc of DOCS) await places.insert(doc);
      });
      try {
        const rows = await derivedRows(temp.dbPath);
        for (const key of ['broken', 'absent']) {
          assert.deepStrictEqual(Object.values(rows[key]), [null, null, null, null, null],
            `every derived column of '${key}' is NULL`);
        }
      }
      finally { temp.cleanup(); }
    });
  }

  it('a geometry keeps the box over the positions it HAS, in both mappings', async () => {
    // The kernel's division of labour, surfacing here: `eachPosition`
    // traverses, `isValidGeoJson` judges. A vertex that is not a
    // position is skipped, so a LineString with one broken vertex is
    // bounded by its other one — a document the GeoJSON meta-schema
    // refuses in the first place. Pinned because the two mappings must
    // agree about it, not because it is a good document to store.
    const bad = {
      id: 'partial',
      geometry: { type: 'LineString', coordinates: [[3, 4], [Number.NaN, 1]] },
    };
    const boxes = [];
    for (const makeDriver of [nodeDriver, storedDriver]) {
      const temp = await seeded(makeDriver(), SPATIAL, async (places) => {
        await places.insert(bad);
      });
      try { boxes.push((await derivedRows(temp.dbPath)).partial); }
      finally { temp.cleanup(); }
    }
    assert.deepStrictEqual(boxes[0], boxes[1],
      'the generated and the stored mapping answer identically');
    assert.deepStrictEqual(boxes[0], {
      gx_at_gh7: null,
      gx_geometry_bbox_w: 3, gx_geometry_bbox_s: 4,
      gx_geometry_bbox_e: 3, gx_geometry_bbox_n: 4,
    });
  });

  it('stored: an update recomputes the columns rather than leaving them stale', async () => {
    const temp = tempDbPath();
    try {
      const store = await openStore(SPATIAL, { driver: storedDriver(), path: temp.dbPath });
      const places = store.collection('places');
      await places.insert({
        id: 'x', at: AMSTERDAM, geometry: { type: 'Point', coordinates: AMSTERDAM },
      });
      await store.close();
      const before = (await derivedRows(temp.dbPath)).x;

      const put = await openStore(SPATIAL, { driver: storedDriver(), path: temp.dbPath });
      await put.collection('places').put({
        id: 'x', at: ROTTERDAM, geometry: { type: 'Point', coordinates: ROTTERDAM },
      });
      await put.close();
      const afterPut = (await derivedRows(temp.dbPath)).x;
      assert.notStrictEqual(afterPut.gx_at_gh7, before.gx_at_gh7);
      assert.strictEqual(afterPut.gx_at_gh7, geohashEncode(ROTTERDAM[0], ROTTERDAM[1], 7));
      assert.strictEqual(afterPut.gx_geometry_bbox_w, ROTTERDAM[0]);

      const patched = await openStore(SPATIAL, { driver: storedDriver(), path: temp.dbPath });
      await patched.collection('places').patch('x', [
        { op: 'replace', path: '/at', value: AMSTERDAM },
        { op: 'replace', path: '/geometry/coordinates', value: AMSTERDAM },
      ]);
      await patched.close();
      assert.deepStrictEqual((await derivedRows(temp.dbPath)).x, before,
        'the same document derives the same columns, through the translated patch too');
    }
    finally { temp.cleanup(); }
  });

  it('stored: writing the same value twice leaves the columns byte-identical', async () => {
    const temp = tempDbPath();
    try {
      const doc = { id: 'x', at: AMSTERDAM, geometry: { type: 'Point', coordinates: AMSTERDAM } };
      const store = await openStore(SPATIAL, { driver: storedDriver(), path: temp.dbPath });
      await store.collection('places').put(doc);
      const first = (await derivedRows(temp.dbPath)).x;
      await store.collection('places').put({ ...doc });
      await store.close();
      assert.deepStrictEqual((await derivedRows(temp.dbPath)).x, first);
    }
    finally { temp.cleanup(); }
  });
});

describe('the two-run check', () => {
  for (const [branch, makeDriver] of [['virtual', nodeDriver], ['stored', storedDriver]]) {
    it(`${branch}: a second open over the same file runs no DDL and reports no difference`,
      async () => {
        const temp = tempDbPath();
        try {
          const isDdl = (sql) => /^\s*(CREATE|ALTER|DROP)\b/i.test(sql);
          const first = recordingDriver(makeDriver());
          const store = await openStore(SPATIAL, { driver: first.driver, path: temp.dbPath });
          await store.collection('places').insert(DOCS[0]);
          await store.close();
          assert.ok(first.executed.some(isDdl), 'the first open creates the shape');

          const second = recordingDriver(makeDriver());
          const reopened = await openStore(SPATIAL, { driver: second.driver, path: temp.dbPath });
          assert.deepStrictEqual(await reopened.collection('places').get('ams'), DOCS[0]);
          await reopened.close();
          assert.deepStrictEqual(second.executed.filter(isDdl), [],
            'the second open verifies and alters nothing');
        }
        finally { temp.cleanup(); }
      });
  }

  it('a file created under one mapping and opened under the other is JD0002', async () => {
    const temp = tempDbPath();
    try {
      const store = await openStore(SPATIAL, { driver: nodeDriver(), path: temp.dbPath });
      await store.collection('places').insert(DOCS[0]);
      await store.close();
      await assert.rejects(
        openStore(SPATIAL, { driver: storedDriver(), path: temp.dbPath }),
        (error) => {
          assert.strictEqual(error.code, 'JD0002');
          assert.match(error.message, /gx_at_gh7/);
          return true;
        },
        'the physical mapping belongs to the driver that created the file — '
        + 'moving it is a migration, not an open');
    }
    finally { temp.cleanup(); }
  });
});

describe('migrating a derived index', () => {
  const BEFORE = model([{ name: 'by_name', path: '$.name' }]);

  it('the stored branch backfills an added derived column, and a replay is a no-op', async () => {
    const temp = tempDbPath();
    try {
      const store = await openStore(BEFORE, { driver: storedDriver(), path: temp.dbPath });
      for (const doc of DOCS) await store.collection('places').insert(doc);
      await store.close();

      const { migration } = planMigration(BEFORE, SPATIAL,
        { dialect: sqliteDialect, derived: 'stored', id: '0001-spatial' });
      const backfill = migration.steps.filter((step) => step.kind === 'derive');
      assert.strictEqual(backfill.length, 1, 'one backfill step for the collection');
      assert.deepStrictEqual(backfill[0].columns.map((column) => column.name), DERIVED_COLUMNS);
      assert.ok(migration.steps.some((step) => step.kind === 'ddl'
        && step.sql === 'ALTER TABLE "places" ADD COLUMN "gx_at_gh7" TEXT'));

      const applied = await migrate({ driver: storedDriver(), path: temp.dbPath }, [migration],
        { baseline: BEFORE, model: SPATIAL });
      assert.deepStrictEqual(applied.applied, ['0001-spatial']);
      const rows = await derivedRows(temp.dbPath);
      assert.strictEqual(rows.ams.gx_at_gh7, geohashEncode(AMSTERDAM[0], AMSTERDAM[1], 7),
        'the rows that were already there are backfilled, not left NULL');
      assert.strictEqual(rows.absent.gx_at_gh7, null);

      const again = await migrate({ driver: storedDriver(), path: temp.dbPath }, [migration],
        { baseline: BEFORE, model: SPATIAL });
      assert.deepStrictEqual(again.applied, [], 'applying twice is a no-op');
      assert.deepStrictEqual(await derivedRows(temp.dbPath), rows);
    }
    finally { temp.cleanup(); }
  });

  it('the virtual branch needs no backfill: a generated column arrives populated', async () => {
    const temp = tempDbPath();
    try {
      const store = await openStore(BEFORE, { driver: nodeDriver(), path: temp.dbPath });
      for (const doc of DOCS) await store.collection('places').insert(doc);
      await store.close();

      const { migration } = planMigration(BEFORE, SPATIAL,
        { dialect: sqliteDialect, id: '0001-spatial' });
      assert.deepStrictEqual(migration.steps.filter((step) => step.kind === 'derive'), []);

      const applied = await migrate({ driver: nodeDriver(), path: temp.dbPath }, [migration],
        { baseline: BEFORE, model: SPATIAL });
      assert.deepStrictEqual(applied.applied, ['0001-spatial']);
      const rows = await derivedRows(temp.dbPath);
      assert.strictEqual(rows.rtm.gx_at_gh7, geohashEncode(ROTTERDAM[0], ROTTERDAM[1], 7));
    }
    finally { temp.cleanup(); }
  });

  it('dropping a derived index drops its columns and its index', () => {
    const { migration } = planMigration(SPATIAL, BEFORE, { dialect: sqliteDialect });
    const sqls = migration.steps.map((step) => step.sql);
    assert.ok(sqls.includes('DROP INDEX "places_by_cell"'));
    assert.ok(sqls.includes('ALTER TABLE "places" DROP COLUMN "gx_at_gh7"'));
    for (const component of ['w', 's', 'e', 'n']) {
      assert.ok(sqls.includes(`ALTER TABLE "places" DROP COLUMN "gx_geometry_bbox_${component}"`));
    }
  });

  it('changing the precision is a different column, not the same one altered', () => {
    const coarse = model([{ name: 'by_cell', path: '$.at', derive: 'geohash', precision: 5 }]);
    const fine = model([{ name: 'by_cell', path: '$.at', derive: 'geohash', precision: 9 }]);
    const sqls = planMigration(coarse, fine, { dialect: sqliteDialect })
      .migration.steps.map((step) => step.sql);
    assert.ok(sqls.includes('ALTER TABLE "places" DROP COLUMN "gx_at_gh5"'));
    assert.ok(sqls.some((sql) => sql?.startsWith('ALTER TABLE "places" ADD COLUMN "gx_at_gh9"')));
  });
});

describe('one home for spatial arithmetic (D1)', () => {
  it('no file in packages/db computes a cell, a box or a distance of its own', () => {
    const root = 'packages/db/src';
    /** @param {string} dir @returns {string[]} */
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) => (entry.isDirectory()
        ? walk(path.join(dir, entry.name))
        : [path.join(dir, entry.name)]));
    const files = walk(root).filter((file) => file.endsWith('.js'));
    const forbidden = /Math\.(atan2|asin|sinh)|6371|0123456789bcdefghjkmnpqrstuvwxyz|haversine/;
    const offenders = files.filter((file) => forbidden.test(fs.readFileSync(file, 'utf8')));
    assert.deepStrictEqual(offenders, [],
      'every cell and every box comes from @jarenjs/core/geo');
    const geoImporters = files.filter((file) =>
      /from '@jarenjs\/core\/geo'/.test(fs.readFileSync(file, 'utf8')));
    // compare in posix spelling: path.join walked with the host separator
    assert.deepStrictEqual(geoImporters.map((file) => file.split(path.sep).join('/')),
      ['packages/db/src/derive.js'],
      'and exactly one file in this package reaches for it');
  });
});
