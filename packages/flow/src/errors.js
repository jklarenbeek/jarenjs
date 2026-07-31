//@ts-check
/**
 * @file Error types for @jarenjs/flow, following the suite convention:
 * every failure carries a stable `code` (JF0xxx compile, JF2xxx runtime)
 * and, where one exists, the `docPath` of the offending member of the
 * flow document — the feedback shape a repair loop needs. The normative
 * table lives in docs/FLOW-FORMAT.md §5 and must stay in sync with the
 * lists below.
 */

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
 */
export class FlowCompileError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {string} [docPath] - JSON Pointer into the flow document.
   * @param {Error} [cause]
   */
  constructor(code, message, docPath, cause) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'FlowCompileError';
    this.code = code;
    this.docPath = docPath ?? '';
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
 */
export class FlowRuntimeError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {string} [docPath] - JSON Pointer into the flow document.
   * @param {Error} [cause]
   */
  constructor(code, message, docPath, cause) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'FlowRuntimeError';
    this.code = code;
    this.docPath = docPath ?? '';
  }
}
