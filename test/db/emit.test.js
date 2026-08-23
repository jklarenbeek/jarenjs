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
