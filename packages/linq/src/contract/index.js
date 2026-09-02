//@ts-check
/**
 * @file `@jarenjs/linq/contract` — `$contract` 0.1 documents by code.
 * `defineContract({ id?, version?, compat? }, operations)` writes the
 * document `compileContract` takes, with every `named()` schema builder
 * an operation reaches hoisted into the contract's own `$defs` and every
 * member in the order CONTRACT-FORMAT §12.1 fixes, so a pen document and
 * its own public projection differ by nothing but the defaults the
 * compiler materializes. `read`/`command`/`subscribe` declare the three
 * kinds, `http()` the REST binding (its path template checked here,
 * earlier than the compiler's `JC0008`), `error()` one entry of an
 * operation's `errors`.
 *
 * The identity wrappers — `typedClient`, `typedHttpClient`,
 * `typedHandlers`, `typedTools` — carry the inferred `Operations` type
 * onto a client (an HTTP one with its byte method), a handler table and
 * an AI toolbox without running the TypeScript projection. The document is the deliverable; nothing here imports
 * `@jarenjs/contract` or an engine.
 */

export { defineContract, typedClient, typedHttpClient, typedHandlers, typedTools, Contract } from './define.js';
export { read, command, subscribe, error } from './operation.js';
export { http } from './http.js';
