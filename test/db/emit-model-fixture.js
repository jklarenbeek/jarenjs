//@ts-check
/**
 * @file The shared fixture model for the generated-types oracle: every
 * vocabulary feature the emission handles — keys of both scalar types,
 * auto/uuid/value defaults, an epoch instant, a version token, all
 * three relation kinds (paired one-to-one included), nested shapes,
 * composite keys.
 */

export const FIXTURE_MODEL = {
  $model: '0.1',
  entities: {
    User: {
      schema: {
        type: 'object',
        required: ['id', 'email'],
        properties: {
          id: { type: 'string', 'x-entity': { key: true, default: 'uuid' } },
          email: { type: 'string', 'x-entity': { unique: true } },
          name: { type: 'string' },
          age: { type: 'integer' },
          active: { type: 'boolean' },
          role: { type: 'string', enum: ['admin', 'user'], 'x-entity': { default: { value: 'user' } } },
          joined: { type: 'string', format: 'date-time', 'x-entity': { column: 'integer', index: true } },
          rev: { type: 'integer', 'x-entity': { version: true } },
          profile: {
            type: 'object',
            properties: { bio: { type: 'string' }, links: { type: 'array', items: { type: 'string' } } },
          },
          posts: { 'x-entity': { relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' } } },
          labels: { 'x-entity': { relation: { to: 'Label', many: true } } },
        },
      },
    },
    Post: {
      schema: {
        type: 'object',
        required: ['pid', 'authorId'],
        properties: {
          pid: { type: 'integer', 'x-entity': { key: true, default: 'auto' } },
          title: { type: 'string' },
          stars: { type: 'integer' },
          published: { type: 'string', format: 'date', 'x-entity': { column: 'integer' } },
          authorId: { type: 'string' },
          author: { 'x-entity': { relation: { to: 'User', via: 'authorId', onDelete: 'cascade' } } },
        },
      },
    },
    Label: {
      schema: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', 'x-entity': { key: true } } },
      },
    },
    Grade: {
      schema: {
        type: 'object',
        required: ['student', 'course'],
        properties: {
          student: { type: 'string', 'x-entity': { key: true } },
          course: { type: 'string', 'x-entity': { key: true } },
          score: { type: 'integer' },
        },
      },
    },
  },
};
