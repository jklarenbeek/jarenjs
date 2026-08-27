//@ts-check
/**
 * @file Entity sets: create / read by key / update / delete over the
 * hybrid mapping. The physical row is the mapped scalar columns, the
 * foreign-key columns, and one JSONB `doc` column for everything
 * else; a write SPLITS the completed document along the mapping and a
 * read MERGES it back. Defaults apply in JavaScript before validation
 * — the value the application sees and the value stored are the same
 * — and identity follows the declared strategy (caller, uuid, auto).
 *
 * Epoch date columns are DERIVED: the document keeps the RFC 3339
 * string, the column carries `getEpochOf…RFC3339(value)` so range
 * predicates are index-friendly; reads take the string from the
 * document and skip the derived column.
 */

import { compileJsonQuery } from '@jarenjs/json/query';
import {
  getEpochOfDateTimeRFC3339, getEpochOfDateOnlyRFC3339,
} from '@jarenjs/core/dates/rfc3339';

import { DbRuntimeError, isDuplicateKeyError } from './errors.js';
import { chain, attempt } from './driver.js';

/**
 * The write/read machinery for one entity, prepared once.
 * @param {any} connection
 * @param {any} entity - the normalized entity (model.js)
 * @param {any} entityMapping - `explainMapping(...).entities[name]`
 * @param {((doc: any) => any) | null} validate
 * @returns {any}
 */
export function entityCore(connection, entity, entityMapping, validate) {
  const dialect = connection.dialect;
  const q = dialect.quoteIdentifier;
  const table = entityMapping.table;
  const docPath = entity.docPath;

  // the column plan: mapped scalars (epoch ones derived), then FKs;
  // everything else lives in the JSONB document
  const scalarColumns = entityMapping.columns.map((column) => ({
    ...column,
    epoch: column.source === 'epoch(document)',
    property: entity.properties.get(column.name),
  }));
  // a declared via property is ALREADY a scalar column — the foreign
  // key adds a column only when no property claims it
  const scalarNames = new Set(scalarColumns.map((column) => column.name));
  const fkColumns = entityMapping.foreignKeys
    .map((fk) => fk.column)
    .filter((name) => !scalarNames.has(name));
  const columnNames = [
    ...scalarColumns.map((column) => column.name),
    ...fkColumns,
  ];
  const columnSet = new Set(columnNames);
  const keys = entityMapping.keys;
  const autoKey = keys.length === 1
    && entity.properties.get(keys[0]).default === 'auto' ? keys[0] : null;

  const epochOf = (property, value) => {
    if (typeof value !== 'string') return null;
    // the mapped-instant contract (§10.3): a present string on an
    // integer date column must parse in the property's own family and
    // be Z-normalized — an offset form would let the derived epoch
    // order hours away from the document string the engine compares
    const dateOnly = property?.format === 'date';
    const epoch = dateOnly
      ? getEpochOfDateOnlyRFC3339(value)
      : getEpochOfDateTimeRFC3339(value);
    if ((dateOnly || value.endsWith('Z'))
      && typeof epoch === 'number' && Number.isFinite(epoch)) return epoch;
    throw new DbRuntimeError('JD2003',
      `entity '${entity.name}' maps '${property.name}' to an integer date column: `
      + `the value must be ${dateOnly
        ? "a 'YYYY-MM-DD' date" : 'a Z-normalized RFC 3339 date-time'}`
      + ` (got ${JSON.stringify(value)})`,
      { docPath, collection: entity.name });
  };

  const relationNames = new Set(
    [...entity.properties.values()]
      .filter((property) => property.relation !== undefined)
      .map((property) => property.name));

  /** Split a completed document into bound column values + the rest.
   * Relation members are PROJECTIONS (§10.1) — never stored. */
  const split = (doc) => {
    const values = [];
    /** @type {any} */
    const rest = {};
    for (const key of Object.keys(doc)) {
      if (!columnSet.has(key) && !relationNames.has(key)) rest[key] = doc[key];
    }
    for (const column of scalarColumns) {
      if (column.name === autoKey && doc[column.name] === undefined) continue;
      const value = doc[column.name];
      if (column.epoch) {
        // derived: the string stays in the document, the epoch rides
        // the column
        rest[column.name] = value;
        values.push({ name: column.name, value: epochOf(column.property, value) });
        continue;
      }
      values.push({
        name: column.name,
        value: value === undefined || value === null
          ? null
          : typeof value === 'boolean' ? (value ? 1 : 0) : value,
      });
    }
    for (const fk of fkColumns) {
      const value = doc[fk];
      values.push({ name: fk, value: value === undefined || value === null ? null : value });
    }
    return { values, rest };
  };

  /** Merge a row back into a document. */
  const merge = (row) => {
    const doc = JSON.parse(row.doc);
    for (const column of scalarColumns) {
      if (column.epoch) continue; // the string is already in the doc
      const value = row[column.name];
      if (value === null || value === undefined) continue; // absent (§9.3)
      doc[column.name] = column.storage === 'boolean' ? value === 1 : value;
    }
    for (const fk of fkColumns) {
      const value = row[fk];
      if (value !== null && value !== undefined) doc[fk] = value;
    }
    return doc;
  };

  // defaults, compiled once
  const defaulters = [];
  const updateStamps = [];
  for (const property of entity.properties.values()) {
    const declared = property.default;
    if (declared === undefined || property.relation !== undefined) continue;
    if (declared === 'now' || declared === 'updated') {
      // a `date` property takes the calendar date; a date-time stamp on
      // it was invalid under its own format and refused by an epoch column
      const stamp = property.format === 'date'
        ? () => new Date().toISOString().slice(0, 10)
        : () => new Date().toISOString();
      defaulters.push({ name: property.name, fill: stamp });
      if (declared === 'updated') updateStamps.push({ name: property.name, fill: stamp });
      continue;
    }
    if (declared === 'uuid') {
      defaulters.push({ name: property.name, fill: () => crypto.randomUUID() });
      continue;
    }
    if (declared === 'auto') continue; // the database allocates
    if (Object.hasOwn(declared, 'value')) {
      defaulters.push({ name: property.name, fill: () => structuredClone(declared.value) });
      continue;
    }
    const compiled = compileJsonQuery(declared.query);
    defaulters.push({ name: property.name, fill: (doc) => compiled(doc) });
  }

  const applyDefaults = (doc, { updating }) => {
    const out = { ...doc };
    for (const { name, fill } of defaulters) {
      if (out[name] === undefined) out[name] = fill(out);
    }
    // the version token starts at 0 on insert: a row written with SQL
    // NULL never matched the tracker's `WHERE ver = 0` and could not be
    // saved through the unit of work at all
    if (!updating && entity.version !== null && entity.version !== undefined
      && out[entity.version] === undefined) {
      out[entity.version] = 0;
    }
    if (updating) {
      for (const { name, fill } of updateStamps) out[name] = fill(out);
    }
    return out;
  };

  /**
   * Refuse relation members a write cannot store: every relation member
   * is a projection (§10.1), except a many-to-many MEMBERSHIP array,
   * which `create()`/`add()` attach through the join table.
   * @param {any} doc
   * @param {string} verb
   * @param {boolean} memberships - whether membership arrays are taken
   */
  const refuseProjections = (doc, verb, memberships) => {
    for (const name of relationNames) {
      const value = doc?.[name];
      if (value === undefined || (Array.isArray(value) && value.length === 0)) continue;
      const relation = entity.properties.get(name).relation;
      if (memberships && relation.kind === 'manyToMany' && Array.isArray(value)) continue;
      throw new DbRuntimeError('JD2003',
        `'${name}' is a relation member — ${verb}() stores no projections; `
        + (relation.kind === 'manyToMany'
          ? 'membership changes through the unit of work (put + saveChanges)'
          : 'write the related entities themselves'),
        { docPath, collection: entity.name });
    }
  };

  const checkValid = (doc) => {
    if (validate === null) return;
    const outcome = validate(doc);
    const valid = outcome === true || outcome?.valid === true;
    if (!valid) {
      throw new DbRuntimeError('JD2003',
        `entity '${entity.name}' rejected the document`,
        Array.isArray(outcome?.errors)
          ? { docPath, collection: entity.name, errors: outcome.errors }
          : { docPath, collection: entity.name });
    }
  };

  // prepared statements, built lazily from the column plan
  /** @type {Map<string, any>} */
  const statements = new Map();
  const prepared = (name, sql) => {
    let statement = statements.get(name);
    if (statement === undefined) {
      statement = connection.prepare(sql);
      statements.set(name, statement);
    }
    return statement;
  };
  const parameterAt = (i) => dialect.parameterRef(i, 'v');
  const keyWhere = (offset) => keys
    .map((key, i) => `${q(key)} = ${parameterAt(offset + i + 1)}`).join(' AND ');
  const selectColumns = [
    ...scalarColumns.filter((column) => !column.epoch).map((column) => q(column.name)),
    ...fkColumns.map((column) => q(column)),
    `${dialect.jsonText(q('doc'))} AS ${q('doc')}`,
  ].join(', ');

  const insertSqlFor = (names) => {
    const withDoc = [...names, 'doc'];
    const refs = withDoc.map((name, i) => (name === 'doc'
      ? dialect.jsonEncode(parameterAt(i + 1))
      : parameterAt(i + 1)));
    const returning = autoKey !== null && !names.includes(autoKey)
      ? ` RETURNING ${q(autoKey)} AS ${q('key')}`
      : '';
    return `INSERT INTO ${q(table)} (${withDoc.map(q).join(', ')}) `
      + `VALUES (${refs.join(', ')})${returning}`;
  };

  const normalizeKeyArg = (key) => {
    if (keys.length === 1) {
      if (typeof key === 'string' || typeof key === 'number') return [key];
      if (key !== null && typeof key === 'object' && !Array.isArray(key)
        && typeof key[keys[0]] !== 'object' && key[keys[0]] !== undefined)
        return [key[keys[0]]];
    }
    else if (key !== null && typeof key === 'object' && !Array.isArray(key)) {
      const parts = keys.map((name) => key[name]);
      if (parts.every((part) => typeof part === 'string' || typeof part === 'number'))
        return parts;
    }
    throw new DbRuntimeError('JD2002',
      keys.length === 1
        ? 'an entity key must be a scalar'
        : `a composite key needs { ${keys.join(', ')} }`,
      { docPath, collection: entity.name });
  };

  const wrapWrite = (error, key) => {
    const code = /** @type {any} */ (error)?.code;
    if (typeof code === 'string' && code.startsWith('JD')) return error;
    if (keys.length === 1 && isDuplicateKeyError(error, table, keys[0])) {
      return new DbRuntimeError('JD2001',
        `a '${entity.name}' already exists under key ${JSON.stringify(key)}`,
        { docPath, collection: entity.name, key, cause: error });
    }
    return new DbRuntimeError('JD2005',
      `the database rejected the operation: ${/** @type {any} */ (error)?.message ?? String(error)}`,
      key === undefined
        ? { docPath, collection: entity.name, cause: error }
        : { docPath, collection: entity.name, key, cause: error });
  };

  const columnByName = new Map(scalarColumns.map((column) => [column.name, column]));
  /** Encode ONE column assignment the way {@link split} would. */
  const encodeColumn = (name, value) => {
    const column = columnByName.get(name);
    if (column !== undefined && column.epoch)
      return value === undefined ? null : epochOf(column.property, value);
    if (value === undefined || value === null) return null;
    return typeof value === 'boolean' ? (value ? 1 : 0) : value;
  };

  return {
    // the unit-of-work exposure (tracker.js): the column plan and the
    // completion/validation/stamping machinery, one source of truth
    plan: {
      table,
      keys,
      autoKey,
      version: entity.version ?? null,
      scalarColumns,
      fkColumns,
      columnSet,
      split,
      merge,
      encodeColumn,
    },
    complete: (doc, { updating }) => {
      const completed = applyDefaults(doc, { updating });
      checkValid(completed);
      return completed;
    },
    validateOnly: (doc) => checkValid(doc),
    stampUpdated: (doc) => {
      if (updateStamps.length === 0) return doc;
      const out = { ...doc };
      for (const { name, fill } of updateStamps) out[name] = fill(out);
      return out;
    },
    normalizeKey: (key) => normalizeKeyArg(key),
    create(doc) {
      refuseProjections(doc, 'create', true);
      const completed = applyDefaults(doc, { updating: false });
      checkValid(completed);
      const { values, rest } = split(completed);
      const names = values.map((value) => value.name);
      const sql = insertSqlFor(names);
      return chain(prepared(`insert:${names.join(',')}`, sql), (statement) => {
        const params = [...values.map((value) => value.value), JSON.stringify(rest)];
        const returning = autoKey !== null && !names.includes(autoKey);
        return chain(
          attempt(() => (returning ? statement.get(params) : statement.run(params)),
            (error) => wrapWrite(error, completed[keys[0]])),
          (out) => (returning ? { ...completed, [autoKey]: out.key } : completed));
      });
    },
    get(key) {
      const parts = normalizeKeyArg(key);
      const sql = `SELECT ${selectColumns} FROM ${q(table)} WHERE ${keyWhere(0)}`;
      return chain(prepared('get', sql), (statement) =>
        chain(statement.get(parts), (row) => (row === undefined ? undefined : merge(row))));
    },
    update(key, changes) {
      const parts = normalizeKeyArg(key);
      refuseProjections(changes, 'update', false);
      return chain(this.get(key), (current) => {
        if (current === undefined) {
          throw new DbRuntimeError('JD2006',
            `no '${entity.name}' to update under that key`,
            { docPath, collection: entity.name });
        }
        for (const keyName of keys) {
          // the key identifies the row the UPDATE addresses; rewriting it
          // through `changes` moved rows out from under the tracker
          if (changes?.[keyName] !== undefined && changes[keyName] !== current[keyName]) {
            throw new DbRuntimeError('JD2003',
              `'${keyName}' is the primary key — update() cannot rewrite it; delete and create`,
              { docPath, collection: entity.name, key: parts[0] });
          }
        }
        const next = applyDefaults({ ...current, ...changes }, { updating: true });
        // an explicit update is last-write-wins by contract (§11.2),
        // but it still moves a declared version token so optimistic
        // savers see the row changed
        if (entity.version !== null && entity.version !== undefined)
          next[entity.version] = (Number(current[entity.version]) || 0) + 1;
        checkValid(next);
        const { values, rest } = split(next);
        const assignments = [
          ...values.map((value, i) => `${q(value.name)} = ${parameterAt(i + 1)}`),
          `${q('doc')} = ${dialect.jsonEncode(parameterAt(values.length + 1))}`,
        ].join(', ');
        const sql = `UPDATE ${q(table)} SET ${assignments} `
          + `WHERE ${keyWhere(values.length + 1)}`;
        return chain(prepared(`update:${values.length}`, sql), (statement) =>
          chain(attempt(() => statement.run([...values.map((value) => value.value),
            JSON.stringify(rest), ...parts]), (error) => wrapWrite(error, parts[0])),
          () => next));
      });
    },
    delete(key) {
      const parts = normalizeKeyArg(key);
      const sql = `DELETE FROM ${q(table)} WHERE ${keyWhere(0)}`;
      return chain(prepared('delete', sql), (statement) =>
        chain(attempt(() => statement.run(parts), (error) => wrapWrite(error, parts[0])),
          (result) => Number(result?.changes ?? 0) > 0));
    },
  };
}
