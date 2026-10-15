#!/usr/bin/env node
//#region the jaren-db command
// Migrations nobody drives by API stay undrifted by nobody: the CLI is
// what puts `check` in CI and a reviewable migration document in the
// repository. Planning, status, explicit history adoption and document
// transforms share the public runners (MIGRATION-FORMAT §11).
// A model or a migration is a JSON file or
// a MODULE — the model pen's document, the migration pen's builder —
// loaded twice, because a module that emits a different document on its
// second load is one whose migration can never match its own history.

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { pathToFileURL } from 'url';

import { loadDocument as loadDocumentFile, isDocumentFile } from '@jarenjs/json/node';

import {
  planModelMigration, planColumnUpgrade, migrate, migrationStatus, migrationHistory, adoptMigrationHistory,
  shapeHash, compareShapeToModel,
  sqliteDialect, normalizeModel, normalizeEntities, explainMapping,
  planCollection, planEntity, planJoinTable, HISTORY_TABLE, entityEmitModel,
  migrateDocuments, streamDocuments, classifyAssertion,
} from './index.js';
import { nodeDriver } from './drivers/node.js';
import { modelIdentity } from './migration-identity.js';
import { prepareDocumentRun } from './documents.js';
import { normalizeAssertionBounds, createAssertionBoundGuard } from './document-steps.js';
import {
  readDocuments, readCollectionBundle, openAtomicTarget, openStreamTarget, openNullTarget,
  formatOf, DOCUMENT_FORMATS,
} from './document-files.js';

const USAGE = `jaren-db — model-driven SQLite migrations

Usage:
  jaren-db plan     --from <model> --to <model> [--store <db>] [--id <name>] [--out <file>]
  jaren-db plan     --model <model> [--snapshot <file>] [--store <db>] [--id <name>] --out <file>
  jaren-db plan     --model <model> --store <db> --upgrade-columns [--id <name>] [--out <file>]
  jaren-db snapshot --model <model> [--snapshot <file>] [--types <file>]
  jaren-db status   --model <model> --store <db> [--migrations <dir>] [--snapshot <file>]
  jaren-db apply    --store <db> --baseline <model> --migrations <dir> [--model <m>] [--dry-run] [--yes]
  jaren-db check    --model <model> --store <db> [--migrations <dir>] [--snapshot <file>]
  jaren-db shape    --model <model>
  jaren-db history  --store <db> [--out <observation.json>]
  jaren-db adopt-history --store <db> --migrations <applied-prefix-dir>
                        --observed <observation.json> --model <model> [--physical-target <json>] [--yes]
  jaren-db documents --migrations <dir> --in <file|-> (--out <file|-> | --in-place --yes | --check)
                     [--format json|jsonl|collections] [--out-format json|jsonl|collections]
                     [--in collection=file ...] [--collection <name>] [--batch-size <n>]
                     [--max-rows <n|none>] [--max-bytes <n|none>] [--max-distinct <n>]

A <model> or a migration is a .json file, or a MODULE (.js, .mjs, .cjs —
or .ts where Node strips types) whose default export, or its 'model' /
'migration' export, is the document or a pen builder that emits one. A
module is loaded twice and refused when its two emissions differ: no
clock, no env, no randomness. --migrations reads .json files and
modules, sorted by file name.

plan      Diff two model FILES into an exact 0.2 migration document,
          or diff the committed SNAPSHOT (default
          model.snapshot.json beside the model) against the model: with
          --out the migration is written and the snapshot advanced; a
          model matching its snapshot plans nothing. With --store, first
          verify the from-model's physical shape against the database.
          With --upgrade-columns, plan instead the link that rebuilds the
          generated columns, index expressions and interval CHECKs the
          --store tables hold as an earlier release created them, from
          the model the database holds to itself; the snapshot is neither
          read nor advanced, and a database that holds what this release
          creates plans nothing and writes nothing. Apply the link as the
          next of --migrations.
snapshot  Write the model's snapshot; with --types, emit's TypeScript
          declaration for it (needs @jarenjs/emit beside @jarenjs/db).
status    Applied, pending, drift (a hand-modified database) and — with
          a snapshot — an unplanned model change.
apply     Print every statement, then apply. Destructive steps (drop
          table/column, rebuild) require --yes or an interactive
          confirmation naming what is lost. --dry-run only prints.
          A database that drifted from the target exits 1, also after
          pending links applied (they stay committed).
check     The CI command: exit 1 on an unplanned model change, pending
          migrations or drift.
shape     Print the physical mapping a model produces.
history   Read full history and exact metadata as one JSON observation;
          create neither table. --out writes that JSON to a file.
adopt-history
          Attest the complete reviewed applied 0.1 prefix and current
          model against --observed; record only exact side metadata.
          Requires --yes or interactive confirmation. No steps run.
          Keep original applied artifacts; never regenerate them with
          an upgraded planner. No --dry-run. Exit: 2 command misuse,
          1 runtime/authority refusal. Ordinary status/apply refuse
          unadopted or newly pending 0.1 documents (JD0028).
documents Run a migration's DOCUMENT steps (jslt, query) over a file of
          documents instead of a database — a JSON array or JSONL, a
          path or stdio. A step that needs tables (ddl, sql, rebuild,
          derive) is refused by name before the first document is read.
          --out writes a new file, --in-place replaces the input (a
          sibling temporary is renamed over it only once every document
          has survived every step; any failure leaves the original byte
          for byte), and --check transforms and validates everything
          while writing nothing. Exit: 0 applicable and valid, 1 a
          migration or source failure, 2 a misuse of this command line.

status, check, history, apply --dry-run, plan --store (with or without
--upgrade-columns) and adopt-history never create a --store database named by a plain path: one that does not
exist is refused (exit 1). An apply that is only printed, or that finds
nothing pending without --yes, creates nothing either. :memory: is an
empty database. A file: URI reaches SQLite as written, so its own mode
decides: without mode=ro or mode=rw, every command creates a missing file.
`;

function fail(message) {
  console.error(`jaren-db: ${message}`);
  process.exit(1);
}

/**
 * A command line that cannot be obeyed — a missing flag, two flags that
 * contradict, a value that names nothing. Distinct from `fail`, because
 * a caller scripting this command has to tell "you asked for the wrong
 * thing" (2) from "what you asked for did not hold" (1).
 */
function misuse(message) {
  console.error(`jaren-db: ${message}`);
  process.exit(2);
}

/** The flags that take the argument after them as their value. */
const VALUE_FLAGS = new Set([
  '--from', '--to', '--model', '--store', '--baseline', '--migrations', '--id', '--out', '--snapshot',
  '--types', '--observed', '--physical-target', '--in', '--max-rows', '--max-bytes', '--max-distinct',
  '--out-format', '--format', '--collection', '--batch-size',
]);

/**
 * The flags each command reads. A flag some other command reads is refused
 * by name: taken and ignored, `snapshot --out file` wrote the default
 * snapshot beside the model instead, and `apply --check` applied.
 */
const COMMAND_FLAGS = Object.freeze({
  plan: ['--from', '--to', '--model', '--store', '--id', '--out', '--snapshot', '--upgrade-columns'],
  snapshot: ['--model', '--snapshot', '--types'],
  status: ['--model', '--store', '--migrations', '--snapshot', '--baseline'],
  check: ['--model', '--store', '--migrations', '--snapshot', '--baseline'],
  apply: ['--store', '--baseline', '--migrations', '--model', '--dry-run', '--yes'],
  shape: ['--model'],
  history: ['--store', '--out'],
  'adopt-history': ['--store', '--migrations', '--observed', '--model', '--physical-target', '--yes'],
  documents: ['--migrations', '--in', '--out', '--in-place', '--check', '--yes', '--format', '--out-format',
    '--collection', '--batch-size', '--max-rows', '--max-bytes', '--max-distinct'],
});
/** Every flag some command reads, and the two helps every command takes. */
const KNOWN_FLAGS = new Set([...Object.values(COMMAND_FLAGS).flat(), '--help', '-h']);

function parseArgs(argv) {
  const options = {
    command: argv[2], from: null, to: null, model: null, store: null,
    baseline: null, migrations: null, id: null, out: null,
    snapshot: null, types: null, observed: null, physicalTarget: null,
    inputs: [], maxRows: undefined, maxBytes: undefined, maxDistinct: undefined,
    in: null, format: null, outFormat: null, collection: null,
    batchSize: null, inPlace: false, check: false, upgradeColumns: false,
    dryRun: false, yes: false, help: false,
  };
  const historyCommand = options.command === 'history' || options.command === 'adopt-history';
  const taken = Object.hasOwn(COMMAND_FLAGS, options.command) ? new Set(COMMAND_FLAGS[options.command]) : null;
  for (let i = 3; i < argv.length; i++) {
    const flag = argv[i];
    if (historyCommand) {
      if (!taken.has(flag) && flag !== '--help' && flag !== '-h') misuse(`${options.command} does not take '${flag}'`);
      if (!['--yes', '--help', '-h'].includes(flag)
        && (!argv[i + 1] || argv[i + 1].startsWith('--') || argv[i + 1] === '-h'))
        misuse(`${flag} needs a value`);
    }
    if ((flag === '--observed' || flag === '--physical-target') && options.command !== 'adopt-history')
      misuse(`${flag} is only used by adopt-history`);
    // a flag another command reads is not this one's: ignoring it would run
    // the command without the thing the flag was asked to do
    if (taken !== null && KNOWN_FLAGS.has(flag) && flag !== '--help' && flag !== '-h' && !taken.has(flag))
      (options.command === 'documents' ? misuse : fail)(`${options.command} does not take '${flag}'`);
    // a value flag with nothing after it, or another flag in its place, has
    // no value: taking the next flag for it named a file `--id`, and none at
    // all stored `undefined`, which a command read as an absent option
    if (VALUE_FLAGS.has(flag) && (argv[i + 1] === undefined || argv[i + 1].startsWith('--')))
      (options.command === 'documents' ? misuse : fail)(`${flag} needs a value`);
    switch (flag) {
      case '--from': options.from = argv[++i]; break;
      case '--to': options.to = argv[++i]; break;
      case '--model': options.model = argv[++i]; break;
      case '--store': options.store = argv[++i]; break;
      case '--baseline': options.baseline = argv[++i]; break;
      case '--migrations': options.migrations = argv[++i]; break;
      case '--id': options.id = argv[++i]; break;
      case '--out': options.out = argv[++i]; break;
      case '--snapshot': options.snapshot = argv[++i]; break;
      case '--types': options.types = argv[++i]; break;
      case '--observed': options.observed = argv[++i]; break;
      case '--physical-target': options.physicalTarget = argv[++i]; break;
      case '--in': options.in = argv[++i]; options.inputs.push(options.in); break;
      case '--max-rows': options.maxRows = argv[++i]; break;
      case '--max-bytes': options.maxBytes = argv[++i]; break;
      case '--max-distinct': options.maxDistinct = argv[++i]; break;
      case '--out-format': options.outFormat = argv[++i]; break;
      case '--format': options.format = argv[++i]; break;
      case '--collection': options.collection = argv[++i]; break;
      case '--batch-size': options.batchSize = argv[++i]; break;
      case '--in-place': options.inPlace = true; break;
      case '--check': options.check = true; break;
      case '--upgrade-columns': options.upgradeColumns = true; break;
      case '--dry-run': options.dryRun = true; break;
      case '--yes': options.yes = true; break;
      case '--help': case '-h': options.help = true; break;
      // an unrecognised flag is a misuse of the command line, which is
      // what `documents` promises exit 2 for; the five older commands
      // keep the exit 1 their published contract has always used
      default: (options.command === 'documents' ? misuse : fail)(`unknown option: ${argv[i]}`);
    }
  }
  return options;
}

/** A committed snapshot: JSON on disk, read as it is. */
const readJson = (file, what) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  catch (error) {
    return fail(`cannot read ${what} '${file}': ${error.message}`);
  }
};

/**
 * A model or migration document: a `.json` file, or a module loaded
 * TWICE — an emission that changes between loads is not pure (a clock,
 * the environment, randomness), and a migration that hashes differently
 * per load can never match its own history. The loader is the suite's
 * one (`@jarenjs/json/node`, shared with `jaren-contract`); every
 * refusal it names exits here under this CLI's prefix.
 */
async function loadDocument(file, what, exportName) {
  try {
    return await loadDocumentFile(file, { what, exportName, impure: 'no clock, no env, no randomness in a model or migration module' });
  }
  catch (error) {
    return fail(error.message);
  }
}

/** The migrations directory, sorted by file name — the full ordered chain. */
const loadMigrationsDir = async (dir) => {
  if (dir === null) return [];
  const files = fs.readdirSync(dir)
    .filter((file) => isDocumentFile(file))
    .sort();
  const migrations = [];
  for (const file of files) migrations.push(await loadDocument(path.join(dir, file), 'migration', 'migration'));
  return migrations;
};

/** The committed snapshot beside a model, unless one is named. */
const defaultSnapshotOf = (modelFile) => path.join(path.dirname(modelFile), 'model.snapshot.json');

/** Write a file only when its text changed — two runs on one input change nothing. */
const writeIfChanged = (file, text) => {
  const same = fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text;
  if (!same) fs.writeFileSync(file, text);
  return same;
};

/**
 * Whether --store names a plain file path with no file behind it. SQLite
 * reads ':memory:' (and '') as a private database and a `file:` name as a
 * URI it resolves itself, so neither is a missing file.
 */
const storeMissing = (store) => store !== '' && store !== ':memory:' && !store.startsWith('file:')
  && !fs.existsSync(store);

/**
 * A command that reads, plans against or attests the database it names never
 * creates one: the driver's open creates a missing file, so a mistyped --store
 * would be reported as an empty, reviewable history. It is refused before
 * anything opens it.
 */
const requireStore = (store) => {
  if (storeMissing(store)) fail(`the database file does not exist: ${store}`);
};

/**
 * The spelling under which those commands open --store: a plain path becomes
 * a `file:` URI with `mode=rw`, which SQLite opens for reading and writing but
 * never creates, so a file removed after `requireStore` looked fails the open
 * instead of being created again. ':memory:', '' and a `file:` URI reach
 * SQLite as written, and so does a network path, whose URI would name an
 * authority SQLite does not open.
 */
const existingStore = (store) => {
  if (store === '' || store === ':memory:' || store.startsWith('file:')) return store;
  const url = pathToFileURL(path.resolve(store));
  return url.host === '' ? `${url.href}?mode=rw` : store;
};

/** What a migration will destroy, by note — the confirmation names it. */
const lossesOf = (migration) => migration.steps
  .filter((step) => /DESTRUCTIVE/.test(step.note ?? '') || step.kind === 'rebuild')
  .map((step) => step.note ?? `${step.kind} '${step.table ?? ''}'`);

const renderSteps = (migration) => {
  for (const step of migration.steps) {
    if (step.kind === 'ddl' || step.kind === 'sql') console.log(`  ${step.sql}`);
    else if (step.kind === 'rebuild') {
      for (const sql of step.create) console.log(`  ${sql}`);
      console.log(`  ${step.copy}`);
      console.log(`  -- drop '${step.table}', rename '${step.table}__rebuild', `
        + 'recreate indexes, PRAGMA foreign_key_check (§10)');
      for (const sql of step.indexes) console.log(`  ${sql}`);
    }
    else console.log(`  -- ${step.kind}${step.draft ? ' (DRAFT)' : ''}: ${step.note ?? ''}`);
  }
};

async function commandPlan(options) {
  if (options.upgradeColumns) return commandPlanUpgrade(options);
  let fromModel;
  let toModel;
  let snapshotFile = null;
  if (options.model !== null) {
    if (options.from !== null || options.to !== null)
      fail('plan takes either --from and --to model files, or --model with its --snapshot — not both');
    snapshotFile = options.snapshot ?? defaultSnapshotOf(options.model);
    if (!fs.existsSync(snapshotFile)) {
      fail(`no snapshot at '${snapshotFile}' — write one from the model the store was created with: `
        + `jaren-db snapshot --model <baseline> --snapshot '${snapshotFile}'`);
    }
    fromModel = readJson(snapshotFile, 'snapshot');
    toModel = await loadDocument(options.model, 'model', 'model');
    if (modelIdentity(fromModel) === modelIdentity(toModel)) {
      console.log(`no change — the model matches its snapshot (${snapshotFile}); nothing to plan`);
      return;
    }
  }
  else {
    if (options.from === null || options.to === null)
      fail('plan needs --from and --to model files, or --model with a committed --snapshot');
    fromModel = await loadDocument(options.from, 'from-model', 'model');
    toModel = await loadDocument(options.to, 'to-model', 'model');
  }
  if (options.store !== null) {
    // the from-model is compared with the database's SHAPE directly:
    // asking the history with an empty chain refused every database
    // that had applied a migration (JD0022), which is every database
    // one plans a second migration for
    requireStore(options.store);
    const driver = nodeDriver();
    const connection = await driver.open(existingStore(options.store), {}).catch((error) => fail(error.message));
    const drift = await Promise.resolve(compareShapeToModel(driver, connection, fromModel, undefined))
      .catch((error) => fail(error.message));
    await connection.close();
    if (drift !== null) {
      fail(`the store does not match the from-model (${drift}) — `
        + 'is this really the previous model?');
    }
  }
  const { migration, report } = planModelMigration(fromModel, toModel, {
    dialect: sqliteDialect,
    id: options.id ?? undefined,
  });
  const rendered = JSON.stringify(migration, null, 2);
  if (options.out !== null) {
    fs.writeFileSync(options.out, rendered + '\n');
    console.log(`wrote ${options.out} (${migration.steps.length} step(s))`);
  }
  else {
    console.log(rendered);
  }
  if (report.drafts.length > 0) {
    console.error(`NOTE: draft data transform(s) for ${report.drafts.join(', ')} — `
      + 'fill them in before applying');
  }
  if (report.destructive) console.error('NOTE: this migration is DESTRUCTIVE');
  if (snapshotFile !== null) {
    if (options.out === null) {
      console.error(`NOTE: the snapshot was not advanced — plan with --out to write the migration and move ${snapshotFile}`);
    }
    else {
      writeIfChanged(snapshotFile, JSON.stringify(toModel, null, 2) + '\n');
      console.log(`advanced ${snapshotFile} (shape ${shapeHash(toModel)})`);
    }
  }
}

/**
 * `plan --upgrade-columns`: the link `planColumnUpgrade` plans from the catalog
 * of --store for the model the database holds, printed or written as `plan`
 * writes a migration. The store is first verified against the model, as `plan
 * --store` verifies the from-model; a database that holds what this release
 * creates plans no step, and nothing is written.
 */
async function commandPlanUpgrade(options) {
  if (options.from !== null || options.to !== null)
    fail('plan --upgrade-columns takes --model, the model the database holds, not --from and --to');
  if (options.snapshot !== null)
    fail('plan --upgrade-columns plans from the database, not from a --snapshot');
  if (options.model === null || options.store === null)
    fail('plan --upgrade-columns needs --model and --store');
  const model = await loadDocument(options.model, 'model', 'model');
  requireStore(options.store);
  const driver = nodeDriver();
  const connection = await driver.open(existingStore(options.store), {}).catch((error) => fail(error.message));
  let planned;
  try {
    const drift = await Promise.resolve(compareShapeToModel(driver, connection, model, undefined));
    if (drift !== null) fail(`the store does not match the model (${drift}) — is this the model the database holds?`);
    planned = await Promise.resolve(planColumnUpgrade(connection, model, options.id === null ? undefined : { id: options.id }));
  }
  catch (error) {
    fail(error.message);
  }
  finally {
    await connection.close();
  }
  const { migration, report } = planned;
  if (migration.steps.length === 0) {
    console.log(`no upgrade — the tables of ${options.store} hold what this release creates for the model; nothing to plan`);
    return;
  }
  const rendered = JSON.stringify(migration, null, 2);
  if (options.out !== null) {
    fs.writeFileSync(options.out, rendered + '\n');
    console.log(`wrote ${options.out} (${migration.steps.length} step(s))`);
  }
  else {
    console.log(rendered);
  }
  console.error(`NOTE: the link rebuilds ${report.upgraded.join(', ')} — apply it as the next link of the chain`);
}

async function commandStatus(options, { asCheck }) {
  // the history and the model are what a status read needs; the
  // baseline anchors an APPLY (the chain's first shape), not a read —
  // `--baseline` is still accepted so an existing invocation keeps working
  if (options.store === null)
    fail(`${asCheck ? 'check' : 'status'} needs --store`);
  // `check` without the model verified nothing and printed "in sync"
  if (asCheck && options.model === null)
    fail('check needs --model — drift is measured against the model the code carries');
  requireStore(options.store);
  const model = options.model !== null ? await loadDocument(options.model, 'model', 'model') : undefined;
  const migrations = await loadMigrationsDir(options.migrations);
  // the snapshot discipline, when it is in use: a model that moved
  // without a plan is named as such, never as the database's drift
  const snapshotFile = options.snapshot ?? (options.model !== null ? defaultSnapshotOf(options.model) : null);
  let unplanned = null;
  const snapshotInUse = snapshotFile !== null && (options.snapshot !== null || fs.existsSync(snapshotFile));
  if (snapshotInUse) {
    if (!fs.existsSync(snapshotFile)) fail(`no snapshot at '${snapshotFile}'`);
    const snapshot = readJson(snapshotFile, 'snapshot');
    if (modelIdentity(snapshot) !== modelIdentity(model)) {
      unplanned = `${snapshotFile} and the model have different exact shapes `
        + `(fingerprints ${shapeHash(snapshot)} / ${shapeHash(model)}) — run jaren-db plan`;
    }
  }
  let status;
  try {
    status = await migrationStatus({ driver: nodeDriver(), path: existingStore(options.store) },
      migrations, unplanned === null ? { model } : {});
  }
  catch (error) {
    return fail(error.message);
  }
  console.log(`applied:  ${status.applied.length === 0 ? '(none)' : status.applied.join(', ')}`);
  console.log(`pending:  ${status.pending.length === 0 ? '(none)' : status.pending.join(', ')}`);
  if (model !== undefined && status.pending.length === 0) {
    console.log(`drift:    ${unplanned !== null ? 'not checked — the model differs from its snapshot'
      : status.drift === null ? 'none — in sync' : status.drift}`);
  }
  if (snapshotInUse) {
    console.log(`model:    ${unplanned === null ? 'planned — matches its snapshot' : `UNPLANNED change — ${unplanned}`}`);
  }
  if (asCheck) {
    if (unplanned !== null)
      fail(`unplanned model change: ${unplanned}`);
    if (status.pending.length > 0)
      fail(`${status.pending.length} pending migration(s) — run jaren-db apply`);
    if (status.drift !== null)
      fail(`the database drifted from the model: ${status.drift}`);
    console.log('in sync');
  }
}

const confirm = (question) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(question, (answer) => {
    rl.close();
    resolve(/^y(es)?$/i.test(answer.trim()));
  });
});

async function commandHistory(options) {
  if (options.store === null) misuse('history needs --store');
  requireStore(options.store);
  const observed = await migrationHistory({ driver: nodeDriver(), path: existingStore(options.store) });
  const json = `${JSON.stringify(observed, null, 2)}\n`;
  if (options.out === null) process.stdout.write(json);
  else writeIfChanged(options.out, json);
}

async function commandAdoptHistory(options) {
  if ([options.store, options.migrations, options.observed, options.model].some((value) => value === null))
    misuse('adopt-history needs --store, --migrations, --observed and --model');
  // an attestation is of a database that holds the observed history
  requireStore(options.store);
  const observed = readJson(options.observed, 'history observation');
  const model = await loadDocument(options.model, 'current model', 'model');
  const migrations = await loadMigrationsDir(options.migrations);
  const physicalTarget = options.physicalTarget === null ? undefined : readJson(options.physicalTarget, 'physical target');
  if (!options.yes) {
    if (!process.stdin.isTTY) fail('adopt-history needs --yes (no interactive terminal to ask) — nothing was adopted');
    const answer = await confirm(`Attest ${migrations.length} reviewed legacy migration(s) without executing steps? [y/N] `);
    if (!answer) fail('aborted — nothing was adopted');
  }
  const outcome = await adoptMigrationHistory({ driver: nodeDriver(), path: existingStore(options.store) }, migrations,
    { observed, model, ...(physicalTarget === undefined ? {} : { physicalTarget }) });
  console.log(JSON.stringify(outcome));
}

async function commandApply(options) {
  if (options.store === null || options.baseline === null || options.migrations === null)
    fail('apply needs --store, --baseline and --migrations');
  // a dry run only reads; a real apply may create a new store
  if (options.dryRun) requireStore(options.store);
  const baseline = await loadDocument(options.baseline, 'baseline model', 'model');
  const model = options.model !== null ? await loadDocument(options.model, 'model', 'model') : undefined;
  const migrations = await loadMigrationsDir(options.migrations);
  const target = { driver: nodeDriver(), path: options.store };

  // the printout reads the store without creating it: a store that does not
  // exist yet reads as the empty database a confirmed apply creates, so an
  // apply that is only printed, or declined, leaves no file behind
  const reading = storeMissing(options.store) ? { driver: nodeDriver() }
    : { driver: nodeDriver(), path: existingStore(options.store) };
  const status = await migrationStatus(reading, migrations, options.dryRun ? {} : { model })
    .catch((error) => fail(error.message));
  if (status.pending.length === 0) {
    if (options.dryRun) {
      console.log('nothing to apply — dry run');
      return;
    }
    if (status.drift !== null)
      fail(`the database drifted from the target: ${status.drift}`);
    // nothing pending on a store that does not exist is an empty chain, which
    // the runner has nothing to check against: without --yes, nothing
    // confirms creating the store, so the report is all this apply does
    if (options.yes || !storeMissing(options.store)) {
      await migrate(target, migrations, { baseline, model })
        .catch((error) => fail(error.message));
    }
    console.log('nothing to apply — up to date');
    return;
  }
  console.log(`pending: ${status.pending.join(', ')}`);
  const pendingDocs = migrations.slice(status.applied.length);
  for (const migration of pendingDocs) {
    console.log(`-- ${migration.id} (${migration.from.slice(0, 8)} → ${migration.to.slice(0, 8)})`);
    renderSteps(migration);
  }
  if (options.dryRun) return;

  const losses = pendingDocs.flatMap(lossesOf);
  if (losses.length > 0 && !options.yes) {
    console.log('\nThis migration is destructive:');
    for (const loss of losses) console.log(`  - ${loss}`);
    if (!process.stdin.isTTY) {
      fail('destructive steps need --yes (no interactive terminal to ask)');
    }
    const answer = await confirm('Apply anyway? [y/N] ');
    if (!answer) fail('aborted — nothing was applied');
  }
  else if (!options.yes) {
    // "default is dry-run + ask" (MIGRATION-FORMAT §11): where nobody
    // can be asked, the statements above are the dry run and nothing runs
    if (!process.stdin.isTTY) fail('apply needs --yes (no interactive terminal to ask) — nothing was applied');
    const answer = await confirm('Apply? [y/N] ');
    if (!answer) fail('aborted — nothing was applied');
  }

  let outcome;
  try {
    outcome = await migrate(target, migrations, { baseline, model });
  }
  catch (error) {
    fail(error.message);
  }
  console.log(`applied: ${outcome.applied.join(', ')}`);
  // the verdict the identical no-op rerun gives: the links stay committed,
  // and a database that drifted from the target still fails the command
  const after = await migrationStatus(target, migrations, { model }).catch((error) => fail(error.message));
  if (after.drift !== null) fail(`the database drifted from the target: ${after.drift}`);
}

async function commandSnapshot(options) {
  if (options.model === null) fail('snapshot needs --model');
  const model = await loadDocument(options.model, 'model', 'model');
  const snapshotFile = options.snapshot ?? defaultSnapshotOf(options.model);
  const same = writeIfChanged(snapshotFile, JSON.stringify(model, null, 2) + '\n');
  console.log(`${same ? 'unchanged' : 'wrote'} ${snapshotFile} (shape ${shapeHash(model)})`);
  if (options.types === null) return;
  // emit is loaded lazily, and only here: db does not depend on it, so a
  // host without it is told exactly what --types needs
  let emit;
  let typescript;
  try {
    emit = await import('@jarenjs/emit');
    typescript = await import('@jarenjs/emit/typescript');
  }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
      return fail(`--types needs @jarenjs/emit beside @jarenjs/db, and it does not resolve `
        + `(${error.message}) — install it: npm install @jarenjs/emit`);
    }
    throw error;
  }
  const declaration = typescript.renderTypeScript(
    entityEmitModel(model, { compile: emit.compileEmitModel, source: options.model }), {});
  const sameTypes = writeIfChanged(options.types, declaration);
  console.log(`${sameTypes ? 'unchanged' : 'wrote'} ${options.types}`);
}

async function commandShape(options) {
  if (options.model === null) fail('shape needs --model');
  const model = await loadDocument(options.model, 'model', 'model');
  console.log(`shape hash: ${shapeHash(model)}`);
  for (const collection of normalizeModel(model).values()) {
    for (const sql of planCollection(collection.name, collection, sqliteDialect).createSql)
      console.log(sql);
  }
  if (normalizeEntities(model).size > 0) {
    const mapping = explainMapping(model);
    for (const name of Object.keys(mapping.entities)) {
      for (const sql of planEntity(name, mapping.entities[name], mapping, sqliteDialect).createSql)
        console.log(sql);
    }
    for (const name of Object.keys(mapping.joinTables)) {
      for (const sql of planJoinTable(name, mapping.joinTables[name], mapping, sqliteDialect).createSql)
        console.log(sql);
    }
  }
  console.log(`-- history rides in '${HISTORY_TABLE}'`);
}

/**
 * Run a migration's document steps over a file of documents.
 *
 * The runner is chosen by what the migration asks for, and named in the
 * report: a cross-document assertion needs every document at once, so
 * its collection is read into memory; anything else streams, holding one
 * batch. Reading a rewindable FILE for the first is not a compromise —
 * it is the same source, read twice.
 */
async function commandDocuments(options) {
  if (options.migrations === null) misuse('documents needs --migrations <dir>');
  if (options.inputs.length === 0) misuse('documents needs --in <file> (or - for standard input)');
  const multiple = options.inputs.length > 1 || /^[A-Za-z_][A-Za-z0-9_]*=/.test(options.in);
  if (multiple && options.inPlace)
    misuse('multiple sources require one --out collection bundle; several in-place renames are not atomic');
  const sinks = [options.out !== null, options.inPlace, options.check].filter(Boolean).length;
  if (sinks !== 1) misuse('documents takes exactly one of --out <file>, --in-place and --check');
  if (options.inPlace && options.in === '-') misuse('--in-place needs a file to replace, not standard input');
  if (options.inPlace && !options.yes) misuse('--in-place rewrites the input file — pass --yes to confirm, or --out to write elsewhere');
  const batchSize = options.batchSize === null ? 500 : Number(options.batchSize);
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) misuse('--batch-size must be a positive integer');
  const declared = {};
  for (const name of ['maxRows', 'maxBytes', 'maxDistinct']) {
    if (options[name] === undefined) continue;
    declared[name] = options[name] === 'none' ? null : Number(options[name]);
  }
  let assertionBounds;
  try { assertionBounds = normalizeAssertionBounds(declared); }
  catch (error) { misuse(error.message); }
  const inFormat = options.format;
  const bundleInput = inFormat === 'collections';
  if (inFormat !== null && ![...DOCUMENT_FORMATS, 'collections'].includes(inFormat))
    misuse('--format must be one of json, jsonl or collections');
  if (bundleInput && multiple) misuse('--format collections takes one bundle file');
  const target = options.inPlace ? options.in : options.out;
  const toStdout = target === '-';
  const migrations = await loadMigrationsDir(options.migrations);
  if (migrations.length === 0) fail(`no migration documents in '${options.migrations}'`);
  const documentSteps = migrations.flatMap((migration) => migration.steps)
    .filter((step) => step.kind === 'jslt' || step.kind === 'query');
  const named = [...new Set(documentSteps.map((step) => step.collection))];
  const files = {};
  if (multiple) {
    if (options.collection !== null) misuse('named --in sources already declare their collections');
    for (const input of options.inputs) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/.exec(input);
      if (match === null) misuse('each named --in must be collection=file');
      if (Object.hasOwn(files, match[1])) misuse(`duplicate input collection '${match[1]}'`);
      Object.defineProperty(files, match[1], { value: match[2], enumerable: true });
    }
    if (Object.values(files).filter((file) => file === '-').length > 1) misuse('standard input can supply only one collection');
  }
  else if (!bundleInput) {
    if (named.length > 1) fail(`a document file holds one collection, but these migrations touch ${named.join(', ')}; supply --in collection=file for every collection, or --format collections`);
    const name = named[0] ?? options.collection ?? 'documents';
    if (options.collection !== null && options.collection !== name) misuse(`--collection names '${options.collection}', but these migrations touch '${name}'`);
    Object.defineProperty(files, name, { value: options.in, enumerable: true });
  }
  const runOptions = { batchSize, assertionBounds };
  // Physical and compilation refusals precede every document read, including
  // the materializing route. A bundle's actual collection inventory is checked
  // again after its bounded parse.
  prepareDocumentRun(bundleInput ? named : Object.keys(files), migrations, runOptions);
  let state;
  if (bundleInput) state = await readCollectionBundle(options.in === '-' ? process.stdin : options.in, assertionBounds);
  const names = bundleInput ? Object.keys(state) : Object.keys(files);
  prepareDocumentRun(names, migrations, runOptions);
  const outFormat = options.outFormat ?? (multiple || bundleInput ? 'collections'
    : options.check || toStdout ? inFormat ?? (options.in === '-' ? 'jsonl' : formatOf(options.in)) : formatOf(target));
  if (!['json', 'jsonl', 'collections'].includes(outFormat)) misuse('--out-format must be json, jsonl or collections');
  if (names.length > 1 && outFormat !== 'collections') misuse('multiple collections require --out-format collections');
  const materializes = bundleInput || documentSteps.some((step) => step.kind === 'query'
    && classifyAssertion(step.assert, { expect: step.expect, maxDistinct: assertionBounds.maxDistinct }).strategy === 'materialize');
  const sources = Object.fromEntries(Object.entries(files).map(([name, file]) => [name,
    readDocuments(file === '-' ? process.stdin : file, inFormat ?? (file === '-' ? 'jsonl' : formatOf(file)))]));
  let sink;
  if (options.check) sink = openNullTarget();
  else if (toStdout) sink = openStreamTarget(process.stdout, outFormat, { collections: names });
  else sink = await openAtomicTarget(target, outFormat, { collections: names });
  try {
    let report;
    if (materializes) {
      if (!bundleInput) {
        state = {};
        for (const name of names) {
          const documents = [], guard = createAssertionBoundGuard(assertionBounds, name, 'the file runner');
          for await (const document of sources[name]) { guard.admit(document); documents.push(document); }
          Object.defineProperty(state, name, { value: documents, enumerable: true });
        }
      }
      const out = await migrateDocuments(state, migrations, runOptions);
      report = out.report;
      for (const name of names) for (const document of out.documents[name]) await sink.write(document, name);
    }
    else report = await streamDocuments(sources, migrations,
      { ...runOptions, write: (name, document) => sink.write(document, name) });
    const written = await sink.commit();
    for (const name of names) {
      const counts = report.counts[name] ?? { read: 0, transformed: 0, asserted: 0 };
      console.log(`${options.check ? 'checked' : 'migrated'} '${name}': ${counts.read} read, `
        + `${counts.transformed} transformed, ${counts.asserted} asserted (${report.strategy[name]})`);
    }
    console.log(`applied: ${report.applied.join(', ')}`);
    if (options.check) console.log('checked only — nothing was written');
    else if (toStdout) console.log(`wrote ${written.documents} document(s) to standard output`);
    else console.log(`wrote ${written.documents} document(s) to ${target} (${written.bytes} bytes)`);
  }
  catch (error) {
    try { await sink.abort(); }
    catch (cleanupError) { error.cleanupError = cleanupError; }
    return fail(error.message);
  }
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.help || options.command === '--help' || options.command === '-h'
    || options.command === undefined) {
    console.log(USAGE);
    process.exit(options.command === undefined && !options.help ? 1 : 0);
  }
  switch (options.command) {
    case 'plan': return commandPlan(options);
    case 'snapshot': return commandSnapshot(options);
    case 'status': return commandStatus(options, { asCheck: false });
    case 'check': return commandStatus(options, { asCheck: true });
    case 'apply': return commandApply(options);
    case 'history': return commandHistory(options);
    case 'adopt-history': return commandAdoptHistory(options);
    case 'shape': return commandShape(options);
    case 'documents': return commandDocuments(options);
    default: return fail(`unknown command '${options.command}' — try --help`);
  }
}

main().catch((error) => fail(error.message));

//#endregion
