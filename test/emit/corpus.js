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
];
