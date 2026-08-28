//@ts-check
/**
 * @file @jarenjs/linq — a C#-familiar fluent surface that captures
 * expressions as plain Jaren query documents (QUERY-FORMAT.md),
 * executes deferred over any iterable, and hands the SAME document
 * whole to any provider exposing `execute(document, options)` (D2:
 * contract-level coupling — the chain imports no provider; the client
 * subpath `./db` is the package's one declared edge, toward the
 * store). The normative surface, mapping table and error codes live
 * in docs/QUERY-PEN.md.
 */

export { from, fromDocument, Sequence } from './sequence.js';
export { fromAsync, AsyncSequence } from './async.js';
export { createPushQueue } from './sources.js';
export { LinqBuildError, LinqRuntimeError, LINQ_CODES } from './errors.js';
