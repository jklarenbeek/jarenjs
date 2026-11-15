// Declarations that describe what runs: each block types a value the way
// the runtime produces or requires it, and each `@ts-expect-error` marks a
// spelling the runtime answers differently from what it would have typed.
import * as s from '@jarenjs/linq/schema';
import * as m from '@jarenjs/linq/model';
import { from } from '@jarenjs/linq';
import type { DateTime } from '@jarenjs/linq';
import { defaultValidator, open } from '@jarenjs/linq/db';
import { defineContract, http, read, subscribe, typedHandlers } from '@jarenjs/linq/contract';
import { compileContract } from '@jarenjs/contract';
import { serveHttp } from '@jarenjs/contract/http';
import type { Driver, Store, TransactionStore } from '@jarenjs/db';
import { typedStore } from '@jarenjs/db/typed';
import type { EntityMeta } from '@jarenjs/db/typed';
import type { ValidationResultObject } from '@jarenjs/validate';

declare const driver: Driver;

// ——— defaultValidator() collects errors: a compiled check answers { valid, errors } ———
export function defaultValidatorCollects(): void {
  const check = defaultValidator().compile({ type: 'object', required: ['id'] });
  const result = check({});
  const valid: boolean = result.valid;
  const collected: ValidationResultObject = result;
  // @ts-expect-error — the result is an object, truthy even when invalid
  const truthy: boolean = check({});
  void [valid, collected, truthy];
}

// ——— the default validator, extended, is still an open() validator ———
export async function defaultValidatorOpens(): Promise<void> {
  const model = { $model: '0.1', collections: { notes: { key: '/id', schema: { type: 'object' } } } } as const;
  const client = await open(model, { driver, validator: defaultValidator().addFormats({}) });
  await client.close();
}

// ——— a subscribe handler answers the live source the stream binding reads ———
const watchContract = defineContract({ id: 'watch', version: '1' }, {
  'board.watch': subscribe({
    input: s.object({}),
    output: s.object({ revision: s.integer() }),
    http: http({ method: 'GET', path: '/watch' }),
  }),
  'board.get': read({
    input: s.object({}),
    output: s.object({ revision: s.integer() }),
    http: http({ method: 'GET', path: '/board' }),
  }),
});
const snapshot = { revision: 0 };
export const watchHandlers = typedHandlers(watchContract, {
  'board.watch': () => ({ snapshot: () => snapshot, subscribe: () => () => {}, close() {} }),
  'board.get': () => snapshot,
});
serveHttp(compileContract(watchContract.document), watchHandlers);
// the settled `result` form and a promise of a source are sources too
typedHandlers(watchContract, {
  'board.watch': async () => ({ result: snapshot, subscribe: () => () => {}, close: async () => {} }),
  'board.get': async () => snapshot,
});
typedHandlers(watchContract, {
  // @ts-expect-error — a snapshot is not a source: the binding answers JC2010
  'board.watch': () => snapshot,
  'board.get': () => snapshot,
});
typedHandlers(watchContract, {
  // @ts-expect-error — the source's snapshot is the operation's output
  'board.watch': () => ({ snapshot: () => ({ revision: 'one' }), subscribe: () => () => {}, close() {} }),
  'board.get': () => snapshot,
});

// ——— a chain orders what the engine orders: numbers and strings ———
interface Row { id: string; n: number; at: DateTime; on: boolean; maybe: boolean | null; meta: { a: number }; tags: string[]; note?: string | null }
declare const rows: Row[];
const chain = from(rows);
chain.orderBy((r) => r.n).thenBy((r) => r.id).thenByDescending((r) => r.at);
chain.orderByDescending((r) => r.note).thenBy((r) => r.get('n')).thenBy((r) => r.n.add(1));
chain.orderBy(() => 1).thenBy(() => 'a');
// @ts-expect-error — a boolean key is JQ2005 at run time
chain.orderBy((r) => r.on);
// @ts-expect-error — so is a nullable boolean's
chain.orderByDescending((r) => r.maybe);
// @ts-expect-error — and a comparison's
chain.orderBy((r) => r.n).thenBy((r) => r.n.eq(1));
// @ts-expect-error — and an existence test's
chain.orderBy((r) => r.n).thenByDescending((r) => r.note.exists());
// @ts-expect-error — and a literal's
chain.orderBy(() => true);
// @ts-expect-error — an object member is JQ2005 at run time
chain.orderBy((r) => r.meta);
// @ts-expect-error — and an array member
chain.orderBy((r) => r.tags);
// @ts-expect-error — and an array literal
chain.orderBy((r) => [r.n, r.id]);

// the same refusals on a client's chain; a JSON model's rows are unknown, so anything goes
const orgs = m.defineModel({ entities: { Org: m.object({ id: m.string().key(), name: m.string(), active: m.boolean() }) } });
export async function clientChains(): Promise<void> {
  const client = await open(orgs, { driver });
  await client.entities.Org.orderBy((o) => o.name).thenByDescending((o) => o.id).toArray();
  // @ts-expect-error — a boolean key is JQ2005 at run time
  await client.entities.Org.orderByDescending((o) => o.active).toArray();
  // @ts-expect-error — on a later key too
  await client.entities.Org.orderBy((o) => o.name).thenBy((o) => o.active).toArray();
  // the load path orders a boolean in SQL (false before true), so a graph and an include admit one
  await client.entities.Org.graph().orderBy((o) => o.active).thenBy((o) => o.id).page({ limit: 10, maxBytes: 65536 });
  const json = await open({ $model: '0.1', collections: { notes: { key: '/id', schema: { type: 'object' } } } } as const, { driver });
  await json.collections.notes.orderBy((n) => n.get('done')).toArray();
  await Promise.all([client.close(), json.close()]);
}

// ——— a JSON model's typed store is a Store; a transaction's view is a TransactionStore ———
const receiptsModel = { $model: '0.1', collections: { receipts: { key: '/id', schema: { type: 'object' } } } } as const;
export async function jsonModelStoreIsAStore(): Promise<void> {
  const client = await open(receiptsModel, { driver });
  const store: Store = client.store;
  // a boundary both pass through names the members it reads
  const root: Pick<Store, 'entity' | 'execute'> = client.store;
  const wide: Store = await open(receiptsModel as object, { driver }).then((opened) => opened.store);
  await client.transaction(async (tx) => {
    const view: TransactionStore = tx.store;
    // a boundary that takes a transaction's view names what it reads
    const reads: Pick<Store, 'entity' | 'execute'> = tx.store;
    // @ts-expect-error — a transaction's view does not own the store's lifetime (checkpoint, optimize, close)
    const owner: Store = tx.store;
    void [view, reads, owner];
  });
  void [store, root, wide];
  await client.close();
}
type WideMeta<K> = Record<string, { doc: object; input: object; key: K; relations: Record<string, { entity: string; doc: object; many: boolean }> }>;
export function wideMapsAreStores(store: Store): Store[] {
  return [typedStore<WideMeta<string>>(store), typedStore<WideMeta<number>>(store), typedStore<WideMeta<unknown>>(store),
    typedStore<Record<string, EntityMeta>>(store)];
}
// a declared map stays precise: an undeclared entity and a key of the wrong type do not compile
type Declared = { Label: { doc: { id: string }; input: { id: string }; key: string; relations: {} } };
export async function declaredMapIsPrecise(store: Store): Promise<void> {
  const typed = typedStore<Declared>(store);
  const plain: Store = typed;
  await typed.entity('Label').load({ after: 'l1' });
  // @ts-expect-error — the store declares no entity 'Labels'
  typed.entity('Labels');
  // @ts-expect-error — the single-column cursor is a string key
  await typed.entity('Label').load({ after: 1 });
  void plain;
}

// ——— a client's live query is a subscribe handler's source as it stands ———
const Note = s.object({ id: s.string(), text: s.string() });
const notesModel = m.defineModel({ collections: { notes: m.collection(m.object({ id: m.string(), text: m.string() }), { key: '/id' }) } });
const notesContract = defineContract({ id: 'notes', version: '1' }, {
  'notes.watch': subscribe({ input: s.object({}), output: s.object({ rows: s.array(Note) }), http: http({ method: 'GET', path: '/notes' }) }),
});
export async function liveQueryIsASource(): Promise<void> {
  const client = await open(notesModel, { driver });
  const table = typedHandlers(notesContract, { 'notes.watch': () => client.collections.notes.live() });
  serveHttp(compileContract(notesContract.document), table);
  await client.close();
}
