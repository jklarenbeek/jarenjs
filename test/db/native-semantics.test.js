//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { from } from '@jarenjs/linq';
import { defineModel, object, integer, string } from '@jarenjs/linq/model';
import { normalizeEntities, explainMapping } from '@jarenjs/db/model';
import { createEntityQueryEngine, createQueryState } from '@jarenjs/db/query';

async function fixture(run) {
  const driver = process.versions.bun
    ? (await import('@jarenjs/db/bun')).bunDriver()
    : (await import('@jarenjs/db/node')).nodeDriver();
  const connection = await driver.open(':memory:');
  const model = defineModel({ entities: { Item: object({
    id: integer().identity('auto'), name: string().nullable(),
  }).physical({ table: 'items', columns: {
    id: { name: 'id', codec: 'integer', null: 'reject' },
    name: { name: 'name', codec: 'text', null: 'null' },
  } }) } });
  connection.exec("CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT COLLATE NOCASE); CREATE INDEX names ON items(name COLLATE BINARY); INSERT INTO items VALUES (1,NULL),(2,'a'),(3,'B')");
  const engine = createEntityQueryEngine({ connection, entities: normalizeEntities(model),
    mapping: explainMapping(model), state: createQueryState(8) });
  const rows = [{ id: 1, name: null }, { id: 2, name: 'a' }, { id: 3, name: 'B' }];
  const source = { root: '$.Item[*]', execute: (doc, options) => engine.execute(doc, { ...options, strict: true }) };
  try { await run({ engine, source, rows, connection }); }
  finally { connection.close(); }
}

it('present SQL null predicates preserve Jaren equality, ranges, negation and projection', async () => fixture(({ source, rows }) => {
  for (const op of ['eq', 'ne', 'lt', 'le', 'gt', 'ge']) for (const value of [null, 'a', 1, true]) {
    const query = (input) => from(input).where((r) => r.name[op](value)).select((r) => ({ id: r.id, name: r.name })).toArray();
    assert.deepEqual(query(source), query(rows), `${op} ${value}`);
  }
  assert.deepEqual(from(source).where((r) => r.name.eq(null).not()).select((r) => r.id).toArray(), [2, 3]);
}));

it('bound nullable native lookups keep null distinct from a missing external', async () => fixture(({ engine }) => {
  for (const op of ['$eq', '$ne', '$lt', '$ge']) for (const value of [null, 'a', 1]) {
    const doc = [{ $for: { it: '$.Item[*]' }, $where: { [op]: ['$it.name', '$needle'] }, $return: '$it.id' }];
    const options = { externals: { needle: value } };
    assert.deepEqual(engine.execute(doc, { ...options, strict: true }), engine.execute(doc, { ...options, pushdown: false }));
    assert.equal(engine.explain(doc, options).mode, 'native');
  }
}));

it('strict execute and both cursors refuse unsupported bindings before fetching rows', async () => fixture(({ engine }) => {
  const doc = { $for: { it: '$.Item[*]' }, $where: { $eq: ['$it.id', '$needle'] }, $return: '$it.id' };
  for (const externals of [{}, { needle: undefined }, { needle: true }, { needle: {} }, { needle: [] }]) {
    for (const method of ['execute', 'query', 'syncQuery']) {
      assert.throws(() => engine[method](doc, { strict: true, externals }), { code: 'JD0010' });
      const info = engine.explain(doc, { externals });
      assert.equal(info.mode, 'set');
      assert.equal(info.reasons[0].construct, 'external');
      assert.deepEqual(info.admitted, { statements: 0, rows: 0, bytes: 0 });
    }
  }
  assert.equal(engine.execute(doc, { strict: true, externals: { needle: 2 } }), 2);
  assert.equal(engine.explain(doc, { externals: { needle: 2 } }).mode, 'native');
}));

it('fluent identity/object composition and join projections stay native', async () => fixture(({ engine, source, rows }) => {
  for (const project of [(r) => r, (r) => ({ id: r.id, label: r.name })]) {
    const read = (input) => from(input).select(project).where((r) => r.id.gt(1)).orderByDescending((r) => r.id).select((r) => r.id).toArray();
    assert.deepEqual(read(source), read(rows));
  }
  const joined = from(source).join(from(source), (a) => a.id, (b) => b.id,
    (a, b) => ({ key: a.id, label: b.name })).where((r) => r.key.gt(1)).orderByDescending((r) => r.key);
  assert.deepEqual(joined.toArray(), [{ key: 3, label: 'B' }, { key: 2, label: 'a' }]);
  const limited = from(source).take(1).where((r) => r.id.gt(1));
  assert.throws(() => limited.toArray(), { code: 'JD0010' });
  assert.equal(engine.execute(limited.toDocument(), { pushdown: false }), undefined);
}));

it('standalone aggregates preserve empty results, null errors and integer overflow refusal', async () => fixture(({ source, rows, connection }) => {
  for (const method of ['sum', 'min', 'max', 'average']) {
    const read = (input) => from(input).select((r) => r.id)[method]();
    assert.equal(read(source), read(rows), method);
  }
  assert.equal(from(source).where((r) => r.id.lt(0)).select((r) => r.id).sum(), 0);
  assert.throws(() => from(source).where((r) => r.id.lt(0)).select((r) => r.id).max(), { code: 'JL2001' });
  assert.throws(() => from(source).select((r) => r.name).max(), { code: 'JQ2001' });
  connection.exec('INSERT INTO items(id) VALUES(9007199254740991)');
  assert.throws(() => from(source).select((r) => r.id).sum(), { code: 'JD0010' });
}));

it('LINQ synchronous iteration uses a native cursor and closes it on early exit', async () => fixture(({ engine }) => {
  let opened = 0, pulled = 0, closed = 0;
  const source = { root: '$.Item[*]', execute: () => assert.fail('iterator must not materialize'),
    syncQuery: (doc, options) => {
      const cursor = engine.syncQuery(doc, { ...options, strict: true });
      opened++;
      return { next: () => { pulled++; return cursor.next(); },
        return: () => { closed++; return cursor.return(); }, [Symbol.iterator]() { return this; } };
    } };
  for (const row of from(source).where((r) => r.id.ge(1))) { assert.equal(row.id, 1); break; }
  assert.deepEqual({ opened, pulled, closed }, { opened: 1, pulled: 1, closed: 1 });
}));

it('native logical mutations support exact matched assignments, arithmetic authority and bulk deletion', async () => {
  const { entityCore } = await import('@jarenjs/db/entity');
  const { compileEntityModel } = await import('@jarenjs/db/model');
  const { sql } = await import('@jarenjs/db/relational');
  const driver = process.versions.bun ? (await import('@jarenjs/db/bun')).bunDriver() : (await import('@jarenjs/db/node')).nodeDriver();
  const db = await driver.open(':memory:');
  try {
    db.exec("CREATE TABLE items(id INTEGER PRIMARY KEY,sku TEXT UNIQUE,quantity INTEGER NOT NULL); INSERT INTO items VALUES(1,'a',2);CREATE TABLE audit(kind TEXT); CREATE TRIGGER quantity_update AFTER UPDATE OF quantity ON items BEGIN INSERT INTO audit VALUES('quantity'); END");
    const model = defineModel({ entities: { Item: object({ id: integer().identity('auto'), sku: string(), qty: integer() }).physical({ table: 'items', columns: {
      id: { name: 'id', codec: 'integer', null: 'reject' }, sku: { name: 'sku', codec: 'text', null: 'reject' }, qty: { name: 'quantity', codec: 'integer', null: 'reject' },
    } }) } });
    const { entities, mapping } = compileEntityModel(model);
    const entity = entityCore(db, entities.get('Item'), mapping.entities.Item, null);
    assert.equal(entity.mutate({ op: 'update', key: 1, set: { qty: 2 } }).affected, 0);
    assert.equal(entity.mutate({ op: 'update', key: 1, set: { sku: 'a' }, reporting: 'matched' }).affected, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM audit').get([]).n, 0);
    assert.equal(entity.mutate({ op: 'update', key: 1, set: { qty: 2 }, reporting: 'matched' }).affected, 1);
    const update = { op: 'update', expressions: { qty: sql.binary('+', sql.column('qty'), 1) }, where: sql.binary('=', sql.column('qty'), 2) };
    assert.equal(entity.mutate(update).affected, 1); assert.equal(entity.mutate(update).affected, 0);
    assert.equal(entity.mutate({ op: 'upsert', values: { sku: 'a', qty: 4 }, conflict: ['sku'], update: ['qty'] }).affected, 1);
    assert.equal(entity.mutate({ op: 'upsert', values: { sku: 'a', qty: 9 }, conflict: ['sku'], onConflict: 'nothing' }).affected, 0);
    assert.throws(() => db.transaction(() => { entity.mutate({ op: 'delete', where: 1 }); throw new Error('rollback'); }), /rollback/);
    assert.equal(entity.get(1).qty, 4);
    assert.equal(entity.mutate({ op: 'delete', where: { $eq: ['$it.sku', 'a'] } }).affected, 1);
    assert.equal(entity.mutate({ op: 'delete', where: 1 }).affected, 0);
  }
  finally { db.close(); }
});

it('typed PostgreSQL column externals keep their dialect encoding when SQLite nullable binding expands', async () => {
  const { createEntityPredicateEmitters } = await import('../../packages/db/src/emit.js');
  const { postgresDialect: createPostgresDialect } = await import('@jarenjs/db/postgres');
  const postgresDialect = createPostgresDialect();
  const slots = [];
  const emitter = createEntityPredicateEmitters(postgresDialect, (slot) => { slots.push(slot); return postgresDialect.parameterRef(slots.length, 'v'); });
  const sql = emitter.emitPred('t', 't.doc', { p: 'compare', op: 'eq', operand: { ext: 'needle' },
    ref: { flavor: 'entity-column', column: 'name', storage: 'string', type: 'string' } });
  assert.ok(sql.includes('$1'));
  assert.deepEqual(slots, [{ external: 'needle', json: true }, { external: 'needle', json: true }]);
});
