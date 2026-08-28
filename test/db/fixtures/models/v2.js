//@ts-check
/**
 * @file The second shape: `User` gains a required `handle` (a mapped
 * column the transform must fill from the old row) and an optional `bio`.
 */
import * as m from '@jarenjs/linq/model';

export const User = m.object({
  id: m.string().key(),
  name: m.string(),
  age: m.integer().optional(),
  handle: m.string().unique(),
  bio: m.string().optional(),
});

export const model = m.defineModel({ entities: { User } });
export default model;
