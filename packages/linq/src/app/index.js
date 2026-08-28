//@ts-check
/**
 * @file `@jarenjs/linq/app` — a `jaren-app` 0.1 application by code.
 * `defineApp()` writes the document `createApp` runs: a state whose
 * initial value comes from its own schema's defaults, the JSLT pen's
 * stylesheet as the view, actions captured over APP-FORMAT §3.1's three
 * names, patch paths derived from the state shape, and subscriptions
 * compiled in §5.3's closed world. It answers the document and the
 * state's JSON Schema as two members of one result — the format has no
 * slot for the second, and `validateState` is where it belongs.
 *
 * Everything the document holds is data, so everything this pen writes
 * is JSON: nothing here imports `@jarenjs/app`, and the loop's compiler
 * stays the only judge of what an app means.
 */

export { defineApp } from './define.js';
export { action, transition, effect, bind } from './action.js';
export { add, append, replace, remove, move, copy, test } from './patch.js';
export { sub } from './sub.js';
