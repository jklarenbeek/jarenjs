//@ts-check
/**
 * @file Error types for @jarenjs/flow, built on `@jarenjs/core`'s coded
 * contract: every failure carries a stable `code` (JF0xxx compile,
 * JF2xxx runtime), a bare `reason`, a composed `message`, and — where
 * one exists — the `docPath` of the offending member of the flow
 * document. The feedback shape a repair loop needs. The normative
 * table lives in docs/FLOW-FORMAT.md §5, proven in sync with
 * `FLOW_CODES` below by a test.
 */

import { CodedError } from '@jarenjs/core/errors';

/**
 * The runtime code table (the `CSV_CODES` shape): one entry per code
 * this package can raise, proven in sync with FLOW-FORMAT.md §5's
 * normative table by a test — the "must stay in sync by hand" note this
 * file used to carry is now a checked fact.
 */
export const FLOW_CODES = Object.freeze({
  JF0001: 'the document is not an object, or $fsm is not 0.1',
  JF0002: 'states is not an array, or a state entry is malformed',
  JF0003: 'two state entries share one id',
  JF0004: 'initial is neither null nor a declared state id',
  JF0005: 'transitions is not an array, or an entry is malformed',
  JF0006: 'a transition from/to names no declared state',
  JF0007: 'a guard failed to compile as a query document',
  JF0008: 'an effects list or effect descriptor is malformed',
  JF0009: 'an effect with failed to compile as a query document',
  JF0010: 'the dag document is not an object, or $dag is not 0.1',
  JF0011: 'nodes is not an object, or a node declaration is malformed',
  JF0012: 'edges is not an array, or an edge entry is malformed',
  JF0013: 'an edge from/to names no declared node',
  JF0014: 'an embedded document failed to compile',
  JF0015: 'the wiring rules are violated',
  JF0016: 'the graph has a cycle',
  JF0017: 'the document does not declare exactly one output node',
  JF0018: 'a task node names a handler the registry does not provide',
  JF2001: 'a state id the machine does not declare',
  JF2002: 'step was called with a non-string event',
  JF2003: 'a guard threw while evaluating',
  JF2004: 'an effect with threw while evaluating',
  JF2005: 'a session was created with no start state',
  JF2006: 'a dag node failed while evaluating; the run rejects',
  JF2007: 'the caller signal aborted the run',
});

/**
 * A defect in the flow document itself, raised while `compileFsm`
 * compiles it. Codes:
 *
 *  - `JF0001` — the document is not an object, or `$fsm` is present and
 *    not `'0.1'`
 *  - `JF0002` — `states` is not an array, or a state entry is neither a
 *    string nor an object with a string `id` (or carries a non-boolean
 *    `final`)
 *  - `JF0003` — two state entries share one id
 *  - `JF0004` — `initial` is neither null nor the id of a declared state
 *  - `JF0005` — `transitions` is not an array, or a transition entry is
 *    malformed (not an object; `from`/`to` not strings; `event` neither
 *    a string nor null)
 *  - `JF0006` — a transition's `from` or `to` names no declared state
 *  - `JF0007` — a guard failed to compile as a query document (see
 *    `cause`)
 *  - `JF0008` — an effects list is not an array, or an effect
 *    descriptor is not an object with a non-empty string `run`
 *  - `JF0009` — an effect's `with` failed to compile as a query
 *    document (see `cause`)
 *
 * Dag documents (`compileDag`):
 *
 *  - `JF0010` — the dag document is not an object, or `$dag` is not
 *    `'0.1'` (the key is required — the dag format has no legacy
 *    contract to stay compatible with)
 *  - `JF0011` — `nodes` is not an object, or a node declaration is
 *    malformed (not an object; unknown `kind`; a kind-specific member
 *    missing or mistyped: `const` needs `value`, `query` needs
 *    `query`, `jslt` needs `stylesheet`, `task` needs a non-empty
 *    string `run`)
 *  - `JF0012` — `edges` is not an array, or an edge entry is malformed
 *    (not an object; `from`/`to` not strings; `port` present but not a
 *    non-empty string)
 *  - `JF0013` — an edge's `from` or `to` names no declared node
 *  - `JF0014` — an embedded document failed to compile (a node's
 *    `query`/`stylesheet`/`with` or an edge's `select`; see `cause`)
 *  - `JF0015` — the wiring rules are violated: an edge enters an
 *    `input`/`const` node or leaves the `output` node; fan-in without
 *    complete unique ports (a ported inbound set must be all-ported
 *    and duplicate-free); or a consuming node (`query`/`jslt`/`task`/
 *    `output`) has no inbound edge
 *  - `JF0016` — the graph has a cycle (the message lists the member
 *    ids; `docPath` points at the first edge inside it)
 *  - `JF0017` — the document does not declare exactly one `output`
 *    node
 *  - `JF0018` — a `task` node names a handler the compile-time
 *    registry does not provide
 */
export class FlowCompileError extends CodedError {
  /**
   * @param {string} code
   * @param {string} reason - The bare reason; `message` is composed per
   *   the coded contract.
   * @param {string} [docPath] - JSON Pointer into the flow document;
   *   `''` is the document root, `undefined` means no location.
   * @param {Error} [cause]
   */
  constructor(code, reason, docPath, cause) {
    super('FlowCompileError', code, reason, docPath,
      cause !== undefined ? { cause } : undefined);
  }
}

/**
 * A failure while a compiled machine is being driven. Only caller
 * mistakes throw; document-level evaluation failures never do — they
 * fail closed and are recorded as plain data on the step result
 * (FLOW-FORMAT §5.2). Codes:
 *
 *  - `JF2001` — `step`, `events` or `final` was called with a state id
 *    the machine does not declare (thrown; a caller bug, not machine
 *    input)
 *  - `JF2002` — `step` was called with a non-string event (thrown)
 *  - `JF2003` — a guard threw while evaluating (recorded on the step
 *    result; the guard reads false and selection continues)
 *  - `JF2004` — an effect's `with` threw while evaluating (recorded on
 *    the step result; the effect is omitted)
 *  - `JF2005` — a session was created with no start state (`initial`
 *    is null and none was given) (thrown)
 *
 * Dag runs (`compileDag(...).run`) have no recorded-error channel —
 * a failure rejects the run promise (fail closed, no partial results):
 *
 *  - `JF2006` — a node failed while evaluating; the run rejects, the
 *    shared signal aborts in-flight siblings, and the error carries
 *    the failing node's id as an own `nodeId` property beside
 *    `docPath` and `cause`
 *  - `JF2007` — the caller's `signal` aborted the run (`cause` is the
 *    abort reason when one was given)
 */
export class FlowRuntimeError extends CodedError {
  /**
   * @param {string} code
   * @param {string} reason - The bare reason; `message` is composed per
   *   the coded contract.
   * @param {string} [docPath] - JSON Pointer into the flow document;
   *   `''` is the document root, `undefined` means no location.
   * @param {Error} [cause]
   */
  constructor(code, reason, docPath, cause) {
    super('FlowRuntimeError', code, reason, docPath,
      cause !== undefined ? { cause } : undefined);
  }
}
