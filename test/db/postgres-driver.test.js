//@ts-check
/**
 * @file The injected PostgreSQL driver, against a SCRIPTED client.
 *
 * Deterministic, and it may never skip: everything here is a claim
 * about the driver's own behaviour — the order it issues statements in,
 * what it does to a row on the way out and a value on the way in, which
 * failures it classifies as what, and that the client it acquired is
 * released exactly once whatever happened. None of that needs a server,
 * and a suite that could only check it against one would check it
 * nowhere.
 *
 * The scripted client answers by pattern and records every call, so a
 * case says "these statements, in this order" rather than "it worked".
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { openStore } from '@jarenjs/db';
import {
  postgresDriver, adaptPostgresClient, postgresProbe, postgresDialect, POSTGRES_FLOOR,
} from '@jarenjs/db/postgres';

/**
 * A client that answers from a table of handlers and records every
 * call. A handler is `[matcher, answer]`; the first matcher whose
 * pattern the statement text satisfies wins, and `answer` is a result,
 * a function of the values, or an Error to reject with.
 * @param {[RegExp, any][]} handlers
 * @param {{ failRelease?: boolean }} [options]
 */
function scriptedClient(handlers, options = undefined) {
  /** @type {{ text: string, name: string | undefined, values: any[] }[]} */
  const calls = [];
  let releases = 0;
  const client = {
    calls,
    get releases() { return releases; },
    query(config, maybeValues) {
      const text = typeof config === 'string' ? config : config.text;
      const name = typeof config === 'string' ? undefined : config.name;
      const values = (typeof config === 'string' ? maybeValues : config.values) ?? [];
      calls.push({ text, name, values });
      for (const [pattern, answer] of handlers) {
        if (!pattern.test(text)) continue;
        const result = typeof answer === 'function' ? answer(values, text) : answer;
        if (result instanceof Error) return Promise.reject(result);
        return Promise.resolve(result);
      }
      return Promise.resolve({ rows: [], rowCount: 0, fields: [] });
    },
    release() {
      releases += 1;
      if (options?.failRelease === true) throw new Error('release blew up');
      return undefined;
    },
  };
  return client;
}

/** The `current_setting` probe row every open starts with. */
const VERSION = /** @type {[RegExp, any]} */ ([
  /current_setting/,
  { rows: [{ num: '170005', version: '17.5' }], rowCount: 1,
    fields: [{ name: 'num', dataTypeID: 25 }, { name: 'version', dataTypeID: 25 }] },
]);

/** @param {[RegExp, any][]} handlers */
const source = (handlers, options) => {
  const client = scriptedClient(handlers, options);
  return { client, connect: () => Promise.resolve(client) };
};

const MODEL = {
  $model: '0.1',
  collections: {
    rows: {
      schema: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' }, n: { type: 'integer' } },
      },
      key: '/id',
      indexes: [{ name: 'by_n', path: '$.n' }],
    },
  },
};

/** The catalog answers for a store whose table already exists. */
const EXISTING = /** @type {[RegExp, any][]} */ ([
  VERSION,
  [/FROM pg_class c\b/, { rows: [{ name: 'rows' }], rowCount: 1,
    fields: [{ name: 'name', dataTypeID: 25 }] }],
  [/FROM pg_attribute a\b/, { rows: [
    { name: 'key', type: 'text', hidden: 0 },
    { name: 'doc', type: 'jsonb', hidden: 0 },
    { name: 'rid', type: 'bigint', hidden: 0 },
    { name: 'gx_n', type: 'numeric', hidden: 1 },
  ],
  rowCount: 4,
  fields: [{ name: 'name', dataTypeID: 25 }, { name: 'type', dataTypeID: 25 },
    { name: 'hidden', dataTypeID: 23 }] }],
  // the covered-columns statement first: it is the narrower shape, and
  // both read `pg_index`
  [/unnest\(i\.indkey/, { rows: [{ name: 'gx_n' }], rowCount: 1,
    fields: [{ name: 'name', dataTypeID: 25 }] }],
  [/FROM pg_index i JOIN pg_class ci/, { rows: [{ name: 'rows_by_n', uniq: 0, origin: 'c' }],
    rowCount: 1,
    fields: [{ name: 'name', dataTypeID: 25 }, { name: 'uniq', dataTypeID: 23 },
      { name: 'origin', dataTypeID: 25 }] }],
]);

describe('the injected PostgreSQL driver', () => {
  it('needs a connection source, and names what one is', () => {
    for (const bad of [null, undefined, {}, { connect: 1 }, 'pool']) {
      assert.throws(() => postgresDriver(/** @type {any} */ (bad)), (error) => {
        assert.strictEqual(error.code, 'JD0003');
        assert.match(error.message, /connect\(\)/);
        assert.match(error.message, /pg\.Pool/);
        return true;
      });
    }
    assert.strictEqual(postgresDriver({ connect: () => {} }).name, 'postgres');
  });

  it('a schema name is an identifier or nothing — it is written into a SET', () => {
    for (const bad of ['a; DROP SCHEMA public', 'has space', '"quoted"', '1leading']) {
      assert.throws(() => postgresDriver({ connect: () => {} }, { schema: bad }), (error) => {
        assert.strictEqual(error.code, 'JD0003');
        assert.match(error.message, /not a schema name/);
        return true;
      });
    }
    const driver = postgresDriver({ connect: () => {} }, { schema: 'jaren_run_1' });
    // ONE value, two consumers: the connection is pointed at the schema
    // and the dialect's catalog statements look in the same place
    assert.ok(driver.dialect.introspect.columns('rows').includes("n.nspname = 'jaren_run_1'"));
  });

  it('a store lives in a schema, so a path that is not one is refused by name', async () => {
    const driver = postgresDriver(source([VERSION]), { schema: 'jaren_run_1' });
    await assert.rejects(() => Promise.resolve(driver.open('/var/db/store.sqlite')), (error) => {
      assert.strictEqual(error.code, 'JD0003');
      assert.match(error.message, /lives in a\s+schema on a server rather than at a path/);
      assert.match(error.message, /postgresDriver\(source, \{ schema \}\)/);
      return true;
    });
    // the conventional "no path" spellings are accepted
    for (const path of [undefined, '', ':memory:', 'jaren_run_1']) {
      const opened = await Promise.resolve(driver.open(path));
      await opened.close();
    }
  });

  it('the open sequence: the search path, then the probe, and nothing else', async () => {
    const injected = source([VERSION]);
    const driver = postgresDriver(injected, { schema: 'jaren_run_1' });
    const connection = await Promise.resolve(driver.open());
    assert.deepStrictEqual(injected.client.calls.map((call) => call.text), [
      'SET search_path TO "jaren_run_1"',
      "SELECT current_setting('server_version_num') AS num, "
      + "current_setting('server_version') AS version",
    ]);
    assert.strictEqual(connection.capabilities.version, '17.5');
    await connection.close();
  });

  it('a server below the floor refuses the open by version', async () => {
    const old = source([[/current_setting/, {
      rows: [{ num: '150004', version: '15.4' }], rowCount: 1,
      fields: [{ name: 'num', dataTypeID: 25 }, { name: 'version', dataTypeID: 25 }],
    }]]);
    await assert.rejects(() => Promise.resolve(postgresDriver(old).open()), (error) => {
      assert.strictEqual(error.code, 'JD0001');
      assert.match(error.message, /15\.4/);
      assert.match(error.message, /floor 16\.0/);
      return true;
    });
    assert.strictEqual(old.client.releases, 1,
      'a refused open releases the client it took');
    assert.ok(Number.isInteger(POSTGRES_FLOOR) && POSTGRES_FLOOR === 160000);
  });

  it('the probe answers this engine, and every capability it does not have', async () => {
    const raw = adaptPostgresClient(scriptedClient([VERSION]));
    const capabilities = await Promise.resolve(postgresProbe(raw));
    assert.strictEqual(capabilities.jsonb, true);
    assert.strictEqual(capabilities.generatedColumns, true);
    assert.strictEqual(capabilities.returning, true);
    assert.strictEqual(capabilities.upsert, true);
    assert.strictEqual(capabilities.savepoints, true);
    assert.strictEqual(capabilities.alterTableFull, true);
    for (const absent of ['rtree', 'fts', 'sessions', 'userFunctions',
      'deterministicIndexableFunctions', 'aggregateFunctions', 'backup',
      'statementTimeout', 'rowEstimates', 'lazyIteration', 'jobs', 'changeCapture']) {
      assert.strictEqual(capabilities[absent], false, absent);
    }
    assert.deepStrictEqual([...capabilities.configurablePragmas], []);
    assert.deepStrictEqual(capabilities.maintenance,
      { checkpoint: false, integrityCheck: false, foreignKeyCheck: false, optimize: false });
    assert.ok(Object.isFrozen(capabilities));
  });

  describe('rows on the way out', () => {
    /** @param {any[]} fields @param {any[]} rows */
    const readBack = async (fields, rows) => {
      const raw = adaptPostgresClient(scriptedClient([[/./, { rows, rowCount: rows.length, fields }]]));
      return raw.prepare('SELECT 1').all([]);
    };

    it('an int8 or a numeric is a JavaScript number, not the text the wire sent', async () => {
      const out = await readBack(
        [{ name: 'count', dataTypeID: 20 }, { name: 'total', dataTypeID: 1700 },
          { name: 'small', dataTypeID: 21 }, { name: 'plain', dataTypeID: 23 }],
        [{ count: '3', total: '1.5', small: '2', plain: '7' },
          { count: null, total: null, small: null, plain: null }]);
      assert.deepStrictEqual(out[0], { count: 3, total: 1.5, small: 2, plain: 7 });
      assert.deepStrictEqual(out[1], { count: null, total: null, small: null, plain: null });
    });

    it('a bool is 1 or 0, which is what every shared form compares against', async () => {
      const out = await readBack([{ name: 'ok', dataTypeID: 16 }],
        [{ ok: true }, { ok: false }, { ok: null }]);
      assert.deepStrictEqual(out.map((row) => row.ok), [1, 0, null]);
    });

    it('a parsed json value is re-encoded, because the row decoder reads text', async () => {
      const out = await readBack([{ name: 'doc', dataTypeID: 3802 },
        { name: 'other', dataTypeID: 114 }],
      [{ doc: { a: 1, b: [2, 3] }, other: '{"already":"text"}' },
        { doc: null, other: null }]);
      assert.strictEqual(out[0].doc, '{"a":1,"b":[2,3]}');
      assert.strictEqual(out[0].other, '{"already":"text"}',
        'a host that already configured a raw parser is left alone');
      assert.strictEqual(out[1].doc, null);
    });

    it('a column the wire already answers correctly is not copied', async () => {
      const rows = [{ name: 'kept' }];
      const raw = adaptPostgresClient(scriptedClient([[/./,
        { rows, rowCount: 1, fields: [{ name: 'name', dataTypeID: 25 }] }]]));
      assert.strictEqual((await raw.prepare('SELECT 1').all([]))[0], rows[0]);
    });

    it('run() answers the affected count the store reads', async () => {
      const raw = adaptPostgresClient(scriptedClient([[/./, { rows: [], rowCount: 4, fields: [] }]]));
      assert.deepStrictEqual(await raw.prepare('UPDATE x SET y = 1').run([]), { changes: 4 });
      const none = adaptPostgresClient(scriptedClient([[/./, { rows: [], fields: [] }]]));
      assert.deepStrictEqual(await none.prepare('UPDATE x SET y = 1').run([]), { changes: 0 },
        'a client that reports no count reports no change, never NaN');
    });

    it('get() is the first row, and undefined where there is none', async () => {
      const raw = adaptPostgresClient(scriptedClient([[/./, { rows: [], rowCount: 0, fields: [] }]]));
      assert.strictEqual(await raw.prepare('SELECT 1').get([]), undefined);
    });
  });

  describe('values on the way in', () => {
    /** @param {any[]} params */
    const bind = async (params) => {
      const client = scriptedClient([[/./, { rows: [], rowCount: 0, fields: [] }]]);
      await adaptPostgresClient(client).prepare('SELECT $1').all(params);
      return client.calls[0].values;
    };

    it('a JavaScript boolean is 1 or 0, because a boolean member is', async () => {
      assert.deepStrictEqual(await bind([true, false]), [1, 0]);
    });

    it('undefined is null — an unbound external is absent, not the string', async () => {
      assert.deepStrictEqual(await bind([undefined, null]), [null, null]);
    });

    it('a bigint is its decimal text, which the server parses exactly', async () => {
      assert.deepStrictEqual(await bind([12345678901234567890n]), ['12345678901234567890']);
    });

    it('a byte view becomes the buffer the wire wants, never its toString', async () => {
      const bytes = new Uint8Array([1, 2, 3, 250]);
      const [bound] = await bind([bytes]);
      assert.ok(globalThis.Buffer.isBuffer(bound));
      assert.deepStrictEqual([...bound], [1, 2, 3, 250]);
    });

    it('everything else is bound as it stands', async () => {
      assert.deepStrictEqual(await bind(['a', 7, -1.5, '']), ['a', 7, -1.5, '']);
    });
  });

  describe('prepared statements', () => {
    it('one server-side name per statement, reused, and unique across adapters', async () => {
      const first = scriptedClient([[/./, { rows: [], rowCount: 0, fields: [] }]]);
      const rawA = adaptPostgresClient(first);
      const statement = rawA.prepare('SELECT 1');
      await statement.all([]);
      await statement.all([]);
      const nameA = first.calls[0].name;
      assert.ok(typeof nameA === 'string' && nameA.startsWith('jaren_s'));
      assert.strictEqual(first.calls[1].name, nameA, 'the same statement keeps its name');

      // a POOLED client's session outlives the store that borrowed it,
      // so a second adapter must not reuse the first's names for
      // different SQL — the server refuses that by name
      const second = scriptedClient([[/./, { rows: [], rowCount: 0, fields: [] }]]);
      await adaptPostgresClient(second).prepare('SELECT 2').all([]);
      assert.notStrictEqual(second.calls[0].name, nameA);
    });

    it('a cached plan whose result type changed re-runs unnamed rather than failing', async () => {
      let attempts = 0;
      const client = scriptedClient([[/SELECT \*/, () => {
        attempts += 1;
        if (attempts === 1)
          return Object.assign(new Error('cached plan must not change result type'), { code: '0A000' });
        return { rows: [{ a: 1 }], rowCount: 1, fields: [{ name: 'a', dataTypeID: 23 }] };
      }]]);
      const raw = adaptPostgresClient(client);
      assert.deepStrictEqual(await raw.prepare('SELECT * FROM t').all([]), [{ a: 1 }]);
      assert.strictEqual(client.calls.length, 2);
      assert.ok(client.calls[0].name !== undefined);
      assert.strictEqual(client.calls[1].name, undefined, 'the retry is unnamed');
    });

    it('any other failure is the caller\'s, unretried', async () => {
      const client = scriptedClient([[/SELECT/,
        Object.assign(new Error('nope'), { code: '42703' })]]);
      const raw = adaptPostgresClient(client);
      await assert.rejects(() => raw.prepare('SELECT missing FROM t').all([]),
        (error) => error.code === '42703');
      assert.strictEqual(client.calls.length, 1, 'one attempt');
    });
  });

  describe('the acquired client', () => {
    it('is released exactly once, after its statements are deallocated', async () => {
      const client = scriptedClient([VERSION]);
      const raw = adaptPostgresClient(client);
      await raw.prepare('SELECT 1').all([]);
      await raw.prepare('SELECT 2').all([]);
      await raw.close();
      const deallocated = client.calls.filter((call) => call.text.startsWith('DEALLOCATE'));
      assert.strictEqual(deallocated.length, 2,
        'the session goes back to the pool without this store\'s statements on it');
      assert.strictEqual(client.releases, 1);
      await raw.close();
      await raw.close();
      assert.strictEqual(client.releases, 1, 'a second close is a no-op');
    });

    it('is released even when the deallocation or the release itself fails', async () => {
      const failing = scriptedClient([
        [/DEALLOCATE/, Object.assign(new Error('gone'), { code: '26000' })],
        [/./, { rows: [], rowCount: 0, fields: [] }],
      ]);
      const raw = adaptPostgresClient(failing);
      await raw.prepare('SELECT 1').all([]);
      await raw.close();
      assert.strictEqual(failing.releases, 1);

      const blowing = scriptedClient([[/./, { rows: [], rowCount: 0, fields: [] }]],
        { failRelease: true });
      const second = adaptPostgresClient(blowing);
      await assert.rejects(() => Promise.resolve(second.close()), /release blew up/);
      assert.strictEqual(blowing.releases, 1);
    });

    it('a statement that never ran is never deallocated', async () => {
      const client = scriptedClient([[/./, { rows: [], rowCount: 0, fields: [] }]]);
      const raw = adaptPostgresClient(client);
      raw.prepare('SELECT 1'); // prepared here, never executed on the server
      await raw.close();
      assert.deepStrictEqual(client.calls.filter((c) => c.text.startsWith('DEALLOCATE')), []);
    });

    it('an onClose hook runs before the release', async () => {
      const order = [];
      const client = scriptedClient([[/./, { rows: [], rowCount: 0, fields: [] }]]);
      const raw = adaptPostgresClient({
        query: (...args) => client.query(...args),
        release: () => { order.push('release'); },
      }, { onClose: () => { order.push('onClose'); } });
      await raw.close();
      assert.deepStrictEqual(order, ['onClose', 'release']);
    });
  });

  describe('a store over the scripted client', () => {
    it('verifies the shape it finds and issues no configuration statement', async () => {
      const injected = source(EXISTING);
      const store = await openStore(MODEL,
        { driver: postgresDriver(injected, { schema: 'jaren_run_1' }) });
      try {
        const texts = injected.client.calls.map((call) => call.text);
        assert.deepStrictEqual(texts.filter((text) => /^PRAGMA/.test(text)), []);
        assert.deepStrictEqual(texts.filter((text) => /foreign_keys/.test(text)), [],
          'this engine always enforces, so nothing sets or reads the switch');
        assert.deepStrictEqual(texts.filter((text) => /^CREATE TABLE/.test(text)), [],
          'the table exists, so the open verifies rather than creates');
        // it read the catalog instead: the columns, the indexes, and
        // each index's covered columns in order
        assert.ok(texts.some((text) => /FROM pg_attribute/.test(text)));
        assert.ok(texts.some((text) => /unnest\(i\.indkey/.test(text)));
      }
      finally {
        await store.close();
      }
      assert.strictEqual(injected.client.releases, 1);
    });

    it('a top-level transaction is a BLOCK, and a nested one a savepoint', async () => {
      const injected = source(EXISTING);
      const store = await openStore(MODEL,
        { driver: postgresDriver(injected, { schema: 'jaren_run_1' }) });
      const before = injected.client.calls.length;
      await store.transaction(async (tx) => {
        await tx.transaction(async () => undefined);
      });
      const texts = injected.client.calls.slice(before).map((call) => call.text);
      // a SAVEPOINT outside a transaction is refused here, so the outer
      // one has to say a transaction is starting
      assert.strictEqual(texts[0], 'BEGIN');
      assert.match(texts[1], /^SAVEPOINT "jaren_sp_\d+"$/);
      assert.match(texts[2], /^RELEASE SAVEPOINT "jaren_sp_\d+"$/);
      assert.strictEqual(texts[3], 'COMMIT');
      await store.close();
    });

    it('a failing transaction rolls the block back, and the failure is classified',
      async () => {
        const injected = source([...EXISTING,
          [/^INSERT INTO "rows"/, Object.assign(
            new Error('duplicate key value violates unique constraint "rows_pkey"'),
            { code: '23505', constraint: 'rows_pkey' })]]);
        const store = await openStore(MODEL,
          { driver: postgresDriver(injected, { schema: 'jaren_run_1' }) });
        const before = injected.client.calls.length;
        await assert.rejects(() => store.transaction(async (tx) => {
          await tx.collection('rows').insert({ id: 'a', n: 1 });
        }), (error) => {
          assert.strictEqual(error.code, 'JD2001');
          assert.strictEqual(error.class, 'duplicate');
          assert.strictEqual(error.retryable, false);
          return true;
        });
        const texts = injected.client.calls.slice(before).map((call) => call.text);
        assert.strictEqual(texts[0], 'BEGIN');
        assert.strictEqual(texts[texts.length - 1], 'ROLLBACK');
        await store.close();
      });

    it('a statement after a failure inside a transaction is the engine\'s own refusal',
      async () => {
        // PostgreSQL poisons a transaction a statement failed in, and
        // says so with `25P02`. The store does not hide that: it arrives
        // classified, retryable false, under its own code — which is
        // what tells a caller to use a nested transaction if it means to
        // catch and continue
        const injected = source([...EXISTING,
          [/^INSERT INTO "rows"/, Object.assign(
            new Error('current transaction is aborted, commands ignored until end of '
              + 'transaction block'), { code: '25P02' })]]);
        const store = await openStore(MODEL,
          { driver: postgresDriver(injected, { schema: 'jaren_run_1' }) });
        await assert.rejects(() => store.transaction(async (tx) => {
          await tx.collection('rows').insert({ id: 'a', n: 1 });
        }), (error) => {
          assert.strictEqual(error.code, 'JD2088');
          assert.strictEqual(error.class, 'aborted');
          assert.strictEqual(error.retryable, false);
          return true;
        });
        await store.close();
      });

    it('a lost connection is retryable, and no credential reaches the message', async () => {
      const injected = source([...EXISTING,
        [/^SELECT .* FROM "rows"/, Object.assign(
          new Error('Connection terminated unexpectedly'), { code: '08006' })]]);
      const store = await openStore(MODEL,
        { driver: postgresDriver(injected, { schema: 'jaren_run_1' }) });
      await assert.rejects(() => Promise.resolve(store.collection('rows').get('a')), (error) => {
        assert.strictEqual(error.code, 'JD2087');
        assert.strictEqual(error.class, 'connection');
        assert.strictEqual(error.retryable, true);
        assert.ok(!/postgres:\/\//.test(error.message));
        return true;
      });
      await store.close();
    });

    it('a store asked for a SQLite-only subsystem is refused before any statement',
      async () => {
        for (const [option, code] of /** @type {[any, string][]} */ ([
          [{ capture: true }, 'JD0051'], [{ jobs: true }, 'JD0003']])) {
          const injected = source(EXISTING);
          await assert.rejects(
            () => openStore(MODEL,
              { driver: postgresDriver(injected, { schema: 'jaren_run_1' }), ...option }),
            (error) => {
              assert.strictEqual(error.code, code);
              return true;
            });
          assert.strictEqual(injected.client.releases, 1,
            'a refused open releases the client it took');
          assert.deepStrictEqual(
            injected.client.calls.filter((call) => /_jaren_(changes|jobs)/.test(call.text)), [],
            'the refusal precedes every statement the subsystem would have run');
        }
      });

    it('the dialect the driver carries is the one its statements are built from', async () => {
      const driver = postgresDriver({ connect: () => {} }, { schema: 'jaren_run_1' });
      assert.strictEqual(driver.dialect.name, 'postgres');
      // two calls make two dialect objects, and a store must not mix
      // them: the driver's is the one, and it carries the search path
      assert.notStrictEqual(driver.dialect, postgresDialect({ searchPath: 'jaren_run_1' }));
      assert.strictEqual(driver.dialect.introspect.columns('rows'),
        postgresDialect({ searchPath: 'jaren_run_1' }).introspect.columns('rows'));
    });
  });
});
