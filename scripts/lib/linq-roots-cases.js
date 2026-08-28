//@ts-check
/**
 * @file The linq-roots relations group
 * (`test/db/oracle/relations/14-linq-roots.json`): every case document
 * is EMITTED by a chain over a recording provider — the whole document a
 * store receives, the terminal's wrapper included — never typed by hand,
 * so the corpus can only drift where the chain drifts.
 * `scripts/generate-linq-roots-cases.js` writes the file;
 * `test/db/relations.test.js` asserts it regenerates byte-identically and
 * runs every case native, residual and in memory.
 */

import { from } from '@jarenjs/linq';

export const MODEL = {
  $model: '0.1',
  entities: {
    User: {
      schema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', 'x-entity': { key: true } },
          name: { type: 'string' },
          age: { type: 'integer' },
          posts: { 'x-entity': { relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' } } },
        },
      },
    },
    Post: {
      schema: {
        type: 'object',
        required: ['pid', 'authorId'],
        properties: {
          pid: { type: 'integer', 'x-entity': { key: true } },
          title: { type: 'string' },
          stars: { type: 'integer' },
          authorId: { type: 'string' },
        },
      },
    },
  },
};

export const DOCUMENTS = {
  User: [
    { id: 'u1', name: 'ada', age: 36 },
    { id: 'u2', name: 'lin', age: 64 },
    { id: 'u3', name: 'kid', age: 8 },
    { id: 'u4', name: 'mo' },
  ],
  Post: [
    { pid: 1, title: 'alpha', stars: 5, authorId: 'u1' },
    { pid: 2, title: 'beta', stars: 1, authorId: 'u1' },
    { pid: 3, title: 'gamma', stars: 4, authorId: 'u2' },
    { pid: 4, title: 'delta', stars: 3, authorId: 'u1' },
    { pid: 5, title: 'epsilon', authorId: 'u2' },
    { pid: 6, title: 'ada', stars: 2, authorId: 'u4' },
  ],
};

/**
 * A recording provider over one entity root; `execute` answers a window
 * of one empty row, so every terminal completes — `first()` included —
 * and the document is what the store would have received.
 * @param {string} name
 * @param {object} scope
 * @param {any[]} calls
 */
function rootOf(name, scope, calls) {
  return {
    root: `$.${name}[*]`,
    scope,
    execute(document) {
      calls.push(document);
      return [{}];
    },
  };
}

/**
 * Build the group: each case's document is what its chain's terminal
 * handed the provider.
 * @returns {{ group: string, model: any, documents: any, cases: { name: string, query: any }[] }}
 */
export function buildLinqRootsGroup() {
  /** @type {{ name: string, query: any }[]} */
  const cases = [];
  const kase = (name, run) => {
    /** @type {any[]} */
    const calls = [];
    const scope = {};
    run(from(rootOf('Post', scope, calls)), from(rootOf('User', scope, calls)));
    if (calls.length !== 1) throw new Error(`${name}: expected one document, got ${calls.length}`);
    cases.push({ name, query: calls[0] });
  };
  kase('a filtered root', (post) => post.where((p) => p.stars.ge(3)).toArray());
  kase('an ordered window', (post) => post
    .orderByDescending((p) => p.stars).thenBy((p) => p.pid).skip(1).take(2).toArray());
  kase('a projection', (post) => post
    .where((p) => p.stars.gt(1)).select((p) => ({ id: p.pid, title: p.title.upper() })).toArray());
  kase('a two-entity join, the child returned', (post, user) => post
    .join(user, (p) => p.authorId, (u) => u.id, (p) => p).toArray());
  kase('a two-entity join, projected', (post, user) => post
    .join(user, (p) => p.authorId, (u) => u.id, (p, u) => ({ title: p.title, by: u.name })).toArray());
  kase('a group join counting the children', (post, user) => user
    .groupJoin(post, (u) => u.id, (p) => p.authorId, (u, g) => ({ id: u.id, n: g.count() })).toArray());
  kase('a count', (post) => post.where((p) => p.stars.ge(3)).count());
  kase('an any', (post) => post.any((p) => p.stars.gt(4)));
  kase('a first', (post) => post.orderBy((p) => p.pid).first());
  return { group: '14 linq roots', model: MODEL, documents: DOCUMENTS, cases };
}

/** The committed file's text: the group as the corpus spells it. */
export function renderLinqRootsGroup() {
  return JSON.stringify(buildLinqRootsGroup(), null, 2) + '\n';
}
