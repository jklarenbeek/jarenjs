//@ts-check
/**
 * @file Windows and counts over constructors. An object or array constructor
 * yields one item per row, and the engine evaluates the return of every row,
 * so a window or a count may skip the evaluation of the rows it leaves out only
 * where that evaluation cannot raise. The operators the planner accepts are
 * kept as data and proven against the engine here; every other leaf keeps the
 * document in the engine, which raises where a row outside the window would.
 * A window over such a constructor rides in the statement while the
 * constructor itself runs per fetched row (the row residual), and a count is a
 * `COUNT(*)`. Collections and entities, SQLite and PostgreSQL, indexed and not.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { compileJsonQuery } from '@jarenjs/json/query';
import { JarenValidator } from '@jarenjs/validate';
import { openStore, planQuery, reasonId } from '@jarenjs/db';
import { nodeDriver, adaptNodeDatabase } from '@jarenjs/db/node';
import { from } from '@jarenjs/linq';

import * as planner from '../../packages/db/src/plan.js';
import {
  loadGroups, loadRelationGroups, storeForGroup, storeForEntityGroup, runCase, runEntityCase,
} from './oracle/harness.js';
import { onBothEngines, onBothEnginesPhysical } from './query-core-engines.js';
import { liveOracle } from './oracle/replication.js';

const PG_URL = process.env.JAREN_PG_URL;
let schemas = 0;

/**
 * Run `fn` once per available host with a way to open a driver of it: SQLite
 * in memory, and PostgreSQL in schemas of its own (a pool of two, every
 * schema dropped afterwards) when `JAREN_PG_URL` names an endpoint.
 * @param {(host: 'sqlite' | 'postgres', driverOf: () => Promise<any>) => Promise<void>} fn
 */
async function onHosts(fn) {
  await fn('sqlite', async () => nodeDriver());
  if (!PG_URL) return;
  const { default: pg } = await import('pg');
  const { postgresDriver } = await import('@jarenjs/db/postgres');
  const pool = new pg.Pool({ connectionString: PG_URL, max: 2 });
  /** @type {string[]} */
  const made = [];
  try {
    await fn('postgres', async () => {
      const schema = `constructors_${process.pid}_${++schemas}`;
      await pool.query(`CREATE SCHEMA "${schema}"`);
      made.push(schema);
      return postgresDriver(pool, { schema });
    });
  }
  finally {
    for (const schema of made) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
}

/** What a call answered: its value, or the code it raised. */
async function outcome(/** @type {() => any} */ call) {
  try { return { value: await call() }; }
  catch (error) { return { code: /** @type {any} */ (error).code }; }
}

/** The engine's outcome for a document over raw documents. */
function engineOutcome(/** @type {any} */ query, /** @type {any} */ documents, /** @type {any} */ externals = undefined) {
  try { return { value: compileJsonQuery(query)(structuredClone(documents), externals) }; }
  catch (error) { return { code: /** @type {any} */ (error).code }; }
}

/** The window clause a dialect spells for a limit (or none) and an offset. */
function windowClause(/** @type {string} */ host, /** @type {[number | null, number]} */ [limit, offset]) {
  const bound = limit === null ? (host === 'sqlite' ? '-1' : 'ALL') : String(limit);
  return `LIMIT ${bound}${offset > 0 ? ` OFFSET ${offset}` : ''}`;
}

// ————— the operators, proven against the engine —————

const ABSENT = Symbol('absent');
const NOT_STRINGS = [null, 5, true, ['a'], { k: 1 }];

/**
 * For each operator the planner accepts: the shape it is accepted in, the engine's value over
 * operands that conform and over an absent one, and the operands it raises on.
 * @type {Record<string, { arity: number, operand: string, build: (operand: any) => any,
 *   answers: [any, any][], raises: any[] }>}
 */
const PROOFS = {
  '$default': { arity: 2, operand: 'plain', build: (operand) => ({ $default: [operand, 'fallback'] }),
    answers: [[5, 5], ['s', 's'], [null, null], [[1], [1]], [{ k: 1 }, { k: 1 }], [ABSENT, 'fallback']], raises: [] },
  '$upper': { arity: 1, operand: 'string', build: (operand) => ({ $upper: operand }),
    answers: [['aé', 'AÉ'], ['', ''], [ABSENT, '']], raises: NOT_STRINGS },
  '$lower': { arity: 1, operand: 'string', build: (operand) => ({ $lower: operand }),
    answers: [['AÉ', 'aé'], ['', ''], [ABSENT, '']], raises: NOT_STRINGS },
  '$string-length': { arity: 1, operand: 'string', build: (operand) => ({ '$string-length': operand }),
    answers: [['aé', 2], ['', 0], [ABSENT, 0]], raises: NOT_STRINGS },
  '$count': { arity: 1, operand: 'path', build: (operand) => ({ $count: operand }),
    answers: [[5, 1], [null, 1], ['s', 1], [[1, 2], 1], [{ k: 1 }, 1], [ABSENT, 0]], raises: [] },
  '$exists': { arity: 1, operand: 'path', build: (operand) => ({ $exists: operand }),
    answers: [[5, true], [null, true], ['s', true], [[], true], [{}, true], [ABSENT, false]], raises: [] },
};

/** One member of one document through the engine: `{ v: <the operator over $it.x> }`. */
function evaluateOver(/** @type {any} */ build, /** @type {any} */ value) {
  const document = value === ABSENT ? {} : { x: value };
  return compileJsonQuery({ $for: { it: '$[*]' }, $return: { v: build('$it.x') } })([document]);
}

describe('the operators a constructor may apply are proven against the engine', () => {
  it('the planner accepts exactly the operators proven here, each with the operand proven', () => {
    assert.deepEqual([...planner.TOTAL_OPERATORS.keys()].sort(), Object.keys(PROOFS).sort());
    for (const [name, rule] of planner.TOTAL_OPERATORS) {
      assert.equal(rule.arity, PROOFS[name].arity, name);
      assert.equal(rule.operand, PROOFS[name].operand, name);
    }
  });

  for (const [name, proof] of Object.entries(PROOFS)) {
    it(`${name}: the engine's value over conforming and absent operands`, () => {
      for (const [value, expected] of proof.answers) {
        const label = `${name} of ${value === ABSENT ? 'an absent member' : JSON.stringify(value)}`;
        assert.deepEqual(evaluateOver(proof.build, value), { v: expected }, label);
      }
    });

    it(`${name}: ${proof.raises.length === 0 ? 'no operand raises' : 'what the engine raises on is what the operand rule keeps out'}`, () => {
      for (const value of proof.raises) {
        assert.throws(() => evaluateOver(proof.build, value), { code: 'JQ2001' }, `${name} of ${JSON.stringify(value)}`);
      }
      // the operand a rule names is the one that cannot raise: a string operator takes a string member
      // alone, and the rule that takes any member takes values of every kind
      if (proof.operand === 'string') assert.ok(proof.raises.length > 0, name);
      else assert.equal(proof.raises.length, 0, name);
    });
  }

  it('$default of two members yields the first member present, and nothing when both are absent', () => {
    const run = (/** @type {any} */ document) => compileJsonQuery(
      { $for: { it: '$[*]' }, $return: { v: { $default: ['$it.x', '$it.y'] } } })([document]);
    assert.deepEqual(run({ x: 1, y: 2 }), { v: 1 });
    assert.deepEqual(run({ y: 2 }), { v: 2 });
    assert.deepEqual(run({ x: null, y: 2 }), { v: null });
    assert.deepEqual(run({}), {});
  });

  it('a path of several items raises where a singular path does not, which is why only a singular path is accepted', () => {
    const several = (/** @type {any} */ build) => compileJsonQuery(
      { $for: { it: '$[*]' }, $return: { v: build('$it.x[*]') } })([{ x: [1, 2] }]);
    assert.throws(() => several((/** @type {any} */ operand) => ({ $default: [operand, 0] })), { code: 'JQ2001' });
    assert.throws(() => several((/** @type {any} */ operand) => operand), { code: 'JQ2001' });
  });
});

describe('a string operand is placed by the schema where the engine reads its path', () => {
  /** Member schemas whose element and member steps the proof reads: tuples, plain and untyped `items`, `contains`, digit names, nesting. */
  const SCHEMAS = /** @type {Record<string, any>} */ ({
    items: { type: 'array', items: { type: 'string' } },
    tuple: { type: 'array', prefixItems: [{ type: 'number' }], items: { type: 'string' } },
    tuple2: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }], items: { type: 'string' } },
    openTail: { type: 'array', prefixItems: [{ type: 'string' }] },
    closedTuple: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'string' }], items: false },
    untypedItems: { items: { type: 'string' } },
    contains: { type: 'array', contains: { type: 'string' } },
    arrayItems: { type: 'array', items: [{ type: 'string' }] },
    digitNames: { properties: { 0: { type: 'string' } } },
    object: { type: 'object', properties: { 0: { type: 'string' }, '-1': { type: 'string' } } },
    nullable: { type: ['array', 'null'], items: { type: 'string' } },
    nested: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
    nestedTuple: { type: 'array', items: { type: 'array', prefixItems: [{ type: 'number' }], items: { type: 'string' } } },
  });
  const PATHS = ['$it.a[0]', '$it.a[1]', '$it.a[2]', '$it.a[-1]', '$it.a[-2]', "$it.a['0']", "$it.a['-1']", '$it.a[0][0]',
    '$it.a[0][1]', '$it.a[0][-1]', '$it.a[-1][0]', '$it.a[-1][-1]', '$it.a.x'];
  /** Values a member may hold: arrays of every length and mix of kinds, nested arrays, objects named like indexes, scalars, null, nothing. */
  const POOL = [ABSENT, null, 5, 's', [], [1], ['s'], [1, 's'], ['s', 1], [1, 's', 't'], ['s', 't'], ['s', 1, 't'], [1, 2, 3],
    [['s']], [[1]], [[1, 's']], [['s', 't']], [[1], ['s']], [['s'], [1]], { 0: 's' }, { 0: 5 }, { '-1': 's' }, { '-1': 5 }, {}, { a: 5 }];
  /** The paths each schema lets a string operator read unevaluated: a negative index counts from the end, which no schema places. */
  const ACCEPTED = /** @type {Record<string, string[]>} */ ({
    items: ['$it.a[0]', '$it.a[1]', '$it.a[2]'],
    tuple: ['$it.a[1]', '$it.a[2]'],
    tuple2: ['$it.a[0]', '$it.a[2]'],
    openTail: ['$it.a[0]'],
    closedTuple: ['$it.a[0]', '$it.a[1]'],
    untypedItems: ['$it.a[0]', '$it.a[1]', '$it.a[2]'],
    contains: [],
    arrayItems: [],
    digitNames: ["$it.a['0']"],
    object: ["$it.a['0']", "$it.a['-1']"],
    nullable: ['$it.a[0]', '$it.a[1]', '$it.a[2]'],
    nested: ['$it.a[0][0]', '$it.a[0][1]'],
    nestedTuple: ['$it.a[0][1]'],
  });

  for (const [name, member] of Object.entries(SCHEMAS)) {
    it(`${name}: a path the planner takes as a string raises on no document the schema admits`, () => {
      const check = new JarenValidator().compile(member);
      const conforming = POOL.filter((value) => value === ABSENT || check(value));
      assert.ok(conforming.length >= 4, `${name}: the pool holds documents that conform`);
      const shape = { collection: 'rows', schema: { type: 'object', properties: { a: member } }, columnByCanonical: new Map() };
      /** @type {string[]} */
      const accepted = [];
      for (const path of PATHS) {
        for (const operator of ['$upper', '$lower', '$string-length']) {
          const leaf = { v: { [operator]: path } };
          const counted = planQuery({ $count: { $for: { it: '$[*]' }, $return: leaf } }, shape);
          const windowed = planQuery({ $subsequence: [{ $for: { it: '$[*]' }, $return: leaf }, 0, 1] }, shape);
          assert.equal(counted.mode === 'native', windowed.mode === 'row', `${name} ${operator} ${path}: one proof decides both`);
          if (counted.mode !== 'native') continue;
          if (operator === '$upper') accepted.push(path);
          for (const value of conforming) {
            const document = value === ABSENT ? {} : { a: value };
            assert.doesNotThrow(() => compileJsonQuery({ $for: { it: '$[*]' }, $return: leaf })([document]),
              `${name}: ${operator} of ${path} over ${JSON.stringify(document)}`);
          }
        }
      }
      assert.deepEqual(accepted, ACCEPTED[name], name);
    });
  }

  it('a negative index through a tuple stays in the engine on a collection and on an entity, on every host', async () => {
    const tuple = { type: 'array', prefixItems: [{ type: 'number' }], items: { type: 'string' } };
    const collection = { $model: '0.1', collections: { rows: { key: null, identity: 'integer', indexes: [{ name: 'by_id', path: '$.id' }],
      schema: { type: 'object', properties: { id: { type: 'string' }, a: tuple } } } } };
    // the last element of [5] is its prefix item, a number: `$upper` raises there, in a row the window never reaches
    const documents = [{ id: 'r1', a: [1, 'y'] }, { id: 'r2', a: [5] }, { id: 'r3', a: [2, 'p', 'q'] }, { id: 'r4' }];
    const windowOver = (/** @type {string} */ path) => ({ $subsequence: [{ $for: { it: '$[*]' }, $orderby: ['$it.id'],
      $return: { id: '$it.id', u: { $upper: path } } }, 0, 1] });
    const countOver = (/** @type {string} */ path) => ({ $count: { $for: { it: '$[*]' }, $return: { u: { $upper: path } } } });
    await onBothEngines(collection, async (store, host) => {
      const rows = store.collection('rows');
      for (const document of documents) await rows.insert(document);
      for (const [path, mode, raises] of /** @type {[string, [string, string], boolean][]} */ ([
        ['$it.a[-1]', ['set', 'set'], true], ['$it.a[0]', ['set', 'set'], true], ['$it.a[1]', ['row', 'native'], false]])) {
        for (const [query, expected] of /** @type {[any, string][]} */ ([[windowOver(path), mode[0]], [countOver(path), mode[1]]])) {
          const label = `${host}: ${JSON.stringify(query)}`;
          assert.equal((await rows.explain(query)).mode, expected, label);
          const engine = engineOutcome(query, documents);
          assert.equal(engine.code, raises ? 'JQ2001' : undefined, label);
          assert.deepEqual(await outcome(() => rows.execute(query)), engine, label);
        }
      }
    });
    const entity = { $model: '0.1', entities: { B: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'integer', 'x-entity': { key: true } }, p: tuple } } } } };
    await onBothEngines(entity, async (store, host) => {
      for (const document of [{ id: 1, p: [1, 'y'] }, { id: 2, p: [5] }, { id: 3 }]) await store.entity('B').create(document);
      for (const [path, mode, raises] of /** @type {[string, string, boolean][]} */ ([
        ['$b.p[-1]', 'set', true], ['$b.p[0]', 'set', true], ['$b.p[1]', 'native', false]])) {
        const query = { $count: { $for: { b: '$.B[*]' }, $return: [{ $upper: path }] } };
        const label = `${host}: ${path}`;
        assert.equal((await store.explain(query)).mode, mode, label);
        const engine = await outcome(() => store.execute(query, { pushdown: false }));
        assert.equal(engine.code, raises ? 'JQ2001' : undefined, label);
        assert.deepEqual(await outcome(() => store.execute(query)), engine, label);
      }
    });
  });
});

// ————— collections: the corpus groups, case by case —————

/**
 * What the planner does with each case of a group: `rows` the window a row plan carries in its statement
 * (`[limit, offset]`), `counts` the cases that plan a native `COUNT(*)`, `kept` the cases that stay in the
 * engine with the first reason they name and the code the engine raises, when it does.
 * @typedef {{ rows: Map<string, [number | null, number]>, counts: Set<string>,
 *   kept: Map<string, { reason: string, raises?: string }> }} Expectations
 */

/** @type {Expectations} */
const CONSTRUCTOR_WINDOWS = {
  rows: new Map(/** @type {[string, [number | null, number]][]} */ ([
    ['a window over a default constructor', [3, 1]],
    ['a window over upper-cased members', [3, 2]],
    ['a window over lower-cased members and lengths', [4, 0]],
    ['a window over counts and presence tests', [4, 3]],
    ['a window over a descending order with absent keys greatest', [3, 1]],
    ['a window over a number order, absent keys least', [5, 1]],
    ['an offset window with no limit', [null, 4]],
    ['nested windows compose over a constructor', [2, 3]],
    ['an empty window over a constructor', [0, 0]],
    ['a window past the last row', [5, 50]],
    ['a window over a filter and a constructor', [3, 1]],
    ['a window over an external bound and a constructor', [2, 0]],
    ['an unordered window follows insertion order', [3, 2]],
    ['a window over an array constructor', [4, 1]],
    ['a window of one over an array constructor', [1, 2]],
    ['a window of one over an array constructor of absent members', [1, 5]],
    ['a window of one over an object constructor of absent members', [1, 5]],
    ['a window over a nested constructor', [3, 2]],
    ['a window over a default of two members', [6, 0]],
    ['a window over literals beside an operator', [3, 1]],
    ['a window over an operator on a nested string member', [10, 0]],
    ['a window over an operator on an array element', [10, 0]],
    ['a window over the document beside an operator', [2, 1]],
    ['a window over a constructor ordered by a string member', [4, 2]],
    ['a window over a constructor with an empty member name', [2, 1]],
  ])),
  counts: new Set([
    'a count of a default constructor',
    'a count of an upper constructor under a filter',
    'a count of an array constructor of operators',
    'a count of an ordered constructor',
    'a count of a constructor over an empty selection',
    'a count of a constructor of counts and presence tests',
    'a count of a constructor under an external bound',
    'a count of a constructor over the document beside an operator',
  ]),
  kept: new Map([
    ['a window over an arithmetic leaf', { reason: 'flwor.projection' }],
    ['a window over a concatenation', { reason: 'flwor.projection' }],
    ['a window over a count of a path that expands', { reason: 'flwor.projection' }],
    ['an upper-case of a member that may be null raises past the window', { reason: 'flwor.projection', raises: 'JQ2001' }],
    ['a count of an upper-case of a member that may be null', { reason: 'plan.countProjection', raises: 'JQ2001' }],
    ['an upper-case of an integer member raises past the window', { reason: 'flwor.projection', raises: 'JQ2001' }],
    ['an upper-case of an untyped member raises past the window', { reason: 'flwor.projection', raises: 'JQ2001' }],
    ['a length of an untyped member raises past the window', { reason: 'flwor.projection', raises: 'JQ2001' }],
    ['a count of an upper-case of a number literal', { reason: 'plan.countProjection', raises: 'JQ2001' }],
    ['a count of an upper-case of a string literal', { reason: 'plan.countProjection' }],
    ['a count of a length of an untyped member', { reason: 'plan.countProjection', raises: 'JQ2001' }],
    ['an object member of several items raises past the window', { reason: 'flwor.projection', raises: 'JQ2001' }],
    ['a count of a constructor with a member of several items', { reason: 'plan.countProjection', raises: 'JQ2001' }],
    ['a default over a path of several items raises past the window', { reason: 'flwor.projection', raises: 'JQ2001' }],
    ['a default over an operator is no leaf', { reason: 'flwor.projection' }],
    ['an operator on an operator is no leaf', { reason: 'flwor.projection' }],
    ['an operator at the root of the return is no constructor', { reason: 'plan.countProjection' }],
    ['an operator at the root of the return under a window', { reason: 'flwor.projection' }],
    ['an external in a constructor stays in the engine', { reason: 'flwor.projection' }],
    ['a key that may be null cannot order the window', { reason: 'flwor.orderPath', raises: 'JQ2005' }],
  ]),
};

/** @type {Expectations} */
const CONSTRUCTOR_LEAVES = {
  rows: new Map(/** @type {[string, [number | null, number]][]} */ ([
    ['an upper-case of a string member', [1, 0]],
    ['an upper-case of a member under a name that reads as an index', [1, 0]],
    ['an upper-case of an index into an array of strings', [1, 0]],
    ['an upper-case of a member of an object that may be null', [1, 0]],
    ['an upper-case of a member of the first element of an array of objects', [1, 0]],
    ['a length of a string member', [1, 0]],
    ['a presence test of a name that reads as an index', [1, 0]],
    ['a count of an index into a container with no items', [1, 0]],
    ['a default of an index into a container with no items', [1, 0]],
    ['an upper-case of an element past the prefix of a tuple', [1, 0]],
    ['a presence test of the last element of a tuple', [1, 0]],
  ])),
  counts: new Set([
    'a count of upper-cases of a name that reads as an index',
    'a count of upper-cases of an index into an array of strings',
    'a count of lengths of a member of an object that may be null',
    'a count of upper-cases of an element past the prefix of a tuple',
  ]),
  kept: new Map([
    // a tuple's last element may be one of its prefix items, which a schema cannot place from the end
    ['an upper-case of the last element of a tuple', { reason: 'flwor.projection', raises: 'JQ2001' }],
    ['an upper-case of the first element of a tuple', { reason: 'flwor.projection', raises: 'JQ2001' }],
    ['an upper-case of the last element of an array of strings', { reason: 'flwor.projection' }],
    ['an upper-case of an element of an array that only contains a string', { reason: 'flwor.projection', raises: 'JQ2001' }],
    ['a count of upper-cases of the last element of a tuple', { reason: 'plan.countProjection', raises: 'JQ2001' }],
    ['a count of upper-cases of the last element of an array of strings', { reason: 'plan.countProjection' }],
    ['a count of upper-cases of an element of an array that only contains a string', { reason: 'plan.countProjection', raises: 'JQ2001' }],
    ['an upper-case of a member of two types', { reason: 'flwor.projection', raises: 'JQ2001' }],
    ['an upper-case of an index into a container with no items', { reason: 'flwor.projection', raises: 'JQ2001' }],
    ['an upper-case of a name that reads as an index in a container with no properties', { reason: 'flwor.projection', raises: 'JQ2001' }],
    ['an upper-case of a name over an array of objects', { reason: 'flwor.projection' }],
    ['a length of a member of two types', { reason: 'flwor.projection', raises: 'JQ2001' }],
    ['a count of upper-cases of an index into a container with no items', { reason: 'plan.countProjection', raises: 'JQ2001' }],
    ['a count of upper-cases of a name that reads as an index in a container with no properties', { reason: 'plan.countProjection', raises: 'JQ2001' }],
    ['a count of upper-cases of a member of two types', { reason: 'plan.countProjection', raises: 'JQ2001' }],
  ]),
};

/**
 * Every case of a collection group on every host and both sides: the plan the tables name, the statement it
 * emits, the answer the engine gives (or the code it raises), natively and with pushdown off, and strict mode.
 * @param {string} name
 * @param {Expectations} expected
 */
function collectionGroup(name, expected) {
  it(`${name}: every case is named once, and the engine raises where a row past the window would`, () => {
    const group = loadGroups().find((entry) => entry.group === name);
    assert.ok(group, name);
    for (const kase of group.cases) {
      const listed = [expected.rows.has(kase.name), expected.counts.has(kase.name), expected.kept.has(kase.name)];
      assert.equal(listed.filter(Boolean).length, 1, `'${kase.name}' is in exactly one table`);
      const raises = expected.kept.get(kase.name)?.raises;
      const engine = engineOutcome(kase.query, group.documents, kase.externals);
      assert.equal(engine.code, raises, `'${kase.name}': the engine ${raises ? `raises ${raises}` : 'answers'}`);
    }
    const names = new Set(group.cases.map((/** @type {any} */ kase) => kase.name));
    for (const listed of [...expected.rows.keys(), ...expected.counts, ...expected.kept.keys()]) {
      assert.ok(names.has(listed), `'${listed}' is a case of the group`);
    }
  });

  it(`${name}: the plans, statements and answers on every host, indexed and unindexed`, async () => {
    const group = loadGroups().find((entry) => entry.group === name);
    assert.ok(group, name);
    await onHosts(async (host, driverOf) => {
      for (const side of /** @type {const} */ (['indexed', 'unindexed'])) {
        const { store, collection } = await storeForGroup(group, await driverOf(), side);
        try {
          for (const kase of group.cases) {
            const label = `${host} ${side}: ${kase.name}`;
            const options = { externals: kase.externals };
            const explained = await collection.explain(kase.query, options);
            const window = expected.rows.get(kase.name);
            const kept = expected.kept.get(kase.name);
            const strict = () => Promise.resolve().then(() => collection.execute(kase.query, { ...options, strict: true }));
            if (window !== undefined) {
              assert.equal(explained.mode, 'row', label);
              assert.ok(explained.sql.endsWith(windowClause(host, window)), `${label}: ${explained.sql}`);
              assert.equal(reasonId(explained.residual.reasons[0].reason), 'flwor.projection', label);
              assert.ok(explained.residual.reasons.every((/** @type {any} */ entry) => reasonId(entry.reason) !== null), label);
              assert.equal(explained.streaming, 'row', label);
              await assert.rejects(strict, { code: 'JD0010' }, label);
            }
            else if (expected.counts.has(kase.name)) {
              assert.equal(explained.mode, 'native', label);
              assert.match(explained.sql, /^SELECT COUNT\(\*\) AS "value" FROM /, label);
              assert.equal(explained.residual, null, label);
              assert.deepEqual(await strict(), engineOutcome(kase.query, group.documents, kase.externals).value, label);
            }
            else {
              assert.equal(explained.mode, 'set', label);
              const reasons = explained.residual.reasons.map((/** @type {any} */ entry) => reasonId(entry.reason));
              assert.ok(reasons.every((/** @type {string | null} */ id) => id !== null), `${label}: ${JSON.stringify(reasons)}`);
              assert.equal(reasons[0], kept?.reason, label);
              await assert.rejects(strict, { code: 'JD0010' }, label);
            }
            if (kept?.raises !== undefined) {
              await assert.rejects(Promise.resolve().then(() => collection.execute(kase.query, options)), { code: kept.raises }, label);
            }
            assert.equal(await runCase(collection, group.documents, kase, 'native'), null, label);
            assert.equal(await runCase(collection, group.documents, kase, 'residual'), null, label);
          }
        }
        finally { await store.close(); }
      }
    });
  });
}

describe('collections: windows and counts over constructors', () => {
  collectionGroup('windows and counts over constructors', CONSTRUCTOR_WINDOWS);
});

describe('collections: the leaves of a constructor over unions and open containers', () => {
  collectionGroup('constructor leaves over unions and open containers', CONSTRUCTOR_LEAVES);
});

describe('collections: a window or a count stays in the engine where a conjunct runs as a registered function', () => {
  // the database stops evaluating a registered function once the window is full, as an ordered index lets it, or
  // once a cheaper conjunct has refused the row, as an index on the member lets a count; the engine evaluates the
  // conjunct on every row and raises on the one that cannot be uppercased
  const returned = { id: '$it.id', s: { $upper: '$it.s' } };
  const QUERIES = /** @type {[string, any][]} */ ([
    ['a window past the row the conjunct raises on', { $subsequence: [{ $for: { it: '$[*]' },
      $where: { $eq: [{ $upper: '$it.u' }, 'X'] }, $orderby: ['$it.id'], $return: returned }, 0, 1] }],
    ['a count beside a conjunct an index refuses first', { $count: { $for: { it: '$[*]' },
      $where: { $and: [{ $eq: [{ $upper: '$it.n' }, 'X'] }, { $eq: ['$it.id', 'none'] }] }, $return: returned } }],
  ]);

  it('raises the engine\'s code from a row the conjunct reaches, with and without the index', async () => {
    const group = loadGroups().find((entry) => entry.group === 'windows and counts over constructors');
    assert.ok(group);
    await onHosts(async (host, driverOf) => {
      for (const side of /** @type {const} */ (['indexed', 'unindexed'])) {
        const { store, collection } = await storeForGroup(group, await driverOf(), side);
        try {
          for (const [name, query] of QUERIES) {
            const label = `${host} ${side}: ${name}`;
            assert.deepEqual(engineOutcome(query, group.documents), { code: 'JQ2001' }, label);
            const explained = await collection.explain(query);
            assert.equal(explained.mode, 'set', label);
            // the hatch takes the conjunct on SQLite, and a window's selection keeps it (the count fetches the
            // whole collection); PostgreSQL registers no function and names the operand
            assert.equal(explained.udfs.length, host === 'sqlite' && query.$count === undefined ? 1 : 0, label);
            // the cause is named first: the function on SQLite, the operand it could not translate on PostgreSQL
            assert.equal(reasonId(explained.residual.reasons[0].reason),
              host === 'postgres' ? 'predicate.operands' : 'plan.registeredFunction', label);
            if (host === 'sqlite' && query.$count === undefined) {
              assert.equal(reasonId(explained.residual.reasons[1].reason), 'flwor.projection', label);
            }
            await assert.rejects(Promise.resolve().then(() => collection.execute(query, { strict: true })),
              { code: 'JD0010', message: /registered function|translate/ }, label);
            assert.deepEqual(await outcome(() => collection.execute(query)), { code: 'JQ2001' }, label);
          }
        }
        finally { await store.close(); }
      }
    });
  });
});

// ————— what the driver fetches —————

/** A collection of `count` documents behind a driver that counts the rows its reads return. */
async function countedCollection(/** @type {number} */ count) {
  const raw = new DatabaseSync(':memory:');
  let fetched = 0;
  const reading = (/** @type {string} */ sql) => /^\s*(SELECT|WITH)\b/i.test(sql);
  const db = await adaptNodeDatabase({
    exec: (sql) => raw.exec(sql), close: () => raw.close(),
    prepare: (sql) => {
      const statement = raw.prepare(sql);
      const counted = (/** @type {any} */ value) => {
        if (reading(sql)) fetched += Array.isArray(value) ? value.length : value === undefined ? 0 : 1;
        return value;
      };
      return {
        iterate: (/** @type {any[]} */ ...args) => (function* () {
          for (const row of statement.iterate(...args)) {
            if (reading(sql)) fetched++;
            yield row;
          }
        })(),
        all: (/** @type {any[]} */ ...args) => counted(statement.all(...args)),
        get: (/** @type {any[]} */ ...args) => counted(statement.get(...args)),
        run: (/** @type {any[]} */ ...args) => statement.run(...args),
      };
    },
  });
  const store = await openStore({
    $model: '0.1',
    collections: { rows: { key: null, identity: 'integer', indexes: [{ name: 'by_id', path: '$.id' }],
      schema: { type: 'object', properties: { id: { type: 'string' }, s: { type: 'string' }, n: { type: 'integer' } } } } },
  }, { driver: { ...nodeDriver(), open: async () => db } });
  const documents = Array.from({ length: count }, (_, i) => ({ id: `p${String(i).padStart(4, '0')}`, s: `name-${i % 97}`, n: i }));
  for (const document of documents) await store.collection('rows').insert(document);
  return { store, collection: store.collection('rows'), documents, fetched: () => fetched, reset: () => { fetched = 0; } };
}

describe('a window over a constructor fetches the rows of the window', () => {
  const capture = (/** @type {any[]} */ documents) => from(documents).orderBy((p) => p.id)
    .select((p) => ({ id: p.id, s: p.s.upper() })).skip(10).take(5).toDocument();

  it('select().skip().take() with an operator plans a row with the window in its statement and fetches five rows of two hundred', async () => {
    const { store, collection, documents, fetched, reset } = await countedCollection(200);
    try {
      const document = capture(documents);
      assert.deepEqual(document, { $subsequence: [{ $subsequence: [{ $for: { it: ['$[*]'] }, $orderby: { $key: '$it.id' },
        $return: { id: '$it.id', s: { $upper: '$it.s' } } }, 10] }, 0, 5] });
      const explained = await collection.explain(document);
      assert.equal(explained.mode, 'row');
      assert.ok(explained.sql.endsWith('LIMIT 5 OFFSET 10'), explained.sql);
      assert.deepEqual(explained.residualProjection, { id: '$it.id', s: { $upper: '$it.s' } });
      reset();
      const answer = await collection.execute(document);
      assert.equal(fetched(), 5);
      assert.deepEqual(answer, compileJsonQuery(document)(documents));
      assert.deepEqual(answer.map((/** @type {any} */ item) => item.s), ['NAME-10', 'NAME-11', 'NAME-12', 'NAME-13', 'NAME-14']);
      // the same chain with plain members was native, and fetches the same rows
      reset();
      await collection.execute(from(documents).orderBy((p) => p.id).select((p) => ({ id: p.id, s: p.s })).skip(10).take(5).toDocument());
      assert.equal(fetched(), 5);
    }
    finally { await store.close(); }
  });

  it('the chain run through the collection provider is the same five rows', async () => {
    const { fromAsync } = await import('@jarenjs/linq');
    const { store, collection, documents, fetched, reset } = await countedCollection(200);
    try {
      reset();
      const answer = await fromAsync(collection).orderBy((p) => p.id)
        .select((p) => ({ id: p.id, s: p.s.upper() })).skip(10).take(5).toArray();
      assert.equal(fetched(), 5);
      assert.deepEqual(answer, from(documents).orderBy((p) => p.id).select((p) => ({ id: p.id, s: p.s.upper() })).skip(10).take(5).toArray());
    }
    finally { await store.close(); }
  });

  it('a cursor over the window pulls the five rows and no more', async () => {
    const { store, collection, documents, fetched, reset } = await countedCollection(200);
    try {
      const document = capture(documents);
      const explained = await collection.explain(document);
      assert.equal(explained.streaming, 'row');
      assert.equal(explained.barrier, null);
      reset();
      const items = [];
      for await (const item of collection.query(document)) items.push(item);
      assert.equal(fetched(), 5);
      assert.deepEqual(items, compileJsonQuery(document)(documents));
    }
    finally { await store.close(); }
  });

  it('a cursor over the window answers the engine\'s items on every host', async () => {
    const group = loadGroups().find((entry) => entry.group === 'windows and counts over constructors');
    assert.ok(group);
    await onHosts(async (host, driverOf) => {
      const { store, collection } = await storeForGroup(group, await driverOf(), 'indexed');
      try {
        for (const name of ['a window over upper-cased members', 'a window over a nested constructor', 'an offset window with no limit']) {
          const kase = group.cases.find((/** @type {any} */ entry) => entry.name === name);
          assert.equal((await collection.explain(kase.query)).streaming, 'row', `${host}: ${name}`);
          const items = [];
          for await (const item of collection.query(kase.query)) items.push(item);
          const expected = engineOutcome(kase.query, group.documents).value;
          assert.deepEqual(items, Array.isArray(expected) ? expected : [expected], `${host}: ${name}`);
        }
      }
      finally { await store.close(); }
    });
  });

  it('a count of the constructor reads one row, the count, of two hundred', async () => {
    const { store, collection, documents, fetched, reset } = await countedCollection(200);
    try {
      const document = { $count: { $for: { it: '$[*]' }, $where: { $ge: ['$it.n', 50] },
        $return: { id: '$it.id', s: { $upper: '$it.s' } } } };
      const explained = await collection.explain(document);
      assert.equal(explained.mode, 'native');
      assert.match(explained.sql, /^SELECT COUNT\(\*\) AS "value" FROM /);
      reset();
      assert.equal(await collection.execute(document), 150);
      assert.equal(fetched(), 1);
      assert.equal(await collection.execute(document, { strict: true }), compileJsonQuery(document)(documents));
    }
    finally { await store.close(); }
  });

  it('the same count over a constructor that can raise reads every row, and so does a window over it', async () => {
    const { store, collection, documents, fetched, reset } = await countedCollection(200);
    try {
      const counted = { $count: { $for: { it: '$[*]' }, $return: { id: '$it.id', v: { $add: ['$it.n', 1] } } } };
      const windowed = { $subsequence: [{ $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: { id: '$it.id', v: { $add: ['$it.n', 1] } } }, 10, 5] };
      for (const document of [counted, windowed]) {
        assert.equal((await collection.explain(document)).mode, 'set');
        reset();
        assert.deepEqual(await collection.execute(document), compileJsonQuery(document)(documents));
        assert.equal(fetched(), 200);
      }
    }
    finally { await store.close(); }
  });

  it('a profile bounds the rows of the window and the one row of the count, not the collection', async () => {
    const { store, collection, documents } = await countedCollection(50);
    try {
      const document = capture(documents);
      const profile = { maxRows: 8 };
      assert.deepEqual(await collection.execute(document, { profile }), compileJsonQuery(document)(documents));
      // the engine path fetches every candidate and crosses the bound
      await assert.rejects(Promise.resolve().then(() => collection.execute(document, { profile, pushdown: false })), { code: 'JD2007' });
      // a window wider than the bound crosses it, as the native window over plain members does
      const wide = { $subsequence: [document.$subsequence[0], 0, 20] };
      await assert.rejects(Promise.resolve().then(() => collection.execute(wide, { profile })), { code: 'JD2007' });
      const counted = { $count: { $for: { it: '$[*]' }, $return: { id: '$it.id', s: { $upper: '$it.s' } } } };
      assert.equal(await collection.execute(counted, { profile }), 50);
      await assert.rejects(Promise.resolve().then(() => collection.execute(counted, { profile, pushdown: false })), { code: 'JD2007' });
    }
    finally { await store.close(); }
  });

  it('a profile\'s engine limits bound what the engine still evaluates: a window\'s rows each alone, and no count', async () => {
    const { store, collection, documents } = await countedCollection(40);
    try {
      const window = { $subsequence: [{ $for: { it: '$[*]' }, $orderby: ['$it.id'],
        $return: { id: '$it.id', u: { $upper: '$it.s' } } }, 0, 10] };
      const counted = { $count: { $for: { it: '$[*]' }, $return: { id: '$it.id', u: { $upper: '$it.s' } } } };
      for (const limits of [{ resultItems: 3 }, { sequenceItems: 3 }, { steps: 20 }]) {
        const profile = { maxRows: 1000, limits };
        const label = JSON.stringify(limits);
        assert.deepEqual(await collection.execute(window, { profile }), compileJsonQuery(window)(documents), label);
        assert.equal(await collection.execute(counted, { profile }), 40, label);
        // the engine path is held to them, with the engine's own code
        await assert.rejects(Promise.resolve().then(() => collection.execute(window, { profile, pushdown: false })),
          { code: 'JQ2009' }, label);
      }
    }
    finally { await store.close(); }
  });

  it('an operator that raises on a row outside the window still raises: the document stays in the engine', async () => {
    const { store, collection, documents } = await countedCollection(20);
    try {
      // `n` is an integer member, which `$upper` raises on in every row, those outside the window included
      const document = { $subsequence: [{ $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: { id: '$it.id', v: { $upper: '$it.n' } } }, 0, 2] };
      assert.equal((await collection.explain(document)).mode, 'set');
      await assert.rejects(Promise.resolve().then(() => collection.execute(document)), { code: 'JQ2001' });
      assert.throws(() => compileJsonQuery(document)(documents), { code: 'JQ2001' });
    }
    finally { await store.close(); }
  });
});

describe('a live count over a constructor of operators', () => {
  const model = { $model: '0.1', collections: { rows: { key: '/id',
    schema: { type: 'object', properties: { id: { type: 'string' }, s: { type: 'string' } } } } } };
  const OPERATORS = [{ $count: { $for: { it: '$[*]' }, $return: { id: '$it.id', u: { $upper: '$it.s' } } } }];
  const MEMBERS = [{ $count: { $for: { it: '$[*]' }, $return: { id: '$it.id', s: '$it.s' } } }];
  const BARE = [{ $count: { $for: { it: '$[*]' }, $return: '$it' } }];
  const fill = (/** @type {any} */ store, /** @type {number} */ count) => store.transaction(async (/** @type {any} */ tx) => {
    for (let i = 0; i < count; i++) await tx.collection('rows').put({ id: `r${i}`, s: `s${i % 7}` });
  });

  it('re-runs its one statement, so no number of rows refuses it and an incremental mode is refused', async () => {
    const store = await openStore(model, { driver: nodeDriver(), capture: true, live: { maxMaintained: 5 } });
    try {
      await fill(store, 12);
      const rows = store.collection('rows');
      const live = await rows.live(OPERATORS, { mode: 'auto' });
      assert.equal(live.mode.strategy, 'rerun');
      const oracle = liveOracle(live, () => rows.execute(OPERATORS));
      await oracle.check();
      assert.deepEqual(live.result.rows, [12]);
      await rows.put({ id: 'extra', s: 'z' });
      await oracle.check();
      assert.deepEqual(live.result.rows, [13]);
      oracle.close();
      live.close();
      await assert.rejects(Promise.resolve().then(() => rows.live(OPERATORS, { mode: 'incremental' })), { code: 'JD0051' });
      // a count of the bare binding or of a constructor of member paths is still a maintained accumulator, and still bounded
      for (const document of [BARE, MEMBERS]) {
        await assert.rejects(Promise.resolve().then(() => rows.live(document, { mode: 'auto' })), { code: 'JD2060' });
      }
    }
    finally { await store.close(); }
  });

  it('registers over the default bound of ten thousand maintained rows', async () => {
    const store = await openStore(model, { driver: nodeDriver(), capture: true });
    try {
      await fill(store, 10001);
      const live = await store.collection('rows').live(OPERATORS, { mode: 'auto' });
      assert.equal(live.mode.strategy, 'rerun');
      assert.deepEqual(live.result.rows, [10001]);
      live.close();
    }
    finally { await store.close(); }
  });
});

describe('a document that violates its schema is outside the proof', () => {
  // inserts are unvalidated without a `compileSchema` hook: the operator raises on the row the statement never reads
  const model = { $model: '0.1', collections: { rows: { key: null, identity: 'integer',
    schema: { type: 'object', properties: { id: { type: 'string' }, s: { type: 'string' } } } } } };

  it('the window and the count answer where the engine raises on a row they leave unread, and raise on a row they read', async () => {
    await onBothEngines(model, async (store, host) => {
      const rows = store.collection('rows');
      for (const document of [{ id: 'a', s: 'x' }, { id: 'b', s: 5 }, { id: 'c', s: 'z' }]) await rows.insert(document);
      const window = (/** @type {number} */ start) => ({ $subsequence: [{ $for: { it: '$[*]' }, $orderby: ['$it.id'],
        $return: { id: '$it.id', v: { $upper: '$it.s' } } }, start, 1] });
      const counted = { $count: { $for: { it: '$[*]' }, $return: { v: { $upper: '$it.s' } } } };
      assert.deepEqual(await rows.execute(window(0)), { id: 'a', v: 'X' }, host);
      await assert.rejects(Promise.resolve().then(() => rows.execute(window(0), { pushdown: false })), { code: 'JQ2001' }, host);
      await assert.rejects(Promise.resolve().then(() => rows.execute(window(1))), { code: 'JQ2001' }, host);
      assert.equal(await rows.execute(counted), 3, host);
      await assert.rejects(Promise.resolve().then(() => rows.execute(counted, { pushdown: false })), { code: 'JQ2001' }, host);
    });
  });
});

// ————— entities —————

/**
 * @type {{ counts: Set<string>, kept: Map<string, { reason: string, raises?: string }>, native: Set<string> }}
 */
const ENTITY_COUNTS = {
  counts: new Set([
    'a count of an upper constructor',
    'a count of an ordered constructor under a filter',
    'a count of an array constructor of presence tests',
    'a count of a constructor over a document member',
    'a count of a constructor over a join',
    'a count of a constructor beside a hop count',
    'a count of a constructor over no rows',
    'a count of a constructor of literals and an operator',
    'a count of an upper-case of an element past the prefix of a tuple',
  ]),
  kept: new Map([
    ['a count of an arithmetic leaf', { reason: 'entity.projection' }],
    // the last element of a short tuple is one of its prefix items, a number
    ['a count of an upper-case of the last element of a tuple', { reason: 'entity.projection', raises: 'JQ2001' }],
    ['a count of an upper-case of the first element of a tuple', { reason: 'entity.projection', raises: 'JQ2001' }],
    ['a count of an upper-case of a nullable member', { reason: 'entity.projection' }],
    ['a count of an upper-case of an integer member', { reason: 'entity.projection', raises: 'JQ2001' }],
    // a hop read as a value that does not cover the related key can reach several rows, which the engine raises on
    ['a count of a constructor with a hop that can reach several rows', { reason: 'entity.hopValue', raises: 'JQ2001' }],
    ['a count of an operator at the root of the return', { reason: 'entity.projection' }],
    ['a count of an operator over a nested operator', { reason: 'entity.projection' }],
    // the entity planner has no row residual: a window over an operator projection is the engine's
    ['a window over an operator projection stays in the engine', { reason: 'entity.projection' }],
    ['an offset window over an operator projection stays in the engine', { reason: 'entity.projection' }],
  ]),
  native: new Set(['a window over a member projection is native']),
};

describe('entities: a count over a constructor', () => {
  it('every case is named once, and the engine raises where a row would', () => {
    const group = loadRelationGroups().find((entry) => entry.group === 'entity counts over constructors');
    assert.ok(group);
    for (const kase of group.cases) {
      const listed = [ENTITY_COUNTS.counts.has(kase.name), ENTITY_COUNTS.kept.has(kase.name), ENTITY_COUNTS.native.has(kase.name)];
      assert.equal(listed.filter(Boolean).length, 1, `'${kase.name}' is in exactly one table`);
      assert.equal(engineOutcome(kase.query, group.documents).code, ENTITY_COUNTS.kept.get(kase.name)?.raises, kase.name);
    }
  });

  it('the plans, statements and answers on every host, indexed and unindexed', async () => {
    const group = loadRelationGroups().find((entry) => entry.group === 'entity counts over constructors');
    assert.ok(group);
    await onHosts(async (host, driverOf) => {
      for (const side of /** @type {const} */ (['indexed', 'unindexed'])) {
        const { store } = await storeForEntityGroup(group, await driverOf(), side);
        try {
          for (const kase of group.cases) {
            const label = `${host} ${side}: ${kase.name}`;
            const explained = await store.explain(kase.query);
            const strict = () => Promise.resolve().then(() => store.execute(kase.query, { strict: true }));
            if (ENTITY_COUNTS.counts.has(kase.name)) {
              assert.equal(explained.mode, 'native', label);
              assert.match(explained.sql, /^SELECT COUNT\(\*\) AS "value" FROM /, label);
              assert.equal(explained.residual, null, label);
              assert.deepEqual(await strict(), engineOutcome(kase.query, group.documents).value, label);
            }
            else if (ENTITY_COUNTS.native.has(kase.name)) assert.equal(explained.mode, 'native', label);
            else {
              const kept = ENTITY_COUNTS.kept.get(kase.name);
              assert.equal(explained.mode, 'set', label);
              assert.equal(reasonId(explained.residual.reasons[0].reason), kept?.reason, label);
              await assert.rejects(strict, { code: 'JD0010' }, label);
              if (kept?.raises !== undefined) {
                await assert.rejects(Promise.resolve().then(() => store.execute(kase.query)), { code: kept.raises }, label);
              }
            }
            assert.equal(await runEntityCase(store, group.documents, kase, 'native'), null, label);
            assert.equal(await runEntityCase(store, group.documents, kase, 'residual'), null, label);
          }
        }
        finally { await store.close(); }
      }
    });
  });

  it('a window over an operator projection of an entity stays in the engine, wrapped as a chain emits it', async () => {
    const group = loadRelationGroups().find((entry) => entry.group === '11 entity selects');
    assert.ok(group);
    const document = [{ $subsequence: [{ $for: { it: '$.Post[*]' }, $orderby: { $key: '$it.pid' },
      $return: { id: '$it.pid', t: { $upper: '$it.title' } } }, 0, 3] }];
    await onHosts(async (host, driverOf) => {
      const { store } = await storeForEntityGroup(group, await driverOf(), 'indexed');
      try {
        const explained = await store.explain(document);
        assert.equal(explained.mode, 'set', host);
        assert.equal(reasonId(explained.residual.reasons[0].reason), 'entity.projection', host);
        await assert.rejects(Promise.resolve().then(() => store.execute(document, { strict: true })), { code: 'JD0010' }, host);
        assert.deepEqual(await store.execute(document), await store.execute(document, { pushdown: false }), host);
        assert.deepEqual(await store.execute(document), engineOutcome(document, group.documents).value, host);
      }
      finally { await store.close(); }
    });
  });

  it('a count fetches the count, and one row, however many rows the entity holds', async () => {
    const raw = new DatabaseSync(':memory:');
    let fetched = 0;
    const db = await adaptNodeDatabase({
      exec: (sql) => raw.exec(sql), close: () => raw.close(),
      prepare: (sql) => {
        const statement = raw.prepare(sql);
        const counted = (/** @type {any} */ value) => {
          if (/^\s*SELECT\b/i.test(sql)) fetched += Array.isArray(value) ? value.length : value === undefined ? 0 : 1;
          return value;
        };
        return {
          iterate: (/** @type {any[]} */ ...args) => statement.iterate(...args),
          all: (/** @type {any[]} */ ...args) => counted(statement.all(...args)),
          get: (/** @type {any[]} */ ...args) => counted(statement.get(...args)),
          run: (/** @type {any[]} */ ...args) => statement.run(...args),
        };
      },
    });
    const store = await openStore({ $model: '0.1', entities: { Word: { schema: { type: 'object', required: ['id'],
      properties: { id: { type: 'integer', 'x-entity': { key: true } }, text: { type: 'string' } } } } } },
    { driver: { ...nodeDriver(), open: async () => db } });
    try {
      for (let id = 1; id <= 120; id++) await store.entity('Word').create({ id, text: `w${id}` });
      const document = { $count: { $for: { w: '$.Word[*]' }, $return: { id: '$w.id', t: { $upper: '$w.text' } } } };
      fetched = 0;
      assert.equal(await store.execute(document), 120);
      assert.equal(fetched, 1);
      fetched = 0;
      assert.equal(await store.execute(document, { pushdown: false }), 120);
      assert.ok(fetched >= 120, `the engine reads every row: ${fetched}`);
    }
    finally { await store.close(); }
  });
});

describe('entities: a string operator takes the members the database and the engine both hold as strings', () => {
  const WORDS_DDL = (/** @type {string} */ prefix) => `CREATE TABLE ${prefix}words (wid integer PRIMARY KEY, plain text NOT NULL, `
    + 'gap text, hole text, maybe text, tally integer NOT NULL, day text NOT NULL);\n'
    + `INSERT INTO ${prefix}words VALUES (1, 'a', 'g', 'h', 'm', 5, '2024-01-01T00:00:00Z');\n`
    + `INSERT INTO ${prefix}words VALUES (2, 'b', NULL, NULL, NULL, 6, '2024-01-02T00:00:00Z');\n`
    + `INSERT INTO ${prefix}words VALUES (3, 'c', 'x', 'y', 'z', 7, '2024-01-03T00:00:00Z');`;
  const column = (/** @type {string} */ name, /** @type {string} */ codec, /** @type {string} */ policy) => ({ name, codec, null: policy });
  const wordsModel = (/** @type {string | null} */ schema) => ({ $model: '0.1', entities: { Word: {
    schema: { type: 'object', required: ['wid'], properties: {
      wid: { type: 'integer', 'x-entity': { key: true } },
      plain: { type: 'string' }, gap: { type: 'string' }, hole: { type: 'string' },
      maybe: { type: ['string', 'null'] }, tally: { type: 'integer' }, day: { type: 'string', format: 'date-time' } } },
    physical: { ...(schema === null ? {} : { schema }), table: 'words', columns: {
      wid: column('wid', 'integer', 'reject'), plain: column('plain', 'text', 'reject'),
      gap: column('gap', 'text', 'absent'), hole: column('hole', 'text', 'null'), maybe: column('maybe', 'text', 'null'),
      tally: column('tally', 'integer', 'reject'), day: column('day', 'datetime', 'reject') } },
  } } });
  const over = (/** @type {string} */ member, /** @type {string} */ operator = '$upper') =>
    ({ $count: { $for: { w: '$.Word[*]' }, $return: { w: '$w.wid', v: { [operator]: `$w.${member}` } } } });

  /** member → whether the count is native, and the code the engine raises over the table's rows */
  const MEMBERS = /** @type {[string, boolean, string | undefined][]} */ ([
    ['plain', true, undefined], // text, NOT NULL
    ['gap', true, undefined], // text, a NULL is a member that is not there
    ['hole', false, 'JQ2001'], // text, a NULL is a present `null` the schema does not mention
    ['maybe', false, 'JQ2001'], // text, a NULL is a present `null` the schema mentions
    ['tally', false, 'JQ2001'], // an integer column, which the engine's string operators refuse
    ['day', false, undefined], // a text column read through the datetime codec
  ]);

  it('only a column that stores text and reads no NULL as a null is a string for the planner', async () => {
    await onBothEnginesPhysical(wordsModel, WORDS_DDL, async (store, host) => {
      for (const [member, native, raises] of MEMBERS) {
        for (const operator of ['$upper', '$lower', '$string-length']) {
          const label = `${host}: ${operator} of ${member}`;
          const document = over(member, operator);
          const explained = await store.explain(document);
          assert.equal(explained.mode, native ? 'native' : 'set', label);
          if (!native) assert.equal(reasonId(explained.residual.reasons[0].reason), 'entity.projection', label);
          const run = await outcome(() => store.execute(document));
          const engine = await outcome(() => store.execute(document, { pushdown: false }));
          assert.deepEqual(run, engine, label);
          assert.equal(run.code, raises, label);
          if (raises === undefined) assert.equal(run.value, 3, label);
        }
      }
    });
  });

  it('a presence test and a default take every member, whatever the column holds', async () => {
    await onBothEnginesPhysical(wordsModel, WORDS_DDL, async (store, host) => {
      for (const [member] of MEMBERS) {
        for (const document of [
          { $count: { $for: { w: '$.Word[*]' }, $return: { v: { $exists: `$w.${member}` }, c: { $count: `$w.${member}` } } } },
          { $count: { $for: { w: '$.Word[*]' }, $return: { v: { $default: [`$w.${member}`, 'none'] } } } },
        ]) {
          const label = `${host}: ${member}`;
          const run = await outcome(() => store.execute(document));
          assert.deepEqual(run, await outcome(() => store.execute(document, { pushdown: false })), label);
          assert.equal(run.value, 3, label);
        }
      }
      // a column is counted without being read, whatever it holds; PostgreSQL keeps a column that reads a NULL
      // as a present `null`, and a date read through a codec, out of every native statement, so their paths
      // are no member paths there
      const unaddressable = host === 'postgres' ? ['hole', 'maybe', 'day'] : [];
      for (const [member] of MEMBERS) {
        const explained = await store.explain({ $count: { $for: { w: '$.Word[*]' }, $return: { v: { $exists: `$w.${member}` } } } });
        assert.equal(explained.mode, unaddressable.includes(member) ? 'set' : 'native', `${host}: $exists of ${member}`);
      }
    });
  });

  it('an epoch column keeps a number beside the string and proves nothing: the count stays in the engine', async () => {
    const model = { $model: '0.1', entities: { Event: { schema: { type: 'object', required: ['eid'], properties: {
      eid: { type: 'integer', 'x-entity': { key: true } }, label: { type: 'string' },
      at: { type: 'string', format: 'date-time', 'x-entity': { column: 'integer' } } } } } } };
    await onBothEngines(model, async (store, host) => {
      await store.entity('Event').create({ eid: 1, label: 'a', at: '2024-01-01T00:00:00Z' });
      await store.entity('Event').create({ eid: 2, label: 'b' });
      const counted = (/** @type {string} */ member) => ({ $count: { $for: { e: '$.Event[*]' }, $return: { v: { $upper: `$e.${member}` } } } });
      assert.equal((await store.explain(counted('label'))).mode, 'native', host);
      assert.equal((await store.explain(counted('at'))).mode, 'set', host);
      for (const member of ['label', 'at']) {
        assert.deepEqual(await outcome(() => store.execute(counted(member))), { value: 2 }, `${host}: ${member}`);
      }
    });
  });
});
