// @jarenjs/linq/db — the client is typed from the model pen with no cast
// and no generate step: open() infers the metadata from the pen model's
// phantom (a JSON model is the wide map unless the caller names one),
// entity handles chain as the typed entity set does, include widens the
// loaded rows by what it included, membership is checked against the
// many-to-many members at compile time, and every negative is pinned.
import { open } from '@jarenjs/linq/db';
import type {
  Client, EntityHandle, CollectionHandle, TypedLiveQuery, TransactionClientOf,
} from '@jarenjs/linq/db';
import type { InferMeta } from '@jarenjs/linq/model';
import type { EntityMeta } from '@jarenjs/db/typed';
import type { Driver, SaveReport } from '@jarenjs/db';
import type { Infer } from '@jarenjs/linq/schema';
import { fixtureModel, placesModel, Place } from '../linq/model-corpus.js';
import type { EntityMetaMap, User, Post, Label } from './db-generated.js';

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Meta = InferMeta<typeof fixtureModel>;
declare const driver: Driver;

async function main(): Promise<void> {
  const client = await open(fixtureModel, { driver });
  // open() infers the metadata from the pen model
  const inferred: Equals<typeof client, Client<Meta, {}>> = true;
  void inferred;
  const handle: EntityHandle<Meta, Meta['User']> = client.entities.User;
  void handle;

  // the chain over a handle is typed by the entity document
  const posts: Post[] = await client.entities.Post.where((p) => p.stars.ge(3)).toArray();
  const titles: string[] = await client.entities.Post.orderBy((p) => p.pid).select((p) => p.title).toArray();
  const first: Post = await client.entities.Post.first();
  const n: number = await client.entities.User.count();
  const byAuthor: { t: string; e: string }[] = await client.entities.Post
    .join(client.entities.User.where((u) => u.age.gt(1)), (p) => p.authorId, (u) => u.id, (p, u) => ({ t: p.title, e: u.email }))
    .toArray();
  void [posts, titles, first, n, byAuthor];
  // @ts-expect-error — a misspelled member is a compile error on the handle's chain too
  void client.entities.Post.where((p) => p.strs.ge(3));

  // include widens by what it included; the spec's callbacks are typed on the TARGET entity
  const loaded = await client.entities.User
    .include((u) => u.posts, { where: (p) => p.stars.ge(3), take: 2, orderBy: { key: (p) => p.pid, desc: true } })
    .include((u) => u.labels, { count: true })
    .where((u) => u.age.gt(1))
    .orderBy((u) => u.email).take(10)
    .toArray();
  const loadedPosts: Post[] = loaded[0].posts;
  const labelCount: number = loaded[0].labels;
  const email: string = loaded[0].email;
  void [loadedPosts, labelCount, email];
  const nested = await client.entities.Post.include((p) => p.author, { include: { labels: true } }).toArray();
  const authorLabels: Label[] | undefined = nested[0].author?.labels;
  void authorLabels;
  const bare = await client.entities.User.include((u) => u.posts).asNoTracking().toArray();
  // the graph cursor: one root per pull, typed by the includes; the
  // per-root bounds ride on the include spec, Infinity spelled
  const streamed = client.entities.User
    .include((u) => u.posts, { maxRows: 100, maxBytes: Infinity })
    .cursor({ signal: new AbortController().signal, tracking: false });
  for await (const user of streamed) {
    const titles: (string | undefined)[] = user.posts.map((p) => p.title);
    void titles;
  }
  void streamed.streaming;
  const barePosts: Post[] = bare[0].posts;
  void barePosts;
  const spec = client.entities.User.include((u) => u.posts).toSpec();
  void spec.include;
  // @ts-expect-error — a wrong include member never types
  void client.entities.User.include((u) => u.email);
  // @ts-expect-error — the include's where is over the target entity, not the root
  void client.entities.User.include((u) => u.posts, { where: (p) => p.email.eq('x') });
  // @ts-expect-error — a nested include member the target does not declare
  void client.entities.Post.include((p) => p.author, { include: { nope: true } });
  // @ts-expect-error — a keyset cursor is the ordering's continuation, never a bare key
  void client.entities.Post.include((p) => p.author).after('one');
  // the continuation follows the declared ordering: a two-key ordering
  // emits and takes a two-value keys tuple, plus the row's key
  const ordered = client.entities.Post.graph().orderBy((p) => p.stars).thenByDescending((p) => p.title);
  const page = await ordered.page({ limit: 10, maxBytes: 65536, consistency: 'live' });
  const continuation: { readonly keys: [number, string]; readonly key: number } | null = page.continuation;
  void continuation;
  const pageRows: { pid: number; title?: string }[] = page.items;
  void pageRows;
  void page.snapshot;
  if (page.continuation !== null) void ordered.after(page.continuation);
  // @ts-expect-error — a two-key ordering needs a two-value continuation
  void ordered.after({ order: [], keys: [1], key: 1 });
  // @ts-expect-error — the tuple is typed by the keys' value types
  void ordered.after({ order: [], keys: ['x', 'y'], key: 1 });
  // an include-bearing graph declares its ordering the same way, and the
  // page is typed by the includes
  const withAuthor = await client.entities.Post.include((p) => p.author).orderBy((p) => p.pid)
    .after({ order: [], keys: [1], key: 1 }).page({ limit: 5 });
  const authorEmail: string | undefined = withAuthor.items[0]?.author?.email;
  void authorEmail;

  // membership: exactly the many-to-many members, the target's key or document
  const ada: User = { id: 'u1', email: 'a@x' };
  client.entities.User.link('u1', 'labels', 'admin');
  client.entities.User.unlink(ada, 'labels', { name: 'dev' });
  // @ts-expect-error — a to-many relation that is not many-to-many is not a membership
  client.entities.User.link('u1', 'posts', 1);
  // @ts-expect-error — a to-one relation is not a membership
  client.entities.Post.link(1, 'author', 'u1');
  // @ts-expect-error — the target key is the target's key type
  client.entities.User.link('u1', 'labels', 42);
  const report: SaveReport = await client.saveChanges();
  void report.joinInserted;

  // live: the rows are typed by the chain's item
  const live: TypedLiveQuery<Post> = await client.live(client.entities.Post.where((p) => p.stars.ge(3)));
  const rows: readonly Post[] = live.result.rows;
  const mode: 'incremental' | 'rerun' = live.mode.mode;
  const handleLive: TypedLiveQuery<User> = await client.entities.User.live();
  void [rows, mode, handleLive, live.subscribe, live.close];

  // the pass-throughs and the escape hatch
  const inTx: number = await client.transaction(async () => 1);
  const validated: boolean = client.capabilities.validated;
  const escape: User | undefined = await client.store.entity('User').get('u1');
  void [inTx, validated, escape];

  // the transaction client: the SAME handles, the same inference, over
  // the store inside the transaction
  const txTitles: string[] = await client.transaction(async (tx) => {
    const sameHandle: Equals<typeof tx.entities.User, typeof client.entities.User> = true;
    void sameHandle;
    const typedTx: TransactionClientOf<Meta, {}> = tx;
    void typedTx;
    tx.entities.Post.add({ title: 'in a transaction', stars: 1, authorId: 'u1' });
    const saved: SaveReport = await tx.saveChanges();
    void saved;
    // it nests, and the nested one is a client too
    await tx.transaction(async (inner) => {
      const nestedRows: Post[] = await inner.entities.Post.toArray();
      void nestedRows;
    });
    // named savepoints are the transaction's alone, forwarded from the store
    await tx.savepoints.create('mid');
    await tx.savepoints.rollbackTo('mid');
    await tx.savepoints.release('mid');
    // @ts-expect-error — a transaction client has no close(); the client owns the store
    void tx.close;
    // @ts-expect-error — nor does the scope-bound store the escape hatch exposes
    void tx.store.close;
    return tx.entities.Post.select((p) => p.title).toArray();
  }, { unitOfWork: 'own' });
  // @ts-expect-error — the root client has no savepoint controller
  void client.savepoints;
  void txTitles;
  // @ts-expect-error — the unit-of-work choice is one of exactly two words
  await client.transaction(async () => 1, { unitOfWork: 'private' });
  await client.close();

  // a JSON model is the wide map unless the caller names one
  const wide = await open({ $model: '0.1', entities: {} }, { driver });
  const wideHandle: EntityHandle<Record<string, EntityMeta>, EntityMeta> = wide.entities.Anything;
  void wideHandle;
  const named = await open<EntityMetaMap>({ $model: '0.1', entities: {} }, { driver });
  const namedUsers: User[] = await named.entities.User.toArray();
  void namedUsers;
  // @ts-expect-error — the named map declares no such entity
  void named.entities.Nope;

  // collections are typed from the pen's collection schema
  const places = await open(placesModel, { driver });
  const collection: CollectionHandle<Infer<typeof Place>> = places.collections.places;
  const place: Infer<typeof Place> | undefined = await collection.get('p1');
  const ids: string[] = await collection.where((p) => p.t.gt(1)).select((p) => p.id).toArray();
  void [place, ids];
  // @ts-expect-error — a collections-only model has no unit of work
  void places.saveChanges;
}
void main;

// ——— the ledger: structurally the contract package's Ledger, typed here ———
import { createDbLedger } from '@jarenjs/linq/db';
import type { DbLedger, DbClaimResult, DbLedgerRecord, LedgerClient } from '@jarenjs/linq/db';
import type { Ledger, ClaimResult, LedgerRecord } from '@jarenjs/contract/ledger';

export async function ledgerTyping(client: LedgerClient) {
  const ledger: DbLedger = createDbLedger(client, { ttlMs: 60_000, collection: 'ledger', now: () => Date.now() });
  const asContract: Ledger = ledger;                                   // assignable: the binding takes it as is
  const claimed: DbClaimResult = await ledger.claim({ op: 'a', scope: '', key: 'k', hash: 'h' });
  const wide: ClaimResult = claimed;
  if (claimed.state === 'new') {
    const id: string = claimed.ref.id;
    const generation: string = claimed.ref.generation;
    await ledger.commit(claimed.ref, { status: 200, headers: {}, body: null });
    void id; void generation;
  }
  const record: DbLedgerRecord | null = await ledger.lookup({ op: 'a', scope: '', key: 'k' });
  const asRecord: LedgerRecord | null = record;
  const swept: number = await ledger.sweep();
  // @ts-expect-error — a ref is named by id and generation; a bare string is not one the types admit
  const bad: DbClaimResult = { state: 'new', ref: 'seq-1' };
  void asContract; void wide; void asRecord; void swept; void bad;
}

export async function trustedTransactionTypes() {
  const client = await open(fixtureModel, { driver });
  await client.transaction(async (tx) => {
    const rows: any[] = await tx.sql.prepare('SELECT ?', { access: 'read' }).all([1]);
    const syncRow: any = tx.sync?.sql.prepare('SELECT ?', { access: 'read' }).get([1]);
    // @ts-expect-error — transaction control is not an access mode
    tx.sql.prepare('SELECT 1', { access: 'transaction' });
    void [rows, syncRow];
  });
}
