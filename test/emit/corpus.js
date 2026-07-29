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
    valid: [{ id: 'abc' }, { id: 'abc', age: 3, role: 'admin', tags: ['x'] }],
    invalidShape: [
      { id: 42 },
      { age: 1 },
      { id: 'abc', role: 'owner' },
      { id: 'abc', tags: [1] },
    ],
    invalidWidened: [{ id: 'ab' }],
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
];
