//@ts-check
/**
 * @file What introspection derives from the NAMES a database holds. A table
 * whose name is no identifier is reported, not derived (a model that declared
 * `My Table` as an entity is refused whole, JD0005); a name that is also a
 * prototype member (`__proto__`) is an own member of the derived model, not a
 * rewrite of the map's prototype that dropped the table and re-typed its
 * siblings' members; and the member a join table's edge is declared as never
 * replaces a column or another edge of the same pair.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { openStore, introspectModel, normalizeEntities } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

/** @param {string} ddl */
async function derive(ddl, options = undefined) {
  const driver = nodeDriver();
  const connection = await driver.open(':memory:');
  try {
    await connection.exec(ddl);
    return await introspectModel(connection, options);
  }
  finally { await connection.close(); }
}

/** An object whose members are all OWN, `__proto__` included. @param {Record<string, any>} members */
const own = (members) => {
  const out = {};
  for (const [key, value] of Object.entries(members)) Object.defineProperty(out, key, { value, enumerable: true, configurable: true, writable: true });
  return out;
};

describe('a table name no model can declare', () => {
  it('is reported unmapped-table, and the derived model keeps only the tables it can declare', async () => {
    const { model, report } = await derive(
      'CREATE TABLE "My Table" (id TEXT PRIMARY KEY); CREATE TABLE "123x" (id TEXT PRIMARY KEY); CREATE TABLE "Ünï" (id TEXT PRIMARY KEY); '
      + 'CREATE TABLE Plain (id TEXT PRIMARY KEY, doc BLOB NOT NULL)');
    assert.deepStrictEqual(Object.keys(model.entities), ['Plain']);
    assert.deepStrictEqual(report.filter((row) => row.code === 'unmapped-table').map((row) => row.object), ['123x', 'My Table', 'Ünï']);
    assert.match(report.find((row) => row.object === 'My Table')?.detail ?? '', /^the table's name is not an identifier /);
    assert.doesNotThrow(() => normalizeEntities(model));
  });

  it('strict introspection refuses the shape that has one', async () => {
    await assert.rejects(derive('CREATE TABLE "My Table" (id TEXT PRIMARY KEY)', { strict: true }), { code: 'JD0002' });
  });
});

describe('a name that is also a prototype member', () => {
  it('a table, a column and a collection named __proto__ are derived as own members', async () => {
    const proto = own({ id: { type: 'string', 'x-entity': { key: true } }, ['__proto__']: { type: 'string' }, constructor: { type: 'integer' } });
    const entity = { schema: { type: 'object', required: ['id'], properties: proto } };
    const model = { $model: '0.1', entities: own({ ['__proto__']: entity, Normal: entity }) };
    const store = await openStore(model, { driver: nodeDriver() });
    try {
      const { model: derived } = await store.introspect();
      assert.deepStrictEqual(Object.keys(derived.entities).sort(), ['Normal', '__proto__']);
      for (const name of ['__proto__', 'Normal']) {
        const properties = derived.entities[name].schema.properties;
        assert.strictEqual(Object.getPrototypeOf(properties), Object.prototype, `${name}: the members map keeps its prototype`);
        assert.deepStrictEqual(Object.keys(properties), ['id', '__proto__', 'constructor']);
      }
    }
    finally { await store.close(); }
  });

  it('a collection named __proto__ is derived, and a key hint is read only for the name it is given under', async () => {
    const model = { $model: '0.1', collections: own({ ['__proto__']: { key: '/id', schema: { type: 'object', properties: { id: { type: 'string' } } } } }) };
    const store = await openStore(model, { driver: nodeDriver() });
    try {
      const unhinted = await store.introspect({ keys: {} });
      assert.deepStrictEqual(Object.keys(unhinted.model.collections), ['__proto__']);
      assert.strictEqual(unhinted.model.collections['__proto__'].identity, 'uuid', 'no hint is the key source row, not the prototype as a key');
      assert.ok(unhinted.report.some((row) => row.code === 'key-source' && row.object === '__proto__.key'));
      const hinted = await store.introspect({ keys: own({ ['__proto__']: '/id' }) });
      assert.strictEqual(hinted.model.collections['__proto__'].key, '/id');
    }
    finally { await store.close(); }
  });
});

describe('the member a join table\'s edge is declared as', () => {
  const POST_TAG = 'CREATE TABLE Post_Tag (Post_key TEXT REFERENCES Post(id), Tag_key TEXT REFERENCES Tag(id), PRIMARY KEY (Post_key, Tag_key)) STRICT;';
  const TABLES = 'CREATE TABLE Tag (id TEXT PRIMARY KEY, doc BLOB NOT NULL) STRICT;';

  it('keeps a column named like it, and takes the join table\'s name beside it', async () => {
    const { model, report } = await derive(`CREATE TABLE Post (id TEXT PRIMARY KEY, tags TEXT, doc BLOB NOT NULL) STRICT; ${TABLES} ${POST_TAG}`);
    assert.deepStrictEqual(model.entities.Post.schema.properties, {
      id: { type: 'string', 'x-entity': { key: true } },
      tags: { type: 'string' },
      tags_Post_Tag: { 'x-entity': { relation: { to: 'Tag', many: true, through: 'Post_Tag' } } },
    });
    assert.match(report.find((row) => row.code === 'ambiguous-relation')?.detail ?? '', /declared on 'Post' as 'tags_Post_Tag'/);
  });

  it('keeps two edges between one pair apart', async () => {
    const { model } = await derive(`CREATE TABLE Post (id TEXT PRIMARY KEY, doc BLOB NOT NULL) STRICT; ${TABLES} ${POST_TAG}
      CREATE TABLE Tagging (Post_key TEXT REFERENCES Post(id), Tag_key TEXT REFERENCES Tag(id), PRIMARY KEY (Post_key, Tag_key)) STRICT;`);
    assert.deepStrictEqual(Object.values(model.entities.Post.schema.properties).flatMap((property) => property['x-entity']?.relation?.through ?? []).sort(),
      ['Post_Tag', 'Tagging']);
    assert.deepStrictEqual(Object.keys(model.entities.Post.schema.properties), ['id', 'tags', 'tags_Tagging']);
  });
});
