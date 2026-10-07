//@ts-check
/**
 * @file The model document is a closed vocabulary, and the canonical schema
 * and the runtime agree on it (MODEL-FORMAT §2, §9, §13).
 *
 * An unknown member of the root, a collection, an index, an entity or an
 * invariant is `JD0005` at the member itself, naming the declaration's
 * members and the nearest one — before any DDL, so a misspelt `unique` can no
 * longer open a store with no unique index. The boolean members are booleans.
 * The schema admits what the runtime admits: an invariant's `when`, `columns`
 * and `effects`. A rule no layer would enforce is refused rather than
 * declared: a database rule on a store-owned layout, and a relation to an
 * entity with a physical layout, which no include could navigate. A rule
 * whose assert does not compile, a database rule on a view and an audit into
 * no writable table are refused at the rule's member as well.
 *
 * The PostgreSQL half runs where `JAREN_PG_URL` names a server.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openStore, normalizeModel, normalizeEntities, planInvariants, sqliteDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { validateFile } from '@jarenjs/studio';
import { compileArtifact } from '../json/schema-artifact-helpers.js';
import { tempDbPath } from './helpers.js';
import { ENGINES, skipFor, withStore, withPostgres } from './store-core-engines.js';

const read = (/** @type {string} */ name) => JSON.parse(readFileSync(new URL(`../../packages/db/schemas/${name}`, import.meta.url), 'utf8'));
const SCHEMAS = { '2020-12': compileArtifact(read('jaren-model.schema.json')), 'draft-07': compileArtifact(read('jaren-model.draft-07.schema.json')) };

/** The runtime's verdict on a model: `accepted`, or the code and the docPath it refuses with. @param {any} model */
const runtime = (model) => {
  try {
    normalizeModel(model);
    normalizeEntities(model);
    return 'accepted';
  }
  catch (/** @type {any} */ error) { return `${error.code} ${error.docPath}`; }
};
/** Run `fn` a turn later, so a synchronous throw arrives as a rejection. @param {() => any} fn */
const later = (fn) => Promise.resolve().then(fn);
/**
 * Assert that an open refuses as `expected`, closing a store that opened
 * anyway so a failing assertion never keeps its connection.
 * @param {() => Promise<any>} open @param {any} expected
 */
async function refusesToOpen(open, expected) {
  /** @type {any} */
  let opened;
  try { await assert.rejects(later(async () => { opened = await open(); }), expected); }
  finally { await opened?.close(); }
}

const COLLECTION = { schema: { type: 'object' }, key: '/id' };
const KEYED = { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } }, n: { type: 'integer' } } };
const collectionModel = (/** @type {any} */ collection) => ({ $model: '0.1', collections: { c: collection } });
const entityModel = (/** @type {any} */ entity) => ({ $model: '0.1', entities: { E: entity } });
const column = (/** @type {string} */ name, codec = 'integer') => ({ name, codec, null: 'reject' });
/** A physical entity with one rule. @param {any} rule */
const physicalRule = (rule) => entityModel({
  schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, n: { type: 'integer' }, rev: { type: 'integer' } } },
  physical: { table: 'entry', columns: { id: column('id'), n: column('n'), rev: column('rev') } },
  invariants: [rule],
});
const storeRule = { name: 'positive', on: ['insert'], enforcement: 'store', assert: { $gt: ['$.new.n', 0] } };

/** Each refused member, at its own docPath, by the runtime and by both schema drafts. */
const REFUSED = [
  ['an unknown root member', { ...collectionModel(COLLECTION), bogus: 1 }, '/bogus'],
  ['$schema at the root', { $schema: 'https://jarenjs.dev/schemas/jaren-model', ...collectionModel(COLLECTION) }, '/$schema'],
  ['an unknown collection member', collectionModel({ ...COLLECTION, bogus: 1 }), '/collections/c/bogus'],
  ['an unknown index member', collectionModel({ ...COLLECTION, indexes: [{ name: 'a', path: '$.a', bogus: 1 }] }), '/collections/c/indexes/0/bogus'],
  ['a misspelt unique', collectionModel({ ...COLLECTION, indexes: [{ name: 'a', path: '$.a', uniqe: true }] }), '/collections/c/indexes/0/uniqe'],
  ['a partial index predicate, which collections do not declare', collectionModel({ ...COLLECTION, indexes: [{ name: 'a', path: '$.a', unique: true, where: { $eq: ['$.s', 'x'] } }] }), '/collections/c/indexes/0/where'],
  ['a unique that is not a boolean', collectionModel({ ...COLLECTION, indexes: [{ name: 'a', path: '$.a', unique: 1 }] }), '/collections/c/indexes/0/unique'],
  ['an unknown entity member', entityModel({ schema: KEYED, bogus: 1 }), '/entities/E/bogus'],
  ['an entity indexes array', entityModel({ schema: KEYED, indexes: [{ name: 'x', path: '$.id' }] }), '/entities/E/indexes'],
  ['an unknown invariant member', entityModel({ schema: KEYED, invariants: [{ ...storeRule, bogus: 1 }] }), '/entities/E/invariants/0/bogus'],
];

/** Accepted alike: every declaration member, the migration hints, and an invariant's when/columns/effects. */
const ACCEPTED = [
  ['every collection member and a composite index', collectionModel({ schema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'integer' } } },
    key: '/id', identity: 'caller', 'x-rename': 'old',
    indexes: [{ name: 'a', path: '$.a', unique: true }, { name: 'ab', path: ['$.a', '$.b'], unique: false }] })],
  ['an allocated identity', collectionModel({ schema: { type: 'object' }, key: null, identity: 'integer' })],
  ['an entity with a rename hint and a store rule', entityModel({ schema: KEYED, 'x-rename': 'Old', invariants: [storeRule] })],
  ['an invariant when', physicalRule({ name: 'g', on: ['update'], enforcement: 'database', when: 'assigned', assert: false })],
  ['an invariant columns', physicalRule({ name: 'g', on: ['update'], enforcement: 'database', columns: ['n'], assert: false })],
  ['an invariant effects', physicalRule({ name: 'g', on: ['update'], enforcement: 'database', effects: [{ increment: 'rev' }], assert: true })],
];

/** Every committed `$model` JSON document under the database tests. */
function committedModels() {
  const found = [];
  /** @param {any} node @param {string} where */
  const walk = (node, where) => {
    if (Array.isArray(node)) { node.forEach((item, i) => walk(item, `${where}[${i}]`)); return; }
    if (node === null || typeof node !== 'object') return;
    if (Object.hasOwn(node, '$model')) found.push([where, node]);
    for (const [key, value] of Object.entries(node)) walk(value, `${where}.${key}`);
  };
  const files = [new URL('./fixtures/adoption-sql.json', import.meta.url),
    ...readdirSync(new URL('./oracle/relations/', import.meta.url)).filter((name) => name.endsWith('.json'))
      .map((name) => new URL(`./oracle/relations/${name}`, import.meta.url))];
  for (const file of files) walk(JSON.parse(readFileSync(file, 'utf8')), file.pathname.split('/test/db/')[1]);
  return found;
}

describe('the model document is one closed vocabulary', () => {
  for (const [label, model, docPath] of REFUSED) {
    it(`${label} is JD0005 at ${docPath}, and both schema drafts refuse it`, () => {
      assert.strictEqual(runtime(model), `JD0005 ${docPath}`);
      for (const [draft, validate] of Object.entries(SCHEMAS)) assert.strictEqual(validate(model), false, draft);
    });
  }

  for (const [label, model] of ACCEPTED) {
    it(`${label} is accepted by the runtime, both schema drafts and the studio`, () => {
      assert.strictEqual(runtime(model), 'accepted');
      for (const [draft, validate] of Object.entries(SCHEMAS)) assert.strictEqual(validate(model), true, draft);
      assert.strictEqual(validateFile({ kind: 'model', text: JSON.stringify(model) }).valid, true);
    });
  }

  it('the schema verdict equals the runtime verdict over every committed model document', () => {
    const models = committedModels();
    assert.ok(models.length >= 9, `found ${models.length}`);
    for (const [where, model] of models) {
      const accepted = runtime(model) === 'accepted';
      for (const [draft, validate] of Object.entries(SCHEMAS)) assert.strictEqual(validate(model), accepted, `${where} (${draft})`);
    }
  });

  it('the refusal names the members of the declaration and the nearest one', () => {
    assert.throws(() => normalizeModel(collectionModel({ ...COLLECTION, indexes: [{ name: 'a', path: '$.a', uniqe: true }] })),
      { code: 'JD0005', message: /unknown index member 'uniqe' — did you mean 'unique'\? \(an index declares name, path, expression, unique, derive, precision, dims, physical\)/ });
    assert.throws(() => normalizeModel({ ...collectionModel(COLLECTION), zzz: 1 }),
      { code: 'JD0005', message: /unknown model member 'zzz' \(a model declares \$model, collections, entities\)/ });
    assert.throws(() => normalizeEntities(entityModel({ schema: KEYED, invariants: [{ ...storeRule, enforcment: 'store' }] })),
      { code: 'JD0005', docPath: '/entities/E/invariants/0/enforcment', message: /did you mean 'enforcement'\?/ });
  });

  it('a misspelt unique is refused before any DDL: the file holds no table', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      await refusesToOpen(() => openStore(collectionModel({ ...COLLECTION, indexes: [{ name: 'a', path: '$.a', uniqe: true }] }),
        { driver: nodeDriver(), path: dbPath }), { code: 'JD0005', docPath: '/collections/c/indexes/0/uniqe' });
      const tables = existsSync(dbPath) ? (() => {
        const db = new DatabaseSync(dbPath);
        try { return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all(); }
        finally { db.close(); }
      })() : [];
      assert.deepStrictEqual(tables, []);
    }
    finally { cleanup(); }
  });

  it("x-entity's boolean members are booleans, and so is a relation's many", () => {
    for (const member of ['key', 'unique', 'index', 'version']) {
      const model = entityModel({ schema: { type: 'object', properties: {
        id: { type: 'string', 'x-entity': { key: true } }, n: { type: 'integer', 'x-entity': { [member]: 'true' } } } } });
      assert.strictEqual(runtime(model), `JD0005 /entities/E/schema/properties/n/x-entity/${member}`, member);
    }
    const many = { $model: '0.1', entities: {
      A: { schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } },
        bs: { 'x-entity': { relation: { to: 'B', many: 1, via: 'aId', onDelete: 'cascade' } } } } } },
      B: { schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } }, aId: { type: 'string' } } } } } };
    assert.strictEqual(runtime(many), 'JD0005 /entities/A/schema/properties/bs/x-entity/relation/many');
  });

  it('an invariant refusal points at its rule and member', () => {
    const at = (/** @type {any} */ rule) => runtime(entityModel({ schema: KEYED, invariants: [storeRule, rule] }));
    assert.strictEqual(at({ ...storeRule, name: 'b', enforcement: 'databse' }), 'JD0005 /entities/E/invariants/1/enforcement');
    assert.strictEqual(at({ ...storeRule, name: 'b', on: ['insrt'] }), 'JD0005 /entities/E/invariants/1/on');
    assert.strictEqual(at({ ...storeRule, name: 'positive' }), 'JD0005 /entities/E/invariants/1/name');
    assert.strictEqual(at({ name: 'b', on: ['insert'], enforcement: 'store' }), 'JD0005 /entities/E/invariants/1/assert');
    assert.strictEqual(runtime(physicalRule({ name: 'g', on: ['update'], enforcement: 'database', effects: [{ increment: 'id' }], assert: true })),
      'JD0005 /entities/E/invariants/0/effects');
  });

  it('so does an assert that does not compile, a database rule on a view and an audit into no mapped table — by the model checks and at open', async () => {
    const view = (/** @type {any} */ rule) => {
      const model = physicalRule(rule);
      model.entities.E.physical.kind = 'view';
      return model;
    };
    const auditInto = (/** @type {string} */ entity) => {
      const model = physicalRule({ name: 'a', on: ['insert'], enforcement: 'database', assert: true, audit: { entity, values: { n: '$.new.n' } } });
      model.entities.Owned = { schema: KEYED };
      return model;
    };
    const REFUSED_RULES = [
      ['an unknown operator', entityModel({ schema: KEYED, invariants: [{ ...storeRule, assert: { $nope: ['$.new.n', 0] } }] }), 'assert', /does not compile: .*unknown operator '\$nope'/],
      ['a path that does not parse', entityModel({ schema: KEYED, invariants: [{ ...storeRule, assert: { $gt: ['$.new.n >', 0] } }] }), 'assert', /does not compile: /],
      ['a database rule on a view', view({ name: 'v', on: ['insert'], enforcement: 'database', assert: true }), 'enforcement',
        /database invariant: database rules require a writable explicit column layout/],
      ['an audit into an entity the model lacks', auditInto('Nope'), 'audit', /database invariant: audit target must be a mapped application table/],
      ['an audit into a store-owned entity', auditInto('Owned'), 'audit', /database invariant: audit target must be a mapped application table/],
    ];
    for (const [label, model, member, message] of REFUSED_RULES) {
      const refused = { code: 'JD0005', docPath: `/entities/E/invariants/0/${member}`, message };
      assert.throws(() => normalizeEntities(model), refused, label);
      await refusesToOpen(() => openStore(model, { driver: nodeDriver() }), refused);
    }
  });
});

const BOOKING = (/** @type {string} */ enforcement) => ({ $model: '0.1', entities: { Booking: {
  schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } }, startsAt: { type: 'integer' }, endsAt: { type: 'integer' } } },
  invariants: [{ name: 'ordered', on: ['insert', 'update'], enforcement, assert: { $le: ['$.new.startsAt', '$.new.endsAt'] } }],
} } });
const STORE_OWNED_REASON = /database invariant: database rules require a writable explicit column layout/;

for (const engine of ENGINES) {
  describe(`a rule no layer would enforce is refused at open (${engine})`, { skip: skipFor(engine) }, () => {
    it('a database rule on a store-owned layout: JD0005 at its enforcement, the reason planInvariants gives', async () => {
      assert.throws(() => planInvariants(BOOKING('database'), { dialect: sqliteDialect }), { code: 'JD0005', message: STORE_OWNED_REASON });
      const refused = { code: 'JD0005', docPath: '/entities/Booking/invariants/0/enforcement', message: STORE_OWNED_REASON };
      if (engine === 'sqlite') await refusesToOpen(() => openStore(BOOKING('database'), { driver: nodeDriver() }), refused);
      else {
        await withPostgres(async ({ pool, schema, driver }) => {
          await refusesToOpen(() => openStore(BOOKING('database'), { driver: driver() }), refused);
          const { rows } = await pool.query('SELECT count(*)::int AS tables FROM information_schema.tables WHERE table_schema = $1', [schema]);
          assert.strictEqual(rows[0].tables, 0, 'nothing was created');
        });
      }
    });

    it('the same rule enforced by the store keeps working', () =>
      withStore(engine, BOOKING('store'), async (store) => {
        await store.entity('Booking').create({ id: 'a', startsAt: 1, endsAt: 5 });
        await assert.rejects(store.entity('Booking').create({ id: 'b', startsAt: 5, endsAt: 1 }), { code: 'JD2096' });
      }));
  });
}

describe('a relation to an entity with a physical layout is refused at open', () => {
  const POST = { schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, authorId: { type: 'integer' } } },
    physical: { table: 'post', columns: { id: { name: 'id', codec: 'integer', null: 'reject' }, authorId: { name: 'author_id', codec: 'integer', null: 'null' } } } };
  const user = (/** @type {any} */ members) => ({ $model: '0.1', entities: {
    User: { schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, ...members } } }, Post: POST } });
  const SHAPES = [
    ['one-to-many', { posts: { 'x-entity': { relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'restrict' } } } }],
    ['one-to-one', { postId: { type: 'integer' }, post: { 'x-entity': { relation: { to: 'Post', via: 'postId', onDelete: 'restrict' } } } }],
    ['many-to-many', { posts: { 'x-entity': { relation: { to: 'Post', many: true } } } }],
  ];
  for (const [shape, members] of SHAPES) {
    it(`${shape}: JD0005 naming the relation, never a JD2005 from a later include`, async () => {
      const refused = { code: 'JD0005', docPath: '/entities/User', message: /relation navigation is not qualified for column layouts/ };
      assert.throws(() => normalizeEntities(user(members)), refused);
      const { dbPath, cleanup } = tempDbPath();
      try {
        const db = new DatabaseSync(dbPath);
        db.exec('CREATE TABLE post(id INTEGER PRIMARY KEY, author_id INTEGER); INSERT INTO post VALUES (10, 1);');
        db.close();
        await refusesToOpen(() => openStore(user(members), { driver: nodeDriver(), path: dbPath }), refused);
      }
      finally { cleanup(); }
    });
  }
});
