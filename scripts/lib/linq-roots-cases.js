//@ts-check
/**
 * @file The linq-roots relations groups
 * (`test/db/oracle/relations/14-linq-roots.json` and `15-linq-hops.json`):
 * every case document is EMITTED by a chain over a recording provider —
 * the whole document a store receives, the terminal's wrapper included —
 * never typed by hand, so the corpus can only drift where the chain
 * drifts. The hops group's providers carry the relation tables the store
 * would expose, built by the store's own `relationTables`, so a lowered
 * hop is exactly what a chain over a real entity set emits.
 * `scripts/generate-linq-roots-cases.js` writes both files;
 * `test/db/relations.test.js` asserts they regenerate byte-identically and
 * runs every case native, residual and in memory.
 */

import { from } from '@jarenjs/linq';
import { normalizeEntities, relationTables } from '@jarenjs/db';

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

//#region the hops group

/**
 * Both directions declared (`User.posts` ↔ `Post.author`, one edge over
 * `authorId`), and `authorId` NOT required, so a post without an author
 * exists: the row a to-one hop finds nothing for.
 */
export const HOPS_MODEL = {
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
        required: ['pid'],
        properties: {
          pid: { type: 'integer', 'x-entity': { key: true } },
          title: { type: 'string' },
          stars: { type: 'integer' },
          authorId: { type: 'string' },
          author: { 'x-entity': { relation: { to: 'User', via: 'authorId', onDelete: 'cascade' } } },
        },
      },
    },
  },
};

export const HOPS_DOCUMENTS = {
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
    { pid: 7, title: 'orphan', stars: 3 },
  ],
};

/**
 * A recording provider over one entity root that carries the relation
 * tables a store's entity set carries — its own under `relations`, every
 * root's under `scope.relations` — built by the store's own function.
 * @param {string} name
 * @param {{ relations: any }} scope
 * @param {any[]} calls
 */
function relatedRootOf(name, scope, calls) {
  return { ...rootOf(name, scope, calls), relations: scope.relations[name] };
}

/**
 * Build the hops group: each case's document is what its chain's
 * terminal handed the provider, the hops lowered.
 * @returns {{ group: string, model: any, documents: any, cases: { name: string, query: any }[] }}
 */
export function buildLinqHopsGroup() {
  /** @type {{ name: string, query: any }[]} */
  const cases = [];
  const scope = { relations: relationTables(normalizeEntities(HOPS_MODEL)) };
  const kase = (name, run) => {
    /** @type {any[]} */
    const calls = [];
    run(from(relatedRootOf('Post', scope, calls)), from(relatedRootOf('User', scope, calls)));
    if (calls.length !== 1) throw new Error(`${name}: expected one document, got ${calls.length}`);
    cases.push({ name, query: calls[0] });
  };
  kase('a to-one hop in the projection, one post without an author', (post) => post
    .select((p) => ({ title: p.title, by: p.author.name })).toArray());
  kase('a to-one hop in the filter', (post) => post
    .where((p) => p.author.age.ge(30)).select((p) => p.pid).toArray());
  kase('a to-one hop under an ordering, the unmatched row first', (post) => post
    .orderBy((p) => p.author.name).thenBy((p) => p.pid).select((p) => p.pid).toArray());
  kase('the absent to-one', (post) => post
    .where((p) => p.author.isEmpty()).select((p) => p.title).toArray());
  kase('a to-many count', (post, user) => user
    .where((u) => u.posts.all().count().ge(2)).select((u) => u.id).toArray());
  kase('a to-many existence', (post, user) => user
    .where((u) => u.posts.all().exists()).count());
  kase('a to-many hop as an array member', (post, user) => user
    .select((u) => ({ id: u.id, titles: [u.posts.all().title] })).toArray());
  kase('two hops chained', (post) => post
    .select((p) => ({ pid: p.pid, siblings: p.author.posts.all().count() })).toArray());
  kase('a hop from the joined it2', (post, user) => post
    .join(user, (p) => p.authorId, (u) => u.id, (p, u) => ({ title: p.title, n: u.posts.all().count() })).toArray());
  kase("a hop from a group-join's fanned group", (post, user) => user
    .groupJoin(post, (u) => u.id, (p) => p.authorId, (u, g) => ({ id: u.id, by: [g.all().author.name] })).toArray());
  kase('a hop in a first', (post) => post
    .where((p) => p.author.name.eq('lin')).orderBy((p) => p.pid).select((p) => p.title).first());
  return { group: '15 linq hops', model: HOPS_MODEL, documents: HOPS_DOCUMENTS, cases };
}

/** The committed file's text: the hops group as the corpus spells it. */
export function renderLinqHopsGroup() {
  return JSON.stringify(buildLinqHopsGroup(), null, 2) + '\n';
}

//#endregion
