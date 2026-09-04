//@ts-check
/**
 * @file The differential oracle (D3, D8): the whole corpus in four
 * modes — native (pushdown on), native over a store with every declared
 * index REMOVED (so the same documents reach a plan with no generated
 * column to read: a promotion that only agrees where an index exists is
 * not a promotion), forced-residual (pushdown off, the regression net
 * for future pushdown work), and generated (a seeded property sweep
 * over the pushable grammar; no `Math.random`, one fixed seed, a flaky
 * oracle is worse than none). Reading the engine's
 * published AST removed *syntactic* drift; this suite is what closes
 * the *semantic* gap — SQL affinity, collation and null propagation
 * against Jaren's JSON types and empty sequences. The construct
 * coverage table prints at the end; an uncovered construct is an open
 * finding, not a silent gap.
 */

import { describe, it, after } from 'node:test';
import * as assert from 'node:assert';

import {
  loadGroups, storeForGroup, runCase, recordConstructs, coverageTable,
  DEFAULT_SCHEMA, DEFAULT_INDEXES,
} from './oracle/harness.js';
import { mulberry32 } from '@jarenjs/core/random';

const startedAt = process.hrtime.bigint();
const tally = new Map();
const groups = loadGroups();

for (const [mode, side] of /** @type {const} */ ([
  ['native', 'indexed'], ['native', 'unindexed'], ['residual', 'indexed'],
])) {
  const label = mode === 'native' ? `native mode, ${side}` : `${mode} mode`;
  describe(`oracle corpus — ${label}`, () => {
    for (const group of groups) {
      describe(group.group, () => {
        /** @type {any} */
        let opened = null;
        const openOnce = async () => {
          if (opened === null) opened = await storeForGroup(group, undefined, side);
          return opened;
        };
        for (const kase of group.cases) {
          it(kase.name, async () => {
            if (mode === 'native' && side === 'indexed') recordConstructs(kase.query, tally);
            const { collection } = await openOnce();
            const divergence = await runCase(collection, group.documents, kase, mode);
            assert.strictEqual(divergence, null,
              divergence === null ? '' : `${group.group}/${kase.name} [${label}] diverged\n`
                + `  sql:      ${divergence.sql ?? '<none>'}\n`
                + `  engine:   ${JSON.stringify(divergence.expected)}\n`
                + `  pushdown: ${JSON.stringify(divergence.actual)}`);
          });
        }
        after(async () => {
          if (opened !== null) await opened.store.close();
        });
      });
    }
  });
}

describe('oracle — generated mode (seeded)', () => {
  const random = mulberry32(0x5eed_09);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const chance = (p) => random() < p;
  const int = (max) => Math.floor(random() * max);

  const STRINGS = ['ada', 'kid', 'lin', 'zed', 'αβγ', 'a b', 'Z'];

  const generateDocuments = () => {
    const documents = [];
    const count = 12 + int(8);
    for (let i = 0; i < count; i++) {
      /** @type {any} */
      const doc = { id: `r${i}` };
      if (chance(0.8)) doc.n = int(50) - 10;
      if (chance(0.85)) doc.s = pick(STRINGS);
      if (chance(0.6)) doc.f = (int(400) - 200) / 8;
      if (chance(0.55)) doc.b = chance(0.5);
      if (chance(0.35)) doc.u = pick([null, 'text', 9, true]);
      if (chance(0.45)) doc.o = { k: int(5) };
      documents.push(doc);
    }
    return documents;
  };

  const generateConjunct = (externals) => {
    switch (int(9)) {
      case 0: return { [pick(['$eq', '$ne', '$lt', '$le', '$gt', '$ge'])]: ['$it.n', int(40) - 5] };
      case 1: return { [pick(['$eq', '$ne', '$gt'])]: ['$it.s', pick(STRINGS)] };
      case 2: return { [pick(['$lt', '$ge'])]: ['$it.f', (int(100) - 50) / 4] };
      case 3: return { $eq: ['$it.b', chance(0.5)] };
      case 4: return { [pick(['$exists', '$empty'])]: pick(['$it.n', '$it.s', '$it.u', '$it.o.k']) };
      case 5: return { [pick(['$starts-with', '$contains', '$ends-with'])]: ['$it.s', pick(['a', 'd', 'Z', 'β'])] };
      case 6: return { $eq: ['$it.n', pick(['x', true, null]) ] };
      case 7: return { $eq: ['$it.u', pick([null, 'text', 9]) ] };
      case 8: {
        externals.x = int(30);
        return { [pick(['$ge', '$lt', '$eq'])]: ['$it.n', '$x'] };
      }
      default: return { $exists: '$it.n' };
    }
  };

  const generateCase = () => {
    /** @type {any} */
    const externals = {};
    /** @type {any} */
    const query = { $for: { it: '$[*]' } };
    if (chance(0.1)) query.$let = { d: { $default: ['$it.n', 0] } };
    if (chance(0.85)) {
      const conjuncts = Array.from({ length: 1 + int(3) },
        () => generateConjunct(externals));
      query.$where = conjuncts.length === 1
        ? conjuncts[0]
        : chance(0.25) && conjuncts.length === 2
          ? { $or: conjuncts }
          : { $and: conjuncts };
      if (chance(0.15)) query.$where = { $not: query.$where };
    }
    if (chance(0.5)) {
      query.$orderby = [chance(0.5)
        ? `$it.${pick(['n', 's'])}`
        : { $key: `$it.${pick(['n', 's'])}`, $dir: pick(['asc', 'desc']),
          $empty: pick(['least', 'greatest']) }];
    }
    query.$return = chance(0.25)
      ? { i: '$it.id', v: { $default: ['$it.n', -1] } }
      : chance(0.15) ? '$it.id' : '$it';
    /** @type {any} */
    let document = query;
    if (chance(0.3))
      document = { $subsequence: [document, int(4), 2 + int(6)] };
    if (chance(0.15) && document === query && query.$return === '$it')
      document = { [pick(['$count'])]: query };
    return { query: document, externals };
  };

  const CASES = 120;
  /** @type {any} */
  let opened = null;
  const documents = generateDocuments();

  it(`agrees on ${CASES} seeded cases in both modes`, async () => {
    opened = await storeForGroup(
      { documents, schema: DEFAULT_SCHEMA, indexes: DEFAULT_INDEXES });
    for (let i = 0; i < CASES; i++) {
      const kase = generateCase();
      recordConstructs(kase.query, tally);
      for (const mode of /** @type {const} */ (['native', 'residual'])) {
        const divergence = await runCase(opened.collection, documents, kase, mode);
        assert.strictEqual(divergence, null,
          divergence === null ? '' : `generated #${i} [${mode}] diverged\n`
            + `  query:    ${JSON.stringify(kase.query)}\n`
            + `  sql:      ${divergence.sql ?? '<none>'}\n`
            + `  engine:   ${JSON.stringify(divergence.expected)}\n`
            + `  pushdown: ${JSON.stringify(divergence.actual)}`);
      }
    }
  });

  after(async () => {
    if (opened !== null) await opened.store.close();
  });
});

describe('oracle — coverage is measured, not asserted', () => {
  it('prints the construct table; uncovered constructs are named findings', () => {
    const { table, missing } = coverageTable(tally);
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    process.stdout.write('\noracle construct coverage (cases touching each):\n'
      + table
      + `\noracle wall clock: ${elapsedMs.toFixed(0)} ms\n`
      + (missing.length === 0
        ? 'every rostered construct is exercised\n'
        : `OPEN FINDINGS — uncovered constructs: ${missing.join(', ')}\n`));
    // the roster rows the corpus MUST cover (the pushdown table);
    // anything else uncovered prints as a finding without failing
    for (const required of ['$eq', '$ne', '$lt', '$gt', '$and', '$or', '$not',
      '$exists', '$empty', '$starts-with', '$orderby', '$subsequence',
      '$count', '$sum', '$min', '$let', 'external', 'null-literal',
      'cross-type', 'object-return']) {
      assert.strictEqual(tally.has(required), true,
        `the corpus must cover ${required}`);
    }
  });
});
