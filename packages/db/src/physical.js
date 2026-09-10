//@ts-check
/** Explicit column layouts and lossless JSON-facing column codecs. */
import { getEpochOfDateTimeRFC3339, getEpochOfDateOnlyRFC3339 } from '@jarenjs/core/dates/rfc3339';
import { DbCompileError, DbRuntimeError } from './errors.js';
import { chain } from './driver.js';
import { canonicalizeJson } from '@jarenjs/json/canonical';

const compiledCodecs = new WeakMap();
const CODECS = new Set(['text', 'integer', 'number', 'boolean', 'json', 'date', 'datetime', 'epoch-ms', 'bigint', 'decimal', 'blob-hex']);
const STORAGE = { text: 'string', integer: 'integer', number: 'number', boolean: 'boolean',
  json: 'string', date: 'string', datetime: 'string', 'epoch-ms': 'integer', bigint: 'integer', decimal: 'string', 'blob-hex': 'string' };
const identifier = (v) => typeof v === 'string' && v.length > 0 && !v.includes('\0');

/** Normalize a declared layout; implicit conversions are never adoption policy.
 * @param {any} physical @param {Map<string, any>} properties @param {string[]} keys
 * @param {string} path @returns {any} */
export function normalizePhysical(physical, properties, keys, path) {
  if (physical === undefined) return null;
  const fail = (reason) => { throw new DbCompileError('JD0005', reason, `${path}/physical`); };
  if (!physical || typeof physical !== 'object' || Array.isArray(physical)) fail('physical must be an object');
  for (const key of Object.keys(physical))
    if (!['table', 'kind', 'keys', 'columns'].includes(key)) fail(`unknown physical member '${key}'`);
  if (!identifier(physical.table)) fail('physical.table must be a nonempty SQL identifier');
  if (physical.kind !== undefined && !['table', 'view'].includes(physical.kind)) fail('physical.kind is table or view');
  if (!physical.columns || typeof physical.columns !== 'object' || Array.isArray(physical.columns)) fail('physical.columns is required');
  const ordered = physical.keys ?? keys;
  if (!Array.isArray(ordered) || ordered.length !== keys.length || new Set(ordered).size !== keys.length
    || ordered.some((key) => !keys.includes(key))) fail('physical.keys must order every declared key exactly once');
  const used = new Set();
  const columns = [];
  for (const [name, property] of properties) {
    if (property.relation) continue;
    const c = physical.columns[name];
    if (!c || typeof c !== 'object' || Array.isArray(c) || !CODECS.has(c.codec)) fail(`'${name}' needs an explicit supported column codec`);
    for (const key of Object.keys(c))
      if (!['name', 'codec', 'null', 'default', 'generated'].includes(key)) fail(`unknown column member '${key}'`);
    if (!identifier(c.name) || used.has(c.name.toLowerCase())) fail(`'${name}' needs a distinct physical column name`);
    if (!['null', 'absent', 'reject'].includes(c.null)) fail(`'${name}' must declare SQL NULL as null, absent or reject`);
    if (c.default !== undefined && c.default !== 'database') fail('column default ownership is database');
    if (c.generated !== undefined && typeof c.generated !== 'boolean') fail('generated must be boolean');
    if (property.key && (!['text', 'integer', 'bigint'].includes(c.codec) || c.null !== 'reject')) fail('keys require non-null text, integer or bigint codecs');
    if (property.column !== undefined) fail('physical codecs replace hybrid column overrides');
    if (c.default === 'database' && property.default !== undefined && property.default !== 'auto') fail('a default has exactly one owner');
    used.add(c.name.toLowerCase());
    columns.push({ name, physical: c.name, codec: c.codec, null: c.null, databaseDefault: c.default === 'database',
      generated: c.generated === true, storage: STORAGE[c.codec], source: 'column', key: property.key });
  }
  for (const name of Object.keys(physical.columns))
    if (!properties.has(name) || properties.get(name).relation) fail(`column '${name}' is not a stored property`);
  return { table: physical.table, kind: physical.kind ?? 'table', keys: [...ordered], columns };
}

/** Compile one codec once, with a JSON-safe public value and a bound SQL value.
 * @param {any} column @returns {{ encode: Function, decode: Function }} */
export function columnCodec(column) {
  if (compiledCodecs.has(column)) return compiledCodecs.get(column);
  const fail = () => { throw new DbRuntimeError('JD2003', `column '${column.name}' refuses a lossy or invalid ${column.codec} value`); };
  const date = (v, only) => typeof v === 'string' && Number.isFinite(only
    ? getEpochOfDateOnlyRFC3339(v) : getEpochOfDateTimeRFC3339(v));
  const convert = (v, reading) => {
    if (v === undefined || v === null) {
      if (!reading && v === null && column.codec === 'json') return 'null';
      if (column.null === 'reject') return fail();
      return reading ? (column.null === 'absent' ? undefined : null) : null;
    }
    switch (column.codec) {
      case 'text': if (typeof v === 'string') return v; break;
      case 'integer': if (typeof v === 'number' && Number.isSafeInteger(v)) return v; break;
      case 'number': if (typeof v === 'number' && Number.isFinite(v) && (!Number.isInteger(v) || Number.isSafeInteger(v))) return v; break;
      case 'boolean':
        if (reading && (v === 0 || v === 1 || typeof v === 'boolean')) return v === 1 || v === true;
        if (!reading && typeof v === 'boolean') return v ? 1 : 0;
        break;
      case 'bigint': if (typeof v === 'string' && /^(?:0|-?[1-9][0-9]*)$/.test(v)
        && BigInt(v) >= -9223372036854775808n && BigInt(v) <= 9223372036854775807n) return v; break;
      case 'decimal': if (typeof v === 'string' && /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(v)) return v; break;
      case 'date': if (date(v, true)) return v; break;
      case 'datetime': if (date(v, false)) return v; break;
      case 'epoch-ms':
        if (reading && typeof v === 'number' && Number.isSafeInteger(v) && Number.isFinite(new Date(v).getTime())) return new Date(v).toISOString();
        if (!reading && date(v, false) && new Date(v).toISOString() === v) return getEpochOfDateTimeRFC3339(v);
        break;
      case 'blob-hex':
        if (typeof v === 'string' && /^(?:[0-9a-fA-F]{2})*$/.test(v))
          return reading ? v.toLowerCase() : Uint8Array.from(v.match(/../g) ?? [], (b) => parseInt(b, 16));
        break;
      case 'json':
        try {
          if (reading) return JSON.parse(v);
          canonicalizeJson(v);
          const text = JSON.stringify(v);
          if (text !== undefined && JSON.stringify(JSON.parse(text)) === text) return text;
        }
        catch { return fail(); }
        break;
    }
    return fail();
  };
  const codec = { encode: (v) => convert(v, false), decode: (v) => convert(v, true) };
  compiledCodecs.set(column, codec);
  return codec;
}

/** SQL selection keeps unsafe integers and byte handles out of application state.
 * @param {any} column @param {any} dialect @param {string} [prefix] @returns {string} */
export function physicalRead(column, dialect, prefix = '') {
  const sql = `${prefix}${dialect.quoteIdentifier(column.physical ?? column.name)}`;
  return dialect.physicalRead(column.codec, sql);
}

/** Verify an existing mapped object without executing DDL. Unmapped columns and
 * all application-owned programs remain physical facts, never inferred drops.
 * @param {any} connection @param {any} mapping @param {any} schema @returns {any} */
export function verifyPhysical(connection, mapping, schema) {
  const fail = (why) => { throw new DbCompileError('JD0002', `physical '${mapping.table}': ${why}`); };
  if (connection.dialect.name !== 'sqlite') fail('column adoption is qualified only for SQLite');
  const object = schema.objects.find((o) => o.name === mapping.table && o.type === mapping.kind);
  if (!object) fail(`declared ${mapping.kind} does not exist`);
  for (const trigger of mapping.triggers ?? []) {
    const actual = schema.objects.find((o) => o.type === 'trigger' && o.name === trigger.name);
    if (!actual || actual.sql?.trim().replace(/;$/, '') !== trigger.sql.trim().replace(/;$/, '')) fail(`invariant trigger '${trigger.name}' is missing or changed; apply an explicit migration`);
  }
  const read = mapping.kind === 'view'
    ? chain(connection.prepare(connection.dialect.introspect.columns(mapping.table)), (s) =>
      chain(s.all([]), (columns) => ({ columns: columns.map((c) => ({ ...c, generated: !!c.hidden })), primaryKey: [] })))
    : schema.tables.find((t) => t.name === mapping.table);
  return chain(read, (table) => {
    if (mapping.kind !== 'view' && JSON.stringify(table.primaryKey) !== JSON.stringify(mapping.keys.map((k) => mapping.columns.find((c) => c.name === k).physical))) fail('ordered primary key disagrees');
    for (const column of mapping.columns) {
      const actual = table.columns.find((c) => c.name === column.physical);
      if (!actual) fail(`column '${column.physical}' does not exist`);
      const type = actual.type.toUpperCase();
      if (!connection.dialect.physicalTypeMatches(column.codec, type)) fail(`'${column.physical}' type ${type} cannot guarantee codec ${column.codec}`);
      if (mapping.kind !== 'view' && actual.generated !== column.generated) fail(`'${column.physical}' generated ownership disagrees`);
    }
    return null;
  });
}

/** Select mapped columns with their physical aliases for the shared row merger.
 * @param {any} mapping @param {any} dialect @param {string} [prefix] @returns {string} */
export function physicalSelection(mapping, dialect, prefix = '') {
  return mapping.columns.map((c) => `${physicalRead(c, dialect, prefix)} AS ${dialect.quoteIdentifier(c.physical ?? c.name)}`).join(', ');
}
