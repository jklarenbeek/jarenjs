//@ts-check
/**
 * @file The entity model walk: `explainMapping` as golden data (every
 * row of §9.3's mapping table has a case), the closed `x-entity`
 * vocabulary (`JD0030`), relation resolution with the inverse
 * agreement matrix (`JD0031`), `$ref`/`allOf` resolution through the
 * exported validate/normalize helpers, and the identity rules.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { normalizeEntities, explainMapping, relationTables } from '@jarenjs/db';

const FULL = {
  $model: '0.1',
  entities: {
    User: {
      schema: {
        type: 'object',
        required: ['id', 'email'],
        $defs: { shortText: { type: 'string' } },
        properties: {
          id: { type: 'string', 'x-entity': { key: true, default: 'uuid' } },
          email: { type: 'string', 'x-entity': { unique: true } },
          role: { type: 'string', enum: ['admin', 'user'] },
          created: {
            type: 'string', format: 'date-time',
            'x-entity': { default: 'now', column: 'integer', index: true },
          },
          nickname: { $ref: '#/$defs/shortText' },
          merged: { allOf: [{ type: 'integer' }, { minimum: 0 }] },
          secret: { type: 'string', 'x-entity': { column: 'json' } },
          profile: { type: 'object' },
          tags: { type: 'array' },
          posts: {
            'x-entity': {
              relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' },
            },
          },
          labels: { 'x-entity': { relation: { to: 'Label', many: true } } },
        },
      },
    },
    Post: {
      schema: {
        type: 'object',
        properties: {
          pid: { type: 'integer', 'x-entity': { key: true, default: 'auto' } },
          title: { type: 'string' },
          authorId: { type: 'string' },
        },
      },
    },
    Label: {
      schema: {
        type: 'object',
        properties: { name: { type: 'string', 'x-entity': { key: true } } },
      },
    },
  },
};

describe('explainMapping — the hybrid rule as data (every §9.3 row)', () => {
  const mapping = explainMapping(FULL);
  const user = mapping.entities.User;

  it('scalars become typed columns; $ref and allOf resolve first', () => {
    const byName = Object.fromEntries(user.columns.map((c) => [c.name, c]));
    assert.strictEqual(byName.email.storage, 'string');
    assert.strictEqual(byName.nickname.storage, 'string', 'through the local $ref');
    assert.strictEqual(byName.merged.storage, 'integer', 'through the allOf merge');
    assert.strictEqual(byName.id.key, true);
  });

  it("a date-time with column: 'integer' derives an epoch column", () => {
    const created = user.columns.find((c) => c.name === 'created');
    assert.strictEqual(created.storage, 'integer');
    assert.strictEqual(created.source, 'epoch(document)');
  });

  it('an enum of scalars carries its CHECK values', () => {
    const role = user.columns.find((c) => c.name === 'role');
    assert.deepStrictEqual(role.check, ['admin', 'user']);
  });

  it("nested shapes and column: 'json' scalars stay in the document", () => {
    assert.deepStrictEqual([...user.document].sort(), ['profile', 'secret', 'tags']);
  });

  it('a one-to-many relation is a foreign key on the target entity', () => {
    assert.deepStrictEqual(mapping.entities.Post.foreignKeys, [{
      column: 'authorId', references: 'User', referencesKey: 'id',
      onDelete: 'cascade', unique: false,
    }]);
  });

  it('a many-to-many relation is a deterministic sorted join table', () => {
    assert.deepStrictEqual(Object.keys(mapping.joinTables), ['Label_User']);
    const join = mapping.joinTables.Label_User;
    assert.strictEqual(join.left.entity, 'Label');
    assert.strictEqual(join.right.entity, 'User');
    assert.strictEqual(join.onDelete, 'cascade');
  });

  it('indexes: unique and plain, from the vocabulary', () => {
    assert.deepStrictEqual(user.indexes, [
      { property: 'email', unique: true },
      { property: 'created', unique: false },
    ]);
  });

  it('the relation table is the declared relations as plain, frozen rows (§10.1)', () => {
    const tables = relationTables(normalizeEntities(FULL));
    assert.deepStrictEqual(tables, {
      User: {
        posts: { to: 'Post', kind: 'oneToMany', via: 'authorId', fkEntity: 'Post', fkTargets: 'User', targetKey: 'id' },
        labels: { to: 'Label', kind: 'manyToMany', joinTable: 'Label_User', targetKey: 'name' },
      },
      Post: {},
      Label: {},
    });
    assert.ok(Object.isFrozen(tables) && Object.isFrozen(tables.User) && Object.isFrozen(tables.User.posts));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(tables)), tables, 'plain data, JSON through and through');
    // a declared inverse names the same edge from the other side: the
    // foreign key and the key it references are the same two columns
    const both = relationTables(normalizeEntities({
      $model: '0.1',
      entities: {
        User: { schema: { type: 'object', properties: {
          id: { type: 'string', 'x-entity': { key: true } },
          posts: { 'x-entity': { relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' } } },
        } } },
        Post: { schema: { type: 'object', properties: {
          pid: { type: 'integer', 'x-entity': { key: true } },
          authorId: { type: 'string' },
          author: { 'x-entity': { relation: { to: 'User', via: 'authorId', onDelete: 'cascade' } } },
        } } },
      },
    }));
    assert.deepStrictEqual(both.Post.author,
      { to: 'User', kind: 'oneToOne', via: 'authorId', fkEntity: 'Post', fkTargets: 'User', targetKey: 'id' });
    assert.deepStrictEqual(both.User.posts,
      { to: 'Post', kind: 'oneToMany', via: 'authorId', fkEntity: 'Post', fkTargets: 'User', targetKey: 'id' });
  });

  it('normalization never mutates the model document', () => {
    const clone = structuredClone(FULL);
    explainMapping(clone);
    explainMapping(clone); // a second pass would see any annotation
    assert.deepStrictEqual(clone, FULL);
  });
});

describe('the closed vocabulary (JD0030)', () => {
  const withBlock = (block) => ({
    $model: '0.1',
    entities: {
      E: {
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string', 'x-entity': { key: true } },
            x: { type: 'string', 'x-entity': block },
          },
        },
      },
    },
  });

  it('an unknown x-entity member refuses with a docPath', () => {
    assert.throws(() => normalizeEntities(withBlock({ sparkle: true })), (error) => {
      assert.strictEqual(error.code, 'JD0030');
      assert.strictEqual(error.docPath,
        '/entities/E/schema/properties/x/x-entity/sparkle');
      return true;
    });
  });

  it('an unknown relation member refuses too', () => {
    assert.throws(() => normalizeEntities(withBlock({
      relation: { to: 'E', via: 'id', onDelete: 'cascade', cascade: true },
    })), (error) => error.code === 'JD0030');
  });

  it('bad defaults, bad column overrides and non-scalar keys are JD0005', () => {
    assert.throws(() => normalizeEntities(withBlock({ default: 'yesterday' })),
      (error) => error.code === 'JD0005');
    assert.throws(() => normalizeEntities(withBlock({ column: 'text' })),
      (error) => error.code === 'JD0005');
    assert.throws(() => normalizeEntities(withBlock({ column: 'integer' })),
      (error) => error.code === 'JD0005', "column: 'integer' needs a date format");
    assert.throws(() => normalizeEntities({
      $model: '0.1',
      entities: { E: { schema: { type: 'object', properties: {
        id: { type: 'object', 'x-entity': { key: true } } } } } },
    }), (error) => error.code === 'JD0005');
    assert.throws(() => normalizeEntities({
      $model: '0.1',
      entities: { E: { schema: { type: 'object', properties: {
        id: { type: 'string' } } } } },
    }), (error) => {
      assert.match(error.message, /declares no key/);
      return true;
    });
  });
});

describe('inverse agreement (JD0031)', () => {
  const pair = (userSide, postSide) => ({
    $model: '0.1',
    entities: {
      User: {
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string', 'x-entity': { key: true } },
            posts: { 'x-entity': { relation: userSide } },
          },
        },
      },
      Post: {
        schema: {
          type: 'object',
          properties: {
            pid: { type: 'integer', 'x-entity': { key: true } },
            author: { 'x-entity': { relation: postSide } },
          },
        },
      },
    },
  });

  it('an agreeing pair resolves', () => {
    const entities = normalizeEntities(pair(
      { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' },
      { to: 'User', via: 'authorId', onDelete: 'cascade' }));
    assert.strictEqual(entities.get('User').relations[0].relation.kind, 'oneToMany');
  });

  it('two edges between one pair declare their inverse on one side only (\u00a79.4)', () => {
    // author AND editor between User and Post: legitimate, and written
    // with both edges on ONE side — the pairing check is per entity
    // pair, so declaring an inverse for each makes `authored` face
    // `editor` and disagree on the key.
    const twoEdges = (userSide, postSide) => ({
      $model: '0.1',
      entities: {
        User: {
          schema: {
            type: 'object',
            properties: { id: { type: 'string', 'x-entity': { key: true } }, ...userSide },
          },
        },
        Post: {
          schema: {
            type: 'object',
            properties: {
              pid: { type: 'integer', 'x-entity': { key: true } },
              authorId: { type: 'string' },
              editorId: { type: 'string' },
              ...postSide,
            },
          },
        },
      },
    });
    const onUser = {
      authored: { 'x-entity': { relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' } } },
      edited: { 'x-entity': { relation: { to: 'Post', many: true, via: 'editorId', onDelete: 'setNull' } } },
    };
    const onPost = {
      author: { 'x-entity': { relation: { to: 'User', via: 'authorId', onDelete: 'cascade' } } },
      editor: { 'x-entity': { relation: { to: 'User', via: 'editorId', onDelete: 'setNull' } } },
    };
    // both edges on the User side, inverses inferred
    assert.strictEqual(normalizeEntities(twoEdges(onUser, {})).get('User').relations.length, 2);
    // both edges on the Post side, inverses inferred
    assert.strictEqual(normalizeEntities(twoEdges({}, onPost)).get('Post').relations.length, 2);
    // both sides declared: `authored` faces `editor` and is refused, and
    // the message names the way out
    assert.throws(() => normalizeEntities(twoEdges(onUser, onPost)), (error) => {
      assert.strictEqual(error.code, 'JD0031');
      assert.match(error.message, /one side only/);
      return true;
    });
  });

  it('via disagreement, side disagreement and onDelete disagreement each refuse', () => {
    assert.throws(() => normalizeEntities(pair(
      { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' },
      { to: 'User', via: 'writerId', onDelete: 'cascade' })),
    (error) => {
      assert.strictEqual(error.code, 'JD0031');
      assert.match(error.message, /authorId.*writerId/);
      return true;
    });
    assert.throws(() => normalizeEntities(pair(
      { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' },
      { to: 'User', many: true, via: 'authorId', onDelete: 'cascade' })),
    (error) => error.code === 'JD0031');
    assert.throws(() => normalizeEntities(pair(
      { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' },
      { to: 'User', via: 'authorId', onDelete: 'restrict' })),
    (error) => {
      assert.strictEqual(error.code, 'JD0031');
      assert.match(error.message, /onDelete/);
      return true;
    });
  });

  it('a many-to-many pair must agree on being one, and on the table', () => {
    assert.throws(() => normalizeEntities(pair(
      { to: 'Post', many: true },
      { to: 'User', via: 'authorId', onDelete: 'cascade' })),
    (error) => error.code === 'JD0031');
    assert.throws(() => normalizeEntities(pair(
      { to: 'Post', many: true, through: 'link_a' },
      { to: 'User', many: true, through: 'link_b' })),
    (error) => {
      assert.strictEqual(error.code, 'JD0031');
      assert.match(error.message, /join table/);
      return true;
    });
  });

  it('structural relation defects are JD0005 with their docPaths', () => {
    assert.throws(() => normalizeEntities(pair(
      { to: 'Ghost', many: true, via: 'x', onDelete: 'cascade' },
      { to: 'User', via: 'x', onDelete: 'cascade' })),
    (error) => error.code === 'JD0005');
    assert.throws(() => normalizeEntities(pair(
      { to: 'Post', many: true, via: 'authorId' },
      { to: 'User', via: 'authorId' })),
    (error) => {
      assert.match(error.message, /onDelete/);
      assert.match(error.message, /never defaulted silently/);
      return true;
    });
    // a declared via property of the wrong type
    const model = pair(
      { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' },
      { to: 'User', via: 'authorId', onDelete: 'cascade' });
    model.entities.Post.schema.properties.authorId = { type: 'integer' };
    assert.throws(() => normalizeEntities(model),
      (error) => {
        assert.match(error.message, /must be a column-mapped string/);
        return true;
      });
  });
});
