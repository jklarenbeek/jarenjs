#!/usr/bin/env node
//#region the jaren-db command
// Migrations nobody drives by API stay undrifted by nobody: the CLI is
// what puts `check` in CI and a reviewable migration document in the
// repository. Six commands (MIGRATION-FORMAT §11): plan, snapshot,
// status, apply, check, shape. A model or a migration is a JSON file or
// a MODULE — the model pen's document, the migration pen's builder —
// loaded twice, because a module that emits a different document on its
// second load is one whose migration can never match its own history.

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

import { loadDocument as loadDocumentFile, isDocumentFile } from '@jarenjs/json/node';

import {
  planModelMigration, migrate, migrationStatus, shapeHash, compareShapeToModel,
  sqliteDialect, normalizeModel, normalizeEntities, explainMapping,
  planCollection, planEntity, planJoinTable, HISTORY_TABLE, entityEmitModel,
} from './index.js';
import { nodeDriver } from './drivers/node.js';

const USAGE = `jaren-db — model-driven SQLite migrations

Usage:
  jaren-db plan     --from <model> --to <model> [--store <db>] [--id <name>] [--out <file>]
  jaren-db plan     --model <model> [--snapshot <file>] [--store <db>] [--id <name>] --out <file>
  jaren-db snapshot --model <model> [--snapshot <file>] [--types <file>]
  jaren-db status   --model <model> --store <db> [--migrations <dir>] [--snapshot <file>]
  jaren-db apply    --store <db> --baseline <model> --migrations <dir> [--model <m>] [--dry-run] [--yes]
  jaren-db check    --model <model> --store <db> [--migrations <dir>] [--snapshot <file>]
  jaren-db shape    --model <model>

A <model> or a migration is a .json file, or a MODULE (.js, .mjs, .cjs —
or .ts where Node strips types) whose default export, or its 'model' /
'migration' export, is the document or a pen builder that emits one. A
module is loaded twice and refused when its two emissions differ: no
clock, no env, no randomness. --migrations reads .json files and
modules, sorted by file name.

plan      Diff two model FILES into a migration document (a database
          stores shape hashes, not models — the from-model is the
          previous model file), or diff the committed SNAPSHOT (default
          model.snapshot.json beside the model) against the model: with
          --out the migration is written and the snapshot advanced; a
          model matching its snapshot plans nothing. With --store, first
          verify the from-model matches the database's recorded shape.
snapshot  Write the model's snapshot; with --types, emit's TypeScript
          declaration for it (needs @jarenjs/emit beside @jarenjs/db).
status    Applied, pending, drift (a hand-modified database) and — with
          a snapshot — an unplanned model change.
apply     Print every statement, then apply. Destructive steps (drop
          table/column, rebuild) require --yes or an interactive
          confirmation naming what is lost. --dry-run only prints.
check     The CI command: exit 1 on an unplanned model change, pending
          migrations or drift.
shape     Print the physical mapping a model produces.
`;

function fail(message) {
  console.error(`jaren-db: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    command: argv[2], from: null, to: null, model: null, store: null,
    baseline: null, migrations: null, id: null, out: null,
    snapshot: null, types: null,
    dryRun: false, yes: false, help: false,
  };
  for (let i = 3; i < argv.length; i++) {
    switch (argv[i]) {
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
      case '--dry-run': options.dryRun = true; break;
      case '--yes': options.yes = true; break;
      case '--help': case '-h': options.help = true; break;
      default: fail(`unknown option: ${argv[i]}`);
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
    if (shapeHash(fromModel) === shapeHash(toModel)) {
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
    const driver = nodeDriver();
    const connection = await driver.open(options.store, {}).catch((error) => fail(error.message));
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

async function commandStatus(options, { asCheck }) {
  // the history and the model are what a status read needs; the
  // baseline anchors an APPLY (the chain's first shape), not a read —
  // `--baseline` is still accepted so an existing invocation keeps working
  if (options.store === null)
    fail(`${asCheck ? 'check' : 'status'} needs --store`);
  // `check` without the model verified nothing and printed "in sync"
  if (asCheck && options.model === null)
    fail('check needs --model — drift is measured against the model the code carries');
  const model = options.model !== null ? await loadDocument(options.model, 'model', 'model') : undefined;
  const migrations = await loadMigrationsDir(options.migrations);
  // the snapshot discipline, when it is in use: a model that moved
  // without a plan is named as such, never as the database's drift
  const snapshotFile = options.snapshot ?? (options.model !== null ? defaultSnapshotOf(options.model) : null);
  let unplanned = null;
  const snapshotInUse = snapshotFile !== null && (options.snapshot !== null || fs.existsSync(snapshotFile));
  if (snapshotInUse) {
    if (!fs.existsSync(snapshotFile)) fail(`no snapshot at '${snapshotFile}'`);
    const recorded = shapeHash(readJson(snapshotFile, 'snapshot'));
    const current = shapeHash(model);
    if (recorded !== current) {
      unplanned = `${snapshotFile} records shape ${recorded}, the model is ${current} — run jaren-db plan`;
    }
  }
  let status;
  try {
    status = await migrationStatus({ driver: nodeDriver(), path: options.store },
      migrations, { model });
  }
  catch (error) {
    return fail(error.message);
  }
  console.log(`applied:  ${status.applied.length === 0 ? '(none)' : status.applied.join(', ')}`);
  console.log(`pending:  ${status.pending.length === 0 ? '(none)' : status.pending.join(', ')}`);
  if (model !== undefined && status.pending.length === 0) {
    console.log(`drift:    ${status.drift === null ? 'none — in sync' : status.drift}`);
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

async function commandApply(options) {
  if (options.store === null || options.baseline === null || options.migrations === null)
    fail('apply needs --store, --baseline and --migrations');
  const baseline = await loadDocument(options.baseline, 'baseline model', 'model');
  const model = options.model !== null ? await loadDocument(options.model, 'model', 'model') : undefined;
  const migrations = await loadMigrationsDir(options.migrations);
  const target = { driver: nodeDriver(), path: options.store };

  const status = await migrationStatus(target, migrations)
    .catch((error) => fail(error.message));
  if (status.pending.length === 0) {
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

  try {
    const outcome = await migrate(target, migrations, { baseline, model });
    console.log(`applied: ${outcome.applied.join(', ')}`);
  }
  catch (error) {
    fail(error.message);
  }
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
    case 'shape': return commandShape(options);
    default: return fail(`unknown command '${options.command}' — try --help`);
  }
}

main().catch((error) => fail(error.message));

//#endregion
