//@ts-check
/**
 * @file `@jarenjs/linq/flow` — the `jaren-fsm` and `jaren-dag` 0.1
 * documents by code. `defineFsm()` writes the machine `compileFsm` and
 * `fsmToApp` take; `defineDag()` writes the dataflow `compileDag`
 * takes. Guards, effect props, node queries and edge selectors are
 * callbacks captured over the scope the engine evaluates them in
 * (FLOW-FORMAT §3 and §6.1), so a path is written, never typed as a
 * string — which is also why a plain-string guard is refused here
 * (§3 makes a literal one vacuously true).
 *
 * State ids, event names and node ids are literal types: a transition
 * into an undeclared state or an edge from an undeclared node is a
 * compile error before it is a `JL0102`, and long before the engine's
 * `JF0006`/`JF0013`. The document is the deliverable — plain,
 * deep-frozen JSON — and nothing here imports `@jarenjs/flow`.
 */

export { defineFsm, state, on, effect } from './fsm.js';
export {
  defineDag, input, output, constant, query, jslt, task, edge, typedTasks,
} from './dag.js';
