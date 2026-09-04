//@ts-check
/**
 * @file The emitter: golden SQL for the truth-table forms through the
 * SQLite dialect, the SAME plans through the full test-double dialect
 * (correspondingly different text — the D21 proof at the query layer),
 * and the injection-impossibility proof: a hostile literal value never
 * appears in the SQL text, only in the ordered parameter slots.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  planQuery, emitPlan, normalizeModel, planCollection,
  sqliteDialect, createDialect, createEntityPredicateEmitters,
} from '@jarenjs/db';
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
    assert.match(sql, /\(length\(\?\) = 0 OR substr\(jsonb_extract\("doc", '\$\."name"'\), -length\(\?\)\) = \?\)/);
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
    const sum = emitFor(
      { $sum: { $for: { it: '$[*]' }, $return: '$it.age' } }, sqliteDialect);
    assert.strictEqual(sum.sql, 'SELECT SUM("gx_age") AS "value" FROM "users"');
  });
});

describe('the dialect proof, repeated at the query layer (D21)', () => {
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
    assert.match(whole.sql,
      /WHERE \("gx_at_gh6" IS NOT NULL AND "gx_at_gh6" IN \(\?, \?, \?, \?, \?, \?, \?, \?, \?\)\)/);
    assert.strictEqual(whole.slots.length, 9);

    const prefix = emitPlaces(
      where({ '$starts-with': [{ $geohash: ['$it.at', 6] }, 'u17'] }), sqliteDialect);
    assert.match(prefix.sql,
      /WHERE \("gx_at_gh6" IS NOT NULL AND \("gx_at_gh6" >= \? AND "gx_at_gh6" < \?\)\)/);
    assert.deepStrictEqual(prefix.slots.map((slot) => slot.literal), ['u17', 'u18']);
  });

  it('the same spatial plans render through the double dialect (D21)', () => {
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

  it('a numeric seek folds the groups and binds ONE guarded comparison', () => {
    const seek = { name: 'asof.lower', kind: 'number', ref: at,
      bound: { op: 'le', lit: 1000 }, inner: 'max', outer: 'min',
      group: { segments: [{ name: 'series' }], type: 'string', column: 'gx_series' },
      keys: ['a', 'b'] };
    const emitted = emit(plan(
      { p: 'cmp', op: 'ge', ref: at, operand: { seek: 'asof.lower' } }, [seek]));
    // the statement: one branch, no text-or-number OR, and a TYPED slot
    assert.match(emitted.sql, new RegExp('WHERE \\(json_type\\("doc", \'\\$\\."at"\'\\) '
      + 'IS NOT NULL AND json_type\\("doc", \'\\$\\."at"\'\\) IN \\(\'integer\', \'real\'\\) '
      + 'AND "gx_at" >= \\?\\)'));
    assert.deepStrictEqual(emitted.slots, [{ typed: { seek: 'asof.lower', type: 'number' } }]);
    // the seek: the least of the groups' own last instants, at or below
    // the earliest probe, over the keys the probes name
    const [first] = emitted.seeks;
    assert.strictEqual(first.name, 'asof.lower');
    assert.strictEqual(first.fallback, 1000);
    assert.match(first.sql,
      /^SELECT MIN\("a"\) AS "anchor" FROM \(SELECT MAX\("gx_at"\) AS "a" FROM "users" WHERE /);
    assert.match(first.sql, /GROUP BY "gx_series"\)$/);
    // its own slots are its own: a positional dialect numbers by the
    // TEXT order of the statement being emitted, and the seek is one
    assert.deepStrictEqual(first.slots.map((slot) => slot.literal), [1000, 'a', 'b']);
    assert.strictEqual(emitted.slots.length, 1);
  });

  it('an ungrouped seek IS the inner fold, and a text seek guards on text', () => {
    const stamp = { segments: [{ name: 'stamp' }], type: 'string', column: 'gx_stamp' };
    const seek = { name: 'asof.upper', kind: 'text', ref: stamp,
      bound: { op: 'ge', lit: '2026-01-01T00:00:00Z' }, inner: 'min', outer: 'max',
      group: null, keys: null };
    const emitted = emit(plan(
      { p: 'cmp', op: 'le', ref: stamp, operand: { seek: 'asof.upper' } }, [seek]));
    assert.match(emitted.sql, /json_type\("doc", '\$\."stamp"'\) = 'text' AND "gx_stamp" <= \?/);
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

  it('the double dialect spells every entity form differently (D21)', () => {
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
