//@ts-check
/**
 * @file The client-side outcome (docs/CONTRACT-FORMAT.md §10): the JSON
 * value every `invoke` resolves to — `{ ok: true, value, meta }` or
 * `{ ok: false, kind, error, meta }` with `kind` one of `failure`
 * (a declared operation error, or a taxonomy error the server answered),
 * `network` (the transport failed), `contract` (the peer violated the
 * contract: an invalid response, an undeclared code, a malformed frame —
 * or the client refused pre-send) and `cancelled` (a local abort). Never
 * an `Error`, a `Response` or a `Headers`: JSON only, so the value can
 * land in app state unchanged.
 *
 * `assembleOutcome` is binding-neutral: it takes what a wire answered as
 * `{ status | null, headers, text | value | error }` and the operation's
 * prepared route, and classifies. The HTTP client feeds it a status, the
 * response headers and the body text; an in-process or message-port
 * binding (no statuses) feeds `status: null` with a parsed `value` or a
 * parsed error envelope. Nothing here performs I/O.
 *
 * Outcome, error and meta objects are built with a fixed member order so
 * each shape is one hidden class — and the shapes `makeMeta` and
 * `outcomeError` build ARE the D6 shapes of every binding (03A): `error`
 * is always `{ code, message, status, details, retryable }`, `meta` is
 * always `{ op, attempt, trace, revision, etag, notModified }`, and no
 * member is ever `undefined` (`isJsonValue` — the predicate the app's
 * task effect and state honor — rejects it, and the outcome would fall
 * back to a string). A binding that cannot carry a member carries `null`
 * (`status`, `etag`, `trace`) or `false` (`notModified`) and says so in
 * its `capabilities`; it never omits the member. The member lists are
 * exported (`OUTCOME_ERROR_MEMBERS`, `OUTCOME_META_MEMBERS`) so a later
 * binding asserts against them instead of restating them.
 */

import { renderMessage, projectValidationDetails, verdict, HTTP_ERRORS, HANDLER_ERROR_MSGID } from '../http/wire.js';

/**
 * @typedef {import('../compile.js').CompiledOperation} CompiledOperation
 * @typedef {import('../http/wire.js').Catalog} Catalog
 */

/**
 * The correlation members of every outcome. `op` is the operation id;
 * `attempt` is the CALLER's attempt id (`ctx.attempt`, `null` when the
 * caller gave none) and is never read from a response; `trace` is the
 * SERVER's request id (`x-jaren-trace`), `null` when the wire carried
 * none; `revision` is reserved for the contract revision; `etag` is the
 * entity tag a success carried (`null` otherwise); `notModified` is true
 * exactly for a 304.
 * @typedef {Object} OutcomeMeta
 * @property {string} op
 * @property {unknown} attempt
 * @property {string | null} trace
 * @property {string | null} revision
 * @property {string | null} etag
 * @property {boolean} notModified
 */

/**
 * The error member of a failed outcome: a stable `code` (a declared
 * error code, a `JC2xxx` taxonomy code, or a `JC205x` client code), a
 * rendered `message`, the HTTP `status` when the binding carries one
 * (`null` otherwise), `details` (`null` when none — an outcome is JSON,
 * so no member is ever `undefined`) and whether the caller may retry.
 * @typedef {Object} OutcomeError
 * @property {string} code
 * @property {string} message
 * @property {number | null} status
 * @property {unknown} details
 * @property {boolean} retryable
 */

/**
 * The members of every outcome `error`, in order (D6). Frozen.
 * @type {readonly ['code', 'message', 'status', 'details', 'retryable']}
 */
export const OUTCOME_ERROR_MEMBERS = Object.freeze(/** @type {const} */ (['code', 'message', 'status', 'details', 'retryable']));

/**
 * The members of every outcome `meta`, in order (D6). Frozen.
 * @type {readonly ['op', 'attempt', 'trace', 'revision', 'etag', 'notModified']}
 */
export const OUTCOME_META_MEMBERS = Object.freeze(/** @type {const} */ (['op', 'attempt', 'trace', 'revision', 'etag', 'notModified']));

/**
 * @typedef {{ ok: true, value: unknown, meta: OutcomeMeta }} OkOutcome
 * @typedef {{ ok: false, kind: 'failure' | 'network' | 'contract' | 'cancelled', error: OutcomeError, meta: OutcomeMeta }} FailedOutcome
 * @typedef {OkOutcome | FailedOutcome} Outcome
 */

/**
 * The client-side taxonomy as data: code → `{ msgid, retryable }`. The
 * normative table is docs/CONTRACT-FORMAT.md §10; a test holds the two
 * equal, and equal to `CONTRACT_CODES` and the English catalog.
 * `retryable` of `JC2055` is decided per response (5xx and 429 are
 * retryable); the row carries the default.
 */
export const CLIENT_ERRORS = Object.freeze({
  JC2050: Object.freeze({ msgid: 'contract/client-invalid-input', retryable: false }),
  JC2051: Object.freeze({ msgid: 'contract/network', retryable: true }),
  JC2052: Object.freeze({ msgid: 'contract/cancelled', retryable: false }),
  JC2053: Object.freeze({ msgid: 'contract/invalid-response', retryable: false }),
  JC2054: Object.freeze({ msgid: 'contract/key-storage-failed', retryable: false }),
  JC2055: Object.freeze({ msgid: 'contract/undeclared-response', retryable: false }),
  JC2056: Object.freeze({ msgid: 'contract/not-a-contract', retryable: false }),
  JC2057: Object.freeze({ msgid: 'contract/incompatible', retryable: false }),
  JC2058: Object.freeze({ msgid: 'contract/host-failed', retryable: false }),
});

/**
 * What the outcome assembler reads per operation, decided once.
 * @typedef {Object} OutcomeRoute
 * @property {string} id
 * @property {(value: unknown) => any} validateOutput
 * @property {Readonly<Record<string, import('../compile.js').CompiledErrorDecl>>} errors
 * @property {ReadonlySet<string>} retryOn
 * @property {'none' | 'paths' | 'full'} details
 */

/**
 * Prepare an operation for the assembler.
 * @param {CompiledOperation} op
 * @returns {OutcomeRoute}
 */
export function prepareOutcomeRoute(op) {
  return Object.freeze({
    id: op.id,
    validateOutput: op.output.validate,
    errors: op.errors,
    retryOn: new Set(op.policy.retry === null ? [] : op.policy.retry.on),
    details: op.policy.errors.details,
  });
}

/**
 * A meta object in its fixed member order.
 * @param {string} op
 * @param {unknown} attempt
 * @param {string | null} trace
 * @returns {OutcomeMeta}
 */
export function makeMeta(op, attempt, trace) {
  return { op, attempt: attempt === undefined ? null : attempt, trace, revision: null, etag: null, notModified: false };
}

/**
 * @param {unknown} value
 * @param {OutcomeMeta} meta
 * @returns {OkOutcome}
 */
export function okOutcome(value, meta) {
  return { ok: true, value, meta };
}

/**
 * @param {'failure' | 'network' | 'contract' | 'cancelled'} kind
 * @param {OutcomeError} error
 * @param {OutcomeMeta} meta
 * @returns {FailedOutcome}
 */
export function failedOutcome(kind, error, meta) {
  return { ok: false, kind, error, meta };
}

/**
 * An error object in its fixed member order.
 * @param {string} code
 * @param {string} message
 * @param {number | null} status
 * @param {unknown} details
 * @param {boolean} retryable
 * @returns {OutcomeError}
 */
export function outcomeError(code, message, status, details, retryable) {
  return { code, message, status, details: details === undefined ? null : details, retryable };
}

/**
 * A client-originated error (`JC205x`): message from the catalog, the
 * row's `retryable` unless overridden.
 * @param {Catalog | null} catalog
 * @param {keyof typeof CLIENT_ERRORS} code
 * @param {Record<string, unknown>} params
 * @param {number | null} status
 * @param {unknown} details
 * @param {boolean} [retryable]
 * @returns {OutcomeError}
 */
export function clientError(catalog, code, params, status, details, retryable) {
  const row = CLIENT_ERRORS[code];
  return outcomeError(code, renderMessage(catalog, row.msgid, params), status, details,
    retryable === undefined ? row.retryable : retryable);
}

/**
 * Whether `value` is an object carrying every member of `members`, none
 * of them `undefined` (D6: an absent member is `null`, never omitted).
 * @param {any} value
 * @param {readonly string[]} members
 * @returns {boolean}
 */
function hasMembers(value, members) {
  if (value === null || typeof value !== 'object') return false;
  for (let i = 0; i < members.length; i++) {
    if (value[members[i]] === undefined) return false;
  }
  return true;
}

/**
 * True for a value shaped like an outcome: a plain object with a
 * boolean `ok`, a `meta` carrying every D6 meta member, and, when
 * failed, a `kind` and an `error` carrying every D6 error member with a
 * string `code` — no member `undefined`. Reads guardedly, so a hostile
 * value classifies as "not an outcome".
 * @param {unknown} value
 * @returns {value is Outcome}
 */
export function isOutcome(value) {
  try {
    if (value === null || typeof value !== 'object') return false;
    const v = /** @type {any} */ (value);
    if (v.ok === true) return hasMembers(v.meta, OUTCOME_META_MEMBERS);
    if (v.ok !== false) return false;
    return (v.kind === 'failure' || v.kind === 'network' || v.kind === 'contract' || v.kind === 'cancelled')
      && hasMembers(v.error, OUTCOME_ERROR_MEMBERS) && typeof v.error.code === 'string'
      && hasMembers(v.meta, OUTCOME_META_MEMBERS);
  }
  catch {
    return false;
  }
}

/**
 * Whether an undeclared status is worth a retry: the server-side class
 * and the rate limit.
 * @param {number} status
 * @returns {boolean}
 */
function retryableStatus(status) {
  return status >= 500 || status === 429;
}

/**
 * What a wire answered, as the assembler reads it. Exactly one of `text`,
 * `value` or `error` carries the body: `text` is the raw body of an HTTP
 * response (parsed here; `''`/`null` is an empty body), `value` a
 * success value already decoded by a JSON-framed binding, `error` an
 * error envelope (`{ code, message?, details?, retryable? }`) already
 * decoded by such a binding. `status` is the HTTP status or `null` on a
 * binding that carries none; `headers` holds `etag` when the binding
 * carries entity tags.
 * @typedef {Object} WireMessage
 * @property {number | null} status
 * @property {Readonly<Record<string, string>> | null} headers
 * @property {string | null} [text]
 * @property {unknown} [value]
 * @property {unknown} [error]
 */

/**
 * Assemble the outcome of one response. TOTAL: every shape the peer can
 * answer classifies; nothing throws.
 *
 * - a 2xx (or `status: null` with a `value`): an empty body is `null`;
 *   otherwise the text is parsed (`JC2053` when not JSON) and the value
 *   validated against the output schema (`JC2053` with details by
 *   `policy.errors.details`) → `{ ok: true, value, meta }` with `meta.etag`
 *   from the header;
 * - a 304 → `{ ok: true, value: null, meta }` with `notModified: true`
 *   and the `etag`;
 * - any other status: the body is parsed as JSON; a string `code` that
 *   the operation declares, or a `JC2xxx` taxonomy code, is `kind:
 *   "failure"` with `{ code, message, status, details?, retryable }` —
 *   the body's `message` when it is a string, else rendered; `retryable`
 *   the body's boolean, else whether `policy.retry.on` names the code;
 *   anything else (a non-JSON body, no string code, an unknown code) is
 *   `kind: "contract"` `JC2055` with the status kept and `retryable`
 *   for 5xx/429.
 *
 * @param {OutcomeRoute} route
 * @param {WireMessage} message
 * @param {OutcomeMeta} meta - mutated: `etag`/`notModified` are set here
 * @param {Catalog | null} catalog
 * @returns {Outcome}
 */
export function assembleOutcome(route, message, meta, catalog) {
  const status = message.status;
  const headers = message.headers;
  const etag = headers !== null && typeof headers.etag === 'string' ? headers.etag : null;
  if (status === 304) {
    meta.etag = etag;
    meta.notModified = true;
    return okOutcome(null, meta);
  }
  if (status === null ? message.error === undefined : (status >= 200 && status <= 299)) {
    let value;
    if (message.text !== undefined) {
      const text = message.text;
      if (text === null || text.length === 0) value = null;
      else {
        try {
          value = JSON.parse(text);
        }
        catch {
          return failedOutcome('contract', clientError(catalog, 'JC2053', { op: route.id }, status,
            [{ path: '', keyword: 'json' }], false), meta);
        }
      }
    }
    else value = message.value;
    const v = verdict(route.validateOutput, value);
    if (!v.valid) {
      return failedOutcome('contract', clientError(catalog, 'JC2053', { op: route.id }, status,
        projectValidationDetails(route.details, v.errors), false), meta);
    }
    meta.etag = etag;
    return okOutcome(value, meta);
  }
  // an error: the body decides between a declared/taxonomy failure and a
  // contract violation
  let body;
  if (message.text !== undefined) {
    const text = message.text;
    if (text !== null && text.length > 0) {
      try {
        body = JSON.parse(text);
      }
      catch {
        body = undefined;
      }
    }
  }
  else body = message.error;
  const retryByStatus = status !== null && retryableStatus(status);
  if (body === null || typeof body !== 'object' || Array.isArray(body) || typeof body.code !== 'string') {
    return failedOutcome('contract', clientError(catalog, 'JC2055', { op: route.id, status }, status, undefined, retryByStatus), meta);
  }
  const code = body.code;
  const declared = Object.hasOwn(route.errors, code);
  const taxonomy = !declared && Object.hasOwn(HTTP_ERRORS, code);
  if (!declared && !taxonomy) {
    return failedOutcome('contract', clientError(catalog, 'JC2055', { op: route.id, status }, status, undefined, retryByStatus), meta);
  }
  const message_ = typeof body.message === 'string'
    ? body.message
    : renderMessage(catalog, declared ? HANDLER_ERROR_MSGID : HTTP_ERRORS[/** @type {keyof typeof HTTP_ERRORS} */ (code)].msgid,
      { op: route.id, code, status });
  const retryable = typeof body.retryable === 'boolean' ? body.retryable : route.retryOn.has(code);
  return failedOutcome('failure', outcomeError(code, message_, status, body.details, retryable), meta);
}

/**
 * The outcome a handler projects a THROWN host value into when it must
 * settle with an outcome (the app effect): `kind: "contract"` `JC2058`,
 * the message from the catalog, nothing of the thrown value (its text
 * may carry anything).
 * @param {string} op
 * @param {unknown} attempt
 * @param {Catalog | null} catalog
 * @returns {Outcome}
 */
export function hostFailureOutcome(op, attempt, catalog) {
  return failedOutcome('contract', clientError(catalog, 'JC2058', { op }, null, undefined), makeMeta(op, attempt, null));
}
