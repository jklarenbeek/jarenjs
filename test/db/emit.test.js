//@ts-check
/**
 * @file The emitter: golden SQL for the truth-table forms through the
 * SQLite dialect, the SAME plans through the full test-double dialect
 * (correspondingly different text — the dialect proof at the query layer),
 * and the injection-impossibility proof: a hostile literal value never
 * appears in the SQL text, only in the ordered parameter slots.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  planQuery, emitPlan, normalizeModel, planCollection,
  sqliteDialect, createDialect, createEntityPredicateEmitters,
} from '@jarenjs/db';
import { postgresDialect } from '@jarenjs/db/postgres';
import { fullDoubleDialect } from './helpers.js';

const MODEL = {
  $model: '0.1',
  collections: {
    users: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' }, name: { type: 'string' },
          age: { type: 'integer' }, active: { type: 'boolean' },
        },
      },
      key: '/id',
      indexes: [{ name: 'by_age', path: '$.age' }],
    },
  },
};
const users = normalizeModel(MODEL).get('users');
const physical = planCollection('users', users, sqliteDialect);
const SHAPE = {
  collection: 'users', schema: users.schema,
  columnByCanonical: physical.columnByCanonical,
};
const PHYSICAL = { table: 'users', keyColumn: 'key', docColumn: 'doc' };
const doubled = fullDoubleDialect(createDialect);

const emitFor = (document, dialect) =>
  emitPlan(planQuery(document, SHAPE).plan, dialect, PHYSICAL);

describe('golden SQL (the truth-table forms)', () => {
  it('a guarded numeric comparison over the generated column, with the identity tiebreaker', () => {
    const { sql, slots } = emitFor(
      { $for: { it: '$[*]' }, $where: { $gt: ['$it.age', 21] }, $return: '$it' },
      sqliteDialect);
    assert.strictEqual(sql,
      'SELECT json("doc") AS "doc" FROM "users" '
      + 'WHERE (json_type("doc", \'$."age"\') IS NOT NULL '
      + 'AND json_type("doc", \'$."age"\') IN (\'integer\', \'real\') '
      + 'AND "gx_age" > ?) '
      + 'ORDER BY "rowid"');
    assert.deepStrictEqual(slots, [{ literal: 21 }]);
  });

  it('ne is present-and-differs; null/boolean literals are type tests; empties order', () => {
    const { sql } = emitFor({
      $for: { it: '$[*]' },
      $where: { $and: [
        { $ne: ['$it.name', 'ada'] },
        { $eq: ['$it.nick', null] },
        { $eq: ['$it.active', false] },
        { $empty: '$it.gone' },
      ] },
      $orderby: [{ $key: '$it.name', $empty: 'greatest' }],
      $return: '$it',
    }, sqliteDialect);
    assert.match(sql,
      /IS NOT NULL AND \(json_type\("doc", '\$\."name"'\) <> 'text' OR jsonb_extract\("doc", '\$\."name"'\) <> \?\)/);
    assert.match(sql, /json_type\("doc", '\$\."nick"'\) = 'null'/);
    assert.match(sql, /json_type\("doc", '\$\."active"'\) = 'false'/);
    assert.match(sql, /json_type\("doc", '\$\."gone"'\) IS NULL/);
    assert.match(sql, /ORDER BY jsonb_extract\("doc", '\$\."name"'\) ASC NULLS LAST, "rowid"/);
  });

  it('externals bind twice per branch with typeof guards; windows become limits', () => {
    const { sql, slots } = emitFor({
      $subsequence: [
        { $for: { it: '$[*]' }, $where: { $ge: ['$it.age', '$min'] }, $return: '$it' },
        2, 5,
      ],
    }, sqliteDialect);
    assert.match(sql, /typeof\(\?\) = 'text'/);
    assert.match(sql, /typeof\(\?\) IN \('integer', 'real'\)/);
    assert.match(sql, /LIMIT 5 OFFSET 2$/);
    assert.deepStrictEqual(slots, [
      { external: 'min' }, { external: 'min' },
      { external: 'min' }, { external: 'min' },
    ]);
  });

  it('string operators spell a prefix range, substr and instr', () => {
    const { sql, slots } = emitFor({
      $for: { it: '$[*]' },
      $where: { $and: [
        { '$starts-with': ['$it.name', 'a'] },
        { '$ends-with': ['$it.name', 'z'] },
        { $contains: ['$it.name', 'mid'] },
      ] },
      $return: '$it',
    }, sqliteDialect);
    assert.match(sql, /\(jsonb_extract\("doc", '\$\."name"'\) >= \? AND jsonb_extract\("doc", '\$\."name"'\) < \?\)/);
    // a suffix compares bytes, which a U+0000 does not cut short
    assert.match(sql, /\(length\(CAST\(\? AS BLOB\)\) = 0 OR substr\(CAST\(jsonb_extract\("doc", '\$\."name"'\) AS BLOB\), -length\(CAST\(\? AS BLOB\)\)\) IS CAST\(\? AS BLOB\)\)/);
    assert.match(sql, /instr\(jsonb_extract\("doc", '\$\."name"'\), \?\) > 0/);
    assert.strictEqual(slots.length, 6, 'starts:2 + ends:3 + contains:1');
    assert.deepStrictEqual(slots[0], { literal: 'a' }, 'the prefix is the lower bound');
    assert.deepStrictEqual(slots[1], { literal: 'b' }, 'and its successor the upper one');
  });

  // the one prefix with no expressible upper bound: nothing sorts above
  // U+10FFFF, so there is no range to seek and the scannable form —
  // correct, merely slow — is what the emitter falls back to
  it('a prefix with no successor keeps the exact form', () => {
    const { sql, slots } = emitFor({
      $for: { it: '$[*]' },
      $where: { '$starts-with': ['$it.name', '\u{10FFFF}'] },
      $return: '$it',
    }, sqliteDialect);
    assert.match(sql, /substr\(jsonb_extract\("doc", '\$\."name"'\), 1, length\(\?\)\) = \?/);
    assert.deepStrictEqual(slots, [{ literal: '\u{10FFFF}' }, { literal: '\u{10FFFF}' }]);
  });

  it('aggregates select the value column; count needs no ref', () => {
    const count = emitFor(
      { $count: { $for: { it: '$[*]' }, $return: '$it' } }, sqliteDialect);
    assert.strictEqual(count.sql, 'SELECT COUNT(*) AS "value" FROM "users"');
    // an integer sum folds as a double beside its exactness guard: every
    // partial sum is exact while the largest magnitude times the count
    // fits 2^53 - 1, and a term past that bound is left out of the fold,
    // so no accumulator — integer or double — can overflow first
    const sum = emitFor(
      { $sum: { $for: { it: '$[*]' }, $return: '$it.age' } }, sqliteDialect);
    assert.strictEqual(sum.sql, 'SELECT SUM(CAST(CASE WHEN "gx_age" BETWEEN -9007199254740991 AND 9007199254740991 '
      + 'THEN "gx_age" END AS REAL)) AS "value", (COUNT("gx_age") = 0 OR '
      + 'MAX(ABS(CAST("gx_age" AS REAL))) <= 9007199254740991 / COUNT("gx_age")) AS "_safe" FROM "users"');
    const max = emitFor(
      { $max: { $for: { it: '$[*]' }, $return: '$it.age' } }, sqliteDialect);
    assert.strictEqual(max.sql, 'SELECT CAST(MAX("gx_age") AS REAL) AS "value" FROM "users"');
  });
});

describe('the dialect proof, repeated at the query layer', () => {
  const DOCS = [
    { $for: { it: '$[*]' }, $where: { $gt: ['$it.age', 21] }, $return: '$it' },
    { $for: { it: '$[*]' }, $where: { '$starts-with': ['$it.name', 'a'] }, $return: '$it' },
    { $subsequence: [{ $for: { it: '$[*]' }, $orderby: ['$it.name'], $return: '$it' }, 1, 2] },
    { $count: { $for: { it: '$[*]' }, $return: '$it' } },
  ];

  it('the same plans render correspondingly different SQL through the double', () => {
    for (const document of DOCS) {
      const viaSqlite = emitFor(document, sqliteDialect).sql;
      const viaDouble = emitFor(document, doubled).sql;
      assert.notStrictEqual(viaDouble, viaSqlite);
      assert.match(viaDouble, /\[users\]/, 'bracket quoting');
      assert.strictEqual(viaDouble.includes('json_type('), false, 'no SQLite spelling leaks');
      assert.strictEqual(viaDouble.includes('"doc"'), false);
    }
    const doubledText = emitFor(DOCS[0], doubled).sql;
    assert.match(doubledText, /JTYPE\(\[doc\], '\/age'\)/);
    assert.match(doubledText, /@p1/, 'named parameter style');
    assert.match(doubledText, /\[rid\]$/, 'the double spells its own row identity');
  });
});

describe('the spatial forms (over derived columns)', () => {
  const PLACES_MODEL = {
    $model: '0.1',
    collections: {
      places: {
        schema: {
          type: 'object',
          properties: { id: { type: 'string' }, at: { type: ['array', 'object'] } },
        },
        key: '/id',
        indexes: [
          { name: 'by_box', path: '$.at', derive: 'bbox' },
          { name: 'by_cell', path: '$.at', derive: 'geohash', precision: 6 },
        ],
      },
    },
  };
  const places = normalizeModel(PLACES_MODEL).get('places');
  const placesPhysical = planCollection('places', places, sqliteDialect);
  const PLACES_SHAPE = {
    collection: 'places', schema: places.schema,
    columnByCanonical: placesPhysical.columnByCanonical,
  };
  const emitPlaces = (document, dialect) => {
    const planned = planQuery(document, PLACES_SHAPE);
    return emitPlan(planned.plan, dialect,
      { table: 'places', keyColumn: 'key', docColumn: 'doc' });
  };
  const where = (predicate) =>
    ({ $for: { it: '$[*]' }, $where: predicate, $return: '$it' });
  const REGION = {
    type: 'Polygon',
    coordinates: [[[4, 52], [5, 52], [5, 53], [4, 53], [4, 52]]],
  };

  it('a box overlap reads only the derived columns, in index order, with no json_type', () => {
    const { sql, slots } = emitPlaces(
      where({ '$bbox-intersects': ['$it.at', REGION] }), sqliteDialect);
    assert.match(sql, /WHERE \("gx_at_bbox_w" IS NOT NULL AND "gx_at_bbox_w" <= \? /);
    assert.match(sql,
      /"gx_at_bbox_e" >= \? AND "gx_at_bbox_s" <= \? AND "gx_at_bbox_n" >= \?\)/);
    assert.strictEqual(sql.includes('json_type('), false,
      'a derived column IS the value; there is nothing to discriminate');
    // the probe binds in the statement's TEXT order, not the box's:
    // east, west, north, south — a positional dialect numbers by text
    assert.deepStrictEqual(slots.map((slot) => slot.literal), [5, 4, 53, 52]);
  });

  it('an external region binds four DERIVED slots naming the axis each computes', () => {
    const { slots } = emitPlaces(where({ $within: ['$it.at', '$region'] }), sqliteDialect);
    assert.deepStrictEqual(slots, [
      { derived: { kind: 'bboxAxis', external: 'region', axis: 'e' } },
      { derived: { kind: 'bboxAxis', external: 'region', axis: 'w' } },
      { derived: { kind: 'bboxAxis', external: 'region', axis: 'n' } },
      { derived: { kind: 'bboxAxis', external: 'region', axis: 's' } },
    ]);
  });

  it('a whole cell is a membership test and a shorter one a half-open range', () => {
    const whole = emitPlaces(
      where({ $exists: { '$index-of': [
        { '$geohash-neighbours': 'u173zc' }, { $geohash: ['$it.at', 6] }] } }), sqliteDialect);
    // the nine cells are ONE bound list: the IN-list emission every
    // membership shares, whatever the neighbourhood's size
    assert.match(whole.sql, new RegExp('WHERE \\("gx_at_gh6" IS NULL OR "gx_at_gh6" IN '
      + "\\(SELECT value FROM json_each\\(\\?\\) WHERE key IS NOT NULL AND type = 'text'\\)\\)"));
    assert.strictEqual(whole.slots.length, 1);
    assert.strictEqual(JSON.parse(/** @type {any} */ (whole.slots[0]).literal).length, 9);

    const prefix = emitPlaces(
      where({ '$starts-with': [{ $geohash: ['$it.at', 6] }, 'u17'] }), sqliteDialect);
    assert.match(prefix.sql,
      /WHERE \("gx_at_gh6" IS NOT NULL AND \("gx_at_gh6" >= \? AND "gx_at_gh6" < \?\)\)/);
    assert.deepStrictEqual(prefix.slots.map((slot) => slot.literal), ['u17', 'u18']);
  });

  it('the same spatial plans render through the double dialect', () => {
    for (const document of [
      where({ '$bbox-intersects': ['$it.at', REGION] }),
      where({ '$starts-with': [{ $geohash: ['$it.at', 6] }, 'u17'] }),
    ]) {
      const viaDouble = emitPlaces(document, doubled).sql;
      assert.notStrictEqual(viaDouble, emitPlaces(document, sqliteDialect).sql);
      assert.match(viaDouble, /\[gx_at_/, 'bracket quoting reaches the derived columns');
      assert.match(viaDouble, /@p1/, 'named parameter style');
    }
  });
});

describe('the interval form, and the seek that binds a typed scalar', () => {
  const plan = (filter, seeks = []) => ({
    planVersion: 2, alg: 'select', collection: 'users', filter,
    order: null, window: null, rank: null, bucket: null, group: null,
    seeks, aggregate: null, project: 'document',
  });
  const emit = (value) => emitPlan(value, sqliteDialect, PHYSICAL);
  const at = { segments: [{ name: 'at' }], type: 'integer', column: 'gx_at' };

  it('an interval reads the two declared columns and keeps the rows §8.16 raises on', () => {
    const { sql, slots } = emit(plan({ p: 'interval',
      columns: { start: 'gx_s', end: 'gx_e' }, probe: { from: 200, to: 300 } }));
    assert.match(sql, /WHERE \("gx_s" IS NOT NULL AND "gx_e" IS NOT NULL AND /);
    assert.match(sql, /\(\("gx_s" < \? AND "gx_e" > \?\) OR "gx_s" >= "gx_e"\)\)/);
    assert.strictEqual(sql.includes('json_type('), false,
      'the declared bounds ARE the values: no document is read to answer the bound');
    // text order, so the far bound binds first
    assert.deepStrictEqual(slots.map((slot) => slot.literal), [300, 200]);
  });

  it('a declared interval is the two comparisons alone, still total over a row with no span', () => {
    const { sql, slots } = emit(plan({ p: 'interval', declared: true,
      columns: { start: 'gx_s', end: 'gx_e' }, probe: { from: 200, to: 300 } }));
    assert.match(sql, /WHERE \("gx_s" IS NOT NULL AND "gx_e" IS NOT NULL AND "gx_s" < \? AND "gx_e" > \?\)/);
    assert.strictEqual(sql.includes('>='), false, 'no stored span is empty or reversed, so no row is kept for the operator to raise on');
    assert.deepStrictEqual(slots.map((slot) => slot.literal), [300, 200]);
  });

  it('a declared interval with a lower bound on the start seeks it from both sides, the lower bound first', () => {
    const { sql, slots } = emit(plan({ p: 'interval', declared: true, lower: 100,
      columns: { start: 'gx_s', end: 'gx_e' }, probe: { from: 200, to: 300 } }));
    assert.match(sql, /WHERE \("gx_s" IS NOT NULL AND "gx_e" IS NOT NULL AND "gx_s" > \? AND "gx_s" < \? AND "gx_e" > \?\)/);
    assert.strictEqual(sql.includes('>='), false);
    // text order: the two bounds of the start, then the end's
    assert.deepStrictEqual(slots.map((slot) => slot.literal), [100, 300, 200]);
  });

  it('a numeric seek folds the groups and binds ONE total column comparison', () => {
    const seek = { name: 'asof.lower', kind: 'number', ref: at,
      bound: { op: 'le', lit: 1000 }, inner: 'max', outer: 'min',
      group: { segments: [{ name: 'series' }], type: 'string', column: 'gx_series' },
      keys: ['a', 'b'] };
    // the planner binds a seek against the column that answers it
    const emitted = emit(plan(
      { p: 'colCmp', op: 'ge', column: 'gx_at', operand: { seek: 'asof.lower' } }, [seek]));
    // the statement: the column's total form, no text-or-number OR, and a TYPED slot
    assert.match(emitted.sql, /WHERE \("gx_at" IS NOT NULL AND "gx_at" >= \?\)/);
    assert.deepStrictEqual(emitted.slots, [{ typed: { seek: 'asof.lower', type: 'number' } }]);
    // the seek: the least of the groups' own last instants, at or below
    // the earliest probe, over the keys the probes name
    const [first] = emitted.seeks;
    assert.strictEqual(first.name, 'asof.lower');
    assert.strictEqual(first.fallback, 1000);
    assert.match(first.sql,
      /^SELECT MIN\("a"\) AS "anchor" FROM \(SELECT MAX\("gx_at"\) AS "a" FROM "users" WHERE /);
    assert.match(first.sql, /GROUP BY "gx_series"\)$/);
    // the keys are one membership list, however many the probes name
    assert.match(first.sql, /"gx_series" IN \(SELECT value FROM json_each\(\?\) /);
    // its own slots are its own: a positional dialect numbers by the
    // TEXT order of the statement being emitted, and the seek is one
    assert.deepStrictEqual(first.slots.map((slot) => slot.literal), [1000, '["a","b"]']);
    assert.strictEqual(emitted.slots.length, 1);
  });

  it('an ungrouped seek IS the inner fold, and a text seek binds a text slot', () => {
    const stamp = { segments: [{ name: 'stamp' }], type: 'string', column: 'gx_stamp' };
    const seek = { name: 'asof.upper', kind: 'text', ref: stamp,
      bound: { op: 'ge', lit: '2026-01-01T00:00:00Z' }, inner: 'min', outer: 'max',
      group: null, keys: null };
    const emitted = emit(plan(
      { p: 'colCmp', op: 'le', column: 'gx_stamp', operand: { seek: 'asof.upper' } }, [seek]));
    assert.match(emitted.sql, /WHERE \("gx_stamp" IS NOT NULL AND "gx_stamp" <= \?\)/);
    assert.deepStrictEqual(emitted.slots, [{ typed: { seek: 'asof.upper', type: 'text' } }]);
    const [first] = emitted.seeks;
    assert.strictEqual(first.kind, 'text');
    assert.match(first.sql, /^SELECT MIN\("gx_stamp"\) AS "anchor" FROM "users" WHERE /);
    assert.strictEqual(first.sql.includes('GROUP BY'), false);
    assert.deepStrictEqual(first.slots.map((slot) => slot.literal), ['2026-01-01T00:00:00Z']);
  });
});

describe('injection is structurally impossible', () => {
  it('a hostile literal value never reaches the SQL text', () => {
    const hostile = "x'; DROP TABLE users; --";
    const { sql, slots } = emitFor(
      { $for: { it: '$[*]' }, $where: { $eq: ['$it.name', hostile] }, $return: '$it' },
      sqliteDialect);
    assert.strictEqual(sql.includes('DROP TABLE'), false);
    assert.strictEqual(sql.includes(hostile), false);
    assert.deepStrictEqual(slots, [{ literal: hostile }]);
  });

  it('the emitter itself never interpolates an operand (source grep)', async () => {
    const fs = await import('node:fs');
    const source = fs.readFileSync('packages/db/src/emit.js', 'utf8');
    assert.strictEqual(/stringLiteral\([^)]*operand/.test(source), false,
      'no operand value flows into a string literal');
    assert.strictEqual(/\$\{lit\}/.test(source), false,
      'no literal value is templated into SQL text');
  });
});

describe('the entity predicate emitters (direct)', () => {
  const emittersFor = (dialect) => {
    /** @type {any[]} */
    const slots = [];
    const emitters = createEntityPredicateEmitters(dialect,
      (slot) => {
        slots.push(slot);
        return dialect.parameterRef(slots.length, 'v');
      });
    return { emitters, slots };
  };
  const ref = (segments, extra) => ({ segments, ...extra });
  const docRef = ref([{ name: 'profile' }, { name: 'score' }], { flavor: 'entity-doc' });

  it('document forms: guarded numeric compare, ne, type list, string operator', () => {
    const { emitters, slots } = emittersFor(sqliteDialect);
    const alias = '"t"';
    const doc = '"t"."doc"';
    assert.strictEqual(
      emitters.emitPred(alias, doc,
        { p: 'cmp', op: 'ge', ref: docRef, operand: { lit: 5 } }),
      '(json_type("t"."doc", \'$."profile"."score"\') IS NOT NULL'
      + ' AND json_type("t"."doc", \'$."profile"."score"\') IN (\'integer\', \'real\')'
      + ' AND jsonb_extract("t"."doc", \'$."profile"."score"\') >= ?)');
    assert.match(
      emitters.emitPred(alias, doc,
        { p: 'cmp', op: 'ne', ref: docRef, operand: { lit: 'x' } }),
      /<> 'text' OR jsonb_extract/, 'ne stays total: other type OR differing value');
    assert.match(
      emitters.emitPred(alias, doc,
        { p: 'typeIs', positive: true, types: ['integer', 'real'], ref: docRef }),
      /IN \('integer', 'real'\)\)$/);
    assert.match(
      emitters.emitPred(alias, doc,
        { p: 'strop', kind: 'contains', ref: docRef, operand: { lit: 'ab' } }),
      /= 'text' AND instr\(/, 'document string operators keep the text guard');
    assert.deepStrictEqual(slots.map((slot) => slot.literal),
      [5, 'x', 'ab'], 'every operand rides a parameter slot');
  });

  it('column and epoch forms: strop binds, the ±1s range plus the text recheck', () => {
    const { emitters, slots } = emittersFor(sqliteDialect);
    const nameRef = ref([{ name: 'name' }],
      { flavor: 'entity-column', column: 'name', storage: 'string' });
    assert.strictEqual(
      emitters.emitPred('"t"', '"t"."doc"',
        { p: 'strop', kind: 'contains', ref: nameRef, operand: { lit: 'i' } }),
      '("t"."name" IS NOT NULL AND instr("t"."name", ?) > 0)');
    const epochRef = ref([{ name: 'joined' }],
      { flavor: 'entity-epoch', column: 'joined', storage: 'integer', format: 'date-time' });
    assert.strictEqual(
      emitters.emitPred('"t"', '"t"."doc"',
        { p: 'cmp', op: 'ge', ref: epochRef, epoch: 5000,
          operand: { lit: '1970-01-01T00:00:05Z' } }),
      '("t"."joined" IS NOT NULL AND "t"."joined" >= ?'
      + ' AND jsonb_extract("t"."doc", \'$."joined"\') >= ?)');
    assert.deepStrictEqual(slots.map((slot) => slot.literal),
      ['i', 4000, '1970-01-01T00:00:05Z'],
      'the range slot carries the slack; the recheck carries the text');
    // a string operator over an instant path rides the guarded
    // document forms — the integer column cannot answer it
    assert.match(
      emitters.emitPred('"t"', '"t"."doc"',
        { p: 'strop', kind: 'starts', ref: { ...epochRef, flavor: 'entity-epoch' },
          operand: { lit: '2026' } }),
      /json_type/, 'epoch strops are document forms');
  });

  it('the double dialect spells every entity form differently', () => {
    const doubled = fullDoubleDialect(createDialect);
    const forms = [
      { p: 'cmp', op: 'ge', ref: docRef, operand: { lit: 5 } },
      { p: 'strop', kind: 'contains',
        ref: ref([{ name: 'name' }], { flavor: 'entity-column', column: 'name', storage: 'string' }),
        operand: { lit: 'i' } },
      { p: 'cmp', op: 'lt', epoch: 5000,
        ref: ref([{ name: 'joined' }], { flavor: 'entity-epoch', column: 'joined', storage: 'integer' }),
        operand: { lit: '1970-01-01T00:00:05Z' } },
    ];
    for (const form of forms) {
      const viaSqlite = emittersFor(sqliteDialect).emitters
        .emitPred('"t"', '"t"."doc"', structuredClone(form));
      const viaDouble = emittersFor(doubled).emitters
        .emitPred('[t]', '[t].[doc]', structuredClone(form));
      assert.notStrictEqual(viaDouble, viaSqlite);
      assert.match(viaDouble, /\[t\]/);
    }
  });
});

describe('PostgreSQL: a literal comparison reads the typed extraction alone', () => {
  const pg = postgresDialect();
  const ITEMS = {
    $model: '0.1',
    collections: {
      items: {
        schema: { type: 'object', properties: {
          id: { type: 'string' }, sku: { type: 'string' }, n: { type: 'integer' } } },
        key: '/id', indexes: [{ name: 'sku', path: '$.sku' }],
      },
    },
  };
  const items = normalizeModel(ITEMS).get('items');
  const ITEMS_PHYSICAL = { table: 'items', keyColumn: 'key', docColumn: 'doc' };
  /** The WHERE a predicate emits over the items collection through a dialect, and its slots. */
  const whereFor = (predicate, dialect) => {
    const layout = planCollection('items', items, dialect);
    const shape = { collection: 'items', schema: items.schema, columnByCanonical: layout.columnByCanonical };
    const { sql, slots } = emitPlan(
      planQuery({ $for: { it: '$[*]' }, $where: predicate, $return: '$it.id' }, shape).plan,
      dialect, ITEMS_PHYSICAL);
    const where = /\sWHERE (.*) ORDER BY /s.exec(sql);
    assert.ok(where !== null, sql);
    return { where: where[1], slots };
  };
  /** The discriminator `jsonTypeOf` writes on PostgreSQL: a three-call CASE over the document. */
  const discriminators = (text) => (text.match(/THEN 'text' WHEN jsonb_typeof/g) ?? []).length;
  const N = '(CASE WHEN jsonb_typeof(("doc" #> \'{"n"}\')) = \'number\' THEN (("doc" #> \'{"n"}\'))::numeric END)';

  it('an indexed member reads its generated column, an unindexed one its typed CASE, no discriminator beside either', () => {
    assert.strictEqual(pg.typedExtract, true);
    const eq = whereFor({ $eq: ['$it.sku', 's0'] }, pg);
    assert.strictEqual(eq.where, '("gx_sku" IS NOT NULL AND "gx_sku" = $1)');
    assert.deepStrictEqual(eq.slots, [{ literal: 's0' }]);
    const gt = whereFor({ $gt: ['$it.n', 5] }, pg);
    assert.strictEqual(gt.where, `(${N} IS NOT NULL AND ${N} > $1)`);
    assert.strictEqual(discriminators(gt.where), 0);
    // a prefix range and a bound list ride the same column
    assert.strictEqual(whereFor({ '$starts-with': ['$it.sku', 's1'] }, pg).where,
      '("gx_sku" IS NOT NULL AND ("gx_sku" >= $1 AND "gx_sku" < $2))');
    const list = whereFor({ $or: [{ $eq: ['$it.sku', 's0'] }, { $eq: ['$it.sku', 's2'] }] }, pg);
    assert.ok(list.where.startsWith('("gx_sku" IS NOT NULL AND "gx_sku" IN (SELECT '), list.where);
    assert.strictEqual(discriminators(list.where), 0);
    assert.deepStrictEqual(list.slots, [{ literal: '["s0","s2"]' }]);
  });

  it('$ne keeps presence through the member\'s JSON value: a null or another type differs, an absent member does not', () => {
    assert.strictEqual(whereFor({ $ne: ['$it.sku', 's0'] }, pg).where,
      '(("doc" #> \'{"sku"}\') IS NOT NULL AND ("gx_sku" IS NULL OR "gx_sku" <> $1))');
    // a number against the indexed STRING member reads the numeric CASE the
    // column cannot answer: NULL for every stored string, so a present
    // string differs and an absent member does not
    const NS = '(CASE WHEN jsonb_typeof(("doc" #> \'{"sku"}\')) = \'number\' THEN (("doc" #> \'{"sku"}\'))::numeric END)';
    assert.strictEqual(whereFor({ $ne: ['$it.sku', 5] }, pg).where,
      `(("doc" #> '{"sku"}') IS NOT NULL AND (${NS} IS NULL OR ${NS} <> $1))`);
  });

  it('a seek binds its typed slot through the column form the planner builds', () => {
    const at = { segments: [{ name: 'at' }], type: 'integer', column: 'gx_at' };
    const seek = { name: 'asof.lower', kind: 'number', ref: at,
      bound: { op: 'le', lit: 1000 }, inner: 'max', outer: 'min', group: null, keys: null };
    const emitted = emitPlan({
      planVersion: 2, alg: 'select', collection: 'users',
      filter: { p: 'colCmp', op: 'ge', column: 'gx_at', operand: { seek: 'asof.lower' } },
      order: null, window: null, rank: null, bucket: null, group: null,
      seeks: [seek], aggregate: null, project: 'document',
    }, pg, PHYSICAL);
    assert.match(emitted.sql, / WHERE \("gx_at" IS NOT NULL AND "gx_at" >= \$1\) /);
    assert.strictEqual(discriminators(emitted.sql), 0);
    assert.deepStrictEqual(emitted.slots, [{ typed: { seek: 'asof.lower', type: 'number' } }]);
  });

  it('an external operand and a type test keep the discriminator', () => {
    assert.ok(discriminators(whereFor({ $eq: ['$it.sku', '$x'] }, pg).where) >= 2);
    assert.strictEqual(whereFor({ $exists: '$it.sku' }, pg).where,
      `${pg.jsonTypeOf('"doc"', '{"sku"}')} IS NOT NULL`);
  });

  it('SQLite keeps its json_type guards: its extraction is untyped', () => {
    assert.strictEqual(sqliteDialect.typedExtract, false);
    assert.strictEqual(whereFor({ $eq: ['$it.sku', 's0'] }, sqliteDialect).where,
      '(json_type("doc", \'$."sku"\') IS NOT NULL AND json_type("doc", \'$."sku"\') = \'text\' AND "gx_sku" = ?)');
    assert.strictEqual(whereFor({ $gt: ['$it.n', 5] }, sqliteDialect).where,
      '(json_type("doc", \'$."n"\') IS NOT NULL AND json_type("doc", \'$."n"\') IN (\'integer\', \'real\')'
      + ' AND jsonb_extract("doc", \'$."n"\') > ?)');
    assert.strictEqual(whereFor({ $ne: ['$it.sku', 's0'] }, sqliteDialect).where,
      '(json_type("doc", \'$."sku"\') IS NOT NULL AND (json_type("doc", \'$."sku"\') <> \'text\' OR "gx_sku" <> ?))');
  });

  it('an entity document member reads the same typed forms', () => {
    /** @type {any[]} */
    const slots = [];
    const emitters = createEntityPredicateEmitters(pg,
      (slot) => { slots.push(slot); return pg.parameterRef(slots.length, 'v'); });
    const score = { segments: [{ name: 'profile' }, { name: 'score' }], flavor: 'entity-doc' };
    const at = '("t"."doc" #> \'{"profile","score"}\')';
    const NUM = `(CASE WHEN jsonb_typeof(${at}) = 'number' THEN (${at})::numeric END)`;
    const TXT = `((CASE WHEN jsonb_typeof(${at}) = 'string' THEN "t"."doc" #>> '{"profile","score"}' END) COLLATE "C")`;
    const emit = (pred) => emitters.emitPred('"t"', '"t"."doc"', pred);
    assert.strictEqual(emit({ p: 'cmp', op: 'ge', ref: score, operand: { lit: 5 } }),
      `(${NUM} IS NOT NULL AND ${NUM} >= $1)`);
    assert.strictEqual(emit({ p: 'cmp', op: 'ne', ref: score, operand: { lit: 'x' } }),
      `(${at} IS NOT NULL AND (${TXT} IS NULL OR ${TXT} <> $2))`);
    const list = emit({ p: 'in', ref: score, operand: { list: ['a', 1] } });
    assert.ok(list.startsWith(`((${TXT} IS NOT NULL AND ${TXT} IN (SELECT `), list);
    assert.ok(list.includes(`(${NUM} IS NOT NULL AND ${NUM} IN (SELECT `), list);
    assert.strictEqual(discriminators(list), 0);
    assert.strictEqual(emit({ p: 'strop', kind: 'contains', ref: score, operand: { lit: 'ab' } }),
      `(${TXT} IS NOT NULL AND strpos(${TXT}, $5::text) > 0)`);
    assert.ok(discriminators(emit({ p: 'typeIs', positive: true, types: ['text'], ref: score })) >= 2);
    assert.deepStrictEqual(slots.map((slot) => slot.literal), [5, 'x', '["a"]', '[1]', 'ab']);
  });
});

describe('PostgreSQL: an external against an entity column', () => {
  const pg = postgresDialect();
  const column = (/** @type {string} */ storage) => ({ segments: [{ name: 'c' }], flavor: 'entity-column', column: 'c', storage });
  const emit = (/** @type {any} */ ref, /** @type {string} */ op) => {
    /** @type {any[]} */
    const slots = [];
    const emitters = createEntityPredicateEmitters(pg,
      (slot) => { slots.push(slot); return pg.parameterRef(slots.length, 'v'); });
    return { sql: emitters.emitPred('"t"', '"t"."doc"', { p: 'cmp', op, ref, operand: { ext: 'x' } }), slots };
  };
  const json = { external: 'x', json: true };
  const type = (/** @type {number} */ slot) => pg.valueTypeOf(`$${slot}`);
  const numeric = `IN (${pg.numericTypeNames.map(pg.stringLiteral).join(', ')})`;

  it('ne is true for a present value of the external\'s other type, and compares only the external\'s own', () => {
    const text = emit(column('string'), 'ne');
    assert.strictEqual(text.sql, `("t"."c" IS NOT NULL AND (NOT (${type(1)} = 'text') OR "t"."c" <> ${pg.externalRef('$2', 'text')}))`);
    assert.deepStrictEqual(text.slots, [json, json]);
    const number = emit(column('number'), 'ne');
    assert.strictEqual(number.sql, `("t"."c" IS NOT NULL AND (NOT (${type(1)} ${numeric}) OR to_jsonb("t"."c") <> ${pg.externalRef('$2', 'number')}))`);
  });

  it('equality and orderings keep the guarded form: the external must be of the column\'s type', () => {
    for (const [op, symbol] of [['eq', '='], ['lt', '<'], ['ge', '>=']]) {
      assert.strictEqual(emit(column('string'), op).sql,
        `("t"."c" IS NOT NULL AND ${type(1)} = 'text' AND "t"."c" ${symbol} ${pg.externalRef('$2', 'text')})`, op);
      assert.strictEqual(emit(column('number'), op).sql,
        `("t"."c" IS NOT NULL AND ${type(1)} ${numeric} AND to_jsonb("t"."c") ${symbol} ${pg.externalRef('$2', 'number')})`, op);
    }
  });

  it('a boolean column holds neither a string nor a number: nothing equals or orders, every present value differs', () => {
    for (const op of ['eq', 'lt', 'le', 'gt', 'ge']) {
      const { sql, slots } = emit(column('boolean'), op);
      assert.match(sql, /^\("t"\."c" IS NOT NULL AND FALSE AND /, op);
      assert.deepStrictEqual(slots, [json], `${op}: the external keeps its slot, so a boolean one still reaches the engine`);
    }
    const differs = emit(column('boolean'), 'ne');
    assert.match(differs.sql, /^\("t"\."c" IS NOT NULL AND \(NOT \(FALSE\) OR /);
    assert.deepStrictEqual(differs.slots, [json]);
  });
});

describe('PostgreSQL: a statement spelled for the server that types and compiles it', () => {
  const pg = postgresDialect();
  /** @param {any} dialect @param {any} pred */
  const emit = (dialect, pred) => {
    /** @type {any[]} */
    const slots = [];
    const emitters = createEntityPredicateEmitters(dialect, (slot) => { slots.push(slot); return dialect.parameterRef(slots.length, 'v'); });
    return { sql: emitters.emitPred('"t"', '"t"."doc"', pred), slots };
  };
  /** @param {string} name @param {string} storage @param {string} [codec] */
  const column = (name, storage, codec) => ({ segments: [{ name }], flavor: 'entity-column', column: name, storage, codec, nullPolicy: 'reject' });
  const n = column('n', 'integer');
  const s = column('s', 'string');
  /** @param {any} ref @param {unknown} lit */
  const ne = (ref, lit) => ({ p: 'cmp', op: 'ne', ref, operand: { lit } });

  it('two $ne literals on one member are its presence and one negated list, in the first one\'s place; SQLite keeps each', () => {
    const chain = { p: 'and', items: [ne(n, 1), ne(s, 'a'), ne(n, 2)] };
    assert.deepStrictEqual(emit(pg, chain), {
      sql: `(("t"."n" IS NOT NULL AND NOT ("t"."n" IS NOT NULL AND ${pg.inList('"t"."n"', '$1', 'number')})) AND ("t"."s" IS NOT NULL AND "t"."s" <> $2))`,
      slots: [{ literal: '[1,2]' }, { literal: 'a' }],
    });
    assert.deepStrictEqual(emit(sqliteDialect, chain), {
      sql: '(("t"."n" IS NOT NULL AND "t"."n" <> ?) AND ("t"."s" IS NOT NULL AND "t"."s" <> ?) AND ("t"."n" IS NOT NULL AND "t"."n" <> ?))',
      slots: [{ literal: 1 }, { literal: 'a' }, { literal: 2 }],
    });
  });

  it('an integer-codec column takes a literal past smallint as a bigint parameter, and one within it as itself', () => {
    const q = column('q', 'integer', 'integer');
    const lt = (/** @type {any} */ dialect, /** @type {number} */ lit) => emit(dialect, { p: 'cmp', op: 'lt', ref: q, operand: { lit } }).sql;
    for (const lit of [3000000000, 32768, -32769]) assert.strictEqual(lt(pg, lit), '("t"."q" IS NOT NULL AND "t"."q" < ($1)::bigint)', String(lit));
    for (const lit of [30000, 32767, -32768]) assert.strictEqual(lt(pg, lit), '("t"."q" IS NOT NULL AND "t"."q" < $1)', String(lit));
    assert.strictEqual(lt(sqliteDialect, 3000000000), '("t"."q" IS NOT NULL AND "t"."q" < ?)');
    // a column the store made is a bigint already
    assert.strictEqual(emit(pg, { p: 'cmp', op: 'lt', ref: n, operand: { lit: 3000000000 } }).sql, '("t"."n" IS NOT NULL AND "t"."n" < $1)');
  });
});
