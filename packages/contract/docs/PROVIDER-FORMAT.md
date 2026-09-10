# Provider descriptors, authority and complete ingestion

`@jarenjs/contract/provider` exports `createProviderExecutor`, `compileProvider`
and `withProviderRun`. The executor composes core scheduling with one injected
HTTP attempt. The compiler describes JSON REST and explicitly declared GraphQL
dialects. Credentials, destination rules and provider schemas remain host inputs.

## Executor

```js
import { createProviderExecutor, compileProvider } from '@jarenjs/contract/provider';

const executor = createProviderExecutor({ attempts: 3, overallMs: 30000,
  attemptMs: 10000, maxBytes: 262144, concurrency: 4, maxQueue: 64 });
const provider = compileProvider({
  $provider: '0.1', id: 'inventory', apiVersion: '2026-01',
  endpoint: 'https://inventory.example/items', protocol: 'rest',
  method: 'GET', safety: 'safe-read',
  query: { environment: '$.input.environment' },
  response: { rows: '$.items', id: '$.id', cursor: '$.next', version: '$.version' },
  pagination: { cursorParam: 'cursor', empty: 'complete' },
  limits: { pages: 3, rows: 256, bytes: 262144 },
});
try {
  const result = await provider.pull({ environment: 'test' }, { executor });
  // Inspect result.state and the preserved result.observations before using it.
} finally { await executor.close(); }
```

`execute(request, context)` requires an absolute HTTP(S) URL without embedded
credentials and explicit safety: `safe-read`, `provider-idempotent`, or
`single-send`. Provider-idempotent also requires `idempotencyKey`; the injected
transport must bind that key using the provider's documented mechanism. The
default transport refuses provider-idempotent requests with
`idempotency-transport-required` because it has no dialect-specific key binding. An
idempotency key does not qualify business reconciliation or durable receipts.
Single-send transport/body uncertainty returns `unresolved` and never resends
inside the executor. Supply the same core attempt budget in `context.budget`
when an outer job or workflow can invoke the same request again.

The optional injected `transport(request, {signal,attempt,maxAttempts})` returns
a Fetch `Response`. It must make exactly one request (`maxAttempts:1`), disable
SDK retries, and honor abort. The default uses `fetch` with redirects disabled.
Custom redirect handling and idempotency binding remain transport obligations.
JSON results preserve status, exact response text, consumed byte count, attempts
and Retry-After, but never raw exceptions, credentials or response handles.
`state` is `ok`, `failed`, `refused`, `unresolved` or `cancelled`.

Defaults are three total attempts, an overall deadline of 30 seconds, ten seconds
per attempt, 262144 response bytes across attempts and 262144 request-body bytes.
`baseMs` defaults to 500 and `maxMs` to 8000. `now`, `random` and `sleep` are
injectable. Core concurrency, queue, scope and spacing options are forwarded.
The `account` request field combines with URL origin for fair rate scopes.
`context.deadline` and `context.maxBytes` can tighten the executor's limits.
Stream readers stop on byte exhaustion; late replies cannot become successes
after abort/deadline. Close drains transport, body readers and retry waits.

Retryable transport failures and HTTP 408/429/5xx consume the same total budget.
`retryAfter` selects `http` (seconds/date), `milliseconds`, or `none`;
`retryAfterHeader` names the header. A server delay which cannot fit the remaining
deadline refuses with `deadline`. It is never shortened to the backoff cap.
AI's declared clamp and the contract client's jitter remain their explicit
[compatibility policies](../../core/docs/SCHEDULING.md).

## Versioned descriptor

`$provider:'0.1'`, `id`, `apiVersion`, `endpoint`, `protocol`, `method`, `safety`
and `response` are required. API version is public data available to request
selectors; the descriptor explicitly binds it in the endpoint, headers or query.
Unknown fields are refused at compile time (`JC0021`). Malformed executor/run
host options use `JC1012`.

| Declaration | Contract |
|---|---|
| `headers` | Static public string headers. Authentication/cookie/key headers are refused; host transport owns credentials. |
| `query`, `body` | Existing Query documents over `{input,cursor,apiVersion,partition,sourceVersion}`; query returns scalar parameters, body becomes canonical JSON. GET/HEAD bodies are refused. |
| `graphql` | POST with `{query,variables?}`; variables is a Query document. `pagination.cursorVariable` receives the continuation. |
| `response.rows`, `id` | Query selectors for an array and each source identity. String identities remain strings; numeric IDs must be safe integers. |
| `response.cursor`, `hasMore` | Scalar continuation and optional explicit boolean. GraphQL terminal cursors may remain present when hasMore is false. |
| `response.errors`, `cost`, `version` | Extracted protocol evidence. GraphQL errors default to `$.errors`; any partial errors make the pull incomplete. |
| `response.transform` | `{kind:'query',expression}`, `{kind:'jslt',expression}`, or `{callback:name}`. Source raw/text/IDs remain beside transformed rows. |
| `inputSchema`, `response.schema` | Optional schemas compiled by injected `compileSchema`; absence of that capability refuses the descriptor. |
| `pagination` | `cursorParam`, `cursorVariable`, and explicit `empty:'complete'` or `'incomplete'`. Empty pages with continuation are always incomplete. |
| `limits` | Positive finite `pages`, `rows`, `bytes`; defaults match the example. Budgets apply across one iterator, including failed request bytes. |
| `capability` | `json` is supported. `upload`, `media`, `bulk`, `binary` refuse before dispatch. |

Named selector callbacks are supplied in `compileProvider(doc,{callbacks})`.
They receive cloned protocol data only. They are trusted host functions, not a
JavaScript sandbox; the framework never supplies run resources to them.
Schema, Query and JSLT each retain their existing compiler and semantics.

`pages(input,context)` is an async iterator. Each `page` contains exact `text`,
parsed `raw`, transformed `rows`, source `ids`, input `cursor`, `continuation`,
`complete`, `version`, `errors`, `cost`, `reason`, `bytes` and `attempts`.
The consumer's next pull admits the next request. A terminal `complete`,
`incomplete` or `refused` record reports totals; `pull` collects that bounded
sequence into `observations`. Repeated cursors, duplicate IDs, empty intermediate
pages, partial errors, broken transforms and exhausted credits remain incomplete.
Accepted partial pages remain inspectable. Bytes refused at a stream limit are
discarded, and malformed response text is returned without claiming parsed rows.
Raw text retains wire distinctions that JSON numbers alone cannot represent.

## Private run authority

`withProviderRun(evidence,host,work,options)` composes the existing
identify/acquire/release hooks. Evidence is a closed JSON record of nonempty
opaque strings: `runId`, `actor`, `environment`, `destination`, `revision`, `lease`.
The host implements `identify(meta)`, `acquire(input,identity,enter)`,
`current(evidence,privateHost,operation)` and `transport(request,context)`.
`current` re-reads live authority and returns matching evidence or null.
The framework compares every field before dispatch and publication, including
after asynchronous refresh. All allowlists and membership rules stay in current.

The callback receives a run with enumerable `evidence` only. Its private
`execute`, `check`, `publish` and `signal` members cannot enter ordinary JSON
state. Transport alone receives `context.host`; privileged clients are unique
to concurrent runs. Host acquisition must serialize account switching where
required. Shutdown stops admission and drains workers and callbacks before
acquired and identity resources release, in that order. Released run callbacks
cannot dispatch or publish again. The library suppresses raw host errors;
applications must also keep secrets out of explicitly returned business data.

Flow DAG/workflow `run(...,{resources})` passes resources as the task handler's
third argument, separate from JSON input, checkpoint identity and trace data.
Tasks with resources drain on abort before the workflow rejects. Compile the
workflow once, then provide the particular run on each invocation. Authority
is reacquired on resume; persisted references never restore live credentials.

## Complete snapshots and qualification

[`createIngestion`](../../flow/docs/WORKFLOW-FORMAT.md#complete-provider-ingestion)
composes bounded pages with the existing workflow engine and an injected store.
[`createDbIngestionStore`](../../linq/docs/DB-CLIENT.md#complete-ingestion-store)
co-commits pages/checkpoints and publishes only complete requested partitions.
Source snapshot or monotonic revision evidence is mandatory, including a version
on every page. Identical published input is a no-op; application reconciliation
owns manual provenance. No network operation holds a page transaction.

Offline REST, partial GraphQL and archive-link transcripts and two independent
bounded consumers are executable through `npm run test:packed` on Node and Bun.
Node's abrupt-process recovery, rollback and zero-write tests run in the unit
suite. Real provider authority/read-back, native external SDK behavior and
downstream cutover remain separate qualifications. External writes await durable
receipt/reconciliation capability; streaming DAG inputs are not required here.

<!--fact:providers.measurements-->

Measured on v24.19.0, linux/x64, AMD Ryzen 9 5900HX with Radeon Graphics.

| Consumer | Rows | Requests / budget | Response bytes / budget | Retained reader ms | Native ingestion ms | Second writes / revisions | Teardown ms / remaining resources | Sampled heap / RSS MiB |
|---|---:|---|---|---:|---:|---|---|---|
| catalog | 256 | 3 / 3 | 66426 / 262144 | 0.96 | 64.45 | 0 / 0 | 0.27 / 0 | 35.69 / 116.45 |
| archive-stock | 512 | 6 / 6 | 135886 / 524288 | 1.31 | 79.46 | 0 / 0 | 0.11 / 0 | 42.55 / 173.56 |

Offline synthetic Node SQLite ingestion. The retained reader only extracts recorded transcripts; native timings include opening storage, descriptor execution, private authority checks, page/checkpoint commits, publication and zero-write replay. Their timings describe different work. No real provider latency, credentials, external write reconciliation or production cutover is qualified.

<!--/fact-->
