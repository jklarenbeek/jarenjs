//@ts-check
/** Bounded column mutation documents, lowered through the entity's writer plan. */
import { analyzeQuery } from '@jarenjs/json/query';
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { chain, attempt } from './driver.js';
import { DbCompileError, DbRuntimeError, wrapDriverError } from './errors.js';
import { entityShape, planEntityPredicate } from './plan.js';
import { createEntityPredicateEmitters } from './emit.js';
import { physicalSelection } from './physical.js';
import { utf8Length } from './cursor.js';

/** Compile once per document, execute within the existing guarded transaction.
 * @param {any} connection @param {any} entity @param {any} mapping @param {any} core */
export function createEntityMutation(connection, entity, mapping, core) {
  const dialect = connection.dialect;
  const q = dialect.quoteIdentifier;
  const plans = new Map();
  const fail = (reason) => { throw new DbCompileError('JD0038', reason, entity.docPath); };
  const column = (name) => {
    const c = mapping.columns.find((entry) => entry.name === name);
    if (!c) return fail(`unknown stored member '${name}'`);
    return c;
  };
  const writableColumn = (name) => {
    const c = column(name);
    if (c.generated || core.plan.keys.includes(name) || name === entity.version)
      fail(`'${name}' is an identity, revision or generated member`);
    return c;
  };
  const comparison = (c, prefix = '') => {
    const value = prefix + q(c.physical);
    return c.storage === 'string' ? dialect.codepoint(value) : value;
  };
  const compile = (document) => {
    if (entity.physical == null || dialect.name !== 'sqlite') fail('native mutations require a declared SQLite column layout');
    core.plan.writable();
    if (!document || typeof document !== 'object' || Array.isArray(document)) fail('a mutation is an object');
    const allowed = { update: ['key', 'expectedRevision', 'set'], upsert: ['values', 'conflict', 'update'],
      'insert-select': ['source', 'where', 'select', 'conflict', 'onConflict'] }[document.op];
    if (!allowed) fail('op must be update, upsert or insert-select');
    for (const key of Object.keys(document))
      if (!['op', 'returning', 'maxRows', 'maxBytes', ...allowed].includes(key)) fail(`unknown mutation member '${key}'`);
    const maxRows = document.maxRows ?? 100;
    const maxBytes = document.maxBytes ?? 1_048_576;
    if (![maxRows, maxBytes].every((n) => Number.isSafeInteger(n) && n > 0 && n < Number.MAX_SAFE_INTEGER)) fail('mutation row and byte bounds must be positive safe integers');
    const returning = document.returning ?? mapping.columns.map((c) => c.name);
    if (!Array.isArray(returning) || !returning.length || new Set(returning).size !== returning.length) fail('returning is a nonempty distinct member list');
    returning.forEach(column);
    // A before/after invariant needs the preimage. These plans promise one
    // data statement; database invariants retain their trigger enforcement.
    if (entity.invariants.some((rule) => rule.enforcement === 'store')) fail('store invariants require the entity writer with before/after images');
    const params = [];
    const param = (value) => { params.push(value); return dialect.parameterRef(params.length, 'v'); };
    const table = q(mapping.table);
    let sql;
    let prefix = '';
    if (document.op === 'update') {
      if (!document.set || typeof document.set !== 'object' || Array.isArray(document.set) || !Object.keys(document.set).length) fail('update needs a nonempty set object');
      const assignments = Object.entries(document.set).map(([name, value]) => {
        const c = writableColumn(name);
        const encoded = core.plan.encodeColumn(name, value);
        return { name: q(c.physical), compare: comparison(c), value: param(encoded), encoded };
      });
      const parts = core.normalizeKey(document.key);
      const where = core.plan.keys.map((key, i) => `${q(column(key).physical)} = ${param(core.plan.encodeColumn(key, parts[i]))}`);
      if (entity.version !== null) {
        if (!Number.isSafeInteger(document.expectedRevision) || document.expectedRevision < 0) fail('a versioned update needs expectedRevision');
        where.push(`${q(column(entity.version).physical)} = ${param(document.expectedRevision)}`);
      }
      else if (document.expectedRevision !== undefined) fail('expectedRevision needs a declared version member');
      where.push(`(${assignments.map((a) => `${a.compare} IS NOT ${param(a.encoded)}`).join(' OR ')})`);
      const sets = assignments.map((a) => `${a.name} = ${a.value}`);
      if (entity.version !== null) sets.push(`${q(column(entity.version).physical)} = ${q(column(entity.version).physical)} + 1`);
      sql = `UPDATE ${table} SET ${sets.join(', ')} WHERE ${where.join(' AND ')}`;
    }
    else {
      if (JSON.stringify(document.conflict) !== JSON.stringify(core.plan.keys)) fail('conflict must name the complete ordered primary key');
      let names;
      let source;
      if (document.op === 'upsert') {
        if (!document.values || typeof document.values !== 'object' || Array.isArray(document.values)) fail('upsert needs values');
        const complete = core.complete(document.values, { updating: false });
        const split = core.plan.split(complete);
        names = split.values.map((v) => v.name);
        if (core.plan.keys.some((key) => !names.includes(key))) fail('upsert requires every primary-key value');
        source = `VALUES (${split.values.map((v) => param(v.value)).join(', ')})`;
      }
      else {
        if (document.source !== entity.name || document.onConflict !== 'nothing') fail('insert-select supports same-entity sources with onConflict nothing');
        if (!document.select || typeof document.select !== 'object' || Array.isArray(document.select)) fail('insert-select needs a projection');
        names = Object.keys(document.select);
        if (!names.length || core.plan.keys.some((key) => !names.includes(key))) fail('insert-select projects every primary-key member');
        const values = names.map((name) => {
          const target = column(name);
          if (target.generated || name === entity.version) fail('insert-select leaves generated values and revisions database-owned');
          const value = document.select[name];
          if (typeof value === 'string' && value.startsWith('$it.')) {
            const from = column(value.slice(4));
            if (from.codec !== target.codec || from.null !== target.null) fail('insert-select requires identical source and target codecs');
            return `${q('s')}.${q(from.physical)}`;
          }
          if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && Object.hasOwn(value, '$literal'))
            return param(core.plan.encodeColumn(name, value.$literal));
          return fail('insert-select values are singular member paths or $literal values');
        });
        const analyzed = analyzeQuery({ $for: { it: '$[*]' }, $where: document.where ?? true, $return: '$it' });
        const predicate = planEntityPredicate(analyzed.root.where, analyzed.root.forBindings[0].slot, entityShape(entity, mapping));
        if ('refusal' in predicate) fail(predicate.refusal.reason);
        const emitter = createEntityPredicateEmitters(dialect, (slot) => {
          if (!Object.hasOwn(slot, 'literal')) return fail('mutation predicates use literal values');
          return param(slot.literal);
        });
        const where = emitter.emitPred(q('s'), `${q('s')}.${q('doc')}`, predicate.pred);
        source = `SELECT ${values.join(', ')} FROM ${table} AS ${q('s')} WHERE ${where}`
          + ` ORDER BY ${core.plan.keys.map((key) => `${q('s')}.${q(column(key).physical)}`).join(', ')}`
          + ` LIMIT ${maxRows + 1}`;
        const aliases = names.map((name, i) => q(`v${i}`));
        prefix = `WITH ${q('_jaren_source')} (${aliases.join(', ')}) AS MATERIALIZED (${source}) `;
        source = `SELECT ${aliases.join(', ')} FROM ${q('_jaren_source')} WHERE `
          + dialect.mutationRowGuard(`(SELECT COUNT(*) FROM ${q('_jaren_source')})`, maxRows);
      }
      sql = `INSERT INTO ${table} (${names.map((name) => q(column(name).physical)).join(', ')}) ${source}`
        + ` ON CONFLICT (${core.plan.keys.map((key) => q(column(key).physical)).join(', ')})`;
      if (document.op === 'insert-select') sql += ' DO NOTHING';
      else {
        if (!Array.isArray(document.update) || !document.update.length || new Set(document.update).size !== document.update.length) fail('upsert update names distinct stored members');
        const changes = document.update.map((name) => {
          const c = writableColumn(name);
          if (!names.includes(name)) fail('an upsert update member must be supplied in values');
          return { name: q(c.physical), compare: comparison(c, `${table}.`) };
        });
        const sets = changes.map(({ name }) => `${name} = excluded.${name}`);
        if (entity.version !== null) sets.push(`${q(column(entity.version).physical)} = ${table}.${q(column(entity.version).physical)} + 1`);
        sql += ` DO UPDATE SET ${sets.join(', ')} WHERE ${changes.map(({ name, compare }) => `${compare} IS NOT excluded.${name}`).join(' OR ')}`;
      }
    }
    sql = prefix + sql + ` RETURNING ${physicalSelection(mapping, dialect)}`;
    return { sql, params, returning, maxRows, maxBytes, statement: null };
  };
  return (document) => {
    const key = canonicalizeJson(document);
    let plan = plans.get(key);
    if (!plan) {
      plan = compile(document);
      if (plans.size >= 64) plans.delete(plans.keys().next().value);
      plans.set(key, plan);
    }
    return connection.transaction(() => {
      plan.statement ??= connection.prepare(plan.sql);
      return chain(plan.statement, (statement) => chain(attempt(() => statement.all(plan.params),
        (error) => String(error?.message).includes('jaren-mutation-row-bound')
          ? new DbRuntimeError('JD2007', 'insert-select exceeded its source row bound', { cause: error })
          : wrapDriverError(error, { collection: entity.name, docPath: entity.docPath })), (rows) => {
        const stored = rows.map(core.plan.merge);
        if (rows.length > plan.maxRows || utf8Length(JSON.stringify(stored)) > plan.maxBytes)
          throw new DbRuntimeError('JD2007', 'native mutation exceeded its returned row or byte bound');
        stored.forEach(core.validateOnly);
        const returned = stored.map((row) => Object.fromEntries(plan.returning
          .filter((name) => Object.hasOwn(row, name)).map((name) => [name, row[name]])));
        return { mode: 'native', affected: rows.length, rows: returned,
          admitted: { statements: 1, rows: rows.length, bytes: utf8Length(JSON.stringify(stored)) } };
      }));
    });
  };
}
