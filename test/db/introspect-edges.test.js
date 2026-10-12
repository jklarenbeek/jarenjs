//@ts-check
/**
 * @file A foreign key is read back as the typed property it is plus the
 * relation that declares its edge, so a model derived from a database with an
 * entity foreign key is a model: it normalizes, and it opens the database it
 * came from (a relation written onto the key's own typeless column is
 * one no model accepts). A unique key is a one-to-one declared on
 * the child, any other a one-to-many declared on the parent, named so that no
 * member is replaced; a key a model cannot declare is reported, not guessed.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { openStore, introspectModel, normalizeEntities } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { ENGINES, skipFor, withPostgres } from './store-core-engines.js';
import { tempDbPath } from './helpers.js';

const ent = (extra = {}) => ({ schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', 'x-entity': { key: true } }, ...extra } } });
const rel = (/** @type {string} */ to, /** @type {any} */ more) => ({ 'x-entity': { relation: { to, ...more } } });
const MODEL = { $model: '0.1', entities: {
  Author: ent({ books: rel('Book', { many: true, via: 'authorId', onDelete: 'cascade' }), profile: rel('Profile', { via: 'profileId', onDelete: 'setNull' }) }),
  Book: ent({ authorId: { type: 'string' }, title: { type: 'string' } }),
  Profile: ent({ bio: { type: 'string' } }),
} };

/** @param {string} engine @param {any} model @param {(open: (model: any) => Promise<any>) => Promise<void>} fn */
async function onEngine(engine, model, fn) {
  if (engine === 'postgres') {
    await withPostgres(async ({ driver }) => {
      await (await openStore(model, { driver: driver() })).close();
      await fn((derived) => openStore(derived, { driver: driver() }));
    });
    return;
  }
  const { dbPath, cleanup } = tempDbPath();
  try {
    await (await openStore(model, { driver: nodeDriver(), path: dbPath })).close();
    await fn((derived) => openStore(derived, { driver: nodeDriver(), path: dbPath }));
  }
  finally { cleanup(); }
}

for (const engine of ENGINES) {
  describe(`${engine}: a model derived from a database with entity foreign keys`, { skip: skipFor(engine) }, () => {
    it('declares each edge beside its typed key, normalizes, and opens the database it was read from', async () => {
      await onEngine(engine, MODEL, async (open) => {
        const store = await open(MODEL);
        const { model, report } = await store.introspect();
        await store.close();
        assert.deepStrictEqual(model.entities.Book.schema.properties.authorId, { type: 'string', 'x-entity': { index: true } });
        assert.deepStrictEqual(model.entities.Author.schema.properties.books, { 'x-entity': { relation: { to: 'Book', many: true, via: 'authorId', onDelete: 'cascade' } } });
        assert.deepStrictEqual(model.entities.Author.schema.properties.profileId, { type: 'string', 'x-entity': { unique: true } });
        assert.deepStrictEqual(model.entities.Author.schema.properties.profile, { 'x-entity': { relation: { to: 'Profile', via: 'profileId', onDelete: 'setNull' } } });
        assert.deepStrictEqual(report.filter((row) => row.code === 'ambiguous-relation').map((row) => row.object), ['Author.profileId', 'Book.authorId']);
        assert.deepStrictEqual(report.filter((row) => row.code === 'unmapped-constraint'), []);
        assert.doesNotThrow(() => normalizeEntities(model));
        await (await open(model)).close();
      });
    });

    it('an edge and a member of one name: the member stays, the edge is qualified by its key', async () => {
      const model = { $model: '0.1', entities: {
        Author: ent({ books: { type: 'string' }, written: rel('Book', { many: true, via: 'authorId', onDelete: 'cascade' }) }),
        Book: ent({ authorId: { type: 'string' } }) } };
      await onEngine(engine, model, async (open) => {
        const store = await open(model);
        const { model: derived } = await store.introspect();
        await store.close();
        const members = derived.entities.Author.schema.properties;
        assert.deepStrictEqual(members.books, { type: 'string' });
        assert.deepStrictEqual(members.books_authorId, { 'x-entity': { relation: { to: 'Book', many: true, via: 'authorId', onDelete: 'cascade' } } });
        await (await open(derived)).close();
      });
    });

    it('a self-referencing key and two edges of one pair are each declared', async () => {
      const model = { $model: '0.1', entities: {
        Node: ent({ children: rel('Node', { many: true, via: 'parentId', onDelete: 'restrict' }), parentId: { type: 'string' } }),
        Person: ent({ wrote: rel('Post', { many: true, via: 'authorId', onDelete: 'cascade' }), edited: rel('Post', { many: true, via: 'editorId', onDelete: 'restrict' }) }),
        Post: ent({ authorId: { type: 'string' }, editorId: { type: 'string' } }) } };
      await onEngine(engine, model, async (open) => {
        const store = await open(model);
        const { model: derived } = await store.introspect();
        await store.close();
        assert.deepStrictEqual(Object.keys(derived.entities.Node.schema.properties), ['id', 'parentId', 'nodes']);
        assert.deepStrictEqual(Object.keys(derived.entities.Person.schema.properties), ['id', 'posts', 'posts_editorId']);
        await (await open(derived)).close();
      });
    });
  });
}

describe('a foreign key a model cannot declare', () => {
  /** @param {string} ddl */
  async function derive(ddl) {
    const driver = nodeDriver();
    const connection = await driver.open(':memory:');
    try { await connection.exec(ddl); return await introspectModel(connection); }
    finally { await connection.close(); }
  }
  const TABLES = 'CREATE TABLE Parent (id TEXT PRIMARY KEY, code TEXT UNIQUE, doc BLOB NOT NULL) STRICT; ';
  /** @type {[string, string, RegExp][]} */
  const cases = [
    ['an ON UPDATE action', 'CREATE TABLE Child (id TEXT PRIMARY KEY, pid TEXT REFERENCES Parent(id) ON DELETE CASCADE ON UPDATE CASCADE, doc BLOB NOT NULL) STRICT', /has the ON UPDATE action CASCADE/],
    ['no ON DELETE action', 'CREATE TABLE Child (id TEXT PRIMARY KEY, pid TEXT REFERENCES Parent(id), doc BLOB NOT NULL) STRICT', /its ON DELETE action is NO ACTION/],
    ['a column other than the key', 'CREATE TABLE Child (id TEXT PRIMARY KEY, pid TEXT REFERENCES Parent(code) ON DELETE CASCADE, doc BLOB NOT NULL) STRICT', /does not reference the single key/],
    ['several columns', 'CREATE TABLE Child (id TEXT PRIMARY KEY, a TEXT, b TEXT, doc BLOB NOT NULL, FOREIGN KEY (a, b) REFERENCES Parent(id, code) ON DELETE CASCADE) STRICT', /spans several columns/],
    ['a column that is the table\'s own key', 'CREATE TABLE Child (id TEXT PRIMARY KEY REFERENCES Parent(id) ON DELETE CASCADE, doc BLOB NOT NULL) STRICT', /its column is the table's own key/],
    ['a key of another type', 'CREATE TABLE Child (id TEXT PRIMARY KEY, pid INTEGER REFERENCES Parent(id) ON DELETE CASCADE, doc BLOB NOT NULL) STRICT', /is typed integer, not as the key it references/],
  ];
  for (const [label, child, why] of cases) {
    it(`${label}: the key stays a typed property, no relation is guessed, and the report says why`, async () => {
      const { model, report } = await derive(TABLES + child);
      const rows = report.filter((row) => row.code === 'unmapped-constraint');
      assert.ok(rows.length >= 1 && why.test(rows[0].detail), JSON.stringify(rows));
      assert.ok(!Object.values(model.entities.Parent.schema.properties).some((property) => /** @type {any} */ (property)['x-entity']?.relation));
      assert.doesNotThrow(() => normalizeEntities(model));
    });
  }
});

describe('postgres: a foreign key another tool wrote as RESTRICT', { skip: skipFor('postgres') }, () => {
  it('reads back as the model\'s restrict, the action the store writes as a deferrable NO ACTION key', async () => {
    await withPostgres(async ({ pool, schema, driver }) => {
      await pool.query(`CREATE TABLE "${schema}"."Parent" (id text PRIMARY KEY);
        CREATE TABLE "${schema}"."Child" (id text PRIMARY KEY, pid text REFERENCES "${schema}"."Parent"(id) ON DELETE RESTRICT)`);
      const connection = await driver().open();
      try {
        const { model } = await introspectModel(connection);
        assert.deepStrictEqual(model.entities.Parent.schema.properties.childs,
          { 'x-entity': { relation: { to: 'Child', many: true, via: 'pid', onDelete: 'restrict' } } });
      }
      finally { await connection.close(); }
    });
  });
});
