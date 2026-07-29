//@ts-check
/**
 * The agreement corpus: one source of truth read by three places — the
 * committed generated fixture, the type-level probe in test/consumer, and the
 * validator-side assertions in agreement.test.js.
 *
 * Each entry names a schema and three kinds of instance:
 *
 * - `valid`          — validates, and must type-check.
 * - `invalidShape`   — fails validation for a STRUCTURAL reason, so the
 *                      generated type must reject it too.
 * - `invalidWidened` — fails validation for a reason no type can carry
 *                      (`minLength`, `pattern`, `format`), so the type
 *                      necessarily accepts it. Asserted rather than hidden.
 *
 * An entry may also carry `normalize` options. Then the generated file holds
 * an accepted/normalized PAIR, and the corpus additionally names:
 *
 * - `rawInput`   — what a caller may hand in, which must satisfy the ACCEPTED
 *                  type and, once normalized, the NORMALIZED one.
 */
export const CORPUS = [
  {
    name: 'Account',
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
    // A JSON Schema object is OPEN unless it says otherwise, so the extra
    // member here is VALID and the generated type has to accept it. Emitting a
    // closed interface made the type narrower than the schema — it rejected a
    // document the service accepts, which is the one direction this generator
    // promises never to take.
    valid: [{ id: 'abc' }, { id: 'abc', age: 3, role: 'admin', tags: ['x'] },
      { id: 'abc', extra: true }],
    invalidShape: [
      { id: 42 },
      { age: 1 },
      { id: 'abc', role: 'owner' },
      { id: 'abc', tags: [1] },
    ],
    invalidWidened: [{ id: 'ab' }],
  },
  {
    // The mirror of Account: `additionalProperties: false` closes the object,
    // so here the extra member IS a structural failure and the type must
    // reject it. The pair pins the rule in both directions — without this one,
    // emitting an index signature unconditionally would still pass.
    name: 'Strict',
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
    name: 'Node',
    schema: {
      $defs: { Label: { type: 'string' } },
      type: 'object',
      properties: {
        label: { $ref: '#/$defs/Label' },
        children: { type: 'array', items: { $ref: '#' } },
      },
      required: ['label'],
    },
    valid: [{ label: 'root' }, { label: 'root', children: [{ label: 'kid', children: [] }] }],
    invalidShape: [{ label: 1 }, { children: [] }, { label: 'root', children: [{ notALabel: true }] }],
    invalidWidened: [],
  },
  {
    name: 'Config',
    normalize: { useDefaults: true, coerceTypes: true },
    schema: {
      type: 'object',
      properties: {
        host: { type: 'string', default: 'localhost' },
        port: { type: 'integer', default: 8080 },
        name: { type: 'string' },
      },
      required: ['name'],
    },
    // Already-normalized documents: valid to the validator as they stand.
    valid: [{ name: 'a', host: 'h', port: 1 }],
    invalidShape: [{ name: 1, host: 'h', port: 1 }],
    invalidWidened: [],
    // What a caller may actually hand in: defaults absent, port still a
    // string. The accepted type must take this; the normalized type must not.
    rawInput: [{ name: 'a', port: '9000' }],
  },
  {
    // A root that IS a reference: the root declaration must alias the target,
    // not collapse to unknown.
    name: 'Id',
    schema: { $defs: { Uuid: { type: 'string' } }, $ref: '#/$defs/Uuid' },
    valid: ['abc'],
    invalidShape: [1, {}, null],
    invalidWidened: [],
  },
  {
    // A plain-anchor $ref WITH siblings: since 2019-09 the siblings apply
    // alongside the target, so the type is the intersection of both — and the
    // anchor resolves exactly as the validator resolves it. The dialect is
    // declared because that is where the composition rule holds: the
    // validator's default draft still lets $ref shadow its siblings.
    name: 'Wide',
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $defs: {
        Base: {
          $anchor: 'base',
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
      $ref: '#base',
      type: 'object',
      properties: { extra: { type: 'number' } },
      required: ['extra'],
    },
    valid: [{ id: 'x', extra: 1 }, { id: 'x', extra: 1, more: true }],
    invalidShape: [{ extra: 1 }, { id: 'x' }, { id: 1, extra: 1 }, { id: 'x', extra: 'n' }],
    invalidWidened: [],
  },
  {
    // JSON Schema tuples are not fixed-length: prefixItems constrains the
    // positions that exist, minItems says how many must, and the omitted
    // `items` leaves the array OPEN. Shorter and longer arrays VALIDATE, so
    // the type has to accept them too.
    name: 'Pair',
    schema: {
      type: 'array',
      prefixItems: [{ type: 'string' }, { type: 'number' }],
      minItems: 1,
      maxItems: 4,
    },
    valid: [['a'], ['a', 2], ['a', 2, true, null]],
    invalidShape: [[], [1], ['a', 'b']],
    // maxItems is a dropped constraint, so the too-long array is the honest
    // widening: the validator says no, the open rest says yes.
    invalidWidened: [['a', 2, true, null, 'five']],
  },
  {
    // The closed mirror of Pair: `items: false` and a met minItems make this
    // a real fixed-length tuple, and only then is one emitted.
    name: 'Exact',
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
    // No `type` at all: `properties` does not make this an object. The
    // validator accepts every primitive without reading the applicators, so
    // the described shape is one union arm and the other JSON kinds fill in
    // the rest. Only a WRONG object is structurally invalid.
    name: 'Loose',
    schema: { properties: { a: { type: 'string' } }, required: ['a'] },
    valid: [{ a: 'x' }, 'hello', 42, true, null, [1, 'x']],
    invalidShape: [{ a: 1 }, {}],
    invalidWidened: [],
  },
  {
    // A closed object with no members. An empty interface is TypeScript's
    // weak-type escape hatch — a primitive satisfies it — so this pins the
    // Record<string, never> emission in both directions.
    name: 'Empty',
    schema: { type: 'object', additionalProperties: false },
    valid: [{}],
    invalidShape: [{ a: 1 }, 'x', 5],
    invalidWidened: [],
  },
  {
    // Literals versus accepted-side coercion: the normalizer coerces '2' to 2
    // BEFORE the enum check runs, so the accepted side must admit the
    // transport string while the normalized side stays the literal union.
    name: 'Level',
    normalize: { coerceTypes: true },
    schema: {
      type: 'object',
      properties: { level: { type: 'integer', enum: [1, 2, 3] } },
      required: ['level'],
    },
    valid: [{ level: 2 }],
    invalidShape: [{ level: 4 }, { level: true }],
    invalidWidened: [],
    rawInput: [{ level: '2' }],
  },
  {
    // A REQUIRED member with an enabled default may still be omitted by the
    // caller: the normalizer materializes it before validation runs. The
    // accepted side must not demand it. The 1.5 retries pin integer-ness as
    // a documented widening.
    name: 'Job',
    normalize: { useDefaults: true },
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
  {
    // Normalization does not reach into anyOf branches — compileNormalizer
    // does not descend them — so the branch's default is never materialized
    // and its integer is never coerced, on EITHER side of the variant pair.
    name: 'Choice',
    normalize: { useDefaults: true, coerceTypes: true },
    schema: {
      type: 'object',
      properties: {
        port: { type: 'integer', default: 8080 },
        opt: {
          anyOf: [
            {
              type: 'object',
              properties: {
                mode: { type: 'string', default: 'auto' },
                level: { type: 'integer' },
              },
            },
            { type: 'string' },
          ],
        },
      },
      required: ['port'],
    },
    valid: [
      { port: 1 },
      { port: 1, opt: {} },
      { port: 1, opt: 'x' },
      { port: 1, opt: { mode: 'a', level: 2 } },
    ],
    invalidShape: [{ port: 1, opt: 5 }, { port: 1, opt: { level: 'x' } }],
    invalidWidened: [],
    rawInput: [{ opt: {} }, { port: '9000', opt: { level: 3 } }],
  },
  {
    // A boolean root under normalization options: one declaration, not a
    // duplicated pair — a boolean schema has nothing normalization can change.
    name: 'Anything',
    normalize: { useDefaults: true },
    schema: true,
    valid: [1, 'x', null, { a: 1 }, []],
    invalidShape: [],
    invalidWidened: [],
  },
];
