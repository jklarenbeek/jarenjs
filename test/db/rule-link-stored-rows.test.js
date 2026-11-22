//@ts-check
/**
 * @file A link that gives a table the store owns a database rule judges the
 * rows the table already holds (MIGRATION-FORMAT §9, MODEL-FORMAT §13.4): one
 * check per rule that judges an insert and that the link adds or changes, run
 * in the link's transaction once the table's programs are in place, as an
 * added unique index judges a duplicate. A stored row the rule refuses — an
 * absent member the rule reads included — fails the step (`JD0023`, naming
 * the rule and the row's key) and the link rolls back whole; a conforming
 * table takes the rule. A rule that judges only updates or deletes, and a rule
 * whose check the link leaves as it was (a rebuild's programs created again),
 * plan no check. `planProgramUpgrade`'s repair of a missing insert program
 * judges the rows too. On SQLite and PostgreSQL alike (`JAREN_PG_URL`; skipped
 * without it, two connections at most).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, openStore, planInvariants, planModelMigration, planProgramUpgrade, sqliteDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDialect } from '@jarenjs/db/postgres';
import { removeTempDirectory } from './helpers.js';
import { ENGINES, skipFor, withPostgres } from './store-core-engines.js';

const T = { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } }, n: { type: 'integer' }, ref: { type: 'integer' } } };
const PARENT = { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } } } };
/** The model with `rules` on `T`, its rows' parents beside it. @param {any[]} [rules] @param {any} [schema] */
const model = (rules = [], schema = T) => ({ $model: '0.1', entities: { Parent: { schema: PARENT }, T: { schema, ...(rules.length ? { invariants: rules } : {}) } } });
/** A database rule on `on` asserting `assert`. @param {string} name @param {string[]} on @param {any} assert */
const rule = (name, on, assert) => ({ name, on, enforcement: 'database', assert });
const POSITIVE = rule('pos', ['insert', 'update'], { $gt: ['$.new.n', 0] });
const PARENTED = rule('parented', ['insert'], { '$exists-row': { entity: 'Parent', match: { id: '$.new.ref' } } });

/**
 * Run `fn` over a fresh store of `base` on `engine`: its migration target,
 * its dialect, and a seeding store.
 * @param {string} engine @param {any} base
 * @param {(it: { target: any, dialect: any, seed: (fn: (store: any) => Promise<void>) => Promise<void> }) => Promise<void>} fn
 */
async function onEngine(engine, base, fn) {
  if (engine === 'sqlite') {
    const dir = mkdtempSync(join(tmpdir(), 'jaren-rule-link-'));
    const target = { driver: nodeDriver(), path: join(dir, 'store.db') };
    try {
      return await fn({ target, dialect: sqliteDialect, seed: async (body) => {
        const store = await openStore(base, target);
        try { await body(store); }
        finally { await store.close(); }
      } });
    }
    finally { removeTempDirectory(dir); }
  }
  return withPostgres(async ({ schema, driver }) => {
    const target = { driver: driver() };
    await fn({ target, dialect: postgresDialect({ searchPath: schema }), seed: async (body) => {
      const store = await openStore(base, target);
      try { await body(store); }
      finally { await store.close(); }
    } });
  });
}

/** What a link from `from` to `to` over `rows` of `T` ends in. @param {string} engine @param {any} from @param {any} to @param {any[]} rows
 * @param {Record<string, any>} [options] - further `planModelMigration` options */
async function linked(engine, from, to, rows, options = {}) {
  /** @type {any} */
  let out;
  await onEngine(engine, from, async ({ target, dialect, seed }) => {
    await seed(async (store) => {
      for (const id of [1, 2]) await store.entity('Parent').create({ id });
      for (const row of rows) await store.entity('T').create(row);
    });
    const { migration } = planModelMigration(from, to, { dialect, id: 'link', ...options });
    const checking = migration.steps.filter((/** @type {any} */ step) => step.kind === 'sql' && step.note.includes('breaks the rule'));
    const checks = checking.map((/** @type {any} */ step) => /** @type {string} */ (/'([^']+)'$/.exec(step.note))[1]);
    // each check follows its insert program, and on PostgreSQL the step that enables that program's trigger,
    // which holds the table's writers until the link commits, where the function alone was replaced in place
    const first = migration.steps.indexOf(checking[0]);
    const holds = engine === 'sqlite' ? /^CREATE TRIGGER "_jaren_rule_\d+_T_insert"/ : /^ALTER TABLE "T" ENABLE TRIGGER "_jaren_rule_\d+_T_insert"$/;
    assert.ok(checking.length === 0 || (migration.steps.slice(0, first).some((/** @type {any} */ step) => holds.test(step.sql ?? ''))
      && migration.steps.slice(0, first).some((/** @type {any} */ step) => /^CREATE (OR REPLACE )?FUNCTION "[^"]+"\."_jaren_rule_\d+_T_insert"|^CREATE TRIGGER "_jaren_rule_\d+_T_insert"/.test(step.sql ?? ''))),
      JSON.stringify(migration.steps.map((/** @type {any} */ step) => String(step.sql ?? step.kind).slice(0, 60))));
    const verdict = await migrate(target, [migration], { baseline: from, model: to, shadow: false })
      .then(() => 'applied', (/** @type {any} */ error) => `${error.code} ${error.message}`);
    // the store opens under the model the history names, its rows as they were
    const applied = verdict === 'applied';
    const store = await openStore(applied ? to : from, target);
    try {
      /** @type {any[]} */
      const kept = [];
      for (const row of rows) kept.push(await store.entity('T').get(row.id));
      out = { checks, verdict, rows: kept.filter((row) => row !== undefined).length,
        // a write the rule refuses, where the link applied
        refused: applied && to.entities.T.invariants?.some((/** @type {any} */ each) => each.name === 'pos')
          ? await store.entity('T').create({ id: 'new', n: -1, ref: 1 }).then(() => 'stored', (/** @type {any} */ error) => error.code) : null };
    }
    finally { await store.close(); }
  });
  return out;
}

for (const engine of ENGINES) {
  const skip = skipFor(engine);
  describe(`a link that adds a database rule over stored rows (${engine})`, () => {
    it('refuses a stored row the rule breaks, naming the rule and the key, and leaves the table as it was', { skip }, async () => {
      const out = await linked(engine, model(), model([POSITIVE]), [{ id: 'ok', n: 1, ref: 1 }, { id: 'bad', n: -5, ref: 1 }]);
      assert.deepEqual(out.checks, ['pos']);
      assert.match(out.verdict, /^JD0023 JD0023: migration 'link' step \d+ \(sql\) failed: .*the rule .pos. of .T. refuses the stored row whose key id is bad: correct the stored rows first/);
      assert.equal(out.rows, 2);
    });

    it('refuses a stored row whose member the rule reads is absent, as the insert program refuses it', { skip }, async () => {
      const out = await linked(engine, model(), model([POSITIVE]), [{ id: 'absent', ref: 1 }]);
      assert.match(out.verdict, /^JD0023 .*refuses the stored row whose key id is absent/);
    });

    it('takes the rule over rows that keep it, which then judges every write', { skip }, async () => {
      const out = await linked(engine, model(), model([POSITIVE]), [{ id: 'a', n: 1, ref: 1 }, { id: 'b', n: 2, ref: 2 }]);
      assert.deepEqual(out, { checks: ['pos'], verdict: 'applied', rows: 2, refused: 'JD2096' });
    });

    it('judges a probe of another table unlocked, inside the link', { skip }, async () => {
      assert.match((await linked(engine, model(), model([PARENTED]), [{ id: 'orphan', n: 1, ref: 9 }])).verdict,
        /^JD0023 .*the rule .parented. of .T. refuses the stored row whose key id is orphan/);
      assert.equal((await linked(engine, model(), model([PARENTED]), [{ id: 'child', n: 1, ref: 2 }])).verdict, 'applied');
    });

    it('judges a changed rule, and no rule the link leaves as it was', { skip }, async () => {
      const stricter = rule('pos', ['insert', 'update'], { $gt: ['$.new.n', 1] });
      const changed = await linked(engine, model([POSITIVE]), model([stricter]), [{ id: 'one', n: 1, ref: 1 }]);
      assert.deepEqual(changed.checks, ['pos']);
      assert.match(changed.verdict, /^JD0023 .*refuses the stored row whose key id is one/);
      // a second rule beside the first: only the one added is judged
      const added = await linked(engine, model([POSITIVE]), model([POSITIVE, PARENTED]), [{ id: 'one', n: 1, ref: 1 }]);
      assert.deepEqual([added.checks, added.verdict], [['parented'], 'applied']);
    });

    it('plans no check for a rule that judges only updates or deletes', { skip }, async () => {
      for (const only of [rule('later', ['update'], { $gt: ['$.new.n', 0] }), rule('gone', ['delete'], { $gt: ['$.old.n', 0] })]) {
        const out = await linked(engine, model(), model([only]), [{ id: 'bad', n: -5, ref: 1 }]);
        assert.deepEqual([out.checks, out.verdict], [[], 'applied'], only.name);
      }
    });

    it('judges the rule it keeps where the link rebuilds the table, whose copy and transform run without its programs', { skip }, async () => {
      // a column the rule does not read retyped: the table rebuilt, the rule as it was
      const retyped = { ...T, properties: { ...T.properties, ref: { type: 'number' } } };
      const kept = await linked(engine, model([POSITIVE]), model([POSITIVE], retyped), [{ id: 'one', n: 1, ref: 1 }],
        { transform: { kind: 'jslt', collection: 'T', stylesheet: [] } });
      assert.deepEqual([kept.checks, kept.verdict], [['pos'], 'applied']);
      // the transform writes a row the rule refuses while the programs are down: the check refuses it
      const broken = await linked(engine, model([POSITIVE]), model([POSITIVE], retyped), [{ id: 'one', n: 1, ref: 1 }],
        { transform: { kind: 'jslt', collection: 'T', stylesheet: [{ match: '$.n', body: -1 }] } });
      assert.match(broken.verdict, /^JD0023 .*the rule .pos. of .T. refuses the stored row whose key id is one/);
    });
  });
}

describe('a link that adds a rule beside another insert rule on PostgreSQL, its function replaced in place', () => {
  it('waits for a writer whose row it has not seen, and then judges that row', { skip: skipFor('postgres') }, () =>
    withPostgres(async ({ pool, schema, driver }) => {
      const { default: pg } = await import('pg');
      const { postgresDriver } = await import('@jarenjs/db/postgres');
      const small = rule('small', ['insert'], { $lt: ['$.new.n', 100] });
      const from = model([POSITIVE]), to = model([POSITIVE, small]);
      await (await openStore(from, { driver: driver() })).close();
      const { migration } = planModelMigration(from, to, { dialect: postgresDialect({ searchPath: schema }), id: 'in-place' });
      // the insert program's function alone is replaced, its trigger kept
      assert.ok(migration.steps.some((/** @type {any} */ step) => /^CREATE OR REPLACE FUNCTION /.test(step.sql)), JSON.stringify(migration.steps.map((/** @type {any} */ step) => step.note)));
      assert.ok(!migration.steps.some((/** @type {any} */ step) => /^(CREATE|DROP) TRIGGER /.test(step.sql)));
      // the other writer on a connection of its own, its transaction open with a row the old program passes and the new rule refuses
      let writerPid = 0;
      const writerPool = new pg.Pool({ connectionString: process.env.JAREN_PG_URL, max: 1 });
      writerPool.on('connect', (/** @type {any} */ client) => { writerPid = client.processID; });
      const writer = await openStore(from, { driver: postgresDriver(writerPool, { schema }) });
      try {
        /** @type {() => void} */
        let release = () => {};
        const held = new Promise((resolve) => { release = () => resolve(undefined); });
        /** @type {(value?: unknown) => void} */
        let wrote = () => {};
        const written = new Promise((resolve) => { wrote = resolve; });
        const committed = writer.transaction(async (/** @type {any} */ tx) => {
          await tx.entity('T').create({ id: 'late', n: 500, ref: 1 });
          wrote();
          await held;
        });
        await written;
        let settled = false;
        const linked = migrate({ driver: driver() }, [migration], { baseline: from, model: to, shadow: false })
          .then(() => 'applied', (/** @type {any} */ error) => `${error.code} ${error.message}`)
          .finally(() => { settled = true; });
        // the link waits for the writer, at the step that holds the table's writers
        let blocked = false;
        for (let i = 0; i < 500 && !blocked && !settled; i++) {
          const { rows } = await pool.query('SELECT EXISTS (SELECT 1 FROM pg_locks l WHERE NOT l.granted AND $1 = ANY (pg_blocking_pids(l.pid))) AS blocked', [writerPid]);
          blocked = rows[0].blocked;
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(blocked, true, 'the link waits for the open writer');
        release();
        await committed;
        assert.match(await linked, /^JD0023 .*the rule 'small' of 'T' refuses the stored row whose key id is late/);
      }
      finally {
        await writer.close();
        await writerPool.end();
      }
    }));
});

describe("planProgramUpgrade's repair of a missing insert program on SQLite", () => {
  it('judges the rows the table holds, as the link that adds its rules does', async () => {
    const ruled = model([POSITIVE]);
    const insert = /** @type {any} */ (planInvariants(ruled, { dialect: sqliteDialect }).find((item) => item.name.endsWith('_insert')));
    for (const [rows, verdict] of /** @type {[any[], RegExp][]} */ ([[[{ id: 'bad', n: -5, ref: 1 }], /^JD0023 .*the rule .pos. of .T. refuses the stored row whose key id is bad/],
      [[{ id: 'ok', n: 5, ref: 1 }], /^applied$/]])) {
      await onEngine('sqlite', ruled, async ({ target, seed }) => {
        await seed(async () => {});
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(target.path);
        try {
          db.exec(insert.drop);
          for (const row of rows) db.prepare('INSERT INTO "T" (id, n, ref, doc) VALUES (?, ?, ?, jsonb(\'{}\'))').run(row.id, row.n, row.ref);
        }
        finally { db.close(); }
        const connection = await target.driver.open(target.path, {});
        let migration;
        try { ({ migration } = await planProgramUpgrade(connection, ruled, { repair: [`T.${insert.name}`] })); }
        finally { await connection.close(); }
        assert.deepEqual(migration.steps.map((/** @type {any} */ step) => step.kind), ['ddl', 'sql']);
        const out = await migrate(target, [migration], { baseline: ruled, model: ruled, shadow: false })
          .then(() => 'applied', (/** @type {any} */ error) => `${error.code} ${error.message}`);
        assert.match(out, verdict);
      });
    }
  });
});
