//@ts-check
/**
 * `introspect({ triggers: sqliteTriggers })` reads a store-owned table's own
 * rule programs (`_jaren_rule_*`) back on SQLite as the database rules that
 * plan them: each program's checks read as candidate rules, kept only where
 * `planInvariants` over the derived model with them plans exactly the
 * programs the table holds. The oracle is a reopen of the model read back over
 * the same file, which verifies every program and refuses the writes the rules
 * refuse. A table whose programs read otherwise — a hand edit, a rule over a
 * column the derivation types otherwise, an assertion the reader does not read —
 * keeps every program an `unmapped-object` row, with its reason. PostgreSQL's
 * programs are not read back (MODEL-FORMAT §13.6).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { introspectModel, openStore, planInvariants, planMigration, sqliteDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { sqliteTriggers } from '@jarenjs/db/trigger-rules';

import { bookingModel } from './invariant-oracle.js';
import { removeTempDirectory } from './helpers.js';
import { PG_URL, withPostgres } from './store-core-engines.js';

const T = { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, n: { type: 'integer' },
  s: { type: 'string' }, x: { type: 'number' }, ref: { type: 'integer' } } };
const P = { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, status: { type: 'string' } } };
const RULES = [
  { name: 'pos', on: ['insert', 'update'], enforcement: 'database', assert: { $gt: ['$.new.n', 0] } },
  { name: 'str', on: ['update'], when: 'assigned', enforcement: 'database', assert: { $and: [{ $ne: ['$.new.s', ''] }, { $eq: ['$.old.s', 'a'] }] } },
  { name: 'ref', on: ['insert'], enforcement: 'database', assert: { '$exists-row': { entity: 'P', match: { id: '$.new.ref', status: 'open' } } } },
  { name: 'seq', on: ['insert'], enforcement: 'database', assert: { $eq: ['$.new.s', { $seq: ['a', 'b'] }] } },
  { name: 'num', on: ['insert'], enforcement: 'database', assert: { $or: [{ $le: ['$.new.x', 1.5] }, { $not: { $eq: ['$.new.s', 'z'] } }] } },
  { name: 'some', on: ['insert'], enforcement: 'database', assert: { $or: [{ $exists: '$.new.s' }, { $lt: ['$.new.n', -3] }] } },
  { name: 'dollar', on: ['insert'], enforcement: 'database', assert: { $ne: ['$.new.s', '$$x'] } },
  { name: 'kept', on: ['delete'], enforcement: 'database', assert: false },
];
/** @param {any[]} [rules] @param {any} [extra] */
const modelOf = (rules = RULES, extra = {}) => ({ $model: '0.1', entities: { P: { schema: P }, T: { schema: { ...T, properties: { ...T.properties, ...extra } }, invariants: rules } } });
/** The rules by name, each as declared: the order of two rules no program shares is not recorded. @param {any[]} rules */
const byName = (rules) => Object.fromEntries(rules.map((rule) => [rule.name, rule]));

/** A SQLite file of `model` in a fresh directory. @param {any} model @param {(file: string) => Promise<void>} fn */
async function withFile(model, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'jaren-db-store-rules-'));
  try {
    const file = join(dir, 'store.db');
    await (await openStore(model, { driver: nodeDriver(), path: file })).close();
    await fn(file);
  }
  finally { removeTempDirectory(dir); }
}
/** @param {string} file @param {any} [options] */
const introspected = async (file, options = { triggers: sqliteTriggers }) => {
  const connection = await nodeDriver().open(file, {});
  try { return await introspectModel(connection, options); }
  finally { await connection.close(); }
};
/** The report's unmapped programs, with their reasons. @param {any[]} report */
const unmappedPrograms = (report) => report.filter((row) => row.code === 'unmapped-object' && row.object.startsWith('_jaren_rule_'))
  .map((row) => [row.object, row.reason]);

describe('introspect() of a store-owned table\'s own rule programs on SQLite', () => {
  it('reads them back as the rules that plan them, and the model read back reopens the file and refuses what they refuse', async () => {
    for (const model of [modelOf(), bookingModel()]) {
      await withFile(model, async (file) => {
        const { model: derived, report } = await introspected(file);
        for (const [name, entity] of Object.entries(model.entities))
          assert.deepEqual(byName(derived.entities[name].invariants ?? []), byName(/** @type {any} */ (entity).invariants ?? []), name);
        assert.deepEqual(unmappedPrograms(report), []);
        // the same programs, and the rules judge writes on the reopened store
        assert.deepEqual(planInvariants(derived, { dialect: sqliteDialect }).map((item) => item.sql),
          planInvariants(model, { dialect: sqliteDialect }).map((item) => item.sql));
        assert.deepEqual(planMigration(derived, model, { dialect: sqliteDialect }).migration.steps.filter((/** @type {any} */ step) => step.kind === 'ddl'), []);
        const reopened = await openStore(derived, { driver: nodeDriver(), path: file });
        try {
          if (model.entities.T !== undefined) {
            await reopened.entity('P').create({ id: 1, status: 'open' });
            await reopened.entity('T').create({ id: 1, n: 1, s: 'a', ref: 1, x: 1 });
            await assert.rejects(reopened.entity('T').create({ id: 2, n: 0, s: 'a', ref: 1, x: 1 }), { code: 'JD2096', message: /jaren invariant:pos/ });
            await assert.rejects(reopened.entity('T').create({ id: 3, n: 1, s: 'a', ref: 9, x: 1 }), { code: 'JD2096', message: /jaren invariant:ref/ });
            await assert.rejects(reopened.entity('T').delete(1), { code: 'JD2096', message: /jaren invariant:kept/ });
          }
          else {
            await reopened.entity('Booking').create({ id: 'b', startsAt: 1, endsAt: 2, room: 'held' });
            await assert.rejects(reopened.entity('Booking').create({ id: 'c', startsAt: 3, endsAt: 2 }), { code: 'JD2096', message: /jaren invariant:ordered/ });
          }
        }
        finally { await reopened.close(); }
      });
    }
  });

  it('reads them back only through the triggers option', async () => {
    await withFile(modelOf(), async (file) => {
      const { model: derived, report } = await introspected(file, {});
      assert.equal(derived.entities.T.invariants, undefined);
      assert.deepEqual(unmappedPrograms(report).map(([object]) => object), ['_jaren_rule_1_T_delete', '_jaren_rule_1_T_insert', '_jaren_rule_1_T_update']);
    });
  });

  it('keeps every program of a table unmapped, with its reason, where one reads otherwise', async () => {
    const reason = (/** @type {string} */ why) => `the store names a declared rule's program so, and it is not read back as one: ${why}`;
    // a hand edit of one program; a formatting-only edit reads back, as the open opens it
    await withFile(modelOf(), async (file) => {
      const [insert] = planInvariants(modelOf(), { dialect: sqliteDialect });
      const raw = new DatabaseSync(file);
      try { raw.exec(`${/** @type {any} */ (insert).drop}; ${insert.sql.replace(' BEGIN ', '\n  BEGIN\n    ')}`); }
      finally { raw.close(); }
      assert.deepEqual(unmappedPrograms((await introspected(file)).report), []);
      const edited = new DatabaseSync(file);
      try { edited.exec(`${/** @type {any} */ (insert).drop}; ${insert.sql.replace('BEGIN', 'BEGIN SELECT 1;')}`); }
      finally { edited.close(); }
      const { model: derived, report } = await introspected(file);
      assert.equal(derived.entities.T.invariants, undefined);
      assert.deepEqual(unmappedPrograms(report).map(([, why]) => why), Array(3).fill(reason("'_jaren_rule_1_T_insert': a statement of its program is no "
        + 'check the rule lowering writes (a store-owned layout\'s rules write no row)')));
    });
    // a rule over a member the derivation types otherwise (a boolean column reads back as an integer one)
    const flag = [{ name: 'on', on: ['insert'], enforcement: 'database', assert: { $eq: ['$.new.b', true] } }];
    await withFile(modelOf(flag, { b: { type: 'boolean' } }), async (file) => {
      const { report } = await introspected(file);
      assert.deepEqual(unmappedPrograms(report), [['_jaren_rule_1_T_insert',
        reason('its programs are not the text the rules they read as plan (a hand edit, or a rule the reader reads otherwise)')]]);
    });
    // an assertion the reader does not read: arithmetic
    const sum = [{ name: 'sum', on: ['insert'], enforcement: 'database', assert: { $gt: [{ $add: ['$.new.n', 1] }, 0] } }];
    await withFile(modelOf(sum), async (file) => {
      const { report } = await introspected(file);
      assert.deepEqual(unmappedPrograms(report), [['_jaren_rule_1_T_insert', reason("'_jaren_rule_1_T_insert': the check of the rule 'sum' is not an assertion the reader reads")]]);
    });
  });
});

describe('introspect() of a store-owned table\'s rule programs on PostgreSQL', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, () => {
  it('keeps them unmapped-object rows: the reader reads SQLite programs only', () => withPostgres(async ({ driver }) => {
    const store = await openStore(modelOf(), { driver: driver() });
    try {
      const { model: derived, report } = await store.introspect({ triggers: sqliteTriggers });
      assert.equal(derived.entities.T.invariants, undefined);
      assert.deepEqual([...new Set(unmappedPrograms(report).map(([, why]) => why))], ['the reader reads SQLite trigger programs, and this engine\'s are not read back']);
    }
    finally { await store.close(); }
  }));
});
