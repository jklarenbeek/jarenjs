//@ts-check
/**
 * @file The first shape of a model that evolves: `User` with a key, a
 * name and an optional age. The second shape is `v2.js`; a migration
 * between them is typed from these two modules' phantoms.
 */
import * as m from '@jarenjs/linq/model';

export const User = m.object({
  id: m.string().key(),
  name: m.string(),
  age: m.integer().optional(),
});

export const model = m.defineModel({ entities: { User } });
export default model;
