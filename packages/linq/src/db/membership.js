//@ts-check
/**
 * @file `link`/`unlink` on a handle: the relation table decides. The
 * member must be a many-to-many relation of the entity — `JL0107`
 * otherwise, naming the kind it is or the members that are declared —
 * and then the store's own `link`/`unlink` record the change
 * (MODEL-FORMAT §11.7) for `saveChanges()` to write. The store would
 * refuse the same members itself (`JD2003`); the client sees it earlier
 * from the table it already reads, mirrored, never invented.
 */

import { LinqBuildError } from '../errors.js';

/**
 * The many-to-many relation entry a membership operation names.
 * @param {Record<string, any>} relations - the handle's relation table
 * @param {string} entityName
 * @param {string} member
 * @param {string} verb - `link` or `unlink`, for the message
 * @returns {any} the relation entry
 */
export function requireMembership(relations, entityName, member, verb) {
  const entry = relations[member];
  if (entry === undefined) {
    const declared = Object.keys(relations).filter((name) => relations[name].kind === 'manyToMany');
    throw new LinqBuildError('JL0107',
      `'${member}' is not a relation member of '${entityName}' — ${verb}() attaches a many-to-many `
      + `membership${declared.length === 0 ? `, and '${entityName}' declares none`
        : ` (${declared.map((name) => `'${name}'`).join(', ')})`}`);
  }
  if (entry.kind !== 'manyToMany') {
    throw new LinqBuildError('JL0107',
      `'${member}' is a ${entry.kind} relation of '${entityName}' — ${verb}() attaches many-to-many `
      + "memberships only; write the related entity's foreign key instead");
  }
  return entry;
}
