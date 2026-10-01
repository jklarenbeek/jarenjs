//@ts-check
/** Bounded physical migration reads and key-preserving column assignments. */
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { createBoundedCache } from '@jarenjs/core/cache';
import { setObjectMember } from '@jarenjs/core/object';
import { chain, isThenable } from './driver.js';
import { DbCompileError } from './errors.js';
import { readSchema } from './introspect.js';
import { columnCodec, physicalSelection, verifyPhysical, textKeyPlan, textKeyDecoding, checkTextKeys } from './physical.js';
import { entityCore } from './entity.js';

const member = (value, name) => Object.hasOwn(value, name) ? value[name] : undefined;
const same = (a, b) => a === undefined || b === undefined
  ? a === b : canonicalizeJson(a) === canonicalizeJson(b);

/** The text-key plan of a migration read (physical.js): a key that cannot
 * round-trip through its SQLite text encoding refuses the migration (`JD0021`). */
function textKeyReadPlan(connection, mapping, keys) {
  const plan = textKeyPlan(mapping, keys, connection.dialect);
  if (plan === null) return null;
  const refuse = (column) => new DbCompileError('JD0021',
    `physical '${mapping.table}' key '${column.name}' cannot round-trip through its SQLite text encoding`);
  return chain(textKeyDecoding(connection), (decoding) => ({
    projection: plan.projection,
    read: (rows) => rows.map((row) => checkTextKeys(row, plan, decoding, refuse)),
  }));
}

/** Validate the physical read before preparing a statement over mapped columns. */
function physicalReader(connection, mapping, batchSize, check) {
  if (connection.dialect.name !== 'sqlite' || mapping.document !== false
    || !mapping.keys?.length || !['table', 'view'].includes(mapping.kind))
    throw new DbCompileError('JD0021', 'a physical migration read needs a declared SQLite table or view and mapped keys');
  if (!Number.isSafeInteger(batchSize) || batchSize < 1)
    throw new TypeError('physical migration batchSize must be a positive safe integer');
  check?.();
  return chain(readSchema(connection), (schema) => chain(verifyPhysical(connection, mapping, schema), () => {
    const dialect = connection.dialect, q = dialect.quoteIdentifier;
    const keys = mapping.keys.map((name) => mapping.columns.find((column) => column.name === name));
    if (keys.some((column) => !column || !['text', 'integer', 'bigint'].includes(column.codec)))
      throw new DbCompileError('JD0021', 'physical migration keys need text, integer or bigint codecs');
    return chain(textKeyReadPlan(connection, mapping, keys), (textKeys) => {
      // One explicit ordering governs both the cursor and comparisons. A table's
      // actual PRIMARY KEY proves uniqueness; a view has no such proof and uses
      // bounded offset pages. Big integers remain strings only at the binding
      // boundary; comparison reads the INTEGER column with its SQLite affinity.
      const ordered = keys.map((column) => column.codec === 'text'
        ? dialect.codepoint(q(column.physical)) : q(column.physical));
      const keyValues = (row) => keys.map((column) => {
        const codec = columnCodec(column);
        return codec.encode(codec.decode(row[column.physical]));
      });
      const table = q(mapping.table), projection = physicalSelection(mapping, dialect);
      const select = `SELECT ${projection}${textKeys === null ? '' : `, ${textKeys.projection}`} FROM ${table}`;
      const ordering = ` ORDER BY ${ordered.join(', ')}`;
      const bounded = dialect.limitClause(batchSize, undefined);
      const keyset = mapping.kind === 'table';
      const seek = ` WHERE (${ordered.join(', ')}) > (${keys.map((_, i) => dialect.parameterRef(i + 1, 'key')).join(', ')})`;
      const count = () => chain(connection.prepare(`SELECT COUNT(*) AS ${q('n')} FROM ${table}`), (s) => chain(s.get([]), (row) => Number(row.n)));
      const walk = (handle) => chain(connection.prepare(select + ordering + bounded), (first) =>
        chain(keyset ? connection.prepare(select + seek + ordering + bounded) : null, (following) => {
          let after = null, offset = 0;
          const done = Symbol('physical-migration-done');
          const consume = (rows) => {
            if (rows.length === 0) return done;
            if (textKeys !== null) rows = textKeys.read(rows);
            // Capture the continuation before a handler can mutate its batch.
            if (keyset) after = keyValues(rows[rows.length - 1]);
            offset += rows.length;
            return handle(rows);
          };
          const advance = () => {
            for (;;) {
              check?.();
              const page = keyset
                ? (after === null ? first.all([]) : following.all(after))
                : offset === 0 ? first.all([]) : chain(connection.prepare(select + ordering + dialect.limitClause(batchSize, offset)), (s) => s.all([]));
              if (isThenable(page)) return page.then((rows) => {
                const result = consume(rows);
                return result === done ? null : chain(result, advance);
              });
              const result = consume(page);
              if (result === done) return null;
              if (isThenable(result)) return result.then(advance);
            }
          };
          return advance();
        }));
      return { walk, count, keys, ordered, table };
    });
  }));
}

/** Read mapped rows without synthetic aliases that could overwrite stored names.
 * @param {any} connection @param {any} mapping @param {number} batchSize
 * @param {(rows: any[]) => any} handle @param {(() => void)} [check] @returns {any} */
export function walkPhysicalRows(connection, mapping, batchSize, handle, check) {
  return chain(physicalReader(connection, mapping, batchSize, check), (reader) => reader.walk(handle));
}

/** Transform column-only entities without application defaults/version stamps.
 * The migration's surrounding savepoint owns every assignment and invariant.
 * @param {any} connection @param {{entity: any, mapping: any}} target
 * @param {any} operation @param {{batchSize: number, runtime?: any, check?: Function,
 * onProgress?: Function, migration: string, collection: string}} options @returns {any} */
export function transformPhysicalRows(connection, target, operation, options) {
  const { entity, mapping } = target;
  const core = entityCore(connection, entity, mapping, null, options.runtime);
  core.plan.writable();
  const columns = core.plan.scalarColumns;
  const known = new Set(columns.map((column) => column.name));
  const keyNames = new Set(core.plan.keys);
  const statements = createBoundedCache(64);
  return chain(physicalReader(connection, mapping, options.batchSize, options.check), (reader) =>
    chain(reader.count(), (initialCount) => {
      let visited = 0, transformed = 0;
      const apply = (row) => {
        const before = core.plan.merge(row);
        const identity = Object.fromEntries(core.plan.keys.map((name) => [name, before[name]]));
        const output = operation.apply(structuredClone(before), canonicalizeJson(identity));
        for (const name of Object.keys(output)) if (!known.has(name))
          operation.fail(`a physical transform cannot store unknown or relation member '${name}'`);
        const values = [];
        const candidate = {};
        for (const column of columns) {
          const name = column.name;
          const supplied = Object.hasOwn(output, name);
          const prior = member(before, name), raw = supplied ? output[name] : undefined;
          const value = (column.generated || column.databaseDefault) && !supplied
            ? prior : column.codecPlan.normalize(raw);
          if (column.generated && !same(value, prior)) operation.fail(`generated column '${name}' is database-owned`);
          if (keyNames.has(name) && !same(value, prior)) operation.fail(`a physical transform cannot change key '${name}'`);
          if (value !== undefined) setObjectMember(candidate, name, value);
          if (!column.generated && !keyNames.has(name) && !same(value, prior))
            values.push({ name, value: core.plan.encodeColumn(name, raw) });
        }
        if (values.length === 0) return null;
        const dialect = connection.dialect, q = dialect.quoteIdentifier;
        const assignments = values.map((value, i) => `${q(core.plan.physicalName(value.name))} = ${dialect.parameterRef(i + 1, 'value')}`);
        const where = reader.ordered.map((column, i) => `${column} = ${dialect.parameterRef(values.length + i + 1, 'key')}`).join(' AND ');
        const sql = `UPDATE ${reader.table} SET ${assignments.join(', ')} WHERE ${where}`;
        const params = [...values.map((value) => value.value), ...core.plan.keys.map((name) => core.plan.encodeColumn(name, before[name]))];
        return chain(statements.getOrCreate(sql, (text) => connection.prepare(text)), (statement) => chain(statement.run(params), (result) => {
          if (Number(result.changes) !== 1) operation.fail('the physical transform did not update exactly its addressed row');
          return chain(core.get(core.plan.keys.length === 1 ? before[core.plan.keys[0]] : identity), (stored) => {
            if (!stored || core.plan.keys.some((name) => !same(stored[name], before[name])))
              operation.fail('the physical transform changed or lost its addressed key');
            if (values.some(({ name }) => !same(member(stored, name), member(candidate, name))))
              operation.fail('the physical transform did not store its requested column values');
            // judged as the entity's own update is: the row it replaced, the
            // row now stored and the columns this statement set
            return chain(core.plan.checkStored('update', before, stored, values.map((value) => value.name)), () => {
              transformed++;
              return null;
            });
          });
        }));
      };
      return chain(reader.walk((rows) => {
        visited += rows.length;
        if (visited > initialCount) operation.fail('a physical transform changed source row membership');
        let index = 0;
        const next = () => {
          while (index < rows.length) {
            const result = apply(rows[index++]);
            if (isThenable(result)) return result.then(next);
          }
          options.onProgress?.({ migration: options.migration, collection: options.collection, transformed });
          return null;
        };
        return next();
      }), () => chain(reader.count(), (finalCount) => {
        if (finalCount !== initialCount || visited !== initialCount)
          operation.fail('a physical transform changed source row membership');
        return transformed;
      }));
    }));
}
