//@ts-check
/**
 * @file `@jarenjs/linq/migration` — `$migration` 0.1 documents by code.
 * `defineMigration({ id, from, to })` names two model documents and
 * hashes their shapes as the store does; the steps follow in the order
 * they are called — `ddl`, `sql`, `transform` (a `jslt` step whose
 * callback is captured over the old row shape and typed to the new one),
 * `assert` (a `query` step), `derive`, and `step` for any planner-emitted
 * step verbatim. `fromPlanned(document)` takes a planner's document up so
 * a typed `transform` replaces the draft it left. The document is the
 * deliverable: plain, deep-frozen JSON the migration runner takes
 * unchanged; nothing here imports the store or an engine.
 */

export { defineMigration, fromPlanned, Migration } from './define.js';
