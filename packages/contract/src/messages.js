//@ts-check
/**
 * @file The English message catalog of the wire errors: one template per
 * `contract/*` msgid the HTTP binding can answer with, plus
 * `contract/handler-error`, the generic text for a declared operation
 * error that has no message of its own. Compiled ONCE at module scope
 * with `@jarenjs/core`'s `compileMessageCatalog` (the two-stage house
 * rule applied to messages) and exported in plain form for the locale
 * packs to mirror key for key.
 *
 * A message never interpolates a request value: the parameters are the
 * operation id, a declared limit, a media type, a method list, a
 * declared header member name or a declared error code — trusted
 * artifacts, never something the caller sent (the trust-boundary rule of
 * docs/CONTRACT-FORMAT.md §7).
 */

import { compileMessageCatalog } from '@jarenjs/core/message';

/**
 * The plain English catalog: msgid → template (`{param}` placeholders).
 * The keys are exactly the msgids of the CONTRACT-FORMAT.md §7 taxonomy
 * plus `contract/handler-error`; a test holds them equal.
 */
export const contractMessagesEn = Object.freeze({
  'contract/not-found': 'no operation matches the request method and path',
  'contract/method-not-allowed': 'the path is served under other methods: {allow}',
  'contract/body-too-large': 'the request body of operation {op} exceeds its {limit}-byte limit',
  'contract/unsupported-media': 'operation {op} accepts {media} bodies only',
  'contract/malformed-json': 'the request body of operation {op} is not valid JSON',
  'contract/invalid-input': 'the input of operation {op} is invalid',
  'contract/idempotency-key-required': 'operation {op} requires an Idempotency-Key header',
  'contract/handler-failed': 'operation {op} failed',
  'contract/idempotency-conflict': 'the Idempotency-Key of operation {op} conflicts with an earlier request ({kind})',
  'contract/invalid-output': 'operation {op} produced a response that violates its contract',
  'contract/malformed-path': 'the request path carries a malformed percent-escape',
  'contract/malformed-query': 'the query string is not decodable',
  'contract/not-implemented': 'operation {op} is not implemented on this server',
  'contract/precondition-failed': 'the If-Match precondition of operation {op} failed',
  'contract/invalid-header': 'the {header} header of operation {op} is invalid',
  'contract/handler-error': 'operation {op} failed with {code}',
});

/** The compiled English catalog (module-level singleton). */
export const contractCatalogEn = compileMessageCatalog(contractMessagesEn);
