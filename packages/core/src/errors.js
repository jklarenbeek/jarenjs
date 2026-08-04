//@ts-check
/**
 * @file The suite's one coded-error contract. Every engine error that
 * carries a stable diagnosis code derives from {@link CodedError}; the
 * canonical form is the structured triple `{ code, reason, docPath |
 * dataPath }`, and `message` is COMPOSED from it for the channels that
 * have no structured reader (an uncaught throw, a console, a CI
 * transcript, a model reading `{ error: err.message }`).
 *
 * The rendering decision, fixed here so every package agrees:
 *
 *   `${code}: ${reason}`                      — no location
 *   `${code}: ${reason} at ${docPath}`        — a document location
 *   `${code}: ${reason} in data ${dataPath}`  — a data location
 *   `${code}: ${reason} at ${d} in data ${p}` — both
 *
 * `docPath` points into the offending *document* (a query, a stylesheet,
 * an app document); `dataPath` points into the offending *data* the
 * document was applied to. They are different facts and stay separately
 * readable and separately identifiable — `at` always means document,
 * `in data` always means data. A root pointer (`''`) is a real location
 * and renders as `at ''`; absence is `undefined` and renders nothing.
 * Absence must never be normalized to `''` — the AI repair loop's
 * `docPath ?? instancePath ?? ''` fallback chain relies on `undefined`
 * to fall through, and `''` is a legitimate root pointer.
 *
 * Cause presence uses the `hasOwn` form: the constructor takes an
 * options bag, and `Object.hasOwn(options, 'cause')` decides whether an
 * own `cause` is installed — so a host that threw `undefined` (passed as
 * `{ cause: undefined }`) stays distinguishable from "no cause" (no
 * options, or an options bag without the key). Positional-adapter
 * subclasses that translate an optional trailing `cause` parameter MUST
 * map an `undefined` argument to "no cause", never to
 * `{ cause: undefined }`.
 *
 * Deliberately OUTSIDE this contract: `ValidationError`
 * (keyword-keyed, locale-rendered, has its own `toJSON`), the
 * `LabeledSyntaxError` family (`source`/`position` over a source
 * string), and josl's line/column family (`line`/`column`/`hint`).
 * Different shapes for different consumers — do not "finish the job" by
 * folding them in.
 *
 * Localization: `@jarenjs/locales` keys its catalogs by JSON Schema
 * KEYWORD (`form/minLength`, …), not by error code — coded errors are
 * localizable by nothing today. Stated so nobody assumes otherwise; a
 * code-keyed catalog would be a new locales feature, not a property of
 * this base.
 */

/**
 * Compose the canonical coded message from the structured fields.
 * @param {string} code - Stable diagnosis code
 * @param {string} reason - The bare human-readable reason
 * @param {string} [docPath] - JSON Pointer into the offending document
 * @param {string} [dataPath] - Pointer/path into the offending data
 * @returns {string}
 */
function composeCodedMessage(code, reason, docPath, dataPath) {
  let message = `${code}: ${reason}`;
  if (docPath !== undefined) message += ` at ${docPath === '' ? "''" : docPath}`;
  if (dataPath !== undefined) message += ` in data ${dataPath === '' ? "''" : dataPath}`;
  return message;
}

/**
 * Base class for every coded error in the suite. Subclasses are thin
 * per-package adapters that fix the public `name` (passed as a string
 * literal because bundles are minified and a mangled class name must
 * not leak into `error.name`) and translate their historical positional
 * signatures into the location/options form.
 */
export class CodedError extends Error {
  /**
   * @param {string} name - The public class name for `error.name`
   * @param {string} code - Stable diagnosis code
   * @param {string} reason - The bare reason; `message` is composed from
   *   `code`, `reason` and the location and must not be pre-composed
   * @param {string | { docPath?: string, dataPath?: string }} [location]
   *   - A string is a `docPath`; the object form carries either or both
   * @param {{ cause?: unknown }} [options] - `cause` is installed as an
   *   own property exactly when the key is present (`hasOwn` form),
   *   preserving "host threw `undefined`" as distinct from "no cause"
   */
  constructor(name, code, reason, location = undefined, options = undefined) {
    const docPath = typeof location === 'string' ? location : location?.docPath;
    const dataPath = typeof location === 'string' ? undefined : location?.dataPath;
    super(composeCodedMessage(code, reason, docPath, dataPath));
    this.name = name;
    this.code = code;
    this.reason = reason;
    this.docPath = docPath;
    if (dataPath !== undefined) this.dataPath = dataPath;
    if (options !== undefined && Object.hasOwn(options, 'cause')) {
      // The native `new Error(msg, { cause })` shape: non-enumerable,
      // writable, configurable — installed by hand so an explicitly
      // `undefined` cause is representable.
      Object.defineProperty(this, 'cause', {
        value: options.cause, writable: true, enumerable: false, configurable: true,
      });
    }
  }
}
