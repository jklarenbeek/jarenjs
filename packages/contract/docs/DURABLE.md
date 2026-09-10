# Durable business operations

Commands, mapped receipts, existing jobs and workflow checkpoints compose through
injected capabilities. Application models own business history, field mapping,
authorization, revision policy and arithmetic. No second authoritative ledger or
scheduler is created. These are local atomicity and recovery guarantees; external
exactly-once delivery is not claimed.

| Boundary | Durable observation | Automatic send/replay |
|---|---|---|
| Same command identity/hash on HTTP, local or job | Original validated outcome | Business effect replays without another mutation |
| Different payload/hash version | Identity mismatch | Refused before mutation |
| Current actor unauthorized | No historic disclosure | Refused before receipt read |
| Output/error/receipt/commit failure | Entire local transaction rolls back | No business receipt exists |
| Declared committed failure | Validated observation and stable references | Historic failure replays |
| Lease/HTTP TTL expires | Business receipt remains | Receipt wins before work admission |
| Before external sending intent | Prepared leg | A valid job fence may admit its first send |
| Sending intent, lost response or lost settlement | Unresolved leg | No automatic resend |
| One confirmed leg, one unresolved leg | Both per-leg observations retained | Confirmed leg skipped; unresolved leg awaits evidence |
| Provider idempotency guarantee and explicit retry decision | Original key and finite attempt budget | Only the approved next attempt is admitted |
| Probe absent without guarantee | Uncertainty retained | Refused as retry proof |
| Lease takeover | New job fence | Stale begin/settlement refused |
| Observer navigation | Run persists; observation detaches | Resume by durable cursor |
| Explicit cancellation | Intent, worker drain, final observation | Resources release after final persistence |
| Incompatible checkpoint | Stored history retained | Refused before reuse |
| Reset/compaction | Receipt identity and audit references retained | Cannot authorize unresolved replay |

Use installed public exports:

```js
import { createCommand } from '@jarenjs/contract/command';
import { createDbReceipts, createDbEffectStore, createDbRunStore } from '@jarenjs/linq/db';
import { createExternalEffects, createDomainRun } from '@jarenjs/flow';
import { createProviderExecutor } from '@jarenjs/contract/provider';
import { createRunPageHandler } from '@jarenjs/contract/app';
import { createRunObservation } from '@jarenjs/app';

// Application declarations: client, compiledContract, identity, authorize, adjust.
const receipts = createDbReceipts(client, { receipts: 'history', leases: 'claims' });
const command = createCommand(compiledContract.operations['item.adjust'], {
  repository: receipts, identity, authorize, handler: adjust,
});
// HTTP/local use { 'item.adjust': command.handler }; jobs call command.execute.
```

`test/consumer/durable.js` exercises the installed composition with synthetic data.
The receipt, external-effect and run tests include cross-process races, interrupted
multi-leg execution, second-run no-op checks and current authorization. The measured
cost probe is `npm run benchmark:durable`; its results below report overhead as
well as resource bounds. Real provider guarantees, downstream cutover, native
executables, PostgreSQL behavior and operator reconciliation acceptance require
separate host/application qualification. Synthetic Node/Bun results cannot prove
those claims. The retained reference fixtures remain unchanged.

<!--fact:durable.measurements-->

Measured on v24.19.0, linux/x64, AMD Ryzen 9 5900HX with Radeon Graphics.

| Commands | Domain/outbox ms | Durable command ms | Receipt replay ms | Added cost ratio | Sends / unresolved resends | Second writes / revisions | Events | Heap / RSS MiB | Teardown ms / resources |
|---:|---:|---:|---:|---:|---|---|---:|---|---|
| 32 | 7.09 | 15.88 | 5.42 | 2.24x | 2 / 0 | 0 / 0 | 8 | 23.69 / 112.07 | 0.28 / 0 |
| 128 | 14.73 | 33.22 | 13.35 | 2.26x | 2 / 0 | 0 / 0 | 8 | 41.05 / 123.25 | 0.13 / 0 |

Synthetic local SQLite commands and interrupted multi-leg effects. Baseline executes the same domain/outbox work without a receipt; durable execution adds validation, authorization and immutable replay. Limits are fixed acceptance ceilings, not performance claims. Real providers, downstream acceptance, native executables, PostgreSQL and operator reconciliation are pending.

<!--/fact-->
