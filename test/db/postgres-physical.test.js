//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, readSchema } from '@jarenjs/db';
import { postgresDriver, postgresDialect } from '@jarenjs/db/postgres';
import { columnCodec } from '../../packages/db/src/physical.js';
import { sql } from '@jarenjs/db/relational';

describe('native physical scalar contracts', () => {
  it('separates UUID, local microseconds and UTC microseconds from existing datetime text', () => {
    const codec = (name) => columnCodec({ name, codec: name, null: 'reject' });
    assert.equal(codec('uuid').normalize('A0000000-0000-0000-0000-000000000001'), 'a0000000-0000-0000-0000-000000000001');
    assert.throws(() => codec('uuid').encode('not-a-uuid'), { code: 'JD2003' });
    for (const name of ['local-timestamp', 'instant']) {
      const value = `2026-09-15T12:34:56.123456${name === 'instant' ? 'Z' : ''}`;
      assert.equal(codec(name).normalize(value), value);
      for (const bad of ['2026-02-30T12:34:56.123456', '2026-09-15T12:34:60.123456', '2026-09-15T12:34:56.123', '0000-01-01T00:00:00.000000'])
        assert.throws(() => codec(name).encode(bad), { code: 'JD2003' });
    }
    assert.equal(codec('datetime').normalize('2026-09-15T12:34:56+02:00'), '2026-09-15T12:34:56+02:00');
  });
  it('qualifies native precision before allowing coercion and preserves SQLite decimal lexemes', () => {
    const dialect = postgresDialect({ searchPath: 'tenant' });
    const column = { name: 'amount', physical: 'amount', codec: 'decimal', null: 'reject' };
    dialect.qualifyPhysicalColumn(column, { type: 'numeric(12,4)' }, 'table');
    const codec = columnCodec(column);
    assert.equal(codec.normalize('123456.0010'), '123456.0010');
    for (const value of ['1.01', '1.01001', '-0.0000']) assert.throws(() => codec.encode(value), { code: 'JD2003' });
    assert.equal(columnCodec({ name: 'amount', codec: 'decimal', null: 'reject' }).normalize('-0.00'), '-0.00');
    assert.equal(dialect.physicalTypeMatches('decimal', 'NUMERIC(4,-2)'), false);
    assert.equal(dialect.physicalTypeMatches('number', 'REAL'), false);
    assert.equal(dialect.physicalTypeMatches('datetime', 'TIMESTAMP WITH TIME ZONE'), false);
    assert.match(dialect.physicalRead('instant', 'stamp'), /AT TIME ZONE 'UTC'/);
    assert.match(dialect.physicalRead('instant', 'stamp'), /unsupported native temporal value/);
    for (const [column, actual] of [
      [{ codec: 'text', declaredType: 'varchar' }, { type: 'text' }],
      [{ codec: 'text' }, { type: 'text', native: { typeKind: 'd' } }],
      [{ codec: 'text', databaseDefault: true }, { type: 'text' }],
      [{ codec: 'integer', identity: 'always' }, { type: 'integer', native: { identity: 'by-default' } }],
    ]) assert.throws(() => dialect.qualifyPhysicalColumn(column, actual, 'table'), { code: 'JD0002' });
  });
});

const url = process.env.JAREN_PG_URL;
describe('PostgreSQL physical adoption', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  it('matches decoded query answers and bounds native mutation effects with one shared writer', async () => {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    const schema = `jaren_physical_queries_${process.pid}`;
    let store;
    try {
      await pool.query(`CREATE SCHEMA "${schema}"; CREATE TABLE "${schema}".items (
        id integer PRIMARY KEY, label text NOT NULL, quantity integer NOT NULL, weight double precision NOT NULL, active boolean NOT NULL);
        INSERT INTO "${schema}".items VALUES (1,'a',16777217,0.125,true),(2,'B',2,3.5,false),(3,'c',3,1.75,true)`);
      const codecs = { id: 'integer', label: 'text', qty: 'integer', weight: 'number', active: 'boolean' };
      const model = { $model: '0.1', entities: { Item: { schema: { type: 'object', properties: Object.fromEntries(
        Object.entries(codecs).map(([name, codec]) => [name, { type: codec === 'text' ? 'string' : codec,
          ...(name === 'id' ? { 'x-entity': { key: true } } : {}) }])) },
      physical: { schema, table: 'items', columns: Object.fromEntries(Object.entries(codecs).map(([name, codec]) =>
        [name, { name: name === 'qty' ? 'quantity' : name, codec, null: 'reject' }])) } } } };
      store = await openStore(model, { driver: postgresDriver(pool, { schema }), adopt: true });
      for (const [member, values] of Object.entries({ label: ['a', 'B', 1, true], qty: [2, 16777217, '2', true], weight: [0.125, 3.5], active: [true, false, 0, 1] })) {
        for (const op of ['$eq', '$ne', '$lt', '$ge']) for (const value of values) {
          const query = [{ $for: { it: '$.Item[*]' }, $where: { [op]: [`$it.${member}`, value] },
            $orderby: '$it.id', $return: { id: '$it.id', value: `$it.${member}` } }];
          assert.deepEqual(await store.execute(query, { strict: true }), await store.execute(query, { pushdown: false }), `${member} ${op} ${value}`);
        }
      }
      for (const op of ['$sum', '$avg', '$min', '$max']) for (const member of ['qty', 'weight']) {
        const query = [{ $for: { it: '$.Item[*]' }, $groupby: { active: '$it.active' },
          $return: { active: '$active', result: { [op]: `$it.${member}` } } }];
        if (member === 'weight' && ['$sum', '$avg'].includes(op)) {
          assert.equal((await store.explain(query)).mode, 'set');
          await assert.rejects(async () => store.execute(query, { strict: true }), { code: 'JD0010' });
        }
        else {
          const explanation = await store.explain(query);
          assert.equal(explanation.mode, 'native', `${op} ${member}: ${JSON.stringify(explanation)}`);
        }
        assert.deepEqual(await store.execute(query), await store.execute(query, { pushdown: false }), `${op} ${member}`);
      }
      const target = store.entity('Item');
      const update = { op: 'update', set: { label: 'changed', active: false },
        expressions: { qty: sql.binary('+', sql.column('qty'), 1) },
        where: sql.binary('=', sql.column('qty'), 16777217) };
      assert.equal((await target.mutate(update)).affected, 1);
      assert.equal((await target.get(1)).qty, 16777218);
      assert.equal((await target.mutate(update)).affected, 0);
      assert.equal((await target.mutate({ op: 'update', key: 1, set: { label: 'changed', active: false } })).affected, 0);
      assert.equal((await target.mutate({ op: 'update', key: 1, set: { label: 'changed' }, reporting: 'matched' })).affected, 1);
      const upsert = { op: 'upsert', values: { id: 1, label: 'new', qty: 5, weight: 1.5, active: true },
        conflict: ['id'], update: ['label', 'qty', 'weight', 'active'] };
      assert.equal((await target.mutate(upsert)).affected, 1);
      assert.equal((await target.mutate(upsert)).affected, 0);
      for (const bounds of [{ maxRows: 1 }, { maxBytes: 1 }]) {
        await assert.rejects(target.mutate({ op: 'delete', where: true, ...bounds }), { code: 'JD2007' });
        assert.equal((await target.get(1)).label, 'new');
        assert.ok(await target.get(3));
      }
      const copy = { op: 'insert-select', source: 'Item', conflict: ['id'], onConflict: 'nothing',
        select: { id: '$it.id', label: '$it.label', qty: '$it.qty', weight: '$it.weight', active: '$it.active' } };
      await assert.rejects(target.mutate({ ...copy, maxRows: 1 }), { code: 'JD2007' });
      assert.equal((await target.mutate(copy)).affected, 0);
      await assert.rejects(store.transaction(async (tx) => {
        await tx.entity('Item').mutate({ op: 'delete', key: 1 });
        throw new Error('withdraw');
      }), /withdraw/);
      assert.ok(await target.get(1));
    }
    finally { await store?.close(); await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await pool.end(); }
  });
  it('adopts exact composite columns without DDL, retains triggers, and saves renamed columns', async () => {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: url, max: 2 });
    const schema = `jaren_physical_${process.pid}`;
    let store, connection;
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      await pool.query(`CREATE TABLE "${schema}".records (
        owner uuid NOT NULL, sequence bigint NOT NULL, amount numeric(30,6) NOT NULL,
        enabled boolean NOT NULL, body bytea NOT NULL, payload jsonb NOT NULL,
        day date NOT NULL, local_stamp timestamp(6) NOT NULL, instant_stamp timestamptz(6) NOT NULL,
        label text NOT NULL DEFAULT 'created', computed text GENERATED ALWAYS AS (label || '!') STORED,
        PRIMARY KEY (sequence, owner));
        CREATE TABLE "${schema}".audit(owner uuid);
        CREATE FUNCTION "${schema}".observe() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN INSERT INTO "${schema}".audit VALUES (NEW.owner); RETURN NEW; END $$;
        CREATE TRIGGER observed AFTER INSERT ON "${schema}".records FOR EACH ROW EXECUTE FUNCTION "${schema}".observe()`);
      const columns = { owner: ['owner', 'uuid'], sequence: ['sequence', 'bigint'], amount: ['amount', 'decimal'],
        active: ['enabled', 'boolean'], bytes: ['body', 'blob-hex'], data: ['payload', 'json'],
        date: ['day', 'date'], local: ['local_stamp', 'local-timestamp'], instant: ['instant_stamp', 'instant'],
        label: ['label', 'text'], computed: ['computed', 'text'] };
      const model = { $model: '0.1', entities: { Record: {
        schema: { type: 'object', properties: Object.fromEntries(Object.keys(columns).map((key) => [key,
          { ...(key === 'data' ? {} : { type: key === 'active' ? 'boolean' : 'string' }),
            ...(['owner', 'sequence'].includes(key) ? { 'x-entity': { key: true } } : {}) }])) },
        physical: { schema, table: 'records', keys: ['sequence', 'owner'], columns: Object.fromEntries(Object.entries(columns)
          .map(([key, [name, codec]]) => [key, { name, codec, null: 'reject',
            ...(key === 'label' ? { default: 'database' } : {}), ...(key === 'computed' ? { generated: true } : {}) }])) },
      } } };
      const trace = [];
      const base = postgresDriver(pool, { schema });
      const driver = { ...base, open: async (...args) => {
        connection = await base.open(...args);
        return { ...connection, get mustQueue() { return connection.mustQueue; },
          prepare: (sql, options) => { trace.push(sql); return connection.prepare(sql, options); },
          exec: (sql) => { trace.push(sql); return connection.exec(sql); } };
      } };
      store = await openStore(model, { driver, adopt: true });
      const input = { owner: 'a0000000-0000-0000-0000-000000000001', sequence: '9007199254740993',
        amount: '123456789012345678901234.001234', active: true, bytes: '0001ff', data: { n: 1, value: null },
        date: '2026-09-15', local: '2026-09-15T12:34:56.123456', instant: '2026-09-15T10:34:56.123456Z' };
      const expected = { ...input, label: 'created', computed: 'created!' };
      assert.deepEqual(await store.entity('Record').create(input), expected);
      assert.deepEqual(await store.entity('Record').get(input), expected);
      assert.deepEqual(await store.execute({ $for: { r: '$.Record[*]' }, $return: '$r' }), expected);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM "${schema}".audit`)).rows[0].n, 1);
      assert.ok(trace.every((sql) => !/\b(?:CREATE|ALTER|DROP)\b/i.test(sql)), trace.join('\n'));
      const inventory = await readSchema(connection);
      const table = inventory.tables.find((entry) => entry.name === 'records');
      assert.deepEqual(table.primaryKey, ['sequence', 'owner']);
      assert.equal(table.columns.find((entry) => entry.name === 'owner').native.schema, schema);
      assert.ok(inventory.objects.some((entry) => entry.type === 'trigger' && entry.name === 'observed'));
      store.entity('Record').put({ ...expected, label: 'updated' });
      assert.equal((await store.saveChanges()).updated, 1);
      assert.equal((await store.entity('Record').get(input)).computed, 'updated!');
      assert.equal((await store.saveChanges()).updated, 0);
      const unchanged = { op: 'update', key: input, set: { amount: input.amount, bytes: input.bytes, data: input.data, active: input.active } };
      assert.equal((await store.entity('Record').mutate(unchanged)).affected, 0);
      assert.equal((await store.entity('Record').mutate({ ...unchanged, set: { ...unchanged.set, active: false } })).affected, 1);
      assert.equal((await store.entity('Record').get(input)).active, false);
      await assert.rejects(store.entity('Record').update(input, { amount: '1.1234567' }), { code: 'JD2003' });
      assert.equal((await store.entity('Record').get(input)).amount, input.amount);
      await assert.rejects(store.entity('Record').page({}, { limit: 1 }), /keyset continuation is not qualified/);
    }
    finally {
      await store?.close();
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });
});
