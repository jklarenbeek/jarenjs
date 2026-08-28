//@ts-check
/**
 * @file The jaren-db CLI, driven as a real subprocess: `plan` writes a
 * reviewable document, `check` exits non-zero on pending AND on drift
 * and zero in sync, `apply` prints every statement, refuses
 * destructive work without `--yes` (naming what is lost), and applies
 * with it; `status` names a hand-modified database; `shape` prints
 * the physical mapping.
 */

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { openStore, shapeHash } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

import { model as V1 } from './fixtures/models/v1.js';
import { model as V2 } from './fixtures/models/v2.js';

const CLI = path.resolve('packages/db/src/cli.js');
const FROM = {
  $model: '0.1',
  entities: {
    User: { schema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string', 'x-entity': { key: true } },
      name: { type: 'string' },
    } } },
  },
};
const TO = structuredClone(FROM);
TO.entities.User.schema.properties.age = { type: 'integer' };
const TO2 = structuredClone(TO);
delete TO2.entities.User.schema.properties.name; // destructive drop

/** @type {string} */
let dir = '';
const fileOf = (name, value) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
};
const run = (...args) => spawnSync(process.execPath,
  ['--no-warnings=ExperimentalWarning', CLI, ...args], { encoding: 'utf8' });

/** @type {Record<string, string>} */
const files = {};

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaren-db-cli-'));
  files.from = fileOf('model-v1.json', FROM);
  files.to = fileOf('model-v2.json', TO);
  files.to2 = fileOf('model-v3.json', TO2);
  files.store = path.join(dir, 'app.db');
  files.migrations = path.join(dir, 'migrations');
  fs.mkdirSync(files.migrations);
  const store = await openStore(FROM, { driver: nodeDriver(), path: files.store });
  await store.entity('User').create({ id: 'u1', name: 'ada' });
  await store.close();
});
after(() => {
  // retries for the same reason as test/db/helpers.js: on Windows the
  // directory entry of a SQLite file outlives its last handle by a
  // moment, and an EPERM here fails a suite that already passed
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('jaren-db', () => {
  it('plan writes a reviewable migration document', () => {
    const out = path.join(files.migrations, '001-add-age.json');
    const result = run('plan', '--from', files.from, '--to', files.to,
      '--store', files.store, '--id', '001-add-age', '--out', out);
    assert.strictEqual(result.status, 0, result.stderr);
    const migration = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.strictEqual(migration.id, '001-add-age');
    assert.ok(migration.steps.some((s) => /ADD COLUMN "age"/.test(s.sql ?? '')));
    assert.ok(migration.steps.some((s) => s.draft === true),
      'the schema changed, so the plan carries a draft transform');
    // the review step a real user performs: a pure widening needs no
    // transform, so the draft is deleted before applying
    migration.steps = migration.steps.filter((s) => s.draft !== true);
    fs.writeFileSync(out, JSON.stringify(migration, null, 2));
  });

  it('plan refuses a from-model that does not match the store', () => {
    const result = run('plan', '--from', files.to2, '--to', files.to,
      '--store', files.store);
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /does not match the from-model/);
  });

  it('check exits non-zero while a migration is pending', () => {
    const result = run('check', '--model', files.to, '--store', files.store,
      '--baseline', files.from, '--migrations', files.migrations);
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /pending/);
  });

  it('apply --dry-run prints every statement and changes nothing', () => {
    const result = run('apply', '--store', files.store, '--baseline', files.from,
      '--migrations', files.migrations, '--model', files.to, '--dry-run');
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /ADD COLUMN "age"/);
    const raw = new DatabaseSync(files.store);
    assert.strictEqual(
      raw.prepare('SELECT COUNT(*) AS n FROM _jaren_migrations').get().n, 0);
    raw.close();
  });

  it('apply --yes applies; check then exits zero, in sync', () => {
    const applied = run('apply', '--store', files.store, '--baseline', files.from,
      '--migrations', files.migrations, '--model', files.to, '--yes');
    assert.strictEqual(applied.status, 0, applied.stderr);
    assert.match(applied.stdout, /applied: 001-add-age/);
    const check = run('check', '--model', files.to, '--store', files.store,
      '--baseline', files.from, '--migrations', files.migrations);
    assert.strictEqual(check.status, 0, check.stderr);
    assert.match(check.stdout, /in sync/);
  });

  it('a destructive apply without --yes refuses, NAMING what is lost', () => {
    const out = path.join(files.migrations, '002-drop-name.json');
    const planned = run('plan', '--from', files.to, '--to', files.to2,
      '--id', '002-drop-name', '--out', out);
    assert.strictEqual(planned.status, 0, planned.stderr);
    assert.match(planned.stderr, /DESTRUCTIVE/);
    const reviewed = JSON.parse(fs.readFileSync(out, 'utf8'));
    reviewed.steps = reviewed.steps.filter((s) => s.draft !== true);
    fs.writeFileSync(out, JSON.stringify(reviewed, null, 2));
    const refused = run('apply', '--store', files.store, '--baseline', files.from,
      '--migrations', files.migrations, '--model', files.to2);
    assert.strictEqual(refused.status, 1);
    assert.match(refused.stdout, /drop column 'name'/,
      'the prompt names the loss');
    assert.match(refused.stderr, /--yes/);
    const raw = new DatabaseSync(files.store);
    assert.strictEqual(raw.prepare('SELECT name FROM "User"').get().name, 'ada',
      'nothing was applied');
    raw.close();
    const applied = run('apply', '--store', files.store, '--baseline', files.from,
      '--migrations', files.migrations, '--model', files.to2, '--yes');
    assert.strictEqual(applied.status, 0, applied.stderr);
  });

  it('status and check name a hand-modified database as drift', () => {
    const raw = new DatabaseSync(files.store);
    raw.exec('CREATE INDEX "sneaky" ON "User" (id)');
    raw.close();
    const status = run('status', '--model', files.to2, '--store', files.store,
      '--baseline', files.from, '--migrations', files.migrations);
    assert.strictEqual(status.status, 0, status.stderr);
    assert.match(status.stdout, /drift:.*unexpected index:sneaky/);
    const check = run('check', '--model', files.to2, '--store', files.store,
      '--baseline', files.from, '--migrations', files.migrations);
    assert.strictEqual(check.status, 1);
    assert.match(check.stderr, /drifted.*sneaky/);
    const cleanupDb = new DatabaseSync(files.store);
    cleanupDb.exec('DROP INDEX "sneaky"');
    cleanupDb.close();
  });

  it('shape prints the physical mapping; --help and bad input behave', () => {
    const shape = run('shape', '--model', files.to);
    assert.strictEqual(shape.status, 0);
    assert.match(shape.stdout, /CREATE TABLE "User"/);
    assert.match(shape.stdout, /shape hash: /);
    assert.strictEqual(run('--help').status, 0);
    assert.strictEqual(run('nonsense').status, 1);
    assert.strictEqual(run().status, 1);
  });
});

// ————— code-first: modules, the committed snapshot, purity, --types —————

const ROOT = path.resolve('.');
const CHECK = (work) => ['check', '--model', path.join(work, 'model.js'), '--store', path.join(work, 'app.db'),
  '--baseline', path.join(work, 'v1.js'), '--migrations', path.join(work, 'migrations')];

describe('jaren-db, code-first (modules, the snapshot, purity, --types)', () => {
  // under node_modules, so a copied module's bare specifiers resolve as a
  // consumer's would; the default snapshot lands beside the model there
  /** @type {string} */
  let work = '';
  const at = (name) => path.join(work, name);
  const mtimes = (...names) => names.map((name) => fs.statSync(at(name)).mtimeMs);

  before(() => {
    work = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.cache-jaren-db-cli-'));
    fs.copyFileSync(path.resolve('test/db/fixtures/models/v1.js'), at('v1.js'));
    fs.copyFileSync(path.resolve('test/db/fixtures/models/v2.js'), at('v2.js'));
    fs.mkdirSync(at('migrations'));
  });
  after(() => {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('snapshot writes the model snapshot beside the module by default; a second run changes nothing', () => {
    fs.writeFileSync(at('model.js'), "export { model as default } from './v1.js';\n");
    const first = run('snapshot', '--model', at('model.js'));
    assert.strictEqual(first.status, 0, first.stderr);
    assert.match(first.stdout, /wrote .*model\.snapshot\.json/);
    assert.strictEqual(shapeHash(JSON.parse(fs.readFileSync(at('model.snapshot.json'), 'utf8'))), shapeHash(V1));
    const before = mtimes('model.snapshot.json');
    const second = run('snapshot', '--model', at('model.js'));
    assert.strictEqual(second.status, 0, second.stderr);
    assert.match(second.stdout, /unchanged/);
    assert.deepStrictEqual(mtimes('model.snapshot.json'), before);
  });

  it('plan --model diffs the snapshot against the module, writes the migration and advances the snapshot; a second plan writes nothing', async () => {
    const store = await openStore(V1, { driver: nodeDriver(), path: at('app.db') });
    await store.entity('User').create({ id: 'u1', name: 'Ada', age: 36 });
    await store.close();
    fs.writeFileSync(at('model.js'), "export { model as default } from './v2.js';\n");
    const out = at('migrations/0002-handles.json');
    const planned = run('plan', '--model', at('model.js'), '--store', at('app.db'), '--id', '0002-handles', '--out', out);
    assert.strictEqual(planned.status, 0, planned.stderr);
    assert.match(planned.stdout, /advanced .*model\.snapshot\.json/);
    const migration = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.strictEqual(migration.from, shapeHash(V1));
    assert.strictEqual(migration.to, shapeHash(V2));
    assert.ok(migration.steps.some((step) => step.draft === true), 'the planner drafts the transform');
    assert.strictEqual(shapeHash(JSON.parse(fs.readFileSync(at('model.snapshot.json'), 'utf8'))), shapeHash(V2));
    const before = mtimes('migrations/0002-handles.json', 'model.snapshot.json');
    const again = run('plan', '--model', at('model.js'), '--store', at('app.db'), '--id', '0003', '--out', at('migrations/0003.json'));
    assert.strictEqual(again.status, 0, again.stderr);
    assert.match(again.stdout, /no change/);
    assert.strictEqual(fs.existsSync(at('migrations/0003.json')), false);
    assert.deepStrictEqual(mtimes('migrations/0002-handles.json', 'model.snapshot.json'), before);
    const missing = run('plan', '--model', at('model.js'), '--snapshot', at('nope.json'));
    assert.strictEqual(missing.status, 1);
    assert.match(missing.stderr, /jaren-db snapshot --model/);
    const both = run('plan', '--model', at('model.js'), '--from', at('v1.js'), '--to', at('v2.js'));
    assert.strictEqual(both.status, 1);
    assert.match(both.stderr, /not both/);
  });

  it('the migrations dir takes a MODULE beside JSON: the pen replaces the draft, apply runs it, check goes green', () => {
    const planned = JSON.parse(fs.readFileSync(at('migrations/0002-handles.json'), 'utf8'));
    fs.rmSync(at('migrations/0002-handles.json'));
    fs.writeFileSync(at('migrations/0002-handles.js'), [
      "import { fromPlanned } from '@jarenjs/linq/migration';",
      "import { model as v1 } from '../v1.js';",
      "import { model as v2 } from '../v2.js';",
      `const planned = ${JSON.stringify(planned)};`,
      'export const migration = fromPlanned(planned, { from: v1, to: v2 })',
      "  .transform('User', (u) => ({ id: u.id, name: u.name, age: u.age, handle: u.name.lower() }));",
      '',
    ].join('\n'));
    const pending = run(...CHECK(work));
    assert.strictEqual(pending.status, 1);
    assert.match(pending.stderr, /pending/);
    const applyArgs = ['apply', '--store', at('app.db'), '--baseline', at('v1.js'), '--migrations', at('migrations'),
      '--model', at('model.js'), '--yes'];
    const applied = run(...applyArgs);
    assert.strictEqual(applied.status, 0, applied.stderr);
    assert.match(applied.stdout, /applied: 0002-handles/);
    const raw = new DatabaseSync(at('app.db'));
    assert.strictEqual(raw.prepare('SELECT "handle" FROM "User"').get().handle, 'ada',
      'the typed transform wrote the column-mapped member');
    raw.close();
    const green = run(...CHECK(work));
    assert.strictEqual(green.status, 0, green.stderr);
    assert.match(green.stdout, /model: {4}planned/);
    assert.match(green.stdout, /in sync/);
    const again = run(...applyArgs);
    assert.strictEqual(again.status, 0, again.stderr);
    assert.match(again.stdout, /nothing to apply/);
  });

  it('an unplanned model change fails check by name and shows in status — the model moved, the snapshot did not', () => {
    fs.writeFileSync(at('v3.js'), [
      "import * as m from '@jarenjs/linq/model';",
      'export const model = m.defineModel({ entities: { User: m.object({',
      '  id: m.string().key(), name: m.string(), age: m.integer().optional(),',
      '  handle: m.string().unique(), bio: m.string().optional(), nick: m.string().optional(),',
      '}) } });',
      '',
    ].join('\n'));
    fs.writeFileSync(at('model.js'), "export { model as default } from './v3.js';\n");
    const status = run('status', ...CHECK(work).slice(1));
    assert.strictEqual(status.status, 0, status.stderr);
    assert.match(status.stdout, /model: {4}UNPLANNED change/);
    const check = run(...CHECK(work));
    assert.strictEqual(check.status, 1);
    assert.match(check.stderr, /unplanned model change/);
    fs.writeFileSync(at('model.js'), "export { model as default } from './v2.js';\n");
    assert.strictEqual(run(...CHECK(work)).status, 0);
  });

  it('an impure module, a non-document export and an unknown extension are refused by name', () => {
    fs.writeFileSync(at('impure.js'), [
      "import * as m from '@jarenjs/linq/model';",
      "export default m.defineModel({ entities: { ['E' + Date.now()]: m.object({ id: m.string().key() }) } });",
      '',
    ].join('\n'));
    const impure = run('shape', '--model', at('impure.js'));
    assert.strictEqual(impure.status, 1);
    assert.match(impure.stderr, /not pure/);
    fs.writeFileSync(at('nodoc.js'), 'export default 42;\n');
    const nodoc = run('shape', '--model', at('nodoc.js'));
    assert.strictEqual(nodoc.status, 1);
    assert.match(nodoc.stderr, /exports neither a default nor a 'model' document/);
    fs.writeFileSync(at('model.txt'), '{}');
    const ext = run('shape', '--model', at('model.txt'));
    assert.strictEqual(ext.status, 1);
    assert.match(ext.stderr, /neither a \.json file nor a module/);
    const broken = run('shape', '--model', at('missing.js'));
    assert.strictEqual(broken.status, 1);
    assert.match(broken.stderr, /cannot load model module/);
  });

  it('a .ts model module loads where the host strips types, and is refused by name where it does not', () => {
    // outside node_modules (Node never strips types there); the pen is
    // reached by its file URL, as a checkout consumer's module would
    const pen = pathToFileURL(path.resolve('packages/linq/src/model/index.js')).href;
    const tsModel = path.join(dir, 'model.ts');
    fs.writeFileSync(tsModel, [
      `import * as m from '${pen}';`,
      'const User: unknown = m.object({ id: m.string().key() });',
      'export const model = m.defineModel({ entities: { User: User as any } });',
      'export default model;',
      '',
    ].join('\n'));
    const stripped = run('shape', '--model', tsModel);
    assert.strictEqual(stripped.status, 0, stripped.stderr);
    assert.match(stripped.stdout, /CREATE TABLE "User"/);
    const refused = spawnSync(process.execPath,
      ['--no-warnings=ExperimentalWarning', '--no-strip-types', CLI, 'shape', '--model', tsModel],
      { encoding: 'utf8' });
    assert.strictEqual(refused.status, 1);
    assert.match(refused.stderr, /a \.ts module loads only where Node strips types/);
  });

  it("snapshot --types writes emit's declaration when emit resolves, and says exactly why when it does not", () => {
    const args = ['snapshot', '--model', at('v2.js'), '--snapshot', at('v2.snapshot.json'), '--types', at('v2.d.ts')];
    const withEmit = run(...args);
    assert.strictEqual(withEmit.status, 0, withEmit.stderr);
    const dts = fs.readFileSync(at('v2.d.ts'), 'utf8');
    assert.match(dts, /export interface User \{/);
    assert.match(dts, /handle: string;/);
    assert.match(dts, /export interface EntityMetaMap/);
    const before = mtimes('v2.d.ts', 'v2.snapshot.json');
    const again = run(...args);
    assert.strictEqual(again.status, 0, again.stderr);
    assert.match(again.stdout, /unchanged .*v2\.d\.ts/);
    assert.deepStrictEqual(mtimes('v2.d.ts', 'v2.snapshot.json'), before);
    // the resolver stub: a host where @jarenjs/emit does not resolve
    fs.writeFileSync(at('no-emit-hook.mjs'), [
      'export async function resolve(specifier, context, next) {',
      "  if (specifier === '@jarenjs/emit' || specifier.startsWith('@jarenjs/emit/')) {",
      "    const error = new Error(`Cannot find package '${specifier}'`);",
      "    error.code = 'ERR_MODULE_NOT_FOUND';",
      '    throw error;',
      '  }',
      '  return next(specifier, context);',
      '}',
      '',
    ].join('\n'));
    fs.writeFileSync(at('no-emit.mjs'), "import { register } from 'node:module';\nregister('./no-emit-hook.mjs', import.meta.url);\n");
    const without = spawnSync(process.execPath,
      ['--no-warnings=ExperimentalWarning', '--import', pathToFileURL(at('no-emit.mjs')).href, CLI,
        'snapshot', '--model', at('v2.js'), '--snapshot', at('v2.snapshot.json'), '--types', at('v2b.d.ts')],
      { encoding: 'utf8' });
    assert.strictEqual(without.status, 1);
    assert.match(without.stderr, /--types needs @jarenjs\/emit/);
    assert.strictEqual(fs.existsSync(at('v2b.d.ts')), false);
  });
});
