//@ts-check
/**
 * @file The English message catalog: one template per `contract/*` msgid
 * a binding can answer with — the HTTP taxonomy, the port/local codes,
 * `contract/handler-error` (the generic text for a declared operation
 * error that has no message of its own) — and one per client-originated
 * outcome (the `JC205x` codes a client resolves without a server
 * message). Compiled ONCE at module scope
 * with `@jarenjs/core`'s `compileMessageCatalog` (the two-stage house
 * rule applied to messages) and exported in plain form for the locale
 * packs to mirror key for key.
 *
 * A message never interpolates a request value: the parameters are the
 * operation id, a declared limit, a media type, a method list, a
 * declared header member name, a declared error code, a status, a
 * platform error's NAME or a contract version — trusted artifacts or
 * protocol facts, never something a peer sent as content (the
 * trust-boundary rule of docs/CONTRACT-FORMAT.md §7).
 */

import { compileMessageCatalog } from '@jarenjs/core/message';

/**
 * The plain English catalog: msgid → template (`{param}` placeholders).
 * The keys are exactly the msgids of the CONTRACT-FORMAT.md §7 taxonomy,
 * `contract/handler-error`, and the §10 client table; a test holds them
 * equal.
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
  'contract/client-invalid-input': 'the input of operation {op} is invalid; nothing was sent',
  'contract/network': 'the request of {op} did not complete ({name})',
  'contract/cancelled': 'the request of operation {op} was cancelled',
  'contract/invalid-response': 'the response of operation {op} violates its contract',
  'contract/key-storage-failed': 'the idempotency key of operation {op} could not be stored; nothing was sent',
  'contract/undeclared-response': 'operation {op} answered an undeclared response (status {status})',
  'contract/not-a-contract': 'the server does not describe contract {id} at its well-known path',
  'contract/incompatible': 'the server speaks version {server} of contract {id}; this client speaks {client} and neither end declares the other compatible',
  'contract/host-failed': 'operation {op} failed in the host before an outcome was produced',
  'contract/local-handler-failed': 'operation {op} failed in the serving host',
  'contract/unknown-operation': 'the request names no operation served on this channel',
  'contract/port-timeout': 'operation {op} got no answer on the channel within {ms}ms',
  'contract/malformed-frame': 'the response frame of operation {op} is malformed',
  'contract/channel-closed': 'the channel of operation {op} is closed',
  'contract/not-a-stream': 'the server answered the subscription of operation {op} with a non-stream response',
  'contract/invalid-snapshot': 'operation {op} produced a snapshot that violates its contract',
  'contract/seq-regression': 'the stream of operation {op} violated its seq order',
  'contract/stream-error': 'the stream of operation {op} ended with a server error ({code})',
  'contract/heartbeat-missed': 'the stream of operation {op} went silent for {ms}ms',
  'contract/slow-consumer': 'the stream of operation {op} ended: the consumer fell behind its bounded queue',
  'contract/reconnect-exhausted': 'the stream of operation {op} could not be re-established after {attempts} attempts (last: {lastCode})',
});

/** The compiled English catalog (module-level singleton). */
export const contractCatalogEn = compileMessageCatalog(contractMessagesEn);
