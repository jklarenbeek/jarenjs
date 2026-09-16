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
import { setTimeout as delay } from 'node:timers/promises';

import { openStore, createEntityQueryEngine, createQueryState } from '@jarenjs/db';
import { relational, sql } from '@jarenjs/db/relational';
import { compileEntityModel } from '@jarenjs/db/model';
import { entityCore } from '@jarenjs/db/entity';
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
  const discarded = [];
  const cursors = new Map();
  const settings = new Map([['statement_timeout', '0'], ['lock_timeout', '0']]);
  const client = {
    calls, discarded,
    get releases() { return releases; },
    query(config, maybeValues) {
      const text = typeof config === 'string' ? config : config.text;
      const name = typeof config === 'string' ? undefined : config.name;
      const values = (typeof config === 'string' ? maybeValues : config.values) ?? [];
      calls.push({ text, name, values });
      if (/^SHOW (statement_timeout|lock_timeout)$/.test(text))
        return Promise.resolve({ rows: [{ [text.slice(5)]: settings.get(text.slice(5)) }] });
      if (text === 'SELECT pg_catalog.set_config($1, $2, false)') {
        settings.set(values[0], values[1]);
        return Promise.resolve({ rows: [{ set_config: values[1] }] });
      }
      if (text.includes('FROM pg_catalog.pg_settings'))
        return Promise.resolve({ rows: [...settings].map(([name, value]) => ({ name, value, unit: 'ms' })) });
      const declaration = /^DECLARE "([^"]+)" NO SCROLL CURSOR FOR ([\s\S]+)$/.exec(text);
      if (declaration) {
        cursors.set(declaration[1], { sql: declaration[2], values, offset: 0, result: null });
        return Promise.resolve({ rows: [], command: 'DECLARE' });
      }
      const fetch = /^FETCH FORWARD (\d+) FROM "([^"]+)"$/.exec(text);
      if (fetch) {
        const cursor = cursors.get(fetch[2]);
        return Promise.resolve(cursor.result ?? client.query(cursor.sql, cursor.values)).then((result) => {
          cursor.result = result;
          const rows = result.rows.slice(cursor.offset, cursor.offset + Number(fetch[1]));
          cursor.offset += rows.length;
          return { ...result, rows, command: 'FETCH' };
        });
      }
      if (/^CLOSE /.test(text)) { cursors.delete(text.slice(7, -1)); return Promise.resolve({ rows: [], command: 'CLOSE' }); }
      for (const [pattern, answer] of handlers) {
        if (!pattern.test(text)) continue;
        const result = typeof answer === 'function' ? answer(values, text) : answer;
        if (result instanceof Error) return Promise.reject(result);
        return Promise.resolve(result);
      }
      if (text === 'SHOW search_path') return Promise.resolve({ rows: [{ search_path: '"$user", public' }] });
      if (text.includes('FROM pg_catalog.pg_namespace')) return Promise.resolve({ rows: [{ oid: '42', usage: 'true' }] });
      return Promise.resolve({ rows: [], rowCount: 0, fields: [], command: text.split(' ')[0] });
    },
    release(error) {
      releases += 1;
      if (error !== undefined) discarded.push(error);
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
  it('binds fresh physical assignments and withdraws invalid native readbacks', async () => {
    let returned = { id: 1, label: 'next', quantity: 2 };
    const client = scriptedClient([VERSION, [/UPDATE "native_items"/, () => ({ rows: [returned] })],
      [/^SELECT.*native_items/, { rows: [{ vp0: 2, tp0: 'integer' }] }]]);
    const connection = await postgresDriver({ connect: () => client }).open();
    try {
      const model = { $model: '0.1', entities: { Item: { schema: { type: 'object', properties: {
        id: { type: 'integer', 'x-entity': { key: true } }, label: { type: 'string' }, qty: { type: 'integer' },
      } }, physical: { table: 'native_items', columns: { id: { name: 'id', codec: 'integer', null: 'reject' },
        label: { name: 'label', codec: 'text', null: 'reject' }, qty: { name: 'quantity', codec: 'integer', null: 'reject' } } } } } };
      const { entities, mapping } = compileEntityModel(model);
      const query = createEntityQueryEngine({ connection, entities, mapping, state: createQueryState(8) });
      assert.equal(await query.execute({ $for: { it: '$.Item[*]' }, $where: { $eq: ['$it.qty', 2] }, $return: '$it.qty' }, { strict: true }), 2);
      const engine = entityCore(connection, entities.get('Item'), mapping.entities.Item, null);
      assert.deepStrictEqual((await engine.mutate({ op: 'update', key: 1, set: { label: 'next', qty: 2 } })).rows,
        [{ id: 1, label: 'next', qty: 2 }]);
      returned = { ...returned, quantity: 2.5 };
      await assert.rejects(engine.mutate({ op: 'update', key: 1, set: { label: 'other', qty: 3 } }), { code: 'JD2003' });
      const writes = client.calls.filter((call) => call.text.includes('UPDATE "native_items"'));
      assert.deepStrictEqual(writes.map((call) => call.values), [['next', 2, 1, 'next', 2], ['other', 3, 1, 'other', 3]]);
      assert.strictEqual(connection.transactionState(), 'rolled-back');
      const copied = await engine.mutate({ op: 'insert-select', source: 'Item', conflict: ['id'], onConflict: 'nothing',
        select: { id: '$it.id', label: '$it.label', qty: '$it.qty' }, maxRows: 1 });
      assert.equal(copied.affected, 0);
    }
    finally { await connection.close(); }
  });
  it('drains a structural cursor before disposal and retains the host connection', async () => {
    const client = scriptedClient([VERSION, [/SELECT.*native_items/, { rows: [{ id: 1 }, { id: 2 }], fields: [{ name: 'id', dataTypeID: 23 }] }]]);
    const connection = await postgresDriver({ connect: () => client }, { windowRows: 1 }).open();
    const engine = relational(connection);
    const cursor = engine.iterate({ from: 'native_items', columns: { id: sql.column('id') } });
    assert.deepStrictEqual(await cursor.next(), { value: { id: 1 }, done: false });
    await engine.dispose();
    assert.strictEqual(connection.metrics().cursors, 0);
    assert.strictEqual(client.releases, 0);
    assert.deepStrictEqual(await (await connection.prepare('SELECT id FROM native_items')).all(), [{ id: 1 }, { id: 2 }]);
    assert.throws(() => engine.all({ from: 'native_items' }), /disposed/);
    await connection.close();
  });
  it('accepts declared boolean parser forms and refuses ambiguous representations', async () => {
    for (const value of [false, true, 'f', 't', 'false', 'true', 0, 1, null, 'FALSE', 'yes', 2]) {
      const client = scriptedClient([VERSION, [/SELECT parsed/, { rows: [{ parsed: value }], fields: [{ name: 'parsed', dataTypeID: 16 }] }]]);
      const connection = await postgresDriver({ connect: () => client }).open();
      try {
        const statement = await connection.prepare('SELECT parsed');
        if (['FALSE', 'yes', 2].includes(value)) await assert.rejects(statement.get(), { code: 'JD2003' });
        else assert.deepStrictEqual(await statement.get(), { parsed: value === null ? null : [true, 't', 'true', 1].includes(value) ? 1 : 0 });
      }
      finally { await connection.close(); }
    }
  });
  it('exposes effective ownership metrics and routes cancellation to one active query generation', async () => {
    let enter, cancelQuery;
    const entered = new Promise((resolve) => { enter = resolve; });
    const response = new Promise((_, reject) => { cancelQuery = reject; });
    const client = Object.assign(scriptedClient([VERSION, [/SELECT slow/, () => { enter(); return response; }]]), {
      getTransactionStatus: () => 'I',
    });
    const cancelled = [];
    const connection = await postgresDriver({ connect: () => client }, {
      cancel: (target, generation) => {
        assert.strictEqual(target, client);
        cancelled.push(generation);
        cancelQuery(Object.assign(new Error('cancelled'), { code: '57014' }));
      },
    }).open();
    assert.strictEqual(connection.mustQueue, false);
    const cursor = await (await connection.prepare('SELECT slow')).iterate();
    const pulling = assert.rejects(cursor.next(), { code: '57014' });
    await entered;
    await cursor.return();
    await pulling;
    assert.strictEqual(cancelled.length, 1);
    assert.ok(Number.isSafeInteger(cancelled[0]) && cancelled[0] > 0);
    assert.strictEqual(connection.metrics().cursors, 0);
    assert.strictEqual(connection.transactionState(), 'rolled-back');
    await connection.close();
  });
  it('aborting session initialization discards a blocked source before any later setup runs', async () => {
    let enter, answer;
    const entered = new Promise((resolve) => { enter = resolve; });
    const response = new Promise((resolve) => { answer = resolve; });
    const trace = [], releases = [];
    const controller = new AbortController();
    const driver = postgresDriver({ connect: () => ({
      query: (query) => { trace.push(query); enter(); return response; },
      release: (error) => releases.push(error),
    }) }, { closeTimeoutMs: 10 });
    const failure = assert.rejects(driver.open(undefined, { signal: controller.signal }),
      (error) => error instanceof AggregateError && error.errors[0].code === 'JD2064');
    await entered;
    controller.abort();
    await failure;
    answer({ rows: [{ statement_timeout: '0' }] });
    await delay(0);
    assert.deepStrictEqual(trace, ['SHOW statement_timeout']);
    assert.strictEqual(releases.length, 1);
    assert.strictEqual(driver.metrics().active, 0);
  });
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

  it('the open sequence validates schema access and preserves the session setting', async () => {
    const injected = source([VERSION]);
    const driver = postgresDriver(injected, { schema: 'jaren_run_1' });
    const connection = await Promise.resolve(driver.open());
    assert.deepStrictEqual(injected.client.calls.map((call) => call.text), [
      'SHOW statement_timeout',
      'SELECT pg_catalog.set_config($1, $2, false)',
      'SHOW lock_timeout',
      'SELECT pg_catalog.set_config($1, $2, false)',
      "SELECT name, setting::text AS value, unit FROM pg_catalog.pg_settings WHERE name IN ('statement_timeout', 'lock_timeout')",
      'SHOW search_path',
      "SELECT n.oid::text AS oid, pg_catalog.has_schema_privilege(n.oid, 'USAGE')::text AS usage "
      + 'FROM pg_catalog.pg_namespace n WHERE n.nspname = $1',
      "SELECT pg_catalog.set_config('search_path', $1, false)",
      "SELECT current_setting('server_version_num') AS num, "
      + "current_setting('server_version') AS version",
    ]);
    assert.strictEqual(connection.capabilities.version, '17.5');
    await connection.close();
  });

  it('missing schemas and absent USAGE refuse before any DDL and restore the path', async () => {
    for (const [rows, code, state, classification] of [
      [[], 'JD2005', '3F000', 'cantopen'],
      [[{ oid: '42', usage: 'false' }], 'JD2083', '42501', 'readonly'],
    ]) {
      const injected = source([[/FROM pg_catalog.pg_namespace/, { rows }], VERSION]);
      await assert.rejects(postgresDriver(injected, { schema: 'tenant' }).open(),
        (error) => error.code === code && error.cause.code === state && error.class === classification);
      assert.strictEqual(injected.client.releases, 1);
      assert.deepStrictEqual(injected.client.calls.at(-1).values, ['"$user", public']);
      assert.ok(!injected.client.calls.some((c) => /^(CREATE|ALTER|DROP)/.test(c.text)));
    }
  });

  it('a probe failure restores the path and deallocates a failed prepared name', async () => {
    const failure = Object.assign(new Error('probe failed'), { code: '42501' });
    const injected = source([[/current_setting/, failure]]);
    await assert.rejects(postgresDriver(injected, { schema: 'tenant' }).open(),
      (error) => error.code === 'JD2083' && error.cause === failure);
    assert.deepStrictEqual(injected.client.calls.at(-1).values, ['"$user", public']);
    assert.strictEqual(injected.client.releases, 1);
    assert.strictEqual(injected.client.calls.filter((c) => /^DEALLOCATE/.test(c.text)).length, 1);
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
    assert.strictEqual(capabilities.changeCapture, true);
    assert.strictEqual(capabilities.jobs, true);
    assert.strictEqual(capabilities.savepoints, true);
    assert.strictEqual(capabilities.alterTableFull, true);
    for (const absent of ['rtree', 'fts', 'sessions', 'userFunctions',
      'deterministicIndexableFunctions', 'aggregateFunctions', 'backup',
      'statementTimeout', 'rowEstimates', 'lazyIteration']) {
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

    it('int8 refuses unsafe values from text, bigint, or a host number parser', async () => {
      const fields = [{ name: 'key', dataTypeID: 20 }];
      for (const value of ['9007199254740991', '-9007199254740991', 3n, 4]) {
        assert.deepStrictEqual(await readBack(fields, [{ key: value }]), [{ key: Number(value) }]);
      }
      for (const value of ['9007199254740992', '9007199254740993', '-9007199254740993',
        9007199254740993n, 9007199254740992]) {
        await assert.rejects(readBack(fields, [{ key: value }]),
          (error) => error.code === 'JD2005' && /safe JavaScript integer range/.test(error.reason));
      }
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
          return Object.assign(new Error('cached plan must not change result type'), { code: '0A000', routine: 'RevalidateCachedQuery' });
        return { rows: [{ a: 1 }], rowCount: 1, fields: [{ name: 'a', dataTypeID: 23 }] };
      }]]);
      const raw = adaptPostgresClient(client);
      assert.deepStrictEqual(await raw.prepare('SELECT * FROM t').all([]), [{ a: 1 }]);
      assert.strictEqual(client.calls.length, 2);
      assert.ok(client.calls[0].name !== undefined);
      assert.strictEqual(client.calls[1].name, undefined, 'the retry is unnamed');
    });

    it('transaction and generic feature failures are never retried, nor are writes', async () => {
      for (const [transaction, method, sql, routine] of [
        [true, 'all', 'SELECT * FROM t', 'RevalidateCachedQuery'],
        [false, 'all', 'SELECT * FROM t', 'exec_stmt_raise'],
        [false, 'run', 'UPDATE t SET id = 1 RETURNING *', 'RevalidateCachedQuery'],
      ]) {
        const failure = Object.assign(new Error('cached plan must not change result type'),
          { code: '0A000', routine });
        const client = scriptedClient([[/^(SELECT|UPDATE)/, failure]]);
        const raw = adaptPostgresClient(client);
        if (transaction) await raw.exec('BEGIN');
        await assert.rejects(raw.prepare(sql)[method](), (error) => error === failure);
        assert.strictEqual(client.calls.filter((c) => c.text === sql).length, 1);
        await raw.close();
        assert.strictEqual(client.calls.some((c) => c.text === 'ROLLBACK'), transaction);
      }
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

    it('restoration failure discards once and concurrent closes share the failure', async () => {
      const failure = new Error('restore refused');
      const client = scriptedClient([]);
      const raw = adaptPostgresClient(client, { onClose: () => { throw failure; } });
      const first = raw.close();
      assert.strictEqual(raw.close(), first);
      await assert.rejects(first, (error) => error === failure);
      assert.deepStrictEqual(client.discarded, [failure]);
      assert.strictEqual(client.releases, 1);
    });

    it('rollback or deallocation failure uses the injected destroy owner', async () => {
      for (const step of ['ROLLBACK', 'DEALLOCATE']) {
        const failure = Object.assign(new Error(step), { code: '08006' });
        const client = scriptedClient([[new RegExp(`^${step}`), failure]]);
        const destroyed = [];
        const raw = adaptPostgresClient(client, { destroy: (c, e) => { destroyed.push([c, e]); } });
        await raw.exec('BEGIN');
        await raw.prepare('SELECT 1').all();
        await assert.rejects(raw.close(), (error) => error === failure);
        assert.deepStrictEqual(destroyed, [[client, failure]]);
        assert.strictEqual(client.releases, 0);
      }
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

    it('a store asked for buffered replication is refused before ledger statements',
      async () => {
        for (const [option, code] of /** @type {[any, string][]} */ ([
          [{ replication: { replica: 'host' } }, 'JD0051']])) {
          const injected = source(EXISTING);
          await assert.rejects(
            () => openStore(MODEL,
              { driver: postgresDriver(injected, { schema: 'jaren_run_1', cursorMode: 'buffered' }), ...option }),
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
