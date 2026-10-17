//@ts-check
/**
 * @file Row → entity-graph reconstruction. One place owns the merge
 * discipline (§9.3): mapped scalar columns fold back into the JSONB
 * document's parse (booleans un-integer, SQL NULL reads back ABSENT,
 * derived epoch columns are skipped because the string never left the
 * document), foreign-key columns fold in the same way, and — for the
 * one-statement graph loads — projected relation JSON parses
 * recursively into child arrays or single children — and, per root,
 * holds every included relation to its declared bound (MODEL-FORMAT
 * §10.4): more rows than `maxRows` or more serialised bytes than
 * `maxBytes` is the coded refusal `JD2073` naming the root, the member
 * and the bound, never a truncated graph the caller cannot tell from a
 * whole one.
 */

import { setObjectMember } from '@jarenjs/core/object';

import { utf8ByteLength } from '@jarenjs/core/string';
import { columnCodec } from './physical.js';

import { DbRuntimeError, refuseRoundedInteger, roundedIntegerDigits, integerReadFailure, storedIntegerNumber } from './errors.js';
import { jsonBytes, decodeCountedJson } from './json-bytes.js';

/**
 * Refuse an include that crossed its per-root bound.
 * @param {any} node - the parent node (`entity`, `entityMapping`)
 * @param {any} include - the include entry (`name`, `maxRows`, `maxBytes`)
 * @param {any} keyed - the parent row or child object the key is read from
 * @param {'maxRows' | 'maxBytes'} bound
 * @param {number} measured
 * @returns {DbRuntimeError}
 */
function boundRefusal(node, include, keyed, bound, measured) {
  const limit = include[bound];
  const key = node.entityMapping.keys.map((name) => JSON.stringify(keyed[name])).join(', ');
  const entity = node.entity?.name ?? node.entityMapping.table;
  return new DbRuntimeError('JD2073',
    `the include '${include.name}' of ${entity} ${key} holds ${bound === 'maxRows'
      ? `more than ${limit} rows` : `${measured} serialised bytes, more than ${limit}`} — its `
    + `${bound} bound for one root. Declare ${bound}: Infinity on the include to load it whole `
    + `by decision, read { count: true } for the size, or page the relation separately`,
    { collection: entity, key: node.entityMapping.keys.length === 1 ? keyed[node.entityMapping.keys[0]] : undefined });
}

/**
 * Hold one include of one parent to its bounds. Bytes are measured on
 * the serialised text the database projected (a nested include arrives
 * already embedded as JSON and carries its decoder-computed size); rows on
 * the parsed array.
 * @param {any} node
 * @param {any} include
 * @param {any} keyed
 * @param {any} raw - the projected value: text at the root, JSON below
 * @param {WeakMap<object, number>} sizes
 * @returns {any} the bounded decoded value
 */
function checkBounds(node, include, keyed, raw, sizes) {
  if (include.maxBytes !== null && include.maxBytes !== undefined) {
    const bytes = typeof raw === 'string' ? utf8ByteLength(raw) : jsonBytes(raw, sizes);
    if (bytes > include.maxBytes) throw boundRefusal(node, include, keyed, 'maxBytes', bytes);
  }
  const parsed = typeof raw === 'string' ? decodeCountedJson(raw, sizes) : raw;
  if (include.many && include.maxRows !== null && include.maxRows !== undefined
    && parsed.length > include.maxRows) {
    throw boundRefusal(node, include, keyed, 'maxRows', parsed.length);
  }
  return parsed;
}

/**
 * Merge one database row back into its entity document.
 * @param {any} entityMapping - `explainMapping(...).entities[name]`
 * @param {any} row - a row carrying the entity's columns plus the
 *   rendered document text
 * @param {string} [docField] - the column the document text rides in
 * @returns {any} the document; an `integer` column whose stored integer its
 *   driver rounded refuses it (`JD2003` once the driver error is coded)
 */
export function mergeEntityRow(entityMapping, row, docField = 'doc') {
  const doc = entityMapping.document === false ? {} : JSON.parse(row[docField]);
  for (const column of entityMapping.columns) {
    if (column.source === 'epoch(document)') continue;
    if (entityMapping.document === false && column.codec) {
      const value = columnCodec(column).decode(row[column.physical ?? column.name]);
      if (value !== undefined) setObjectMember(doc, column.name, value);
      continue;
    }
    const value = row[column.name];
    if (value === null || value === undefined) continue;
    if (column.storage === 'integer') refuseRoundedInteger(row, column.name);
    setObjectMember(doc, column.name, column.storage === 'boolean' ? value === 1 : value);
  }
  foldForeignKeys(entityMapping, row, doc);
  return doc;
}

/**
 * Fold a row's foreign-key columns into its document: a column a mapped
 * member owns was folded with the members — an epoch column's document keeps
 * the instant's string, never the epoch the column holds.
 * @param {any} entityMapping @param {any} row @param {any} doc
 */
function foldForeignKeys(entityMapping, row, doc) {
  for (const fk of entityMapping.foreignKeys) {
    if (entityMapping.columns.some((/** @type {any} */ column) => column.name === fk.column)) continue;
    const value = row[fk.column];
    if (value !== null && value !== undefined) setObjectMember(doc, fk.column, value);
  }
}

/**
 * Parse one graph-load row: the root entity's merge plus every
 * included relation's projected JSON, recursively.
 * @param {any} node - the include-plan node
 *   `{ entityMapping, includes: { name, field, many, count, child }[] }`
 * @param {any} row
 * @param {string} docField
 * @param {boolean} [exactIntegers] - whether the engine holds an `integer`
 *   column's exact integer (SQLite: `dialect.integerDigits`), which an
 *   included child reads by that rule rather than PostgreSQL's
 * @returns {any}
 */
export function parseGraphRow(node, row, docField = '__doc', exactIntegers = false) {
  const sizes = new WeakMap();
  const doc = mergeEntityRow(node.entityMapping, row, docField);
  for (const include of node.includes) {
    const raw = row[include.field];
    if (include.count === true) {
      setObjectMember(doc, include.name, Number(raw ?? 0));
      continue;
    }
    if (raw === null || raw === undefined) {
      setObjectMember(doc, include.name, include.many ? [] : null);
      continue;
    }
    const parsed = checkBounds(node, include, row, raw, sizes);
    setObjectMember(doc, include.name, include.many
      ? parsed.map((child) => parseGraphChild(include.child, child, sizes, exactIntegers))
      : parseGraphChild(include.child, parsed, sizes, exactIntegers));
  }
  return doc;
}

/**
 * An included child's `integer` column holding an integer past ±(2^53 - 1),
 * which crosses as its digits (`dialect.jsonInteger`): the number they spell,
 * refused where the row read whole refuses it — on an engine that holds the
 * exact integer (`exact`, SQLite) wherever the number would round it, and on
 * one that holds the digits a JavaScript number wrote (PostgreSQL) where they
 * are not that number's either.
 * @param {string} digits
 * @param {boolean} exact
 * @returns {number}
 */
function includedInteger(digits, exact) {
  if (exact) return storedIntegerNumber(BigInt(digits));
  const rounded = roundedIntegerDigits(digits);
  if (rounded !== null) throw integerReadFailure(rounded);
  return Number(digits);
}

/**
 * A child arrives as a plain object (json_object projection): columns
 * under their names, the document under `__doc` — embedded as real
 * JSON, because json() carries the JSON subtype into json_object —
 * and nested includes under their fields.
 * @param {any} node
 * @param {any} child
 * @param {WeakMap<object, number>} sizes
 * @param {boolean} exactIntegers - as {@link parseGraphRow} takes it
 * @returns {any}
 */
function parseGraphChild(node, child, sizes, exactIntegers) {
  const doc = typeof child.__doc === 'string' ? JSON.parse(child.__doc) : child.__doc;
  for (const column of node.entityMapping.columns) {
    if (column.source === 'epoch(document)') continue;
    const value = child[column.name];
    if (value === null || value === undefined) continue;
    setObjectMember(doc, column.name, column.storage === 'boolean' ? value === 1
      : column.storage === 'integer' && typeof value === 'object' ? includedInteger(value.digits, exactIntegers) : value);
  }
  foldForeignKeys(node.entityMapping, child, doc);
  for (const include of node.includes) {
    const raw = child[include.field];
    if (include.count === true) {
      setObjectMember(doc, include.name, Number(raw ?? 0));
      continue;
    }
    if (raw === null || raw === undefined) {
      setObjectMember(doc, include.name, include.many ? [] : null);
      continue;
    }
    const parsed = checkBounds(node, include, child, raw, sizes);
    setObjectMember(doc, include.name, include.many
      ? parsed.map((grandchild) => parseGraphChild(include.child, grandchild, sizes, exactIntegers))
      : parseGraphChild(include.child, parsed, sizes, exactIntegers));
  }
  return doc;
}
