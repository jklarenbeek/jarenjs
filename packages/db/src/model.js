//@ts-check
/**
 * @file The entity model walk: `x-entity` normalization with a CLOSED
 * vocabulary, relation resolution with inverse agreement, and
 * `explainMapping` — the derived physical shape as plain data, so the
 * hybrid mapping rule is golden-testable rather than folklore.
 *
 * THE DESCENT DECISION (recorded here because TODO's D22 demands it
 * be explicit): six copies of the `properties`/`prefixItems`/`items`/
 * `allOf` descent spine exist in this repository, and this walk was
 * the candidate seventh. It is NOT one. The entity walk is
 * deliberately ONE level deep — it enumerates the TOP-LEVEL
 * properties of an entity schema, resolves `$ref` and shallow-merges
 * `allOf` at each property through the resolvers
 * `@jarenjs/validate/normalize` exports for exactly this purpose, and
 * never recurses further, because the mapping rule sends every nested
 * shape to the JSONB document wholesale. A consumer with no recursion
 * has no descent spine to share, so the shared-enumerator question
 * (three different termination strategies across the six copies)
 * stays open for the first consumer that actually recurses. No
 * seventh copy was added.
 */

import {
  collectSameDocumentAnchors, resolveSameDocumentRef,
} from '@jarenjs/validate/normalize';
import { compileJsonQuery } from '@jarenjs/json/query';

import { DbCompileError } from './errors.js';
import { normalizePhysical } from './physical.js';
import { normalizeInvariants } from './invariants.js';

/** The closed `x-entity` vocabulary; anything else is `JD0030`. */
const ENTITY_MEMBERS = new Set(['key', 'unique', 'index', 'default', 'column', 'relation', 'version']);
const RELATION_MEMBERS = new Set(['to', 'many', 'via', 'through', 'onDelete']);
const ON_DELETE = new Set(['cascade', 'restrict', 'setNull']);
const ENTITY_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SCALARS = new Set(['string', 'integer', 'number', 'boolean']);

/**
 * @param {string} reason
 * @param {string} docPath
 * @param {string} [code]
 * @returns {DbCompileError}
 */
function modelError(reason, docPath, code = 'JD0005') {
  return new DbCompileError(code, reason, docPath);
}

/**
 * Resolve a property subschema to its effective shape: follow a local
 * `$ref`, then shallow-merge `allOf` branches (last write wins for
 * scalars; the entity walk needs `type`, `format`, `enum` and
 * `x-entity`, nothing deeper).
 * @param {any} node
 * @param {any} root - the entity schema (same-document refs only)
 * @param {Map<string, any>} anchors
 * @param {string} docPath
 * @returns {any}
 */
function effectiveSchema(node, root, anchors, docPath) {
  if (node === null || typeof node !== 'object' || Array.isArray(node))
    return {};
  let resolved = node;
  if (typeof node.$ref === 'string') {
    const target = resolveSameDocumentRef(node.$ref, root, anchors);
    if (target === undefined) {
      throw modelError(`the $ref '${node.$ref}' does not resolve inside the entity schema`,
        docPath);
    }
    resolved = /** @type {any} */ (target);
  }
  if (!Array.isArray(resolved.allOf)) return resolved;
  const merged = { ...resolved };
  delete merged.allOf;
  for (const branch of resolved.allOf) {
    const flat = effectiveSchema(branch, root, anchors, docPath);
    for (const key of Object.keys(flat)) {
      if (!(key in merged)) merged[key] = flat[key];
    }
  }
  return merged;
}

/**
 * Normalize one property's `x-entity` block against the closed set.
 * @param {any} block
 * @param {string} docPath
 * @returns {any}
 */
function normalizeEntityBlock(block, docPath) {
  if (block === undefined) return {};
  if (block === null || typeof block !== 'object' || Array.isArray(block))
    throw modelError('x-entity must be an object', docPath);
  for (const member of Object.keys(block)) {
    if (!ENTITY_MEMBERS.has(member)) {
      throw new DbCompileError('JD0030',
        `unknown x-entity member '${member}' — the vocabulary is closed `
        + '(key, unique, index, default, column, relation, version) because a silently '
        + 'ignored mapping directive loses data',
        `${docPath}/${member}`);
    }
  }
  if (block.relation !== undefined) {
    const relation = block.relation;
    if (relation === null || typeof relation !== 'object' || Array.isArray(relation))
      throw modelError('x-entity.relation must be an object', `${docPath}/relation`);
    for (const member of Object.keys(relation)) {
      if (!RELATION_MEMBERS.has(member)) {
        throw new DbCompileError('JD0030',
          `unknown x-entity relation member '${member}'`,
          `${docPath}/relation/${member}`);
      }
    }
  }
  return block;
}

/**
 * Validate a default declaration.
 * @param {any} declared
 * @param {string} docPath
 */
function checkDefault(declared, docPath) {
  if (declared === 'now' || declared === 'updated' || declared === 'uuid'
    || declared === 'auto') return;
  if (declared !== null && typeof declared === 'object' && !Array.isArray(declared)
    && (Object.hasOwn(declared, 'value') !== Object.hasOwn(declared, 'query'))
    && Object.keys(declared).length === 1) {
    if (Object.hasOwn(declared, 'query')) {
      // compiled where the model is checked, not at the first
      // `store.entity()` call — a default that cannot compile is a model
      // defect, and the engine's reason travels with the model position
      try {
        compileJsonQuery(declared.query);
      }
      catch (cause) {
        throw new DbCompileError('JD0005',
          `the { query } default does not compile: ${/** @type {Error} */ (cause).message}`,
          docPath, /** @type {Error} */ (cause));
      }
    }
    return;
  }
  throw modelError(
    "a default is 'now', 'updated', 'uuid', 'auto', { value: … } or { query: … }",
    docPath);
}

/** The schema positions whose `x-entity` block the one-level walk READS:
 * a top-level property, an `allOf` branch of one (shallow-merged), and
 * a `$defs`/anchor target (a property's `$ref` resolves there). */
const READ_BLOCK_KEYS = new Set(['allOf', '$defs', 'definitions']);

/**
 * Find an `x-entity` block the entity walk would never read — nested
 * inside a property's `properties`, `items`, `anyOf`, … — so it fails
 * the model instead of being ignored. §9.2's promise: a silently
 * ignored mapping directive is a data-loss bug, so the vocabulary is
 * closed in POSITION as well as in name.
 * @param {any} node
 * @param {string} path
 * @param {boolean} read - whether a block AT this node is read
 * @returns {string | null} the docPath of an unread block
 */
function unreadEntityBlock(node, path, read) {
  if (node === null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const found = unreadEntityBlock(node[i], `${path}/${i}`, read);
      if (found !== null) return found;
    }
    return null;
  }
  for (const key of Object.keys(node)) {
    if (key === 'x-entity') {
      if (!read) return `${path}/x-entity`;
      continue;
    }
    // a block one level under a read position is read only through
    // `allOf`/`$defs`; under anything else it is out of the walk
    const found = unreadEntityBlock(node[key], `${path}/${key}`, read && READ_BLOCK_KEYS.has(key));
    if (found !== null) return found;
  }
  return null;
}

/**
 * Normalize the `entities` member of a model document.
 * @param {any} model
 * @returns {Map<string, any>} entity name -> normalized entity
 */
export function normalizeEntities(model) {
  const declared = model?.entities;
  if (declared === undefined) return new Map();
  if (declared === null || typeof declared !== 'object' || Array.isArray(declared)
    || Object.keys(declared).length === 0)
    throw modelError('entities must be a non-empty object', '/entities');

  /** @type {Map<string, any>} */
  const entities = new Map();
  for (const name of Object.keys(declared)) {
    const docPath = `/entities/${name}`;
    if (!ENTITY_NAME.test(name))
      throw modelError(`entity names are identifiers, got '${name}'`, '/entities');
    const spec = declared[name];
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec))
      throw modelError('an entity must be an object', docPath);
    const schema = spec.schema;
    if (schema === null || typeof schema !== 'object' || Array.isArray(schema)
      || schema.properties === null || typeof schema.properties !== 'object')
      throw modelError('an entity needs an object schema with properties',
        `${docPath}/schema`);

    const anchors = collectSameDocumentAnchors(schema);
    const properties = new Map();
    const keys = [];
    const relations = [];
    for (const propertyName of Object.keys(schema.properties)) {
      const propertyPath = `${docPath}/schema/properties/${propertyName}`;
      const raw = schema.properties[propertyName];
      const effective = effectiveSchema(raw, schema, anchors, propertyPath);
      const entityBlock = normalizeEntityBlock(
        effective['x-entity'] ?? (raw !== null && typeof raw === 'object'
          ? raw['x-entity'] : undefined),
        `${propertyPath}/x-entity`);

      // a nullable scalar (`['string', 'null']`) is that scalar; a union
      // of two or more scalar types has no one column type and lives in
      // the document (§9.3) — mapping it by its FIRST member stored `5`
      // as `"5.0"` in a text column
      const scalarMembers = Array.isArray(effective.type)
        ? effective.type.filter((t) => t !== 'null')
        : [effective.type];
      const type = scalarMembers.length === 1 && typeof scalarMembers[0] === 'string'
        ? scalarMembers[0]
        : undefined;
      const union = scalarMembers.length > 1;

      if (entityBlock.default !== undefined)
        checkDefault(entityBlock.default, `${propertyPath}/x-entity/default`);
      if (entityBlock.default !== undefined && entityBlock.relation !== undefined) {
        throw modelError('a relation member takes no default — it is a projection, not stored state',
          `${propertyPath}/x-entity/default`);
      }
      if (entityBlock.default === 'auto' && entityBlock.key !== true) {
        throw modelError("default: 'auto' is allocated by the database for a single integer key only",
          `${propertyPath}/x-entity/default`);
      }
      // the mapping directives that need a column of their own: on a
      // property the document keeps — `column: 'json'`, a non-scalar, a
      // union — they were accepted and never applied (a key with no key
      // column let duplicates in and broke every read)
      const columnMapped = SCALARS.has(type ?? '') && entityBlock.column !== 'json';
      const needsColumn = ['key', 'unique', 'index'].filter((member) => entityBlock[member] === true);
      if (!columnMapped && needsColumn.length > 0) {
        const why = entityBlock.column === 'json'
          ? "column: 'json' keeps the property in the document"
          : union ? 'a union of scalar types lives in the document'
            : 'only a top-level scalar takes a column';
        throw modelError(entityBlock.key === true
          ? `a key property must be a scalar with a column of its own — ${why}`
          : `'${propertyName}' declares ${needsColumn.join('/')} but has no column — ${why}`,
          propertyPath);
      }
      for (const key of Object.keys(raw !== null && typeof raw === 'object' ? raw : {})) {
        if (key === 'x-entity') continue;
        const unread = unreadEntityBlock(raw[key], `${propertyPath}/${key}`, READ_BLOCK_KEYS.has(key));
        if (unread !== null) {
          throw new DbCompileError('JD0030',
            'x-entity applies to an entity\'s top-level properties (and their allOf/$ref '
            + 'targets) only — a nested block is never read, so it is refused rather than ignored',
            unread);
        }
      }
      if (entityBlock.column !== undefined
        && entityBlock.column !== 'integer' && entityBlock.column !== 'json') {
        throw modelError("x-entity.column is 'integer' (epoch date column) or 'json' (stay in the document)",
          `${propertyPath}/x-entity/column`);
      }
      if (entityBlock.column === 'integer'
        && !(type === 'string' && (effective.format === 'date-time' || effective.format === 'date'))) {
        throw modelError("column: 'integer' applies to date-time/date formatted strings",
          `${propertyPath}/x-entity/column`);
      }

      const property = {
        name: propertyName,
        docPath: propertyPath,
        type,
        format: typeof effective.format === 'string' ? effective.format : undefined,
        enum: Array.isArray(effective.enum)
          && effective.enum.every((v) => v === null || SCALARS.has(typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v))
          ? effective.enum : undefined,
        key: entityBlock.key === true,
        unique: entityBlock.unique === true,
        index: entityBlock.index === true,
        version: entityBlock.version === true,
        default: entityBlock.default,
        column: entityBlock.column,
        // COPIED: relation resolution annotates this object (kind,
        // fkEntity, joinTable) and must never write into the caller's
        // model document
        relation: entityBlock.relation === undefined
          ? undefined
          : { ...entityBlock.relation },
      };
      if (property.key) {
        if (!SCALARS.has(property.type ?? ''))
          throw modelError('a key property must be a scalar', propertyPath);
        keys.push(propertyName);
      }
      if (property.relation !== undefined) relations.push(property);
      properties.set(propertyName, property);
    }

    if (keys.length === 0)
      throw modelError(`entity '${name}' declares no key property`, docPath);
    const autoKeys = keys.filter((k) => properties.get(k).default === 'auto');
    const uuidKeys = keys.filter((k) => properties.get(k).default === 'uuid');
    if (autoKeys.length > 0 && (keys.length > 1
      || properties.get(autoKeys[0]).type !== 'integer'))
      throw modelError("default: 'auto' needs a single integer key", docPath);
    if (uuidKeys.length > 0 && (keys.length > 1
      || properties.get(uuidKeys[0]).type !== 'string'))
      throw modelError("default: 'uuid' needs a single string key", docPath);
    // the optimistic-concurrency token (§11.5): one integer, mapped to
    // its own column, never the key
    const versions = [...properties.values()].filter((p) => p.version);
    for (const p of versions) {
      if (p.type !== 'integer' || p.key || p.relation !== undefined
        || p.column !== undefined) {
        throw modelError('a version property is a plain integer column '
          + '(not a key, not a relation, not column-mapped)', p.docPath);
      }
    }
    if (versions.length > 1)
      throw modelError(`entity '${name}' declares more than one version property`, docPath);

    entities.set(name, {
      name,
      docPath,
      schema,
      properties,
      keys,
      relations,
      version: versions.length === 1 ? versions[0].name : null,
      physical: normalizePhysical(spec.physical, properties, keys, docPath),
      invariants: normalizeInvariants(spec.invariants, `${docPath}/invariants`),
    });
  }

  for (const entity of entities.values())
    if (entity.physical !== null && entity.relations.length) throw modelError('physical join tables are declared as entities; relation navigation is not qualified for column layouts', entity.docPath);
  resolveRelations(entities);
  return entities;
}

/**
 * Resolve every relation: shape checks, the foreign-key placement
 * rule, inverse agreement (`JD0031` on contradiction), and join
 * tables for many-to-many.
 * @param {Map<string, any>} entities
 */
function resolveRelations(entities) {
  /** @type {{ owner: string, property: any }[]} */
  const declarations = [];
  for (const entity of entities.values()) {
    for (const property of entity.relations)
      declarations.push({ owner: entity.name, property });
  }

  for (const { owner, property } of declarations) {
    const relation = property.relation;
    const docPath = `${property.docPath}/x-entity/relation`;
    if (typeof relation.to !== 'string' || !entities.has(relation.to)) {
      throw modelError(`relation target '${String(relation.to)}' is not a declared entity`,
        `${docPath}/to`);
    }
    const many = relation.many === true;
    const hasVia = relation.via !== undefined;
    const hasThrough = relation.through !== undefined;
    if (hasVia && hasThrough)
      throw modelError('a relation declares via (a foreign key) or through (a join table), not both', docPath);
    if (!many && hasThrough)
      throw modelError('through is for many-to-many relations', `${docPath}/through`);

    if (many && !hasVia) {
      // many-to-many: a join table
      relation.kind = 'manyToMany';
      const other = relation.to;
      if (other === owner) {
        throw modelError('a many-to-many relation to the entity itself is not supported — '
          + 'both endpoint columns would carry the same name', docPath);
      }
      for (const endpoint of [owner, other]) {
        if (entities.get(endpoint).keys.length !== 1) {
          throw modelError(`a many-to-many relation needs single-key endpoints; '${endpoint}' `
            + 'declares a composite key', docPath);
        }
      }
      relation.joinTable = typeof relation.through === 'string'
        ? relation.through
        : [owner, other].sort().join('_');
      continue;
    }
    if (!hasVia)
      throw modelError('a foreign-key relation needs via (the FK property name)', docPath);
    if (typeof relation.via !== 'string' || !ENTITY_NAME.test(relation.via))
      throw modelError('via must be an identifier property name', `${docPath}/via`);
    if (!ON_DELETE.has(relation.onDelete)) {
      throw modelError(
        "a foreign-key relation must declare onDelete: 'cascade', 'restrict' or 'setNull' — never defaulted silently",
        `${docPath}/onDelete`);
    }
    // the placement rule: many:true puts the FK on the TARGET entity;
    // one-to-one (no many) puts it on the DECLARING entity
    relation.kind = many ? 'oneToMany' : 'oneToOne';
    relation.fkEntity = many ? relation.to : owner;
    relation.fkTargets = many ? owner : relation.to;
    // a DECLARED via property must be a column-mapped scalar of the
    // referenced key's type (§9.4)
    const holder = entities.get(relation.fkEntity);
    const declaredVia = holder.properties.get(relation.via);
    const targetEntity = entities.get(relation.fkTargets);
    if (targetEntity.keys.length !== 1) {
      // a foreign key references ONE column; a composite-key target
      // rendered a reference to its first key alone, which SQLite
      // refused at the first write with a raw "foreign key mismatch"
      throw modelError(`a foreign-key relation must reference a single-key entity; `
        + `'${relation.fkTargets}' declares a composite key`, docPath);
    }
    const targetKeyType = targetEntity.properties.get(targetEntity.keys[0]).type;
    if (declaredVia !== undefined) {
      if (declaredVia.type !== targetKeyType || declaredVia.column === 'json') {
        throw modelError(
          `via property '${relation.via}' on '${relation.fkEntity}' must be a `
          + `column-mapped ${targetKeyType} (the referenced key's type)`,
          `${docPath}/via`);
      }
    }
  }

  // inverse agreement: two FK declarations describing the same edge
  // must agree on via/onDelete and be a many/one pairing
  for (let i = 0; i < declarations.length; i++) {
    for (let j = i + 1; j < declarations.length; j++) {
      const a = declarations[i];
      const b = declarations[j];
      const relationA = a.property.relation;
      const relationB = b.property.relation;
      if (relationA.to !== b.owner || relationB.to !== a.owner) continue;
      if (relationA.kind === 'manyToMany' || relationB.kind === 'manyToMany') {
        if (relationA.kind !== relationB.kind) {
          throw new DbCompileError('JD0031',
            `relation '${a.owner}.${a.property.name}' and '${b.owner}.${b.property.name}' `
            + 'contradict: one is many-to-many, the other is not',
            `${a.property.docPath}/x-entity/relation`);
        }
        if (relationA.joinTable !== relationB.joinTable) {
          throw new DbCompileError('JD0031',
            `relation '${a.owner}.${a.property.name}' and '${b.owner}.${b.property.name}' `
            + `disagree on the join table ('${relationA.joinTable}' vs '${relationB.joinTable}')`,
            `${a.property.docPath}/x-entity/relation`);
        }
        continue;
      }
      if (relationA.via !== relationB.via) {
        // a mutual one/many pair is presumed ONE edge and must agree
        // on its key; a mutual SAME-kind pair with different vias is
        // two independent edges (how a legitimate cycle is written)
        if (relationA.kind !== relationB.kind) {
          throw new DbCompileError('JD0031',
            `relation '${a.owner}.${a.property.name}' and '${b.owner}.${b.property.name}' `
            + `disagree on the foreign key ('${relationA.via}' vs '${relationB.via}') `
            + '— two edges between the same pair declare their inverse on one side only (§9.4)',
            `${a.property.docPath}/x-entity/relation`);
        }
        continue;
      }
      if (relationA.kind === relationB.kind) {
        throw new DbCompileError('JD0031',
          `relation '${a.owner}.${a.property.name}' and '${b.owner}.${b.property.name}' `
          + 'both claim the same side of the edge (an inverse pair is one many and one one)',
          `${a.property.docPath}/x-entity/relation`);
      }
      if (relationA.fkEntity !== relationB.fkEntity) continue; // different edges
      if (relationA.onDelete !== relationB.onDelete) {
        throw new DbCompileError('JD0031',
          `relation '${a.owner}.${a.property.name}' and '${b.owner}.${b.property.name}' `
          + `disagree on onDelete ('${relationA.onDelete}' vs '${relationB.onDelete}')`,
          `${a.property.docPath}/x-entity/relation`);
      }
    }
  }
}

/**
 * The relation table a producer may read (§10.1): per entity, one
 * frozen record per declared relation member — `to`, `kind`, and for a
 * foreign-key relation `via`, `fkEntity`, `fkTargets` and `targetKey`
 * (the key property the foreign key references on `fkTargets`, which
 * is what a hop's equality compares `via` against); for a many-to-many
 * `joinTable` and the target's `targetKey`. Plain data, keyed by
 * entity name and then by member name, so a query producer can lower
 * a relation hop to the phrases the translator runs without a second
 * vocabulary and without importing this package.
 * @param {Map<string, any>} entities - normalized entities
 * @returns {Readonly<Record<string, Readonly<Record<string, any>>>>}
 */
export function relationTables(entities) {
  /** @type {Record<string, any>} */
  const tables = {};
  for (const entity of entities.values()) {
    /** @type {Record<string, any>} */
    const table = {};
    for (const property of entity.relations) {
      const relation = property.relation;
      const entry = relation.kind === 'manyToMany'
        ? {
          to: relation.to,
          kind: relation.kind,
          joinTable: relation.joinTable,
          targetKey: entities.get(relation.to).keys[0],
          // the join row's two columns and the key each references, so a
          // hop can lower through the join ROOT (§10.7) rather than
          // refusing for want of one
          ownColumn: `${entity.name}_key`,
          ownKey: entity.keys[0],
          targetColumn: `${relation.to}_key`,
        }
        : {
          to: relation.to,
          kind: relation.kind,
          via: relation.via,
          fkEntity: relation.fkEntity,
          fkTargets: relation.fkTargets,
          targetKey: entities.get(relation.fkTargets).keys[0],
        };
      // an own member, whatever the property is named: `__proto__` as
      // a member name would otherwise rewrite the record's prototype
      Object.defineProperty(table, property.name,
        { value: Object.freeze(entry), writable: true, enumerable: true, configurable: true });
    }
    Object.defineProperty(tables, entity.name,
      { value: Object.freeze(table), writable: true, enumerable: true, configurable: true });
  }
  return Object.freeze(tables);
}

/**
 * The hybrid mapping, derived mechanically from §9.3's table and
 * returned as DATA: per entity, the columns (name, type, source),
 * the checks, the foreign keys, the indexes, and which properties
 * live in the JSONB document.
 * @param {any} model - a model document with `entities`
 * @returns {any}
 */
export function explainMapping(model) {
  return mappingOf(model, normalizeEntities(model));
}

/** Normalize and map once for lightweight engines sharing model metadata.
 * No process-global cache retains the model or any connection.
 * @param {any} model @returns {{entities:Map<string,any>,mapping:any}} */
export function compileEntityModel(model) {
  const entities = normalizeEntities(model);
  return { entities, mapping: mappingOf(model, entities) };
}

/** @param {any} model @param {Map<string,any>} entities @returns {any} */
function mappingOf(model, entities) {
  /** @type {any} */
  const mapping = { entities: {}, joinTables: {} };

  for (const entity of entities.values()) {
    if (entity.physical !== null) {
      mapping.entities[entity.name] = { ...entity.physical, document: false,
        foreignKeys: [], indexes: [], version: entity.version, invariants: model.entities[entity.name].invariants ?? [] };
      continue;
    }
    const columns = [];
    const document = [];
    const indexes = [];
    for (const property of entity.properties.values()) {
      if (property.relation !== undefined) continue; // no storage of its own
      const isScalar = SCALARS.has(property.type ?? '');
      const epoch = property.column === 'integer';
      if (!isScalar || property.column === 'json') {
        document.push(property.name);
        continue;
      }
      const column = {
        name: property.name,
        storage: epoch ? 'integer' : property.type,
        source: epoch ? 'epoch(document)' : 'document',
        key: property.key,
      };
      if (property.enum !== undefined) {
        // `null` never fails a CHECK (NULL IN (…) is unknown, which
        // passes), but rendered into the list it made the whole CHECK
        // unknown for EVERY value — a nullable enum accepted anything
        const values = property.enum.filter((value) => value !== null);
        if (values.length > 0) column.check = values;
      }
      columns.push(column);
      if (property.unique) indexes.push({ property: property.name, unique: true });
      else if (property.index) indexes.push({ property: property.name, unique: false });
    }
    const foreignKeys = [];
    /** @type {Map<string, any>} */
    const fkByColumn = new Map();
    for (const other of entities.values()) {
      for (const declaring of other.relations) {
        const relation = declaring.relation;
        if (relation.kind === 'manyToMany') continue;
        if (relation.fkEntity !== entity.name) continue;
        const existing = fkByColumn.get(relation.via);
        if (existing !== undefined) {
          // the validated inverse pair (one many, one one) shares ONE
          // physical key; a many side means children share the parent,
          // so the key cannot be unique
          if (existing.references !== relation.fkTargets
            || existing.onDelete !== relation.onDelete) {
            throw new DbCompileError('JD0031',
              `two relations claim foreign key '${relation.via}' on `
              + `'${entity.name}' with different targets or on-delete`,
              declaring.docPath);
          }
          existing.unique = existing.unique && relation.kind === 'oneToOne';
          continue;
        }
        const fk = {
          column: relation.via,
          references: relation.fkTargets,
          referencesKey: entities.get(relation.fkTargets).keys[0],
          onDelete: relation.onDelete,
          unique: relation.kind === 'oneToOne',
        };
        fkByColumn.set(relation.via, fk);
        foreignKeys.push(fk);
      }
    }
    mapping.entities[entity.name] = {
      table: entity.name,
      keys: entity.keys,
      columns,
      foreignKeys,
      indexes,
      document,
      version: entity.version ?? null,
      ...(entity.invariants.length ? { invariants: model.entities[entity.name].invariants } : {}),
    };
  }

  const seenJoins = new Set();
  for (const entity of entities.values()) {
    for (const declaring of entity.relations) {
      const relation = declaring.relation;
      if (relation.kind !== 'manyToMany' || seenJoins.has(relation.joinTable)) continue;
      // a join table is a queryable ROOT (§10.7), so its name shares one
      // namespace with the entities: a collision would make `$.X[*]`
      // mean two things
      if (entities.has(relation.joinTable)) {
        throw modelError(`the join table '${relation.joinTable}' has the name of a declared `
          + 'entity, and both are query roots', declaring.docPath ?? entity.docPath);
      }
      seenJoins.add(relation.joinTable);
      const [a, b] = [entity.name, relation.to].sort();
      mapping.joinTables[relation.joinTable] = {
        left: { entity: a, column: `${a}_key`, referencesKey: entities.get(a).keys[0] },
        right: { entity: b, column: `${b}_key`, referencesKey: entities.get(b).keys[0] },
        onDelete: 'cascade',
      };
    }
  }
  return mapping;
}

/**
 * The read-only query ROOTS a model's join tables contribute (§10.7):
 * one pseudo-entity per declared many-to-many join table, carrying
 * exactly its two key columns and no document of its own. They are
 * queryable — `$.<JoinTable>[*]` binds like any entity array — and they
 * are NOT writable: `store.entity(name)` reads the model's own entity
 * map, which these are deliberately not in, so a membership is still
 * written through `link`/`unlink` and the tracker's join rows.
 * @param {Map<string, any>} entities - the normalized entities
 * @param {any} mapping - `explainMapping(...)`
 * @returns {{ entities: Map<string, any>, mappings: Record<string, any> }}
 */
export function joinTableRoots(entities, mapping) {
  /** @type {Map<string, any>} */
  const roots = new Map();
  /** @type {any} */
  const mappings = {};
  for (const [name, join] of Object.entries(mapping.joinTables ?? {})) {
    const sides = [join.left, join.right];
    /** @type {any} */
    const properties = new Map();
    /** @type {any} */
    const schemaProperties = {};
    const columns = [];
    for (const side of sides) {
      const referenced = entities.get(side.entity).properties.get(side.referencesKey);
      properties.set(side.column, { name: side.column, type: referenced.type, key: true });
      schemaProperties[side.column] = { type: referenced.type };
      columns.push({ name: side.column, storage: referenced.type, source: 'column' });
    }
    roots.set(name, {
      name,
      docPath: `/entities/${sides[0].entity}` ,
      schema: { type: 'object', required: sides.map((side) => side.column),
        properties: schemaProperties },
      properties,
      keys: sides.map((side) => side.column),
      relations: [],
      version: null,
      joinTable: true,
    });
    mappings[name] = {
      table: name,
      columns,
      foreignKeys: [],
      indexes: [],
      keys: sides.map((side) => side.column),
      // a join row IS its two keys: there is no document column to read,
      // and the merge is handed an empty one
      document: false,
    };
  }
  return { entities: roots, mappings };
}
