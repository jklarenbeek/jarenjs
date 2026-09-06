//@ts-check
/**
 * @file `@jarenjs/linq/model` — the database by code. The schema pen's
 * every name, rebuilt from SUBCLASSES that carry the `x-entity`
 * vocabulary (`key()`, `identity()`, `unique()`, `index()`, `column()`,
 * `now()`, `updated()`, `fill()`, `compute()`, `version()`,
 * `renamedFrom()`), the relation members (`rel.*`), collections and
 * their indexes, and `defineModel()` — one `$model` 0.1 document that
 * `openStore` accepts unchanged. Nothing here imports `@jarenjs/db`.
 */

import {
  SchemaBuilder, StringBuilder, NumberBuilder, ArrayBuilder, TupleBuilder,
  ObjectBuilder, WhenBuilder, NeverBuilder,
} from '../schema/builders.js';
import { createFactories } from '../schema/factories.js';
import { withEntity } from './entity.js';
import { createRelations } from './relation.js';

/** The entity-aware classes: new classes, one mixin, no patched prototype. */
export const EntityBuilder = withEntity(SchemaBuilder);
export const EntityStringBuilder = withEntity(StringBuilder);
export const EntityNumberBuilder = withEntity(NumberBuilder);
export const EntityArrayBuilder = withEntity(ArrayBuilder);
export const EntityTupleBuilder = withEntity(TupleBuilder);
export const EntityObjectBuilder = withEntity(ObjectBuilder);
export const EntityWhenBuilder = withEntity(WhenBuilder);
export const EntityNeverBuilder = withEntity(NeverBuilder);

export const {
  string, number, integer, boolean, nil, literal, enumOf,
  object, array, tuple, record, union, discriminated, intersection,
  named, ref, lazy, any, never, when, from, document,
  datetime, date, time, duration,
} = /** @type {any} */ (createFactories({
  Base: EntityBuilder, String: EntityStringBuilder, Number: EntityNumberBuilder,
  Array: EntityArrayBuilder, Tuple: EntityTupleBuilder, Object: EntityObjectBuilder,
  When: EntityWhenBuilder, Never: EntityNeverBuilder,
}));

/** The relation members: `rel.hasMany`, `rel.hasOne`, `rel.belongsToMany`. */
export const rel = createRelations(EntityBuilder);

export { collection, index, expressionIndex } from './collection.js';
export { defineModel } from './define.js';
export { withEntity } from './entity.js';
export { isSchemaBuilder, schemaOf, SCHEMA_BUILDER } from '../schema/brand.js';
