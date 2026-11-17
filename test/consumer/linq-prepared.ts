// A model prepared once opens many stores, and the client a prepared
// model opens is typed from the document it was prepared from, as a plain
// open of that document is.
import { open } from '@jarenjs/linq/db';
import type { Client } from '@jarenjs/linq/db';
import { openStore, prepareModel, normalizeModel } from '@jarenjs/db';
import type { Driver, PreparedModel, Store } from '@jarenjs/db';
import type { InferMeta } from '@jarenjs/linq/model';
import { fixtureModel } from '../linq/model-corpus.js';

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Meta = InferMeta<typeof fixtureModel>;
declare const driver: Driver;

async function main(): Promise<void> {
  const prepared = prepareModel(fixtureModel);
  const kept: PreparedModel<typeof fixtureModel> = prepared;
  const document: typeof fixtureModel = prepared.model;
  const client = await open(prepared, { driver });
  const inferred: Equals<typeof client, Client<Meta, {}>> = true;
  const store: Store = await openStore(prepared, { driver });
  const json = prepareModel({ $model: '0.1', collections: { notes: { key: '/id', schema: { type: 'object' } } } },
    { expressions: {} });
  const wide = await open(json, { driver });
  void [kept, document, inferred, store, wide.collections.notes];
  // @ts-expect-error a hand-made lookalike is not a prepared model
  const lookalike: PreparedModel<typeof fixtureModel> = { model: fixtureModel };
  void lookalike;
  // normalizeModel resolves the same expressions, positionally
  const normalized: Map<string, unknown> = normalizeModel(fixtureModel, {});
  void normalized;
  // @ts-expect-error prepareModel reads expressions alone
  void prepareModel(fixtureModel, { functions: {} });
}
void main;
