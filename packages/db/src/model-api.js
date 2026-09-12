//@ts-check
/** Model metadata and read-only schema inspection without opening a store. */
export { normalizeEntities, explainMapping, compileEntityModel, relationTables } from './model.js';
export { readSchema, introspectModel, INTROSPECT_CODES } from './introspect.js';
