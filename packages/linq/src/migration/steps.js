//@ts-check
/**
 * @file The step spellings of a `$migration` 0.1 document
 * (MIGRATION-FORMAT §2): each function writes one step as plain JSON in
 * the member order the format's examples use, and refuses only what it
 * cannot spell (`JL0101`) or what the runner's own structural check would
 * refuse later and the pen can see now (`JL0101`, mirrored from the
 * runner's `JD0023` rules: a `sql` step without text, a `derive` without
 * columns, a `rebuild` without its rendered parts, an unknown kind). A
 * transform's callback is captured through the JSLT pen's `body()` — the
 * capture the format's `jslt` step runs — as one root rule; an
 * assertion's predicate through the chain's recording proxy, rooted at
 * `$it` inside the `$for` the format's own example writes.
 */

import { isJsonObject } from '@jarenjs/core/object';
import { captureExpression } from '../expression.js';
import { body } from '../jslt/body.js';
import { describeValue, requireJson } from '../json-boundary.js';
import { LinqBuildError } from '../errors.js';

/** The kinds the runner accepts, in the artifact's order. */
const STEP_KINDS = ['ddl', 'jslt', 'query', 'derive', 'sql', 'rebuild'];
const EXPECTS = ['empty', 'ebv'];
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** An assertion evaluates with no externals: `p.x` cannot appear. */
const NO_PARAMS = new Set();

/** A JSON value, copied: the document is a value of its own. @param {any} v */
const copy = (v) => JSON.parse(JSON.stringify(v));

/**
 * A table name: an identifier, as the artifact's pattern admits.
 * @param {any} name
 * @param {string} what
 * @returns {string}
 */
export function requireName(name, what) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new LinqBuildError('JL0101',
      `${what} names an entity or collection by identifier ('users'), got ${describeValue(name)}`);
  }
  return name;
}

/** @param {any} sql @param {string} what */
function requireSql(sql, what) {
  if (typeof sql !== 'string' || sql.trim() === '') {
    throw new LinqBuildError('JL0101',
      `${what} takes one rendered SQL statement as a non-empty string, got ${describeValue(sql)}`);
  }
  return sql;
}

/** @param {any} note @param {string} what */
function readNote(note, what) {
  if (note === undefined) return undefined;
  if (typeof note !== 'string') {
    throw new LinqBuildError('JL0101', `${what} note is a string, got ${describeValue(note)}`);
  }
  return note;
}

/** The externals proxy an assertion's predicate sees: nothing. */
const NO_EXTERNALS = new Proxy(Object.freeze({}), {
  get(_target, prop) {
    if (typeof prop === 'symbol') return undefined;
    throw new LinqBuildError('JL0104',
      `an assert() predicate cannot bind '${String(prop)}' — a query assertion runs over the `
      + "table's rows with no externals (MIGRATION-FORMAT §2)");
  },
});

/**
 * `{ kind: 'ddl', sql, note? }` — one rendered DDL statement.
 * @param {string} sql @param {string} [note]
 */
export function ddlStep(sql, note = undefined) {
  const out = { kind: 'ddl', sql: requireSql(sql, 'ddl()') };
  const n = readNote(note, 'ddl()');
  if (n !== undefined) out.note = n;
  return out;
}

/**
 * `{ kind: 'sql', sql, note? }` — one DATA statement spelled directly
 * (§9.4); a dry run always prints it with its note.
 * @param {string} sql @param {string} [note]
 */
export function sqlStep(sql, note = undefined) {
  const out = { kind: 'sql', sql: requireSql(sql, 'sql()') };
  const n = readNote(note, 'sql()');
  if (n !== undefined) out.note = n;
  return out;
}

/**
 * `{ kind: 'jslt', collection, stylesheet }` — the transform of one
 * table's rows. The spelling is a callback (one root rule, `match: '$'`,
 * its body captured over the whole row with `root`/`path` as the
 * externals the engine binds), a `stylesheet(…)` envelope (its rules —
 * the step carries the rules array, so a disposition or a mode table
 * has no place in it, `JL0102`), or a rules array verbatim.
 * @param {string} name
 * @param {any} spelling
 */
export function transformStep(name, spelling) {
  requireName(name, 'transform()');
  let stylesheet;
  if (typeof spelling === 'function') {
    stylesheet = [{ match: '$', body: body(spelling) }];
  }
  else if (Array.isArray(spelling)) {
    stylesheet = copy(requireJson(spelling, 'transform() rules'));
  }
  else if (isJsonObject(spelling) && spelling.$jslt === '0.1') {
    for (const key of Object.keys(spelling)) {
      if (key !== '$jslt' && key !== 'rules') {
        throw new LinqBuildError('JL0102',
          `transform() takes a stylesheet's rules — a jslt step carries the rules array `
          + `(MIGRATION-FORMAT §2), so '${key}' has no place in it; write the rules without it`,
          `/${key}`);
      }
    }
    stylesheet = copy(requireJson(spelling.rules, 'transform() stylesheet rules'));
    if (!Array.isArray(stylesheet)) {
      throw new LinqBuildError('JL0101',
        `transform() stylesheet rules are an array, got ${describeValue(spelling.rules)}`, '/rules');
    }
  }
  else {
    throw new LinqBuildError('JL0101',
      'transform() takes a callback (row, x) => …, a stylesheet(…) document or a rules array, '
      + `got ${describeValue(spelling)}`);
  }
  return { kind: 'jslt', collection: name, stylesheet };
}

/**
 * `{ kind: 'query', collection, assert, expect? }` — an assertion over
 * the table's rows. A callback names a predicate over one row, spelled
 * as the format's own `$for` over the rows: with `expect: 'empty'` (the
 * default, absent from the document) no row may satisfy it — the
 * predicate names the VIOLATION; with `expect: 'ebv'` the matching rows
 * are the witness. A document is taken verbatim.
 * @param {string} name
 * @param {any} spelling
 * @param {{ expect?: 'empty' | 'ebv' }} [options]
 */
export function assertStep(name, spelling, options = undefined) {
  requireName(name, 'assert()');
  let expect;
  if (options !== undefined) {
    if (!isJsonObject(options)) {
      throw new LinqBuildError('JL0101', `assert() options are { expect? }, got ${describeValue(options)}`);
    }
    for (const key of Object.keys(options)) {
      if (key !== 'expect') throw new LinqBuildError('JL0101', `assert() does not take '${key}'`);
    }
    if (options.expect !== undefined) {
      if (!EXPECTS.includes(options.expect)) {
        throw new LinqBuildError('JL0101',
          `assert() expect is 'empty' or 'ebv' (MIGRATION-FORMAT §2), got ${describeValue(options.expect)}`,
          '/expect');
      }
      expect = options.expect;
    }
  }
  let query;
  if (typeof spelling === 'function') {
    const predicate = captureExpression((it) => spelling(it, NO_EXTERNALS), ['it'], NO_PARAMS);
    query = { $for: { it: '$[*]' }, $where: predicate, $return: '$it' };
  }
  else if (spelling !== undefined) {
    query = copy(requireJson(spelling, 'assert() query'));
  }
  else {
    throw new LinqBuildError('JL0101',
      'assert() takes a predicate (row) => … or a query document over the rows');
  }
  const out = { kind: 'query', collection: name, assert: query };
  if (expect === 'ebv') out.expect = 'ebv';
  return out;
}

/**
 * `{ kind: 'derive', collection, columns }` — recompute stored derived
 * columns (§2.1); the columns ride verbatim, a non-empty array.
 * @param {string} name
 * @param {any} columns
 */
export function deriveStep(name, columns) {
  requireName(name, 'derive()');
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new LinqBuildError('JL0101',
      `derive() takes a non-empty array of derived-column records ({ name, derive, segments }), got ${describeValue(columns)}`);
  }
  return { kind: 'derive', collection: name, columns: copy(requireJson(columns, 'derive() columns')) };
}

/**
 * Any planner-emitted step, verbatim — the escape that keeps `rebuild`
 * authorable without the pen re-implementing §10. The structural rules
 * are the runner's own (`JD0023`), seen here: a recognised kind and the
 * members that kind requires. A `draft` flag rides untouched.
 * @param {any} step
 */
export function rawStep(step) {
  const raw = copy(requireJson(step, 'step()'));
  if (!isJsonObject(raw) || !STEP_KINDS.includes(raw.kind)) {
    throw new LinqBuildError('JL0101',
      `step() takes a migration step with a recognised kind (${STEP_KINDS.join(', ')}), got `
      + `${isJsonObject(raw) ? `kind ${describeValue(raw.kind)}` : describeValue(step)}`);
  }
  const need = (member, ok) => {
    if (!ok) {
      throw new LinqBuildError('JL0101',
        `step() '${raw.kind}' needs '${member}' (MIGRATION-FORMAT §2)`, `/${member}`);
    }
  };
  switch (raw.kind) {
    case 'ddl': case 'sql':
      need('sql', typeof raw.sql === 'string' && raw.sql !== '');
      break;
    case 'jslt':
      need('collection', typeof raw.collection === 'string');
      need('stylesheet', Array.isArray(raw.stylesheet));
      break;
    case 'query':
      need('collection', typeof raw.collection === 'string');
      need('assert', raw.assert !== undefined);
      break;
    case 'derive':
      need('collection', typeof raw.collection === 'string');
      need('columns', Array.isArray(raw.columns) && raw.columns.length > 0);
      break;
    default: // rebuild
      need('table', typeof raw.table === 'string');
      need('create', Array.isArray(raw.create) && raw.create.length > 0);
      need('copy', typeof raw.copy === 'string');
      need('indexes', Array.isArray(raw.indexes));
  }
  return raw;
}
