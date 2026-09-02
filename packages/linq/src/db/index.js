//@ts-check
/**
 * @file `@jarenjs/linq/db` — the store's front door. `open(model,
 * options)` returns a client typed from the model pen whose entity
 * handles chain (`client.entities.Post.where(…)` is `fromAsync(handle)
 * .where(…)`, so every read is the chain's document and pushes down),
 * load graphs from an EMITTED `load` spec (`include`), track and save
 * changes, link and unlink many-to-many members and maintain live
 * results — over exactly one runtime edge: this subpath imports
 * `@jarenjs/db`, `@jarenjs/validate` and `@jarenjs/formats`, declared as
 * optional peers; no other subpath of the package does, and the store
 * never imports this package (the edge suite in the tests holds both).
 * The store stays the engine: the client adds no storage semantics and
 * duplicates no algorithm — `include` emits the spec the store runs,
 * membership is the store's own `link`/`unlink`, `live` is the store's
 * registration — and every read is one an `explain()` can name.
 * `createDbLedger` is the contract ledger over a declared collection of
 * the client's store, through that same surface: the durable idempotency
 * ledger a host was left to write, with no edge from `@jarenjs/contract`
 * to a store (DB-CLIENT.md §2.6).
 */

export { open, defaultValidator } from './open.js';
export { createDbLedger } from './ledger.js';
