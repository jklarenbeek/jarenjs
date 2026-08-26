//@ts-check
/**
 * @file The vector column: `derive: 'vector'` with `dims` in the model
 * document (MODEL-FORMAT §2.1), ONE packed Float32 stored column on
 * every driver (§3.1 — deliberately one mapping, not the spatial
 * capability branch), the refusals, the NULL rule for an unrankable
 * member (§3.2), the write-path lockstep read back through BARE SQL on
 * a connection that registered nothing, the migration that adds one
 * and the backfill that fills it, and the two-run check.
 *
 * First, though, T1: the derive-kind switches are exhaustive, seen red
 * with a kind that does not exist BEFORE the vector kind was added.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  openStore, normalizeModel, planCollection, sqliteDialect, createDialect,
  planMigration, migrate, derivedValue, deriveVector, derivedMappingFor, DERIVE_MAPPING,
  DIMS_MIN, DIMS_MAX, chain,
} from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { wasmDriver } from '@jarenjs/db/wasm';
import { l2Normalize, packVector, unpackVector } from '@jarenjs/core/vector';
import { JarenValidator } from '@jarenjs/validate';

import {
  tempDbPath, declaringWasmHandle, recordingDriver, fullDoubleDialect,
} from './helpers.js';
import { compileArtifact } from '../json/schema-artifact-helpers.js';

const DIMS = 3;
const COLUMN = 'gx_embedding_v3';

const SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    embedding: { type: 'array', items: { type: 'number' } },
    at: { type: 'array', items: { type: 'number' } },
    name: { type: 'string' },
    meta: { type: 'object' },
    loose: {},
    mixed: { type: ['array', 'null'] },
    listed: { type: ['array'] },
  },
};

const model = (indexes, schema = SCHEMA) => ({
  $model: '0.1',
  collections: { items: { schema, key: '/id', indexes } },
});

const VECTOR = model([{ name: 'by_vec', path: '$.embedding', derive: 'vector', dims: DIMS }]);

/** The bun-shaped path: no function API, derived columns stored (see
 * `spatial-ddl.test.js` for why this covers the real binding). */
const storedDriver = () => wasmDriver(declaringWasmHandle({
  userFunctions: false, deterministicIndexableFunctions: false, sessions: false,
}));

/**
 * A driver wrapper that records every function REGISTERED through it —
 * the proof that a vector column needs none is a count of zero.
 * @param {any} driver
 */
function functionRecordingDriver(driver) {
  /** @type {string[]} */
  const registered = [];
  return {
    registered,
    driver: {
      name: driver.name,
      dialect: driver.dialect,
      open: (dbPath, options) => chain(driver.open(dbPath, options), (connection) => ({
        ...connection,
        registerFunction: (name, options, fn) => {
          registered.push(name);
          return connection.registerFunction(name, options, fn);
        },
      })),
    },
  };
}

const DOCS = [
  { id: 'a', embedding: [3, 4, 0] },
  { id: 'b', embedding: [1, 1, 1] },
  // the zero vector has no direction and is STORED, not refused: it
  // scores 0 against everything, which the format publishes as a score
  { id: 'zero', embedding: [0, 0, 0] },
  // every shape of "unrankable" — each writes NULL, each document stores
  { id: 'short', embedding: [1, 2] },
  { id: 'long', embedding: [1, 2, 3, 4] },
  { id: 'nan', embedding: [1, Number.NaN, 3] },
  { id: 'nested', embedding: [[1], [2], [3]] },
  { id: 'text', embedding: 'not a vector' },
  { id: 'absent', name: 'nothing here' },
];
const RANKABLE = ['a', 'b', 'zero'];
const UNRANKABLE = ['short', 'long', 'nan', 'nested', 'text', 'absent'];

/**
 * The column of every row, read through a BARE connection that has
 * registered nothing — which is itself part of the claim: a stored
 * column is readable by any tool.
 * @param {string} dbPath
 * @param {string} [column]
 * @returns {Record<string, Uint8Array | null>}
 */
function bareColumn(dbPath, column = COLUMN) {
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db.prepare(`SELECT "key", "${column}" AS v FROM "items" ORDER BY "key"`).all();
    return Object.fromEntries(rows.map((row) => [row.key, row.v]));
  }
  finally { db.close(); }
}

/** The stored form unpacked, for comparison with the kernel's answer. */
const unpacked = (bytes) => (bytes === null ? null : unpackVector(bytes, DIMS));

/**
 * Open a store on a fresh file, run `work`, close, hand back the path.
 * @param {any} driver
 * @param {any} document
 * @param {(items: any, store: any) => Promise<void>} work
 */
async function seeded(driver, document, work) {
  const temp = tempDbPath();
  const store = await openStore(document, { driver, path: temp.dbPath });
  await work(store.collection('items'), store);
  await store.close();
  return temp;
}

describe('T1 — the derive-kind switches are exhaustive', () => {
  const FAKE = { derive: 'quadkey', precision: 7, component: 'w', dims: 3 };

  it('derivedValue throws on a kind it has no rule for, naming the kind', () => {
    assert.throws(() => derivedValue(FAKE, [1, 2, 3]), (error) => {
      assert.match(error.message, /quadkey/);
      return true;
    }, 'an open ternary would have answered a bbox edge of the first floats');
  });

  it('the sqlite dialect refuses to spell an expression for a kind it does not know', () => {
    assert.throws(() => sqliteDialect.derivedColumn('"doc"', '$."at"', FAKE), (error) => {
      assert.match(error.message, /quadkey/);
      return true;
    }, 'an open ternary would have spelled jaren_bbox_w(...) for it');
  });

  it('the vector kind is stored everywhere, and has no generated expression to spell', () => {
    assert.strictEqual(DERIVE_MAPPING.vector, 'stored');
    assert.strictEqual(derivedMappingFor('vector', 'virtual'), 'stored');
    assert.strictEqual(derivedMappingFor('vector', 'stored'), 'stored');
    assert.strictEqual(derivedMappingFor('geohash', 'virtual'), 'virtual');
    assert.strictEqual(derivedMappingFor('bbox', 'stored'), 'stored');
    assert.throws(() => derivedMappingFor('quadkey', 'virtual'), /quadkey/);
    assert.throws(() => sqliteDialect.derivedColumn('"doc"', '$."e"', { derive: 'vector', dims: 3 }),
      /stored on every driver/);
  });
});

describe('the vector declaration', () => {
  const refusal = (indexes, member, schema = undefined) => {
    let thrown = null;
    try {
      planCollection('items', normalizeModel(model(indexes, schema)).get('items'), sqliteDialect);
    }
    catch (error) {
      thrown = error;
    }
    assert.ok(thrown !== null, `expected a refusal for ${JSON.stringify(indexes)}`);
    assert.strictEqual(thrown.code, 'JD0004', thrown.message);
    assert.strictEqual(thrown.docPath, member, thrown.message);
    assert.match(thrown.message, /by_vec|by_cell|by_box|by_name/, 'the message names the index');
    return thrown;
  };
  const at = (member) => `/collections/items/indexes/0/${member}`;

  it('refuses a vector index with no dims — the width is the identity of the column', () => {
    const error = refusal([{ name: 'by_vec', path: '$.embedding', derive: 'vector' }], at('dims'));
    assert.match(error.message, new RegExp(`${DIMS_MIN}\\.\\.${DIMS_MAX}`));
    assert.match(error.message, /different models/);
  });

  it('refuses dims outside 1..8192, a non-integer one, and a string', () => {
    for (const dims of [0, DIMS_MAX + 1, 1.5, '3', null, -1]) {
      const error = refusal([{ name: 'by_vec', path: '$.embedding', derive: 'vector', dims }],
        at('dims'));
      assert.match(error.message, /integer 1\.\.8192/);
    }
  });

  it('refuses dims on a geohash, a bbox, and an undecorated index', () => {
    refusal([{ name: 'by_cell', path: '$.at', derive: 'geohash', precision: 7, dims: 3 }],
      at('dims'));
    refusal([{ name: 'by_box', path: '$.meta', derive: 'bbox', dims: 3 }], at('dims'));
    refusal([{ name: 'by_name', path: '$.name', dims: 3 }], at('dims'));
  });

  it('refuses precision and physical beside a vector index', () => {
    refusal([{ name: 'by_vec', path: '$.embedding', derive: 'vector', dims: 3, precision: 7 }],
      at('precision'));
    const error = refusal(
      [{ name: 'by_vec', path: '$.embedding', derive: 'vector', dims: 3, physical: 'rtree' }],
      at('physical'));
    assert.match(error.message, /one shape on disk/);
  });

  it('refuses unique and a composite path, as every derived index does', () => {
    const error = refusal(
      [{ name: 'by_vec', path: '$.embedding', derive: 'vector', dims: 3, unique: true }],
      at('unique'));
    assert.match(error.message, /never unique/);
    refusal([{ name: 'by_vec', path: ['$.embedding', '$.at'], derive: 'vector', dims: 3 }],
      at('path'));
  });

  it("the closed set names 'vector' now", () => {
    const error = refusal([{ name: 'by_vec', path: '$.embedding', derive: 'embedding', dims: 3 }],
      at('derive'));
    assert.match(error.message, /'geohash', 'bbox' or 'vector'/);
  });

  it("refuses a member the schema does not type 'array' and nothing else", () => {
    const vec = (p) => [{ name: 'by_vec', path: p, derive: 'vector', dims: 3 }];
    assert.match(refusal(vec('$.name'), at('derive')).message, /typed 'string'/);
    assert.match(refusal(vec('$.meta'), at('derive')).message, /typed "object"/);
    assert.match(refusal(vec('$.loose'), at('derive')).message, /not typed/);
    assert.match(refusal(vec('$.mixed'), at('derive')).message, /\["array","null"\]/);
    assert.match(refusal(vec('$.nowhere'), at('derive')).message, /not typed/);
    const error = refusal(vec('$.mixed'), at('derive'));
    assert.match(error.message, /minItems\/maxItems equal to dims/,
      'the refusal says how to declare the member');
  });

  it("accepts type: 'array' and type: ['array'] alike", () => {
    for (const p of ['$.embedding', '$.listed']) {
      const plan = planCollection('items', normalizeModel(model([
        { name: 'by_vec', path: p, derive: 'vector', dims: 3 },
      ])).get('items'), sqliteDialect);
      assert.strictEqual(plan.generated.length, 1);
    }
  });
});

describe('the physical mapping — one shape on every driver', () => {
  const planned = (mapping, document = VECTOR) => planCollection('items',
    normalizeModel(document).get('items'), sqliteDialect,
    mapping === undefined ? undefined : { derived: mapping });

  it('one stored BLOB column, no B-tree, identical under both driver mappings', () => {
    const CREATE = 'CREATE TABLE "items" ('
      + '"key" TEXT PRIMARY KEY, '
      + '"doc" BLOB NOT NULL, '
      + `"${COLUMN}" BLOB`
      + ') STRICT';
    assert.deepStrictEqual(planned().createSql, [CREATE],
      'no CREATE INDEX: nothing seeks a blob of floats');
    assert.deepStrictEqual(planned('stored').createSql, [CREATE]);
    assert.deepStrictEqual(planned('virtual').createSql, [CREATE]);
    for (const mapping of [undefined, 'stored']) {
      const plan = planned(mapping);
      assert.deepStrictEqual(plan.expected.columns, [
        { name: 'key', type: 'TEXT', generated: false },
        { name: 'doc', type: 'BLOB', generated: false },
        { name: COLUMN, type: 'BLOB', generated: false },
      ]);
      assert.deepStrictEqual(plan.expected.indexes, [], 'a vector derive is a column, not an index');
      assert.deepStrictEqual(plan.derived, [
        { name: COLUMN, derive: 'vector', dims: DIMS, segments: [{ name: 'embedding' }] },
      ]);
      assert.strictEqual(plan.generated[0].stored, true);
      assert.strictEqual(plan.generated[0].expression, null);
    }
  });

  it('beside a spatial index, only the spatial column follows the capability branch', () => {
    const both = model([
      { name: 'by_vec', path: '$.embedding', derive: 'vector', dims: DIMS },
      { name: 'by_cell', path: '$.at', derive: 'geohash', precision: 7 },
    ]);
    const virtual = planned(undefined, both);
    assert.match(virtual.createSql[0], /"gx_at_gh7" TEXT GENERATED ALWAYS AS/);
    assert.match(virtual.createSql[0], new RegExp(`"${COLUMN}" BLOB[,)]`));
    assert.deepStrictEqual(virtual.expected.indexes.map((i) => i.name), ['items_by_cell']);
    const stored = planned('stored', both);
    assert.match(stored.createSql[0], /"gx_at_gh7" TEXT[,)]/);
    assert.match(stored.createSql[0], new RegExp(`"${COLUMN}" BLOB[,)]`));
  });

  it('dims is identity: one width shares a column, two widths are two columns', () => {
    const shared = planned(undefined, model([
      { name: 'a', path: '$.embedding', derive: 'vector', dims: 3 },
      { name: 'b', path: '$.embedding', derive: 'vector', dims: 3 },
    ]));
    assert.deepStrictEqual(shared.generated.map((c) => c.name), [COLUMN]);
    const split = planned(undefined, model([
      { name: 'a', path: '$.embedding', derive: 'vector', dims: 3 },
      { name: 'b', path: '$.embedding', derive: 'vector', dims: 4 },
    ]));
    assert.deepStrictEqual(split.generated.map((c) => c.name), [COLUMN, 'gx_embedding_v4']);
  });

  it('a plain index over the same path keeps its own column', () => {
    const plan = planned(undefined, model([
      { name: 'a', path: '$.embedding', derive: 'vector', dims: 3 },
      { name: 'b', path: '$.embedding' },
    ]));
    assert.deepStrictEqual(plan.generated.map((c) => c.name), [COLUMN, 'gx_embedding']);
    assert.deepStrictEqual(plan.expected.indexes.map((i) => i.columns), [['gx_embedding']]);
  });

  it('the dialect owns the spelling: the double says VECBYTES, a dialect without one is refused', () => {
    const double = fullDoubleDialect(createDialect);
    const create = planCollection('items', normalizeModel(VECTOR).get('items'), double).createSql;
    assert.deepStrictEqual(create,
      ['CREATE TABLE [items] ([key] KEYTYPE PRIMARY KEY, [doc] JSONDOC NOT NULL, '
        + `[${COLUMN}] VECBYTES)`]);
    const mute = { ...double, packedVectorType: undefined };
    assert.throws(() => planCollection('items', normalizeModel(VECTOR).get('items'), mute),
      /'double' dialect declares no packedVectorType/);
  });
});

describe('deriveVector — the one seam onto @jarenjs/core/vector', () => {
  it('answers the packed, l2-normalized STORED form of the member', () => {
    assert.deepStrictEqual(deriveVector([3, 4, 0], 3), packVector(l2Normalize([3, 4, 0])));
    assert.deepStrictEqual(unpackVector(deriveVector([3, 4, 0], 3), 3),
      new Float32Array([0.6, 0.8, 0]));
    assert.deepStrictEqual(deriveVector([0, 0, 0], 3), new Uint8Array(12), 'the zero vector is stored');
  });

  it('is a function of what the database holds, not of the object handed in', () => {
    // a typed array is held as an object, a NaN as null — neither is a vector once stored
    assert.strictEqual(deriveVector(new Float32Array([3, 4, 0]), 3), null);
    assert.strictEqual(deriveVector([1, Number.NaN, 0], 3), null);
    assert.strictEqual(deriveVector([1, Number.POSITIVE_INFINITY, 0], 3), null);
    for (const member of [undefined, null, [1, 2], [1, 2, 3, 4], 'text', { 0: 1 }, [[1], [2], [3]]])
      assert.strictEqual(deriveVector(member, 3), null, JSON.stringify(member));
  });
});

describe('the column, written in lockstep with the document', () => {
  for (const [branch, makeDriver] of [['node', nodeDriver], ['bun-shaped (stored)', storedDriver]]) {
    it(`${branch}: insert writes the normalized packed member; the unrankable write NULL`, async () => {
      const temp = await seeded(makeDriver(), VECTOR, async (items) => {
        for (const doc of DOCS) await items.insert(doc);
      });
      try {
        const rows = bareColumn(temp.dbPath);
        for (const key of RANKABLE) {
          const doc = DOCS.find((d) => d.id === key);
          assert.ok(rows[key] instanceof Uint8Array, `'${key}' holds bytes`);
          assert.strictEqual(rows[key].byteLength, 4 * DIMS);
          assert.deepStrictEqual(unpacked(rows[key]), l2Normalize(doc.embedding),
            `'${key}' unpacks to the kernel's normalized form, to Math.fround exactness`);
        }
        for (const key of UNRANKABLE)
          assert.strictEqual(rows[key], null, `'${key}' is NULL — invisible, not wrong`);
      }
      finally { temp.cleanup(); }
    });

    it(`${branch}: every unrankable document itself stores, and reads back as held`, async () => {
      const temp = tempDbPath();
      try {
        const store = await openStore(VECTOR, { driver: makeDriver(), path: temp.dbPath });
        const items = store.collection('items');
        for (const doc of DOCS) await items.insert(doc);
        assert.deepStrictEqual(await items.get('nan'), { id: 'nan', embedding: [1, null, 3] },
          'JSON has no NaN: the document holds null, and the column saw null');
        assert.deepStrictEqual(await items.get('text'), { id: 'text', embedding: 'not a vector' },
          'a string at the path stores — the stored column has no jsonb_extract expression to trip');
        assert.deepStrictEqual(await items.get('absent'), { id: 'absent', name: 'nothing here' });
        await store.close();
      }
      finally { temp.cleanup(); }
    });
  }

  it('the two driver shapes store byte-identical columns for the same documents', async () => {
    const columns = [];
    for (const makeDriver of [nodeDriver, storedDriver]) {
      const temp = await seeded(makeDriver(), VECTOR, async (items) => {
        for (const doc of DOCS) await items.insert(doc);
      });
      try { columns.push(bareColumn(temp.dbPath)); }
      finally { temp.cleanup(); }
    }
    assert.deepStrictEqual(columns[0], columns[1]);
  });

  it('a typed array in the document is held as an object, so the column is NULL', async () => {
    const temp = await seeded(nodeDriver(), VECTOR, async (items) => {
      await items.insert({ id: 'typed', embedding: new Float32Array([3, 4, 0]) });
    });
    try {
      assert.strictEqual(bareColumn(temp.dbPath).typed, null);
      const store = await openStore(VECTOR, { driver: nodeDriver(), path: temp.dbPath });
      assert.deepStrictEqual(await store.collection('items').get('typed'),
        { id: 'typed', embedding: { 0: 3, 1: 4, 2: 0 } });
      await store.close();
    }
    finally { temp.cleanup(); }
  });

  it('upsert, a translated patch and the patch fallback each recompute the column', async () => {
    const temp = tempDbPath();
    try {
      const store = await openStore(VECTOR, { driver: nodeDriver(), path: temp.dbPath });
      const items = store.collection('items');
      await items.insert({ id: 'x', embedding: [3, 4, 0] });
      const first = bareColumn(temp.dbPath).x;
      assert.deepStrictEqual(unpacked(first), l2Normalize([3, 4, 0]));

      await items.put({ id: 'x', embedding: [0, 0, 2] });
      assert.deepStrictEqual(unpacked(bareColumn(temp.dbPath).x), new Float32Array([0, 0, 1]),
        'upsert');

      await items.patch('x', [{ op: 'replace', path: '/embedding', value: [1, 1, 1] }]);
      assert.strictEqual(items.stats().patchTranslated, 1);
      assert.deepStrictEqual(unpacked(bareColumn(temp.dbPath).x), l2Normalize([1, 1, 1]),
        'the translated patch');

      await items.patch('x', [{ op: 'replace', path: '/embedding/1', value: 5 }]);
      assert.strictEqual(items.stats().patchTranslated, 2);
      assert.deepStrictEqual(unpacked(bareColumn(temp.dbPath).x), l2Normalize([1, 5, 1]),
        'a component patch, translated');

      await items.patch('x', [
        { op: 'add', path: '/spare', value: [3, 4, 0] },
        { op: 'move', from: '/spare', path: '/embedding' },
      ]);
      assert.strictEqual(items.stats().patchFallback, 1, 'a move takes the whole-document fallback');
      assert.deepStrictEqual(bareColumn(temp.dbPath).x, first, 'the fallback');

      await items.patch('x', [{ op: 'remove', path: '/embedding' }]);
      assert.strictEqual(bareColumn(temp.dbPath).x, null,
        'a document that loses its member leaves the column, never keeps a stale vector');
      await store.close();
    }
    finally { temp.cleanup(); }
  });

  it('writing the same document twice leaves the column byte-identical', async () => {
    const temp = tempDbPath();
    try {
      const store = await openStore(VECTOR, { driver: storedDriver(), path: temp.dbPath });
      await store.collection('items').put({ id: 'x', embedding: [0.1, 0.2, 0.3] });
      const first = bareColumn(temp.dbPath).x;
      await store.collection('items').put({ id: 'x', embedding: [0.1, 0.2, 0.3] });
      await store.close();
      assert.deepStrictEqual(bareColumn(temp.dbPath).x, first);
    }
    finally { temp.cleanup(); }
  });

  it('the schema, not the column, refuses a wrong-width vector when the author constrains it', async () => {
    // MODEL-FORMAT's guidance made real: dims on the index, minItems and
    // maxItems on the member — a wrong width is then JD2003 at the
    // write, instead of a valid document that is merely unrankable
    const constrained = model([{ name: 'by_vec', path: '$.embedding', derive: 'vector', dims: DIMS }], {
      type: 'object',
      properties: {
        id: { type: 'string' },
        embedding: { type: 'array', items: { type: 'number' }, minItems: DIMS, maxItems: DIMS },
      },
    });
    const validator = new JarenValidator({ collectErrors: true, skipErrors: false });
    const temp = tempDbPath();
    try {
      const store = await openStore(constrained, {
        driver: nodeDriver(), path: temp.dbPath,
        compileSchema: (schema) => validator.compile(schema),
      });
      const items = store.collection('items');
      await assert.rejects(items.insert({ id: 'short', embedding: [1, 2] }),
        (error) => error.code === 'JD2003');
      await items.insert({ id: 'ok', embedding: [1, 2, 3] });
      await store.close();
      assert.deepStrictEqual(Object.keys(bareColumn(temp.dbPath)), ['ok']);
    }
    finally { temp.cleanup(); }
  });
});

describe('no function is registered for the kind', () => {
  it('a vector-only model registers nothing on the node driver', async () => {
    const recording = functionRecordingDriver(nodeDriver());
    const temp = await seeded(recording.driver, VECTOR, async (items) => {
      await items.insert(DOCS[0]);
    });
    try {
      assert.deepStrictEqual(recording.registered, []);
      // and a fresh connection that registered nothing reads the table
      assert.deepStrictEqual(unpacked(bareColumn(temp.dbPath).a), l2Normalize([3, 4, 0]));
    }
    finally { temp.cleanup(); }
  });

  it('beside a spatial index only the spatial functions are registered, none named for vectors', async () => {
    const recording = functionRecordingDriver(nodeDriver());
    const both = model([
      { name: 'by_vec', path: '$.embedding', derive: 'vector', dims: DIMS },
      { name: 'by_cell', path: '$.at', derive: 'geohash', precision: 7 },
    ]);
    const temp = await seeded(recording.driver, both, async (items) => {
      await items.insert({ id: 'a', embedding: [3, 4, 0], at: [4.9, 52.3] });
    });
    try {
      assert.ok(recording.registered.includes('jaren_geohash'));
      assert.deepStrictEqual(recording.registered.filter((name) => /vec/i.test(name)), []);
    }
    finally { temp.cleanup(); }
  });
});

describe('the two-run check', () => {
  for (const [branch, makeDriver] of [['node', nodeDriver], ['bun-shaped (stored)', storedDriver]]) {
    it(`${branch}: a second open over the same file runs no DDL and reports no difference`,
      async () => {
        const temp = tempDbPath();
        try {
          const isDdl = (sql) => /^\s*(CREATE|ALTER|DROP)\b/i.test(sql);
          const first = recordingDriver(makeDriver());
          const store = await openStore(VECTOR, { driver: first.driver, path: temp.dbPath });
          await store.collection('items').insert(DOCS[0]);
          await store.close();
          assert.ok(first.executed.some(isDdl), 'the first open creates the shape');

          const second = recordingDriver(makeDriver());
          const reopened = await openStore(VECTOR, { driver: second.driver, path: temp.dbPath });
          assert.deepStrictEqual(await reopened.collection('items').get('a'), DOCS[0]);
          await reopened.close();
          assert.deepStrictEqual(second.executed.filter(isDdl), [],
            'the second open verifies and alters nothing');
        }
        finally { temp.cleanup(); }
      });
  }

  it('a file created under one driver opens under the other: one mapping, no drift', async () => {
    const temp = await seeded(nodeDriver(), VECTOR, async (items) => {
      await items.insert(DOCS[0]);
    });
    try {
      const store = await openStore(VECTOR, { driver: storedDriver(), path: temp.dbPath });
      await store.collection('items').insert(DOCS[1]);
      await store.close();
      const rows = bareColumn(temp.dbPath);
      assert.deepStrictEqual(unpacked(rows.a), l2Normalize([3, 4, 0]));
      assert.deepStrictEqual(unpacked(rows.b), l2Normalize([1, 1, 1]));
    }
    finally { temp.cleanup(); }
  });

  it('a column a foreign tool dropped, or renamed, is JD0002 naming it', async () => {
    for (const alteration of [
      `ALTER TABLE "items" DROP COLUMN "${COLUMN}"`,
      `ALTER TABLE "items" RENAME COLUMN "${COLUMN}" TO "gx_something_else"`,
    ]) {
      const temp = await seeded(nodeDriver(), VECTOR, async (items) => {
        await items.insert(DOCS[0]);
      });
      try {
        const db = new DatabaseSync(temp.dbPath);
        db.exec(alteration);
        db.close();
        await assert.rejects(openStore(VECTOR, { driver: nodeDriver(), path: temp.dbPath }),
          (error) => {
            assert.strictEqual(error.code, 'JD0002');
            assert.match(error.message, new RegExp(COLUMN), alteration);
            return true;
          });
      }
      finally { temp.cleanup(); }
    }
  });
});

describe('migrating a vector column', () => {
  const BEFORE = model([{ name: 'by_name', path: '$.name' }]);
  const migrationSchema = JSON.parse(
    fs.readFileSync('packages/db/schemas/jaren-migration.schema.json', 'utf8'));
  const validateMigration = compileArtifact(migrationSchema);

  for (const [branch, makeDriver, mapping] of [
    ['node', nodeDriver, undefined], ['bun-shaped (stored)', storedDriver, 'stored'],
  ]) {
    it(`${branch}: adding the column backfills it, and a replay is a no-op`, async () => {
      const temp = tempDbPath();
      try {
        const store = await openStore(BEFORE, { driver: makeDriver(), path: temp.dbPath });
        for (const doc of DOCS) await store.collection('items').insert(doc);
        await store.close();

        const { migration } = planMigration(BEFORE, VECTOR,
          { dialect: sqliteDialect, derived: mapping, id: '0001-vector' });
        assert.strictEqual(validateMigration(migration), true,
          'the derive step with dims validates against the migration artifact');
        assert.ok(migration.steps.some((step) => step.kind === 'ddl'
          && step.sql === `ALTER TABLE "items" ADD COLUMN "${COLUMN}" BLOB`));
        const backfill = migration.steps.filter((step) => step.kind === 'derive');
        assert.deepStrictEqual(backfill.map((step) => step.columns), [[
          { name: COLUMN, derive: 'vector', dims: DIMS, segments: [{ name: 'embedding' }] },
        ]], 'stored under BOTH mappings, so the backfill is planned under both');
        assert.ok(!migration.steps.some((step) => /CREATE INDEX/.test(step.sql ?? '')),
          'no B-tree arrives with the column');

        const applied = await migrate({ driver: makeDriver(), path: temp.dbPath }, [migration],
          { baseline: BEFORE, model: VECTOR });
        assert.deepStrictEqual(applied.applied, ['0001-vector']);
        const rows = bareColumn(temp.dbPath);
        for (const key of RANKABLE) {
          const doc = DOCS.find((d) => d.id === key);
          assert.deepStrictEqual(unpacked(rows[key]), l2Normalize(doc.embedding),
            `'${key}' is backfilled through the same seam the write path uses`);
        }
        for (const key of UNRANKABLE) assert.strictEqual(rows[key], null, key);

        const again = await migrate({ driver: makeDriver(), path: temp.dbPath }, [migration],
          { baseline: BEFORE, model: VECTOR });
        assert.deepStrictEqual(again.applied, [], 'applying twice is a no-op');
        assert.deepStrictEqual(bareColumn(temp.dbPath), rows);

        // and the migrated file is what a fresh open expects: zero DDL
        const reopen = recordingDriver(makeDriver());
        const reopened = await openStore(VECTOR, { driver: reopen.driver, path: temp.dbPath });
        await reopened.close();
        assert.deepStrictEqual(
          reopen.executed.filter((sql) => /^\s*(CREATE|ALTER|DROP)\b/i.test(sql)), []);
      }
      finally { temp.cleanup(); }
    });
  }

  it('changing dims is a different column, not the same one altered', () => {
    const wider = model([{ name: 'by_vec', path: '$.embedding', derive: 'vector', dims: 4 }]);
    const sqls = planMigration(VECTOR, wider, { dialect: sqliteDialect })
      .migration.steps.map((step) => step.sql);
    assert.ok(sqls.includes(`ALTER TABLE "items" DROP COLUMN "${COLUMN}"`));
    assert.ok(sqls.includes('ALTER TABLE "items" ADD COLUMN "gx_embedding_v4" BLOB'));
  });

  it('dropping the index drops the column, and there is no index to drop', () => {
    const { migration } = planMigration(VECTOR, BEFORE, { dialect: sqliteDialect });
    const sqls = migration.steps.map((step) => step.sql);
    assert.ok(sqls.includes(`ALTER TABLE "items" DROP COLUMN "${COLUMN}"`));
    assert.ok(!sqls.some((sql) => /DROP INDEX "items_by_vec"/.test(sql ?? '')));
  });
});

describe('one home for vector arithmetic (D2), one home for SQL text (D12)', () => {
  const root = 'packages/db/src';
  /** @param {string} dir @returns {string[]} */
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory()
      ? walk(path.join(dir, entry.name))
      : [path.join(dir, entry.name)]));
  const files = walk(root).filter((file) => file.endsWith('.js'));
  const posix = (file) => file.split(path.sep).join('/');

  it('no file in packages/db normalizes, packs or multiplies a vector of its own', () => {
    // code, not prose: a normalization is a square root, a packing is a
    // Float32Array or a Float32 view write
    const forbidden = /Math\.(sqrt|hypot)\(|new Float32Array\(|\.(set|get)Float32\(/;
    const offenders = files.filter((file) => forbidden.test(fs.readFileSync(file, 'utf8')));
    assert.deepStrictEqual(offenders, [],
      'every normalization and every packing comes from @jarenjs/core/vector');
    const importers = files.filter((file) =>
      /from '@jarenjs\/core\/vector'/.test(fs.readFileSync(file, 'utf8')));
    assert.deepStrictEqual(importers.map(posix), ['packages/db/src/derive.js'],
      'and exactly one file in this package reaches for it');
  });

  it('the BLOB spelling lives in the dialects and nowhere else', () => {
    const spellers = files.filter((file) => /\bBLOB\b/.test(fs.readFileSync(file, 'utf8')));
    assert.ok(spellers.length > 0);
    assert.deepStrictEqual(spellers.map(posix).filter((file) => !file.startsWith(`${root}/dialects/`)),
      []);
  });

  it('the k-nearest statement spells no row identity of its own', () => {
    // the plan projects (row identity, packed column) and then fetches
    // the winners BY identity: two statements whose every dialect-
    // specific token has to come from the spec, or a second spelling of
    // the seam would have to re-derive them
    const outside = files.filter((file) => !posix(file).startsWith(`${root}/dialects/`));
    const spelled = outside.filter((file) => /"rowid"/.test(fs.readFileSync(file, 'utf8')));
    assert.deepStrictEqual(spelled.map(posix), [],
      'row identity is spelled by the dialect; a caller asks for it');
    const emit = fs.readFileSync(path.join(root, 'emit.js'), 'utf8');
    assert.match(emit, /dialect\.rowIdentity\(\)/,
      'the candidate projection no longer asks the dialect for row identity');
    const query = fs.readFileSync(path.join(root, 'query.js'), 'utf8');
    assert.match(query, /dialect\.dml\.selectByIdentities/,
      'the winners fetch no longer goes through the dialect\'s composed statement');
  });
});

describe('one home for vector arithmetic, across every package (D2)', () => {
  // the db gate above proves it for one package; a second dot product
  // anywhere in the suite is the drift the rule exists to prevent, and
  // the packages that could grow one are the four that consume vectors
  const KERNELS = ['isVector', 'dotProduct', 'cosineSimilarity', 'euclideanSimilarity',
    'l2Normalize', 'packVector', 'unpackVector'];
  const HOME = 'packages/core/src/vector/index.js';

  /** @param {string} dir @returns {string[]} */
  const walk = (dir) => (fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory()
      ? walk(path.join(dir, entry.name))
      : [path.join(dir, entry.name)]))
    : []);
  const posix = (file) => file.split(path.sep).join('/');
  /**
   * A file's CODE: comments stripped, so a kernel named in a docblock
   * (which is documentation doing its job) is not read as a second
   * implementation.
   * @param {string} file @returns {string}
   */
  const code = (file) => fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const sources = ['packages', 'components']
    .flatMap((group) => (fs.existsSync(group)
      ? fs.readdirSync(group).map((name) => path.join(group, name, 'src'))
      : []))
    .flatMap(walk)
    .filter((file) => file.endsWith('.js'));

  it('every kernel is declared exactly once, in core', () => {
    assert.ok(sources.length > 0, 'no package sources were read');
    for (const kernel of KERNELS) {
      const declared = sources.filter((file) =>
        new RegExp(`(?:export )?(?:function|const|let|var) ${kernel}\\b`).test(code(file)));
      assert.deepStrictEqual(declared.map(posix), [HOME],
        `${kernel} is declared somewhere other than the suite's one home`);
    }
  });

  it('every consumer imports them, and none computes one of its own', () => {
    const consumers = sources
      .filter((file) => posix(file) !== HOME)
      .filter((file) => KERNELS.some((k) => new RegExp(`\\b${k}\\b`).test(code(file))));
    assert.ok(consumers.length > 0, 'nothing consumes the kernels — the gate would be vacuous');
    for (const file of consumers) {
      assert.match(code(file), /from '@jarenjs\/core\/vector'/,
        `${posix(file)} names a vector kernel without importing it from core`);
    }
    // and nobody writes the arithmetic by hand: an accumulation of
    // `a[i] * b[i]` is a dot product whatever it is called
    const handRolled = sources
      .filter((file) => posix(file) !== HOME)
      .filter((file) => /\+=\s*[A-Za-z_$][\w$]*\[\w+\]\s*\*\s*[A-Za-z_$][\w$]*\[\w+\]/
        .test(code(file)));
    assert.deepStrictEqual(handRolled.map(posix), [],
      'a second dot product exists — collapse it onto @jarenjs/core/vector');
  });
});
