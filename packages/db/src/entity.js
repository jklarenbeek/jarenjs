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
import { resolveRuntime } from '@jarenjs/core/runtime';
import { setObjectMember, isJsonObject } from '@jarenjs/core/object';

import { DbRuntimeError, wrapDriverError, wrapHeldKey, keyUndecided } from './errors.js';
import { chain, isThenable, attempt, useStatementOnce, releaseStatements as releasePrepared } from './driver.js';
import { createCursor, createSyncCursor, rowClassOf } from './cursor.js';
import { checkInvariants, existsRowSql, recordPath, ruleLiteral } from './invariants.js';
import { columnCodec, physicalRead } from './physical.js';
import { mergeEntityRow } from './graph.js';
import { namesNoNumber, noNumberKeyReason, numericKeyValue } from './key-text.js';
import { createJSONPatch } from '@jarenjs/json/patch';
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { createEntityMutation } from './mutation.js';

/** How many update shapes an entity keeps prepared. */
const UPDATE_SHAPES = 32;

/** The top-level member a JSON Patch operation touches. @param {{ path: string }} op */
const memberOfPatch = (op) => (op.path.split('/')[1] ?? '').replace(/~1/g, '/').replace(/~0/g, '~');

/** @param {any} settled @returns {never} */
const refuse = (settled) => { throw settled; };

/**
 * The error a failed INSERT is refused with: what `wrapDriverError` makes of
 * it, except where SQLite names a unique constraint that is not the key's
 * while a stored row holds the key too (it reports only the first constraint
 * a row fails) — one read of the keys the INSERT carried then settles it, and
 * a stored key is the `JD2001` the key's own collision is. The read runs on
 * the connection the INSERT failed on, inside the caller's transaction when
 * there is one, and a read that itself fails leaves the report as it was.
 * @param {any} connection @param {any} error - the driver's
 * @param {() => import('./errors.js').WrapDetails} details
 * @param {() => { tableSql: string, columns: string[], rows: any[][] }} held
 * @returns {any} the error, or a promise of it
 */
function failedInsert(connection, error, details, held) {
  const wrapped = details();
  const reported = () => wrapDriverError(error, wrapped);
  if (!keyUndecided(error, wrapped.unique)) return reported();
  const { tableSql, columns, rows } = held();
  if (rows.length === 0) return reported();
  const { dialect } = connection;
  let bound = 0;
  const where = rows.map((row) => {
    const terms = row.map((_, i) => `${columns[i]} = ${dialect.parameterRef(++bound, 'v')}`).join(' AND ');
    return rows.length === 1 ? terms : `(${terms})`;
  }).join(' OR ');
  const stored = (/** @type {any} */ found) => (found === undefined || found === null ? reported() : wrapHeldKey(error, wrapped));
  try {
    const read = useStatementOnce(connection, `SELECT 1 FROM ${tableSql} WHERE ${where} LIMIT 1`,
      (statement) => statement.get(rows.flat()));
    return isThenable(read) ? read.then(stored, reported) : stored(read);
  }
  catch {
    return reported();
  }
}

/**
 * Run an INSERT. Every insert path of both stores (an entity's `create()`,
 * the unit of work's batch, a collection's `insert()`) ends here: the result
 * is the call's own, or its failure ({@link failedInsert}), synchronously for
 * a synchronous driver. Nothing runs beside the call unless it fails.
 * @param {any} connection
 * @param {() => any} call - runs the INSERT
 * @param {() => import('./errors.js').WrapDetails} details - what the failure
 *   is classified by; read on failure only
 * @param {() => { tableSql: string, columns: string[], rows: any[][] }} held -
 *   the table, its quoted key columns and the key values the INSERT bound, one
 *   array per row (none for a key the database allocated); read on a failure
 *   that leaves the key undecided only
 * @returns {any}
 */
export function insertAttempt(connection, call, details, held) {
  let out;
  try {
    out = call();
  }
  catch (error) {
    return chain(failedInsert(connection, error, details, held), refuse);
  }
  return isThenable(out)
    ? out.then(undefined, (error) => chain(failedInsert(connection, error, details, held), refuse))
    : out;
}

/**
 * The write/read machinery for one entity, prepared once.
 * @param {any} connection
 * @param {any} entity - the normalized entity (model.js)
 * @param {any} entityMapping - `explainMapping(...).entities[name]`
 * @param {((doc: any) => any) | null} validate
 * @param {Partial<import('@jarenjs/core/runtime').Runtime>} [runtime] - the
 *   host's runtime record: the clock a `default: 'now'` stamps and the
 *   identifier a `default: 'uuid'` allocates; the platform's own when absent
 * @param {string | string[]} [keyConstraint] - the name the catalog gives the
 *   table's primary-key constraint (PostgreSQL), or the names of a partitioned
 *   table's tree: the unique violation that is a duplicate key; without it none
 *   is
 * @param {boolean} [keyAllocates] - whether the table's key column allocates
 *   a key the model leaves to the database (`default: "auto"`), as the open
 *   read it: `false` where it allocates nothing, so a write that leaves the
 *   key to the database is refused by name; allocating where not read
 * @returns {any}
 */
export function entityCore(connection, entity, entityMapping, validate, runtime = undefined, keyConstraint = undefined, keyAllocates = true) {
  const host = resolveRuntime(runtime);
  const dialect = connection.dialect;
  const q = dialect.quoteIdentifier;
  const table = entityMapping.table;
  const tableSql = dialect.tableName(table, entityMapping.schema);
  const docPath = entity.docPath;
  const physical = entityMapping.document === false;
  const physicalName = (name) => entityMapping.columns.find((c) => c.name === name)?.physical ?? name;
  const writable = () => {
    if (entityMapping.kind === 'view') throw new DbRuntimeError('JD2003', `entity '${entity.name}' is a read-only view`);
  };

  // the column plan: mapped scalars (epoch ones derived), then FKs;
  // everything else lives in the JSONB document
  const scalarColumns = entityMapping.columns.map((column) => ({
    ...column,
    epoch: column.source === 'epoch(document)',
    property: entity.properties.get(column.name),
    codecPlan: physical ? columnCodec(column) : null,
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

  /** A member a document holds itself: a name the prototype also answers
   * (`__proto__`) is a member only where the document defines it. */
  const memberOf = (doc, name) => (Object.hasOwn(doc, name) ? doc[name] : undefined);

  /**
   * A column's value as written, refused when the column would store
   * another string: a driver encodes text as UTF-8, which has no spelling
   * for a lone surrogate, and stores U+FFFD in its place, so a read would
   * answer another string than was written (a document member keeps it:
   * its JSON escape is well-formed). A key part no write can store this
   * way is one no read finds ({@link storedKeyPart}).
   * @param {string} name @param {any} value - what the column binds
   */
  const storable = (name, value) => {
    if (typeof value === 'string' && !value.isWellFormed()) {
      throw new DbRuntimeError('JD2003', `the member '${name}' holds a lone surrogate, which its column cannot store: `
        + 'the driver writes U+FFFD in its place, so a read would answer another string than was written; write a '
        + 'well-formed string (toWellFormed()), or keep the member in the document, which stores it as written',
      { docPath, collection: entity.name });
    }
    return value;
  };

  /** Split a completed document into bound column values + the rest.
   * Relation members are PROJECTIONS (§10.1) — never stored. */
  const split = (doc, { updating = false } = {}) => {
    const values = [];
    /** @type {any} */
    const rest = {};
    for (const key of Object.keys(doc)) {
      if (!columnSet.has(key) && !relationNames.has(key)) setObjectMember(rest, key, doc[key]);
    }
    for (const column of scalarColumns) {
      const value = memberOf(doc, column.name);
      if (column.name === autoKey && value === undefined) continue;
      if (physical && (column.generated || (!updating && column.databaseDefault && value === undefined))) continue;
      // derived: an epoch column's string stays in the document, the
      // epoch rides the column
      if (!physical && column.epoch) setObjectMember(rest, column.name, value);
      values.push({ name: column.name, value: encodeColumn(column.name, value) });
    }
    for (const fk of fkColumns) {
      const value = memberOf(doc, fk);
      values.push({ name: fk, value: value === undefined || value === null ? null : storable(fk, value) });
    }
    if (physical && Object.keys(rest).length > 0) throw new DbRuntimeError('JD2003',
      `column-only entity '${entity.name}' cannot store undeclared members: ${Object.keys(rest).join(', ')}`);
    return { values, rest };
  };

  /** Merge a row back into a document. */
  const merge = (row) => mergeEntityRow(entityMapping, row);

  /** The document as a read will answer it. For a column-mapped scalar,
   * JSON `null` and absence both store as SQL NULL and read back ABSENT
   * (§9.3) — so a value a write RETURNS drops it too, and the promise
   * this file opens with holds: the value the application sees IS the
   * value stored. A property that needs present-`null` declares
   * `column: "json"` and stays in the document, where it survives; an
   * epoch column keeps its string in the document for the same reason. */
  const asStored = (doc) => {
    if (physical) return doc;
    let out = doc;
    const drop = (name) => {
      if (!Object.hasOwn(out, name) || (out[name] !== null && out[name] !== undefined)) return;
      if (out === doc) out = { ...doc };
      delete out[name];
    };
    for (const column of scalarColumns) {
      if (column.epoch) continue; // the string is in the document, null and all
      drop(column.name);
    }
    for (const fk of fkColumns) drop(fk);
    return out;
  };
  const normalizePhysicalDoc = (doc) => {
    if (!physical) return doc;
    const normalized = { ...doc };
    for (const column of scalarColumns) {
      if (column.generated || !Object.hasOwn(doc, column.name)) continue;
      const value = column.codecPlan.normalize(doc[column.name]);
      if (value === undefined) delete normalized[column.name];
      else setObjectMember(normalized, column.name, value);
    }
    return normalized;
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
        ? () => new Date(host.now()).toISOString().slice(0, 10)
        : () => new Date(host.now()).toISOString();
      defaulters.push({ name: property.name, fill: stamp });
      if (declared === 'updated') updateStamps.push({ name: property.name, fill: stamp });
      continue;
    }
    if (declared === 'uuid') {
      defaulters.push({ name: property.name, fill: () => host.uuid() });
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
      if (memberOf(out, name) === undefined) setObjectMember(out, name, fill(out));
    }
    // the version token starts at 0 on insert: a row written with SQL
    // NULL never matched the tracker's `WHERE ver = 0` and could not be
    // saved through the unit of work at all
    if (!updating && entity.version !== null && entity.version !== undefined
      && memberOf(out, entity.version) === undefined) {
      setObjectMember(out, entity.version, 0);
    }
    if (updating) {
      for (const { name, fill } of updateStamps) setObjectMember(out, name, fill(out));
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
      const value = doc === null || doc === undefined ? undefined : memberOf(doc, name);
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

  /** A write takes an object: a string would spread into numbered members, and
   * `null` or `undefined` into an empty row (`put()` refuses them the same way).
   * @param {any} doc @param {string} what - what the call takes, for the message */
  const requireObject = (doc, what) => {
    if (!isJsonObject(doc))
      throw new DbRuntimeError('JD2003', what, { docPath, collection: entity.name });
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
      statement = connection.prepare(sql, { readOnly: name === 'get' || name.startsWith('probe:') });
      statements.set(name, statement);
    }
    return statement;
  };
  // an update's shape is the set of members it assigns: the first few shapes
  // stay prepared, any beyond them are prepared for the one call and released
  let updateShapes = 0;
  const runUpdate = (names, sql, use) => {
    const name = `update:${JSON.stringify(names)}`;
    if (!statements.has(name) && updateShapes >= UPDATE_SHAPES) return useStatementOnce(connection, sql, use, { readOnly: false });
    if (!statements.has(name)) updateShapes += 1;
    return chain(prepared(name, sql), use);
  };
  const parameterAt = (i) => dialect.parameterRef(i, 'v');
  const keyWhere = (offset) => keys
    .map((key, i) => `${q(physicalName(key))} = ${parameterAt(offset + i + 1)}`).join(' AND ');
  const selectColumns = [
    ...scalarColumns.filter((column) => !column.epoch).map((column) => physical
      ? `${physicalRead(column, dialect)} AS ${q(physicalName(column.name))}` : q(column.name)),
    ...fkColumns.map((column) => q(column)),
    ...(physical ? [] : [`${dialect.jsonText(q('doc'))} AS ${q('doc')}`]),
  ].join(', ');

  const insertSqlFor = (names) => {
    const withDoc = physical ? names : [...names, 'doc'];
    const refs = withDoc.map((name, i) => (!physical && name === 'doc'
      ? dialect.jsonEncode(parameterAt(i + 1))
      : parameterAt(i + 1)));
    const returning = autoKey !== null && !names.includes(autoKey)
      ? ` RETURNING ${q(physicalName(autoKey))} AS ${q('key')}`
      : '';
    if (withDoc.length === 0) return `INSERT INTO ${tableSql} DEFAULT VALUES${returning}`;
    return `INSERT INTO ${tableSql} (${withDoc.map((n) => q(physicalName(n))).join(', ')}) `
      + `VALUES (${refs.join(', ')})${returning}`;
  };

  // a lookup of a string that is no number on a numeric key column names no
  // row on either engine (see `namesNoNumber`), and a write under one — an
  // insert, a staged removal, a membership — is refused before any statement
  const numericKey = keys.map((name) => ['integer', 'number'].includes(entity.properties.get(name)?.type));
  // an instant key kept as an epoch column (`column: "integer"`): its column
  // holds the epoch, so a key part binds as the epoch the write stored
  const epochKey = keys.map((name) => scalarColumns.some((column) => column.name === name && column.epoch));
  /** One key part as its column holds it — the encoding a write gives the
   * member ({@link encodeColumn}): a physical column's codec, the epoch of an
   * instant kept as an epoch column (a number there already is one), the
   * value itself otherwise. Throws what that encoding refuses (`JD2003`).
   * @param {number} i @param {any} part */
  const keyColumnValue = (i, part) => (epochKey[i] && typeof part === 'number' ? part : encodeColumn(keys[i], part));
  /** {@link keyColumnValue}, or NULL — which matches no row — for a part no
   * row is stored under: text that names no number under a numeric key
   * column, a part the column's encoding refuses (§6): a read answers
   * absent. @param {number} i @param {any} part */
  const storedKeyPart = (i, part) => {
    if (!physical && numericKey[i] && namesNoNumber(part)) return null;
    try { return keyColumnValue(i, part); }
    catch (error) {
      if (/** @type {any} */ (error)?.code === 'JD2003') return null;
      throw error;
    }
  };
  /** The parameters a statement names a row by: each part of a key as its
   * column holds it ({@link storedKeyPart}). @param {any[]} parts */
  const storedKey = (parts) => parts.map((part, i) => storedKeyPart(i, part));
  /** {@link storedKey} for a key argument. @param {any} key */
  const keyParts = (key) => storedKey(normalizeKeyArg(key));
  /** Refuse the parts of a key to write that no write could hold, and answer
   * them: under a numeric key column, a string that names no number
   * (`JD2002` — see `noNumberKeyReason`); a value the key column's encoding
   * refuses (its own `JD2003`, as an insert meets it: a physical column's
   * codec, an epoch column's instant) — at
   * the call that stages the write, never at every save after it. `member`
   * names the many-to-many member of another entity a membership key came
   * from. @param {any[]} parts @param {string} [member] @returns {any[]} */
  const refuseUnnumbered = (parts, member = undefined) => {
    for (let i = 0; i < parts.length; i++) refusePart(parts[i], i, member);
    return parts;
  };
  /** {@link refuseUnnumbered} for one part. @param {any} part @param {number} i @param {string} [member] */
  const refusePart = (part, i, member = undefined) => {
    if (!physical && numericKey[i] && namesNoNumber(part))
      throw new DbRuntimeError('JD2002', noNumberKeyReason(part, member), { docPath, collection: entity.name, key: part });
    if (part !== undefined) keyColumnValue(i, part);
  };
  /** {@link refuseUnnumbered} for a document to insert, which refuses
   * (`JD2002`) a key member left absent too, unless the database allocates
   * it (`default: "auto"`, or a generated column of a physical layout):
   * SQLite would otherwise store a single integer key's row under a rowid
   * of its own choosing that no tracked record names, PostgreSQL refuses
   * the NULL, and a physical layout's codec refused it at every save of a
   * pending insert no key could discard. @param {any} doc */
  const refuseUnnumberedKey = (doc) => {
    for (let i = 0; i < keys.length; i++) {
      const name = keys[i];
      const part = doc[name];
      if ((part === undefined || part === null) && name === autoKey && keyAllocates === false) {
        throw new DbRuntimeError('JD2002', `the key member '${name}' is declared "default": "auto" but its column allocates `
          + 'nothing on this database (it has no default and is not an identity, as read when the store opened): give the column '
          + 'the allocation the model declares (MODEL-FORMAT §9.5) and reopen the store, or write the key',
        { docPath, collection: entity.name });
      }
      if ((part === undefined || part === null) && name !== autoKey && !(physical && columnByName.get(name)?.generated)) {
        throw new DbRuntimeError('JD2002', `the key member '${name}' is missing — only a key declared `
          + '"default": "auto" is the database\'s to allocate', { docPath, collection: entity.name });
      }
      refusePart(part, i);
    }
  };
  const valuedKeys = !physical && (numericKey.some(Boolean) || epochKey.some(Boolean));
  /** The parts of a key as the values they name (§6): decimal text under a
   * numeric key column is the number it spells ({@link numericKeyValue}), so
   * `'16'`, `' 16'`, `'16.0'` and `16` are one key wherever the unit of work
   * files or compares one, and an instant under an epoch key column is the
   * epoch it names, so
   * `'2026-03-01T00:00:00Z'` and `'2026-03-01T00:00:00.000Z'` are one key.
   * Text spelling a number no double holds exactly, or no instant, stays as
   * it is. @param {any[]} parts @returns {any[]} */
  const keyValues = (parts) => {
    if (!valuedKeys) return parts;
    let out = parts;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (typeof part !== 'string') continue;
      if (!epochKey[i] && !numericKey[i]) continue;
      const value = epochKey[i] ? storedKeyPart(i, part) : numericKeyValue(part);
      if (value === null || value === part) continue;
      if (out === parts) out = [...parts];
      out[i] = value;
    }
    return out;
  };

  const normalizeKeyArg = (key) => {
    if (keys.length === 1) {
      if (typeof key === 'string' || typeof key === 'number') return [key];
      if (isJsonObject(key)
        && typeof key[keys[0]] !== 'object' && key[keys[0]] !== undefined)
        return [key[keys[0]]];
    }
    else if (isJsonObject(key)) {
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

  const keyColumns = keys.map(physicalName);
  /** @type {import('./errors.js').UniqueKey} */
  const unique = { table, column: keyColumns.length === 1 ? keyColumns[0] : keyColumns,
    ...(keyConstraint === undefined ? undefined : { constraint: keyConstraint }) };
  /** The members of a key, as the document names them. @param {any} doc */
  const keyOf = (doc) => keys.map((name) => doc[name]);
  /** A key as a sentence names it: the value of a single member, the members of a composite one. @param {any[]} parts */
  const keyText = (parts) => JSON.stringify(keys.length === 1 ? parts[0]
    : Object.fromEntries(keys.map((name, i) => [name, parts[i]])));
  /**
   * What a write's failure is classified by: a collision on the key's own
   * constraint is `JD2001` naming the key — or, for a batch the unit of work
   * inserts, every key the statement carried.
   * @param {any} key - the first key member, which the error carries
   * @param {any[][]} [carried] - the keys the write named, one array of members each
   */
  const writeDetails = (key, carried = [[key]]) => {
    // a key the database allocated is not known here: a sequence does not
    // see a key written explicitly, and can hand it out again
    const named = carried.filter((parts) => parts.every((part) => part !== undefined));
    return {
      docPath, collection: entity.name, ...(key === undefined ? undefined : { key }), unique,
      duplicateReason: named.length === 0
        ? `a '${entity.name}' already exists under the key the database allocated`
        : named.length > 1
          ? `a '${entity.name}' already exists under one of the keys ${named.map(keyText).join(', ')}`
          : `a '${entity.name}' already exists under key ${keyText(named[0])}`,
    };
  };
  const wrapWrite = (error, key, carried = undefined) => wrapDriverError(error, writeDetails(key, carried));
  /**
   * An INSERT of these documents ({@link insertAttempt}): the key values
   * its failure may be settled by are read on that failure only.
   * @param {() => any} call @param {any[]} docs
   */
  const attemptInsert = (call, docs) => insertAttempt(connection, call,
    () => writeDetails(docs.length === 1 ? docs[0][keys[0]] : undefined, docs.map(keyOf)),
    () => ({ tableSql, columns: keyColumns.map(q),
      // the values the INSERT bound; a key the database allocates, or one its codec refused, names no row
      rows: docs.map((doc) => keys.map((name, i) => (doc[name] === undefined || doc[name] === null ? null
        : storedKeyPart(i, doc[name])))).filter((row) => row.every((part) => part !== null)) }));
  /**
   * A write in a transaction of its own — a savepoint inside the caller's.
   * A bracket that cannot open, on a PostgreSQL transaction an earlier
   * failure spent, is classified as the write's own failure (`JD2088`),
   * as its statement would be; a coded failure inside passes through.
   * @param {any} key @param {() => any} run
   */
  const bracketed = (key, run) => attempt(() => connection.transaction(run), (error) => wrapWrite(error, key));

  /**
   * A store rule's `$exists-row`: the probe SQL the database's trigger runs,
   * its values bound, read inside the write's own transaction. A key member
   * with no value, or one its column cannot hold, matches no row.
   * @param {any} spec a resolved probe @param {any} record `{ old, new, op }`
   */
  const probe = (spec, record) => {
    const params = [];
    let none = false;
    const sql = existsRowSql(spec, dialect, (expression, column) => {
      const path = recordPath(expression);
      const value = path === null ? ruleLiteral(expression) : record[path.record]?.[path.name] ?? null;
      let encoded = null;
      try { encoded = value === null ? null : columnCodec(column).encode(value); }
      catch { none = true; }
      if (encoded === null && spec.keys.includes(column.name)) none = true;
      params.push(encoded);
      return dialect.parameterRef(params.length, 'v');
    });
    if (none) return false;
    return attempt(() => chain(prepared(`probe:${sql}`, `SELECT ${sql} AS ${q('hit')}`), (statement) =>
      chain(statement.get(params), (row) => row?.hit === true || Number(row?.hit) === 1)),
    (error) => wrapDriverError(error, { docPath, collection: entity.name }));
  };
  const ruledOps = new Set(entity.invariants.flatMap((rule) => (rule.enforcement === 'store' ? rule.on : [])));
  /** Whether a store rule judges `op`. @param {string} op */
  const ruled = (op) => ruledOps.has(op);
  const triggeredOps = new Set(entity.invariants.flatMap((rule) => (rule.enforcement === 'database' ? rule.on : [])));
  /** Whether a database rule judges `op`: the write is a savepoint of its own,
   * since a refused statement spends a PostgreSQL transaction (a physical
   * row's insert and update are one already). @param {string} op */
  const triggered = (op) => triggeredOps.has(op);
  /** Whether a store rule on `op` reads another row, so its check and the
   * write share one transaction. @param {string} op */
  const probing = (op) => entity.invariants.some((rule) => rule.enforcement === 'store' && rule.on.includes(op) && rule.probes.length > 0);
  // what a database rule counts as a change (§13.1): every column but the
  // version, a generated column and a member a rule increments
  const incremented = new Set(entity.invariants.flatMap((rule) => (rule.effects ?? []).map((effect) => effect.increment)));
  const counted = physical ? scalarColumns.filter((column) => !column.generated && column.name !== entity.version
    && !incremented.has(column.name)).map((column) => column.name) : [];
  /** Whether a counted member differs between two stored rows, each read back
   * through its codec — the comparison a database rule's change test makes. */
  const changedBetween = (before, after) => counted.some((name) =>
    canonicalizeJson(before?.[name] ?? null) !== canonicalizeJson(after?.[name] ?? null));
  /** Judge a physical row's write against the row it replaced and the row now
   * stored: an update that changes no counted member runs no `changed` rule.
   * @param {string} op @param {any} before @param {any} stored @param {string[]} [assigned] */
  const checkStored = (op, before, stored, assigned) => (!ruledOps.has(op) ? null : checkInvariants(entity.invariants, op, before, stored,
    { probe, ...(assigned === undefined ? {} : { assigned }), ...(op === 'update' ? { unchanged: !changedBetween(before, stored) } : {}) }));

  /** Whether a write from `before` to `after` changes nothing the store
   * writes: the version member is the store's own (§11.3), so a change to
   * it alone is no change. @param {any} before @param {any} after */
  const versionOnly = (before, after) => createJSONPatch(before, after).every((op) => memberOfPatch(op) === entity.version);

  const columnByName = new Map(scalarColumns.map((column) => [column.name, column]));
  /** ONE column's value as its column holds it — a physical column's codec,
   * the epoch of an instant kept as an epoch column, a boolean as 1 or 0 —
   * refusing nothing the column would store as another string: what a read
   * compares the stored column with. */
  const columnValue = (name, value) => {
    const column = columnByName.get(name);
    if (physical && column) return column.codecPlan.encode(value);
    if (column !== undefined && column.epoch)
      return value === undefined ? null : epochOf(column.property, value);
    if (value === undefined || value === null) return null;
    return typeof value === 'boolean' ? (value ? 1 : 0) : value;
  };
  /** Encode ONE column's value for a write ({@link split} encodes each
   * column of a row this way). */
  const encodeColumn = (name, value) => storable(name, columnValue(name, value));

  const core = {
    // Temporary migration cores retire only their own completed work. Store
    // cores retain these statements for the Store's existing lifetime.
    releaseStatements(wait = false) {
      const prepared = [...statements.values()];
      statements.clear();
      updateShapes = 0;
      return releasePrepared(prepared, wait);
    },
    // the unit-of-work exposure (tracker.js): the column plan and the
    // completion/validation/stamping machinery, one source of truth
    plan: {
      table,
      tableSql,
      document: !physical,
      physicalName,
      writable,
      // a document is judged as the store reads it back: a member written null is missing
      checkMutation: (op, before, after, options = {}) => checkInvariants(entity.invariants, op,
        before && asStored(before), after && asStored(after), { probe, ...options }),
      checkStored,
      ruled,
      normalize: (doc) => normalizePhysicalDoc(doc),
      unchanged: versionOnly,
      keys,
      autoKey,
      version: entity.version ?? null,
      scalarColumns,
      fkColumns,
      columnSet,
      split,
      merge,
      encodeColumn,
      columnValue,
      refuseUnnumbered,
      keyValues,
      storedKey,
      /** A membership's key to this entity, as a write names it: refused
       * where no write could hold it ({@link refuseUnnumbered}), otherwise
       * the value it names ({@link keyValues}).
       * @param {any[]} parts @param {string} [member] */
      memberKey: (parts, member = undefined) => keyValues(refuseUnnumbered(parts, member)),
      /** An INSERT of these documents, classified as `create()`'s is. */
      attemptInsert,
    },
    complete: (doc, { updating }) => {
      writable();
      requireObject(doc, `${updating ? 'update' : 'add'}() takes an entity document`);
      if (!updating && physical && scalarColumns.some((c) => c.generated && Object.hasOwn(doc, c.name)))
        throw new DbRuntimeError('JD2003', 'generated columns are database-owned');
      const completed = applyDefaults(normalizePhysicalDoc(doc), { updating });
      checkValid(completed);
      if (!updating) refuseUnnumberedKey(completed);
      return asStored(completed);
    },
    validateOnly: (doc) => checkValid(doc),
    stampUpdated: (doc) => {
      if (updateStamps.length === 0) return doc;
      const out = { ...doc };
      for (const { name, fill } of updateStamps) setObjectMember(out, name, fill(out));
      return out;
    },
    normalizeKey: (key) => normalizeKeyArg(key),
    create(doc) {
      writable();
      requireObject(doc, 'create() takes an entity document');
      refuseProjections(doc, 'create', true);
      const completed = applyDefaults(doc, { updating: false });
      checkValid(completed);
      refuseUnnumberedKey(completed);
      if (physical && scalarColumns.some((c) => c.generated && Object.hasOwn(doc, c.name)))
        throw new DbRuntimeError('JD2003', 'generated columns are database-owned');
      const { values, rest } = split(completed);
      const names = values.map((value) => value.name);
      const sql = insertSqlFor(names);
      const insert = () => chain(prepared(`insert:${JSON.stringify(names)}`, sql), (statement) => {
        const params = [...values.map((value) => value.value), ...(physical ? [] : [JSON.stringify(rest)])];
        const returning = autoKey !== null && !names.includes(autoKey);
        return chain(
          attemptInsert(() => (returning ? statement.get(params) : statement.run(params)), [completed]),
          (out) => {
            const made = returning ? { ...completed, [autoKey]: out.key } : completed;
            return physical ? chain(this.get(made), (stored) => {
              checkValid(stored);
              return chain(checkStored('insert', null, stored), () => stored);
            }) : asStored(made);
          });
      });
      if (physical) return bracketed(completed[keys[0]], insert);
      // judged as the store reads the row back: a member written null is missing
      const write = () => chain(checkInvariants(entity.invariants, 'insert', null, asStored(completed), { probe }), insert);
      return probing('insert') || triggered('insert') ? bracketed(completed[keys[0]], write) : write();
    },
    get(key) {
      return readRow(key, 'get', '');
    },
    /**
     * The row a store rule judges as `$.old`, read inside the write's
     * transaction and locked for the rest of it where the engine locks rows
     * (`FOR UPDATE`): a concurrent writer's change waits or lands before the
     * read, never between the read and the statement (§13.3).
     * @param {any} key
     */
    getLocked(key) {
      return readRow(key, 'getLocked', dialect.rowLockSuffix);
    },
    /**
     * The rows whose `column` holds one of `values` — the rows a foreign key
     * on that column names — each read as {@link get} reads one, inside the
     * caller's transaction and locked for the rest of it where the engine
     * locks rows, at most `limit` of them when one is given.
     * @param {string} column - a column of this entity's table
     * @param {any[]} values - the values as the column stores them
     * @param {number} [limit]
     * @param {string} [lock] - the row-lock suffix: `dialect.rowLockSuffix`
     *   (`FOR UPDATE`) by default, `dialect.rowNoKeyLockSuffix` for rows the
     *   write changes only outside their key columns
     * @returns {any[] | Promise<any[]>}
     */
    referencing(column, values, limit = undefined, lock = dialect.rowLockSuffix) {
      if (values.length === 0) return [];
      const sql = `SELECT ${selectColumns} FROM ${tableSql} WHERE ${q(physicalName(column))} `
        + `IN (${values.map((_, i) => parameterAt(i + 1)).join(', ')})`
        + `${limit === undefined ? '' : ` LIMIT ${parameterAt(values.length + 1)}`}${lock}`;
      const params = limit === undefined ? values : [...values, limit];
      return attempt(() => useStatementOnce(connection, sql, (statement) => {
        // pulled through the one cursor mechanism and buffered here, named:
        // the caller records every row once its write ran, and the LIMIT,
        // when there is one, bounds the read
        const cursor = (connection.synchronous ? createSyncCursor : createCursor)({ ...rowClassOf(connection),
          open: () => statement.iterate(params), items: (/** @type {any} */ row) => [merge(row)] });
        /** @type {any[]} */
        const rows = [];
        const pump = () => {
          for (;;) {
            const step = cursor.next();
            if (isThenable(step)) {
              return step.then((/** @type {any} */ pulled) => {
                if (pulled.done) return rows;
                rows.push(pulled.value);
                return pump();
              });
            }
            if (step.done) return rows;
            rows.push(step.value);
          }
        };
        return pump();
      }), (error) => wrapDriverError(error, { docPath, collection: entity.name }));
    },
    update(key, changes) {
      writable();
      requireObject(changes, 'update() takes an object of the members to change');
      const parts = keyParts(key);
      refuseProjections(changes, 'update', false);
      const update = () => chain(ruled('update') ? this.getLocked(key) : this.get(key), (current) => {
        if (current === undefined) {
          throw new DbRuntimeError('JD2006',
            `no '${entity.name}' to update under that key`,
            { docPath, collection: entity.name });
        }
        for (const keyName of keys) {
          // the key identifies the row the UPDATE addresses; rewriting it
          // through `changes` moved rows out from under the tracker
          if (memberOf(changes, keyName) !== undefined
            && changes[keyName] !== current[keyName]) {
            throw new DbRuntimeError('JD2003',
              `'${keyName}' is the primary key — update() cannot rewrite it; delete and create`,
              { docPath, collection: entity.name, key: parts[0] });
          }
        }
        const candidate = normalizePhysicalDoc({ ...current, ...changes });
        // the version is the store's: a change to it alone writes nothing
        if (physical && versionOnly(current, candidate)) return current;
        if (physical && scalarColumns.some((c) => c.generated && Object.hasOwn(changes, c.name)
          && changes[c.name] !== current[c.name])) throw new DbRuntimeError('JD2003', 'generated columns are database-owned');
        const next = applyDefaults(candidate, { updating: true });
        // an explicit update is last-write-wins by contract (§11.2),
        // but it still moves a declared version token so optimistic
        // savers see the row changed
        if (entity.version !== null && entity.version !== undefined)
          setObjectMember(next, entity.version, (Number(current[entity.version]) || 0) + 1);
        checkValid(next);
        const { values: all, rest } = split(next, { updating: true });
        // a physical row is assigned what changes and nothing else, as a
        // tracked save assigns it: an UPDATE OF program sees what was written
        const changed = physical ? new Set(createJSONPatch(current, next).map(memberOfPatch)) : null;
        const values = changed === null ? all : all.filter((value) => changed.has(value.name));
        if (physical && values.length === 0) return current;
        const assignments = [
          ...values.map((value, i) => `${q(physicalName(value.name))} = ${parameterAt(i + 1)}`),
          ...(physical ? [] : [`${q('doc')} = ${dialect.jsonEncode(parameterAt(values.length + 1))}`]),
        ].join(', ');
        const sql = `UPDATE ${tableSql} SET ${assignments} `
          + `WHERE ${keyWhere(values.length + (physical ? 0 : 1))}`;
        return chain(physical ? null : checkInvariants(entity.invariants, 'update', current, asStored(next), { probe }), () =>
          chain(runUpdate(values.map((value) => value.name), sql, (statement) =>
            attempt(() => statement.run([...values.map((value) => value.value),
              ...(physical ? [] : [JSON.stringify(rest)]), ...parts]), (error) => wrapWrite(error, parts[0]))),
          () => physical ? chain(this.get(key), (stored) => {
            checkValid(stored);
            return chain(checkStored('update', current, stored, values.map((value) => value.name)), () => stored);
          }) : asStored(next)));
      });
      // a rule judges the row this update replaces: read and write in one transaction
      return physical || ruled('update') || triggered('update') ? bracketed(parts[0], update) : update();
    },
    delete(key) {
      writable();
      const parts = keyParts(key);
      if (!ruled('delete')) return triggered('delete') ? bracketed(parts[0], () => remove(key)) : remove(key);
      // judged after the delete, against the row it removed, as a database
      // rule is: a key with no row removes nothing and runs no rule
      return bracketed(parts[0], () => chain(this.getLocked(key), (before) => before === undefined ? remove(key)
        : chain(remove(key), (removed) => removed
          ? chain(checkInvariants(entity.invariants, 'delete', before, null, { probe }), () => removed) : removed)));
    },
  };
  core.mutate = createEntityMutation(connection, entity, entityMapping, core);
  return core;
  /**
   * One row by key, merged back into its document: `get`, or `getLocked` with
   * the dialect's row-lock suffix — classified like every read of the query
   * engines, never raw.
   * @param {any} key @param {string} name - the prepared statement's name
   * @param {string} lock - the row-lock suffix, empty for a plain read
   */
  function readRow(key, name, lock) {
    const parts = keyParts(key);
    const sql = `SELECT ${selectColumns} FROM ${tableSql} WHERE ${keyWhere(0)}${lock}`;
    return attempt(() => chain(prepared(name, sql), (statement) =>
      chain(statement.get(parts), (row) => (row === undefined ? undefined : merge(row)))),
    (error) => wrapDriverError(error, { docPath, collection: entity.name, key }));
  }
  function remove(key) {
      const parts = keyParts(key);
      const sql = `DELETE FROM ${tableSql} WHERE ${keyWhere(0)}`;
      return chain(prepared('delete', sql), (statement) =>
        chain(attempt(() => statement.run(parts), (error) => wrapWrite(error, parts[0])),
          (result) => Number(result?.changes ?? 0) > 0));
  }
}
