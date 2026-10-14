//@ts-check
/**
 * @file A rebuild that retypes a number, an integer or a boolean member to
 * text: the values, the model, and the run that reads the text back through
 * the store. The text each must read back as is JavaScript's `String()` of the
 * value the store read before. Shared by the engines' file and the bun:sqlite
 * run.
 */
import { migrate, planModelMigration } from '@jarenjs/db';

/** Numbers whose spelling both engines write exactly: integers, fractions,
 * negative zero, the bounds of the fixed notation (1e-7 and 1e21), the double
 * range's ends, and the shortest spellings of 16 and 17 digits. */
export const NUMBERS = Object.freeze([5, -5, 0, -0, 0.1, -0.1, 0.5, 81.125, 1 / 3, 2 / 3, 0.1 + 0.2, 4.35, 100, 123.456,
  1e-6, 1.234e-6, 1e-7, -1e-7, 1.5e-7, 1e-5, 2 ** 53, 2 ** 60, 1e20, 123456789012345680000, 1e21, -1e21, 1.5e300,
  5e-324, 2 ** -1022, 1.7976931348623157e308, -1.7976931348623157e308]);

/** @param {string} type */
export const textModel = (type) => ({ $model: '0.1', entities: { T: { schema: { type: 'object', required: ['id'], properties: {
  id: { type: 'string', 'x-entity': { key: true } }, v: { type } } } } } });

/**
 * Store each value as a `from` member, retype the member to text by a planned
 * rebuild, and read each back through the store.
 * @param {{ open: (model: any) => Promise<any>, target: any, dialect: any }} handles
 * @param {string} from @param {readonly unknown[]} values
 * @returns {Promise<{ texts: unknown[], migration: any }>}
 */
export async function retypeToText({ open, target, dialect }, from, values) {
  const id = (/** @type {number} */ at) => `r${String(at).padStart(3, '0')}`;
  const store = await open(textModel(from));
  try { for (const [at, v] of values.entries()) await store.entity('T').create({ id: id(at), v }); }
  finally { await store.close(); }
  const { migration } = planModelMigration(textModel(from), textModel('string'), { dialect, id: 'to-text' });
  migration.steps = migration.steps.filter((/** @type {any} */ step) => step.draft !== true);
  await migrate(target, [migration], { baseline: textModel(from), model: textModel('string'), shadow: false });
  const after = await open(textModel('string'));
  try {
    const texts = [];
    for (const at of values.keys()) texts.push((await after.entity('T').asNoTracking().get(id(at)))?.v);
    return { texts, migration };
  }
  finally { await after.close(); }
}
