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

import { DbRuntimeError } from './errors.js';
import { chain } from './driver.js';

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
  const fkColumns = entityMapping.foreignKeys.map((fk) => fk.column);
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
    const epoch = property?.format === 'date'
      ? getEpochOfDateOnlyRFC3339(value)
      : getEpochOfDateTimeRFC3339(value);
    return typeof epoch === 'number' && Number.isFinite(epoch) ? epoch : null;
  };

  /** Split a completed document into bound column values + the rest. */
  const split = (doc) => {
    const values = [];
    /** @type {any} */
    const rest = {};
    for (const key of Object.keys(doc)) {
      if (!columnSet.has(key)) rest[key] = doc[key];
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
      defaulters.push({ name: property.name, fill: () => new Date().toISOString() });
      if (declared === 'updated')
        updateStamps.push({ name: property.name, fill: () => new Date().toISOString() });
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
    if (updating) {
      for (const { name, fill } of updateStamps) out[name] = fill(out);
    }
    return out;
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
    if (/** @type {any} */ (error)?.code === 'JD2003') return error;
    return new DbRuntimeError('JD2005',
      `the database rejected the operation: ${/** @type {any} */ (error)?.message ?? String(error)}`,
      key === undefined
        ? { docPath, collection: entity.name, cause: error }
        : { docPath, collection: entity.name, key, cause: error });
  };

  return {
    create(doc) {
      const completed = applyDefaults(doc, { updating: false });
      checkValid(completed);
      const { values, rest } = split(completed);
      const names = values.map((value) => value.name);
      const sql = insertSqlFor(names);
      return chain(prepared(`insert:${names.join(',')}`, sql), (statement) => {
        const params = [...values.map((value) => value.value), JSON.stringify(rest)];
        let out;
        try {
          out = autoKey !== null && !names.includes(autoKey)
            ? statement.get(params)
            : (statement.run(params), null);
        }
        catch (error) {
          throw wrapWrite(error, completed[keys[0]]);
        }
        if (out !== null) return { ...completed, [autoKey]: out.key };
        return completed;
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
      return chain(this.get(key), (current) => {
        if (current === undefined) {
          throw new DbRuntimeError('JD2006',
            `no '${entity.name}' to update under that key`,
            { docPath, collection: entity.name });
        }
        const next = applyDefaults({ ...current, ...changes }, { updating: true });
        checkValid(next);
        const { values, rest } = split(next);
        const assignments = [
          ...values.map((value, i) => `${q(value.name)} = ${parameterAt(i + 1)}`),
          `${q('doc')} = ${dialect.jsonEncode(parameterAt(values.length + 1))}`,
        ].join(', ');
        const sql = `UPDATE ${q(table)} SET ${assignments} `
          + `WHERE ${keyWhere(values.length + 1)}`;
        return chain(prepared(`update:${values.length}`, sql), (statement) => {
          try {
            statement.run([...values.map((value) => value.value),
              JSON.stringify(rest), ...parts]);
          }
          catch (error) {
            throw wrapWrite(error, parts[0]);
          }
          return next;
        });
      });
    },
    delete(key) {
      const parts = normalizeKeyArg(key);
      const sql = `DELETE FROM ${q(table)} WHERE ${keyWhere(0)}`;
      return chain(prepared('delete', sql), (statement) => {
        let out;
        try {
          out = statement.run(parts);
        }
        catch (error) {
          throw wrapWrite(error, parts[0]);
        }
        return chain(out, (result) => Number(result?.changes ?? 0) > 0);
      });
    },
  };
}
