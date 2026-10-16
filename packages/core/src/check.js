//@ts-check
/**
 * The shared reading of a compiled check's return value. Both the tool
 * boundary and structured generation accept an injected `check`, and an
 * injected one must answer strict true: the default
 * `JarenValidator` check reports `{ valid, errors }`, a hand-written one
 * may answer a bare boolean. Normalizing here keeps both call sites from
 * having to know which kind they were handed.
 *
 * An invalid outcome always names at least one error, because its errors
 * are what a repair loop hands back to the model that wrote the value: a
 * check that answers `false`, `{ valid: false }` or an empty `errors`
 * list is reported as the one coded error `JG2001` at the root.
 */

import { CodedError } from './errors.js';
import { isThenable } from './function.js';

/**
 * The codes {@link checkOutcome} raises or reports.
 * @type {Readonly<Record<'JG0001' | 'JG2001', string>>}
 */
export const CHECK_CODES = Object.freeze({
  JG0001: 'a check answered a promise, which checkOutcome cannot read',
  JG2001: 'a check answered invalid without naming an error',
});

/**
 * Read a compiled check's answer as `{ valid, errors }`. Only `true` and
 * `{ valid: true }` are valid. An invalid answer keeps the errors it
 * carries; one that carries none (`false`, `{ valid: false }`, an empty
 * `errors`, any other value) answers the single error `{ code: 'JG2001',
 * docPath: '', message }`, a fresh plain object each time.
 * @param {any} outcome - a compiled check's return value
 * @returns {{ valid: boolean, errors: any[] }}
 * @throws {CodedError} `JG0001` (named `CheckOutcomeError`) when the
 *   answer is a promise or another thenable: an asynchronous check must
 *   be awaited and its settled answer passed instead
 */
export function checkOutcome(outcome) {
  if (outcome === true)
    return { valid: true, errors: [] };
  if (typeof outcome === 'object' && outcome !== null) {
    if (outcome.valid === true)
      return { valid: true, errors: outcome.errors ?? [] };
    if (isThenable(outcome)) {
      // the promise is refused, never read: settle its rejection here so
      // refusing it cannot also raise an unhandled rejection
      Promise.resolve(outcome).catch(() => {});
      throw new CodedError('CheckOutcomeError', 'JG0001',
        'a check answered a promise, which has not settled — await the check and pass its settled answer');
    }
    const errors = outcome.errors;
    if (errors !== undefined && errors !== null && !(Array.isArray(errors) && errors.length === 0))
      return { valid: false, errors };
  }
  return { valid: false, errors: [{ code: 'JG2001', docPath: '', message: 'the value was rejected by a check that named no error' }] };
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
