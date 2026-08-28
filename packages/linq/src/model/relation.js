//@ts-check
/**
 * @file Relation members: `rel.hasMany`, `rel.hasOne`, `rel.belongsToMany`
 * — each a builder of no type (`{}`) whose `x-entity.relation` block is
 * the whole member, spelled exactly as MODEL-FORMAT §9.4's three kinds.
 * A relation member is a projection, never stored state, so every
 * relation builder is `optional()` by construction. The target is an
 * entity NAME; whether it is declared is `defineModel`'s question.
 */

import { LinqBuildError } from '../errors.js';
import { initial, requireName } from '../schema/builders.js';

const ON_DELETE = new Set(['cascade', 'restrict', 'setNull']);

/**
 * @param {any} options
 * @param {string} what
 * @returns {{ via: string, onDelete: string }}
 */
function foreignKeyOptions(options, what) {
  if (options === null || typeof options !== 'object') {
    throw new LinqBuildError('JL0101', `${what} takes { via, onDelete }`);
  }
  const via = requireName(options.via, `${what} via`);
  if (!ON_DELETE.has(options.onDelete)) {
    throw new LinqBuildError('JL0101',
      `${what} must declare onDelete: 'cascade', 'restrict' or 'setNull' — a foreign key is `
      + `never defaulted silently; got ${JSON.stringify(options.onDelete)}`);
  }
  for (const key of Object.keys(options)) {
    if (key !== 'via' && key !== 'onDelete') {
      throw new LinqBuildError('JL0101', `${what} does not take '${key}'`);
    }
  }
  return { via, onDelete: options.onDelete };
}

/**
 * The relation factories for one builder class.
 * @param {any} Base - the class a relation member is built from
 */
export function createRelations(Base) {
  const member = (relation) => new Base(initial('any', {}))
    .annotate('x-entity', Object.freeze({ relation: Object.freeze(relation) }))
    .with({ optional: true });
  return Object.freeze({
    /**
     * One-to-many: `{ to, many: true, via, onDelete }` — `via` names the
     * foreign key on the TARGET entity.
     * @param {string} to @param {{ via: string, onDelete: 'cascade' | 'restrict' | 'setNull' }} options
     */
    hasMany(to, options) {
      const { via, onDelete } = foreignKeyOptions(options, 'rel.hasMany()');
      return member({ to: requireName(to, 'rel.hasMany()'), many: true, via, onDelete });
    },
    /**
     * One-to-one (and the many-to-one side): `{ to, via, onDelete }` —
     * `via` names the foreign key on the DECLARING entity.
     * @param {string} to @param {{ via: string, onDelete: 'cascade' | 'restrict' | 'setNull' }} options
     */
    hasOne(to, options) {
      const { via, onDelete } = foreignKeyOptions(options, 'rel.hasOne()');
      return member({ to: requireName(to, 'rel.hasOne()'), via, onDelete });
    },
    /**
     * Many-to-many: `{ to, many: true, through? }` — a join table, named
     * `through` or the sorted `<A>_<B>`.
     * @param {string} to @param {{ through?: string }} [options]
     */
    belongsToMany(to, options = {}) {
      if (options === null || typeof options !== 'object') {
        throw new LinqBuildError('JL0101', 'rel.belongsToMany() takes { through? }');
      }
      for (const key of Object.keys(options)) {
        if (key !== 'through') {
          throw new LinqBuildError('JL0101', `rel.belongsToMany() does not take '${key}'`);
        }
      }
      const relation = { to: requireName(to, 'rel.belongsToMany()'), many: true };
      if (options.through !== undefined) relation.through = requireName(options.through, 'rel.belongsToMany() through');
      return member(relation);
    },
  });
}
