//@ts-check
/**
 * The shared reading of a compiled check's return value. Both the tool
 * boundary and structured generation accept an injected `check`, and an
 * injected one is only obliged to answer truthily: the default
 * `JarenValidator` check reports `{ valid, errors }`, a hand-written one
 * may answer a bare boolean. Normalizing here keeps both call sites from
 * having to know which kind they were handed.
 */

/**
 * @param {any} outcome - a compiled check's return value
 * @returns {{ valid: boolean, errors: any[] }}
 */
export function checkOutcome(outcome) {
  return typeof outcome === 'object' && outcome !== null
    ? { valid: outcome.valid === true, errors: outcome.errors ?? [] }
    : { valid: outcome === true, errors: [] };
}

/** Validation errors reported back per rejected write — enough to fix
 * from, few enough to stay readable in a model's context. */
export const MAX_INPUT_ERRORS = 8;

/**
 * The one rejection shape every schema-guarded boundary in this package
 * answers with: `{ error, errors, inputSchema }`, never a throw. The
 * model (or the caller) reads the errors, re-reads the schema, and
 * retries — which only works if every boundary answers the same way, so
 * this is the single implementation and both the toolbox and the ledger
 * call it rather than each shaping its own.
 *
 * Member order is part of the shape: `error`, `errors`, any `extra`
 * (the toolbox's `hint`), then `inputSchema` last, because the schema is
 * the biggest member and a reader scans the message first.
 *
 * @param {string} what - what was being validated (`add`, `memory`, …)
 * @param {{ errors: any[] }} outcome - a normalized {@link checkOutcome}
 * @param {any} inputSchema - the schema to re-read
 * @param {Record<string, any>} [extra] - boundary-specific members
 * @returns {{ error: string, errors: any[], inputSchema: any }}
 */
export function invalidInput(what, outcome, inputSchema, extra = {}) {
  return {
    error: `invalid input for ${what}`,
    errors: outcome.errors.slice(0, MAX_INPUT_ERRORS).map((e) => ({
      instancePath: e.instancePath ?? '',
      keyword: e.keyword ?? '',
      message: e.message ?? 'invalid',
    })),
    ...extra,
    inputSchema,
  };
}

/**
 * Compose several checks into one, run in order: the FIRST invalid
 * outcome wins and its errors are returned; a value that passes every
 * check is valid with no errors. This is how "the reply validates
 * against the schema AND compiles as a program" becomes a single
 * injected `validator` — the schema check first (cheap, structural),
 * the engine's compile gate second (semantic). It is deliberately
 * engine-agnostic: a Jaren query, JSLT, app or flow compile gate all
 * compose the same way, because each reports the same `{ valid, errors }`
 * shape through {@link checkOutcome} and each error carries a `code`
 * and a `docPath` the repair loop can act on.
 *
 * A compile gate is the two-line adapter `(doc) => { try { compile(doc);
 * return true; } catch (e) { return { valid: false, errors: [{ code:
 * e.code, docPath: e.docPath, message: e.reason ?? e.message }] }; } }`
 * — `reason` is the bare text of a coded error; falling back to
 * `message` keeps the adapter total over non-coded throws.
 *
 * @param {...(value: any) => any} checks - each returns a boolean or a
 *   `{ valid, errors }` outcome (mixed freely)
 * @returns {(value: any) => { valid: boolean, errors: any[] }}
 */
export function composeChecks(...checks) {
  return (value) => {
    for (const check of checks) {
      const outcome = checkOutcome(check(value));
      if (!outcome.valid) return outcome;
    }
    return { valid: true, errors: [] };
  };
}
