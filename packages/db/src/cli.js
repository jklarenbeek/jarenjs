#!/usr/bin/env node
//#region the jaren-db command
// Migrations nobody drives by API stay undrifted by nobody: the CLI is
// what puts `check` in CI and a reviewable migration document in the
// repository. Five commands (MIGRATION-FORMAT §11): plan, status,
// apply, check, shape.

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

import {
  planModelMigration, migrate, migrationStatus, shapeHash, compareShapeToModel,
  sqliteDialect, normalizeModel, normalizeEntities, explainMapping,
  planCollection, planEntity, planJoinTable, HISTORY_TABLE,
} from './index.js';
import { nodeDriver } from './drivers/node.js';

const USAGE = `jaren-db — model-driven SQLite migrations

Usage:
  jaren-db plan   --from <model> --to <model> [--store <db>] [--id <name>] [--out <file>]
  jaren-db status --model <model> --store <db> --baseline <model> [--migrations <dir>]
  jaren-db apply  --store <db> --baseline <model> --migrations <dir> [--model <m>] [--dry-run] [--yes]
  jaren-db check  --model <model> --store <db> --baseline <model> [--migrations <dir>]
  jaren-db shape  --model <model>

plan    Diff two model FILES into a migration document (a database
        stores shape hashes, not models — the from-model is the
        previous model file). With --store, first verify the
        from-model matches the database's recorded shape.
status  Applied, pending, and drift (a hand-modified database).
apply   Print every statement, then apply. Destructive steps (drop
        table/column, rebuild) require --yes or an interactive
        confirmation naming what is lost. --dry-run only prints.
check   The CI command: exit 1 on pending migrations or drift.
shape   Print the physical mapping a model produces.
`;

function fail(message) {
  console.error(`jaren-db: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    command: argv[2], from: null, to: null, model: null, store: null,
    baseline: null, migrations: null, id: null, out: null,
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
      case '--dry-run': options.dryRun = true; break;
      case '--yes': options.yes = true; break;
      case '--help': case '-h': options.help = true; break;
      default: fail(`unknown option: ${argv[i]}`);
    }
  }
  return options;
}

const readJson = (file, what) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  catch (error) {
    return fail(`cannot read ${what} '${file}': ${error.message}`);
  }
};

/** The migrations directory, sorted — the full ordered chain. */
const readMigrationsDir = (dir) => {
  if (dir === null) return [];
  return fs.readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => readJson(path.join(dir, file), 'migration'));
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
  if (options.from === null || options.to === null)
    fail('plan needs --from and --to model files');
  const fromModel = readJson(options.from, 'from-model');
  const toModel = readJson(options.to, 'to-model');
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
}

async function commandStatus(options, { asCheck }) {
  if (options.store === null || options.baseline === null)
    fail(`${asCheck ? 'check' : 'status'} needs --store and --baseline`);
  // `check` without the model verified nothing and printed "in sync"
  if (asCheck && options.model === null)
    fail('check needs --model — drift is measured against the model the code carries');
  const baseline = readJson(options.baseline, 'baseline model');
  const model = options.model !== null ? readJson(options.model, 'model') : undefined;
  const migrations = readMigrationsDir(options.migrations);
  let status;
  try {
    status = await migrationStatus({ driver: nodeDriver(), path: options.store },
      migrations, { baseline, model });
  }
  catch (error) {
    return fail(error.message);
  }
  console.log(`applied:  ${status.applied.length === 0 ? '(none)' : status.applied.join(', ')}`);
  console.log(`pending:  ${status.pending.length === 0 ? '(none)' : status.pending.join(', ')}`);
  if (model !== undefined && status.pending.length === 0) {
    console.log(`drift:    ${status.drift === null ? 'none — in sync' : status.drift}`);
  }
  if (asCheck) {
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
  const baseline = readJson(options.baseline, 'baseline model');
  const model = options.model !== null ? readJson(options.model, 'model') : undefined;
  const migrations = readMigrationsDir(options.migrations);
  const target = { driver: nodeDriver(), path: options.store };

  const status = await migrationStatus(target, migrations, { baseline })
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

function commandShape(options) {
  if (options.model === null) fail('shape needs --model');
  const model = readJson(options.model, 'model');
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
    case 'status': return commandStatus(options, { asCheck: false });
    case 'check': return commandStatus(options, { asCheck: true });
    case 'apply': return commandApply(options);
    case 'shape': return commandShape(options);
    default: return fail(`unknown command '${options.command}' — try --help`);
  }
}

main().catch((error) => fail(error.message));

//#endregion
