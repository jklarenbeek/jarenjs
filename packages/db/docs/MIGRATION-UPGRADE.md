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

`openStore(..., { adopt: true })` verifies an existing physical mapping and does
not adopt migration authority. A new zero-step physical baseline starts history
for an existing schema without applied migration records; it is also a separate
operation. File-only `migrateDocuments`, `streamDocuments` and `jaren-db documents`
retain structural 0.1 compatibility because they have no database history.
