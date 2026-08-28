//@ts-check
/**
 * @file The migration pen, held to the format and to the store: every
 * corpus migration emits its hand-written document byte-equal, validates
 * against both published artifacts, hashes its shapes exactly as the
 * store's `shapeHash` does (every model-pen corpus model, rename hint
 * included) and builds twice to one document; the v1 → v2 migration
 * applies through `migrate()` — shadow replay included — with the
 * transformed rows validating under the target model and a column-mapped
 * member written to its column. Beside the corpus: `fromPlanned` replacing
 * exactly the planner's draft (an untouched draft still refuses at run,
 * `JD0021`), the refusals by code, and the no-engine rule.
 */

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { defineMigration, fromPlanned, Migration } from '@jarenjs/linq/migration';
import { stylesheet, rule } from '@jarenjs/linq/jslt';
import { LinqBuildError } from '@jarenjs/linq';
import {
  openStore, planModelMigration, migrate, shapeHash, migrationChecksum, sqliteDialect,
} from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { JarenValidator } from '@jarenjs/validate';

import { compileArtifact } from '../json/schema-artifact-helpers.js';
import { CORPUS } from './model-corpus.js';
import { FIXTURE_MODEL } from '../db/emit-model-fixture.js';
import { model as V1 } from '../db/fixtures/models/v1.js';
import { model as V2 } from '../db/fixtures/models/v2.js';

const MIGRATION_SRC = new URL('../../packages/linq/src/migration/', import.meta.url);
const validators = [
  ['2020-12', compileArtifact(JSON.parse(fs.readFileSync('packages/db/schemas/jaren-migration.schema.json', 'utf8')))],
  ['draft-07', compileArtifact(JSON.parse(fs.readFileSync('packages/db/schemas/jaren-migration.draft-07.schema.json', 'utf8')))],
];
const compileSchema = (schema) => {
  const validate = new JarenValidator({ collectErrors: true }).compile(schema);
  return (doc) => validate(doc);
};
const codeIs = (code, pattern = undefined) => (e) =>
  e instanceof LinqBuildError && e.code === code && (pattern === undefined || pattern.test(e.message));

/** The planner's document for v1 → v2 — the planner still plans; the pen types the human part. */
const plannedV1V2 = () => planModelMigration(V1, V2, { dialect: sqliteDialect, id: '0002-handles' }).migration;
const HANDLE = (u) => ({ id: u.id, name: u.name, age: u.age, handle: u.name.lower() });
const HANDLE_BODY = { id: '$.id', name: '$.name', age: '$.age', handle: { $lower: '$.name' } };

/** The corpus: each entry's builder and the document it MUST emit. */
const MIGRATIONS = [
  {
    name: 'the v1 → v2 migration: the planned DDL, a typed transform, an assertion',
    build: () => {
      let m = defineMigration({ id: '0002-handles', from: V1, to: V2, note: 'every user gets a handle' });
      for (const step of plannedV1V2().steps) if (step.draft !== true) m = m.step(step);
      return m.transform('User', HANDLE).assert('User', (u) => u.handle.isEmpty());
    },
    document: {
      $migration: '0.1', id: '0002-handles', from: shapeHash(V1), to: shapeHash(V2),
      note: 'every user gets a handle',
      steps: [
        ...plannedV1V2().steps.filter((step) => step.draft !== true),
        { kind: 'jslt', collection: 'User', stylesheet: [{ match: '$', body: HANDLE_BODY }] },
        { kind: 'query', collection: 'User',
          assert: { $for: { it: '$[*]' }, $where: { $empty: '$it.handle' }, $return: '$it' } },
      ],
    },
  },
  {
    name: 'every step kind by hand: ddl, sql, a stylesheet transform, an ebv assertion, derive, a raw rebuild',
    build: () => defineMigration({ id: '0003-kinds', from: V2, to: V2 })
      .ddl('CREATE INDEX "User_by_name" ON "User" ("name")', 'index by name')
      .sql('UPDATE "User" SET "bio" = \'\' WHERE "bio" IS NULL', 'blank bios')
      .transform('User', stylesheet([rule('$', (u) => ({ id: u.id, name: u.name.upper(), age: u.age, handle: u.handle, bio: u.bio }))]))
      .assert('User', { $for: { it: '$[*]' }, $where: { $exists: '$it.handle' }, $return: '$it' }, { expect: 'ebv' })
      .derive('User', [{ name: 'gx_bio_gh5', derive: 'geohash', precision: 5, segments: [{ name: 'bio' }] }])
      .step({ kind: 'rebuild', table: 'User', create: ['CREATE TABLE "User__rebuild" ("id" TEXT PRIMARY KEY, "doc" BLOB NOT NULL) STRICT'],
        copy: 'INSERT INTO "User__rebuild" ("id", "doc") SELECT "id", "doc" FROM "User"', indexes: [] }),
    document: {
      $migration: '0.1', id: '0003-kinds', from: shapeHash(V2), to: shapeHash(V2),
      steps: [
        { kind: 'ddl', sql: 'CREATE INDEX "User_by_name" ON "User" ("name")', note: 'index by name' },
        { kind: 'sql', sql: 'UPDATE "User" SET "bio" = \'\' WHERE "bio" IS NULL', note: 'blank bios' },
        { kind: 'jslt', collection: 'User', stylesheet: [{ match: '$',
          body: { id: '$.id', name: { $upper: '$.name' }, age: '$.age', handle: '$.handle', bio: '$.bio' } }] },
        { kind: 'query', collection: 'User',
          assert: { $for: { it: '$[*]' }, $where: { $exists: '$it.handle' }, $return: '$it' }, expect: 'ebv' },
        { kind: 'derive', collection: 'User',
          columns: [{ name: 'gx_bio_gh5', derive: 'geohash', precision: 5, segments: [{ name: 'bio' }] }] },
        { kind: 'rebuild', table: 'User', create: ['CREATE TABLE "User__rebuild" ("id" TEXT PRIMARY KEY, "doc" BLOB NOT NULL) STRICT'],
          copy: 'INSERT INTO "User__rebuild" ("id", "doc") SELECT "id", "doc" FROM "User"', indexes: [] },
      ],
    },
  },
  {
    name: 'no steps: the document only moves the recorded shape',
    build: () => defineMigration({ id: '0004-shape', from: V1, to: V2 }),
    document: { $migration: '0.1', id: '0004-shape', from: shapeHash(V1), to: shapeHash(V2), steps: [] },
  },
  {
    name: 'a rules array verbatim, and a body reading the engine-bound externals',
    build: () => defineMigration({ id: '0005-rules', from: V1, to: V1 })
      .transform('User', [{ match: '$', body: { id: '$.id', name: '$.name' } }])
      .transform('User', (u, x) => ({ id: u.id, name: x.path, age: x.root.age })),
    document: {
      $migration: '0.1', id: '0005-rules', from: shapeHash(V1), to: shapeHash(V1),
      steps: [
        { kind: 'jslt', collection: 'User', stylesheet: [{ match: '$', body: { id: '$.id', name: '$.name' } }] },
        { kind: 'jslt', collection: 'User', stylesheet: [{ match: '$', body: { id: '$.id', name: '$path', age: '$root.age' } }] },
      ],
    },
  },
];

describe('the migration pen — every corpus migration, four ways', () => {
  for (const entry of MIGRATIONS) {
    describe(entry.name, () => {
      it('emits the hand-written document byte-equal, deep-frozen', () => {
        const doc = entry.build().document;
        assert.deepStrictEqual(doc, entry.document);
        assert.strictEqual(JSON.stringify(doc), JSON.stringify(entry.document));
        assert.strictEqual(Object.isFrozen(doc), true);
        assert.strictEqual(Object.isFrozen(doc.steps), true);
        assert.deepStrictEqual(JSON.parse(JSON.stringify(entry.build())), entry.document, 'toJSON() is the document');
      });

      it('validates against both published artifacts', () => {
        for (const [name, validate] of validators) {
          assert.strictEqual(validate(entry.build().document), true, name);
        }
      });

      it('two builds are one document, one checksum', () => {
        assert.deepStrictEqual(entry.build().document, entry.build().document);
        assert.strictEqual(migrationChecksum(entry.build().document), migrationChecksum(entry.build().document));
      });

      it('carries the shape hashes the store computes', () => {
        const doc = entry.build().document;
        assert.match(doc.from, /^[0-9a-z]+$/);
        assert.match(doc.to, /^[0-9a-z]+$/);
      });
    });
  }
});

describe('identity is the shape hash, as the store computes it', () => {
  it('from/to equal shapeHash for every corpus model — the rename hint stripped, as the store strips it', () => {
    for (const model of [...CORPUS.map((entry) => entry.model), FIXTURE_MODEL, V1, V2]) {
      const doc = defineMigration({ id: 'h', from: model, to: model }).document;
      assert.strictEqual(doc.from, shapeHash(model));
      assert.strictEqual(doc.to, shapeHash(model));
    }
    const notes = /** @type {any} */ (CORPUS.find((entry) => entry.name === 'notes')).model;
    assert.strictEqual(notes.entities.Note['x-rename'], 'Memo', 'the corpus carries a hint');
    const stripped = JSON.parse(JSON.stringify(notes));
    delete stripped.entities.Note['x-rename'];
    const doc = defineMigration({ id: 'h', from: notes, to: stripped }).document;
    assert.strictEqual(doc.from, doc.to, 'a planning hint is not shape');
  });
});

describe('the typed transform applies through migrate()', () => {
  /** @type {string} */
  let dir = '';
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaren-linq-migration-')); });
  after(() => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  const seeded = async (name) => {
    const file = path.join(dir, `${name}.db`);
    const store = await openStore(V1, { driver: nodeDriver(), path: file });
    await store.entity('User').create({ id: 'u1', name: 'Ada', age: 36 });
    await store.entity('User').create({ id: 'u2', name: 'Lin' });
    await store.close();
    return file;
  };

  it('v1 → v2 lands on a seeded store, shadow replay included; the column is written and the rows validate under v2', async () => {
    const file = await seeded('handles');
    const migration = MIGRATIONS[0].build().document;
    const outcome = await migrate({ driver: nodeDriver(), path: file }, [migration],
      { baseline: V1, model: V2, compileSchema });
    assert.deepStrictEqual(outcome.applied, ['0002-handles']);
    const migrated = await openStore(V2, { driver: nodeDriver(), path: file });
    assert.deepStrictEqual(await migrated.entity('User').get('u1'), { id: 'u1', name: 'Ada', age: 36, handle: 'ada' });
    assert.deepStrictEqual(await migrated.entity('User').get('u2'), { id: 'u2', name: 'Lin', handle: 'lin' });
    await migrated.close();
    const raw = new DatabaseSync(file);
    assert.deepStrictEqual(raw.prepare('SELECT "handle" FROM "User" ORDER BY "id"').all().map((row) => row.handle),
      ['ada', 'lin'], 'the column-mapped member is written to its column');
    raw.close();
    // and a second run changes nothing (the two-run rule)
    const again = await migrate({ driver: nodeDriver(), path: file }, [migration], { baseline: V1, model: V2, compileSchema });
    assert.deepStrictEqual(again.applied, []);
  });

  it('a transform that misses the new required member is refused against the REAL data (JD0021)', async () => {
    const file = await seeded('narrow');
    let m = defineMigration({ id: '0002-handles', from: V1, to: V2 });
    for (const step of plannedV1V2().steps) if (step.draft !== true) m = m.step(step);
    m = m.transform('User', [{ match: '$', body: { id: '$.id', name: '$.name' } }]);
    await assert.rejects(migrate({ driver: nodeDriver(), path: file }, [m.document],
      { baseline: V1, model: V2, compileSchema }), (e) => /** @type {any} */ (e).code === 'JD0021');
  });

  it('an untouched draft still refuses at run (JD0021): the pen never clears it', async () => {
    const file = await seeded('draft');
    const untouched = fromPlanned(plannedV1V2()).document;
    assert.strictEqual(untouched.steps[untouched.steps.length - 1].draft, true);
    await assert.rejects(migrate({ driver: nodeDriver(), path: file }, [untouched], { baseline: V1, model: V2 }),
      (e) => /** @type {any} */ (e).code === 'JD0021');
  });
});

describe('fromPlanned', () => {
  it('replaces exactly the draft step for the name, in place; the other steps ride verbatim', () => {
    const planned = plannedV1V2();
    const replaced = fromPlanned(planned, { from: V1, to: V2 }).transform('User', HANDLE).document;
    assert.strictEqual(replaced.steps.length, planned.steps.length);
    planned.steps.forEach((step, i) => {
      if (step.draft === true) {
        assert.deepStrictEqual(replaced.steps[i], { kind: 'jslt', collection: 'User', stylesheet: [{ match: '$', body: HANDLE_BODY }] });
      }
      else {
        assert.deepStrictEqual(replaced.steps[i], step);
      }
    });
    // the two routes are one document
    let byHand = defineMigration({ id: '0002-handles', from: V1, to: V2 });
    for (const step of planned.steps) if (step.draft !== true) byHand = byHand.step(step);
    assert.deepStrictEqual(replaced, byHand.transform('User', HANDLE).document);
    // a planned document with a note keeps it; the id and hashes are the planner's
    const noted = fromPlanned({ ...planned, note: 'planned' }).document;
    assert.strictEqual(noted.note, 'planned');
    assert.strictEqual(noted.from, planned.from);
  });

  it('refuses by code: two drafts, a draft-less name without a target, an undeclared name, a model that is not the planned one', () => {
    const planned = plannedV1V2();
    const draft = planned.steps.find((step) => step.draft === true);
    assert.throws(() => fromPlanned({ ...planned, steps: [...planned.steps, draft] }).transform('User', HANDLE),
      codeIs('JL0106', /2 draft transforms/));
    assert.throws(() => fromPlanned(planned).transform('Nope', HANDLE), codeIs('JL0106', /no target model/));
    assert.throws(() => fromPlanned(planned, { to: V2 }).transform('Nope', HANDLE), codeIs('JL0106', /does not declare/));
    assert.throws(() => fromPlanned(planned, { from: V2 }), codeIs('JL0102', /not the one the planner planned/));
    assert.throws(() => fromPlanned(planned, { to: V1 }), codeIs('JL0102', /not the one the planner planned/));
    assert.throws(() => fromPlanned({ ...planned, extra: 1 }), codeIs('JL0101', /'extra'/));
    assert.throws(() => fromPlanned({ id: 'x' }), codeIs('JL0101', /\$migration 0\.1 document/));
    assert.throws(() => fromPlanned(planned, { nope: 1 }), codeIs('JL0101', /'nope'/));
    // without a target model the other steps take any identifier: the runner judges
    const doc = fromPlanned(planned).ddl('SELECT 1').assert('Anything', (u) => u.x.isEmpty()).document;
    assert.strictEqual(doc.steps.length, planned.steps.length + 2);
  });
});

describe('the refusals, by code', () => {
  const m = () => defineMigration({ id: 'r', from: V1, to: V2 });

  it('JL0101 — what the pen cannot spell', () => {
    assert.throws(() => defineMigration(/** @type {any} */ ({ id: '', from: V1, to: V2 })), codeIs('JL0101', /id/));
    assert.throws(() => defineMigration(/** @type {any} */ ({ id: 'x', from: {}, to: V2 })), codeIs('JL0101', /\$model/));
    assert.throws(() => defineMigration(/** @type {any} */ ({ id: 'x', from: V1, to: V2, extra: 1 })), codeIs('JL0101', /'extra'/));
    assert.throws(() => defineMigration(/** @type {any} */ ({ id: 'x', from: V1, to: V2, note: 1 })), codeIs('JL0101', /note/));
    assert.throws(() => defineMigration(/** @type {any} */ (null)), codeIs('JL0101'));
    assert.throws(() => m().ddl(/** @type {any} */ (42)), codeIs('JL0101', /SQL/));
    assert.throws(() => m().sql(''), codeIs('JL0101', /SQL/));
    assert.throws(() => m().ddl('SELECT 1', /** @type {any} */ (1)), codeIs('JL0101', /note/));
    assert.throws(() => m().transform('User', /** @type {any} */ (42)), codeIs('JL0101', /callback/));
    assert.throws(() => m().transform('User', /** @type {any} */ ([() => 1])), codeIs('JL0101', /not JSON/));
    assert.throws(() => m().transform('User', /** @type {any} */ ({ $jslt: '0.1', rules: 1 })), codeIs('JL0101', /rules/));
    assert.throws(() => m().transform(/** @type {any} */ ('no-such'), HANDLE), codeIs('JL0101', /identifier/));
    assert.throws(() => m().assert('User', (u) => u, /** @type {any} */ ({ expect: 'maybe' })), codeIs('JL0101', /expect/));
    assert.throws(() => m().assert('User', (u) => u, /** @type {any} */ ({ other: 1 })), codeIs('JL0101', /'other'/));
    assert.throws(() => m().assert('User', /** @type {any} */ (undefined)), codeIs('JL0101', /predicate/));
    assert.throws(() => m().derive('User', []), codeIs('JL0101', /non-empty/));
    assert.throws(() => m().step(/** @type {any} */ ({ kind: 'nope' })), codeIs('JL0101', /recognised kind/));
    assert.throws(() => m().step(/** @type {any} */ (42)), codeIs('JL0101', /recognised kind/));
    assert.throws(() => m().step(/** @type {any} */ ({ kind: 'rebuild', table: 'User' })), codeIs('JL0101', /'create'/));
    assert.throws(() => m().step(/** @type {any} */ ({ kind: 'sql' })), codeIs('JL0101', /'sql'/));
    assert.throws(() => m().step(/** @type {any} */ ({ kind: 'jslt', collection: 'User' })), codeIs('JL0101', /'stylesheet'/));
    assert.throws(() => m().step(/** @type {any} */ ({ kind: 'query', collection: 'User' })), codeIs('JL0101', /'assert'/));
    assert.throws(() => m().step(/** @type {any} */ ({ kind: 'derive', collection: 'User', columns: [] })), codeIs('JL0101', /'columns'/));
  });

  it('JL0102 — a construct a jslt step cannot carry; JL0104 — an external an assertion or a body cannot bind', () => {
    assert.throws(() => m().transform('User', stylesheet([], { unmatched: 'error' })), codeIs('JL0102', /unmatched/));
    assert.throws(() => m().transform('User', stylesheet([], { modes: { toc: { unmatched: 'share' } } })), codeIs('JL0102', /modes/));
    assert.throws(() => m().assert('User', (u, x) => x.limit.gt(1)), codeIs('JL0104', /'limit'/));
    assert.throws(() => m().transform('User', (u, x) => ({ id: u.id, name: u.name, handle: x.rate })), codeIs('JL0104', /'rate'/));
  });

  it('JL0106 — a table the target model does not declare', () => {
    assert.throws(() => m().transform('Post', HANDLE), codeIs('JL0106', /'Post'.*'User'/));
    assert.throws(() => m().assert('Post', (u) => u.x.isEmpty()), codeIs('JL0106', /'Post'/));
    assert.throws(() => m().derive('Post', [{ name: 'x', derive: 'bbox', segments: [] }]), codeIs('JL0106', /'Post'/));
    // a collection name is declared too
    const withCollections = { $model: '0.1', collections: { rows: { schema: { type: 'object' }, key: null, identity: 'integer' } } };
    assert.doesNotThrow(() => defineMigration({ id: 'c', from: withCollections, to: withCollections })
      .transform('rows', (r) => ({ n: r.n })));
  });
});

describe('the builder is a value', () => {
  it('is immutable: a step answers a new builder and the old one is unchanged', () => {
    const a = defineMigration({ id: 'v', from: V1, to: V1 });
    const b = a.ddl('SELECT 1');
    assert.notStrictEqual(a, b);
    assert.ok(b instanceof Migration);
    assert.strictEqual(a.document.steps.length, 0);
    assert.strictEqual(b.document.steps.length, 1);
    assert.strictEqual(a.document, a.document, 'memoized');
  });

  it('the pen imports no store, no validator and no query engine', () => {
    for (const file of fs.readdirSync(MIGRATION_SRC)) {
      const source = fs.readFileSync(new URL(file, MIGRATION_SRC), 'utf8');
      assert.strictEqual(/from '@jarenjs\/(db|validate|emit)/.test(source), false, `${file} imports a store or an engine`);
      assert.strictEqual(/from '@jarenjs\/json\/(query|jslt)/.test(source), false, `${file} imports the query engine`);
    }
  });
});
