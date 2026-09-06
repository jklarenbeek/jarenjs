//@ts-check
/**
 * @file `jaren-db documents` — a migration's document steps run over a
 * file. Every supported input answers the same ordered documents and the
 * same counts; an in-place run that fails leaves the original byte for
 * byte and takes its temporary with it; `--check` transforms and
 * validates while writing nothing; and the three exit codes mean three
 * different things (0 valid, 1 the run failed, 2 the command line did).
 */

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { planMigration, sqliteDialect, migrateDocuments } from '@jarenjs/db';

const CLI = path.resolve('packages/db/src/cli.js');

const M0 = {
  $model: '0.1',
  collections: {
    users: {
      schema: {
        type: 'object',
        properties: { id: { type: 'string' }, first: { type: 'string' }, last: { type: 'string' } },
      },
      key: '/id',
      indexes: [],
    },
  },
};
const M1 = {
  $model: '0.1',
  collections: {
    users: M0.collections.users,
    events: { schema: { type: 'object' }, key: null, identity: 'integer' },
  },
};

/** A migration carrying only the given DOCUMENT steps. */
function documentMigration(id, steps) {
  const { migration } = planMigration(M0, M1, { dialect: sqliteDialect, id });
  migration.steps = migration.steps
    .filter((step) => step.kind === 'jslt' || step.kind === 'query');
  migration.steps.push(...steps);
  return migration;
}

const SPLIT_NAME = {
  kind: 'jslt',
  collection: 'users',
  stylesheet: [{
    match: '$',
    body: {
      id: '$.id',
      name: { $concat: [{ $default: ['$.first', ''] }, ' ', { $default: ['$.last', ''] }] },
    },
  }],
};

const SEED = [
  { id: 'u1', first: 'Ada', last: 'Lovelace' },
  { id: 'u2', first: 'Lin', last: 'Zed' },
  { id: 'u3', first: 'Kai', last: 'Rho' },
];
/** What every mode must answer. */
const EXPECTED = [
  { id: 'u1', name: 'Ada Lovelace' },
  { id: 'u2', name: 'Lin Zed' },
  { id: 'u3', name: 'Kai Rho' },
];

/** @type {string} */
let dir = '';
const run = (...args) => spawnSync(process.execPath,
  ['--no-warnings=ExperimentalWarning', CLI, 'documents', ...args], { encoding: 'utf8' });
const runWithStdin = (input, ...args) => spawnSync(process.execPath,
  ['--no-warnings=ExperimentalWarning', CLI, 'documents', ...args],
  { encoding: 'utf8', input });

const migrationsIn = (name, migrations) => {
  const folder = path.join(dir, name);
  fs.mkdirSync(folder, { recursive: true });
  migrations.forEach((migration, i) => fs.writeFileSync(
    path.join(folder, `000${i + 1}.json`), JSON.stringify(migration, null, 2)));
  return folder;
};

const jsonl = (documents) => `${documents.map((d) => JSON.stringify(d)).join('\n')}\n`;

/** @type {string} */
let splitDir = '';

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaren-cli-documents-'));
  splitDir = migrationsIn('split', [documentMigration('0001-split', [SPLIT_NAME])]);
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify(SEED, null, 2));
  fs.writeFileSync(path.join(dir, 'users.jsonl'), jsonl(SEED));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('every input answers the same documents', () => {
  it('a JSON array file, out to a JSON array file', () => {
    const out = path.join(dir, 'out-array.json');
    const result = run('--migrations', splitDir, '--in', path.join(dir, 'users.json'), '--out', out);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(out, 'utf8')), EXPECTED);
    assert.match(result.stdout, /3 read, 3 transformed, 0 asserted \(streamed\)/);
    assert.match(result.stdout, /applied: 0001-split/);
  });

  it('a JSONL file, out to a JSONL file', () => {
    const out = path.join(dir, 'out-lines.jsonl');
    const result = run('--migrations', splitDir, '--in', path.join(dir, 'users.jsonl'), '--out', out);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(fs.readFileSync(out, 'utf8'), jsonl(EXPECTED));
  });

  it('JSON in, JSONL out — the encodings are independent', () => {
    const out = path.join(dir, 'crossed.jsonl');
    const result = run('--migrations', splitDir, '--in', path.join(dir, 'users.json'), '--out', out);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(fs.readFileSync(out, 'utf8'), jsonl(EXPECTED));
  });

  it('standard input to standard output', () => {
    const result = runWithStdin(jsonl(SEED), '--migrations', splitDir, '--in', '-', '--out', '-');
    assert.strictEqual(result.status, 0, result.stderr);
    const lines = result.stdout.split('\n')
      .filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
    assert.deepStrictEqual(lines, EXPECTED);
  });

  it('and the programmatic array API answers the same', async () => {
    const { documents } = await migrateDocuments({ users: SEED },
      [documentMigration('0001-split', [SPLIT_NAME])]);
    assert.deepStrictEqual(documents.users, EXPECTED);
  });
});

describe('an in-place run', () => {
  it('replaces the file when every document survives every step', () => {
    const target = path.join(dir, 'inplace-ok.json');
    fs.writeFileSync(target, JSON.stringify(SEED, null, 2));
    const result = run('--migrations', splitDir, '--in', target, '--in-place', '--yes');
    assert.strictEqual(result.status, 0, result.stderr);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(target, 'utf8')), EXPECTED);
  });

  it('leaves the original byte-identical when a step fails, and removes its temporary', () => {
    const failing = migrationsIn('failing', [documentMigration('0001-assert-fails', [SPLIT_NAME, {
      kind: 'query',
      collection: 'users',
      assert: { $for: { it: '$[*]' }, $where: { $eq: ['$it.id', 'u2'] }, $return: '$it.id' },
    }])]);
    const target = path.join(dir, 'inplace-fail.json');
    fs.writeFileSync(target, JSON.stringify(SEED, null, 2));
    const before = fs.readFileSync(target);
    const listed = fs.readdirSync(dir).sort();

    const result = run('--migrations', failing, '--in', target, '--in-place', '--yes');
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /expected an empty sequence/);
    assert.ok(fs.readFileSync(target).equals(before), 'the original is byte-identical');
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), listed,
      'no temporary was left behind');
  });

  it('leaves the original alone when the source itself is malformed', () => {
    const target = path.join(dir, 'inplace-bad.jsonl');
    fs.writeFileSync(target, '{"id":"u1"}\n{oops}\n');
    const before = fs.readFileSync(target);
    const listed = fs.readdirSync(dir).sort();
    const result = run('--migrations', splitDir, '--in', target, '--in-place', '--yes');
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /line 2 is not JSON/);
    assert.ok(fs.readFileSync(target).equals(before));
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), listed);
  });

  it('refuses to rewrite a file without --yes, as a misuse', () => {
    const target = path.join(dir, 'inplace-unconfirmed.json');
    fs.writeFileSync(target, JSON.stringify(SEED, null, 2));
    const before = fs.readFileSync(target);
    const result = run('--migrations', splitDir, '--in', target, '--in-place');
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /--yes/);
    assert.ok(fs.readFileSync(target).equals(before));
  });
});

describe('--check writes nothing, and the exit codes mean three things', () => {
  it('0 when every document passes every step', () => {
    const result = run('--migrations', splitDir, '--in', path.join(dir, 'users.json'), '--check');
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /checked only — nothing was written/);
  });

  it('writes nothing at all: the input and the directory are unchanged', () => {
    const source = path.join(dir, 'check-untouched.jsonl');
    fs.writeFileSync(source, jsonl(SEED));
    const before = fs.readFileSync(source);
    const listed = fs.readdirSync(dir).sort();
    const result = run('--migrations', splitDir, '--in', source, '--check');
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(fs.readFileSync(source).equals(before));
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), listed);
  });

  it('1 when a migration step fails', () => {
    const failing = migrationsIn('check-fails', [documentMigration('0001-fails', [{
      kind: 'query',
      collection: 'users',
      assert: { $for: { it: '$[*]' }, $where: { $eq: ['$it.id', 'u1'] }, $return: '$it.id' },
    }])]);
    const result = run('--migrations', failing, '--in', path.join(dir, 'users.json'), '--check');
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /expected an empty sequence/);
  });

  it('2 for every shape of misuse', () => {
    const users = path.join(dir, 'users.json');
    const cases = [
      [['--in', users, '--check'], /needs --migrations/],
      [['--migrations', splitDir, '--check'], /needs --in/],
      [['--migrations', splitDir, '--in', users], /one of --out/],
      [['--migrations', splitDir, '--in', users, '--out', 'x.json', '--check'], /exactly one of/],
      [['--migrations', splitDir, '--in', '-', '--in-place', '--yes'], /not standard input/],
      [['--migrations', splitDir, '--in', users, '--check', '--format', 'yaml'], /--format must be one of/],
      [['--migrations', splitDir, '--in', users, '--check', '--batch-size', '0'], /--batch-size must be/],
      [['--migrations', splitDir, '--in', users, '--check', '--bogus'], /unknown option: --bogus/],
    ];
    for (const [args, message] of cases) {
      const result = run(.../** @type {string[]} */ (args));
      assert.strictEqual(result.status, 2, `${JSON.stringify(args)}: ${result.stderr}`);
      assert.match(result.stderr, /** @type {RegExp} */ (message));
    }
  });

  it('a failing run to standard output exits 1, and what already left has left', () => {
    const failing = migrationsIn('stdout-fails', [documentMigration('0001-stdout-fails', [
      SPLIT_NAME,
      {
        kind: 'query',
        collection: 'users',
        assert: { $for: { it: '$[*]' }, $where: { $eq: ['$it.id', 'u1'] }, $return: '$it.id' },
      },
    ])]);
    const result = runWithStdin(jsonl(SEED),
      '--migrations', failing, '--in', '-', '--out', '-');
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /expected an empty sequence/);
    // a stream sink cannot take back what it has written, and says so by
    // never claiming the run succeeded
    assert.doesNotMatch(result.stdout, /wrote \d+ document/);
  });

  it('1 — not 2 — when the file simply is not there', () => {
    const result = run('--migrations', splitDir, '--in', path.join(dir, 'absent.json'), '--check');
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /no such file/);
  });
});

describe('what a file cannot be asked to do', () => {
  it('refuses a step that needs a database, before reading a document', () => {
    const physical = migrationsIn('physical',
      [planMigration(M0, M1, { dialect: sqliteDialect, id: '0001-ddl' }).migration]);
    const result = run('--migrations', physical, '--in', path.join(dir, 'users.json'), '--check');
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /needs a database/);
  });

  it('refuses a chain that touches more than the one collection a file holds', () => {
    const many = migrationsIn('many', [documentMigration('0001-many', [
      SPLIT_NAME, { ...SPLIT_NAME, collection: 'events' },
    ])]);
    const result = run('--migrations', many, '--in', path.join(dir, 'users.json'), '--check');
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /a document file holds one collection/);
    assert.match(result.stderr, /users, events/);
  });

  it('refuses a --collection that is not the one the migrations touch', () => {
    const result = run('--migrations', splitDir, '--in', path.join(dir, 'users.json'),
      '--check', '--collection', 'events');
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /but these migrations touch 'users'/);
  });

  it('STREAMS an aggregate assertion: it folds, so the collection is never held', () => {
    const folding = migrationsIn('folding', [documentMigration('0001-count', [{
      kind: 'query', collection: 'users', assert: { $count: '$[*]' }, expect: 'ebv',
    }])]);
    const out = path.join(dir, 'folding-out.json');
    const result = run('--migrations', folding, '--in', path.join(dir, 'users.json'), '--out', out);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /\(streamed\)/);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(out, 'utf8')), SEED);
  });

  it('reads a collection whole only when the assertion truly needs it, and says so', () => {
    const global = migrationsIn('global', [documentMigration('0001-nested', [{
      kind: 'query',
      collection: 'users',
      assert: {
        $for: { a: '$[*]', b: '$[*]' },
        $where: { $and: [{ $eq: ['$a.first', '$b.first'] }, { $ne: ['$a.id', '$b.id'] }] },
        $return: '$a.id',
      },
    }])]);
    const out = path.join(dir, 'global-out.json');
    const result = run('--migrations', global, '--in', path.join(dir, 'users.json'), '--out', out);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /\(materialized\)/);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(out, 'utf8')), SEED);
  });
});
