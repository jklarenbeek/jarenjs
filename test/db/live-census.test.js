//@ts-check
/**
 * @file The live census (LIVE-FORMAT §7): one model, one seed and a
 * corpus of documents across the maintenance table's rows, window,
 * group, distinct, nested-group, join and graph strategies and the
 * boundary it re-runs. Each document registers on a fresh store, and the
 * census pins what the classifier reports: `live.mode` exactly, every
 * re-run's reason included, and a demanded `mode: 'incremental'`
 * accepted where the shape is maintained and refused `JD0051`, naming
 * the reason, where it re-runs. After every committed write the result
 * equals a fresh run of the same document and a consumer mirror rebuilt
 * from the patches alone. Each shape names the row of the maintenance
 * table it instantiates, and that row must name the strategy the
 * classifier reports, so a classifier change or a table edit that moves
 * a shape fails here, by the shape's name. A load specification is no
 * live document (`JD0033`), and a join whose cached roots exceed
 * `live.maxMaintained` refuses (`JD2060`).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { fromAsync } from '@jarenjs/linq';
import { open } from '@jarenjs/linq/db';

import { liveOracle } from './oracle/replication.js';

const KEY = { 'x-entity': { key: true } };
const MODEL = {
  $model: '0.1',
  entities: {
    Author: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string', ...KEY }, name: { type: 'string' }, rank: { type: 'number' },
      mentor: { type: 'string', 'x-entity': { index: true } },
      posts: { 'x-entity': { relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' } } } } } },
    Post: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string', ...KEY }, title: { type: 'string' }, editor: { type: 'string' },
      score: { type: 'number' } } } },
    Parent: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string', ...KEY }, name: { type: 'string' },
      tags: { 'x-entity': { relation: { to: 'Tag', many: true } } } } } },
    Tag: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string', ...KEY }, label: { type: 'string' } } } },
  },
  collections: {
    rows: { key: '/id', schema: { type: 'object', properties: {
      id: { type: 'string' }, region: { type: 'string' }, team: { type: 'string' }, score: { type: 'number' },
      weight: { type: 'integer' } } } },
  },
};

/** Four authors in a mentor chain, six posts, two parents over three tags and twelve rows, in one commit. */
async function seed(store) {
  await store.transaction(async (tx) => {
    for (const [id, mentor, rank] of [['a1', null, 1], ['a2', 'a1', 5], ['a3', 'a1', 3], ['a4', 'a2', 8]]) {
      await tx.entity('Author').create({ id, name: id.toUpperCase(), rank, ...(mentor ? { mentor } : {}) });
    }
    for (const [id, authorId, editor, score] of [['p1', 'a1', 'a3', 2], ['p2', 'a1', 'a2', 6], ['p3', 'a2', 'a3', 4],
      ['p4', 'a3', 'a1', 9], ['p5', 'a3', 'a4', 1], ['p6', 'a4', 'a1', 7]]) {
      await tx.entity('Post').create({ id, authorId, editor, score, title: `T${id}` });
    }
    for (const id of ['t1', 't2', 't3']) await tx.entity('Tag').create({ id, label: id.toUpperCase() });
    await tx.entity('Parent').create({ id: 'P1', name: 'one', tags: ['t1', 't2'] });
    await tx.entity('Parent').create({ id: 'P2', name: 'two', tags: ['t2'] });
    for (let i = 1; i <= 12; i++) {
      await tx.collection('rows').put({ id: `r${i}`, region: ['west', 'east', 'north'][i % 3],
        team: ['x', 'y', 'z', 'w'][i % 4], score: i, weight: i % 5 });
    }
  });
}

/** Entity writes, one commit each: insert, move to another author, rename and re-mentor, delete, link, unlink, relabel, insert. */
const ENTITY_WRITES = [
  (s) => s.entity('Post').create({ id: 'p7', authorId: 'a2', editor: 'a1', score: 5, title: 'Tp7' }),
  (s) => s.entity('Post').update('p1', { authorId: 'a3', score: 9 }),
  (s) => s.entity('Author').update('a1', { name: 'A1x', rank: 7, mentor: 'a4' }),
  (s) => s.entity('Post').delete('p2'),
  (s) => { s.entity('Parent').link('P2', 'tags', 't3'); return s.saveChanges(); },
  (s) => { s.entity('Parent').unlink('P1', 'tags', 't1'); return s.saveChanges(); },
  (s) => s.entity('Tag').update('t2', { label: 'T2x' }),
  (s) => s.entity('Author').create({ id: 'a5', name: 'A5', rank: 0, mentor: 'a1' }),
];
/** Collection writes, one commit each: insert, move to another group, delete, move to a new team, change a row that keeps matching. */
const ROW_WRITES = [
  (s) => s.collection('rows').put({ id: 'r13', region: 'west', team: 'x', score: 3 }),
  (s) => s.collection('rows').put({ id: 'r1', region: 'east', team: 'y', score: 11 }),
  (s) => s.collection('rows').delete('r2'),
  (s) => s.collection('rows').put({ id: 'r3', region: 'north', team: 'q', score: 0 }),
  (s) => s.collection('rows').put({ id: 'r5', region: 'east', team: 'z', score: 8 }),
];

const JOIN = { $for: { p: '$.Post[*]', a: '$.Author[*]' }, $where: { $eq: ['$p.authorId', '$a.id'] },
  $return: { id: '$p.id', who: '$a.name' } };
const CHILD_IDS = [{ $for: { p: '$.Post[*]' }, $where: { $eq: ['$p.authorId', '$a.id'] }, $return: '$p.id' }];
const GRAPH = { $for: { a: '$.Author[*]' }, $return: { id: '$a.id', posts: CHILD_IDS } };
const GROUP = { $for: { r: '$[*]' }, $groupby: { g: '$r.region' },
  $return: { key: '$g', n: { $count: '$r' }, total: { $sum: '$r.score' } } };
const NESTED = { $for: { row: '$[*]' }, $groupby: { region: '$row.region' }, $return: { region: '$region',
  teams: [{ $for: { leaf: '$row' }, $groupby: { team: '$leaf.team' }, $return: { team: '$team', n: { $count: '$leaf' } } }] } };
const ORDERED = (orderby) => ({ $for: { r: '$[*]' }, $orderby: orderby, $return: '$r' });

const maintained = (strategy) => ({ strategy, mode: 'incremental' });
const rerun = (reason) => ({ strategy: 'rerun', mode: 'rerun', reason });
const DECODED = 'entity dependency plan: this entity return or grouping needs decoded-row evaluation';
// the child query correlates on a foreign key the schema declares no property for, so no comparison family is known
const HOP_SHAPE = 'entity dependency plan: a navigation hop translates only as one plain correlated FLWOR whose '
  + 'correlation equates mapped columns of one comparison family that admit no null';
const SET_LEVEL = 'this grouping or distinct projection needs set-level maintenance';
const PROFILED = "the store profile's predicates, member lists and limits apply to every read, which maintenance does not repeat";
const ROW_ALONE = 'a projection that reads the collection root re-runs (a row is evaluated alone)';

/**
 * @typedef {object} Shape
 * @property {string} name - what the document is
 * @property {'entity' | 'rows'} on - `store.live`, or the `rows` collection's `live`
 * @property {any} document - the registered document, or a function of the store that builds it
 * @property {string} row - a phrase of the one maintenance-table row the document instantiates
 * @property {{ strategy: string, mode: string, reason?: string }} mode - `live.mode` as registered
 * @property {any} [reference] - the document a fresh run answers with, when it is not the registered one
 * @property {boolean} [multiset] - the result is compared as a multiset
 * @property {Record<string, unknown>} [externals] - bound at registration and in every fresh run
 * @property {any} [profile] - the store profile the store is opened with
 */

/** @type {Shape[]} */
const SHAPES = [
  { name: 'an indexed equi-join over a foreign key', on: 'entity', document: [JOIN],
    row: 'indexed inner equi-joins', mode: maintained('join') },
  { name: 'a self join over an indexed column (each author and the mentor it names)', on: 'entity',
    document: [{ $for: { a: '$.Author[*]', m: '$.Author[*]' }, $where: { $eq: ['$a.mentor', '$m.id'] },
      $return: { a: '$a.id', m: '$m.id' } }],
    row: 'flat self joins included', mode: maintained('join') },
  { name: 'a self join over a foreign key (the posts sharing an author)', on: 'entity',
    document: [{ $for: { p: '$.Post[*]', q: '$.Post[*]' }, $where: { $eq: ['$p.authorId', '$q.authorId'] },
      $return: { p: '$p.id', q: '$q.id' } }],
    row: 'flat self joins included', mode: maintained('join') },
  { name: 'an equality join refined by a non-equality term', on: 'entity',
    document: [{ ...JOIN, $where: { $and: [{ $eq: ['$p.authorId', '$a.id'] }, { $lt: ['$p.score', '$a.rank'] }] } }],
    row: 'unindexed/non-equi joins', mode: rerun('a non-equality join refinement re-runs') },
  { name: 'a non-equality join alone (a cartesian product)', on: 'entity',
    document: [{ ...JOIN, $where: { $lt: ['$p.score', '$a.rank'] } }],
    row: 'unindexed/non-equi joins',
    mode: rerun('entity dependency plan: every binding past the first needs a column equality to one already joined '
      + '— a binding nothing connects is a cartesian product, which is engine work') },
  { name: 'an equi-join over a column with no declared index', on: 'entity',
    document: [{ ...JOIN, $where: { $eq: ['$p.editor', '$a.id'] } }],
    row: 'unindexed/non-equi joins', mode: rerun("join dependency 'p.editor' has no declared index") },
  { name: 'a many-to-many join on the owning side\'s key', on: 'entity',
    document: [{ $for: { p: '$.Parent[*]', j: '$.Parent_Tag[*]' }, $where: { $eq: ['$j.Parent_key', '$p.id'] },
      $return: { p: '$p.id', t: '$j.Tag_key' } }],
    row: 'indexed inner equi-joins', mode: maintained('join') },
  { name: 'an allowing-empty (left) join over a foreign key', on: 'entity',
    document: [{ $for: { p: '$.Post[*]', a: { $in: { $for: { m: '$.Author[*]' }, $where: { $eq: ['$m.id', '$p.authorId'] },
      $return: '$m' }, '$allowing-empty': true } }, $return: { id: '$p.id', who: { $default: ['$a.name', null] } } }],
    row: 'canonical allowing-empty left joins', mode: maintained('join') },
  { name: 'a many-to-many join on the target\'s key', on: 'entity',
    document: [{ $for: { t: '$.Tag[*]', j: '$.Parent_Tag[*]' }, $where: { $eq: ['$j.Tag_key', '$t.id'] },
      $return: { t: '$t.id', p: '$j.Parent_key' } }],
    row: 'unindexed/non-equi joins', mode: rerun("join dependency 'j.Tag_key' has no declared index") },
  { name: 'a three-way many-to-many join through the join table', on: 'entity',
    document: [{ $for: { p: '$.Parent[*]', j: '$.Parent_Tag[*]', t: '$.Tag[*]' },
      $where: { $and: [{ $eq: ['$j.Parent_key', '$p.id'] }, { $eq: ['$j.Tag_key', '$t.id'] }] },
      $return: { p: '$p.id', label: '$t.label' } }],
    row: 'unindexed/non-equi joins', mode: rerun("join dependency 'j.Tag_key' has no declared index") },
  { name: 'an ordered entity join', on: 'entity', document: [{ ...JOIN, $orderby: '$p.id' }],
    row: 'explicit entity ordering/windows',
    mode: rerun('an explicitly ordered entity join has no maintained ordering') },
  { name: 'a limit window over an entity join', on: 'entity', document: [{ $subsequence: [JOIN, 0, 3] }],
    row: 'explicit entity ordering/windows', mode: rerun('an entity offset or limit window re-runs') },
  { name: 'an offset window over an ordered entity join', on: 'entity',
    document: [{ $subsequence: [{ ...JOIN, $orderby: '$p.id' }, 1, 3] }],
    row: 'explicit entity ordering/windows', mode: rerun('an entity offset or limit window re-runs') },
  { name: 'a graph projection whose child query is ordered and windowed', on: 'entity',
    document: [{ $for: { a: '$.Author[*]' }, $return: { id: '$a.id', top: [{ $subsequence: [{ $for: { p: '$.Post[*]' },
      $where: { $eq: ['$p.authorId', '$a.id'] }, $orderby: '$p.score', $return: '$p.id' }, 0, 2] }] } }],
    row: 'a graph projection whose child query is ordered', mode: rerun(DECODED) },
  { name: 'a graph projection whose child query is windowed without an ordering', on: 'entity',
    document: [{ $for: { a: '$.Author[*]' }, $return: { id: '$a.id', first: [{ $subsequence: [CHILD_IDS[0], 1, 2] }] } }],
    row: 'windowed without an ordering (literal, quoted or external bounds', mode: maintained('graph') },
  { name: 'a graph projection whose child query is windowed by external bounds', on: 'entity', externals: { from: 1, size: 1 },
    document: [{ $for: { a: '$.Author[*]' }, $return: { id: '$a.id', next: [{ $subsequence: [CHILD_IDS[0], '$from', '$size'] }] } }],
    row: 'windowed without an ordering (literal, quoted or external bounds', mode: maintained('graph') },
  { name: 'a graph projection counting each owner\'s children', on: 'entity',
    document: [{ $for: { a: '$.Author[*]' }, $return: { id: '$a.id', n: { $count: { $for: { p: '$.Post[*]' },
      $where: { $eq: ['$p.authorId', '$a.id'] }, $return: '$p' } } } }],
    row: 'nested entity graph projections', mode: maintained('graph') },
  { name: 'a graph projection listing each owner\'s children', on: 'entity', document: [GRAPH],
    row: 'nested entity graph projections', mode: maintained('graph') },
  { name: 'a projection counting an entity root outside any child query', on: 'entity',
    document: [{ $for: { a: '$.Author[*]' }, $return: { id: '$a.id', total: { $count: '$.Post[*]' } } }],
    row: 'reads an entity root outside its child queries', mode: rerun(DECODED) },
  { name: 'a graph projection beside a count of an entity root', on: 'entity',
    document: [{ $for: { a: '$.Author[*]' }, $return: { id: '$a.id', posts: CHILD_IDS, total: { $count: '$.Post[*]' } } }],
    row: 'reads an entity root outside its child queries', mode: rerun(HOP_SHAPE) },
  { name: 'an aggregate over an entity join', on: 'entity', document: [{ $count: JOIN }],
    row: 'an entity aggregate', mode: rerun('an entity aggregate has no bounded tuple accumulator') },
  { name: 'an object-root entity document', on: 'entity',
    document: [{ authors: { $count: '$.Author[*]' }, posts: { $count: '$.Post[*]' } }],
    row: 'object-root documents', mode: rerun('entity dependency plan: only a FLWOR over entity arrays is translated') },
  // maintenance appends and splices an unordered result's rows (LIVE-FORMAT §9)
  { name: 'the rows a translated where selects', on: 'rows', multiset: true,
    document: [{ $for: { r: '$[*]' }, $where: { $gt: ['$r.score', 2] }, $return: '$r' }],
    row: '`where` whose predicates translate', mode: maintained('rows') },
  { name: 'the rows a translated where selects, each projected', on: 'rows', multiset: true,
    document: [{ $for: { r: '$[*]' }, $where: { $gt: ['$r.score', 2] }, $return: { id: '$r.id', next: { $add: ['$r.score', 1] } } }],
    row: 'per-row `select` projection (row-mode plan)', mode: maintained('rows') },
  { name: 'a count of the rows a translated where selects', on: 'rows',
    document: [{ $count: { $for: { r: '$[*]' }, $where: { $gt: ['$r.score', 3] }, $return: '$r' } }],
    row: 'whole-query `count` / `min` / `max`', mode: maintained('accumulator') },
  { name: 'the least value of a member', on: 'rows', document: [{ $min: { $for: { r: '$[*]' }, $return: '$r.score' } }],
    row: 'whole-query `count` / `min` / `max`', mode: maintained('accumulator') },
  { name: 'a sum over a number member', on: 'rows', document: [{ $sum: { $for: { r: '$[*]' }, $return: '$r.score' } }],
    row: '`sum` / `avg` over a `number` member',
    mode: rerun("'$sum' — a floating sum or average runs in the engine, whose left-to-right addition decides "
      + 'the rounding a native sum would not reproduce') },
  { name: 'an unordered distinct projection', on: 'rows',
    document: [{ $distinct: { $for: { r: '$[*]' }, $return: '$r.team' } }],
    row: 'unordered SQL-native typed scalar distinct projections', mode: maintained('distinct') },
  { name: 'an ordered distinct projection', on: 'rows',
    document: [{ $distinct: { $for: { r: '$[*]' }, $orderby: '$r.team', $return: '$r.team' } }],
    row: 'ordered or windowed distinct', mode: rerun(SET_LEVEL) },
  { name: 'a windowed distinct projection', on: 'rows',
    document: [{ $subsequence: [{ $distinct: { $for: { r: '$[*]' }, $return: '$r.team' } }, 0, 2] }],
    row: 'ordered or windowed distinct', mode: rerun(SET_LEVEL) },
  { name: 'a group returning its key, a count and a sum', on: 'rows', document: [GROUP],
    row: 'single-level `groupBy` with one or more keys', mode: maintained('group') },
  { name: 'a sum over groups', on: 'rows', document: [{ $sum: { ...GROUP, $return: { $sum: '$r.score' } } }],
    row: 'count/sum/avg/min/max over unwindowed single-level groups', mode: maintained('group') },
  { name: 'a maximum over groups returning arithmetic over their sums', on: 'rows',
    document: [{ $max: { ...GROUP, $return: { $add: [{ $sum: '$r.score' }, 1] } } }],
    row: 'count/sum/avg/min/max over unwindowed single-level groups', mode: maintained('group') },
  { name: 'a group returning its rows whole', on: 'rows',
    document: [{ ...GROUP, $return: { key: '$g', items: ['$r'] } }],
    row: 'single-level `groupBy` with one or more keys', mode: maintained('group') },
  { name: 'a sum over a window of groups', on: 'rows',
    document: [{ $sum: { $subsequence: [{ ...GROUP, $return: { $sum: '$r.score' } }, 0, 2] } }],
    row: 'aggregates over windowed groups', mode: rerun('a windowed aggregate maintains no accumulator') },
  { name: 'ordered groups', on: 'rows', document: [{ ...GROUP, $orderby: '$g' }],
    row: 'ordered or windowed groups',
    mode: rerun("'$groupby' — a floating sum or average runs in the engine, whose left-to-right addition decides "
      + 'the rounding a native sum would not reproduce') },
  // an integer sum orders natively, and a group that orders is still set-level work for maintenance
  { name: 'groups ordered by an integer sum', on: 'rows',
    document: [{ ...GROUP, $orderby: [{ $key: { $sum: '$r.weight' }, $dir: 'desc' }],
      $return: { key: '$g', total: { $sum: '$r.weight' } } }],
    row: 'ordered or windowed groups', mode: rerun(SET_LEVEL) },
  { name: 'one groupBy followed by select, as @jarenjs/linq emits it', on: 'rows',
    document: (s) => fromAsync(s.collection('rows')).groupBy((r) => r.region)
      .select((g) => ({ key: g.key, n: g.items.count() })).toDocument(),
    row: "`@jarenjs/linq`'s one `groupBy` followed by `select`/`where` steps", mode: maintained('group') },
  { name: 'a group of groups, as @jarenjs/linq emits groupBy().groupBy()', on: 'rows',
    document: (s) => fromAsync(s.collection('rows')).groupBy((r) => r.region).groupBy((g) => g.items.count()).toDocument(),
    row: 'nested two-level `groupBy` emission (a group of groups)',
    mode: rerun("'$for' — only a single plain binding over the whole collection is translated") },
  { name: 'an explicit two-level nested group', on: 'rows', document: [NESTED],
    row: 'explicit two-level collection groups', mode: maintained('nested-group') },
  // a window breaks ties by the collection key's text (LIVE-FORMAT §9): its
  // fresh run is the document with the key appended to the order
  { name: 'an offset window over an ordered query', on: 'rows',
    document: [{ $subsequence: [ORDERED('$r.score'), 1, 3] }],
    reference: [{ $subsequence: [ORDERED(['$r.score', '$r.id']), 1, 3] }],
    row: '`orderBy` over extractable paths, an optional literal offset and limit', mode: maintained('window') },
  { name: 'an offset window over nested groups', on: 'rows', document: [{ $subsequence: [NESTED, 1, 3] }],
    row: 'an offset or limit over a group, distinct projection, aggregate or nested group',
    mode: rerun('a windowed group re-runs') },
  { name: 'a top-k window over an ordered query', on: 'rows',
    document: [{ $subsequence: [ORDERED('$r.score'), 0, 3] }],
    reference: [{ $subsequence: [ORDERED(['$r.score', '$r.id']), 0, 3] }],
    row: '`orderBy` over extractable paths, an optional literal offset and limit', mode: maintained('window') },
  { name: 'a projection that reads the collection root', on: 'rows',
    document: [{ $for: { r: '$[*]' }, $where: { $gt: ['$r.score', 2] }, $return: { id: '$r.id', total: { $count: '$[*]' } } }],
    row: 'a query whose filter or return reads the collection root', mode: rerun(ROW_ALONE) },
  // a profile applies to every read execute makes, and maintenance repeats none of it
  { name: 'rows on a store opened with a profile predicate', on: 'rows',
    profile: { predicates: { rows: { $ne: ['$it.region', 'north'] } } },
    document: [{ $for: { r: '$[*]' }, $where: { $gt: ['$r.score', 2] }, $return: '$r.id' }],
    row: 'any document on a store opened with a `profile`', mode: rerun(PROFILED) },
  { name: 'an indexed equi-join on a store opened with engine limits alone', on: 'entity',
    profile: { limits: { steps: 100_000 } }, document: [JOIN],
    row: 'any document on a store opened with a `profile`', mode: rerun(PROFILED) },
];

/** The bold phrase opening the Strategy cell of a strategy's rows in the maintenance table. */
const STRATEGY_CELL = {
  rows: 'incremental rows', window: 'maintained window', accumulator: 'running accumulator', group: 'group maintenance',
  distinct: 'distinct maintenance', 'nested-group': 'nested-group maintenance',
  join: 'join dependency maintenance', graph: 'graph dependency maintenance', rerun: 're-run on invalidation',
};

const LIVE_FORMAT = fs.readFileSync(new URL('../../packages/db/docs/LIVE-FORMAT.md', import.meta.url), 'utf8');

/**
 * The maintenance table of LIVE-FORMAT §7, one `{ construct, strategy }`
 * per row; a row that does not split into three cells fails.
 * @returns {{ construct: string, strategy: string }[]}
 */
function maintenanceTable() {
  const lines = LIVE_FORMAT.split('\n');
  const header = lines.indexOf('| Construct (as planned) | Strategy | Maintained state |');
  assert.ok(header > 0, 'LIVE-FORMAT §7 carries the maintenance table');
  const rows = [];
  for (let line = header + 2; lines[line]?.startsWith('|'); line++) {
    const cells = lines[line].split('|').slice(1, -1).map((cell) => cell.trim());
    assert.equal(cells.length, 3, `LIVE-FORMAT.md:${line + 1} is a row of three cells`);
    rows.push({ construct: cells[0], strategy: cells[1] });
  }
  return rows;
}

/**
 * A fresh run holding exactly the rows the live result holds, in the
 * live result's order; any other fresh run as it is, so the comparison
 * names the difference.
 */
function sameRowsInLiveOrder(fresh, held) {
  const canonical = (rows) => rows.map((row) => JSON.stringify(row)).sort();
  return isDeepStrictEqual(canonical(fresh), canonical(held)) ? held : fresh;
}

const LOAD_SPECIFICATION = {
  code: 'JD0033',
  message: 'JD0033: store.live takes an entity-root document ($.<Entity>[*]); this document names none — '
    + "a load specification is not a query document, and a collection's live query is store.collection(name).live "
    + 'at /entities',
};

describe('the live census: each shape registers as its maintenance-table row says and equals a fresh run after every write', () => {
  for (const shape of SHAPES) {
    it(shape.name, async () => {
      const rows = maintenanceTable().filter(({ construct }) => construct.includes(shape.row));
      assert.equal(rows.length, 1, `one row of the maintenance table names '${shape.row}'`);
      assert.ok(rows[0].strategy.startsWith(`**${STRATEGY_CELL[shape.mode.strategy]}**`),
        `the row naming '${shape.row}' states ${rows[0].strategy.slice(0, 40)}…, not ${shape.mode.strategy}`);

      const store = await openStore(MODEL, { driver: nodeDriver(), capture: true,
        ...(shape.profile === undefined ? {} : { profile: shape.profile }) });
      try {
        await seed(store);
        const document = typeof shape.document === 'function' ? shape.document(store) : shape.document;
        const externals = shape.externals ?? {};
        const register = (/** @type {any} */ options) => shape.on === 'entity'
          ? store.live(document, { ...options, externals }) : store.collection('rows').live(document, { ...options, externals });
        const live = await register({ mode: 'auto' });
        assert.deepEqual(live.mode, shape.mode);
        if (shape.mode.strategy === 'rerun') {
          await assert.rejects(async () => register({ mode: 'incremental' }),
            { code: 'JD0051', message: `JD0051: the demanded incremental mode is unavailable: ${shape.mode.reason}` });
        }
        else {
          const demanded = await register({ mode: 'incremental' });
          assert.deepEqual(demanded.mode, shape.mode);
          demanded.close();
        }
        const reference = shape.reference ?? (Array.isArray(document) ? document : [document]);
        const run = async () => shape.on === 'entity'
          ? store.execute(reference, { externals }) : store.collection('rows').execute(reference, { externals });
        const oracle = liveOracle(live, shape.multiset ? async () => sameRowsInLiveOrder(await run(), live.result.rows) : run);
        await oracle.check();
        for (const write of shape.on === 'entity' ? ENTITY_WRITES : ROW_WRITES) {
          await write(store);
          await oracle.check();
        }
        oracle.close();
        live.close();
      }
      finally { await store.close(); }
    });
  }

  it('a load specification handed to store.live is JD0033 and registers nothing', async () => {
    assert.ok(LIVE_FORMAT.slice(LIVE_FORMAT.indexOf('## 7.'), LIVE_FORMAT.indexOf('## 8.')).includes('`JD0033`'),
      'LIVE-FORMAT §7 names the refusal');
    const store = await openStore(MODEL, { driver: nodeDriver(), capture: true });
    try {
      await seed(store);
      await assert.rejects(async () => store.live({ include: { posts: { orderBy: '$it.score', take: 2 } } }),
        LOAD_SPECIFICATION);
      assert.equal(store.stats().liveQueries, 0);
    }
    finally { await store.close(); }
  });

  it('an include() chain handed to the client\'s live() is JD0033 and registers nothing', async () => {
    const client = await open(MODEL, { driver: nodeDriver(), capture: true, validator: null });
    try {
      await seed(client.store);
      const graph = client.entities.Author.include((/** @type {any} */ a) => a.posts,
        { orderBy: (/** @type {any} */ p) => p.score, take: 2 });
      await assert.rejects(async () => client.live(graph), LOAD_SPECIFICATION);
      assert.equal(client.store.stats().liveQueries, 0);
    }
    finally { await client.close(); }
  });

  it('a join whose cached roots exceed live.maxMaintained is JD2060, though its result is empty', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), capture: true, live: { maxMaintained: 5 } });
    try {
      for (let i = 0; i < 8; i++) await store.entity('Author').create({ id: `x${i}` });
      await assert.rejects(async () => store.live([JOIN]),
        { code: 'JD2060', message: 'JD2060: the join dependency state exceeds live.maxMaintained (5)' });
      assert.equal(store.stats().liveQueries, 0);
    }
    finally { await store.close(); }
  });
});
