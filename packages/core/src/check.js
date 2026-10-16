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
 * check that answers `false`, `{ valid: false }`, an empty `errors` list
 * or an `errors` that is no error (text, a number) is reported as the one
 * coded error `JG2001` at the root. `errors` is always a list: one error
 * object a check did not put in a list is answered as the list of it.
 *
 * {@link checkCompile} makes a check of a compile that refuses by
 * throwing, and {@link CHECK_CODES} also holds the codes of a guarded
 * refiner (`@jarenjs/core/guarded`): the one its synchronous `prepare`
 * throws when it meets an asynchronous hook, and the one it reports for
 * a throw that carries no text code.
 */

import { CodedError } from './errors.js';
import { isThenable } from './function.js';

/**
 * The members a repair loop reads from one error a check names. Every
 * member is optional because a check names its own errors and
 * {@link checkOutcome} passes them on as they are: a `JarenValidator`
 * error carries `instancePath`, `keyword` and `params`; a compile gate's
 * carries `code` and `docPath`.
 * @typedef {object} CheckError
 * @property {string} [code] - the error's stable code
 * @property {string} [docPath] - JSON Pointer into the checked document
 * @property {string} [instancePath] - JSON Pointer into the checked instance
 * @property {string} [message] - the error's text
 * @property {unknown} [params] - the code's or keyword's own detail
 */

/**
 * The one error an invalid answer that names none is reported as.
 * @typedef {{ code: 'JG2001', docPath: '', message: string }} UnnamedCheckError
 */

/**
 * What {@link checkOutcome} answers, discriminated by `valid`. `E` is the
 * error type the check's own answer carries; an invalid answer that
 * carries none reports the one {@link UnnamedCheckError} instead.
 * @template [E=CheckError]
 * @typedef {{ valid: true, errors: E[] } | { valid: false, errors: (E | UnnamedCheckError)[] }} CheckOutcome
 */

/**
 * The error type a check's answer `O` carries in its `errors` member:
 * `never` for a bare boolean, the element type of an `errors` array, and
 * `unknown` for an answer whose type does not say (`any` stays `any`).
 * @template O
 * @typedef {0 extends (1 & O) ? any : unknown extends O ? unknown
 *   : O extends object ? (O extends { readonly errors?: infer A }
 *     ? (A extends readonly (infer E)[] ? E : A extends null | undefined ? never : unknown) : never)
 *   : never} CheckErrorsOf
 */

/**
 * The codes {@link checkOutcome} and a guarded refiner raise or report.
 * @type {Readonly<Record<'JG0001' | 'JG0002' | 'JG2001' | 'JG2002', string>>}
 */
export const CHECK_CODES = Object.freeze({
  JG0001: 'a check answered a promise, which checkOutcome cannot read',
  JG0002: 'a guarded hook answered a promise, which the synchronous prepare cannot await',
  JG2001: 'a check answered invalid without naming an error',
  JG2002: 'a guarded hook, snapshot, commit or restore threw a value whose code is not text',
});

/**
 * Read a compiled check's answer as `{ valid, errors }`. Only `true` and
 * `{ valid: true }` are valid. An answer keeps the errors it carries, and
 * one error object its `errors` holds outside a list answers as the list
 * of it; a valid answer with no list answers `[]`. An invalid answer that
 * carries none (`false`, `{ valid: false }`, an empty `errors`, an
 * `errors` that is text or a number, any other value) answers the single
 * error `{ code: 'JG2001', docPath: '', message }`, a fresh plain object
 * each time.
 * @template [O=unknown]
 * @param {O} outcome - a compiled check's return value
 * @returns {0 extends (1 & O) ? CheckOutcome<any> : [O] extends [PromiseLike<unknown>] ? never
 *   : CheckOutcome<CheckErrorsOf<O>>} the
 *   errors keep the type the answer's own `errors` carry (`never` when the
 *   answer's type is a promise, which is refused)
 * @throws {CodedError} `JG0001` (named `CheckOutcomeError`) when the
 *   answer is a promise or another thenable: an asynchronous check must
 *   be awaited and its settled answer passed instead
 */
export function checkOutcome(outcome) {
  if (outcome === true)
    return { valid: true, errors: [] };
  if (typeof outcome === 'object' && outcome !== null) {
    if (outcome.valid === true)
      return { valid: true, errors: listedErrors(outcome.errors) ?? [] };
    if (isThenable(outcome)) {
      // the promise is refused, never read: settle its rejection here so
      // refusing it cannot also raise an unhandled rejection
      Promise.resolve(outcome).catch(() => {});
      throw new CodedError('CheckOutcomeError', 'JG0001',
        'a check answered a promise, which has not settled — await the check and pass its settled answer');
    }
    const errors = listedErrors(outcome.errors);
    if (errors !== null && errors.length > 0)
      return { valid: false, errors };
  }
  return { valid: false, errors: [{ code: 'JG2001', docPath: '', message: 'the value was rejected by a check that named no error' }] };
}

/**
 * An answer's `errors` member as a list: an array as it stands, one error
 * object a check did not put in a list as the list of it, and anything
 * else (missing, text, a number) as no list.
 * @param {unknown} errors
 * @returns {unknown[] | null}
 */
function listedErrors(errors) {
  if (Array.isArray(errors))
    return errors;
  return typeof errors === 'object' && errors !== null ? [errors] : null;
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
 * A compile gate is {@link checkCompile} over the engine's compile.
 *
 * @template {((value: any) => unknown)[]} C
 * @param {C} checks - each returns a boolean or a `{ valid, errors }`
 *   outcome (mixed freely)
 * @returns {(value: any) => CheckOutcome<CheckErrorsOf<ReturnType<C[number]>>>}
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

/**
 * The one error {@link checkCompile} answers for a throw: the thrown
 * value's own `code` and `docPath`, and its bare `reason` as `message`.
 * @typedef {{ code: string, docPath: string, message: string }} CompileCheckError
 */

/**
 * Make a check of a compile that refuses by throwing: any jarenjs
 * `compile*` (a `CodedError` carrying `code`, `docPath` and `reason`)
 * or a host's own. The check hands the compile the checked value; a
 * compile that returns answers `{ valid: true, errors: [] }` (its return
 * value is not read), and a throw answers `{ valid: false, errors:
 * [{ code, docPath, message }] }`, a fresh object each time. `code` is
 * the thrown value's own when it is non-empty text and `fallbackCode`
 * otherwise; `docPath` is its own when it is text and `''` (the root)
 * otherwise; `message` is its `reason` (a coded error's bare text), else
 * its `message`, else the value as text. The compile must refuse
 * synchronously: a promise it returns is not awaited.
 *
 * The check composes with {@link composeChecks}, after a schema check:
 * `composeChecks(schemaCheck, checkCompile(compileJsonQuery, {
 * fallbackCode }))`.
 * @param {(value: any) => unknown} compile - throws to refuse a value
 * @param {{ fallbackCode: string }} options - `fallbackCode` is the code
 *   a throw that carries none answers, chosen by the host
 * @returns {(value: any) => CheckOutcome<CompileCheckError>}
 * @throws {TypeError} when `compile` is not a function or `fallbackCode`
 *   is not non-empty text
 */
export function checkCompile(compile, options) {
  const fallbackCode = options?.fallbackCode;
  if (typeof compile !== 'function' || typeof fallbackCode !== 'string' || fallbackCode === '')
    throw new TypeError('checkCompile needs a compile function and a non-empty fallbackCode');
  return (value) => {
    try {
      compile(value);
      return { valid: true, errors: [] };
    }
    catch (error) {
      const { code, docPath, reason, message } = /** @type {any} */ (error) ?? {};
      return { valid: false, errors: [{
        code: typeof code === 'string' && code !== '' ? code : fallbackCode,
        docPath: typeof docPath === 'string' ? docPath : '',
        message: typeof reason === 'string' ? reason : typeof message === 'string' ? message : String(error),
      }] };
    }
  };
}
