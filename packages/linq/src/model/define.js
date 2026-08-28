//@ts-check
/**
 * @file `defineModel({ entities, collections })` — one `$model` 0.1
 * document, deep-frozen, that `openStore` accepts unchanged. The pen
 * refuses here only what it can see and the store's model walk would
 * refuse anyway: a relation whose target is not a declared entity, a
 * store-allocated default on a composite key, a collection spec where
 * an entity was expected. Inverse agreement, foreign-key types and the
 * rest stay the engine's (`JD00xx`), never re-implemented.
 */

import { deepFreeze, setObjectMember } from '@jarenjs/core/object';

import { LinqBuildError } from '../errors.js';
import { isSchemaBuilder } from '../schema/brand.js';
import { COLLECTION } from './collection.js';

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** @param {any} value @param {string} what @returns {Record<string, any>} */
function requireMap(value, what) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LinqBuildError('JL0101', `defineModel() ${what} is a plain object of declarations`);
  }
  for (const name of Object.keys(value)) {
    if (!NAME.test(name)) {
      throw new LinqBuildError('JL0101',
        `defineModel() ${what} names are identifiers, got '${name}'`, `/${what}`);
    }
  }
  return value;
}

/**
 * The `x-entity` blocks an entity declares, by member, read from the
 * builder before its document is assembled.
 * @param {any} builder
 * @returns {[string, any][]}
 */
function entityBlocks(builder) {
  const st = builder.state;
  if (st.kind !== 'object') return [];
  return st.props.map(([name, member]) => [name, member.annotation('x-entity') ?? {}]);
}

/**
 * Build the model document.
 * @param {{ entities?: Record<string, any>, collections?: Record<string, any> }} spec
 * @returns {any} the deep-frozen `$model` 0.1 document
 */
export function defineModel(spec) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new LinqBuildError('JL0101', 'defineModel() takes { entities?, collections? }');
  }
  for (const key of Object.keys(spec)) {
    if (key !== 'entities' && key !== 'collections') {
      throw new LinqBuildError('JL0101', `defineModel() does not take '${key}'`);
    }
  }
  if (spec.entities === undefined && spec.collections === undefined) {
    throw new LinqBuildError('JL0101', 'defineModel() needs entities, collections, or both');
  }
  const out = { $model: '0.1' };

  if (spec.collections !== undefined) {
    const collections = requireMap(spec.collections, 'collections');
    const emitted = {};
    for (const name of Object.keys(collections)) {
      const declared = collections[name];
      if (declared === null || typeof declared !== 'object' || declared[COLLECTION] !== true) {
        throw new LinqBuildError('JL0101',
          `collections.${name} is not a collection() declaration`, `/collections/${name}`);
      }
      setObjectMember(emitted, name, declared);
    }
    out.collections = emitted;
  }

  if (spec.entities !== undefined) {
    const entities = requireMap(spec.entities, 'entities');
    const names = Object.keys(entities);
    const emitted = {};
    for (const name of names) {
      const at = `/entities/${name}`;
      const builder = entities[name];
      if (builder !== null && typeof builder === 'object' && builder[COLLECTION] === true) {
        throw new LinqBuildError('JL0102',
          `entities.${name} is a collection() declaration — an entity has no key pointer and no `
          + 'indexes option: its key is key() on a member and its indexes are unique()/index() '
          + 'per member (the vocabulary has no composite or derived entity index)', at);
      }
      if (!isSchemaBuilder(builder)) {
        throw new LinqBuildError('JL0101', `entities.${name} is not a schema builder`, at);
      }
      const blocks = entityBlocks(builder);
      const keys = blocks.filter(([, block]) => block.key === true);
      for (const [member, block] of blocks) {
        const memberAt = `${at}/schema/properties/${member}/x-entity`;
        const relation = block.relation;
        if (relation !== undefined && !names.includes(relation.to)) {
          throw new LinqBuildError('JL0102',
            `relation target '${relation.to}' on ${name}.${member} is not a declared entity — `
            + `the model declares ${names.map((n) => `'${n}'`).join(', ')}`,
            `${memberAt}/relation/to`);
        }
        if ((block.default === 'auto' || block.default === 'uuid') && keys.length > 1) {
          throw new LinqBuildError('JL0102',
            `identity('${block.default}') on ${name}.${member}: a store-allocated key is a SINGLE `
            + `key, and ${name} declares a composite one (${keys.map(([k]) => k).join(', ')})`,
            `${memberAt}/default`);
        }
      }
      const entity = { schema: builder.schema };
      if (builder.state.renamedFrom !== undefined) entity['x-rename'] = builder.state.renamedFrom;
      setObjectMember(emitted, name, entity);
    }
    out.entities = emitted;
  }
  return deepFreeze(out);
}
