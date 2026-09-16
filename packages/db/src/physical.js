//@ts-check
/** Explicit column layouts and lossless JSON-facing column codecs. */
import { getEpochOfDateTimeRFC3339, getEpochOfDateOnlyRFC3339 } from '@jarenjs/core/dates/rfc3339';
import { DbCompileError, DbRuntimeError } from './errors.js';
import { chain } from './driver.js';
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { planTable } from './dialects/sqlite-schema.js';
import { sqlitePhysicalColumnType } from './dialects/sqlite.js';

const compiledCodecs = new WeakMap();
const STORAGE = { text: 'string', integer: 'integer', number: 'number', boolean: 'boolean',
  json: 'string', date: 'string', datetime: 'string', 'epoch-ms': 'integer', bigint: 'integer', decimal: 'string', 'blob-hex': 'string',
  uuid: 'string', 'local-timestamp': 'string', instant: 'string' };
const identifier = (v) => typeof v === 'string' && v.length > 0 && !v.includes('\0');
const PROGRAMS = ['constraints', 'indexes', 'triggers', 'strict', 'withoutRowid'];

/** Normalize a declared layout; implicit conversions are never adoption policy.
 * @param {any} physical @param {Map<string, any>} properties @param {string[]} keys
 * @param {string} path @returns {any} */
export function normalizePhysical(physical, properties, keys, path) {
  if (physical === undefined) return null;
  const fail = (reason) => { throw new DbCompileError('JD0005', reason, `${path}/physical`); };
  if (!physical || typeof physical !== 'object' || Array.isArray(physical)) fail('physical must be an object');
  for (const key of Object.keys(physical))
    if (!['table', 'schema', 'kind', 'keys', 'columns', ...PROGRAMS].includes(key)) fail(`unknown physical member '${key}'`);
  if (!identifier(physical.table)) fail('physical.table must be a nonempty SQL identifier');
  if (physical.schema !== undefined && !identifier(physical.schema)) fail('physical.schema must be a nonempty SQL identifier');
  if (physical.kind !== undefined && !['table', 'view'].includes(physical.kind)) fail('physical.kind is table or view');
  if (!physical.columns || typeof physical.columns !== 'object' || Array.isArray(physical.columns)) fail('physical.columns is required');
  const ordered = physical.keys ?? keys;
  if (!Array.isArray(ordered) || ordered.length !== keys.length || new Set(ordered).size !== keys.length
    || ordered.some((key) => !keys.includes(key))) fail('physical.keys must order every declared key exactly once');
  const used = new Set();
  const columns = [];
  const names = Object.keys(physical.columns);
  for (const name of names)
    if (!properties.has(name) || properties.get(name).relation) fail(`column '${name}' is not a stored property`);
  for (const [name, property] of properties)
    if (!property.relation && !Object.hasOwn(physical.columns, name)) fail(`'${name}' needs an explicit supported column codec`);
  const definitions = [];
  for (const name of names) {
    const property = properties.get(name);
    const c = physical.columns[name];
    if (!c || typeof c !== 'object' || Array.isArray(c) || !Object.hasOwn(STORAGE, c.codec)) fail(`'${name}' needs an explicit supported column codec`);
    for (const key of Object.keys(c))
      if (!['name', 'codec', 'null', 'default', 'generated', 'type', 'defaultValue', 'collation', 'identity', 'check', 'generatedExpression', 'stored'].includes(key)) fail(`unknown column member '${key}'`);
    if (!identifier(c.name) || used.has(c.name.toLowerCase())) fail(`'${name}' needs a distinct physical column name`);
    if (!['null', 'absent', 'reject'].includes(c.null)) fail(`'${name}' must declare SQL NULL as null, absent or reject`);
    if (c.type !== undefined && (physical.schema === undefined
      ? c.type !== sqlitePhysicalColumnType(c.codec) : typeof c.type !== 'string' || !c.type || c.type.includes('\0')))
      fail(`'${name}' declares an affinity incompatible with its codec`);
    if (c.stored !== undefined && (typeof c.stored !== 'boolean' || c.generatedExpression === undefined))
      fail(`'${name}' needs an explicit generated expression for stored ownership`);
    if (c.default !== undefined && c.default !== 'database') fail('column default ownership is database');
    if (c.generated !== undefined && typeof c.generated !== 'boolean') fail('generated must be boolean');
    if (property.key && (!['text', 'integer', 'bigint', 'uuid'].includes(c.codec) || c.null !== 'reject')) fail('keys require non-null text, integer, bigint or uuid codecs');
    if (property.column !== undefined) fail('physical codecs replace hybrid column overrides');
    if ((c.default === 'database' || Object.hasOwn(c, 'defaultValue')) && property.default !== undefined && property.default !== 'auto') fail('a default has exactly one owner');
    if (c.generatedExpression !== undefined && c.generated === false) fail('a generated expression requires generated ownership');
    if (physical.schema !== undefined && ['defaultValue', 'collation', 'check', 'generatedExpression', 'stored'].some((key) => c[key] !== undefined))
      fail('native expressions require a reviewed migration');
    used.add(c.name.toLowerCase());
    columns.push({ name, physical: c.name, codec: c.codec, null: c.null, databaseDefault: c.default === 'database' || Object.hasOwn(c, 'defaultValue'),
      generated: c.generated === true || c.generatedExpression !== undefined, storage: STORAGE[c.codec], source: 'column', key: property.key,
      ...(c.type === undefined ? {} : { declaredType: c.type }),
      ...(c.identity === undefined ? {} : { identity: c.identity }) });
    definitions.push({ name: c.name,
      type: c.type ?? sqlitePhysicalColumnType(c.codec),
      nullable: c.null !== 'reject',
      ...(Object.hasOwn(c, 'defaultValue') ? { default: c.defaultValue } : {}),
      ...(c.identity !== undefined || property.default === 'auto' ? { identity: c.identity ?? 'rowid' } : {}),
      ...(c.collation === undefined ? {} : { collation: c.collation }),
      ...(c.check === undefined ? {} : { check: c.check }),
      ...(c.generatedExpression === undefined ? {} : { generated: c.generatedExpression, stored: c.stored === true }),
    });
  }
  const definition = { name: physical.table, columns: definitions,
    primaryKey: ordered.map((key) => physical.columns[key].name),
    ...Object.fromEntries(PROGRAMS
      .filter((key) => physical[key] !== undefined).map((key) => [key, physical[key]])) };
  if (physical.schema === undefined && physical.kind !== 'view') planTable(definition);
  if (physical.schema !== undefined && PROGRAMS.some((key) => physical[key] !== undefined))
    fail('native programs require a reviewed migration');
  // Database-owned expressions must be explicit before DDL can own them.
  const ddl = physical.schema !== undefined || physical.kind === 'view' || columns.some((c, i) => (c.generated && definitions[i].generated === undefined)
    || (c.databaseDefault && !Object.hasOwn(definitions[i], 'default')))
    ? null : definition;
  return { table: physical.table, ...(physical.schema === undefined ? {} : { schema: physical.schema }),
    kind: physical.kind ?? 'table', keys: [...ordered], columns, ddl };
}

/** Compile one codec once, with a JSON-safe public value and a bound SQL value.
 * @param {any} column @returns {{ encode: Function, decode: Function, normalize: Function }} */
export function columnCodec(column) {
  if (compiledCodecs.has(column)) return compiledCodecs.get(column);
  const fail = () => { throw new DbRuntimeError('JD2003', `column '${column.name}' refuses a lossy or invalid ${column.codec} value`); };
  const date = (v, only) => typeof v === 'string' && Number.isFinite(only
    ? getEpochOfDateOnlyRFC3339(v) : getEpochOfDateTimeRFC3339(v));
  const timestamp = (v, instant) => {
    if (typeof v !== 'string') return false;
    const match = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)\.(\d{6})(Z?)$/.exec(v);
    return match !== null && match[1].slice(0, 4) !== '0000' && date(match[1], true)
      && (match[6] === 'Z') === instant
      && (column.fractionDigits === undefined || !/[1-9]/.test(match[5].slice(column.fractionDigits)));
  };
  const convert = (v, reading) => {
    if (v === undefined || v === null) {
      if (!reading && v === null && column.codec === 'json') return 'null';
      if (column.null === 'reject') return fail();
      return reading ? (column.null === 'absent' ? undefined : null) : null;
    }
    switch (column.codec) {
      case 'text': if (typeof v === 'string') return v; break;
      case 'uuid': if (typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return v.toLowerCase(); break;
      case 'integer': if (typeof v === 'number' && Number.isSafeInteger(v)) return v; break;
      case 'number': if (typeof v === 'number' && Number.isFinite(v) && (!Number.isInteger(v) || Number.isSafeInteger(v))) return v; break;
      case 'boolean':
        if (reading && (v === 0 || v === 1 || typeof v === 'boolean')) return v === 1 || v === true;
        if (!reading && typeof v === 'boolean') return v ? 1 : 0;
        break;
      case 'bigint': if (typeof v === 'string' && /^(?:0|-?[1-9][0-9]*)$/.test(v)
        && BigInt(v) >= -9223372036854775808n && BigInt(v) <= 9223372036854775807n) return v; break;
      case 'decimal': if (typeof v === 'string' && /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(v)
        && (!column.nativeNumeric || !/^-0(?:\.0+)?$/.test(v))
        && (column.scale === undefined || (v.split('.')[1]?.length ?? 0) === column.scale)) return v; break;
      case 'date': if (date(v, true)) return v; break;
      case 'datetime': if (date(v, false)) return v; break;
      case 'local-timestamp': if (timestamp(v, false)) return v; break;
      case 'instant': if (timestamp(v, true)) return v; break;
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
  const codec = { encode: (v) => convert(v, false), decode: (v) => convert(v, true), normalize: (v) => {
    const encoded = convert(v, false);
    return column.codec === 'blob-hex' && encoded !== null ? v.toLowerCase() : convert(encoded, true);
  } };
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
  if (!connection.dialect.physicalTypeMatches) fail('this backend has no qualified physical codecs');
  if (connection.dialect.physicalNamespaceRequired && connection.dialect.schema === undefined)
    fail('physical adoption requires an explicit driver-owned schema');
  if (mapping.schema !== undefined && mapping.schema !== connection.dialect.schema)
    fail('declared schema must equal the driver-owned schema');
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
      connection.dialect.qualifyPhysicalColumn?.(column, actual, mapping.kind);
    }
    return null;
  });
}

/** Select mapped columns with their physical aliases for the shared row merger.
 * @param {any} mapping @param {any} dialect @param {string} [prefix] @returns {string} */
export function physicalSelection(mapping, dialect, prefix = '') {
  return mapping.columns.map((c) => `${physicalRead(c, dialect, prefix)} AS ${dialect.quoteIdentifier(c.physical ?? c.name)}`).join(', ');
}
