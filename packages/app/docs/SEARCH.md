# Search resource ownership

`createSearchResource` from `@jarenjs/app/search` owns one private resident index
and an injected worker. JSON application state holds search intent, progress,
result IDs and observations. It never holds index handles, worker objects,
controllers or cached source rows.

```js
import { createSearchResource } from '@jarenjs/app/search';
// workerFactory is the host's injected service; dispose must settle its requests.
const resource = createSearchResource({ version: 1, fields: ['title', 'sku'] }, {
  workerFactory, maxInFlight: 2, onProgress: progress => publishProgress(progress),
});
await resource.build(rows, { generation: 1, requestId: 'build-1', sourceRevision: 'catalog-1' });
const result = resource.search('gren tea', { limit: 20 });
await resource.dispose();
```

The factory supplies `{request(message, {signal, onProgress}), dispose()}`.
Build messages have `version: 1`, `operation: 'build'`, the lexical definition,
projected string documents, and all three identities. Transport admission checks
document/field/source and temporary credits before handing text to the worker.
The host worker runs the public core engine and responds with matching identities,
`state: 'complete'` and a serialized `snapshot`. Progress carries those same
identities plus nonnegative integer `work`. A host can use Web Workers or a server
worker; no worker constructor or runtime is imported by this capability.

An incomplete or corrupt snapshot never publishes. Switching builds aborts older
requests, fences late replies and retains finite in-flight admission credits.
Cancelled and superseded progress is ignored. Worker errors are explicit outcomes.
`dispose()` stops admission, aborts requests, closes the worker, drains settlements,
and releases all index/source references. The worker's disposal contract must
settle outstanding requests; a worker ignoring termination cannot prove drained
teardown. Enforce a host memory ceiling in addition to the core's logical credits.

For query/collection composition use the injected query provider and the existing
collection coordinator. Search resources do not create another application
scheduler, evaluator, catalog or range cache.

Build generations must increase strictly, including retries after a failed worker
request. Progress is fenced by identity and never regresses within a request.
