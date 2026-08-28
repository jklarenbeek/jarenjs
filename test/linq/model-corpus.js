//@ts-check
/**
 * The model-pen corpus: models built through `@jarenjs/linq/model`,
 * each with the hand-written `$model` document it MUST emit. The first
 * entry rebuilds `test/db/emit-model-fixture.js`'s `FIXTURE_MODEL` — the
 * hand-written model the generated `EntityMetaMap` derives from — so the
 * pen provably writes what the hand wrote and `InferMeta<>` is pinned
 * against a generated map for the same document. Every entry also
 * opens under the real store and round-trips a write through its
 * declared defaults (test/linq/model-pen.test.js).
 */
import * as m from '@jarenjs/linq/model';

import { FIXTURE_MODEL } from '../db/emit-model-fixture.js';

// ——— the fixture, through the pen (entities are open objects there) ———
export const User = m.object({
  id: m.string().identity('uuid'),
  email: m.string().unique(),
  name: m.string().optional(),
  age: m.integer().optional(),
  active: m.boolean().optional(),
  role: m.string().enumOf(['admin', 'user']).fill('user').optional(),
  joined: m.datetime().column('integer').index().optional(),
  rev: m.integer().version().optional(),
  profile: m.object({
    bio: m.string().optional(),
    links: m.array(m.string()).optional(),
  }).open().optional(),
  posts: m.rel.hasMany('Post', { via: 'authorId', onDelete: 'cascade' }),
  labels: m.rel.belongsToMany('Label'),
}).open();

export const Post = m.object({
  pid: m.integer().identity('auto'),
  title: m.string().optional(),
  stars: m.integer().optional(),
  published: m.date().column('integer').optional(),
  authorId: m.string(),
  author: m.rel.hasOne('User', { via: 'authorId', onDelete: 'cascade' }),
}).open();

export const Label = m.object({ name: m.string().key() }).open();

export const Grade = m.object({
  student: m.string().key(),
  course: m.string().key(),
  score: m.integer().optional(),
}).open();

export const fixtureModel = m.defineModel({ entities: { User, Post, Label, Grade } });

// ——— a closed entity with every store-written default, and a rename ———
export const Note = m.object({
  id: m.string().identity('uuid'),
  text: m.string(),
  slug: m.string().compute((d) => d.text.lower()).optional(),
  created: m.datetime().now().optional(),
  touched: m.datetime().updated().column('integer').optional(),
  kind: m.string().enumOf(['memo', 'todo']).fill('memo').optional(),
  weight: m.integer().fill(1).optional(),
  tags: m.array(m.string()).optional(),
}).renamedFrom('Memo');

export const notesModel = m.defineModel({ entities: { Note } });

// ——— collections: a pointer key, captured index paths, every derive kind ———
export const Place = m.object({
  id: m.string(),
  loc: m.array(m.number()),
  geometry: m.any().optional(),
  series: m.string(),
  t: m.integer(),
  embedding: m.array(m.number()).length(4).optional(),
});

export const placesModel = m.defineModel({
  collections: {
    places: m.collection(Place, {
      key: (d) => d.id,
      indexes: [
        m.index((p) => p.series),
        m.index([(p) => p.series, (p) => p.t]),
        m.index((p) => p.loc, { name: 'by_cell', derive: 'geohash', precision: 7 }),
        m.index((p) => p.geometry, { derive: 'bbox', physical: 'rtree' }),
        m.index((p) => p.embedding, { derive: 'vector', dims: 4 }),
      ],
    }),
    log: m.collection(m.object({ line: m.string() }), { key: null, identity: 'integer' }),
  },
});

export const CORPUS = [
  {
    name: 'fixture',
    model: fixtureModel,
    document: FIXTURE_MODEL,
    // write through the declared defaults, read back equal
    roundTrip: async (/** @type {any} */ store) => {
      const users = store.entity('User');
      const ada = await users.create({ email: 'ada@x.test' });
      const posts = store.entity('Post');
      const first = await posts.create({ title: 'one', authorId: ada.id });
      return {
        created: ada,
        stored: await users.get(ada.id),
        checks: [
          [/^[0-9a-f-]{36}$/.test(ada.id), 'uuid() allocated the key'],
          [ada.role === 'user', 'fill() wrote the literal'],
          [typeof first.pid === 'number', 'auto() allocated the key'],
        ],
      };
    },
  },
  {
    name: 'notes',
    model: notesModel,
    document: {
      $model: '0.1',
      entities: {
        Note: {
          schema: {
            type: 'object',
            properties: {
              id: { type: 'string', 'x-entity': { key: true, default: 'uuid' } },
              text: { type: 'string' },
              slug: { type: 'string', 'x-entity': { default: { query: { $lower: '$.text' } } } },
              created: { type: 'string', format: 'date-time', 'x-entity': { default: 'now' } },
              touched: { type: 'string', format: 'date-time', 'x-entity': { default: 'updated', column: 'integer' } },
              kind: { type: 'string', enum: ['memo', 'todo'], 'x-entity': { default: { value: 'memo' } } },
              weight: { type: 'integer', 'x-entity': { default: { value: 1 } } },
              tags: { type: 'array', items: { type: 'string' } },
            },
            required: ['id', 'text'],
            additionalProperties: false,
          },
          'x-rename': 'Memo',
        },
      },
    },
    roundTrip: async (/** @type {any} */ store) => {
      const notes = store.entity('Note');
      const note = await notes.create({ text: 'Hello', tags: ['a'] });
      return {
        created: note,
        stored: await notes.get(note.id),
        checks: [
          [note.slug === 'hello', 'compute() ran over the document being written'],
          [/^\d{4}-\d{2}-\d{2}T/.test(note.created), 'now() stamped'],
          [/^\d{4}-\d{2}-\d{2}T/.test(note.touched), 'updated() stamped'],
          [note.kind === 'memo' && note.weight === 1, 'fill() wrote both literals'],
        ],
      };
    },
  },
  {
    name: 'places',
    model: placesModel,
    document: {
      $model: '0.1',
      collections: {
        places: {
          schema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              loc: { type: 'array', items: { type: 'number' } },
              geometry: {},
              series: { type: 'string' },
              t: { type: 'integer' },
              embedding: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 },
            },
            required: ['id', 'loc', 'series', 't'],
            additionalProperties: false,
          },
          key: '/id',
          indexes: [
            { name: 'by_series', path: '$.series' },
            { name: 'by_series_t', path: ['$.series', '$.t'] },
            { name: 'by_cell', path: '$.loc', derive: 'geohash', precision: 7 },
            { name: 'by_geometry', path: '$.geometry', derive: 'bbox', physical: 'rtree' },
            { name: 'by_embedding', path: '$.embedding', derive: 'vector', dims: 4 },
          ],
        },
        log: {
          schema: {
            type: 'object',
            properties: { line: { type: 'string' } },
            required: ['line'],
            additionalProperties: false,
          },
          key: null,
          identity: 'integer',
        },
      },
    },
    roundTrip: async (/** @type {any} */ store) => {
      const places = store.collection('places');
      await places.insert({ id: 'p1', loc: [4.9, 52.3], series: 's', t: 1, embedding: [1, 0, 0, 0] });
      const row = await places.get('p1');
      const logged = await store.collection('log').insert({ line: 'x' });
      return {
        created: row,
        stored: await places.get('p1'),
        checks: [
          [row !== undefined && row.series === 's', 'the row reads back by its pointer key'],
          [typeof logged === 'number', 'the store allocated the log key'],
        ],
      };
    },
  },
];
