# Upgrading migration history to exact identity

New planner and migration-pen output uses `$migration: "0.2"`. Its exact model
endpoints and canonical document receipts prevent a short-hash collision from
authorizing a different artifact. Existing applied 0.1 documents and normal
history rows remain unchanged. Ordinary status/apply refuse unadopted legacy
history and newly pending 0.1 work with `JD0028`.

Use this procedure on a reviewed copy first, then follow the application's
normal backup and rollout procedure. Adoption attests the artifacts and current
model you reviewed; an old checksum cannot prove which colliding document ran.
The protocol is specified in [MIGRATION-FORMAT §5](MIGRATION-FORMAT.md#5-history-and-checksums).

A consistent backup must keep application data, `_jaren_migrations` and
`_jaren_migration_identity` together. Preserve the normal rows' ordering values
(SQLite `rowid` or PostgreSQL `rid`), columns and complete side payloads; an
application-table-only export is insufficient. Use a backend-consistent snapshot,
including committed WAL, rather than copying an open SQLite main file alone
([native backup behavior](HOSTS.md#existing-file-adoption-and-backup)). Reopen a
restored copy and verify its full history against the unchanged reviewed artifacts
before using it. Do not recreate missing receipts from short checksums.

## 1. Preserve applied artifacts before upgrading

Keep each applied JSON file byte-for-byte. Do not change `$migration`, add an
`identity`, re-plan an applied link or reevaluate its module with an upgraded pen.
`defineMigration` and planners now emit 0.2; unchanged JavaScript source can
therefore emit a different document after a dependency upgrade.

For code-first migrations, retain the old lockfile, original modules, dependencies
and model snapshots. Under that pinned old toolchain, use its status command to
identify the complete applied prefix. Capture those emissions to immutable JSON
in a separate reviewed directory, one file per applied history id, in history
order. Keep pending artifacts outside this applied-prefix directory.

For example, run this script from the preserved old checkout, with the explicit
reviewed file list substituted. It refuses to overwrite an existing capture:

```js
import { copyFileSync, constants, mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { loadDocument } from '@jarenjs/json/node';

const applied = ['migrations/0001-create.mjs', 'migrations/0002-handles.json'];
const destination = './reviewed-applied';
mkdirSync(destination);
for (const file of applied) {
  const output = join(destination, `${basename(file, extname(file))}.json`);
  if (extname(file) === '.json') copyFileSync(file, output, constants.COPYFILE_EXCL);
  else {
    const document = await loadDocument(file, { what: 'migration', exportName: 'migration' });
    writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx' });
  }
}
```

Capture the current model and original shadow baseline under the same pinned
runtime if they are code-generated. Review and preserve those outputs too. If the
upgrade already happened, an isolated checkout with the pinned old runtime can
reproduce emissions for review; that does not prove which artifact originally
ran. Never silently adopt newly emitted 0.2 replacements for applied 0.1 modules.

## 2. Observe and review the complete stored history

After installing the new release:

```sh
mkdir -p ./review
jaren-db history --store ./app.db --out ./review/history.observed.json
```

The JSON contains `version: 1`, the dialect and ordering discriminator, every
normal history row and the current exact side metadata. `rowid`/`rid`,
`applied_at` and `steps` are SQL text projections, so values beyond 2^53 and
fractional PostgreSQL timestamps survive JSON without Number rounding. Raw fields
can be null or malformed for diagnosis; observing them does not authorize them.
The command creates neither history table.

Review the complete ordered prefix against the preserved artifacts, the current
model and the application's actual data. The old id/hash/checksum/count checks
are necessary but cannot recover exact historical identity. Review physical
mappings with their complete owned schema and programs; mappings alone cannot
establish the state of triggers or indexes. Save a complete `physicalTarget`
when the final applied physical artifact does not already carry one.

## 3. Attest exactly that applied prefix

```sh
jaren-db adopt-history --store ./app.db --migrations ./reviewed-applied \
  --observed ./review/history.observed.json --model ./review/current-model.json --yes
```

Add `--physical-target ./review/physical-target.json` for an explicitly selected
complete physical target. Without `--yes`, an interactive terminal asks for
confirmation; unattended calls refuse. Adoption has no `--dry-run`. New history
command misuse exits 2; an authority or runtime failure exits 1.

The first successful result is `{ "adopted": N, "unchanged": 0 }`. These count
legacy receipts attested; no migration step executes. Only the side metadata is
written. Original history columns, ordering values, application rows and reviewed
files remain unchanged. Repeating the exact operation with its original
observation returns `{ "adopted": 0, "unchanged": N }` and writes nothing.

Changed rows, a different model/target/document, appended history, partial side
metadata or a stale observation refuse. Re-observe and review the actual state;
there is no force/allowLegacy switch or automatic metadata repair. An empty
history or a history containing only exact artifacts uses the normal 0.2 workflow
and cannot be relabeled as a legacy prefix.

For an application-managed connection, the equivalent public API is:

```js
import { migrationHistory, adoptMigrationHistory } from '@jarenjs/db';
const target = { connection };
const observed = await migrationHistory(target);
const result = await adoptMigrationHistory(target, appliedLegacyDocuments, {
  observed, model: currentModel, shadowDriver, physicalTarget,
  // Include compileSchema when logical stored-document validation is required.
});
```

Owned `{ driver, path? }` targets return promises and close acquired connections.
Borrowed synchronous targets preserve their value boundary and stay open.
Observation accepts `runtime`, `signal` and `deadline`; adoption also accepts
`physicalTarget`, `shadowDriver`, `registerFunctions`, `compileSchema`,
`expressions` and `batchSize`. Options are closed. Logical row validation is
conditional on `compileSchema`; the native CLI supplies no implicit validator.
PostgreSQL migration/adoption writers require effective `READ COMMITTED` and
refuse stronger transaction snapshots with `JD0021`, preserving caller isolation.
Read-only status/history see their caller's transaction view.

## 4. Extend the reviewed chain with new exact artifacts

Keep the adopted JSON prefix unchanged in the ordinary full migrations directory.
Author and review a new 0.2 tail from the attested current model. Old pending 0.1
files cannot execute; preserve them outside the active directory and deliberately
author/review their 0.2 replacements. `fromPlanned` accepts only current exact
artifacts and refuses recognized 0.1 input with `JL0102`.

```sh
jaren-db apply --store ./app.db --baseline ./review/original-model.json \
  --model ./model.json --migrations ./migrations --dry-run
jaren-db apply --store ./app.db --baseline ./review/original-model.json \
  --model ./model.json --migrations ./migrations --yes
jaren-db check --store ./app.db --model ./model.json --migrations ./migrations
```

The CLI dry run only prints; it still refuses unverifiable legacy authority.
Real apply performs the runner's acceptance checks before reporting success,
including no-pending runs. Model comparison is canonical, while the admitted source retains declaration
order for execution and generated program identities. Shadow replay executes the actual verified legacy
prefix on an independent empty shadow, establishes its attested boundary, then
runs the exact tail. It never copies primary receipts to skip work. Legacy
starting/intermediate exact models remain unknown; adoption establishes the
reviewed current boundary, not unavailable historical facts.

These operations establish different things:

| Operation | Result |
|---|---|
| Physical adoption: `openStore(..., { adopt: true })` | Verifies an existing physical mapping; grants no migration-history authority. |
| Identity attestation: `adopt-history` / `adoptMigrationHistory` | Records exact receipts for the reviewed applied 0.1 prefix without rerunning its steps. |
| New zero-step physical baseline | Starts 0.2 history for an existing schema with no applied migration records; saves a reviewed model-to-itself target. |
| New planner or pen output | Authors a pending 0.2 artifact; the runner applies it and records both receipt families. |

File-only `migrateDocuments`, `streamDocuments` and `jaren-db documents` retain
structural 0.1 compatibility because they have no database history.

## 5. Refusals to resolve before retrying

| Code | Meaning and next step |
|---|---|
| `JD0028` | Legacy authority needs explicit observation/attestation, or pending work is 0.1. Preserve applied files; deliberately author pending replacements as 0.2. |
| `JD0022` | The complete history, observation, exact document or side authority disagrees. Stop and compare the stored state with reviewed artifacts and backups; do not delete or regenerate receipts. |
| `JD0020` | The baseline, adjacent exact endpoints or supplied model disagree. Select the matching model snapshots and full chain without editing applied artifacts. |
| `JD0021` | A draft, target-data check, replay prerequisite or writer setting refuses. Read the named reason; provide the required transform/target/independent shadow or dedicated PostgreSQL `READ COMMITTED` scope. |
| `JD0023` | A malformed migration, failed step or physical acceptance check refuses. Inspect the reason and any classified cause before changing pending work. |
| `JL0102` | `fromPlanned` received legacy input or a model that differs from the exact planned endpoint. Keep legacy files immutable and supply the reviewed current artifact/models. |

A fresh observation is a review input, not permission to repair authority
metadata. These codes do not replace the application's restore and rollout policy.


## Measured costs

Exact identity stores complete canonical documents and model endpoints, so
storage and comparison costs grow with their size. A short fingerprint remains
useful for display; it does not replace this evidence. The migration pen adds <!--fact:bundle.migration-->25,931<!--/fact--> bytes to an otherwise empty
consumer bundle; the DB-client fixture is <!--fact:bundle.db-->836,237<!--/fact--> bytes. These are complete measured
fixture sizes, not the incremental price of identity alone.

The following native SQLite workload measures current receipts and repeat
checks. Reproduce both reports from the repository root:

```sh
node --no-warnings=ExperimentalWarning benchmark/migration-identity.js --write
bun benchmark/migration-identity.js --write
npm run docs:derive
```

The instrument records every sample, runtime and source hash. Documentation
derivation refuses stale sources or incomplete evidence. Keep the JSON reports
with the code that produced them.

<!--fact:migration.costs-->

10 SQL-only links; 500 calls per read/repeat loop; medians of 5 fresh-database samples. Every sample preserves exact application, normal-history and identity rows.

| Native runtime / SQLite | Apply all links ms | Status loop ms | No-op apply loop ms | Observation loop ms | Measured at |
|---|---:|---:|---:|---:|---|
| node 24.20.0 / 3.53.4 | 12.421 | 310.476 | 301.624 | 80.446 | 2026-10-06T18:12:01.404Z |
| bun 1.4.2 / 3.53.2 | 16.075 | 292.803 | 302.546 | 79.050 | 2026-10-06T18:12:05.228Z |

| Native runtime | Current document JSON bytes | Legacy-shaped JSON projection bytes | Side rows / key+value UTF-8 bytes | SQLite page growth bytes |
|---|---:|---:|---:|---:|
| node | 2521 | 1311 | 11 / 5147 | 24576 |
| bun | 2521 | 1311 | 11 / 5147 | 24576 |

Ten SQL-only links on a borrowed synchronous in-memory SQLite connection; shadow replay is disabled. Each sample uses a fresh database. Timed loops include result assertions; observations compare complete receipts. All samples are retained, with medians reported. Shared-host elapsed costs are not production latency or a causal comparison with the old protocol. Legacy projection bytes compare JSON serialization only; no legacy document executes. Page growth includes both history tables and application writes, not only receipt payload.

<!--/fact-->

For PostgreSQL logical backup and archived-WAL recovery measurements, see
[PostgreSQL operations](POSTGRESQL.md). Native SQLite crash and backup checks
cover receipt/adoption rollback and publication boundaries; they do not model
power loss or establish application-specific production recovery guarantees.
