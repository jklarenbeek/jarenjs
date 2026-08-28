//@ts-check
/**
 * The schema-pen corpus: one source of truth read by three gates — the
 * pen test (emission byte-equal to the hand-written `schema`, the
 * validator's verdicts, the 2020-12 meta-schema), the committed
 * generated fixture (emit's declarations for every emitted document)
 * and the type pins under `npm run test:types`. The entry shape is the
 * emit corpus's (`schema`, `valid`, `invalidShape`, `invalidWidened`,
 * `normalize`, `rawInput`) plus `build`, the pen spelling that MUST emit
 * `schema`.
 *
 * `normalize` is always the pen's own profile (`PEN_NORMALIZE`): the
 * three annotations the pen writes are the three the normalizer reads.
 * An entry carries it exactly when its document holds a `default`,
 * `x-coerce` or `x-trim` (the pen test asserts both directions), so the
 * plain-named generated declaration is the NORMALIZED shape `Infer<>`
 * claims and the `Input` twin is the accepted shape `Input<>` claims.
 */
import * as s from '@jarenjs/linq/schema';

/** The normalize profile every pen document is read under. */
export const PEN_NORMALIZE = Object.freeze({
  useDefaults: true,
  coerceTypes: (/** @type {any} */ node) => node['x-coerce'] === true,
  trimStrings: (/** @type {any} */ node) => node['x-trim'] === true,
});

/**
 * The recursive definition two entries share. Annotated, as every
 * recursive inference must be: the initializer names itself.
 * @typedef {{ label: string, children?: NodeShape[] }} NodeShape
 * @type {import('@jarenjs/linq/schema').NamedBuilder<NodeShape>}
 */
export const Node = s.named('Node', s.object({
  label: s.string(),
  children: s.array(s.lazy(() => Node)).optional(),
}));

/** The object `Derived` reshapes. */
const Base = s.object({ id: s.string(), name: s.string(), age: s.integer().optional() });

// The builders, one per entry — named exports so the type pins read the
// SAME builders the runtime gate does.
export const Account = s.object({
  id: s.string().min(3),
  age: s.integer().optional(),
  role: s.enumOf(['admin', 'user']).optional(),
  tags: s.array(s.string()).optional(),
}).open();
export const Strict = s.object({ kind: s.string() });
export const Config = s.object({
  host: s.string().optional().default('localhost'),
  port: s.integer().optional().default(8080),
  name: s.string(),
}).open();
export const Id = s.named('Uuid', s.string());
export const Exact = s.tuple([s.string(), s.number()]).rest(s.never());
export const Empty = s.object({});
export const Job = s.object({ cmd: s.string(), retries: s.integer().default(3) }).open();
export const Scalars = s.object({
  s: s.string(), n: s.number(), i: s.integer(), b: s.boolean(), z: s.nil(),
});
export const Literals = s.object({ kind: s.literal('a'), on: s.literal(true), n: s.literal(1) });
export const Enums = s.object({
  role: s.enumOf(['admin', 'user']),
  mood: s.enumOf(['up', 'down']).nullable(),
  tag: s.literal('x').nullable().optional(),
});
export const Nullables = s.object({ name: s.string().nullable(), age: s.integer().nullable().optional() });
export const StringRules = s.object({
  id: s.string().uuid(),
  mail: s.string().email(),
  site: s.string().uri(),
  code: s.string().length(4),
  slug: s.string().min(1).max(20).pattern(/^[a-z-]+$/),
});
export const NumberRules = s.object({
  a: s.number().min(0).max(10),
  b: s.integer().gt(0).lt(5),
  c: s.number().multipleOf(0.5),
  d: s.number().int(),
});
export const Dates = s.object({
  at: s.datetime(),
  on: s.date(),
  t: s.time(),
  d: s.duration(),
  seen: s.datetime().nullable().optional(),
  stamps: s.array(s.datetime()).optional(),
});
export const ArrayRules = s.object({
  tags: s.array(s.string()).min(1).max(3).unique(),
  pair: s.array(s.integer()).length(2),
  has: s.array(s.number()).contains(s.literal(0)),
});
export const Tuples = s.object({
  open: s.tuple([s.string(), s.number()]),
  tail: s.tuple([s.string()]).rest(s.boolean()),
  exact: s.tuple([s.string(), s.number()]).rest(s.never()),
});
export const Dict = s.record(s.integer());
export const Either = s.object({
  v: s.union([s.string(), s.number()]),
  w: s.union([s.object({ a: s.string() }), s.object({ b: s.number() })]).optional(),
});
export const Shape = s.discriminated('kind', [
  s.object({ kind: s.literal('circle'), r: s.number() }),
  s.object({ kind: s.literal('square'), side: s.number() }),
]);
export const Both = s.intersection([
  s.object({ a: s.string() }).open(),
  s.object({ b: s.number() }).open(),
]);
// a reference by name carries no type: the cast is the caller's assertion
// (`ref<NodeShape>('Node')` in TypeScript), pinned against emit's reading
export const Linked = s.object({
  head: Node,
  tail: /** @type {import('@jarenjs/linq/schema').SchemaBuilder<NodeShape>} */ (s.ref('Node')).optional(),
});
export const Conditional = s.intersection([
  s.object({ k: s.string(), v: s.any() }).open(),
  s.when(s.object({ k: s.literal('a') }).open())
    .then(s.object({ v: s.string() }).open())
    .else(s.object({ v: s.number() }).open()),
]);
// a hand-written schema is never inferred: `from<T>()` is the caller's
// assertion, pinned against emit's reading of the same JSON
export const Wrapped = s.object({
  meta: /** @type {import('@jarenjs/linq/schema').SchemaBuilder<{ a?: string, [key: string]: unknown }>} */ (
    s.from({ type: 'object', properties: { a: { type: 'string' } } })),
  anything: s.any(),
  nothing: s.never().optional(),
  yes: s.from(true).optional(),
});
export const Members = s.object({ a: s.string(), b: s.number().optional() })
  .open().minProperties(1).maxProperties(9).dependentRequired({ a: ['b'] });
export const Patterned = s.object({ id: s.string() }).patternProperties({ '^x-': s.number() });
export const Keyed = s.object({}).open().propertyNames(s.string().pattern('^[a-z]+$'));
export const Derived = s.object({
  one: Base.extend({ email: s.string() }).omit(['name']).partial().required(['id']),
  two: Base.pick(['name']).optional(),
});
export const Invoice = s.object({
  lines: s.array(s.object({ amount: s.number() })),
  total: s.number(),
}).check((o) => o.total.eq(o.lines.all().amount.sum()));
export const Order = s.object({
  currency: s.string(),
  start: s.datetime(),
  end: s.datetime(),
  // the root is the honest top, so a rule against it reads from the
  // root's side: an unknown expression compares with anything
  lines: s.array(s.object({ qty: s.integer(), currency: s.string() })
    .check((l, x) => x.root.currency.eq(l.currency))),
})
  .check((o) => o.start.le(o.end))
  .check({ $every: { l: '$.lines[*]' }, $satisfies: { $gt: ['$l.qty', 0] } });
export const Coerced = s.object({
  port: s.integer().coerce(),
  on: s.boolean().coerce().optional(),
  name: s.string().trim(),
  ratio: s.number().coerce().default(1),
  label: s.string().nullable().optional(),
});
export const Level = s.object({
  level: s.integer().enumOf([1, 2, 3]).coerce(),
  role: s.string().enumOf(['admin', 'user']).nullable().optional(),
});
export const Annotated = s.object({
  id: s.string().describe('The id').title('Id').example('abc').example('def')
    .meta({ 'x-vendor': { a: 1 }, deprecated: true })
    .message('need an id'),
  n: s.integer().min(18).message({ minimum: 'Must be an adult', _: 'Invalid age' }).optional(),
}).title('Annotated').describe('An annotated object');

export const CORPUS = [
  // ——— the emit corpus's own entries, rebuilt through the pen ———
  {
    name: 'Account',
    build: () => Account,
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 3 },
        age: { type: 'integer' },
        role: { enum: ['admin', 'user'] },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
    },
    valid: [{ id: 'abc' }, { id: 'abc', age: 3, role: 'admin', tags: ['x'] }, { id: 'abc', extra: true }],
    invalidShape: [{ id: 42 }, { age: 1 }, { id: 'abc', role: 'owner' }, { id: 'abc', tags: [1] }],
    invalidWidened: [{ id: 'ab' }],
  },
  {
    name: 'Strict',
    build: () => Strict,
    schema: {
      type: 'object',
      properties: { kind: { type: 'string' } },
      required: ['kind'],
      additionalProperties: false,
    },
    valid: [{ kind: 'a' }],
    invalidShape: [{ kind: 'a', extra: 1 }, { extra: 1 }],
    invalidWidened: [],
  },
  {
    name: 'Config',
    normalize: PEN_NORMALIZE,
    build: () => Config,
    schema: {
      type: 'object',
      properties: {
        host: { type: 'string', default: 'localhost' },
        port: { type: 'integer', default: 8080 },
        name: { type: 'string' },
      },
      required: ['name'],
    },
    valid: [{ name: 'a', host: 'h', port: 1 }],
    invalidShape: [{ name: 1, host: 'h', port: 1 }],
    invalidWidened: [],
    rawInput: [{ name: 'a' }, { name: 'a', port: 9000 }],
  },
  {
    name: 'Id',
    build: () => Id,
    schema: { $defs: { Uuid: { type: 'string' } }, $ref: '#/$defs/Uuid' },
    valid: ['abc'],
    invalidShape: [1, {}, null],
    invalidWidened: [],
  },
  {
    name: 'Exact',
    build: () => Exact,
    schema: {
      type: 'array',
      prefixItems: [{ type: 'string' }, { type: 'number' }],
      items: false,
      minItems: 2,
    },
    valid: [['a', 2]],
    invalidShape: [['a'], ['a', 2, 3], ['a', 'b']],
    invalidWidened: [],
  },
  {
    name: 'Empty',
    build: () => Empty,
    schema: { type: 'object', additionalProperties: false },
    valid: [{}],
    invalidShape: [{ a: 1 }, 'x', 5],
    invalidWidened: [],
  },
  {
    name: 'Job',
    normalize: PEN_NORMALIZE,
    build: () => Job,
    schema: {
      type: 'object',
      properties: {
        cmd: { type: 'string' },
        retries: { type: 'integer', default: 3 },
      },
      required: ['cmd', 'retries'],
    },
    valid: [{ cmd: 'ls', retries: 0 }],
    invalidShape: [{ retries: 1 }, { cmd: 'ls', retries: 'x' }],
    invalidWidened: [{ cmd: 'ls', retries: 1.5 }],
    rawInput: [{ cmd: 'ls' }],
  },

  // ——— the pen's own rows ———
  {
    name: 'Scalars',
    build: () => Scalars,
    schema: {
      type: 'object',
      properties: {
        s: { type: 'string' }, n: { type: 'number' }, i: { type: 'integer' },
        b: { type: 'boolean' }, z: { type: 'null' },
      },
      required: ['s', 'n', 'i', 'b', 'z'],
      additionalProperties: false,
    },
    valid: [{ s: 'a', n: 1.5, i: 2, b: true, z: null }],
    invalidShape: [{ s: 1, n: 1.5, i: 2, b: true, z: null }, { s: 'a', n: 1.5, i: 2, b: true }],
    invalidWidened: [{ s: 'a', n: 1.5, i: 2.5, b: true, z: null }],
  },
  {
    name: 'Literals',
    build: () => Literals,
    schema: {
      type: 'object',
      properties: { kind: { const: 'a' }, on: { const: true }, n: { const: 1 } },
      required: ['kind', 'on', 'n'],
      additionalProperties: false,
    },
    valid: [{ kind: 'a', on: true, n: 1 }],
    invalidShape: [{ kind: 'b', on: true, n: 1 }, { kind: 'a', on: false, n: 1 }, { kind: 'a', on: true, n: 2 }],
    invalidWidened: [],
  },
  {
    name: 'Enums',
    build: () => Enums,
    schema: {
      type: 'object',
      properties: {
        role: { enum: ['admin', 'user'] },
        mood: { enum: ['up', 'down', null] },
        tag: { enum: ['x', null] },
      },
      required: ['role', 'mood'],
      additionalProperties: false,
    },
    valid: [{ role: 'admin', mood: null }, { role: 'user', mood: 'up', tag: 'x' }, { role: 'user', mood: 'down', tag: null }],
    invalidShape: [{ role: 'owner', mood: null }, { role: 'admin', mood: 'flat' }, { role: 'admin', mood: null, tag: 'y' }],
    invalidWidened: [],
  },
  {
    name: 'Nullables',
    build: () => Nullables,
    schema: {
      type: 'object',
      properties: {
        name: { type: ['string', 'null'] },
        age: { type: ['integer', 'null'] },
      },
      required: ['name'],
      additionalProperties: false,
    },
    valid: [{ name: null }, { name: 'a', age: null }, { name: 'a', age: 3 }],
    invalidShape: [{}, { name: 1 }, { name: 'a', age: 'x' }],
    invalidWidened: [{ name: 'a', age: 1.5 }],
  },
  {
    name: 'StringRules',
    build: () => StringRules,
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        mail: { type: 'string', format: 'email' },
        site: { type: 'string', format: 'uri' },
        code: { type: 'string', minLength: 4, maxLength: 4 },
        slug: { type: 'string', minLength: 1, maxLength: 20, pattern: '^[a-z-]+$' },
      },
      required: ['id', 'mail', 'site', 'code', 'slug'],
      additionalProperties: false,
    },
    valid: [{ id: '123e4567-e89b-12d3-a456-426614174000', mail: 'a@b.co', site: 'https://x.y/', code: 'abcd', slug: 'a-b' }],
    invalidShape: [{ id: 1, mail: 'a@b.co', site: 'https://x.y/', code: 'abcd', slug: 'a-b' }],
    invalidWidened: [
      { id: 'nope', mail: 'a@b.co', site: 'https://x.y/', code: 'abcd', slug: 'a-b' },
      { id: '123e4567-e89b-12d3-a456-426614174000', mail: 'a@b.co', site: 'https://x.y/', code: 'abc', slug: 'A' },
    ],
  },
  {
    name: 'NumberRules',
    build: () => NumberRules,
    schema: {
      type: 'object',
      properties: {
        a: { type: 'number', minimum: 0, maximum: 10 },
        b: { type: 'integer', exclusiveMinimum: 0, exclusiveMaximum: 5 },
        c: { type: 'number', multipleOf: 0.5 },
        d: { type: 'integer' },
      },
      required: ['a', 'b', 'c', 'd'],
      additionalProperties: false,
    },
    valid: [{ a: 10, b: 4, c: 1.5, d: 7 }],
    invalidShape: [{ a: '1', b: 4, c: 1.5, d: 7 }],
    invalidWidened: [{ a: 11, b: 4, c: 1.5, d: 7 }, { a: 1, b: 5, c: 1.5, d: 7 }, { a: 1, b: 1, c: 0.3, d: 7 }, { a: 1, b: 1, c: 1, d: 7.5 }],
  },
  {
    name: 'Dates',
    build: () => Dates,
    schema: {
      type: 'object',
      properties: {
        at: { type: 'string', format: 'date-time' },
        on: { type: 'string', format: 'date' },
        t: { type: 'string', format: 'time' },
        d: { type: 'string', format: 'duration' },
        seen: { type: ['string', 'null'], format: 'date-time' },
        stamps: { type: 'array', items: { type: 'string', format: 'date-time' } },
      },
      required: ['at', 'on', 't', 'd'],
      additionalProperties: false,
    },
    valid: [
      { at: '2024-01-01T00:00:00Z', on: '2024-01-01', t: '10:00:00Z', d: 'P1D' },
      { at: '2024-01-01T00:00:00Z', on: '2024-01-01', t: '10:00:00Z', d: 'P1D', seen: null, stamps: ['2024-01-01T00:00:00Z'] },
    ],
    invalidShape: [{ at: 1, on: '2024-01-01', t: '10:00:00Z', d: 'P1D' }],
    invalidWidened: [{ at: 'yesterday', on: '2024-01-01', t: '10:00:00Z', d: 'P1D' }],
  },
  {
    name: 'ArrayRules',
    build: () => ArrayRules,
    schema: {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3, uniqueItems: true },
        pair: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2 },
        has: { type: 'array', items: { type: 'number' }, contains: { const: 0 } },
      },
      required: ['tags', 'pair', 'has'],
      additionalProperties: false,
    },
    valid: [{ tags: ['a'], pair: [1, 2], has: [3, 0] }],
    invalidShape: [{ tags: [1], pair: [1, 2], has: [0] }],
    invalidWidened: [{ tags: [], pair: [1, 2], has: [0] }, { tags: ['a', 'a'], pair: [1, 2], has: [0] }, { tags: ['a'], pair: [1], has: [0] }, { tags: ['a'], pair: [1, 2], has: [1] }],
  },
  {
    name: 'Tuples',
    build: () => Tuples,
    schema: {
      type: 'object',
      properties: {
        open: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }], minItems: 2 },
        tail: { type: 'array', prefixItems: [{ type: 'string' }], items: { type: 'boolean' }, minItems: 1 },
        exact: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }], items: false, minItems: 2 },
      },
      required: ['open', 'tail', 'exact'],
      additionalProperties: false,
    },
    valid: [{ open: ['a', 1, 'anything'], tail: ['a', true, false], exact: ['a', 1] }],
    invalidShape: [{ open: ['a'], tail: ['a'], exact: ['a', 1] }, { open: ['a', 1], tail: ['a', 1], exact: ['a', 1] }, { open: ['a', 1], tail: ['a'], exact: ['a', 1, 2] }],
    invalidWidened: [],
  },
  {
    name: 'Dict',
    build: () => Dict,
    schema: { type: 'object', additionalProperties: { type: 'integer' } },
    valid: [{}, { a: 1, b: 2 }],
    invalidShape: [{ a: 'x' }, [], 'x'],
    invalidWidened: [{ a: 1.5 }],
  },
  {
    name: 'Either',
    build: () => Either,
    schema: {
      type: 'object',
      properties: {
        v: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        w: {
          anyOf: [
            { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false },
            { type: 'object', properties: { b: { type: 'number' } }, required: ['b'], additionalProperties: false },
          ],
        },
      },
      required: ['v'],
      additionalProperties: false,
    },
    valid: [{ v: 'a' }, { v: 1, w: { a: 'x' } }, { v: 1, w: { b: 2 } }],
    invalidShape: [{ v: true }, { v: 1, w: { a: 1 } }, { v: 1, w: { a: 'x', b: 2 } }],
    invalidWidened: [],
  },
  {
    name: 'Shape',
    build: () => Shape,
    schema: {
      oneOf: [
        { type: 'object', properties: { kind: { const: 'circle' }, r: { type: 'number' } }, required: ['kind', 'r'], additionalProperties: false },
        { type: 'object', properties: { kind: { const: 'square' }, side: { type: 'number' } }, required: ['kind', 'side'], additionalProperties: false },
      ],
    },
    valid: [{ kind: 'circle', r: 1 }, { kind: 'square', side: 2 }],
    invalidShape: [{ kind: 'circle', side: 2 }, { kind: 'oval' }, { r: 1 }],
    invalidWidened: [],
  },
  {
    name: 'Both',
    build: () => Both,
    schema: {
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] },
      ],
    },
    valid: [{ a: 'x', b: 1 }, { a: 'x', b: 1, c: true }],
    invalidShape: [{ a: 'x' }, { b: 1 }, { a: 1, b: 1 }],
    invalidWidened: [],
  },
  {
    name: 'Tree',
    build: () => Node,
    schema: {
      $defs: {
        Node: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            children: { type: 'array', items: { $ref: '#/$defs/Node' } },
          },
          required: ['label'],
          additionalProperties: false,
        },
      },
      $ref: '#/$defs/Node',
    },
    valid: [{ label: 'root' }, { label: 'root', children: [{ label: 'kid', children: [] }] }],
    invalidShape: [{ label: 1 }, { children: [] }, { label: 'root', children: [{ notALabel: true }] }],
    invalidWidened: [],
  },
  {
    name: 'Linked',
    build: () => Linked,
    schema: {
      $defs: {
        Node: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            children: { type: 'array', items: { $ref: '#/$defs/Node' } },
          },
          required: ['label'],
          additionalProperties: false,
        },
      },
      type: 'object',
      properties: { head: { $ref: '#/$defs/Node' }, tail: { $ref: '#/$defs/Node' } },
      required: ['head'],
      additionalProperties: false,
    },
    valid: [{ head: { label: 'a' } }, { head: { label: 'a' }, tail: { label: 'b', children: [] } }],
    invalidShape: [{ tail: { label: 'b' } }, { head: { label: 'a' }, tail: 1 }],
    invalidWidened: [],
  },
  {
    name: 'Conditional',
    build: () => Conditional,
    schema: {
      allOf: [
        { type: 'object', properties: { k: { type: 'string' }, v: {} }, required: ['k', 'v'] },
        {
          if: { type: 'object', properties: { k: { const: 'a' } }, required: ['k'] },
          then: { type: 'object', properties: { v: { type: 'string' } }, required: ['v'] },
          else: { type: 'object', properties: { v: { type: 'number' } }, required: ['v'] },
        },
      ],
    },
    valid: [{ k: 'a', v: 'x' }, { k: 'b', v: 1 }],
    invalidShape: [{ v: 'x' }, { k: 'a' }],
    invalidWidened: [{ k: 'a', v: 1 }, { k: 'b', v: 'x' }],
  },
  {
    name: 'Wrapped',
    build: () => Wrapped,
    schema: {
      type: 'object',
      properties: {
        meta: { type: 'object', properties: { a: { type: 'string' } } },
        anything: {},
        nothing: false,
        yes: true,
      },
      required: ['meta', 'anything'],
      additionalProperties: false,
    },
    valid: [{ meta: {}, anything: null }, { meta: { a: 'x', b: 1 }, anything: [1], yes: 'y' }],
    invalidShape: [{ meta: { a: 1 }, anything: 1 }, { meta: {}, anything: 1, nothing: 1 }, { anything: 1 }],
    invalidWidened: [],
  },
  {
    name: 'Members',
    build: () => Members,
    schema: {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a'],
      dependentRequired: { a: ['b'] },
      minProperties: 1,
      maxProperties: 9,
    },
    valid: [{ a: 'x', b: 1 }, { a: 'x', b: 1, c: true }],
    invalidShape: [{ a: 1, b: 1 }, { b: 1 }],
    invalidWidened: [{ a: 'x' }],
  },
  {
    name: 'Patterned',
    build: () => Patterned,
    schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
      patternProperties: { '^x-': { type: 'number' } },
    },
    valid: [{ id: 'a' }, { id: 'a', 'x-1': 2 }],
    invalidShape: [{ id: 'a', other: 1 }, { id: 'a', 'x-1': 'no' }, { 'x-1': 1 }],
    invalidWidened: [],
  },
  {
    name: 'Keyed',
    build: () => Keyed,
    schema: {
      type: 'object',
      propertyNames: { type: 'string', pattern: '^[a-z]+$' },
    },
    valid: [{}, { abc: 1 }],
    invalidShape: [[], 'x'],
    invalidWidened: [{ ABC: 1 }],
  },
  {
    name: 'Derived',
    build: () => Derived,
    schema: {
      type: 'object',
      properties: {
        one: {
          type: 'object',
          properties: { id: { type: 'string' }, age: { type: 'integer' }, email: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
        two: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
          additionalProperties: false,
        },
      },
      required: ['one'],
      additionalProperties: false,
    },
    valid: [{ one: { id: 'a' } }, { one: { id: 'a', age: 1, email: 'e' }, two: { name: 'n' } }],
    invalidShape: [{ one: { age: 1 } }, { one: { id: 'a', name: 'n' } }, { one: { id: 'a' }, two: {} }],
    invalidWidened: [],
  },
  {
    name: 'Invoice',
    build: () => Invoice,
    schema: {
      type: 'object',
      properties: {
        lines: {
          type: 'array',
          items: { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'], additionalProperties: false },
        },
        total: { type: 'number' },
      },
      required: ['lines', 'total'],
      additionalProperties: false,
      $query: { $eq: ['$.total', { $sum: '$.lines[*].amount' }] },
    },
    valid: [{ lines: [{ amount: 12.5 }, { amount: 7.5 }], total: 20 }],
    invalidShape: [{ lines: [{ amount: 'x' }], total: 1 }, { total: 1 }],
    invalidWidened: [{ lines: [{ amount: 12.5 }, { amount: 7.5 }], total: 21 }],
  },
  {
    name: 'Order',
    build: () => Order,
    schema: {
      type: 'object',
      properties: {
        currency: { type: 'string' },
        start: { type: 'string', format: 'date-time' },
        end: { type: 'string', format: 'date-time' },
        lines: {
          type: 'array',
          items: {
            type: 'object',
            properties: { qty: { type: 'integer' }, currency: { type: 'string' } },
            required: ['qty', 'currency'],
            additionalProperties: false,
            $query: { $eq: ['$root.currency', '$.currency'] },
          },
        },
      },
      required: ['currency', 'start', 'end', 'lines'],
      additionalProperties: false,
      $query: {
        $and: [
          { $le: ['$.start', '$.end'] },
          { $every: { l: '$.lines[*]' }, $satisfies: { $gt: ['$l.qty', 0] } },
        ],
      },
    },
    valid: [{ currency: 'EUR', start: '2024-01-01T00:00:00Z', end: '2024-01-02T00:00:00Z', lines: [{ qty: 1, currency: 'EUR' }] }],
    invalidShape: [{ currency: 'EUR', start: '2024-01-01T00:00:00Z', end: '2024-01-02T00:00:00Z', lines: [{ qty: 1 }] }],
    invalidWidened: [
      { currency: 'EUR', start: '2024-01-02T00:00:00Z', end: '2024-01-01T00:00:00Z', lines: [] },
      { currency: 'EUR', start: '2024-01-01T00:00:00Z', end: '2024-01-02T00:00:00Z', lines: [{ qty: 0, currency: 'EUR' }] },
      { currency: 'EUR', start: '2024-01-01T00:00:00Z', end: '2024-01-02T00:00:00Z', lines: [{ qty: 1, currency: 'USD' }] },
    ],
  },
  {
    name: 'Coerced',
    normalize: PEN_NORMALIZE,
    build: () => Coerced,
    schema: {
      type: 'object',
      properties: {
        port: { type: 'integer', 'x-coerce': true },
        on: { type: 'boolean', 'x-coerce': true },
        name: { type: 'string', 'x-trim': true },
        ratio: { type: 'number', 'x-coerce': true, default: 1 },
        label: { type: ['string', 'null'] },
      },
      required: ['port', 'name', 'ratio'],
      additionalProperties: false,
    },
    valid: [{ port: 80, name: 'a', ratio: 0.5 }, { port: 80, on: true, name: 'a', ratio: 1, label: null }],
    invalidShape: [{ port: 'x', name: 'a', ratio: 1 }, { name: 'a', ratio: 1 }],
    invalidWidened: [{ port: 1.5, name: 'a', ratio: 1 }],
    rawInput: [{ port: '80', name: ' a ' }, { port: 80, on: 'true', name: 'a', ratio: '2' }],
  },
  {
    // the emit corpus's Level: a TYPED enum, where coercion widens the
    // accepted side by the one source primitive that can reach a member
    name: 'Level',
    normalize: PEN_NORMALIZE,
    build: () => Level,
    schema: {
      type: 'object',
      properties: {
        level: { type: 'integer', enum: [1, 2, 3], 'x-coerce': true },
        role: { type: ['string', 'null'], enum: ['admin', 'user', null] },
      },
      required: ['level'],
      additionalProperties: false,
    },
    valid: [{ level: 2 }, { level: 1, role: null }, { level: 3, role: 'admin' }],
    invalidShape: [{ level: 4 }, { level: true }, { level: 1, role: 'owner' }],
    invalidWidened: [],
    rawInput: [{ level: '2' }],
  },
  {
    name: 'Annotated',
    build: () => Annotated,
    schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The id',
          title: 'Id',
          examples: ['abc', 'def'],
          'x-vendor': { a: 1 },
          deprecated: true,
          errorMessage: 'need an id',
        },
        n: { type: 'integer', minimum: 18, errorMessage: { minimum: 'Must be an adult', _: 'Invalid age' } },
      },
      required: ['id'],
      additionalProperties: false,
      title: 'Annotated',
      description: 'An annotated object',
    },
    valid: [{ id: 'abc' }, { id: 'abc', n: 20 }],
    invalidShape: [{ id: 1 }, {}],
    invalidWidened: [{ id: 'abc', n: 17 }],
  },
];
