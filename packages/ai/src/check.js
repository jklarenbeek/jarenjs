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
