//@ts-check
/**
 * @file A link whose own step leaves a table the store owns as the next open
 * would refuse it — an entity's index dropped, its column dropped, its
 * foreign key changed — is refused before it commits (`JD0023`), and rolls
 * back whole: the history keeps the link pending and the table holds what it
 * held. On PostgreSQL acceptance verifies every table the store owns as the
 * open verifies it; on SQLite its CREATE text comparison refuses the same
 * links. Acceptance of a link sends the same statements whatever the number
 * of tables the store owns, but for the pages of the catalog's rows. PostgreSQL runs on a live server
 * (`JAREN_PG_URL`; skipped without it).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, migrationStatus, openStore, planModelMigration, sqliteDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { tempDbPath } from './helpers.js';
import { PG_URL, withPostgres } from './store-core-engines.js';

const skip = !PG_URL && 'JAREN_PG_URL is not set';
const ID = { type: 'string', 'x-entity': { key: true } };
/** Users with an indexed age and posts by author; `extra` adds the index the link plans. @param {boolean} extra */
const modelOf = (extra) => ({ $model: '0.1', entities: {
  User: { schema: { type: 'object', required: ['id'], properties: { id: ID, age: { type: 'integer' }, v: { type: 'string' },
    posts: { 'x-entity': { relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'restrict' } } } } },
  indexes: [{ name: 'by_age', path: '$.age' }, ...(extra ? [{ name: 'by_v', path: '$.v' }] : [])] },
  Post: { schema: { type: 'object', required: ['id'], properties: { id: ID, authorId: { type: 'string' } } } } } });
const BASE = modelOf(false), NEXT = modelOf(true);
const REFUSED = 'JD0023: the migrated shape does not equal the target model\'s: ';
const UNCHANGED = '; the next open would refuse the table (JD0002), so nothing was changed';

/** The ordinary link BASE -> NEXT with each statement of `sql` a step after it. @param {any} dialect @param {string} sql */
const linkWith = (dialect, sql) => {
  const link = planModelMigration(BASE, NEXT, { dialect, id: 'l1' }).migration;
  for (const statement of sql.split('; ')) link.steps.push({ kind: 'sql', sql: statement, note: 'an edit the model does not declare' });
  return link;
};

const POSTGRES_CASES = [
  ['drops an entity\'s index', 'DROP INDEX "User_by_age"',
    "entity 'User': 1 declared indexes exist, the model declares 2 — the model declares User_by_age, which the database does not have"],
  ['drops an entity\'s column', 'ALTER TABLE "User" DROP COLUMN "age"',
    "entity 'User': 4 columns exist, the model declares 5; missing: 'age'"],
  ['changes an entity\'s foreign key', 'ALTER TABLE "Post" DROP CONSTRAINT "Post_authorId_fkey"; '
    + 'ALTER TABLE "Post" ADD CONSTRAINT "Post_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"(id) ON DELETE CASCADE',
  "entity 'Post': the foreign keys are [authorId -> User(id) ON DELETE CASCADE ON UPDATE NO ACTION], "
    + 'the model declares [authorId -> User(id) ON DELETE NO ACTION ON UPDATE NO ACTION]'],
];

describe('PostgreSQL acceptance of a link that leaves a store-owned table the open refuses', () => {
  for (const [name, sql, difference] of POSTGRES_CASES) {
    it(`refuses a link that ${name}, and rolls it back`, { skip }, () => withPostgres(async ({ pool, schema, driver }) => {
      await (await openStore(BASE, { driver: driver() })).close();
      const link = linkWith(driver().dialect, sql);
      await assert.rejects(migrate({ driver: driver() }, [link], { baseline: BASE, model: NEXT, shadow: false }),
        { code: 'JD0023', message: `${REFUSED}${difference}${UNCHANGED}` });
      const status = await migrationStatus({ driver: driver() }, [link], { model: NEXT });
      assert.deepEqual([status.applied, status.pending], [[], ['l1']]);
      const { rows } = await pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'User' ORDER BY 1`, [schema]);
      assert.deepEqual(rows.map((row) => row.indexname), ['User_by_age', 'User_pkey']);
      // the same link without the edit applies, and status calls the store current
      const clean = planModelMigration(BASE, NEXT, { dialect: driver().dialect, id: 'l1' }).migration;
      assert.deepEqual((await migrate({ driver: driver() }, [clean], { baseline: BASE, model: NEXT, shadow: false })).applied, ['l1']);
      assert.equal((await migrationStatus({ driver: driver() }, [clean], { model: NEXT })).drift, null);
    }));
  }

  it('costs a link the same statements over 8 times the tables', { skip }, async () => {
    const { default: pg } = await import('pg');
    const { postgresDriver } = await import('@jarenjs/db/postgres');
    /** @param {number} n @param {boolean} extra */
    const wide = (n, extra) => ({ $model: '0.1', entities: Object.fromEntries(Array.from({ length: n }, (_, i) => [`E${i}`, {
      schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, v: { type: 'string' }, w: { type: 'string' } } },
      indexes: [{ name: 'by_v', path: '$.v' }, ...(extra && i === 0 ? [{ name: 'by_w', path: '$.w' }] : [])] }])) });
    const pool = new pg.Pool({ connectionString: PG_URL, max: 2 });
    // a catalog read pages its rows (FETCH) and a statement slot is released (DEALLOCATE) by the rows the
    // catalog holds, not by the tables read: what is counted is every other statement
    let statements = 0;
    /** @param {any[]} args */
    const count = (args) => {
      const sql = String(typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '');
      if (!/^\s*(FETCH|DEALLOCATE)\b/.test(sql)) statements++;
    };
    const counting = { on: () => {}, options: pool.options, query: (/** @type {any[]} */ ...args) => { count(args); return pool.query(...args); },
      connect: async () => {
        const client = await pool.connect();
        return new Proxy(client, { get: (target, key) => (key === 'query'
          ? (/** @type {any[]} */ ...args) => { count(args); return target.query(...args); }
          : typeof target[key] === 'function' ? target[key].bind(target) : target[key]) });
      } };
    /** @type {number[]} */
    const counts = [];
    try {
      for (const n of [4, 32]) {
        const schema = `jaren_accept_cost_${process.pid}_${n}`;
        await pool.query(`CREATE SCHEMA "${schema}"`);
        try {
          const base = wide(n, false), next = wide(n, true);
          await (await openStore(base, { driver: postgresDriver(pool, { schema }) })).close();
          const link = planModelMigration(base, next, { dialect: postgresDriver(pool, { schema }).dialect, id: 'l1' }).migration;
          statements = 0;
          assert.deepEqual((await migrate({ driver: postgresDriver(counting, { schema }) }, [link], { baseline: base, model: next, shadow: false })).applied, ['l1']);
          counts.push(statements);
        }
        finally { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      }
    }
    finally { await pool.end(); }
    assert.equal(counts[1], counts[0], `a link sent ${counts[0]} statements over 4 tables and ${counts[1]} over 32`);
  });
});

describe('SQLite acceptance of the same links', () => {
  const SQLITE_CASES = [
    ['drops an entity\'s index', 'DROP INDEX "User_by_age"', /^JD0023: the migrated shape does not equal the target model's: missing index:User_by_age$/],
  ];
  for (const [name, sql, message] of SQLITE_CASES) {
    it(`refuses a link that ${name}, and rolls it back`, async () => {
      const { dbPath, cleanup } = tempDbPath();
      try {
        await (await openStore(BASE, { driver: nodeDriver(), path: dbPath })).close();
        const link = linkWith(sqliteDialect, String(sql));
        await assert.rejects(migrate({ driver: nodeDriver(), path: dbPath }, [link], { baseline: BASE, model: NEXT, shadow: false }),
          { code: 'JD0023', message });
        const status = await migrationStatus({ driver: nodeDriver(), path: dbPath }, [link], { model: NEXT });
        assert.deepEqual([status.applied, status.pending], [[], ['l1']]);
      }
      finally { cleanup(); }
    });
  }
});
