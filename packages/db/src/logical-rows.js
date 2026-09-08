//@ts-check
/** Logical row access through the store's validation and physical column plans. */
import { chain } from './driver.js';
import { keyToken } from './capture.js';
import { DbRuntimeError } from './errors.js';

/** @param {any} options */
export function createLogicalRows({ connection, shapes, collectionCore, entityCore, capture, captureJoinDelete }) {
  const dialect = connection.dialect;
  const q = dialect.quoteIdentifier;
  const statement = (sql, method, params = []) => chain(connection.prepare(sql), (s) => s[method](params));
  const shapeOf = (table) => {
    const shape = shapes.get(table);
    if (!shape) throw new DbRuntimeError('JD2104', `replication names undeclared table '${table}'`);
    return shape;
  };
  const keyColumns = (shape) => shape.keyIndexes.map((i) => shape.columns[i].name);
  const partsOf = (shape, key) => {
    if (shape.keyIndexes.length === 1) return [key];
    let parts;
    try { parts = JSON.parse(key); } catch { parts = null; }
    if (!Array.isArray(parts) || parts.length !== shape.keyIndexes.length
      || parts.some((part) => typeof part !== 'string' && !(typeof part === 'number' && Number.isFinite(part))))
      throw new DbRuntimeError('JD2104', 'replication contains an invalid composite key');
    return parts;
  };
  const where = (keys) => keys.map((key) => `${q(key)} = ?`).join(' AND ');
  const entityKey = (shape, key) => Object.fromEntries(keyColumns(shape).map((name, i) => [name, partsOf(shape, key)[i]]));
  const read = (table, key) => {
    const shape = shapeOf(table);
    if (shape.kind === 'collection') return collectionCore(table).get(key);
    if (shape.kind === 'entity') return entityCore(table).get(entityKey(shape, key));
    return chain(statement(`SELECT * FROM ${q(table)} WHERE ${where(keyColumns(shape))}`, 'get', partsOf(shape, key)),
      (row) => row === undefined ? undefined : { ...row });
  };
  const write = (operation) => {
    const { table, key, before, after } = operation;
    const shape = shapeOf(table);
    if (shape.kind === 'collection') {
      const core = collectionCore(table);
      return after === null ? core.delete(key) : core.put(after, key);
    }
    const keys = keyColumns(shape);
    let names;
    let params;
    let expressions;
    if (after !== null) {
      if (keyToken(keys.map((name) => after[name])) !== key)
        throw new DbRuntimeError('JD2104', 'replication cannot change a row identity');
      if (shape.kind === 'entity') {
        const core = entityCore(table);
        core.validateOnly(after);
        const { values, rest } = core.plan.split(after);
        names = [...values.map((value) => value.name), 'doc'];
        params = [...values.map((value) => value.value), JSON.stringify(rest)];
        expressions = names.map((name) => name === 'doc' ? dialect.jsonEncode('?') : '?');
      }
      else {
        if (Object.keys(after).length !== keys.length)
          throw new DbRuntimeError('JD2104', 'a membership row contains only its two keys');
        names = keys;
        params = keys.map((name) => after[name]);
        expressions = keys.map(() => '?');
      }
    }
    const sql = after === null ? `DELETE FROM ${q(table)} WHERE ${where(keys)}`
      : before === null ? `INSERT INTO ${q(table)} (${names.map(q).join(', ')}) VALUES (${expressions.join(', ')})`
        : `UPDATE ${q(table)} SET ${names.map((name, i) => `${q(name)} = ${expressions[i]}`).join(', ')} WHERE ${where(keys)}`;
    return chain(after === null && shape.kind === 'entity' ? captureJoinDelete?.(table, partsOf(shape, key)) : null,
      () => chain(statement(sql, 'run', after === null ? partsOf(shape, key)
      : before === null ? params : [...params, ...partsOf(shape, key)]), () => {
      if (capture.mode === 'journal') capture.record(table, partsOf(shape, key), before, after);
      }));
  };
  return { read, write, tables: [...shapes.keys()],
    position: (table, key) => {
      const shape = shapeOf(table);
      return chain(statement(`SELECT ${dialect.rowIdentity()} AS position FROM ${q(table)} WHERE ${where(keyColumns(shape))}`, 'get', partsOf(shape, key)),
        (row) => row?.position);
    },
    empty: () => {
      let result = true;
      const entries = [...shapes.keys()];
      const next = (i) => i === entries.length ? result : chain(
        statement(`SELECT 1 AS present FROM ${q(entries[i])} LIMIT 1`, 'get'),
        (row) => { result &&= row === undefined; return next(i + 1); });
      return next(0);
    },
  };
}
