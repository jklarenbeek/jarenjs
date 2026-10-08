//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEntities, openStore, planInvariants, sqliteDialect } from '@jarenjs/db';
import { postgresDialect } from '@jarenjs/db/postgres';
import { column, sqliteEngine, postgresEngine, openRefusal, createVerdicts } from './invariant-oracle.js';

const url = process.env.JAREN_PG_URL;
/** @param {string} name */
const col = (name) => ({ $sql: 'column', name });
const DIALECTS = /** @type {const} */ ([['sqlite', sqliteDialect], ['postgres', postgresDialect({ searchPath: 'tenant' })]]);
const ENGINES = /** @type {const} */ ([['sqlite', sqliteEngine, false], ['postgres', postgresEngine, !url && 'JAREN_PG_URL is not set']]);

/** The index over an order's code, as the model declares it. */
const ORDERS_CODE = { name: 'orders_code', unique: true, terms: [{ by: col('code') }] };
const BY_CODE = { '$exists-row': { entity: 'Order', match: { code: '$.new.sku' } } };

/**
 * Orders with a code, and lines that name their order by it: the probe is
 * keyed by the unique index over the code, not by the key.
 * @param {'database' | 'store'} enforcement @param {any[] | null} indexes the orders' declared indexes, `null` for none
 * @param {any} [assert] the rule
 */
const codedModel = (enforcement, indexes = [ORDERS_CODE], assert = BY_CODE) => ({ $model: '0.1', entities: {
  Order: { schema: { type: 'object', properties: {
    id: { type: 'integer', 'x-entity': { key: true } }, code: { type: 'string' }, status: { type: ['string', 'null'] } } },
  physical: { table: 'orders', columns: { id: column('id'), code: column('code', 'text'), status: column('status', 'text', 'null') },
    ...(indexes === null ? {} : { indexes }) } },
  Line: { schema: { type: 'object', properties: {
    id: { type: 'integer', 'x-entity': { key: true } }, order: { type: 'integer' }, sku: { type: 'string' } } },
  physical: { table: 'lines', columns: { id: column('id'), order: column('order_id'), sku: column('sku', 'text') } },
  invariants: [{ name: 'coded', on: ['insert', 'update'], enforcement, assert }] },
} });
const CODED_TABLES = {
  sqlite: 'CREATE TABLE orders(id INTEGER PRIMARY KEY, code TEXT NOT NULL, status TEXT); CREATE UNIQUE INDEX orders_code ON orders(code); '
    + 'CREATE TABLE lines(id INTEGER PRIMARY KEY, order_id INTEGER, sku TEXT)',
  postgres: 'CREATE TABLE orders(id integer PRIMARY KEY, code text NOT NULL, status text); CREATE UNIQUE INDEX orders_code ON orders(code); '
    + 'CREATE TABLE lines(id integer PRIMARY KEY, order_id integer, sku text)',
};

/** A layout the store owns, probed by a physical layout's rule: by its key, a unique member, and a unique entity index.
 * @param {any} match */
const hybridTarget = (match) => ({ $model: '0.1', entities: {
  Doc: { schema: { type: 'object', required: ['id', 'code', 'ref'], properties: {
    id: { type: 'string', 'x-entity': { key: true } }, code: { type: 'string', 'x-entity': { unique: true } }, ref: { type: 'string' },
    tag: { type: 'string' }, kind: { type: 'string' }, at: { type: 'string', format: 'date-time', 'x-entity': { column: 'integer' } } } },
  indexes: [{ name: 'by_ref', path: '$.ref', unique: true }, { name: 'by_tag', path: '$.tag', unique: true, where: { $eq: ['$.kind', 'x'] } },
    { name: 'by_kind', path: '$.kind' }] },
  Line: { schema: { type: 'object', properties: {
    id: { type: 'integer', 'x-entity': { key: true } }, doc: { type: 'string' } } },
  physical: { table: 'lines', columns: { id: column('id'), doc: column('doc', 'text') } },
  invariants: [{ name: 'parent', on: ['insert'], enforcement: 'database', assert: { '$exists-row': { entity: 'Doc', match } } }] },
} });
const HYBRID_TABLES = { sqlite: 'CREATE TABLE lines(id INTEGER PRIMARY KEY, doc TEXT)', postgres: 'CREATE TABLE lines(id integer PRIMARY KEY, doc text)' };

/** @param {any} model @param {any} expected */
const refusedEverywhere = (model, expected) => {
  assert.throws(() => normalizeEntities(model), expected);
  for (const [, dialect] of DIALECTS) assert.throws(() => planInvariants(model, { dialect }), expected);
};

describe('a probe keyed by a unique index', () => {
  it('is refused until the target declares a unique index over the matched members, naming what keys a probe', () => {
    refusedEverywhere(codedModel('database', null), { code: 'JD0005', message: /must match its key member 'id'.*unique index/s });
    refusedEverywhere(codedModel('database', [{ ...ORDERS_CODE, unique: false }]), { code: 'JD0005', message: /must match its key member 'id'/ });
    for (const [, dialect] of DIALECTS) assert.equal(planInvariants(codedModel('database'), { dialect }).length, dialect === sqliteDialect ? 2 : 4);
    assert.doesNotThrow(() => normalizeEntities(codedModel('store')));
    // a composite unique index keys a probe that matches every one of its columns, in any order, beside other members
    const composite = codedModel('database', [{ name: 'orders_code_status', unique: true, terms: [{ by: col('code') }, { by: col('status') }] }],
      { '$exists-row': { entity: 'Order', match: { status: 'open', code: '$.new.sku' } } });
    for (const [, dialect] of DIALECTS) assert.match(planInvariants(composite, { dialect })[0].sql, /"code" = NEW\."sku"/);
    const partial = codedModel('database', [{ name: 'orders_code_status', unique: true, terms: [{ by: col('code') }, { by: col('status') }] }],
      { '$exists-row': { entity: 'Order', match: { code: '$.new.sku' } } });
    refusedEverywhere(partial, { code: 'JD0005', message: /must match its key member 'id'/ });
  });

  it('refuses a null literal against a member the probe is keyed by: a key holds no null and a unique index admits any number of them', () => {
    for (const match of [{ code: null }, { code: { $const: null } }, { id: null }])
      refusedEverywhere(codedModel('database', [ORDERS_CODE], { '$exists-row': { entity: 'Order', match } }),
        { code: 'JD0005', docPath: '/entities/Line/invariants/0/assert', message: /keyed by, which matches a value, never null/ });
    // a member the probe is not keyed by still matches SQL NULL null-safely: beside the key, the code is one
    for (const match of [{ id: '$.new.order', status: null }, { id: '$.new.order', code: null }]) for (const [, dialect] of DIALECTS)
      assert.doesNotThrow(() => planInvariants(codedModel('database', [ORDERS_CODE], { '$exists-row': { entity: 'Order', match } }), { dialect }));
  });

  it('plans each model\'s probe from its own resolution when two models share one assert object and open concurrently', async () => {
    const shared = { '$exists-row': { entity: 'Order', match: { code: '$.new.sku' } } };
    const fixtures = [];
    try {
      const opens = [];
      for (const table of ['orders_a', 'orders_b']) {
        const model = /** @type {any} */ (codedModel('database', [ORDERS_CODE], shared));
        model.entities.Order.physical.table = table;
        const fixture = await sqliteEngine().fixture({ sqlite: `CREATE TABLE ${table}(id INTEGER PRIMARY KEY, code TEXT NOT NULL, status TEXT); `
          + `CREATE UNIQUE INDEX orders_code ON ${table}(code); CREATE TABLE lines(id INTEGER PRIMARY KEY, order_id INTEGER, sku TEXT)` });
        fixtures.push(fixture);
        for (const statement of planInvariants(model, { dialect: fixture.dialect })) await fixture.exec(statement.sql);
        opens.push([model, { driver: fixture.target.driver }]);
      }
      const stores = await Promise.all(opens.map(([model, options]) => openStore(model, options)));
      for (const store of stores) await store.close();
    }
    finally { for (const fixture of fixtures) await fixture.dispose(); }
  });

  it('is refused by a partial unique index, and by one with an expression term, naming the index', () => {
    const where = { $sql: 'in', value: col('status'), values: [{ $sql: 'value', value: 'open' }], negate: false };
    refusedEverywhere(codedModel('database', [{ ...ORDERS_CODE, where }]),
      { code: 'JD0005', docPath: '/entities/Line/invariants/0/assert', message: /unique index 'orders_code'.*condition.*never keys a probe/s });
    refusedEverywhere(codedModel('database', [{ ...ORDERS_CODE, terms: [{ by: { $sql: 'collate', value: col('code'), collation: 'NOCASE' } }] }]),
      { code: 'JD0005', docPath: '/entities/Line/invariants/0/assert', message: /unique index 'orders_code'.*expression term/s });
  });

  for (const [name, engine, skip] of ENGINES) {
    describe(`on ${name}`, { skip }, () => {
      for (const enforcement of /** @type {const} */ (['database', 'store'])) {
        it(`enforces the probe under ${enforcement} enforcement and verifies the index on every open`, async () => {
          const model = codedModel(enforcement);
          const fixture = await engine().fixture(CODED_TABLES);
          try {
            for (const statement of planInvariants(model, { dialect: fixture.dialect })) await fixture.exec(statement.sql);
            const options = { driver: fixture.target.driver };
            const store = await openStore(model, options);
            try {
              await store.entity('Order').create({ id: 1, code: 'A-1', status: 'open' });
              assert.deepEqual(await createVerdicts(store.entity('Line'), [{ id: 1, order: 1, sku: 'A-1' }, { id: 2, order: 1, sku: 'A-2' }]),
                ['ok', 'JD2096/constraint']);
              await assert.rejects(store.entity('Line').update(1, { sku: 'A-2' }), { code: 'JD2096' });
              // the store's probe reads what the write's own transaction holds
              await store.transaction(async (/** @type {any} */ tx) => {
                await tx.entity('Order').create({ id: 2, code: 'A-2', status: 'open' });
                await tx.entity('Line').update(1, { sku: 'A-2' });
              });
              assert.equal((await store.entity('Line').get(1)).sku, 'A-2');
            }
            finally { await store.close(); }
            const raw = fixture.exec("INSERT INTO lines(id, order_id, sku) VALUES (3, 1, 'A-9')");
            if (enforcement === 'database') await assert.rejects(raw, /jaren invariant:coded/);
            else await raw;
            await fixture.exec('DROP INDEX orders_code');
            assert.match((await openRefusal(model, options)).message, /index 'orders_code'/);
            await fixture.exec('CREATE INDEX orders_code ON orders(code)');
            assert.match((await openRefusal(model, options)).message, /index 'orders_code'/);
            await fixture.exec('DROP INDEX orders_code; CREATE UNIQUE INDEX orders_code ON orders(code, status)');
            assert.match((await openRefusal(model, options)).message, /index 'orders_code'/);
            await fixture.exec("DROP INDEX orders_code; CREATE UNIQUE INDEX orders_code ON orders(code) WHERE status = 'open'");
            assert.match((await openRefusal(model, options)).message, /index 'orders_code'/);
            await fixture.exec('DROP INDEX orders_code; CREATE UNIQUE INDEX orders_code ON orders(code)');
            assert.equal(await openRefusal(model, options), null);
          }
          finally { await fixture.dispose(); }
        });
      }

      it('reads a layout the store owns by its key, a unique member or a unique entity index, each verified at open', async () => {
        for (const [match, refused] of /** @type {const} */ ([
          [{ tag: '$.new.doc' }, /unique index 'by_tag'.*condition.*never keys a probe/s],
          [{ kind: '$.new.doc' }, /must match its key member 'id'/],
          [{ ref: null }, /'ref' reads SQL NULL as an absent member/],
          [{ at: '$.new.doc' }, /'at' holds an epoch/],
        ])) refusedEverywhere(hybridTarget(match), { code: 'JD0005', docPath: '/entities/Line/invariants/0/assert', message: refused });
        for (const [member, dropped] of /** @type {const} */ ([['id', null], ['code', 'Doc_code'], ['ref', 'Doc_by_ref']])) {
          const model = hybridTarget({ [member]: '$.new.doc' });
          const fixture = await engine().fixture(HYBRID_TABLES);
          try {
            // the physical table's programs name the store-owned table, which the open then creates
            for (const statement of planInvariants(model, { dialect: fixture.dialect })) await fixture.exec(statement.sql);
            const options = { driver: fixture.target.driver };
            const store = await openStore(model, options);
            try {
              await store.entity('Doc').create({ id: 'd1', code: 'c1', ref: 'r1', kind: 'x' });
              const value = { id: 'd1', code: 'c1', ref: 'r1' }[member];
              assert.deepEqual(await createVerdicts(store.entity('Line'), [{ id: 1, doc: value }, { id: 2, doc: 'nope' }]), ['ok', 'JD2096/constraint']);
              await assert.rejects(fixture.exec("INSERT INTO lines(id, doc) VALUES (3, 'nope')"), /jaren invariant:parent/);
            }
            finally { await store.close(); }
            if (dropped !== null) {
              await fixture.exec(`DROP INDEX "${dropped}"`);
              assert.equal((await openRefusal(model, options))?.code, 'JD0002');
            }
          }
          finally { await fixture.dispose(); }
        }
      });
    });
  }
});

describe('a physical layout verifies its declared indexes at open', () => {
  const SHIFT = (/** @type {any[]} */ indexes, kind = 'table') => ({ $model: '0.1', entities: { Shift: {
    schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } }, employeeId: { type: 'string' }, day: { type: 'string' }, status: { type: 'string' } } },
    physical: { table: 'shift', kind, columns: { id: column('id', 'text'), employeeId: column('employee_id', 'text'), day: column('day', 'text'), status: column('status', 'text') },
      indexes } } } });
  const PARTIAL = { name: 'shift_one_active', unique: true, terms: [{ by: col('employee_id') }, { by: col('day') }],
    where: { $sql: 'in', value: col('status'), values: [{ $sql: 'value', value: 'active' }, { $sql: 'value', value: 'pending' }], negate: false } };
  const PLAIN = { name: 'shift_day', terms: [{ by: col('day') }] };
  /** Orders with a code, declared over an existing table whose index the application created. @param {any[]} indexes */
  const ordersLayout = (indexes) => ({ $model: '0.1', entities: { Order: { schema: { type: 'object', properties: {
    id: { type: 'integer', 'x-entity': { key: true } }, code: { type: 'string' }, status: { type: ['string', 'null'] } } },
  physical: { table: 'orders', columns: { id: column('id'), code: column('code', 'text'), status: column('status', 'text', 'null') }, indexes } } } });
  const PLAIN_ORDERS = { name: 'orders_code', unique: true, terms: [{ by: col('code') }] };
  const OPEN = { $sql: 'in', value: col('status'), values: [{ $sql: 'value', value: 'open' }], negate: false };
  const ORDERS_TABLE = { sqlite: 'CREATE TABLE orders(id INTEGER PRIMARY KEY, code TEXT NOT NULL, status TEXT)',
    postgres: 'CREATE TABLE orders(id integer PRIMARY KEY, code text NOT NULL, status text)' };
  const SHIFT_TABLES = {
    sqlite: 'CREATE TABLE shift(id TEXT PRIMARY KEY, employee_id TEXT, day TEXT, status TEXT); CREATE INDEX shift_day ON shift(day); '
      + 'CREATE UNIQUE INDEX "shift_one_active" ON "shift" ("employee_id", "day") WHERE ("status" IN (\'active\', \'pending\'))',
    postgres: 'CREATE TABLE shift(id text PRIMARY KEY, employee_id text, day text, status text); CREATE INDEX shift_day ON shift(day); '
      + "CREATE UNIQUE INDEX shift_one_active ON shift(employee_id, day) WHERE status IN ('active', 'pending')",
  };

  it('refuses indexes on a view, and on a layout that names its PostgreSQL schema', () => {
    assert.throws(() => normalizeEntities(SHIFT([PLAIN], 'view')), { code: 'JD0005', docPath: '/entities/Shift/physical', message: /view/ });
    const named = /** @type {any} */ (SHIFT([PLAIN]));
    named.entities.Shift.physical.schema = 'tenant';
    assert.throws(() => normalizeEntities(named), { code: 'JD0005', docPath: '/entities/Shift/physical', message: /native programs require a reviewed migration/ });
  });

  /** An adopted index as the application created it, and the verdict the declared layout meets. */
  const ADOPTED = {
    sqlite: [
      ['plain, unquoted', 'CREATE UNIQUE INDEX orders_code ON orders(code)', PLAIN_ORDERS, null],
      ['plain, named in another ASCII case, which SQLite folds', 'CREATE UNIQUE INDEX Orders_Code ON orders(code)', PLAIN_ORDERS, null],
      ['plain declared, the column collated in the index', 'CREATE UNIQUE INDEX orders_code ON orders(code COLLATE NOCASE)', PLAIN_ORDERS, null],
      ['plain declared, a DESC term in the index', 'CREATE UNIQUE INDEX orders_code ON orders(code DESC)', PLAIN_ORDERS, null],
      ['declared desc, the index ascending', 'CREATE UNIQUE INDEX orders_code ON orders(code)', { ...PLAIN_ORDERS, terms: [{ by: col('code'), direction: 'desc' }] }, null],
      ['a condition written by hand with another operator', "CREATE UNIQUE INDEX orders_code ON orders(code) WHERE status = 'open'", { ...PLAIN_ORDERS, where: OPEN }, /is declared as/],
      ['a condition as the store plans it', 'CREATE UNIQUE INDEX "orders_code" ON "orders" ("code") WHERE ("status" IN (\'open\'))', { ...PLAIN_ORDERS, where: OPEN }, null],
      ['the same condition in the application\'s spelling', "CREATE UNIQUE INDEX orders_code ON orders(code) WHERE status IN ('open')", { ...PLAIN_ORDERS, where: OPEN }, null],
      ['the same condition in another case, spacing and quoting', 'create unique index Orders_Code on ORDERS ( "Code" ) where ( Status in(\'open\') )', { ...PLAIN_ORDERS, where: OPEN }, null],
      ['the same condition in bracket and backtick quoting', "CREATE UNIQUE INDEX orders_code ON orders([code]) WHERE `status` IN ('open')", { ...PLAIN_ORDERS, where: OPEN }, null],
      ['an expression term in the application\'s spelling', 'CREATE INDEX orders_code ON orders(lower(code))', { name: 'orders_code', terms: [{ by: { $sql: 'call', name: 'lower', args: [col('code')] } }] }, null],
      ['an expression term over another function', 'CREATE INDEX orders_code ON orders(upper(code))', { name: 'orders_code', terms: [{ by: { $sql: 'call', name: 'lower', args: [col('code')] } }] }, /is declared as/],
      ['a condition over another list', "CREATE UNIQUE INDEX orders_code ON orders(code) WHERE status IN ('open', 'held')", { ...PLAIN_ORDERS, where: OPEN }, /is declared as/],
      ['a condition over another column', "CREATE UNIQUE INDEX orders_code ON orders(code) WHERE code IN ('open')", { ...PLAIN_ORDERS, where: OPEN }, /is declared as/],
      ['a condition over another literal case', "CREATE UNIQUE INDEX orders_code ON orders(code) WHERE status IN ('Open')", { ...PLAIN_ORDERS, where: OPEN }, /is declared as/],
      ['a unique table constraint, whose index the engine names', null, PLAIN_ORDERS, /is missing/],
    ],
    postgres: [
      ['plain', 'CREATE UNIQUE INDEX orders_code ON orders(code)', PLAIN_ORDERS, null],
      ['an INCLUDE column beside the key', 'CREATE UNIQUE INDEX orders_code ON orders(code) INCLUDE (status)', PLAIN_ORDERS, null],
      ['an operator class', 'CREATE UNIQUE INDEX orders_code ON orders(code text_pattern_ops)', PLAIN_ORDERS, null],
      ['a collated term', 'CREATE UNIQUE INDEX orders_code ON orders(code COLLATE "C")', PLAIN_ORDERS, null],
      ['a DESC term', 'CREATE UNIQUE INDEX orders_code ON orders(code DESC)', PLAIN_ORDERS, null],
      ['NULLS NOT DISTINCT', 'CREATE UNIQUE INDEX orders_code ON orders(code) NULLS NOT DISTINCT', PLAIN_ORDERS, null],
      ['a unique constraint', 'ALTER TABLE orders ADD CONSTRAINT orders_code UNIQUE (code)', PLAIN_ORDERS, null],
      ['a hash index under a plain non-unique declaration', 'CREATE INDEX orders_code ON orders USING hash (code)', { ...PLAIN_ORDERS, unique: false }, null],
      ['a quoted name in another case, which PostgreSQL keeps apart', 'CREATE UNIQUE INDEX "Orders_Code" ON orders(code)', PLAIN_ORDERS, /is missing/],
      ['a condition with another text, which the shape does not see', "CREATE UNIQUE INDEX orders_code ON orders(code) WHERE status = 'open'", { ...PLAIN_ORDERS, where: OPEN }, null],
      ['an expression under a plain declaration', 'CREATE UNIQUE INDEX orders_code ON orders(lower(code))', PLAIN_ORDERS, /covers \(<expression>\)/],
      ['INCLUDE columns under a composite declaration', 'CREATE UNIQUE INDEX orders_code ON orders(code, status) INCLUDE (id)',
        { ...PLAIN_ORDERS, terms: [{ by: col('code') }, { by: col('status') }] }, null],
      ['a key column moved into INCLUDE', 'CREATE UNIQUE INDEX orders_code ON orders(code) INCLUDE (status)',
        { ...PLAIN_ORDERS, terms: [{ by: col('code') }, { by: col('status') }] }, /covers \(code\) in that order/],
    ],
  };
  for (const [name, engine, skip] of ENGINES) {
    it(`on ${name}: an adopted index opens as the application created it, where its shape is the declared one`, { skip }, async () => {
      for (const [label, ddl, index, refused] of ADOPTED[name]) {
        const tables = ddl === null
          ? 'CREATE TABLE orders(id INTEGER PRIMARY KEY, code TEXT NOT NULL, status TEXT, CONSTRAINT orders_code UNIQUE (code))'
          : `${ORDERS_TABLE[name]}; ${ddl}`;
        const fixture = await engine().fixture({ [name]: tables });
        try {
          const error = await openRefusal(ordersLayout([index]), { driver: fixture.target.driver });
          if (refused === null) assert.equal(error, null, `${label}: ${error?.message}`);
          else assert.match(error?.message ?? 'opened', refused, label);
        }
        finally { await fixture.dispose(); }
      }
    });

    it(`on ${name}: a dropped, renamed, re-shaped or re-conditioned index is JD0002, an undeclared one a fact`, { skip }, async () => {
      const fixture = await engine().fixture(SHIFT_TABLES);
      try {
        const options = { driver: fixture.target.driver };
        const model = SHIFT([PARTIAL, PLAIN]);
        assert.equal(await openRefusal(model, options), null);
        await fixture.exec('CREATE INDEX shift_status ON shift(status)');
        assert.equal(await openRefusal(model, options), null, 'an undeclared index is a fact');
        await fixture.exec('DROP INDEX shift_day');
        assert.match((await openRefusal(model, options)).message, /^JD0002: physical 'shift': index 'shift_day' is missing/);
        await fixture.exec('CREATE UNIQUE INDEX shift_day ON shift(day)');
        assert.match((await openRefusal(model, options)).message, /index 'shift_day' is unique/);
        await fixture.exec('DROP INDEX shift_day; CREATE INDEX shift_day ON shift(employee_id)');
        assert.match((await openRefusal(model, options)).message, /index 'shift_day' covers \(employee_id\)/);
        await fixture.exec('DROP INDEX shift_day; CREATE INDEX shift_day ON shift(day) WHERE status IS NOT NULL');
        assert.match((await openRefusal(model, options)).message, /index 'shift_day' has a condition/);
        await fixture.exec('DROP INDEX shift_day; CREATE INDEX shift_day ON shift(day)');
        assert.equal(await openRefusal(model, options), null);
        await fixture.exec("DROP INDEX shift_one_active; CREATE UNIQUE INDEX shift_one_active ON shift(employee_id, day) WHERE status IN ('active')");
        const changed = await openRefusal(model, options);
        // the condition's text is what SQLite keeps; PostgreSQL verifies the index's shape, which a changed condition leaves
        if (name === 'sqlite') assert.match(changed.message, /index 'shift_one_active' is declared as/);
        else assert.equal(changed, null);
        await fixture.exec('DROP INDEX shift_one_active; CREATE UNIQUE INDEX shift_one_active ON shift(employee_id, day)');
        assert.match((await openRefusal(model, options)).message, /index 'shift_one_active' has no condition/);
      }
      finally { await fixture.dispose(); }
    });
  }
});
