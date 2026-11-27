//@ts-check
/**
 * @file Declared temporal members (MODEL-FORMAT §2, `temporals`): the one
 * place a calendar value of `@jarenjs/core/calendar` becomes the columns a
 * table keys it by and the CHECK that holds every writer to its kind.
 *
 * A value keeps the spelling it was written in, in the document. Its key is
 * the one spelling of that value, so two spellings of one value are one key
 * and the key's order is the value's: a `date` its date, a `date-range` its
 * two dates, a `floating` value its wall clock padded to seconds and three
 * fraction digits, a `utc` value its instant padded likewise. Each of those
 * is a GENERATED column both engines spell the same way, from the member's
 * text alone (no date or zone arithmetic in SQL), so no writer can leave it
 * stale. A `zoned` value's key is the instant it resolves to, which takes a
 * zone database: the store computes it in JavaScript through its zone
 * provider under the declared policy and writes it beside the provider's
 * identity (`tk_<name>$<policy>`), so a key a later revision would move is known
 * by its stamp. A zoned key only narrows: the engine decides every row, and a
 * row stamped by another provider is always a candidate.
 *
 * Everything here reaches a store only through the seam a host installs,
 * `storeTemporals()` of `@jarenjs/db/temporals` ({@link TEMPORAL_HOOKS}):
 * a store that declares no temporal member carries none of it, nor the
 * calendar.
 */

import { parseTemporal, toUtc, RESOLUTION_POLICIES } from '@jarenjs/core/calendar';
import { isJsonObject } from '@jarenjs/core/object';
import { utf8ByteLength } from '@jarenjs/core/string';
import { DbCompileError, DbRuntimeError, wrapDriverError } from './errors.js';
import { chain, inOrder, attempt, useStatementOnce } from './driver.js';
import { refuseUnknownModelMembers } from './options.js';
import { IDENTIFIER } from './engine-metadata.js';
import { compileIndexPath, schemaNodeAt, canonicalOf } from './ddl.js';
import { memberPath, COMPARISONS, refusal, exactly, promotion, constantOf, integerBound } from './plan.js';
import { CONSTRAINT_NAME_BYTES } from './store.js';
import { modelPath } from './model-path.js';
import { temporalSpelling } from './dialects/temporal.js';

/** The five calendar kinds a member may be declared. */
export const TEMPORAL_KINDS = Object.freeze(['date', 'floating', 'utc', 'zoned', 'date-range']);

/** The policies a zoned declaration resolves a gap or fold under. */
export const TEMPORAL_POLICIES = RESOLUTION_POLICIES;

/** Each kind's own members, `kind` first: a value holds these and no other. */
const MEMBERS = Object.freeze({
  date: ['kind', 'date'], floating: ['kind', 'date', 'time'], utc: ['kind', 'instant'],
  zoned: ['kind', 'date', 'time', 'zone'], 'date-range': ['kind', 'start', 'end'],
});

/** The least and greatest instant a calendar value spells: 0000-01-01 and
 * 9999-12-31T23:59:59.999Z, in epoch milliseconds. */
export const INSTANT_MIN = -62167219200000;
export const INSTANT_MAX = 253402300799999;

/**
 * The columns one declaration keys its member by. A zoned member's stamp is
 * named after its policy: a key resolved under another policy is another
 * key, so a changed policy is a new column whose rows no key reads yet.
 * @param {{ name: string, kind: string, policy?: string }} temporal
 * @returns {{ key: string, end?: string, stamp?: string }}
 */
export function temporalColumns(temporal) {
  const key = `tk_${temporal.name}`;
  if (temporal.kind === 'date-range') return { key, end: `${key}$end` };
  if (temporal.kind === 'zoned') return { key, stamp: `${key}$${temporal.policy}` };
  return { key };
}

/**
 * The stamp a zoned key is written beside: the provider's identity as one
 * text, `["<name>","<revision>"]`.
 * @param {{ name: string, revision: string }} identity
 * @returns {string}
 */
export function stampOf(identity) {
  return JSON.stringify([identity.name, identity.revision]);
}

/**
 * The SQL one declaration plans: its key columns (each a generated column
 * over the document, or a column the store writes), and its CHECK.
 * @param {any} temporal - the normalized declaration
 * @param {any} dialect
 * @param {string} docColumn
 * @returns {{ generated: any[], derived: any[], sql: string, shapeSql: string }}
 */
export function planTemporal(temporal, dialect, docColumn) {
  const spell = temporalSpelling(dialect);
  const doc = dialect.quoteIdentifier(docColumn);
  const q = dialect.quoteIdentifier;
  /** @param {string} [member] */
  const pathOf = (member) => dialect.jsonPathText(member === undefined ? temporal.segments : [...temporal.segments, { name: member }]);
  /** @param {string} member */
  const text = (member) => spell.textOf(doc, pathOf(member));
  const columns = temporalColumns(temporal);
  const textType = dialect.typeFor('string', 'generated');
  /** @param {string} name @param {string} expression */
  const keyColumn = (name, expression) => ({ name, type: textType, kind: 'text', pathText: null,
    expression: spell.keyText(expression), canonical: `${temporal.canonical}\u0000${name}`, temporal: temporal.name });
  /** @type {any[]} */
  const generated = [];
  /** @type {any[]} */
  const derived = [];
  /** @type {string[]} */
  const terms = [];
  /** The terms over the columns the store writes, apart: the shape alone is
   * what an existing table's rows are counted against. @type {string[]} */
  const keyTerms = [];
  /** @param {string} member @param {string} form */
  const textMember = (member, form) => {
    terms.push(`${spell.is(spell.typeOf(doc, pathOf(member)), spell.textType)}`, spell.matches(text(member), form));
  };
  switch (temporal.kind) {
    case 'date':
      generated.push(keyColumn(columns.key, text('date')));
      textMember('date', 'date');
      break;
    case 'date-range':
      generated.push(keyColumn(columns.key, text('start')), keyColumn(/** @type {string} */ (columns.end), text('end')));
      textMember('start', 'date');
      textMember('end', 'date');
      terms.push(`${spell.keyText(text('start'))} < ${spell.keyText(text('end'))}`);
      break;
    case 'floating':
      generated.push(keyColumn(columns.key, `${text('date')} || 'T' || ${canonicalTimeSql(text('time'))}`));
      textMember('date', 'date');
      textMember('time', 'time');
      break;
    case 'utc':
      generated.push(keyColumn(columns.key, canonicalInstantSql(text('instant'))));
      textMember('instant', 'instant');
      break;
    case 'zoned': {
      const key = q(columns.key);
      generated.push(
        { name: columns.key, type: spell.epochType, stored: true, pathText: null, canonical: `${temporal.canonical}\u0000${columns.key}`, temporal: temporal.name },
        { name: columns.stamp, type: spell.stampType, stored: true, pathText: null, canonical: `${temporal.canonical}\u0000${columns.stamp}`, temporal: temporal.name });
      derived.push(
        { name: columns.key, derive: 'zoned-instant', segments: temporal.segments, policy: temporal.policy, temporal: temporal.name },
        { name: columns.stamp, derive: 'zoned-stamp', segments: temporal.segments, policy: temporal.policy, temporal: temporal.name });
      textMember('date', 'date');
      textMember('time', 'time');
      // a key may be absent — a backfill with no zone provider, a writer
      // that writes the document alone — and the row is then read as one
      // another provider keyed: a candidate the engine decides
      terms.push(`${spell.is(spell.typeOf(doc, pathOf('zone')), spell.textType)}`, `${text('zone')} <> ''`);
      keyTerms.push(`(${key} IS NULL OR (${key} >= ${INSTANT_MIN} AND ${key} <= ${INSTANT_MAX}))`);
      break;
    }
    default:
      throw new TypeError(`temporal: no plan for the kind '${temporal.kind}'`);
  }
  const stored = generated.filter((column) => column.stored === true).map((column) => `${q(column.name)} IS NULL`);
  const absent = stored.length === 0 ? spell.booleanTrue : stored.join(' AND ');
  const typeOf = spell.typeOf(doc, pathOf());
  const present = [`${typeOf} = 'object'`, spell.is(text('kind'), `'${temporal.kind}'`),
    spell.rest(doc, pathOf(), MEMBERS[/** @type {keyof typeof MEMBERS} */ (temporal.kind)]), ...terms];
  const sql = `CASE WHEN ${typeOf} IS NULL THEN ${absent} ELSE ${[...present, ...keyTerms].join(' AND ')} END`;
  const shapeSql = `CASE WHEN ${typeOf} IS NULL THEN ${spell.booleanTrue} ELSE ${present.join(' AND ')} END`;
  return { generated, derived, sql, shapeSql };
}

/** A time the calendar admits (`HH:MM`, `HH:MM:SS`, `.f` to `.fff`) padded to
 * `HH:MM:SS.fff` by its length alone — the SQL twin of the query engine's `$wall`.
 * @param {string} time */
function canonicalTimeSql(time) {
  return `CASE WHEN length(${time}) = 5 THEN ${time} || ':00.000' WHEN length(${time}) = 8 THEN ${time} || '.000' `
    + `WHEN length(${time}) = 10 THEN ${time} || '00' WHEN length(${time}) = 11 THEN ${time} || '0' ELSE ${time} END`;
}

/** An instant the calendar admits padded to `YYYY-MM-DDTHH:MM:SS.fffZ` by its
 * length alone. @param {string} instant */
function canonicalInstantSql(instant) {
  return `CASE WHEN length(${instant}) = 20 THEN substr(${instant}, 1, 19) || '.000Z' `
    + `WHEN length(${instant}) = 22 THEN substr(${instant}, 1, 21) || '00Z' `
    + `WHEN length(${instant}) = 23 THEN substr(${instant}, 1, 22) || '0Z' ELSE ${instant} END`;
}

/** {@link canonicalTimeSql} over one time text. @param {string} time */
const canonicalTime = (time) => (time.length === 5 ? `${time}:00.000` : time.length === 8 ? `${time}.000`
  : time.length === 10 ? `${time}00` : time.length === 11 ? `${time}0` : time);

/** {@link canonicalInstantSql} over one instant text. @param {string} instant */
const canonicalInstant = (instant) => (instant.length === 20 ? `${instant.slice(0, 19)}.000Z`
  : instant.length === 22 ? `${instant.slice(0, 21)}00Z` : instant.length === 23 ? `${instant.slice(0, 22)}0Z` : instant);

/**
 * The text each generated key column of a declared member holds for one
 * value, in {@link temporalColumns}' order (`[key]`, or `[key, end]` for a
 * date range): what the columns' expressions compute from the document, so
 * two spellings of one value answer one key. `null` for a zoned member (a
 * zone provider resolves its key; no expression spells it) and for a value
 * that is absent or not the kind's shape (its CHECK refuses one stored).
 * @param {{ kind: string }} temporal - the declaration, or its mapping entry
 * @param {unknown} member - the member's value in the document
 * @returns {string[] | null}
 */
function temporalKeyValues(temporal, member) {
  if (!isJsonObject(member) || member.kind !== temporal.kind) return null;
  /** @param {string[]} names */
  const texts = (...names) => (names.every((name) => typeof member[name] === 'string') ? names.map((name) => /** @type {string} */ (member[name])) : null);
  switch (temporal.kind) {
    case 'date': return texts('date');
    case 'date-range': return texts('start', 'end');
    case 'floating': {
      const parts = texts('date', 'time');
      return parts === null ? null : [`${parts[0]}T${canonicalTime(parts[1])}`];
    }
    case 'utc': {
      const parts = texts('instant');
      return parts === null ? null : [canonicalInstant(parts[0])];
    }
    default: return null;
  }
}

/**
 * The one spelling of a utc instant, `YYYY-MM-DDTHH:MM:SS.fffZ`, from epoch
 * milliseconds — what a `utc` key holds for that instant — or `null` for an
 * instant no calendar value spells.
 * @param {number} epoch
 * @returns {string | null}
 */
export function instantKey(epoch) {
  if (!Number.isSafeInteger(epoch) || epoch < INSTANT_MIN || epoch > INSTANT_MAX) return null;
  return new Date(epoch).toISOString();
}

/**
 * Whether a text is a day the calendar has, `YYYY-MM-DD` (`2026-02-30` is
 * not one).
 * @param {string} text
 * @returns {boolean}
 */
export function isCalendarDate(text) {
  try {
    parseTemporal({ kind: 'date', date: text });
    return true;
  }
  catch {
    return false;
  }
}

/**
 * Why a member would not be stored under its declaration, or `null`: absent
 * is fine; present, it is a value of the declared kind as its constructor
 * admits it — and a zoned one resolves under the declared policy in the
 * store's zone provider.
 * @param {any} temporal
 * @param {unknown} member - the member as the database will hold it
 * @param {any} provider - the store's zone provider, or `null`
 * @param {boolean} [resolve] - whether a zoned value must resolve in
 *   `provider` (`false`: a writer with none writes its key absent)
 * @returns {string | null}
 */
export function temporalFault(temporal, member, provider, resolve = true) {
  if (member === undefined) return null;
  let value;
  try {
    value = parseTemporal(/** @type {any} */ (member));
  }
  catch (e) {
    return `is not a calendar value (${/** @type {any} */ (e).code ?? 'refused'}: ${/** @type {any} */ (e).message})`;
  }
  if (value.kind !== temporal.kind) return `is a ${value.kind} value, and the member is declared ${temporal.kind}`;
  if (value.kind === 'zoned' && resolve) {
    try {
      toUtc(value, { provider, policy: temporal.policy });
    }
    catch (e) {
      return `resolves to no instant under '${temporal.policy}' (${/** @type {any} */ (e).code ?? 'refused'}: ${/** @type {any} */ (e).message})`;
    }
  }
  return null;
}

/**
 * The value of a column the store writes for a zoned member: its instant, or
 * the stamp of the provider that resolved it. `null` for an absent member.
 * @param {{ derive: string, policy?: string }} column
 * @param {unknown} member - the member as stored
 * @param {any} provider
 * @returns {number | string | null}
 */
export function zonedValueFor(column, member, provider) {
  if (member === undefined || member === null) return null;
  const resolved = toUtc(parseTemporal(/** @type {any} */ (member)), { provider, policy: /** @type {any} */ (column.policy) });
  return column.derive === 'zoned-instant' ? /** @type {any} */ (resolved).instant : stampOf(/** @type {any} */ (resolved).provider);
}

/**
 * The columns the store writes for the zoned members among `temporals`:
 * each one's key, then its stamp.
 * @param {{ name: string, kind: string, policy?: string }[]} temporals
 * @returns {string[]}
 */
function zonedColumnsOf(temporals) {
  return temporals.filter((temporal) => temporal.kind === 'zoned').flatMap((temporal) => {
    const columns = temporalColumns(temporal);
    return [columns.key, /** @type {string} */ (columns.stamp)];
  });
}

/**
 * An entity's declared calendar members as its query shape reads them: each
 * with its key columns, and a date's and a date range's members entered in
 * `flavors` as the text columns they ARE, so a path to one reads its key as
 * a collection's does.
 * @param {any[]} declared - the entity mapping's `temporals`
 * @param {Map<string, any>} flavors - the shape's column flavors, by canonical path
 * @returns {any[]}
 */
function entityShapeTemporals(declared, flavors) {
  return declared.map((temporal) => {
    const keyed = { ...temporal, ...temporalColumns(temporal) };
    const members = keyed.kind === 'date' ? [['date', keyed.key]]
      : keyed.kind === 'date-range' ? [['start', keyed.key], ['end', keyed.end]] : [];
    for (const [member, column] of members)
      flavors.set(canonicalOf([...keyed.segments, { name: member }]), { column, flavor: 'entity-column', storage: 'string' });
    return keyed;
  });
}

/**
 * An entity's normalized calendar members as mapping data: what the table
 * plans each by, with its property's `index`/`unique` flag, which is over
 * its key columns.
 * @param {any[]} temporals - the normalized entity's
 * @param {Map<string, any>} properties - the normalized entity's
 * @returns {any[]}
 */
function entityMapping(temporals, properties) {
  return temporals.map((temporal) => {
    const property = properties.get(temporal.name);
    return { name: temporal.name, path: temporal.path, kind: temporal.kind,
      ...(temporal.policy === undefined ? {} : { policy: temporal.policy }), constraint: temporal.constraint,
      segments: temporal.segments, canonical: temporal.canonical, docPath: temporal.docPath,
      ...(property.unique ? { unique: true } : property.index ? { index: true } : {}) };
  });
}

/**
 * What an entity's writes carry for its declared calendar members: the
 * table keys each one by columns generated from the document, except a
 * zoned one, whose key and stamp the store writes beside every document it
 * writes (`zonedValues`: each column's value for a document as the database
 * holds it, or only one member's), and the text each key column of a member
 * holds for a value of it (`keyValues`, `null` for no declared member).
 * @param {any[]} declared - the entity mapping's `temporals`
 * @param {any} zoneProvider - the store's, or `null`
 * @returns {{ zonedValues: (doc: any, property?: string) => { name: string, value: unknown }[],
 *   keyValues: (property: string, value: unknown) => any }}
 */
function entityWrites(declared, zoneProvider) {
  const zoned = declared.filter((temporal) => temporal.kind === 'zoned').flatMap((temporal) => {
    const columns = temporalColumns(temporal);
    return [{ name: columns.key, derive: 'zoned-instant', policy: temporal.policy, property: temporal.name },
      { name: /** @type {string} */ (columns.stamp), derive: 'zoned-stamp', policy: temporal.policy, property: temporal.name }];
  });
  return {
    zonedValues: (doc, property) => zoned.filter((column) => property === undefined || column.property === property)
      .map((column) => ({ name: column.name, value: zoneProvider === null ? null
        : zonedValueFor(column, Object.hasOwn(doc, column.property) ? doc[column.property] : undefined, zoneProvider) })),
    keyValues: (property, value) => {
      const temporal = declared.find((member) => member.name === property);
      return temporal === undefined ? null : temporalKeyValues(temporal, value);
    },
  };
}

/**
 * The refusal of a calendar member on an adopted layout (`physical`), which
 * has no document column its key columns could be generated from: `JD0004`.
 * @param {any} temporal - the entity's first declared member
 * @returns {never}
 */
function refuseAdopted(temporal) {
  throw new DbCompileError('JD0004', `'${temporal.name}' declares a calendar kind, keyed by columns generated from the entity's `
    + 'document, and an adopted layout (physical) has no document column: keep the value in the columns the '
    + 'application declares, or declare the entity without physical', temporal.docPath);
}

/** Whether a stored derived column is a zoned key. @param {{ derive?: string }} column */
export const isZonedColumn = (column) => column.derive === 'zoned-instant' || column.derive === 'zoned-stamp';

// ————— The model —————

/** A declared temporal member's closed set (`temporals[]`, MODEL-FORMAT §2). */
const TEMPORAL_MEMBERS = ['name', 'path', 'kind', 'policy'];

/** @param {string} code @param {string} reason @param {string} docPath */
const modelError = (code, reason, docPath) => new DbCompileError(code, reason, docPath);

/**
 * A zoned member's key is the instant its wall clock resolves to in the
 * store's zone provider, stamped with that provider's identity so a key a
 * later revision moves is known: a store that declares one opens only with a
 * provider whose identity is recorded (`{ name, revision }`, neither
 * `unrecorded`) — two unrecorded stamps would prove nothing (`JD0004`).
 * @param {any} collection - a normalized collection
 * @param {any} provider
 */
function refuseUnrecordedZones(collection, provider) {
  const zoned = collection.temporals.find((/** @type {any} */ temporal) => temporal.kind === 'zoned');
  if (zoned === undefined) return;
  const identity = provider?.identity;
  const recorded = identity !== null && typeof identity === 'object'
    && typeof identity.name === 'string' && identity.name !== '' && identity.name !== 'unrecorded'
    && typeof identity.revision === 'string' && identity.revision !== '' && identity.revision !== 'unrecorded';
  if (provider === null || provider === undefined || !recorded) {
    throw modelError('JD0004',
      `the zoned member '${zoned.name}' is keyed by the instant it resolves to, stamped with the zone provider's identity: `
      + 'open the store with a zoneProvider whose identity records its name and revision (createIntlZoneProvider({ revision }))',
      zoned.docPath);
  }
}

/**
 * The declared temporal members (`temporals[]`): each a closed `{ name,
 * path, kind, policy? }` naming a member by a path of member names alone, a
 * kind of `@jarenjs/core/calendar` and — for a zoned member, and only there —
 * the policy its gap or fold resolves under. The name is an identifier,
 * unique among the collection's temporal members, naming a
 * `<name>_temporal` constraint of at most 63 bytes, and a member is declared
 * once, and is no declared interval's span.
 * @param {any} spec - the collection declaration
 * @param {string} docPath
 * @param {any[]} intervals - the collection's normalized intervals
 * @returns {any[]} each with its segments and canonical
 */
function normalizeTemporals(spec, docPath, intervals) {
  const declared = spec.temporals ?? [];
  if (!Array.isArray(declared))
    throw modelError('JD0005', 'temporals must be an array', `${docPath}/temporals`);
  const names = new Set();
  /** @type {Set<string>} */
  const members = new Set();
  const temporals = [];
  for (let i = 0; i < declared.length; i++) {
    const temporal = declared[i];
    const at = `${docPath}/temporals/${i}`;
    if (!isJsonObject(temporal))
      throw modelError('JD0005', 'a temporal member declaration must be an object', at);
    refuseUnknownModelMembers(temporal, TEMPORAL_MEMBERS, at, 'temporal member');
    if (typeof temporal.name !== 'string' || !IDENTIFIER.test(temporal.name))
      throw modelError('JD0005', 'a temporal member needs an identifier name', `${at}/name`);
    if (names.has(temporal.name))
      throw modelError('JD0005', `duplicate temporal member name '${temporal.name}'`, `${at}/name`);
    names.add(temporal.name);
    const pointers = { name: `${at}/name`, kind: `${at}/kind`, policy: `${at}/policy`, path: `${at}/path`, docPath: at };
    refuseKind(temporal, pointers);
    if (typeof temporal.path !== 'string' || temporal.path === '') {
      throw modelError('JD0005',
        'a temporal member path is a singular JSONPath string selecting the member', `${at}/path`);
    }
    let compiled;
    try {
      compiled = compileIndexPath(temporal.path, `${at}/path`);
    }
    catch (cause) {
      throw new DbCompileError('JD0005',
        `the temporal member path '${temporal.path}' must be a singular JSONPath selecting the member`,
        `${at}/path`, /** @type {Error} */ (cause));
    }
    if (compiled.segments.some((/** @type {any} */ segment) => !('name' in segment))) {
      throw modelError('JD0005',
        `the temporal member path '${temporal.path}' names members alone: an array index selects no one member of every document`, `${at}/path`);
    }
    if (members.has(compiled.canonical))
      throw modelError('JD0005', `the member '${temporal.path}' is declared twice`, `${at}/path`);
    members.add(compiled.canonical);
    if (intervals.some((interval) => interval.canonical === compiled.canonical))
      throw modelError('JD0005', `the member '${temporal.path}' is a declared interval's span`, `${at}/path`);
    temporals.push(temporalDeclaration(temporal, compiled, schemaNodeAt(spec.schema, compiled.segments), pointers));
  }
  return temporals;
}

/**
 * One declared temporal member, normalized — a collection's `temporals[]`
 * entry and an entity property's `x-entity.temporal` alike: its constraint
 * `<name>_temporal` of at most 63 bytes, a kind of `@jarenjs/core/calendar`,
 * a policy for a zoned member and only there, and a member the schema
 * types as an object where it types it at all. Each refusal names the
 * pointer the declaration spells it at.
 * @param {{ name: string, kind?: unknown, policy?: unknown, path: string }} temporal
 * @param {{ segments: any[], canonical: string }} compiled - the member's path
 * @param {any} node - the schema node at the member, or `undefined`
 * @param {{ name: string, kind: string, policy: string, path: string, docPath: string }} at - the pointers
 * @returns {any}
 */
function temporalDeclaration(temporal, compiled, node, at) {
  const type = node?.type;
  if (type !== undefined && type !== 'object' && !(Array.isArray(type) && type.includes('object'))) {
    throw modelError('JD0005',
      `the schema types '${temporal.path}' ${JSON.stringify(type)}: a calendar value is an object`, at.path);
  }
  return {
    name: temporal.name,
    constraint: `${temporal.name}_temporal`,
    path: temporal.path,
    kind: temporal.kind,
    ...(temporal.kind === 'zoned' ? { policy: temporal.policy } : {}),
    segments: compiled.segments,
    canonical: compiled.canonical,
    docPath: at.docPath,
  };
}

/**
 * Refuse a declaration's constraint name, kind or policy: a constraint
 * `<name>_temporal` of at most 63 bytes, a kind of `@jarenjs/core/calendar`,
 * a policy for a zoned member and only there.
 * @param {{ name: string, kind?: unknown, policy?: unknown }} temporal
 * @param {{ name: string, kind: string, policy: string }} at - the pointers
 */
function refuseKind(temporal, at) {
  const constraint = `${temporal.name}_temporal`;
  if (utf8ByteLength(constraint) > CONSTRAINT_NAME_BYTES) {
    throw modelError('JD0005',
      `the constraint name '${constraint}' exceeds ${CONSTRAINT_NAME_BYTES} bytes`, at.name);
  }
  if (!TEMPORAL_KINDS.includes(/** @type {any} */ (temporal.kind))) {
    throw modelError('JD0005',
      `a temporal member's kind is one of ${TEMPORAL_KINDS.join(', ')}, got ${JSON.stringify(temporal.kind)}`, at.kind);
  }
  if (temporal.kind === 'zoned' && !TEMPORAL_POLICIES.includes(/** @type {any} */ (temporal.policy))) {
    throw modelError('JD0005',
      `a zoned member declares the policy its gap or fold resolves under, one of ${TEMPORAL_POLICIES.join(', ')}, `
      + `got ${temporal.policy === undefined ? 'none' : JSON.stringify(temporal.policy)}`, at.policy);
  }
  if (temporal.kind !== 'zoned' && temporal.policy !== undefined) {
    throw modelError('JD0005',
      `a policy resolves a zoned member's wall clock; a ${temporal.kind} member has none to resolve`, at.policy);
  }
}

/** The closed members of an entity property's `x-entity.temporal`. */
const ENTITY_TEMPORAL_MEMBERS = ['kind', 'policy'];

/**
 * An entity property declared a calendar kind (`x-entity: { temporal: {
 * kind, policy? } }`, MODEL-FORMAT §9.3): normalized as a collection's
 * `temporals[]` entry naming the property itself — a top-level member of
 * the entity's document, keyed by the columns the same declaration plans.
 * The member stays in the document, keyed by columns of its own: its block
 * takes no `key`, `column`, `relation` or `version` beside it.
 * @param {string} name - the property @param {any} entityBlock - its `x-entity`
 * @param {any} node - the property's (effective) schema
 * @param {string} propertyPath - the property's pointer
 * @returns {any}
 */
function normalizeEntityTemporal(name, entityBlock, node, propertyPath) {
  for (const member of ['key', 'column', 'relation', 'version']) {
    if (entityBlock[member] !== undefined && entityBlock[member] !== false) {
      throw modelError('JD0005', `x-entity.temporal keeps the property in the entity's document, keyed by columns of its own: `
        + `it takes no ${member} beside it`, `${propertyPath}/x-entity/${member}`);
    }
  }
  const block = entityBlock.temporal;
  const at = `${propertyPath}/x-entity/temporal`;
  if (!isJsonObject(block))
    throw modelError('JD0005', "x-entity.temporal is an object: { kind, policy? }", at);
  refuseUnknownModelMembers(block, ENTITY_TEMPORAL_MEMBERS, at, 'temporal member');
  if (!IDENTIFIER.test(name))
    throw modelError('JD0005', `a temporal member names its key columns after the property, and '${name}' is no identifier`, propertyPath);
  const segments = [{ name }];
  const temporal = { name, kind: block.kind, policy: block.policy, path: modelPath(segments) };
  const pointers = { name: propertyPath, kind: `${at}/kind`, policy: `${at}/policy`, path: propertyPath, docPath: at };
  refuseKind(temporal, pointers);
  return temporalDeclaration(temporal,
    { segments, canonical: canonicalOf(segments) }, node, pointers);
}

// ————— The table —————

/**
 * A collection's declared temporal members planned into its table: each
 * one's key columns (refused past the engine's name length, and added to the
 * table's taken names and generated columns), the columns the store writes
 * for a zoned one, the member paths a date's and a date range's keys stand
 * for, and the CHECK each one plans.
 * @param {any} collection - the normalized collection
 * @param {any} dialect
 * @param {{ docColumn: string, taken: Set<string>, generated: any[], derived: any[],
 *   columnByCanonical: Map<string, string>, safeIntegerColumns: Set<string>,
 *   refuseLongName: (dialect: any, name: string, what: string, docPath: string) => void }} table
 * @returns {{ temporals: any[], indexColumns: (canonical: string, index: any) => string[] | null }}
 */
function planCollectionTemporals(collection, dialect, table) {
  const { docColumn, taken, generated, derived, columnByCanonical, safeIntegerColumns, refuseLongName } = table;
  const temporals = collection.temporals.map((/** @type {any} */ temporal) => {
    const planned = planTemporal(temporal, dialect, docColumn);
    for (const column of planned.generated) {
      refuseLongName(dialect, column.name, `the key column of the temporal member '${temporal.name}'`, `${temporal.docPath}/name`);
      taken.add(column.name);
      generated.push(column);
    }
    derived.push(...planned.derived);
    const columns = temporalColumns(temporal);
    if (temporal.kind === 'date') columnByCanonical.set(canonicalOf([...temporal.segments, { name: 'date' }]), columns.key);
    if (temporal.kind === 'date-range') {
      columnByCanonical.set(canonicalOf([...temporal.segments, { name: 'start' }]), columns.key);
      columnByCanonical.set(canonicalOf([...temporal.segments, { name: 'end' }]), /** @type {string} */ (columns.end));
    }
    if (temporal.kind === 'zoned') safeIntegerColumns.add(columns.key);
    return { name: temporal.name, constraint: temporal.constraint, kind: temporal.kind,
      ...(temporal.policy === undefined ? {} : { policy: temporal.policy }),
      segments: temporal.segments, canonical: temporal.canonical, path: temporal.path, ...columns,
      sql: planned.sql, shapeSql: planned.shapeSql, docPath: temporal.docPath };
  });
  /**
   * The key columns an index over a declared temporal member covers, or
   * `null` for an index over none of them. A unique zoned key would compare
   * a row's key with keys another provider revision resolved, which can
   * refuse a value that is no duplicate or admit one that is: `JD0004`.
   * @param {string} canonical @param {any} index
   */
  const indexColumns = (canonical, index) => {
    const temporal = temporals.find((/** @type {any} */ declared) => declared.canonical === canonical);
    if (temporal === undefined) return null;
    if (temporal.kind === 'zoned' && index.unique) {
      throw new DbCompileError('JD0004',
        `index '${index.name}': a zoned member's key is the instant a zone provider resolves, and a unique index would `
        + 'compare it with keys another provider revision resolved: a zoned member takes no unique index', `${index.docPath}/unique`);
    }
    if (temporal.kind === 'date-range') return [temporal.key, temporal.end];
    if (temporal.kind === 'zoned') return [temporal.stamp, temporal.key];
    return [temporal.key];
  };
  return { temporals, indexColumns };
}

/**
 * An entity's declared calendar members (`x-entity.temporal`) planned as a
 * collection's are, the one implementation both document kinds share: each
 * one's key columns, generated over the document (a zoned one's key and
 * stamp written by the store), and its CHECK. A key column named as another
 * column of the table is `JD0004`; `flag` takes each member's `index` or
 * `unique` flag into the table's flag indexes, and `indexColumns` names the
 * key columns such an index covers.
 * @param {any[]} declared - the entity mapping's `temporals`
 * @param {any} dialect
 * @param {{ name: string, entityPath: string, docColumn: string, taken: Map<string, { name: string, what: string }>,
 *   compare: (name: string) => string,
 *   refuseLongName: (dialect: any, name: string, what: string, docPath: string) => void }} table
 * @returns {{ temporals: any[], generated: any[], flag: (indexUnique: Map<string, boolean>) => void,
 *   indexColumns: (column: string, index: { name: string, unique: boolean }) => string[] | null }}
 */
function planEntityTemporals(declared, dialect, table) {
  const { name, entityPath, docColumn, taken, compare, refuseLongName } = table;
  /** @type {any[]} */
  const generated = [];
  const plan = planCollectionTemporals({ temporals: declared }, dialect,
    { docColumn, taken: new Set(), generated, derived: [], columnByCanonical: new Map(), safeIntegerColumns: new Set(), refuseLongName });
  for (const column of generated) {
    const holder = taken.get(compare(column.name));
    if (holder !== undefined) {
      throw new DbCompileError('JD0004', `the key column of the temporal member '${column.temporal}' would be named '${column.name}', `
        + `the name of ${holder.what} — two columns of one table cannot share a name: rename the member`, `${entityPath}/schema/properties/${column.temporal}`);
    }
    taken.set(compare(column.name), { name: column.name, what: `the key column of the temporal member '${column.temporal}'` });
  }
  return {
    temporals: plan.temporals,
    generated,
    // a member's `index`/`unique` flag: over its key columns, in the order a
    // collection's index over the member keys them (a zoned key takes no
    // unique index: `JD0004`), named as a column's flag index is
    flag: (indexUnique) => {
      for (const temporal of declared) {
        if (temporal.unique !== true && temporal.index !== true) continue;
        refuseLongName(dialect, `${name}_${temporal.name}`, `the index over '${temporal.name}'`, `${entityPath}/schema/properties/${temporal.name}`);
        indexUnique.set(temporal.name, temporal.unique === true);
      }
    },
    indexColumns: (column, index) => {
      const temporal = declared.find((/** @type {any} */ member) => member.name === column);
      return temporal === undefined ? null : plan.indexColumns(temporal.canonical,
        { ...index, docPath: `${entityPath}/schema/properties/${column}/x-entity` });
    },
  };
}

/**
 * A declared temporal member's CHECK as the database holds it, read back
 * as the planned one: absent, not validated or another text is a
 * disagreement.
 * @param {any} temporal - the planned member
 * @param {any} row - the stored CHECK, or `undefined`
 * @param {any} dialect
 * @param {(row: any) => boolean} readsConforming
 * @param {(reason: string) => void} disagree
 */
function verifyCheck(temporal, row, dialect, readsConforming, disagree) {
  if (row === undefined) {
    disagree(`the model declares the ${temporal.kind} member '${temporal.name}' with CHECK '${temporal.constraint}', `
      + 'which the database does not have');
  }
  if (Number(row.validated) !== 1)
    disagree(`CHECK '${temporal.constraint}' is not validated: the rows it holds were never checked against it`);
  const differs = dialect.readBack.check(String(row.expression ?? ''), temporal.sql, readsConforming(row));
  if (differs !== null) disagree(`CHECK '${temporal.constraint}' ${differs}`);
}

/**
 * The temporal member a CHECK declares, or `null`: one named
 * `<name>_temporal` whose text is, exactly, the CHECK a declaration of one
 * kind (and, for a zoned member, of the policy its stamp column is named
 * after) over the member its first test reads plans — with every key column
 * that declaration plans on the table.
 * @param {any} dialect
 * @param {{ name: string, sql?: string, validated?: boolean, conforming?: boolean }} check
 * @param {Map<string, any>} byName - the table's columns
 * @param {string} docColumn
 * @returns {{ declaration: any, columns: string[], indexColumns: string[] } | null}
 */
function temporalOf(dialect, check, byName, docColumn) {
  const stem = /^(.*)_temporal$/.exec(check.name)?.[1];
  if (stem === undefined || !IDENTIFIER.test(stem) || check.sql === undefined || check.validated === false) return null;
  const segments = temporalSpelling(dialect).checkPath(check.sql);
  if (segments === null) return null;
  const candidates = TEMPORAL_KINDS.flatMap((kind) => (kind === 'zoned' ? TEMPORAL_POLICIES.map((policy) => ({ kind, policy })) : [{ kind }]));
  for (const { kind, policy } of candidates) {
    const temporal = { name: stem, kind, ...(policy === undefined ? {} : { policy }), segments, canonical: canonicalOf(segments) };
    const columns = temporalColumns(temporal);
    const names = [columns.key, columns.end, columns.stamp].filter((name) => name !== undefined);
    if (!names.every((name) => byName.has(name))) continue;
    const planned = planTemporal(temporal, dialect, docColumn).sql;
    const same = dialect.readBack === undefined
      ? String(check.sql).replace(/\s+/g, ' ').trim() === planned
      : dialect.readBack.check(String(check.sql), planned, check.conforming !== false) === null;
    if (!same) continue;
    const declaration = { name: stem, path: modelPath(segments), kind, ...(policy === undefined ? {} : { policy }) };
    const indexColumns = kind === 'date-range' ? [columns.key, /** @type {string} */ (columns.end)]
      : kind === 'zoned' ? [/** @type {string} */ (columns.stamp), columns.key] : [columns.key];
    return { declaration, columns: /** @type {string[]} */ (names), indexColumns };
  }
  return null;
}

/** Whether a plain column is named as a zoned member's key or stamp beside the
 * CHECK its declaration names (`tk_<name>`, `tk_<name>$<policy>`, `<name>_temporal`).
 * @param {string} name @param {any} table */
function zonedKeyColumn(name, table) {
  const stem = /^tk_([A-Za-z_][A-Za-z0-9_]*?)(?:\$(?:rfc5545|later|reject))?$/.exec(name)?.[1];
  return stem !== undefined && (table.checks ?? []).some((/** @type {any} */ check) => check.name === `${stem}_temporal`);
}

/**
 * The paths an index over at least one declared temporal member covers —
 * each member's key columns, in order, standing for its path, every other
 * column for its own member — or `null` for an index over none, or over
 * columns no path stands for.
 * @param {string[]} columns
 * @param {{ path: string, columns: string[] }[]} temporals
 * @param {Map<string, { path: string }>} paths
 * @returns {string[] | null}
 */
function temporalPathsOf(columns, temporals, paths) {
  const out = [];
  let any = false;
  for (let at = 0; at < columns.length;) {
    const temporal = temporals.find((entry) => entry.columns.every((column, i) => columns[at + i] === column));
    if (temporal !== undefined) {
      out.push(temporal.path);
      at += temporal.columns.length;
      any = true;
      continue;
    }
    const entry = paths.get(columns[at]);
    if (entry === undefined) return null;
    out.push(entry.path);
    at++;
  }
  return any ? out : null;
}

/**
 * A collection table's declared temporal members, read back: each CHECK
 * that declares one ({@link temporalOf}), the key columns they plan, and the
 * paths an index over their keys covers.
 * @param {any} dialect
 * @param {any} table - the table as introspection read it
 * @param {Map<string, any>} byName - the table's columns
 * @param {string} docColumn
 * @returns {{ declarations: any[], checks: Set<string>, keys: Set<string>,
 *   indexPaths: (columns: string[], paths: Map<string, { path: string }>) => string[] | null,
 *   indexColumns: (path: string) => string[] | null }}
 */
function readTable(dialect, table, byName, docColumn) {
  const declarations = [];
  /** @type {Set<string>} */
  const checks = new Set();
  /** @type {Set<string>} */
  const keys = new Set();
  /** @type {{ path: string, columns: string[] }[]} the members, by the columns an index over each covers */
  const indexed = [];
  for (const check of table.checks) {
    const temporal = temporalOf(dialect, check, byName, docColumn);
    if (temporal === null) continue;
    declarations.push(temporal.declaration);
    checks.add(check.name);
    for (const column of temporal.columns) keys.add(column);
    indexed.push({ path: temporal.declaration.path, columns: temporal.indexColumns });
  }
  return { declarations, checks, keys, indexPaths: (columns, paths) => temporalPathsOf(columns, indexed, paths),
    /** The columns an index over a declared member's path covers, by its path. */
    indexColumns: (/** @type {string} */ path) => indexed.find((entry) => entry.path === path)?.columns ?? null };
}

/**
 * An entity table's declared calendar members (`x-entity.temporal`), read
 * back as a collection's are ({@link readTable}): each over a top-level
 * member named as its CHECK is, with the key columns it plans, which are the
 * member's and no property of their own. `claims` takes a one-member index
 * named as the member's flag index, over the key columns that flag plans, as
 * that flag; `members` answers each member's property, with the flags
 * claimed; `null` for a table that declares none.
 * @param {any} dialect @param {any} table @param {string} docColumn
 * @returns {null | { keys: Set<string>, checks: Set<string>, claims: (index: any) => boolean,
 *   members: () => [string, any][] }}
 */
function readEntityTemporals(dialect, table, docColumn) {
  const read = readTable(dialect, table, new Map(table.columns.map((/** @type {any} */ column) => [column.name, column])), docColumn);
  const temporals = read.declarations.filter((declaration) => declaration.path === modelPath([{ name: declaration.name }]));
  if (temporals.length === 0) return null;
  /** @type {Set<string>} */
  const keys = new Set();
  for (const declaration of temporals)
    for (const column of Object.values(temporalColumns(declaration))) keys.add(/** @type {string} */ (column));
  /** @type {Map<string, { unique: boolean }>} the members a flag's index covers */
  const flags = new Map();
  return {
    keys,
    checks: new Set(temporals.map((declaration) => `${declaration.name}_temporal`)),
    claims: (index) => {
      const member = temporals.find((declaration) => index.name === `${table.name}_${declaration.name}`);
      const covers = member === undefined ? null : read.indexColumns(member.path);
      if (member === undefined || index.partial || covers === null || covers.length !== index.columns.length
        || !covers.every((column, at) => index.columns[at] === column) || (index.unique && member.kind === 'zoned')) return false;
      flags.set(member.name, { unique: index.unique });
      return true;
    },
    members: () => temporals.map((declaration) => {
      const flag = flags.get(declaration.name);
      return [declaration.name, { type: 'object', 'x-entity': {
        temporal: { kind: declaration.kind, ...(declaration.policy === undefined ? {} : { policy: declaration.policy }) },
        ...(flag === undefined ? {} : flag.unique ? { unique: true } : { index: true }) } }];
    }),
  };
}

// ————— The writes —————

/**
 * Refuse a document whose declared temporal member would not be stored
 * under its declaration (`JD2003`, before the statement, hook or no hook,
 * as the CHECK refuses every other writer).
 * @param {{ name: string, docPath: string, temporals: any[] }} collection - the collection, or the entity
 * @param {(segments: any[]) => unknown} readMember - the member as the database will hold it
 * @param {any} provider - the store's zone provider
 * @param {'collection' | 'entity'} [what] - which `collection` is
 */
function refuseFaults(collection, readMember, provider, what = 'collection') {
  for (const temporal of collection.temporals) {
    // an entity core with no provider (a migration's) writes a zoned key absent
    const fault = temporalFault(temporal, readMember(temporal.segments), provider, what === 'collection' || provider !== null);
    if (fault !== null) {
      throw new DbRuntimeError('JD2003',
        `${what} '${collection.name}' rejected the document: the ${temporal.kind} member '${temporal.name}' at ${temporal.path} ${fault}`,
        { docPath: collection.docPath, collection: collection.name });
    }
  }
}

/**
 * Write the current zone provider's key and stamp on every row whose
 * zoned member another provider keyed, or none did: one read of their
 * keys, then each row's read-modify-write under its own lock, so a
 * concurrent write is never keyed from the document it replaced. Answers
 * how many rows it keyed.
 * @param {{ connection: any, collection: any, plan: any, dialect: any, storedDerived: any[], zoneProvider: any,
 *   atomically: Function, runWrite: Function, whereKey: Function, readMember: (doc: any, segments: any[]) => unknown }} store
 * @returns {any} value-or-promise of a count
 */
function rekey(store) {
  const { connection, collection, plan, dialect, storedDerived, zoneProvider, atomically, runWrite, whereKey, readMember } = store;
  const zoned = storedDerived.filter(isZonedColumn);
  const temporals = (plan.temporals ?? []).filter((/** @type {any} */ temporal) => temporal.kind === 'zoned');
  if (temporals.length === 0) return 0;
  const q = dialect.quoteIdentifier;
  const current = stampOf(zoneProvider.identity);
  const docSql = q(plan.docColumn);
  const stale = temporals.map((/** @type {any} */ temporal, /** @type {number} */ i) =>
    `(${dialect.jsonTypeName(docSql, dialect.jsonPathText(temporal.segments))} IS NOT NULL `
    + `AND NOT (${q(temporal.stamp)} IS NOT NULL AND ${q(temporal.stamp)} = ${dialect.parameterRef(i + 1, `stamp${i}`)}))`);
  const selectSql = `SELECT ${q(plan.keyColumn)} AS ${q('key')} FROM ${q(plan.table)} WHERE ${stale.join(' OR ')} `
    + `ORDER BY ${dialect.rowIdentity()}`;
  const updateSql = `UPDATE ${q(plan.table)} SET `
    + `${zoned.map((column, i) => `${q(column.name)} = ${dialect.parameterRef(i + 1, column.name)}`).join(', ')} `
    + `WHERE ${q(plan.keyColumn)} = ${dialect.parameterRef(zoned.length + 1, 'key')}`;
  return chain(attempt(() => useStatementOnce(connection, selectSql, (statement) => statement.all(temporals.map(() => current))),
    (error) => wrapDriverError(error, { docPath: collection.docPath, collection: collection.name })), (/** @type {any[]} */ rows) => {
    let keyed = 0;
    /** @param {number} at @returns {any} */
    const next = (at) => {
      const key = rows[at].key;
      return chain(atomically(key, (/** @type {any} */ doc) => (doc === undefined ? null
        : runWrite('rekeyTemporal', updateSql, [...zoned.map((column) =>
          zonedValueFor(column, readMember(doc, column.segments), zoneProvider)), whereKey(key)], key, false))),
      (result) => {
        if (result !== null) keyed++;
      });
    };
    return chain(inOrder(rows.length, next), () => keyed);
  });
}

// ————— The queries —————

// ————— Declared temporal members —————
//
// A declared calendar value (`temporals`, MODEL-FORMAT §2) compares by its
// key: a utc value by `$instant` (or `$epoch` of its instant), a floating
// value by `$wall`, a zoned value by `$instant` under its declared policy, a
// date and a date range by their members. Each key but a zoned one is a
// column generated from the member's text in the value's one spelling, so a
// comparison of the key with a literal is the comparison of that column —
// exact, no residual, the key's index sought. A zoned key is the instant a
// zone provider resolved, stamped with its identity: it only NARROWS, keeping
// every row another provider stamped, and the engine decides.

/** Why a temporal key was not translated. */
const TEMPORAL_REASONS = {
  zonedOrder: 'a zoned key is the instant a zone provider resolved; the engine orders by it',
  zoned: 'a zoned key narrows the rows: the engine resolves each candidate in the current zone provider and decides',
  zoneStamp: 'a zoned key is read only beside the stamp of the zone provider the store opened with, and it has none',
  operand: 'a temporal key is compared with one literal',
};

/**
 * The type a declared date's or date range's member reads as: its key column
 * holds it as text. `undefined` for any other path.
 * @param {any} shape @param {string} canonical
 * @returns {string | undefined}
 */
function temporalMemberType(shape, canonical) {
  for (const temporal of shape.temporals ?? []) {
    if (temporal.kind !== 'date' && temporal.kind !== 'date-range') continue;
    const members = temporal.kind === 'date' ? ['date'] : ['start', 'end'];
    if (members.some((member) => canonicalOf([...temporal.segments, { name: member }]) === canonical)) return 'string';
  }
  return undefined;
}

/** The declared temporal member a path node names, or `null`.
 * @param {any} node @param {number} itSlot @param {any} shape */
function declaredTemporal(node, itSlot, shape) {
  const path = memberPath(node, itSlot);
  if (path === null) return null;
  return (shape.temporals ?? []).find((/** @type {any} */ temporal) => temporal.canonical === path.canonical) ?? null;
}

/**
 * The key a key expression over a declared temporal member reads, or
 * `null`: `$instant` of a utc member (or `$epoch` of its instant) and `$wall`
 * of a floating one are exact over their generated key; `$instant` of a zoned
 * member under its declared policy is its stored key, which narrows.
 * @param {any} node @param {number} itSlot @param {any} shape
 * @returns {{ temporal: any, ref: any, exact: boolean, family: 'instant' | 'text' } | null}
 */
function temporalKey(node, itSlot, shape) {
  if (node?.kind !== 'op') return null;
  let temporal = null;
  if (node.name === '$instant') {
    temporal = declaredTemporal(node.args[0], itSlot, shape);
    if (temporal?.kind === 'zoned' && node.args[1]?.value !== temporal.policy) return null;
    if (temporal !== null && temporal.kind !== 'utc' && temporal.kind !== 'zoned') return null;
  }
  else if (node.name === '$epoch') {
    const path = memberPath(node.args[0], itSlot);
    if (path === null || path.segments.length < 2) return null;
    const last = path.segments[path.segments.length - 1];
    if (!('name' in last) || last.name !== 'instant') return null;
    const owner = canonicalOf(path.segments.slice(0, -1));
    temporal = (shape.temporals ?? []).find((/** @type {any} */ declared) => declared.kind === 'utc' && declared.canonical === owner) ?? null;
  }
  else if (node.name === '$wall') {
    temporal = declaredTemporal(node.args[0], itSlot, shape);
    if (temporal !== null && temporal.kind !== 'floating') return null;
  }
  if (temporal === null) return null;
  const zoned = temporal.kind === 'zoned';
  const ref = { segments: temporal.segments, type: zoned ? 'integer' : 'string', column: temporal.key };
  return { temporal, ref, exact: !zoned, family: temporal.kind === 'floating' ? 'text' : 'instant' };
}

/** A bound over a key column. @param {string} column @param {string} op @param {unknown} lit */
const temporalBound = (column, op, lit) => ({ p: 'colCmp', op, column, operand: { lit } });

/**
 * A comparison of a temporal key with a literal, or `null` where neither
 * side is a key over a declared member (the ordinary forms plan it).
 * @param {any} node @param {number} itSlot @param {any} shape
 * @returns {any}
 */
function planTemporalComparison(node, itSlot, shape) {
  let op = /** @type {string} */ (COMPARISONS.get(node.name));
  let [left, right] = node.args;
  let keyed = temporalKey(left, itSlot, shape);
  if (keyed === null) {
    keyed = temporalKey(right, itSlot, shape);
    if (keyed === null) return null;
    [left, right] = [right, left];
    op = /** @type {any} */ ({ lt: 'gt', le: 'ge', gt: 'lt', ge: 'le' })[op] ?? op;
  }
  if (right.kind !== 'literal')
    return { refusal: refusal(node.name, TEMPORAL_REASONS.operand) };
  const lit = right.value;
  const present = { p: 'typeIs', ref: keyed.ref, types: [], positive: true };
  if (!keyed.exact) return planZonedComparison(keyed, op, lit, shape, node.name);
  // the engine compares a key with a literal of its own family only: any
  // other pair is unequal and unordered (QUERY-FORMAT §8.4)
  const family = keyed.family === 'text' ? typeof lit === 'string' : typeof lit === 'number' && !Number.isNaN(lit);
  if (!family) return exactly(op === 'ne' ? present : { p: 'const', value: false });
  if (keyed.family === 'text') {
    return exactly(op === 'ne' ? { p: 'and', items: [present, { p: 'not', item: temporalBound(keyed.ref.column, 'eq', lit) }] }
      : temporalBound(keyed.ref.column, op, lit));
  }
  // a utc key holds the instant's one spelling, whose order is the
  // instant's: a bound in milliseconds is the spelling of the nearest whole
  // millisecond on the bound's side, and one past the years a value spells
  // holds every row or none
  const n = /** @type {number} */ (lit);
  if (op === 'eq') return exactly(Number.isInteger(n) && instantKey(n) !== null ? temporalBound(keyed.ref.column, 'eq', instantKey(n)) : { p: 'const', value: false });
  if (op === 'ne') {
    const key = Number.isInteger(n) ? instantKey(n) : null;
    return exactly(key === null ? present : { p: 'and', items: [present, { p: 'not', item: temporalBound(keyed.ref.column, 'eq', key) }] });
  }
  const upper = op === 'lt' || op === 'le';
  const whole = op === 'lt' || op === 'ge' ? Math.ceil(n) : Math.floor(n);
  if (whole > INSTANT_MAX) return exactly(upper ? present : { p: 'const', value: false });
  if (whole < INSTANT_MIN) return exactly(upper ? { p: 'const', value: false } : present);
  return exactly(temporalBound(keyed.ref.column, op, instantKey(whole)));
}

/**
 * A comparison of a zoned key: the rows the store's own provider keyed are
 * narrowed by their key, every other row is a candidate, and the engine
 * decides them all.
 * @param {any} keyed @param {string} op @param {unknown} lit @param {any} shape @param {string} construct
 * @returns {any}
 */
function planZonedComparison(keyed, op, lit, shape, construct) {
  if (typeof shape.zoneStamp !== 'string') return { refusal: refusal(construct, TEMPORAL_REASONS.zoneStamp) };
  if (typeof lit !== 'number' || Number.isNaN(lit) || op === 'ne')
    return { refusal: refusal(construct, TEMPORAL_REASONS.operand) };
  const { key, stamp } = keyed.temporal;
  const current = temporalBound(stamp, 'eq', shape.zoneStamp);
  // the key is an integer column (milliseconds): a bound that is no integer
  // of its range — a fraction, an infinity — is the integers it admits, which
  // PostgreSQL's bigint takes and SQLite compares alike
  const bound = integerBound(op, /** @type {number} */ (lit));
  const keyBound = bound === null ? temporalBound(key, op, lit) : bound === 'none' ? { p: 'const', value: false }
    : bound === 'present' ? temporalBound(key, 'ge', INSTANT_MIN) : temporalBound(key, bound.op, bound.lit);
  const pred = { p: 'or', items: [{ p: 'and', items: [current, keyBound] }, { p: 'not', item: current }] };
  return promotion(pred, { construct: '$instant', via: 'columns', columns: [stamp, key], exact: false },
    [refusal('$instant', TEMPORAL_REASONS.zoned)]);
}

/**
 * `$overlaps` of a declared date range with a literal date range: the two
 * bounds compared as the dates they are — exact, since a declared range is
 * half-open and never empty, and two dates order as their text. A probe
 * that is no pair of dates, or no range, plans as the engine's interval.
 * @param {any} node @param {number} itSlot @param {any} shape
 * @returns {any}
 */
function planDateRangeOverlap(node, itSlot, shape) {
  if (node.args.length !== 2) return null;
  let [subject, probeNode] = node.args;
  let temporal = declaredTemporal(subject, itSlot, shape);
  if (temporal === null) {
    [subject, probeNode] = [probeNode, subject];
    temporal = declaredTemporal(subject, itSlot, shape);
  }
  if (temporal === null || temporal.kind !== 'date-range') return null;
  const probe = constantOf(probeNode)?.value;
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  if (probe === null || typeof probe !== 'object' || Array.isArray(probe)
    || typeof probe.start !== 'string' || typeof probe.end !== 'string'
    || !DATE.test(probe.start) || !DATE.test(probe.end) || !(probe.start < probe.end)
    || !isCalendarDate(probe.start) || !isCalendarDate(probe.end)) return null;
  return exactly({ p: 'and', items: [temporalBound(temporal.key, 'lt', probe.end), temporalBound(temporal.end, 'gt', probe.start)] });
}


/** What a store's planner asks of a collection's declared temporal members. */
const TEMPORAL_PLANNER = Object.freeze({
  memberType: temporalMemberType,
  comparison: planTemporalComparison,
  overlap: planDateRangeOverlap,
  key: temporalKey,
  zonedOrder: TEMPORAL_REASONS.zonedOrder,
});

/**
 * The temporal seam's hooks: what the store, its planner, its tables, its
 * introspection and its migrations ask of a declared temporal member. A
 * store receives them inside `storeTemporals()` of `@jarenjs/db/temporals`;
 * a migration plans with them always, so a model read as history plans
 * whether or not a host installed the seam.
 */
export const TEMPORAL_HOOKS = Object.freeze({
  normalize: normalizeTemporals,
  normalizeEntity: normalizeEntityTemporal,
  refuseUnrecordedZones,
  planCollection: planCollectionTemporals,
  planEntity: planEntityTemporals,
  verifyCheck,
  readTable,
  readEntity: readEntityTemporals,
  entityShape: entityShapeTemporals,
  entityWrites,
  mapping: entityMapping,
  refuseAdopted,
  keyColumn: zonedKeyColumn,
  keyValues: temporalKeyValues,
  refuse: refuseFaults,
  zonedColumnsOf,
  zonedValueFor,
  /** The stamp a zoned key a store keyed through `provider` carries, or `null`
   * beside a provider that names no identity. @param {any} provider */
  zoneStamp: (provider) => (provider?.identity === undefined || provider?.identity === null ? null : stampOf(provider.identity)),
  rekey,
  planner: TEMPORAL_PLANNER,
});
