//@ts-check
/**
 * @file The foreign-commit corpus every SQLite host runs (bun:sqlite under
 * Bun as well): after each of the store's read paths, a row another
 * connection commits is seen by the store's next reads. A statement a read
 * leaves active keeps the connection's read transaction, and with it the
 * snapshot, open across later statements, so each path is followed by three
 * commits, each read back by a different statement.
 */
import { asyncLive } from '@jarenjs/db/async-live';

const entity = (/** @type {Record<string, any>} */ extra) => ({ schema: { type: 'object', required: ['id'], properties: {
  id: { type: 'string', 'x-entity': { key: true } }, ...extra } } });

export const FOREIGN_COMMIT_MODEL = { $model: '0.1',
  entities: {
    P: entity({ kids: { 'x-entity': { relation: { to: 'K', many: true, via: 'pid', onDelete: 'cascade' } } } }),
    K: entity({ pid: { type: 'string' }, v: { type: 'integer' } }),
  },
  collections: {
    C: { key: '/id', schema: { type: 'object', properties: { id: { type: 'string' }, v: { type: 'integer' } } },
      indexes: [{ name: 'by_v', path: '$.v' }] },
  },
};

/** Every item a cursor yields. @param {AsyncIterable<any>} cursor */
const drain = async (cursor) => {
  const items = [];
  for await (const item of cursor) items.push(item);
  return items;
};

/** The first item a cursor yields, the cursor then abandoned. @param {AsyncIterable<any>} cursor */
const first = async (cursor) => {
  for await (const item of cursor) return item;
  return undefined;
};

const PROJECTED = { $for: { it: '$.K[*]' }, $orderby: ['$it.id'], $return: '$it.v' };
const COLLECTED = { $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: '$it.v' };
const KEYED = { $for: { it: '$.K[*]' }, $where: { $eq: ['$it.id', 'k1'] }, $return: '$it.v' };
const SCANNED = { $for: { it: '$[*]' }, $where: { $eq: ['$it.v', 1] }, $return: '$it.id' };

/** The options a store under the corpus opens with beside the host's: jobs,
 * a durable capture log and the asynchronous live host, and a profile that
 * refuses a full scan, so every read checks its statement's plan first (a
 * live query takes no profile of its own). */
export const FOREIGN_COMMIT_OPTIONS = { jobs: true, capture: { mode: 'journal', log: true } };
/** The paths that run on a store opened with the scan-refusing profile. */
const PROFILED = new Set(['collection live, scan checked', 'collection live resnapshot, scan checked']);

/** Register a live query, read its first result, and close it.
 * @param {any} c @param {any} document @param {Record<string, unknown>} [options] */
const liveOnce = async (c, document, options = {}) => {
  const live = await c.live(document, options);
  try { return live.result; }
  finally { await live.close(); }
};

/**
 * The store's read paths, by name: each reads once and ends.
 * @param {any} store
 * @returns {Record<string, () => Promise<unknown>>}
 */
export const readPaths = (store) => {
  const kids = store?.entity('K');
  const c = store?.collection('C');
  return {
    'entity get': () => kids.asNoTracking().get('k0'),
    'entity load': () => kids.asNoTracking().load({ orderBy: '$it.id' }),
    'entity page': () => kids.page({ orderBy: '$it.id' }, { limit: 1 }),
    'entity loadCursor drained': () => drain(kids.loadCursor({ orderBy: '$it.id' })),
    'entity loadCursor abandoned': () => first(kids.loadCursor({ orderBy: '$it.id' })),
    'entity cursor drained': () => drain(kids.cursor({ $for: { it: '$.K[*]' }, $orderby: ['$it.id'], $return: '$it.v' })),
    'entity cursor abandoned': () => first(kids.cursor({ $for: { it: '$.K[*]' }, $orderby: ['$it.id'], $return: '$it.v' })),
    'entity explainLoad': () => kids.explainLoad({ orderBy: '$it.id' }),
    'include load': () => store.entity('P').asNoTracking().load({ include: { kids: true } }),
    'store execute native': () => store.execute(PROJECTED),
    'store execute engine': () => store.execute(PROJECTED, { pushdown: false }),
    'store explain': () => store.explain(PROJECTED),
    'collection get': () => c.get('c0'),
    'collection all': () => c.all(),
    'collection execute native': () => c.execute(COLLECTED),
    'collection execute engine': () => c.execute(COLLECTED, { pushdown: false }),
    'collection query drained': () => drain(c.query(COLLECTED)),
    'collection query abandoned': () => first(c.query(COLLECTED)),
    // a profile that refuses a full scan reads the statement's plan first
    'collection execute, scan checked': () => c.execute(SCANNED, { profile: { refuseFullScan: true } }),
    'entity load, scan checked': () => kids.asNoTracking().load({ where: { $eq: ['$it.v', 1] } }, { profile: { refuseFullScan: true } }),
    // an entity statement whose plan the check refuses, which ends the read
    // with its error
    'store execute, scan refused': async () => {
      try { return await store.execute({ $for: { it: '$.K[*]' }, $where: { $eq: ['$it.v', 1] }, $return: '$it.id' },
        { profile: { refuseFullScan: true } }); }
      catch (error) { return /** @type {any} */ (error).code; }
    },
    'collection explain': () => c.explain(SCANNED),
    'transaction read': () => store.transaction((/** @type {any} */ tx) => tx.entity('K').asNoTracking().get('k0')),
    'jobs get': () => store.jobs.get('j0'),
    'jobs counts': () => store.jobs.counts(),
    'jobs page drained': () => drain(store.jobs.page()),
    'jobs page abandoned': () => first(store.jobs.page()),
    'collection live': () => liveOnce(c, COLLECTED),
    'collection live, scan checked': () => liveOnce(c, SCANNED),
    'collection live resnapshot, scan checked': () => liveOnce(c, SCANNED, { mode: 'resnapshot' }),
  };
};

/**
 * Run the corpus over a store `open` makes, `raw` running one statement
 * beside it on the same database, committed when it returns. Answers the
 * paths after which a commit was not seen, with what was read.
 * @param {(model: any, options: Record<string, unknown>) => Promise<any>} open
 * @param {(sql: string) => void | Promise<void>} raw
 * @returns {Promise<string[]>}
 */
export async function staleAfterReads(open, raw) {
  return eachPath(open, async (store, name, read, write) => {
    const kids = store.entity('K');
    // three commits, each read back by another statement than the last
    // (each by its key, which a profile that refuses a full scan admits)
    const reads = [
      async () => (await kids.asNoTracking().get('k1'))?.v,
      async () => (await kids.asNoTracking().load({ where: { $eq: ['$it.id', 'k1'] } }))[0]?.v,
      async () => store.execute(KEYED),
    ];
    await read();
    for (const [round, readBack] of reads.entries()) {
      const written = await write();
      const seen = await readBack();
      if (seen !== written) return `${name}: round ${round + 1} read ${seen}, committed ${written}`;
    }
    return null;
  }, raw);
}

/**
 * The same corpus in a rollback journal, where a read transaction left open
 * holds a SHARED lock: the commit beside the store is then refused busy
 * rather than missed. Answers the paths after which it was refused.
 * @param {(model: any, options: Record<string, unknown>) => Promise<any>} open
 * @param {(sql: string) => void | Promise<void>} raw
 * @returns {Promise<string[]>}
 */
export async function lockedAfterReads(open, raw) {
  return eachPath(open, async (store, name, read, write) => {
    await read();
    // a second read through another statement: the one that keeps the
    // transaction a statement left active open past its own end
    await store.execute(KEYED);
    try { await write(); }
    catch (error) { return `${name}: ${/** @type {any} */ (error)?.code ?? error}`; }
    return null;
  }, raw);
}

/**
 * Each read path over a store of its own on the one database (a path that
 * leaves a snapshot open must not hide the next one's), seeded by the first.
 * @param {(model: any, options: Record<string, unknown>) => Promise<any>} open
 * @param {(store: any, name: string, read: () => Promise<unknown>, write: () => Promise<number>) => Promise<string | null>} check
 * @param {(sql: string) => void | Promise<void>} raw
 * @returns {Promise<string[]>}
 */
async function eachPath(open, check, raw) {
  const found = [];
  let written = 100;
  const write = async () => {
    written++;
    await raw(`UPDATE "K" SET "v" = ${written} WHERE "id" = 'k1'`);
    return written;
  };
  const seeding = await open(FOREIGN_COMMIT_MODEL, {});
  try {
    await seeding.entity('P').create({ id: 'p' });
    for (let i = 0; i < 3; i++) await seeding.entity('K').create({ id: `k${i}`, pid: 'p', v: i });
    for (let i = 0; i < 3; i++) await seeding.collection('C').insert({ id: `c${i}`, v: i });
    await seeding.jobs.enqueue('kind', { n: 1 }, { id: 'j0' });
  }
  finally { await seeding.close(); }
  for (const name of Object.keys(readPaths(null))) {
    const store = await open(FOREIGN_COMMIT_MODEL, { live: asyncLive({ pollMs: 60000 }),
      ...(PROFILED.has(name) ? { profile: { refuseFullScan: true, externals: [] } } : {}) });
    try {
      const outcome = await check(store, name, readPaths(store)[name], write);
      if (outcome !== null) found.push(outcome);
    }
    finally { await store.close(); }
  }
  return found;
}
