//@ts-check
/**
 * @file Member paths outside ASCII identifiers: a member named `日本`, `é`,
 * `123`, `a b`, or holding a quote, a bracket, a backslash or SQL, written in
 * the bracket spelling (`$['日本']`, RFC 9535 escapes), in an entity index, an
 * index condition, a collection index condition and a database rule operand,
 * on SQLite. Each answers as its ASCII-named twin and as the query engine
 * does over the record as stored; the DDL quotes every name as an
 * identifier; introspection reads the indexes back to the same model. The
 * PostgreSQL half is `postgres-member-paths.test.js`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { explainMapping, openStore, planEntity, planInvariants, planMigration, sqliteDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDialect } from '@jarenjs/db/postgres';
import { memberNames, modelPath, readModelPath } from '../../packages/db/src/model-path.js';
import { ODD_NAMES, ODD_NAME_VERDICTS, PATH_MEMBERS, SCENARIO_NAMES, SHIFT_NAMES, SHIFT_ROWS, SHIFT_VERDICTS, TRUTH_NAMES, TRUTH_POLICIES, UNIQUE_NAMES, bracketed,
  createVerdicts, familyModel, hybridTruthTable, memberPathScenario, oddNameVerdicts, oddNamesModel, renameKeys, ruleModel, ruleTruthTable, shiftModelOf, sqliteEngine,
  uniquenessAgreement, uniquenessModelOf } from './invariant-oracle.js';
import { tempDbPath } from './helpers.js';

/** The statements that create an entity's table and indexes. @param {any} model @param {string} [name] */
const createSqlOf = (model, name = 'E') => {
  const mapping = explainMapping(model);
  return planEntity(name, mapping.entities[name], mapping, sqliteDialect).createSql;
};

/** Every schema object one SQLite file holds. @param {string} path */
function schemaOf(path) {
  const db = new DatabaseSync(path);
  try { return db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(); }
  finally { db.close(); }
}

describe('a member path read through the query language\'s path grammar', () => {
  it('reads each name in the bracket spelling, either quote, and as the model writes it back', () => {
    for (const name of ODD_NAMES) {
      assert.deepEqual(memberNames(bracketed('$', name)), [name], bracketed('$', name));
      assert.deepEqual(memberNames(modelPath([{ name }])), [name], modelPath([{ name }]));
      assert.deepEqual(memberNames(bracketed('$.new', name)), ['new', name]);
    }
    assert.equal(modelPath([{ name: 'x"); DROP TABLE "U0"; --' }]), '$["x\\"); DROP TABLE \\"U0\\"; --"]');
    assert.deepEqual(memberNames('$["a b"]'), ['a b']);
    assert.deepEqual(memberNames('$.日本'), ['日本']);
    assert.deepEqual(memberNames("$['new'].x"), ['new', 'x']);
    assert.deepEqual(memberNames('$.a.b'), ['a', 'b']);
  });

  it('reads no member from an index, a wildcard, a variable, an escaped literal or text that is no path', () => {
    for (const text of ['$[0]', '$.a[0]', '$.a[*]', "$['a','b']", '$..a', '$', '$x', '$$a', 'a', "$['a'", '$.a.length()', '$.123', 7, null])
      assert.equal(memberNames(text), null, String(text));
    assert.deepEqual(['$..a', '$x', '$', "$['a'"].map((path) => /** @type {any} */ (readModelPath(path)).refused), ['singular', 'root', 'root', 'invalid']);
    assert.deepEqual(readModelPath("$.a[-1]['b c']"), { segments: [{ name: 'a' }, { index: -1 }, { name: 'b c' }] });
  });
});

describe('an entity index and its condition over members outside ASCII identifiers (SQLite)', () => {
  it('refuse exactly the rows the ASCII-named twin refuses, as the query engine judges them, for every condition', async () => {
    const ascii = await openStore(uniquenessModelOf(), { driver: nodeDriver(), path: ':memory:' });
    const renamed = await openStore(uniquenessModelOf(UNIQUE_NAMES), { driver: nodeDriver(), path: ':memory:' });
    try {
      const twins = await uniquenessAgreement(ascii);
      const agreed = await uniquenessAgreement(renamed, UNIQUE_NAMES);
      assert.equal(agreed.length, 13);
      for (const [at, { where, expected, actual, judged, stored }] of agreed.entries()) {
        assert.deepEqual(actual, expected, JSON.stringify(where));
        assert.deepEqual(expected, twins[at].expected, JSON.stringify(where));
        assert.deepEqual(stored, judged, JSON.stringify(where));
      }
      assert.equal(agreed.flatMap((row) => row.actual).filter((verdict) => verdict !== 'ok').length,
        twins.flatMap((row) => row.actual).filter((verdict) => verdict !== 'ok').length);
    }
    finally { await ascii.close(); await renamed.close(); }
  });

  it('quotes every name as an identifier, creates no other object, and reopens clean', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const model = uniquenessModelOf(UNIQUE_NAMES);
      await (await openStore(model, { driver: nodeDriver(), path: dbPath })).close();
      await (await openStore(model, { driver: nodeDriver(), path: dbPath })).close();
      const objects = schemaOf(dbPath);
      assert.deepEqual(objects.filter((object) => object.type === 'table').map((object) => object.name).sort(),
        ['U0', 'U1', 'U10', 'U11', 'U12', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7', 'U8', 'U9']);
      assert.equal(objects.find((object) => object.name === 'U0_one')?.sql,
        'CREATE UNIQUE INDEX "U0_one" ON "U0" ("日本", "x""); DROP TABLE ""U0""; --") WHERE "it\'s ""a]b"" \\ c" IN (\'active\', \'pending\')');
      // every index is its ASCII twin's, each name quoted as an identifier where the twin's is
      const twin = tempDbPath();
      try {
        await (await openStore(uniquenessModelOf(), { driver: nodeDriver(), path: twin.dbPath })).close();
        const quoted = (/** @type {string} */ name) => `"${name.replaceAll('"', '""')}"`;
        const renamed = (/** @type {string} */ sql) => Object.entries(UNIQUE_NAMES).reduce((text, [from, to]) => text.replaceAll(quoted(from), quoted(to)), sql);
        const indexes = (/** @type {any[]} */ all) => all.filter((object) => object.type === 'index').map((object) => [object.name, object.sql]);
        assert.deepEqual(indexes(objects), indexes(schemaOf(twin.dbPath)).map(([name, sql]) => [name, renamed(sql)]));
        assert.equal(indexes(objects).length, 13);
      }
      finally { twin.cleanup(); }
    }
    finally { cleanup(); }
  });

  it('every name takes a unique index, its condition and a database rule, through a reopen', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      await (await openStore(oddNamesModel(), { driver: nodeDriver(), path: dbPath })).close();
      const store = await openStore(oddNamesModel(), { driver: nodeDriver(), path: dbPath });
      try { assert.deepEqual(await oddNameVerdicts(store), ODD_NAMES.map(() => ODD_NAME_VERDICTS)); }
      finally { await store.close(); }
      assert.equal(schemaOf(dbPath).filter((object) => object.type === 'index').length, ODD_NAMES.length);
    }
    finally { cleanup(); }
  });

  it('a member named op reads its column in a condition; without one, $.op is still a rule\'s operation', () => {
    const schema = { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } }, op: { type: 'string' }, k: { type: 'string' } } };
    const where = { $eq: ['$.op', 'x'] };
    for (const path of ['$.op', "$['op']"]) {
      const model = { $model: '0.1', entities: { E: { schema, indexes: [{ name: 'k', path: '$.k', where: { $eq: [path, 'x'] } }] } } };
      assert.equal(createSqlOf(model).at(-1), 'CREATE INDEX "E_k" ON "E" ("k") WHERE "op" = \'x\'', path);
    }
    const without = { $model: '0.1', entities: { E: { schema: { ...schema, properties: { id: schema.properties.id, k: schema.properties.k } },
      indexes: [{ name: 'k', path: '$.k', where }] } } };
    assert.throws(() => createSqlOf(without),
      { code: 'JD0004', message: /'\$\.op' is a rule's operation; an index condition reads \$\.<member>/ });
    for (const path of ["$['new'].k", '$["old"]["k"]', '$.new.k']) {
      const record = { $model: '0.1', entities: { E: { schema, indexes: [{ name: 'k', path: '$.k', where: { $eq: [path, 'x'] } }] } } };
      assert.throws(() => createSqlOf(record), { code: 'JD0004', message: /reads a rule's record; an index condition reads \$\.<member> or \$\['<member>'\]/ }, path);
    }
  });

  it('a collection index condition reads a member the collection indexes by its bracketed path', async () => {
    const model = { $model: '0.1', collections: { c: { identity: 'uuid', schema: { type: 'object', properties: { '日本': { type: 'string' }, k: { type: 'string' } } },
      indexes: [{ name: 'by_jp', path: "$['日本']" }, { name: 'one_k', path: '$.k', unique: true, where: { $eq: ["$['日本']", 'x'] } }] } } };
    const store = await openStore(model, { driver: nodeDriver(), path: ':memory:' });
    try {
      const c = store.collection('c');
      const verdicts = [];
      for (const doc of [{ '日本': 'x', k: 'a' }, { '日本': 'x', k: 'a' }, { '日本': 'y', k: 'a' }, { k: 'a' }]) {
        try { await c.insert(doc); verdicts.push('ok'); }
        catch (error) { verdicts.push(/** @type {any} */ (error).code); }
      }
      assert.deepEqual(verdicts, ['ok', 'JD2005', 'ok', 'ok']);
    }
    finally { await store.close(); }
    const unindexed = structuredClone(model);
    unindexed.collections.c.indexes.shift();
    await assert.rejects(openStore(unindexed, { driver: nodeDriver(), path: ':memory:' }),
      { code: 'JD0004', message: /'日本' has no generated column: an index condition reads a member the collection indexes by its path — index '\$\["日本"\]' first/ });
  });

  it('every shape that is not one member keeps its refusal', () => {
    for (const path of ['$.a.b', "$['a']['b']", '$[0]', '$.a[*]', '$x', "$['a'"]) {
      const model = { $model: '0.1', entities: { E: { schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } },
        a: { type: 'object' } } }, indexes: [{ name: 'i', path }] } } };
      assert.throws(() => createSqlOf(model),
        { code: 'JD0004', docPath: '/entities/E/indexes/0/path', message: /is not one member written \$\.<member> or \$\['<member>'\]/ }, path);
    }
    const document = { $model: '0.1', entities: { E: { schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } },
      'a b': { type: 'object' } } }, indexes: [{ name: 'i', path: "$['a b']" }] } } };
    assert.throws(() => createSqlOf(document),
      { code: 'JD0004', message: /the index path '\$\["a b"\]' reads 'a b', which the entity's document holds/ });
  });

  it('introspection reads the index back in the model\'s spelling, and the derived model reopens the database', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const flagged = shiftModelOf(SHIFT_NAMES);
      flagged.entities.Shift.schema.properties['従業員'] = { type: 'string', 'x-entity': { index: true } };
      flagged.entities.Shift.indexes.push({ name: 'by_day', path: "$['a b']" });
      const store = await openStore(flagged, { driver: nodeDriver(), path: dbPath });
      const { model: derived, report } = await store.introspect();
      await store.close();
      assert.deepEqual(derived.entities.Shift.indexes, [{ name: 'by_day', path: '$["a b"]' },
        { name: 'one_active', path: ['$["従業員"]', '$["a b"]'], unique: true, where: { $eq: ['$["x\\"]\\\\\'"]', { $seq: ['active', 'pending'] }] } }]);
      assert.deepEqual(derived.entities.Shift.schema.properties['従業員'], { type: 'string', 'x-entity': { index: true } });
      assert.deepEqual(report.filter((row) => row.code === 'unmapped-index'), []);
      const back = planMigration(derived, flagged, { dialect: sqliteDialect });
      assert.deepEqual(back.migration.steps.map((step) => `${step.kind}${step.draft === true ? ' (draft)' : ''}`), ['jslt (draft)']);
      const reopened = await openStore(derived, { driver: nodeDriver(), path: dbPath });
      try { assert.deepEqual(await createVerdicts(reopened.entity('Shift'), SHIFT_ROWS.map((row) => renameKeys(row, SHIFT_NAMES))), SHIFT_VERDICTS); }
      finally { await reopened.close(); }
    }
    finally { cleanup(); }
  });

  it('introspection places the type of a member an expression index reads, a bracket in its name included', async () => {
    const lower = { lower: { arity: 1, deterministic: true, apply: (/** @type {any} */ value) => String(value).toLowerCase(), sql: 'lower' } };
    const model = { $model: '0.1', collections: { users: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' },
      'x]y': { type: 'string' } } }, key: '/id', indexes: [{ name: 'by', expression: { call: 'lower', args: [{ member: "$['x]y']" }] } }] } } };
    const store = await openStore(model, { driver: nodeDriver(), path: ':memory:', expressions: lower });
    try {
      const { model: derived } = await store.introspect({ keys: { users: '/id' }, expressions: lower });
      assert.deepEqual(derived.collections.users.schema.properties, { id: { type: 'string' }, 'x]y': {} });
      assert.deepEqual(derived.collections.users.indexes, [{ name: 'by', expression: { call: 'lower', args: [{ member: '$["x]y"]' }] } }]);
    }
    finally { await store.close(); }
  });
});

describe('a rule operand over members outside ASCII identifiers (SQLite)', () => {
  it('a database rule on an explicit layout accepts exactly what its ASCII twin accepts, as the query engine does, under every null policy', async () => {
    for (const policy of Object.values(TRUTH_POLICIES))
      assert.equal(await ruleTruthTable(sqliteEngine(), policy, TRUTH_NAMES), await ruleTruthTable(sqliteEngine(), policy), JSON.stringify(policy));
  });

  it('a database rule on a store-owned layout judges the store and a raw writer as its ASCII twin does, its columns quoted', async () => {
    assert.equal(await hybridTruthTable(sqliteEngine(), TRUTH_NAMES), await hybridTruthTable(sqliteEngine()));
    const model = { $model: '0.1', entities: { Row: { schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } },
      [TRUTH_NAMES.a]: { type: 'integer' } } }, invariants: [{ name: 'truth', on: ['insert'], enforcement: 'database',
      assert: { $ge: [bracketed('$.new', TRUTH_NAMES.a), 0] } }] } } };
    assert.match(planInvariants(model, { dialect: sqliteDialect })[0].sql, /NEW\."a b"/);
  });

  it('a probe, a delete rule and a sum answer as their ASCII twins do, whether the store or the database enforces them', async () => {
    const expected = {
      store: '{"writes":["ok","refused open_parent","refused open_parent","ok","refused bounded","refused kept","ok","ok"],"lines":[null,null,null,null,null]}',
      database: '{"writes":["ok","refused open_parent","refused open_parent","ok","refused bounded","refused kept","ok","ok","refused open_parent","ok",'
        + '"refused kept","refused bounded"],"lines":[null,null,null,null,{"id":6,"doc":1,"note":"held"}]}',
    };
    for (const enforcement of /** @type {const} */ (['store', 'database'])) {
      assert.equal(await memberPathScenario(sqliteEngine(), enforcement, PATH_MEMBERS), expected[enforcement], enforcement);
      assert.equal(await memberPathScenario(sqliteEngine(), enforcement, SCENARIO_NAMES), expected[enforcement], enforcement);
    }
  });

  it('every spelling of a record path is one path: an incremented member, an epoch member and a rounding audit are refused in each', () => {
    for (const path of ['$.new.revision', "$.new['revision']", "$['new']['revision']", '$["new"].revision']) {
      const spec = /** @type {any} */ (familyModel('database'));
      spec.entities.Line.invariants[0].assert = { $gt: [path, 0] };
      assert.throws(() => planInvariants(spec, { dialect: sqliteDialect }),
        { code: 'JD0005', message: /'revision' is incremented by the database: an update rule cannot read \$\.new\.revision/ }, path);
    }
    for (const path of ['$.new.at', "$.new['at']", "$['new']['at']"]) {
      const model = { $model: '0.1', entities: { E: { schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } },
        at: { type: 'string', format: 'date-time', 'x-entity': { column: 'integer' } } } },
      invariants: [{ name: 'r', on: ['insert'], enforcement: 'database', assert: { $gt: [path, '2020-01-01T00:00:00Z'] } }] } } };
      assert.throws(() => planInvariants(model, { dialect: sqliteDialect }), { code: 'JD0005', message: /'at' holds an epoch \(milliseconds\) in its column/ }, path);
    }
    const rounding = /** @type {any} */ (structuredClone(ruleModel));
    rounding.entities.Entry.schema.properties.ratio = { type: 'number' };
    rounding.entities.Entry.physical.columns.ratio = { name: 'ratio', codec: 'number', null: 'reject' };
    for (const path of ['$.new.ratio', "$.new['ratio']", "$['new']['ratio']"]) {
      rounding.entities.Entry.invariants[0].audit.values.entry = path;
      assert.throws(() => planInvariants(rounding, { dialect: postgresDialect({ searchPath: 'tenant' }) }), { code: 'JD0005', message: /would round/ }, path);
    }
  });
});
