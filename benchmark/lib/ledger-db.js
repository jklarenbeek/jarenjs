//#region the durable ledger adapter
// The `@jarenjs/ai` ledger's storage contract over one `@jarenjs/db`
// collection: four methods, plus the optional `rank` when a vector
// column is declared. It lives here rather than inside either consumer
// because both need exactly this one: `test/ai/ledger-db.test.js` runs
// the ledger's whole suite of shapes over it, and
// `benchmark/retrieval.js --store=db` scores the instrument through it.
//
// The listing between the markers below is the recipe in `packages/ai`'s
// README, verbatim, and the test is what keeps them one thing. Nothing
// here imports `@jarenjs/ai`: the storage contract is the whole
// interface between a ledger and where it lives, and an adapter that
// reached for the ledger would be a fork of it.

// —— the recipe (packages/ai/README.md, "A durable ledger over @jarenjs/db") ——
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

/**
 * One collection is the whole schema a ledger needs: the storage key,
 * the JSON value, and — when records carry embeddings — one packed
 * vector column derived from `value.embedding`. `value` is deliberately
 * untyped: the ledger stores objects, strings and arrays under the same
 * contract, and only the vector member has to be declared.
 */
const ledgerModel = (dims) => ({
  $model: '0.1',
  collections: {
    slots: {
      schema: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          value: { properties: { embedding: { type: 'array', items: { type: 'number' } } } },
        },
        required: ['key'],
      },
      key: '/key',
      indexes: dims === undefined ? []
        : [{ name: 'by_vec', path: '$.value.embedding', derive: 'vector', dims }],
    },
  },
});

/** A collection answer as a list — `execute` returns the bare item for one. */
const many = (result) => (Array.isArray(result) ? result : result === undefined ? [] : [result]);

/**
 * A durable ledger storage adapter over one `@jarenjs/db` collection:
 * the four methods, plus `rank` when a vector column is declared. It
 * imports nothing from `@jarenjs/ai` — the storage contract is the
 * whole interface between them.
 *
 * The prefix is INLINE in every query document rather than bound as an
 * external, because a string operator only translates to SQL with a
 * literal pattern; inlined, `keys()` and the ranked read both become a
 * range scan over the key column. The ledger asks for a handful of
 * distinct prefixes, so the documents are built once each and cached.
 */
export async function createDbStorage({ path = ':memory:', dims } = {}) {
  const store = await openStore(ledgerModel(dims), { driver: nodeDriver(), path });
  const slots = store.collection('slots');
  const documents = new Map();

  /** Every query document one prefix needs, built once. */
  const forPrefix = (prefix) => {
    let built = documents.get(prefix);
    if (built !== undefined) return built;
    const under = { '$starts-with': ['$r.key', prefix] };
    const score = { $similarity: ['$r.value.embedding', '$q'] };
    const mine = [{ $eq: ['$r.value.embeddedBy.model', '$model'] },
      { $eq: ['$r.value.embeddedBy.dims', '$dims'] }];
    const counted = (where) => ({ $count: { $for: { r: '$[*]' }, $where: where, $return: '$r' } });
    const ranked = {
      $for: { r: '$[*]' },
      $where: { $and: [under, ...mine] },
      // the ledger re-scores and re-sorts what comes back, so this
      // ordering only has to agree with its tie-break: score, then
      // newest, then the key
      $orderby: [{ $key: score, $dir: 'desc', $empty: 'least' },
        { $key: '$r.value.at', $dir: 'desc' }, '$r.key'],
      $return: { key: '$r.key', score },
    };
    built = {
      keys: { $for: { r: '$[*]' }, $where: under, $orderby: ['$r.key'], $return: '$r.key' },
      ranked,
      window: (limit) => ({ $subsequence: [ranked, 0, limit] }),
      skipped: counted({ $and: [under, { $not: { $exists: '$r.value.embedding' } }] }),
      held: counted({ $and: [under, { $exists: '$r.value.embedding' }] }),
      ours: counted({ $and: [under, { $exists: '$r.value.embedding' }, ...mine] }),
      names: { $distinct: { $for: { r: '$[*]' }, $where: under, $return: '$r.value.embeddedBy' } },
    };
    documents.set(prefix, built);
    return built;
  };

  return {
    get: async (key) => (await slots.get(key))?.value,
    set: async (key, value) => { await slots.put({ key, value }); },
    delete: async (key) => { await slots.delete(key); },
    // sorted, because the ledger reads listings, the goal archive and a
    // snapshot's entries in key order and its zero-padded sequences
    // exist so that order is chronological
    keys: async (prefix = '') => many(await slots.execute(forPrefix(prefix).keys)),
    /**
     * The optional fifth: rank where the records live. The window is the
     * k-nearest plan — the vector column cuts the candidates, the engine
     * orders them — and the two reports the ledger needs are counts,
     * which push to SQL. Naming every identity costs a scan, so it is
     * paid only when the counts prove a mixture, which is the one case
     * that is about to refuse anyway.
     */
    rank: async ({ prefix, vector, model, dims: width, limit }) => {
      const docs = forPrefix(prefix);
      const externals = { q: vector, model, dims: width };
      const hits = many(await slots.execute(
        limit === undefined ? docs.ranked : docs.window(limit), { externals }));
      const skipped = await slots.execute(docs.skipped);
      const held = await slots.execute(docs.held);
      const ours = await slots.execute(docs.ours, { externals });
      const identities = held === ours
        ? (ours === 0 ? [] : [{ model, dims: width }])
        : many(await slots.execute(docs.names));
      return { hits, skipped, identities };
    },
    // beyond the contract, and deliberately: the store is the host's to
    // migrate, back up and explain, and hiding it would only mean
    // opening a second one to do any of that
    store,
    close: () => store.close(),
  };
}
// —— end of the recipe ——

//#endregion
