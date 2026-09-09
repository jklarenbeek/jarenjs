//@ts-check
/**
 * @file The migration runtime and its published declarations agree
 * exactly (every option `migrate`/`migrationStatus` reads is declared,
 * every declared option is read); a per-document assertion step walks
 * the collection in keyset batches like every other step and still
 * fails fast with `JD0023`; a cross-document assertion keeps its
 * whole-collection read, stated; and `migrationStatus` on a fresh
 * database writes nothing — no history table, not one byte.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openStore, migrate, migrationStatus, planMigration, sqliteDialect } from '@jarenjs/db';
import { nodeDriver, adaptNodeDatabase } from '@jarenjs/db/node';

import { tempDbPath } from './helpers.js';

const M0 = {
  $model: '0.1',
  collections: {
    users: {
      schema: { type: 'object', properties: { id: { type: 'string' }, n: { type: 'integer' } } },
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

/** A driver that records every prepared statement's text. */
function tracingDriver() {
  /** @type {string[]} */
  const prepared = [];
  return {
    prepared,
    driver: {
      name: 'node-sqlite', dialect: sqliteDialect,
      open: (dbPath, options) => {
        const db = new DatabaseSync(dbPath, options?.timeout === undefined ? {} : { timeout: options.timeout });
        return adaptNodeDatabase({
          exec: (sql) => db.exec(sql),
          prepare: (sql) => { prepared.push(sql); return db.prepare(sql); },
          function: (name, o, fn) => db.function(name, o, fn),
          aggregate: (name, spec) => db.aggregate(name, spec),
          createSession: (o) => (o === undefined ? db.createSession() : db.createSession(o)),
          close: () => db.close(),
        });
      },
    },
  };
}

/** A migration whose only step is the given assertion. */
function assertionMigration(assertion) {
  const { migration } = planMigration(M0, M1, { dialect: sqliteDialect, id: '0001-with-assertion' });
  migration.steps.push({ kind: 'query', collection: 'users', ...assertion });
  return migration;
}

async function seeded(n) {
  const { dbPath, cleanup } = tempDbPath();
  const store = await openStore(M0, { driver: nodeDriver(), path: dbPath });
  await store.transaction(async (tx) => {
    for (let i = 0; i < n; i++) await tx.collection('users').insert({ id: `u${String(i).padStart(5, '0')}`, n: i });
  });
  await store.close();
  return { dbPath, cleanup };
}

describe('declaration parity', () => {
  /** The `options.<name>` reads inside one exported function's body. */
  const readsOf = (source, name) => {
    const start = source.indexOf(`export function ${name}(`);
    assert.ok(start >= 0, name);
    const rest = source.slice(start);
    const end = rest.search(/\n}\n/);
    const body = rest.slice(0, end);
    return [...new Set([...body.matchAll(/\boptions\.([A-Za-z]+)\b/g)].map((m) => m[1]))].sort();
  };
  /** The member names of one interface or inline options object in the declarations. */
  const membersOf = (text) => [...new Set([...text.matchAll(/^\s+(?:readonly )?([A-Za-z]+)\??:/gm)].map((m) => m[1]))].sort();

  it('every option migrate reads is declared on MigrateOptions, and every declared option is read', () => {
    const source = fs.readFileSync(path.resolve('packages/db/src/migrate.js'), 'utf8');
    const types = fs.readFileSync(path.resolve('packages/db/types/index.d.ts'), 'utf8');
    const block = types.slice(types.indexOf('export interface MigrateOptions {'));
    const declared = membersOf(block.slice(0, block.indexOf('\n}\n')));
    assert.deepStrictEqual(readsOf(source, 'migrate'), declared);
  });

  it('every option migrationStatus reads is declared, and nothing declared goes unread', () => {
    const source = fs.readFileSync(path.resolve('packages/db/src/migrate.js'), 'utf8');
    const types = fs.readFileSync(path.resolve('packages/db/types/index.d.ts'), 'utf8');
    const at = types.indexOf('export declare function migrationStatus(');
    const signature = types.slice(at, types.indexOf('): Promise<MigrationStatusReport>;', at));
    const optionsText = signature.slice(signature.search(/options\??: \{/));
    // the members of the options object: parenthesised function types
    // (`registerFunctions?: (connection: unknown) => unknown`) carry
    // parameter names that are not members
    const flat = optionsText.replace(/\([^)]*\)/g, '()');
    const declared = [...new Set([...flat.matchAll(/\b([A-Za-z]+)\??:/g)].map((m) => m[1]))]
      .filter((name) => name !== 'options').sort();
    assert.deepStrictEqual(readsOf(source, 'migrationStatus'), declared);
  });

  it('the target parameter is typed: driver, path, busyTimeout', () => {
    const types = fs.readFileSync(path.resolve('packages/db/types/index.d.ts'), 'utf8');
    assert.match(types, /export interface MigrationTarget \{[\s\S]*?driver: Driver;[\s\S]*?path\?: string;[\s\S]*?busyTimeout\?: number;[\s\S]*?\}/);
    assert.match(types, /export declare function migrate\(\s*target: MigrationTarget,/);
    assert.match(types, /export declare function migrationStatus\(\s*target: MigrationTarget,/);
  });
});

describe('batched assertions', () => {
  it('a per-document assertion issues paged reads, never an unbounded whole-collection read, and still fails fast', async () => {
    const { dbPath, cleanup } = await seeded(5000);
    try {
      const { driver, prepared } = tracingDriver();
      const events = [];
      const migration = assertionMigration({
        assert: { $for: { it: '$[*]' }, $where: { $eq: ['$it.n', 2600] }, $return: '$it.id' },
        note: 'no user may carry n = 2600',
      });
      await assert.rejects(async () => migrate({ driver, path: dbPath }, [migration],
        { baseline: M0, model: M1, batchSize: 500, shadow: false, onProgress: (p) => events.push(p) }),
      (error) => error.code === 'JD0023' && /step 1 \(query\)/.test(error.message)
        && /expected an empty sequence/.test(error.message));
      const reads = prepared.filter((sql) => /FROM "users"/.test(sql));
      assert.strictEqual(reads.length, 2);
      for (const sql of reads) {
        assert.match(sql, /LIMIT 500/, sql);
        assert.match(sql, /ORDER BY "rowid"/, sql);
      }
      assert.doesNotMatch(reads[0], /WHERE/, 'the first page includes every signed identity');
      assert.match(reads[1], /WHERE "rowid" > \?/);
      // The violation is in batch six. Only the first five complete;
      // count progress, not preparations of the two reusable statements.
      assert.deepStrictEqual(events.filter((event) => event.asserted !== undefined)
        .map((event) => event.asserted), [500, 1000, 1500, 2000, 2500]);
    }
    finally {
      cleanup();
    }
  });

  it('a per-document assertion that holds passes over every batch, and progress reports the batches', async () => {
    const { dbPath, cleanup } = await seeded(1200);
    try {
      const events = [];
      const migration = assertionMigration({
        assert: { $for: { it: '$[*]' }, $where: { $lt: ['$it.n', 0] }, $return: '$it.id' },
      });
      const done = await migrate({ driver: nodeDriver(), path: dbPath }, [migration],
        { baseline: M0, model: M1, batchSize: 500, shadow: false, onProgress: (p) => events.push(p) });
      assert.deepStrictEqual(done.applied, ['0001-with-assertion']);
      const asserted = events.filter((event) => event.asserted !== undefined);
      assert.deepStrictEqual(asserted.map((event) => event.asserted), [500, 1000, 1200]);
    }
    finally {
      cleanup();
    }
  });

  it('a proven count assertion uses the provider without fetching documents', async () => {
    const { dbPath, cleanup } = await seeded(3);
    try {
      const { driver, prepared } = tracingDriver();
      const migration = assertionMigration({ assert: { $count: '$[*]' }, expect: 'ebv' });
      const plans = [];
      const done = await migrate({ driver, path: dbPath }, [migration],
        { baseline: M0, model: M1, batchSize: 1, shadow: false, onAssertionPlan: (plan) => plans.push(plan) });
      assert.deepStrictEqual(done.applied, ['0001-with-assertion']);
      assert.deepStrictEqual(plans.map((plan) => plan.strategy), ['provider']);
      const reads = prepared.filter((sql) => /FROM "users"/.test(sql));
      assert.deepStrictEqual(reads.filter((sql) => !/LIMIT/.test(sql)),
        ['SELECT COUNT(*) AS "value" FROM "users"']);
      // The final model validation still pages through documents.
      for (const sql of reads.filter((sql) => /LIMIT/.test(sql))) assert.match(sql, /LIMIT 1\b/);
      // and on an EMPTY collection the count assertion still fails, as
      // it always did — the fold answers 0 and its EBV is false
      const empty = tempDbPath();
      try {
        const store = await openStore(M0, { driver: nodeDriver(), path: empty.dbPath });
        await store.close();
        await assert.rejects(async () => migrate({ driver: nodeDriver(), path: empty.dbPath }, [migration],
          { baseline: M0, model: M1, shadow: false }),
        (error) => error.code === 'JD0023' && /EBV assertion answered false/.test(error.message));
      }
      finally {
        empty.cleanup();
      }
    }
    finally {
      cleanup();
    }
  });

  it('a MATERIALIZING assertion still reads whole — bounded, and refusing before the excess', async () => {
    // a nested $for reads the root twice: it decomposes into no batching,
    // so it holds the collection — under a declared bound
    const migration = assertionMigration({
      assert: {
        $for: { a: '$[*]', b: '$[*]' },
        $where: { $and: [{ $eq: ['$a.n', '$b.n'] }, { $ne: ['$a.id', '$b.id'] }] },
        $return: '$a.id',
      },
    });
    // every run needs its own database: an applied migration is history,
    // and a second attempt on the same file has nothing pending to run
    const run = async (bounds, use) => {
      const { dbPath, cleanup } = await seeded(50);
      try {
        const { driver, prepared } = tracingDriver();
        const outcome = await use(driver, dbPath, bounds);
        return { outcome, prepared };
      }
      finally { cleanup(); }
    };

    const applied = await run(undefined, (driver, dbPath) =>
      migrate({ driver, path: dbPath }, [migration],
        { baseline: M0, model: M1, batchSize: 10, shadow: false }));
    assert.deepStrictEqual(applied.outcome.applied, ['0001-with-assertion']);
    // it gathers through the same paged walk — the bound is checked per
    // row, so it can refuse before holding the excess
    const reads = applied.prepared.filter((sql) => /FROM "users"/.test(sql));
    assert.deepStrictEqual(reads.filter((sql) => !/LIMIT/.test(sql)), []);

    // and the bounds refuse, each naming itself
    const rows = await seeded(50);
    try {
      await assert.rejects(async () => migrate({ driver: nodeDriver(), path: rows.dbPath }, [migration],
        { baseline: M0, model: M1, batchSize: 10, shadow: false,
          assertionBounds: { maxRows: 20 } }),
      (error) => error.code === 'JD2007' && /maxRows bound of 20/.test(error.message));
    }
    finally { rows.cleanup(); }

    const bytes = await seeded(50);
    try {
      await assert.rejects(async () => migrate({ driver: nodeDriver(), path: bytes.dbPath }, [migration],
        { baseline: M0, model: M1, batchSize: 10, shadow: false,
          assertionBounds: { maxBytes: 200 } }),
      (error) => error.code === 'JD2076' && /maxBytes bound of 200/.test(error.message));
    }
    finally { bytes.cleanup(); }
  });

  it('a batched assertion is cancellable at its batch boundary (JD2080)', async () => {
    const { dbPath, cleanup } = await seeded(1500);
    try {
      const controller = new AbortController();
      let batches = 0;
      const migration = assertionMigration({
        assert: { $for: { it: '$[*]' }, $where: { $lt: ['$it.n', 0] }, $return: '$it.id' },
      });
      await assert.rejects(async () => migrate({ driver: nodeDriver(), path: dbPath }, [migration], {
        baseline: M0, model: M1, batchSize: 500, shadow: false, signal: controller.signal,
        onProgress: (event) => { if (event.asserted !== undefined && ++batches === 1) controller.abort(); },
      }), (error) => error.code === 'JD2080');
      assert.strictEqual(batches, 1);
    }
    finally {
      cleanup();
    }
  });
});

describe('side-effect-free status', () => {
  it('on a fresh file: applied [], every migration pending, no history table, not a byte written', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await openStore(M0, { driver: nodeDriver(), path: dbPath });
      await store.close();
      const before = fs.statSync(dbPath).size;
      const beforeBytes = fs.readFileSync(dbPath);
      const migration = planMigration(M0, M1, { dialect: sqliteDialect, id: '0001' }).migration;
      const report = await migrationStatus({ driver: nodeDriver(), path: dbPath }, [migration], { model: M1 });
      assert.deepStrictEqual(report, { applied: [], pending: ['0001'], drift: null, upToDate: false });
      const db = new DatabaseSync(dbPath, { readOnly: true });
      assert.strictEqual(db.prepare("SELECT name FROM sqlite_schema WHERE name = '_jaren_migrations'").get(), undefined);
      db.close();
      assert.strictEqual(fs.statSync(dbPath).size, before);
      assert.ok(fs.readFileSync(dbPath).equals(beforeBytes), 'the file is byte-identical');
      // on a migrated file the answers are what they were
      await migrate({ driver: nodeDriver(), path: dbPath }, [migration], { baseline: M0, model: M1 });
      const after = await migrationStatus({ driver: nodeDriver(), path: dbPath }, [migration], { model: M1 });
      assert.deepStrictEqual(after, { applied: ['0001'], pending: [], drift: null, upToDate: true });
    }
    finally {
      cleanup();
    }
  });
});
