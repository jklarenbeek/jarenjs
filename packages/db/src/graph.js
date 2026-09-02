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

import { DbRuntimeError } from './errors.js';
import { utf8Length } from './cursor.js';

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
 * already embedded as JSON and is re-serialised to measure it); rows on
 * the parsed array.
 * @param {any} node
 * @param {any} include
 * @param {any} keyed
 * @param {any} raw - the projected value: text at the root, JSON below
 * @param {any} parsed
 */
function checkBounds(node, include, keyed, raw, parsed) {
  if (include.maxBytes !== null && include.maxBytes !== undefined) {
    const bytes = utf8Length(typeof raw === 'string' ? raw : JSON.stringify(raw));
    if (bytes > include.maxBytes) throw boundRefusal(node, include, keyed, 'maxBytes', bytes);
  }
  if (include.many && include.maxRows !== null && include.maxRows !== undefined
    && parsed.length > include.maxRows) {
    throw boundRefusal(node, include, keyed, 'maxRows', parsed.length);
  }
}

/**
 * Merge one database row back into its entity document.
 * @param {any} entityMapping - `explainMapping(...).entities[name]`
 * @param {any} row - a row carrying the entity's columns plus the
 *   rendered document text
 * @param {string} [docField] - the column the document text rides in
 * @returns {any}
 */
export function mergeEntityRow(entityMapping, row, docField = 'doc') {
  const doc = JSON.parse(row[docField]);
  for (const column of entityMapping.columns) {
    if (column.source === 'epoch(document)') continue;
    const value = row[column.name];
    if (value === null || value === undefined) continue;
    doc[column.name] = column.storage === 'boolean' ? value === 1 : value;
  }
  for (const fk of entityMapping.foreignKeys) {
    const value = row[fk.column];
    if (value !== null && value !== undefined) doc[fk.column] = value;
  }
  return doc;
}

/**
 * Parse one graph-load row: the root entity's merge plus every
 * included relation's projected JSON, recursively.
 * @param {any} node - the include-plan node
 *   `{ entityMapping, includes: { name, field, many, count, child }[] }`
 * @param {any} row
 * @param {string} docField
 * @returns {any}
 */
export function parseGraphRow(node, row, docField = '__doc') {
  const doc = mergeEntityRow(node.entityMapping, row, docField);
  for (const include of node.includes) {
    const raw = row[include.field];
    if (include.count === true) {
      doc[include.name] = Number(raw ?? 0);
      continue;
    }
    if (raw === null || raw === undefined) {
      doc[include.name] = include.many ? [] : null;
      continue;
    }
    const parsed = JSON.parse(raw);
    checkBounds(node, include, row, raw, parsed);
    doc[include.name] = include.many
      ? parsed.map((child) => parseGraphChild(include.child, child))
      : parseGraphChild(include.child, parsed);
  }
  return doc;
}

/**
 * A child arrives as a plain object (json_object projection): columns
 * under their names, the document under `__doc` — embedded as real
 * JSON, because json() carries the JSON subtype into json_object —
 * and nested includes under their fields.
 * @param {any} node
 * @param {any} child
 * @returns {any}
 */
function parseGraphChild(node, child) {
  const doc = typeof child.__doc === 'string' ? JSON.parse(child.__doc) : child.__doc;
  for (const column of node.entityMapping.columns) {
    if (column.source === 'epoch(document)') continue;
    const value = child[column.name];
    if (value === null || value === undefined) continue;
    doc[column.name] = column.storage === 'boolean' ? value === 1 : value;
  }
  for (const fk of node.entityMapping.foreignKeys) {
    const value = child[fk.column];
    if (value !== null && value !== undefined) doc[fk.column] = value;
  }
  for (const include of node.includes) {
    const raw = child[include.field];
    if (include.count === true) {
      doc[include.name] = Number(raw ?? 0);
      continue;
    }
    if (raw === null || raw === undefined) {
      doc[include.name] = include.many ? [] : null;
      continue;
    }
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    checkBounds(node, include, child, raw, parsed);
    doc[include.name] = include.many
      ? parsed.map((grandchild) => parseGraphChild(include.child, grandchild))
      : parseGraphChild(include.child, parsed);
  }
  return doc;
}
