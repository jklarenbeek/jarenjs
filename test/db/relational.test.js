//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { relational, sql, planRelational, defineTable, planTable, explainMapping, planEntity, sqliteDialect } from '@jarenjs/db';
import { defineModel, object, integer, string } from '@jarenjs/linq/model';

const c = sql.column, b = sql.binary, call = sql.call;
async function fixture(run) {
  const driver = process.versions.bun ? (await import('@jarenjs/db/bun')).bunDriver() : (await import('@jarenjs/db/node')).nodeDriver();
  const connection = await driver.open(':memory:');
  try { await run(connection, relational(connection)); }
  finally { connection.close(); }
}
const items = () => defineTable({ name: 'items', columns: [
  { name: 'id', type: 'INTEGER', identity: 'autoincrement', nullable: false },
  { name: 'name', type: 'TEXT', collation: 'NOCASE' },
  { name: 'state', type: 'TEXT', nullable: false, default: 'draft' },
  { name: 'revision', type: 'INTEGER', nullable: false, default: 1, check: b('>=', c('revision'), 1) },
  { name: 'raw', type: 'TEXT' }, { name: 'bytes', type: 'BLOB' },
], primaryKey: ['id'], indexes: [
  { name: 'current_name', unique: true, terms: [{ by: sql.collate(c('name'), 'NOCASE'), direction: 'asc' }], where: b('=', c('state'), 'draft') },
  { name: 'trimmed_name', terms: [{ by: call('trim', [c('name')]), direction: 'desc' }] },
], triggers: [{ name: 'immutable_items', timing: 'before', event: 'update',
  when: b('<>', c('state', 'OLD'), 'draft'), steps: [{ raise: { action: 'abort', message: 'immutable history' } }] }] });

it('column-first DDL preserves physical constraints, defaults, indexes and conditional triggers', async () => fixture((db, r) => {
  const plan = planTable(items());
  for (let i = 0; i < 2; i++) for (const text of plan.createSql) db.exec(text);
  assert.deepEqual(db.prepare('PRAGMA table_info(items)').all([]).map((x) => x.name), ['id', 'name', 'state', 'revision', 'raw', 'bytes']);
  const added = r.execute({ op: 'insert', table: 'items', values: { name: 'a' }, returning: '*' });
  assert.equal(added.rows[0].revision, 1);
  assert.equal(added.rows[0].id, 1);
  assert.throws(() => r.execute({ op: 'insert', table: 'items', values: { name: 'A' } }), /UNIQUE/);
  assert.throws(() => r.execute({ op: 'update', table: 'items', set: { revision: 0 }, where: 1 }), /CHECK/);
  r.execute({ op: 'update', table: 'items', set: { state: 'posted' }, where: b('=', c('id'), 1) });
  assert.throws(() => r.execute({ op: 'update', table: 'items', set: { state: 'posted' }, where: 1 }), /immutable history/);
  const model = defineModel({ entities: { Item: object({ id: integer().identity('auto'), name: string().nullable() })
    .physical({ table: 'simple', columns: { id: { name: 'id', codec: 'integer', null: 'reject' }, name: { name: 'name', codec: 'text', null: 'null' } } }) } });
  const mapping = explainMapping(model);
  for (const text of planEntity('Item', mapping.entities.Item, mapping, sqliteDialect).createSql) db.exec(text);
  assert.deepEqual(db.prepare('PRAGMA table_info(simple)').all([]).map((x) => x.type), ['INTEGER', 'TEXT']);
}));

it('native relational reads preserve raw JSON, NULL, SQLite casts, aggregates and collation', async () => fixture((db, r) => {
  db.exec('CREATE TABLE items(id INTEGER PRIMARY KEY,name TEXT,raw TEXT); CREATE TABLE lines(item INTEGER,amount REAL)');
  for (const values of [{ id: 1, name: null, raw: ' { "price" : "2.5", "qty": 2 } ' }, { id: 2, name: 'Ä', raw: '{}' }, { id: 3, name: 'a', raw: '{}' }]) r.execute({ op: 'insert', table: 'items', values });
  db.exec('INSERT INTO lines VALUES(1,0.1),(1,0.2),(2,1.5)');
  const query = { from: { table: 'items', as: 'i' }, columns: {
    id: c('id', 'i'), raw: c('raw', 'i'),
    price: sql.cast(call('json_extract', [c('raw', 'i'), '$.price']), 'REAL'),
    total: sql.scalar({ from: 'lines', columns: { n: call('coalesce', [call('sum', [c('amount')]), 0]) }, where: b('=', c('item'), c('id', 'i')) }),
    present: sql.exists({ from: 'lines', columns: { one: 1 }, where: b('=', c('item'), c('id', 'i')) }),
  }, orderBy: [{ by: sql.collate(c('name', 'i'), 'NOCASE'), nulls: 'first' }] };
  const expected = db.prepare("SELECT i.id,i.raw,CAST(json_extract(i.raw,'$.price') AS REAL) AS price,(SELECT COALESCE(SUM(amount),0) FROM lines WHERE item=i.id) AS total,EXISTS(SELECT 1 FROM lines WHERE item=i.id) AS present FROM items i ORDER BY i.name COLLATE NOCASE NULLS FIRST").all([]);
  assert.deepEqual(r.all(query), expected);
  assert.deepEqual([...r.iterate(query)], expected);
  const grouped = { from: { table: 'items', as: 'i' }, joins: [{ source: { table: 'lines', as: 'l' }, type: 'left', on: b('=', c('item', 'l'), c('id', 'i')) }],
    columns: { id: c('id', 'i'), n: call('count', [c('amount', 'l')], { distinct: true }), sum: call('sum', [c('amount', 'l')]) },
    groupBy: [c('id', 'i')], having: b('>=', call('count', []), 1), orderBy: [{ by: c('id', 'i') }] };
  assert.deepEqual(r.all(grouped), db.prepare('SELECT i.id,COUNT(DISTINCT l.amount) AS n,SUM(l.amount) AS sum FROM items i LEFT JOIN lines l ON l.item=i.id GROUP BY i.id HAVING COUNT(*)>=1 ORDER BY i.id').all([]));
  assert.equal(r.get({ from: 'lines', where: 0, columns: { n: call('sum', [c('amount')]) } }).n, null);
  assert.equal(r.get({ from: 'lines', columns: { n: call('sum', [sql.case([{ when: b('=', c('item'), 1), then: c('amount') }], 0)]) } }).n, 0.1 + 0.2);
  assert.deepEqual(r.all({ union: [{ from: 'items', columns: { id: c('id') }, where: b('<=', c('id'), 2) }, { from: 'items', columns: { id: c('id') }, where: b('>=', c('id'), 2) }], orderBy: [{ by: c('id') }] }).map((r) => r.id), [1, 2, 3]);
}));

it('exact assignments, conditional authority, partial conflicts and byte copying use one transaction', async () => fixture((db, r) => {
  for (const text of planTable(items()).createSql) db.exec(text);
  db.exec('CREATE TABLE audit(n INTEGER); CREATE TRIGGER only_name AFTER UPDATE OF name ON items BEGIN INSERT INTO audit VALUES(1); END');
  const bytes = new Uint8Array([9, 0, 255, 7]).subarray(1, 3);
  r.execute({ op: 'insert', table: 'items', values: { name: 'a', bytes, raw: ' { "x": 1 } ' } });
  assert.equal(r.execute({ op: 'update', table: 'items', set: { raw: c('raw') }, where: 1 }).affected, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM audit').get([]).n, 0);
  assert.equal(r.execute({ op: 'update', table: 'items', set: { name: 'a' }, reporting: 'changed', where: 1 }).affected, 0);
  assert.equal(r.execute({ op: 'update', table: 'items', set: { name: 'a' }, reporting: 'matched', where: 1 }).affected, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM audit').get([]).n, 1);
  const update = { op: 'update', table: 'items', set: { revision: b('+', c('revision'), 1) }, where: b('AND', b('=', c('revision'), 1), b('=', c('state'), 'draft')) };
  assert.equal(r.execute(update).affected, 1); assert.equal(r.execute(update).affected, 0);
  const conflict = { target: [sql.collate(c('name'), 'NOCASE')], where: b('=', c('state'), 'draft'), action: 'update', set: { bytes: c('bytes', 'excluded') } };
  assert.equal(r.execute({ op: 'insert', table: 'items', values: { name: 'A', bytes: new Uint8Array([0, 1, 0]) }, conflict }).affected, 1);
  assert.deepEqual([...r.get({ from: 'items' }).bytes], [0, 1, 0]);
  assert.equal(r.execute({ op: 'insert', table: 'items', values: { name: 'a' }, conflict: { target: conflict.target, where: conflict.where, action: 'nothing' } }).affected, 0);
  db.exec('CREATE TABLE copies(id INTEGER PRIMARY KEY,bytes BLOB,raw TEXT)');
  assert.equal(r.execute({ op: 'insert', table: 'copies', columns: ['id', 'bytes', 'raw'], source: { from: 'items', columns: { id: c('id'), bytes: c('bytes'), raw: c('raw') } }, conflict: { action: 'nothing' } }).affected, 1);
  assert.deepEqual([...r.get({ from: 'copies' }).bytes], [0, 1, 0]);
  assert.throws(() => db.transaction(() => { r.execute({ op: 'delete', table: 'copies', where: 1 }); throw new Error('rollback'); }), /rollback/);
  assert.equal(r.get({ from: 'copies' }).raw, ' { "x": 1 } ');
  assert.throws(() => planRelational({ from: 'items', where: sql.param('missing') }), { code: 'JD0038' });
  assert.throws(() => planRelational({ op: 'delete', table: 'items' }), { code: 'JD0038' });
}));

it('unknown-schema scans inspect SQLite storage classes and release their first row', async () => fixture((db, r) => {
  db.exec('CREATE TABLE "user supplied"("payload" ANY) STRICT');
  for (const value of [123, 'secret', null, new Uint8Array([0, 1]), 'other']) r.execute({ op: 'insert', table: 'user supplied', values: { payload: value } });
  const query = { from: 'user supplied', columns: { rid: c('rowid'), value: c('payload') }, where: b('=', call('typeof', [c('payload')]), 'text'), orderBy: [{ by: c('rowid') }] };
  const expected = db.prepare('SELECT rowid AS rid,payload AS value FROM "user supplied" WHERE typeof(payload)=\'text\' ORDER BY rowid').all([]);
  assert.deepEqual(r.all(query), expected);
  const cursor = r.iterate(query);
  assert.equal(cursor.streaming, 'row');
  assert.equal(cursor.next().value.value, 'secret');
  cursor.return(); assert.equal(cursor.next().done, true);
  // The released read no longer holds a statement over the schema.
  db.exec('DROP TABLE "user supplied"');
}));

it('schema defaults and invalid structural programs are checked without SQL string wrappers', async () => fixture((db, r) => {
  const table = { name: 'timestamps', columns: [{ name: 'at', type: 'TEXT', default: call('strftime', ['%Y-%m-%dT%H:%M:%fZ', 'now']) }] };
  for (const statement of planTable(table).createSql) db.exec(statement);
  r.execute({ op: 'insert', table: 'timestamps', values: {} });
  assert.match(r.get({ from: 'timestamps' }).at, /^\d{4}-\d{2}-\d{2}T/);
  for (const value of [{ ...table, indexes: {} }, { ...table, constraints: [{ kind: 'unique', columns: ['at'], onDelete: 'cascade' }] },
    { ...table, indexes: [{ name: 'bad', terms: [{ by: c('at'), nulls: 'first' }] }] }]) assert.throws(() => planTable(value), { code: 'JD0005' });
  assert.throws(() => planRelational({ op: 'insert', table: 'timestamps', values: {}, extra: 'ignored' }), { code: 'JD0038' });
}));

it('value, negation, membership and windows execute with explicit SQLite semantics', async () => fixture((db, r) => {
  db.exec('CREATE TABLE items(id INTEGER); INSERT INTO items VALUES(1),(2),(3),(4)');
  const query = { from: 'items', columns: { id: c('id'), literal: sql.value('quoted\'text') },
    where: sql.not(sql.in(c('id'), [2, 4])), orderBy: [{ by: c('id'), direction: 'desc' }], limit: 1, offset: 1 };
  assert.deepEqual(r.all(query), db.prepare("SELECT id,? AS literal FROM items WHERE NOT(id IN (2,4)) ORDER BY id DESC LIMIT 1 OFFSET 1").all(["quoted'text"]));
}));

it('catalog-driven native reads include framework tables without adopting their shape', async () => fixture((db, r) => {
  db.exec("CREATE TABLE _jaren_jobs(payload);INSERT INTO _jaren_jobs VALUES('framework text')");
  const tables = r.all({ from: 'sqlite_schema', columns: { name: c('name') }, where: b('=', c('type'), 'table') });
  assert.ok(tables.some((table) => table.name === '_jaren_jobs'));
  assert.equal(r.get({ from: '_jaren_jobs', columns: { text: c('payload') }, where: b('=', call('typeof', [c('payload')]), 'text') }).text, 'framework text');
}));

it('execute reports lastInsertRowid only for an insert that inserted a row of a rowid table', async () => fixture((db, r) => {
  db.exec('CREATE TABLE a(id INTEGER PRIMARY KEY, name TEXT UNIQUE); CREATE TABLE b(id INTEGER PRIMARY KEY, x);'
    + ' CREATE TABLE w(k TEXT PRIMARY KEY, v) WITHOUT ROWID; CREATE TABLE copies(id INTEGER PRIMARY KEY, x)');
  const has = (/** @type {any} */ result) => Object.hasOwn(result, 'lastInsertRowid');
  r.execute({ op: 'insert', table: 'b', values: { x: 1 } });
  assert.equal(Number(r.execute({ op: 'insert', table: 'b', values: { x: 2 } }).lastInsertRowid), 2);
  assert.equal(Number(r.execute({ op: 'insert', table: 'a', values: { name: 'n' } }).lastInsertRowid), 1);
  // an ignored duplicate inserted nothing: the connection's last rowid is another row's
  const ignored = r.execute({ op: 'insert', table: 'a', values: { name: 'n' }, ignore: true });
  assert.equal(ignored.affected, 0);
  assert.equal(has(ignored), false, 'no rowid for an insert that inserted nothing');
  r.execute({ op: 'insert', table: 'b', values: { x: 3 } });
  // an upsert that updated reports the changed row as affected, and SQLite cannot say whether it inserted
  const upserted = r.execute({ op: 'insert', table: 'a', values: { name: 'n' },
    conflict: { target: ['name'], action: 'update', set: { name: c('name', 'excluded') } } });
  assert.equal(upserted.affected, 1);
  assert.equal(has(upserted), false, "an upsert's row may have been updated: returning names it");
  // a WITHOUT ROWID table has no rowid to report
  const keyed = r.execute({ op: 'insert', table: 'w', values: { k: 'k', v: 1 } });
  assert.equal(keyed.affected, 1);
  assert.equal(has(keyed), false, 'a WITHOUT ROWID insert reports no rowid');
  for (const document of [{ op: 'update', table: 'a', set: { name: 'm' }, where: 1 }, { op: 'delete', table: 'b', where: b('=', c('id'), 3) }])
    assert.equal(has(r.execute(/** @type {any} */ (document))), false, `${document.op} reports no rowid`);
  const copied = r.execute({ op: 'insert', table: 'copies', columns: ['x'], source: { from: 'b', columns: { x: c('x') }, orderBy: [{ by: c('id') }] } });
  assert.equal(copied.affected, 2);
  assert.equal(Number(copied.lastInsertRowid), 2, 'an insert-select reports its last inserted row');
}));

it('a synchronous engine refuses to enter another caller\'s transaction (JD0012) and refuses once disposed (JD2063)', async () => fixture(async (db, r) => {
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, n INTEGER); INSERT INTO t VALUES (1, 1)');
  /** @type {(v?: any) => void} */
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const holding = db.transaction(async () => { await gate; });
  try {
    for (const call of [() => r.all({ from: 't' }), () => r.get({ from: 't' }), () => r.iterate({ from: 't' }).next(),
      () => r.execute({ op: 'update', table: 't', set: { n: 2 }, where: 1 })]) {
      assert.throws(call, (/** @type {any} */ error) => error.code === 'JD0012', 'contention is the store\'s code, not an invalid document');
    }
  }
  finally {
    release();
    await holding;
  }
  assert.equal(r.get({ from: 't', columns: { n: c('n') } }).n, 1);
  r.dispose();
  for (const call of [() => r.all({ from: 't' }), () => r.execute({ op: 'delete', table: 't', where: 1 })])
    assert.throws(call, (/** @type {any} */ error) => error.code === 'JD2063' && /disposed/.test(error.message));
}));

it('driver failures are classified on every path: execute, reads and cursor pulls', async () => fixture((db, r) => {
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, n INTEGER CHECK (n >= 0)); INSERT INTO t VALUES (1, 1)');
  const classified = (/** @type {string} */ klass, /** @type {RegExp} */ text) => (/** @type {any} */ error) =>
    error.code === 'JD2005' && error.class === klass && text.test(error.message) && error.cause !== undefined;
  assert.throws(() => r.execute({ op: 'insert', table: 't', values: { id: 1, n: 2 } }), classified('constraint', /UNIQUE/));
  assert.throws(() => r.execute({ op: 'update', table: 't', set: { n: -1 }, where: 1 }), classified('constraint', /CHECK/));
  const malformed = { columns: { x: call('json_extract', ['not json', '$.a']) } };
  assert.throws(() => r.all(malformed), classified('error', /malformed JSON/));
  assert.throws(() => r.get(malformed), classified('error', /malformed JSON/));
  assert.throws(() => r.iterate(malformed).next(), classified('error', /malformed JSON/));
}));

const OPERATORS = /** @type {const} */ (['=', '<>', '<', '<=', '>', '>=', 'IS', 'IS NOT', '+', '-', '*', '/', '%', '||', 'AND', 'OR', 'LIKE', 'NOT LIKE', 'GLOB']);
const refused = (/** @type {string} */ text) => (/** @type {any} */ error) => error.code === 'JD0038' && error.message.includes(text);
/** The builder as an untyped caller reaches it: any count of arguments. */
const loose = /** @type {(...args: any[]) => any} */ (b);

it('sql.binary keeps every operand: AND and OR nest any number from the left, every other operator refuses a third (JD0038)', async () => fixture((db, r) => {
  // every two-operand call builds the node and plans the SQL it did before
  for (const op of OPERATORS) {
    const node = b(op, c('x'), 2);
    assert.deepEqual(Object.keys(node), ['$sql', 'op', 'left', 'right']);
    assert.deepEqual(node, { $sql: 'binary', op, left: { $sql: 'column', name: 'x' }, right: 2 });
    assert.deepEqual(planRelational({ columns: { v: node } }), { sql: `SELECT ("x" ${op} ?) AS "v"`, params: [2], access: 'read' });
  }
  // a missing operand still builds the node it did, refused when compiled
  assert.deepEqual(loose('AND', c('x')), { $sql: 'binary', op: 'AND', left: { $sql: 'column', name: 'x' }, right: undefined });
  assert.throws(() => planRelational({ columns: { v: loose('AND', c('x')) } }), refused('SQL values are'));
  const key = (/** @type {any} */ value) => b('=', c('key'), value);
  assert.deepEqual(b('AND', key('a'), key('b'), key('c')), b('AND', b('AND', key('a'), key('b')), key('c')));
  assert.deepEqual(b('OR', 1, 2, 3, 4), { $sql: 'binary', op: 'OR',
    left: { $sql: 'binary', op: 'OR', left: { $sql: 'binary', op: 'OR', left: 1, right: 2 }, right: 3 }, right: 4 });
  assert.deepEqual(planRelational({ from: 't', columns: { key: c('key') }, where: b('AND', key('a'), key('a'), key('zzz')) }), {
    sql: 'SELECT "key" AS "key" FROM "t" WHERE ((("key" = ?) AND ("key" = ?)) AND ("key" = ?))', params: ['a', 'a', 'zzz'], access: 'read' });
  // the nesting limit bounds the count: 64 comparisons nest within it, a 65th does not
  planRelational({ from: 't', where: loose('AND', ...Array(64).fill(key('a'))) });
  assert.throws(() => planRelational({ from: 't', where: loose('AND', ...Array(65).fill(key('a'))) }), refused('nesting exceeds 64'));
  for (const op of OPERATORS.filter((o) => o !== 'AND' && o !== 'OR'))
    assert.throws(() => loose(op, 1, 2, 3), refused(`sql.binary('${op}') takes two operands, not 3: an operand past the second would be left out`));
  assert.throws(() => loose('<', 1, 2, 3, 4), refused("sql.binary('<') takes two operands, not 4"));
  assert.throws(() => loose('=', 1, 2, undefined), refused("sql.binary('=') takes two operands, not 3"), 'an explicit extra argument counts');

  db.exec("CREATE TABLE t(key TEXT PRIMARY KEY); INSERT INTO t VALUES ('a'), ('b'), ('c')");
  const rows = (/** @type {any} */ where) => r.all({ from: 't', columns: { key: c('key') }, where, orderBy: [{ by: c('key') }] }).map((row) => row.key);
  const native = (/** @type {string} */ where) => db.prepare(`SELECT key FROM t WHERE ${where} ORDER BY key`).all([]).map((row) => row.key);
  // the answers a dropped operand gave: AND(a, a, zzz) matched a, OR(x, y, a) matched nothing
  assert.deepEqual(rows(b('AND', key('a'), key('a'), key('zzz'))), []);
  assert.deepEqual(rows(b('OR', key('x'), key('y'), key('a'))), ['a']);
  // the builder, the node nested by hand and SQLite's own reading of the flat predicate agree
  for (const [built, nested, text] of /** @type {[any, any, string][]} */ ([
    [b('AND', key('a'), key('a'), key('zzz')), b('AND', b('AND', key('a'), key('a')), key('zzz')), "key = 'a' AND key = 'a' AND key = 'zzz'"],
    [b('OR', key('x'), key('y'), key('a')), b('OR', b('OR', key('x'), key('y')), key('a')), "key = 'x' OR key = 'y' OR key = 'a'"],
    [b('OR', key('a'), key('zz'), key('c'), key('b')), b('OR', b('OR', b('OR', key('a'), key('zz')), key('c')), key('b')), "key = 'a' OR key = 'zz' OR key = 'c' OR key = 'b'"],
    [b('AND', b('<>', c('key'), 'a'), b('<>', c('key'), 'b'), b('IS NOT', c('key'), null)), b('AND', b('AND', b('<>', c('key'), 'a'), b('<>', c('key'), 'b')), b('IS NOT', c('key'), null)),
      "key <> 'a' AND key <> 'b' AND key IS NOT NULL"],
    [b('OR', b('AND', key('a'), key('a'), key('a')), key('c'), b('AND', key('b'), key('zzz'))),
      b('OR', b('OR', b('AND', b('AND', key('a'), key('a')), key('a')), key('c')), b('AND', key('b'), key('zzz'))),
      "(key = 'a' AND key = 'a' AND key = 'a') OR key = 'c' OR (key = 'b' AND key = 'zzz')"],
  ])) {
    assert.deepEqual(rows(built), rows(nested), text);
    assert.deepEqual(rows(built), native(text), text);
  }
  // three-valued logic: every combination of true, false and NULL as SQLite reads `x AND y AND z`
  const truth = [1, 0, null];
  for (const op of /** @type {const} */ (['AND', 'OR'])) for (const x of truth) for (const y of truth) for (const z of truth)
    assert.equal(r.get({ columns: { v: b(op, x, y, z) } }).v, db.prepare(`SELECT ? ${op} ? ${op} ? AS v`).get([x, y, z]).v, `${x} ${op} ${y} ${op} ${z}`);
}));

it('a literal substring matches as text: sql.contains, LIKE with an ESCAPE, and instr', async () => fixture((db, r) => {
  const TITLES = ['a 100% b', 'a 1000 b', 'x100_y', 'a_b', 'aXb', 'A_B', 'Éa_b', 'éA_B'];
  db.exec('CREATE TABLE t(n INTEGER PRIMARY KEY, title TEXT)');
  for (const title of [...TITLES, null]) r.execute({ op: 'insert', table: 't', values: { title } });
  const t = c('title');
  const rows = (/** @type {any} */ where) => r.all({ from: 't', columns: { title: t }, where, orderBy: [{ by: c('n') }] }).map((row) => row.title);
  assert.deepEqual(rows(sql.contains(t, '100%')), ['a 100% b']);
  assert.deepEqual(rows(sql.contains(t, 'a_b')), ['a_b', 'Éa_b']);
  assert.deepEqual(rows(sql.contains(t, 'a_b', { caseInsensitive: true })), ['a_b', 'A_B', 'Éa_b', 'éA_B']);
  assert.deepEqual(rows(sql.contains(t, 'éa', { caseInsensitive: true })), ['éA_B'], 'only ASCII letters fold');
  // the oracle: a substring as JavaScript reads one, ASCII letters folded on request
  const ascii = (/** @type {string} */ s) => s.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
  for (const needle of ['', '%', '_', '100%', '%%', 'a_b', 'A_B', 'X', 'é', 'É', ' 1000 ', 'a 100% b!'])
    for (const caseInsensitive of [false, true])
      assert.deepEqual(rows(sql.contains(t, needle, { caseInsensitive })),
        TITLES.filter((title) => (caseInsensitive ? ascii(title).includes(ascii(needle)) : title.includes(needle))), `'${needle}' ${caseInsensitive}`);
  assert.deepEqual(planRelational({ columns: { v: sql.contains(t, 'x') } }).sql, 'SELECT (instr("title", ?) > 0) AS "v"');
  assert.deepEqual(planRelational({ columns: { v: sql.contains(t, 'x', { caseInsensitive: true }) } }).sql,
    'SELECT (instr(LOWER("title"), LOWER(?)) > 0) AS "v"');

  // without an escape `%` and `_` stay wildcards; with one they are text, and SQLite's LIKE folds ASCII letters
  assert.deepEqual(sql.like(t, '%100%%'), b('LIKE', t, '%100%%'));
  assert.deepEqual(sql.like(t, '%100%%', { negate: true }), b('NOT LIKE', t, '%100%%'));
  assert.deepEqual(rows(sql.like(t, '%100%%')), ['a 100% b', 'a 1000 b', 'x100_y']);
  assert.deepEqual(rows(sql.like(t, '%100!%%', { escape: '!' })), ['a 100% b']);
  assert.deepEqual(rows(sql.like(t, '%a!_b%', { escape: '!' })), ['a_b', 'A_B', 'Éa_b', 'éA_B']);
  assert.deepEqual(rows(sql.like(t, '%a!_b%', { escape: '!', negate: true })), ['a 100% b', 'a 1000 b', 'x100_y', 'aXb']);
  assert.deepEqual(rows(sql.like(t, '%a!', { escape: '!' })), [], 'a pattern ending in its escape matches nothing on SQLite');
  assert.deepEqual(planRelational({ from: 't', columns: { title: t }, where: sql.like(t, '%100!%%', { escape: '!' }) }),
    { sql: 'SELECT "title" AS "title" FROM "t" WHERE ("title" LIKE ? ESCAPE ?)', params: ['%100!%%', '!'], access: 'read' });
  assert.equal(r.get({ columns: { at: call('instr', ['a 100% b', '100%']) } }).at, 3);
  // schema expressions write the escape and the needle as literals
  const codes = planTable(defineTable({ name: 'codes', columns: [{ name: 'code', type: 'TEXT',
    check: b('AND', sql.like(c('code'), 'A!_%', { escape: '!' }), sql.contains(c('code'), '%', { caseInsensitive: true })) }] }));
  assert.match(codes.createSql[0], /CHECK \(\(\("code" LIKE 'A!_%' ESCAPE '!'\) AND \(instr\(LOWER\("code"\), LOWER\('%'\)\) > 0\)\)\)/);
  for (const text of codes.createSql) db.exec(text);
  r.execute({ op: 'insert', table: 'codes', values: { code: 'A_5%' } });
  for (const code of ['AB5%', 'A_5']) assert.throws(() => r.execute({ op: 'insert', table: 'codes', values: { code } }), /CHECK/, code);

  for (const [node, text] of /** @type {[any, string][]} */ ([
    [{ $sql: 'binary', op: '=', left: t, right: 'x', escape: '!' }, 'ESCAPE applies to LIKE and NOT LIKE only'],
    [sql.like(t, 'x', { escape: '' }), 'one character'],
    [sql.like(t, 'x', { escape: '!!' }), 'one character'],
    [sql.like(t, 'x', { escape: /** @type {any} */ (1) }), 'one character'],
    [sql.like(t, 'x', { escape: '\0' }), 'one character other than NUL'],
    [sql.contains(t, 'x', { caseInsensitive: /** @type {any} */ ('yes') }), 'caseInsensitive must be boolean'],
    [{ $sql: 'contains', value: t, text: 'x', nocase: true }, "unknown contains member 'nocase'"],
    [call(/** @type {any} */ ('strpos'), [t, 'x']), 'unsupported SQL function'],
  ])) assert.throws(() => planRelational({ columns: { v: node } }), refused(text), text);
  // the builders refuse an option they do not know rather than leave it out
  assert.throws(() => sql.like(t, 'x', /** @type {any} */ ({ escpae: '!' })), refused("unknown LIKE options member 'escpae'"));
  assert.throws(() => sql.like(t, 'x', /** @type {any} */ ({ negate: 'yes' })), refused('LIKE negate must be boolean'));
  assert.throws(() => sql.contains(t, 'x', /** @type {any} */ ({ nocase: true })), refused("unknown contains options member 'nocase'"));
}));
