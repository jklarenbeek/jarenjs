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

import { DbCompileError } from './errors.js';

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
    && Object.keys(declared).length === 1) return;
  throw modelError(
    "a default is 'now', 'updated', 'uuid', 'auto', { value: … } or { query: … }",
    docPath);
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

      const type = typeof effective.type === 'string'
        ? effective.type
        : Array.isArray(effective.type)
          ? effective.type.find((t) => t !== 'null')
          : undefined;

      if (entityBlock.default !== undefined)
        checkDefault(entityBlock.default, `${propertyPath}/x-entity/default`);
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
    });
  }

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
            + `disagree on the foreign key ('${relationA.via}' vs '${relationB.via}')`,
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
 * The hybrid mapping, derived mechanically from §9.3's table and
 * returned as DATA: per entity, the columns (name, type, source),
 * the checks, the foreign keys, the indexes, and which properties
 * live in the JSONB document.
 * @param {any} model - a model document with `entities`
 * @returns {any}
 */
export function explainMapping(model) {
  const entities = normalizeEntities(model);
  /** @type {any} */
  const mapping = { entities: {}, joinTables: {} };

  for (const entity of entities.values()) {
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
      if (property.enum !== undefined) column.check = property.enum;
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
    };
  }

  const seenJoins = new Set();
  for (const entity of entities.values()) {
    for (const declaring of entity.relations) {
      const relation = declaring.relation;
      if (relation.kind !== 'manyToMany' || seenJoins.has(relation.joinTable)) continue;
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
