//@ts-check
/**
 * @file The PostgreSQL dialect — the second spelling of the dialect
 * contract, and the reason the contract exists.
 *
 * It imports no PostgreSQL client and no runtime builtin: it is pure
 * text, exactly like the SQLite dialect beside it, so
 * `@jarenjs/db/postgres` resolves in a browser bundle and type-checks
 * with nothing installed. Transport is the driver's business
 * (`src/drivers/postgres.js`), and the driver is INJECTED — a
 * standards-shaped client or pool the host supplies.
 *
 * The mapping, in one paragraph. Documents are stored `jsonb`. An
 * indexed path becomes a STORED generated column, because PostgreSQL
 * has no indexable virtual one; its type is the schema's, and the
 * expression is guarded by `jsonb_typeof` inside a `CASE` so a document
 * whose member is the wrong JSON type stores `NULL` rather than failing
 * the INSERT — a cast that can raise is not a legal generated-column
 * expression. Text columns and text comparisons carry `COLLATE "C"`,
 * which is byte order, which is what SQLite's default `BINARY`
 * collation is: without it the same prefix range would hold different
 * rows on a database initialised in another locale. Every table this
 * dialect creates carries `rid bigserial`, because PostgreSQL has no
 * per-row identity that survives an UPDATE (`ctid` moves) and a
 * collection is a SEQUENCE — its order is insertion order, and the
 * store orders by `rowIdentity()` wherever the model says so.
 *
 * What it does NOT do, declared rather than approximated: no
 * configuration vocabulary (`pragmas: false` — a PostgreSQL server is
 * configured by its operator, not by a store at open), no stored CREATE
 * text (`declaredSqlText: false` — the drift check is the structural
 * one, with each index condition and generated column's expression read
 * back from the catalog), no virtual tables and no sync triggers (so a `physical: 'rtree'`
 * column set maps back onto the B-tree over its four edge columns; the
 * database rules of MODEL-FORMAT §13 are trigger functions of their own,
 * verified through the catalog), and
 * no column without a scalar type — which is why a comparison against a
 * member the schema does not type reads the document rather than the
 * column. `BEGIN IMMEDIATE` has no analogue either: the store's writer
 * lock is an advisory lock of its own class, taken right after `BEGIN`
 * (`tx.writerLock`).
 */

import { createDialect, stringLiteral, MEMBER_WHEN } from '../dialect.js';
import { postgresPhysicalRead, postgresPhysicalCompare, postgresPhysicalValueType, postgresPhysicalDifferent, postgresPhysicalTypeMatches, qualifyPostgresPhysicalColumn } from './postgres-physical.js';
import { postgresCatalog } from './postgres-catalog.js';
import { POSTGRES, postgresInvariantTriggers } from './postgres-invariants.js';
import { postgresRelational } from './postgres-relational.js';
import { postgresMigration } from './postgres-migration.js';
import { postgresCapture } from './postgres-capture.js';
import { postgresJobs } from './postgres-jobs.js';
import { postgresReplication } from './postgres-replication.js';
import { POSTGRES_LOCK_CLASSES, OWNER_LOCK, transactionLock } from './postgres-locks.js';
import { readExpression } from './expression-read.js';
import { postgresChecks, POSTGRES_PREDICATE, POSTGRES_PREDICATE_ESCAPED } from './check-read.js';
import { functionNameKey, postgresReadBack } from './postgres-read-back.js';
import { modelPath, readsAsIndex } from '../model-path.js';
import { columnKindFor } from '../scalar-types.js';

/** PostgreSQL truncates an identifier past this many BYTES, silently
 * and with only a notice — so two long generated names would collide
 * and one index would quietly serve another column's path. */
export const IDENTIFIER_BYTES = 63;

const UTF8 = new TextEncoder();

/**
 * @param {string} name
 * @returns {string}
 */
function quoteIdentifier(name) {
  const text = String(name);
  if (UTF8.encode(text).length > IDENTIFIER_BYTES) {
    throw new TypeError(
      `postgres dialect: the identifier '${text}' is longer than ${IDENTIFIER_BYTES} bytes, `
      + 'which PostgreSQL truncates silently — two names that share a prefix would become one');
  }
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * A member path as the text of a PostgreSQL `text[]`, which is what
 * `#>` and `jsonb_set` navigate by. Every element is quoted and its
 * backslashes and quotes escaped, so a member named `a,b` or `}` is one
 * element rather than two.
 *
 * Two shapes return `null`, and the caller then falls back to a
 * whole-document strategy rather than addressing the wrong member: a
 * NEGATIVE array index (`#>` counts from the front only — `jsonb_set`
 * would accept one, and a path that meant different members to the read
 * and the write would be worse than no path), and a name carrying a NUL,
 * which no PostgreSQL text value can hold.
 * @param {import('../dialect.js').JsonPathSegment[]} segments
 * @returns {string | null}
 */
function jsonPathText(segments) {
  const parts = [];
  for (const segment of segments) {
    if ('index' in segment) {
      if (segment.index < 0) return null;
      parts.push(`"${segment.index}"`);
      continue;
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000]/.test(segment.name)) return null;
    parts.push(`"${segment.name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * The same path with one more element on the end — how an append
 * addresses the position after an array's last.
 * @param {string} pathText
 * @param {string} element
 * @returns {string}
 */
function pathWith(pathText, element) {
  const body = pathText.slice(1, -1);
  return `{${body.length === 0 ? '' : `${body},`}${element}}`;
}

/**
 * The declared column type for a schema-declared value type.
 *
 * `numeric` carries BOTH JSON number types. PostgreSQL would take
 * `bigint` for an integer member, and it would be the better index —
 * but a document whose `integer` member holds `3.5` (a schema this
 * store validates against only when a validator is injected) would then
 * fail its INSERT inside a generated column's cast, and a storage
 * decision that can reject a document the model accepts is not a
 * storage decision. The cost is stated: `integer` and `number` are one
 * column type here, and introspection cannot tell them apart.
 *
 * A path the schema does not type has no honest scalar type at all, so
 * it is `jsonb` — indexable, comparable with another `jsonb`, and
 * comparable with nothing else, which is exactly what
 * `capabilities.untypedColumns: false` says.
 * @param {string | undefined} schemaType
 * @param {string} hint - `'key'` or `'generated'`
 * @returns {string}
 */
function typeFor(schemaType, hint) {
  switch (schemaType) {
    case 'string': return 'text COLLATE "C"';
    case 'integer': return 'numeric';
    case 'number': return 'numeric';
    // 1 and 0, not TRUE and FALSE. A boolean MEMBER is 1 or 0 in the
    // SQLite mapping, every shared form that touches one compares it
    // against those integers (a type test, a projected pair's own type
    // name), and a column that answered `true` would make each of those
    // an operator-resolution error rather than a row. The loss is
    // stated: introspection reads this column back as a number.
    case 'boolean': return 'smallint';
    default: return hint === 'key' ? 'text COLLATE "C"' : 'jsonb';
  }
}

/** How the reading session spells a backslash in a plain string, beside a
 * deparse that spells one: `on` reads it as itself, `off` doubles it. */
const CONFORMING = "(SELECT s.setting FROM pg_settings AS s WHERE s.name = 'standard_conforming_strings')";

/** The catalog's own spelling of a type this dialect declares, so the
 * drift check compares like with like: a collation, an allocation
 * clause and a serial's expansion are all how a type is WRITTEN, not
 * what the catalog reports it as. */
const TYPE_SYNONYMS = Object.freeze({
  BIGSERIAL: 'BIGINT', SERIAL: 'INTEGER', SMALLSERIAL: 'SMALLINT',
  INT8: 'BIGINT', INT4: 'INTEGER', INT2: 'SMALLINT', INT: 'INTEGER',
  FLOAT8: 'DOUBLE PRECISION', FLOAT4: 'REAL', BOOL: 'BOOLEAN',
  'CHARACTER VARYING': 'VARCHAR', DECIMAL: 'NUMERIC',
});

/**
 * @param {string} declaredType
 * @returns {string}
 */
function comparableColumnType(declaredType) {
  const bare = String(declaredType)
    .replace(/\s+COLLATE\s+("[^"]*"|\S+)/i, '')
    .replace(/\s+GENERATED\s+.*$/i, '')
    .replace(/\s+NOT\s+NULL$/i, '')
    .trim()
    .toUpperCase();
  return TYPE_SYNONYMS[bare] ?? bare;
}

/**
 * Whether a column of `declaredType` can be compared with a value of
 * `kind` at all. PostgreSQL resolves an operator by type, so a text
 * column against a numeric parameter is a parse error rather than a row
 * that fails its guard — the emitter reads the member out of the
 * document instead, which answers the same and merely does not seek.
 * @param {string | undefined} declaredType
 * @param {string} kind
 * @returns {boolean}
 */
function columnUsableFor(declaredType, kind) {
  return kind === 'any' || columnKindFor(declaredType) === kind;
}

/**
 * The type discriminator, in the vocabulary the whole store shares —
 * SQLite's, because the row decoder reads these names in JavaScript.
 * `jsonb_typeof` answers six names and this maps the two that differ:
 * a JSON string is `text`, and a JSON boolean is `true` or `false`
 * (which is how a type test spells an equality against one). A JSON
 * number stays `number`, and `numericTypeNames` is what tells the
 * emitter so.
 * @param {string} atSql - SQL for the member, as `jsonb`
 * @returns {string}
 */
function typeOfJsonb(atSql) {
  return `(CASE WHEN jsonb_typeof(${atSql}) = 'string' THEN 'text' `
    + `WHEN jsonb_typeof(${atSql}) = 'boolean' `
    + `THEN (CASE WHEN (${atSql})::boolean THEN 'true' ELSE 'false' END) `
    + `ELSE jsonb_typeof(${atSql}) END)`;
}

/**
 * A `numeric` read as the double the engine holds: the cast rounds a
 * decimal to the nearest double, as `JSON.parse` does, but raises where
 * that double would be an infinity or a zero — a number past the double
 * range, which only another writer can spell — so those read as the
 * engine's infinity or (signed) zero instead: at and past the midpoint
 * between the largest double and 2^1024 (whose tie rounds to the infinity),
 * and at and below 2^-1075, half the least double (whose tie rounds to
 * zero).
 * @param {string} sql - a `numeric`
 * @returns {string} a `double precision`
 */
function doubleOf(sql) {
  return `(CASE WHEN abs(${sql}) < power(2::numeric, 1024) - power(2::numeric, 970) `
    + `AND (abs(${sql}) * power(2::numeric, 1075) > 1 OR ${sql} = 0) THEN (${sql})::float8 `
    + `WHEN abs(${sql}) >= 1 THEN sign(${sql})::float8 * 'Infinity'::float8 `
    + `ELSE sign(${sql})::float8 * 0::float8 END)`;
}

/**
 * The member at a path, read as the SQL type a comparison of the given
 * KIND needs. Every typed form is a `CASE` over `jsonb_typeof`, and the
 * guard is INSIDE it for two reasons: a cast that can raise is not a
 * legal generated-column expression, and `AND` does not short-circuit,
 * so a guard beside the cast would not stop it either.
 * @param {string} columnSql
 * @param {string} pathText
 * @param {string} [kind]
 * @returns {string}
 */
function jsonExtract(columnSql, pathText, kind) {
  const at = `(${columnSql} #> ${stringLiteral(pathText)})`;
  switch (kind) {
    case 'text':
      return `((CASE WHEN jsonb_typeof(${at}) = 'string' `
        + `THEN ${columnSql} #>> ${stringLiteral(pathText)} END) COLLATE "C")`;
    case 'number':
      return `(CASE WHEN jsonb_typeof(${at}) = 'number' THEN (${at})::numeric END)`;
    // `double` is a number a GROUP KEY reads: the double the engine holds, so that
    // every spelling of one double is one key (`1` and `1.0`, `1152921504606846976`
    // and `1152921504606847000`) and no text of either is needed to group by
    case 'double':
      return doubleOf(`(CASE WHEN jsonb_typeof(${at}) = 'number' THEN (${at})::numeric END)`);
    case 'boolean':
      return `(CASE WHEN jsonb_typeof(${at}) = 'boolean' `
        + `THEN (CASE WHEN (${at})::boolean THEN 1 ELSE 0 END) END)`;
    // a projected SCALAR leaf: its text, whatever JSON type it is. The
    // decoder reads the type name beside it and rebuilds the value, so
    // one column that can carry every scalar is what it needs
    case 'scalar':
      return `(${columnSql} #>> ${stringLiteral(pathText)})`;
    // a group KEY that may hold any scalar: a number as the number it is, with no
    // trailing zeros of the scale its JSON text was written with (`1` and `1.0` are
    // one key), every other scalar as its text
    case 'key':
      return `(CASE WHEN jsonb_typeof(${at}) = 'number' THEN trim_scale((${at})::numeric)::text `
        + `ELSE ${columnSql} #>> ${stringLiteral(pathText)} END)`;
    // a unique KEY over a member that may hold an object or an array: the container as
    // `jsonb`, whose equality is the engine's (member order aside, numbers by value)
    case 'object':
    case 'array':
      return `(CASE WHEN jsonb_typeof(${at}) = '${kind}' THEN ${at} END)`;
    default:
      return at;
  }
}

/**
 * The containers a path's steps must meet, outermost first, for a read of
 * the member at `segments` to select what the engine's path selects: the
 * parent of each step that is an index must be an array, and the parent of
 * each name an array would take for an index ({@link readsAsIndex}) an
 * object. `null` where the dialect cannot spell the path at all.
 * @param {import('../dialect.js').JsonPathSegment[]} segments
 * @returns {{ parent: import('../dialect.js').JsonPathSegment[], container: 'array' | 'object' }[] | null}
 */
function guardSteps(segments) {
  if (jsonPathText(segments) === null) return null;
  const steps = [];
  segments.forEach((segment, at) => {
    const index = 'index' in segment;
    if (!index && !readsAsIndex(segment.name)) return;
    steps.push({ parent: segments.slice(0, at), container: /** @type {'array' | 'object'} */ (index ? 'array' : 'object') });
  });
  return steps;
}

/**
 * The condition under which a query reads the member at `segments` from a
 * document, or `null` when every read is right. `#>` has one spelling for
 * the array element `0` and the object key `0`, so a path step that is an
 * index, or a name that reads as one, would select a member the engine's
 * path never selects: the key `0` of an object for an index step, the
 * element `0` of an array for a name step. The parent of each such step
 * must be the container the step means (see {@link guardSteps}). A
 * generated column, an index expression and an interval's CHECK whose
 * path leaves such a container open read through the same guard
 * ({@link queryDocument} of the dialect); the migrations and the drift
 * read-back spell a top-level member through {@link jsonExtract} alone.
 * @param {string} documentSql - SQL for the document, as `jsonb`
 * @param {import('../dialect.js').JsonPathSegment[]} segments
 * @returns {string | null}
 */
function queryGuard(documentSql, segments) {
  const steps = guardSteps(segments);
  if (steps === null || steps.length === 0) return null;
  return steps.map(({ parent, container }) => {
    const at = parent.length === 0 ? documentSql
      : `(${documentSql} #> ${stringLiteral(/** @type {string} */ (jsonPathText(parent)))})`;
    return `jsonb_typeof(${at}) = '${container}'`;
  }).join(' AND ');
}

/**
 * The schema type a declared column type came from. Two mappings here
 * are LOSSY on the way back and the introspector's report says so:
 * `numeric` carries both `integer` and `number`, and `smallint` carries
 * a boolean member's 1 and 0. `jsonb` carries no scalar type at all.
 * @param {string} declaredType
 * @returns {string | undefined}
 */
function schemaTypeOf(declaredType) {
  switch (comparableColumnType(declaredType)) {
    case 'TEXT': case 'VARCHAR': case 'CHARACTER': return 'string';
    case 'NUMERIC': case 'DOUBLE PRECISION': case 'REAL': return 'number';
    case 'BIGINT': case 'INTEGER': case 'SMALLINT': return 'integer';
    case 'BOOLEAN': return 'boolean';
    default: return undefined;
  }
}

/** The words a re-rendered expression puts before a parenthesis that
 * are not function calls: `WHEN (`, `AND (`, and their kin. */
const SQL_WORDS = new Set(['CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'AND', 'OR', 'NOT',
  'IN', 'IS', 'BETWEEN', 'LIKE', 'COLLATE', 'SELECT', 'WHERE']);

/**
 * One PostgreSQL array literal's elements. The server RE-RENDERS the
 * literal it stored — dropping the quotes a member did not need — so
 * the parse has to take both forms, and a member named `a,b` comes back
 * quoted for exactly that reason.
 * @param {string} body - between the braces
 * @returns {string[] | null}
 */
function parseArrayLiteral(body) {
  const out = [];
  let i = 0;
  if (body.length === 0) return out;
  while (i <= body.length) {
    if (body[i] === '"') {
      let text = '';
      i += 1;
      while (i < body.length && body[i] !== '"') {
        if (body[i] === '\\') { text += body[i + 1] ?? ''; i += 2; continue; }
        text += body[i];
        i += 1;
      }
      if (body[i] !== '"') return null;
      out.push(text);
      i += 1;
    }
    else {
      const comma = body.indexOf(',', i);
      const end = comma < 0 ? body.length : comma;
      out.push(body.slice(i, end));
      i = end;
    }
    if (i >= body.length) return out;
    if (body[i] !== ',') return null;
    i += 1;
  }
  return out;
}

/**
 * The member path a generated column's expression reads, recovered from
 * this dialect's own spelling. Every form it writes navigates with `#>` or
 * `#>>` over an array literal, and the member is the LONGEST path read:
 * the guard of a path that leaves a container open reads its parents,
 * each a proper prefix of the member, and may come before it. Anything
 * else answers `null`, and the caller reports the column rather than
 * inventing a path for it.
 * @param {string} expression
 * @returns {import('../dialect.js').JsonPathSegment[] | null}
 */
function memberPathOf(expression) {
  const text = String(expression);
  // and NOTHING else calls: every form `jsonExtract` writes navigates
  // with `#>` under at most a `jsonb_typeof` guard, so an expression
  // that calls anything else is a DECLARED index expression rather than
  // a member read — and reading it as a member would lose the index
  for (const call of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    if (call[1] === 'jsonb_typeof' || SQL_WORDS.has(call[1].toUpperCase())) continue;
    return null;
  }
  // a function whose name is a keyword comes back quoted: `"left"(…)`
  if (/"(?:[^"]|"")+"\s*\(/.test(text)) return null;
  /** @type {string[] | null} */
  let longest = null;
  for (const match of text.matchAll(/#>>?\s*'\{((?:[^']|'')*)\}'/g)) {
    const elements = pathElementsOf(`{${match[1].replace(/''/g, "'")}}`);
    if (elements === null) return null;
    if (longest === null || elements.length > longest.length) longest = elements;
  }
  if (longest === null) return null;
  const member = longest;
  // a step the guard says is a step into an OBJECT is a name, whatever it spells
  /** @type {Set<number>} */
  const names = new Set();
  for (const guard of text.matchAll(GUARD_TEST)) {
    const parent = guard[1] === undefined ? [] : pathElementsOf(`{${guard[1].replace(/''/g, "'")}}`);
    if (parent !== null && guard[2] === 'object' && parent.every((element, at) => element === member[at])) names.add(parent.length);
  }
  return segmentsOfElements(member, (at) => names.has(at));
}

/** A guard's test of a container, in this dialect's spelling and the server's:
 * `jsonb_typeof(("doc" #> '{"u"}')) = 'object'`, the parent path (none for the
 * document itself) and the container the parent must be. */
const GUARD_TEST = /jsonb_typeof\(\(*\s*(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_]*)\s*(?:#>\s*'\{((?:[^']|'')*)\}'(?:::text\[\])?\s*)?\)+\s*=\s*'(array|object)'/g;

/**
 * Whether an expression reads its member under the guard of
 * {@link queryGuard}: a `CASE` whose branch is the bare document column
 * (`THEN "doc" END`, or the server's `THEN doc ELSE NULL::jsonb END`). Every
 * other `CASE` this dialect writes returns a read or a cast of the member.
 * @param {string} expression
 * @returns {boolean}
 */
function memberGuarded(expression) {
  return /\bTHEN\s+(?:"(?:[^"]|"")+"|(?!(?:true|false|null)\b)[A-Za-z_][A-Za-z0-9_]*)\s+(?:END|ELSE)\b/i.test(String(expression));
}

/**
 * The elements of a `#>` array literal (`{span,"a b",0}`), or `null` for
 * text that is none or names no element.
 * @param {string} literal
 * @returns {string[] | null}
 */
function pathElementsOf(literal) {
  if (!literal.startsWith('{') || !literal.endsWith('}')) return null;
  const elements = parseArrayLiteral(literal.slice(1, -1));
  return elements === null || elements.length === 0 ? null : elements;
}

/**
 * The segments the elements of a path address, as {@link memberPathOf}
 * reads one out of a whole expression: an element that spells a whole
 * non-negative integer is an ARRAY INDEX, as it was on the way in, except
 * where `isName` says the guard of the path made it a name.
 * @param {string[]} elements
 * @param {(at: number) => boolean} isName
 * @returns {import('../dialect.js').JsonPathSegment[]}
 */
function segmentsOfElements(elements, isName) {
  return elements.map((element, at) => (!isName(at) && /^(?:0|[1-9][0-9]*)$/.test(element)
    ? { index: Number(element) }
    : { name: element }));
}

/**
 * The containers a guard in a CHECK names, as the guard's tokens spell them,
 * once parentheses and casts are set aside: `WHEN jsonb_typeof(doc #> '{a}')
 * = 'array' AND … THEN doc [ELSE NULL]`. Each conjunct names a parent
 * path (the elements of its array literal) and the container it must be.
 * @param {{ kind: string, value: string }[]} inner - the tokens between `CASE` and `END`
 * @param {string} column - the document column the CHECK reads
 * @returns {{ parent: string[], container: string }[] | null}
 */
function readGuard(inner, column) {
  /** @type {{ kind: string, value: string }[]} */
  const flat = [];
  for (let i = 0; i < inner.length; i++) {
    const token = inner[i];
    if (token.kind === 'symbol' && (token.value === '(' || token.value === ')')) continue;
    if (token.kind === 'symbol' && token.value === '::') {
      // a cast: `::text`, `::jsonb`, `::text[]`
      i++;
      if (inner[i + 1]?.value === '[' && inner[i + 2]?.value === ']') i += 2;
      continue;
    }
    flat.push(token);
  }
  let k = 0;
  const word = (/** @type {string} */ value) => {
    if (flat[k]?.kind !== 'word' || flat[k].value.toLowerCase() !== value) return false;
    k++;
    return true;
  };
  const symbol = (/** @type {string} */ value) => {
    if (flat[k]?.kind !== 'symbol' || flat[k].value !== value) return false;
    k++;
    return true;
  };
  const columnName = () => {
    const token = flat[k];
    if (token === undefined || (token.kind !== 'identifier' && token.kind !== 'word') || token.value !== column) return false;
    k++;
    return true;
  };
  if (!word('when')) return null;
  const guards = [];
  do {
    if (!word('jsonb_typeof') || !columnName()) return null;
    /** @type {string[]} */
    let parent = [];
    if (symbol('#')) {
      if (!symbol('>') || flat[k]?.kind !== 'string') return null;
      const elements = pathElementsOf(flat[k].value);
      if (elements === null) return null;
      parent = elements;
      k++;
    }
    if (!symbol('=') || flat[k]?.kind !== 'string') return null;
    guards.push({ parent, container: flat[k].value });
    k++;
  } while (word('and'));
  if (!word('then') || !columnName()) return null;
  if (word('else') && !word('null')) return null;
  return k === flat.length ? guards : null;
}

/**
 * How this dialect's interval CHECK reads back through the one interval
 * reader, for a session whose `standard_conforming_strings` is as given.
 * The server deparses `jsonb_typeof((doc #> '{span}'::text[]))` where the
 * dialect wrote `jsonb_typeof(("doc" #> '{"span"}'))` — bare lower-case
 * names, a cast on the array literal, the literal's quoting its own, a
 * type on every constant — and both read as one; a bound is an integer
 * by its column: present, and equal to its own truncation. A span path
 * that leaves a container open reads its member off the document under
 * the guard of {@link queryGuard}, `jsonb_typeof((CASE WHEN … THEN doc END)
 * #> '{span,0}')`, which reads back only as exactly the guard its own path
 * calls for; the unguarded form an earlier release wrote reads as well.
 * @param {boolean} conforming
 * @returns {import('./check-read.js').IntervalSpelling}
 */
function intervalSpelling(conforming) {
  return {
    ...(conforming ? POSTGRES_PREDICATE : POSTGRES_PREDICATE_ESCAPED),
    integers: 'column',
    typeOf: (tokens, at) => {
      const symbol = (/** @type {number} */ i, /** @type {string} */ value) => tokens[i]?.kind === 'symbol' && tokens[i].value === value;
      const wordAt = (/** @type {number} */ i, /** @type {string} */ value) => tokens[i]?.kind === 'word' && tokens[i].value.toLowerCase() === value;
      if (!wordAt(at, 'jsonb_typeof') || !symbol(at + 1, '(')) return undefined;
      let i = at + 2;
      let depth = 0;
      for (; symbol(i, '('); i++) depth++;
      /** @type {{ parent: string[], container: string }[] | null} */
      let guards = null;
      let column;
      if (wordAt(i, 'case')) {
        const end = tokens.findIndex((token, k) => k > i && token.kind === 'word' && token.value.toLowerCase() === 'end');
        if (end < 0) return undefined;
        const then = tokens.findIndex((token, k) => k > i && k < end && token.kind === 'word' && token.value.toLowerCase() === 'then');
        column = tokens[then + 1];
        if (then < 0 || column === undefined || (column.kind !== 'identifier' && column.kind !== 'word')) return undefined;
        guards = readGuard(tokens.slice(i + 1, end), column.value);
        if (guards === null) return undefined;
        i = end + 1;
        // the parentheses the server puts round the CASE
        if (depth > 0 && symbol(i, ')')) { depth--; i++; }
      }
      else {
        column = tokens[i];
        if (column === undefined || (column.kind !== 'identifier' && column.kind !== 'word')) return undefined;
        i++;
      }
      if (!symbol(i, '#') || !symbol(i + 1, '>') || tokens[i + 2]?.kind !== 'string') return undefined;
      const elements = pathElementsOf(tokens[i + 2].value);
      if (elements === null) return undefined;
      // a name an array would take for an index is the object step its guard says it is
      const segments = segmentsOfElements(elements, (p) => guards?.some((guard) => guard.parent.length === p && guard.container === 'object') === true);
      if (guards !== null) {
        // exactly the guard this path calls for: no conjunct more, fewer or other
        const wanted = guardSteps(segments);
        if (wanted === null || wanted.length !== guards.length
          || !wanted.every(({ parent, container }, k) => guards[k].container === container
            && JSON.stringify(guards[k].parent) === JSON.stringify(elements.slice(0, parent.length)))) return undefined;
      }
      i += 3;
      if (symbol(i, '::')) {
        if (tokens[i + 1]?.kind !== 'word' || tokens[i + 1].value.toLowerCase() !== 'text' || !symbol(i + 2, '[') || !symbol(i + 3, ']')) return undefined;
        i += 4;
      }
      for (; depth > 0; depth--, i++) if (!symbol(i, ')')) return undefined;
      if (!symbol(i, ')')) return undefined;
      return { column: column.value, segments, end: i + 1, guarded: guards !== null };
    },
  };
}

/** The numeric types a deparse casts a number constant to. */
const NUMBER_CAST = /^(?:\((.*)\)|(.*))::(?:smallint|integer|bigint|numeric|real|double precision)$/s;

/**
 * The digits of a number constant the server keeps cast — a negative one or
 * one past the 4-byte integers as quoted digits (`'-1'::integer`,
 * `'2147483648'::bigint`), one passed where a function takes another numeric
 * type cast again (`(5)::numeric`, `('2147483648'::bigint)::numeric`) — or
 * `null` for any other text.
 * @param {string} text
 * @returns {string | null}
 */
function castNumber(text) {
  let body = text.trim();
  let cast = false;
  for (let match = NUMBER_CAST.exec(body); match !== null; match = NUMBER_CAST.exec(body)) {
    body = (match[1] ?? match[2]).trim();
    cast = true;
  }
  const quoted = /^'(.*)'$/s.exec(body);
  const digits = quoted === null ? body : quoted[1];
  return cast && /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(digits) ? digits : null;
}

/**
 * The declared index EXPRESSION a generated column computes, out of the
 * SQL this dialect wrote for it. Here the engine calls its OWN
 * immutable function, so `byName` maps the host's `sql` name back to the
 * model's — a mapping only the host's declarations carry — each name read
 * as the server deparses it ({@link functionNameKey}: folded to lower case,
 * without the schema the store's search path finds it in). Given an entity
 * table's string `columns`, the expression is an entity index's key, whose
 * member is one of those columns as `textOperand` reads it
 * (`email COLLATE "default"` in the server's deparse). A number the server
 * does not keep as an unadorned constant — a negative one, one past the
 * 4-byte integers — comes back as its digits cast (`'-1'::integer`).
 * @param {string} expression
 * @param {Record<string, string>} byName
 * @param {readonly string[]} [columns]
 * @param {string} [schema] - the store's own schema, if it names one
 * @returns {any | null}
 */
function expressionOf(expression, byName, columns = undefined, schema = undefined) {
  /** @type {Map<string, string>} */
  const byKey = new Map();
  for (const [sql, name] of Object.entries(byName)) {
    const key = functionNameKey(sql, schema);
    if (!byKey.has(key)) byKey.set(key, name);
  }
  return readExpression(expression, {
    memberOf: columns !== undefined ? (text) => {
      const match = /^\s*(?:([a-z_][a-z0-9_$]*)|"((?:[^"]|"")+)")\s+COLLATE\s+"default"\s*$/.exec(text);
      const name = match === null ? null : match[1] ?? match[2].replace(/""/g, '"');
      return name !== null && columns.includes(name) ? { member: modelPath([{ name }]) } : null;
    } : (text) => {
      // a member read here is `doc #>> '{…}'` and nothing else: the
      // typed forms belong to a plain path index, not to an expression
      if (!/#>>/.test(text)) return null;
      const segments = memberPathOf(text);
      return segments === null ? null : { member: modelPath(segments) };
    },
    nameOf: (name) => (Object.hasOwn(byName, name) ? byName[name] : byKey.get(functionNameKey(name, schema)) ?? null),
    stringOf: (text) => (/^'(?:[^']|'')*'(?:::text)?$/.test(text)
      ? text.replace(/::text$/, '').slice(1, -1).replace(/''/g, "'") : null),
    numberOf: castNumber,
  });
}

/**
 * Build the dialect. A function rather than a constant because a host
 * may narrow it — today only the schema search path is worth naming,
 * and the default is the connection's own, which is what a disposable
 * per-run schema needs.
 * @param {{ searchPath?: string, notifyChannel?: string }} [options]
 * @returns {any}
 */
export function postgresDialect(options = undefined) {
  // the namespaces a catalog query looks in: the connection's own
  // search path unless the host names one, so a store opened against a
  // disposable schema introspects that schema and not `public`
  const namespaces = options?.searchPath === undefined
    ? 'ANY(current_schemas(false))'
    : stringLiteral(options.searchPath);
  const inNamespace = `n.nspname = ${namespaces}`;

  return createDialect({
    name: 'postgres',
    schema: options?.searchPath,
    physicalNamespaceRequired: true,
    relational: postgresRelational,
    migration: postgresMigration(),
    jobs: postgresJobs,
    // the owner lock (MODEL-FORMAT §5.1): no table — a session lock of its
    // own class, held for the store's session and released at close
    owner: Object.freeze({ kind: 'session', ...OWNER_LOCK }),
    // a read-modify-write locks the ROW it reads, never the store
    rowLockSuffix: ' FOR UPDATE',
    // a row only a non-key column of which changes, as SET NULL locks it
    rowNoKeyLockSuffix: ' FOR NO KEY UPDATE',
    replication: postgresReplication,
    // Ordinary writes still check after each statement. Logical replay alone
    // defers validation so canonical envelope order need not follow FK order.
    foreignKeyActions: { cascade: 'CASCADE', restrict: 'NO ACTION', setNull: 'SET NULL' },
    foreignKeySuffix: ' DEFERRABLE INITIALLY IMMEDIATE',
    // Existing immediate RESTRICT layouts retain their ordinary Store meaning.
    // Replication separately verifies that every enrolled FK can be deferred.
    comparableForeignKeyAction: (action) => action === 'RESTRICT' ? 'NO ACTION' : action,
    capture: postgresCapture(options?.notifyChannel === undefined ? undefined
      : `SELECT pg_catalog.pg_notify(${stringLiteral(options.notifyChannel)}, '')`),
    physicalRead: postgresPhysicalRead,
    physicalCompare: postgresPhysicalCompare,
    physicalValueType: postgresPhysicalValueType,
    physicalDifferent: postgresPhysicalDifferent,
    mutationRowGuard: (count, limit) => `CAST(CASE WHEN ${count} > ${limit} THEN 'jaren-mutation-row-bound' ELSE '1' END AS INTEGER) = 1`,
    boundMutation: (sql, limit) => `WITH "_jaren_result" AS (${sql}) SELECT * FROM "_jaren_result" LIMIT ${limit + 1}`,
    numberCast: (sql) => `CAST(${sql} AS DOUBLE PRECISION)`,
    // a number is held by the digits its writer spelled
    doubleRead: doubleOf,
    physicalTypeMatches: postgresPhysicalTypeMatches,
    qualifyPhysicalColumn: qualifyPostgresPhysicalColumn,
    invariantTriggers: (mapping, all, dialect) => postgresInvariantTriggers(mapping, all, dialect, IDENTIFIER_BYTES),
    rowPredicateFlavor: POSTGRES,
    // the server keeps no CREATE text, so the open reads each index condition
    // and generated column's expression back from its deparse and compares it
    // with the planned one; a layout index's condition as one condition
    // across the spellings the server keeps for it
    readBack: postgresReadBack(options?.searchPath),
    capabilities: {
      jsonb: true,
      generatedColumns: true,
      // STORED ones are; PostgreSQL 18's VIRTUAL ones are not, which is
      // why this dialect declares STORED and this capability true
      indexableGeneratedColumns: true,
      untypedColumns: false,
      returning: true,
      upsert: true,
      savepoints: true,
      // the store's writer lock, taken right after `BEGIN` (`tx.writerLock`):
      // a transaction-scoped advisory lock, so two immediate bodies run one
      // after the other and the second reads the first one's commit
      immediateTransactions: true,
      // a GROUP BY / ORDER BY term may name an output column
      groupByAlias: true,
      alterTableFull: true,
      virtualTables: false,
      triggers: false,
      pragmas: false,
      declaredSqlText: false,
      foreignKeysAlwaysOn: true,
      // through the declared `rid` column, not through `ctid`
      rowIdentity: true,
      // a declared index function is the host's IMMUTABLE one in the
      // database itself, which every connection calls
      catalogFunctions: true,
    },
    tableSuffix: '',
    // PostgreSQL has no indexable virtual generated column, so an
    // indexed path is materialised
    generatedStorage: 'STORED',
    // the identity every table this dialect creates carries. NOT
    // `GENERATED ALWAYS AS IDENTITY`: PostgreSQL allows one identity
    // column per table, and a collection with a database-allocated
    // integer key needs that slot for its key
    identityColumn: { name: 'rid', type: 'bigserial' },
    autoKeyType: 'bigserial',
    maxIdentifierBytes: IDENTIFIER_BYTES,
    ownRelationNames: (table, columns) => [`${table}_pkey`, ...columns.filter((column) => /serial$/i.test(column.type)).map((column) => `${table}_${column.name}_seq`)],
    epochFromRfc3339: (valueSql) =>
      `round(EXTRACT(EPOCH FROM (${valueSql})::timestamptz) * 1000)::bigint`,
    docColumnType: 'jsonb',
    // the packed little-endian binary32 form of a `derive: 'vector'`
    // column. Deliberately NOT `vector` from pgvector: a model may not
    // name a vendor type, and the k-nearest cut is the engine's
    packedVectorType: 'bytea',
    quoteIdentifier,
    parameterRef: (i) => `$${i}`,
    stringLiteral,
    booleanLiteral: (b) => (b ? 'TRUE' : 'FALSE'),
    typeFor,
    comparableColumnType,
    columnUsableFor,
    limitClause: (limit, offset) => (offset !== undefined && offset > 0
      ? `LIMIT ${limit === null ? 'ALL' : limit} OFFSET ${offset}`
      : `LIMIT ${limit === null ? 'ALL' : limit}`),
    jsonPathText,
    jsonExtract,
    queryGuard,
    // the two engine-specific pieces of a declared interval's CHECK: the
    // span member's JSON type by name (`jsonb_typeof` itself, where the
    // query layer's `jsonTypeOf` folds the server's names into the
    // engine's), and each bound held to an integer by its COLUMN — the
    // generated numeric column is NULL for every non-number (so a boolean,
    // a text, a half span fail `IS NOT NULL`) and holds a fraction, which
    // `trunc` tells apart
    jsonTypeName: (columnSql, pathText) => `jsonb_typeof(${jsonExtract(columnSql, pathText)})`,
    integerBounds: ({ start, end }) =>
      `${start.sql} IS NOT NULL AND ${end.sql} IS NOT NULL AND `
      + `${start.sql} = trunc(${start.sql}) AND ${end.sql} = trunc(${end.sql})`,
    intervalSpelling,
    // Concurrent first opens can both observe an absent relation before
    // either CREATE commits. Ordinary unique violations remain failures. A
    // rule program's function and trigger race as measured: the function on
    // `pg_proc`'s name index, the trigger as `CreateTriggerFiringOn`'s
    // duplicate — which is also how an already-committed trigger answers,
    // harmless where a trigger is created only with its own fresh table
    isCreateRace: (error) => error?.code === '42P07'
      || error?.code === '42710' && (error.routine === 'TypeCreate' || error.routine === 'CreateTriggerFiringOn')
      || error?.code === '23505'
      && (error.constraint === 'pg_type_typname_nsp_index' && error.table === 'pg_type'
        || error.constraint === 'pg_class_relname_nsp_index' && error.table === 'pg_class'
        || error.constraint === 'pg_proc_proname_args_nsp_index' && error.table === 'pg_proc'),
    // `undefined_function`: no function of the called name takes the arguments passed
    isUndefinedFunction: (error) => error?.code === '42883',
    // a DERIVED column's expression names a function the HOST supplies;
    // this dialect creates none and assumes none. Every driver this
    // package ships for PostgreSQL declares
    // `deterministicIndexableFunctions: false`, so the store computes
    // these values and writes them into ordinary columns — which is why
    // asking for the expression is a planner defect, exactly as it is
    // for a vector column on every driver
    derivedExpression: (memberSql, column) => {
      throw new TypeError(
        `postgres dialect: no generated-column expression for derive kind '${column.derive}' `
        + '— a derived column is STORED here, and the store writes its value');
    },
    jsonSet: (exprSql, pathText, valueSql) =>
      `jsonb_set(${exprSql}, ${stringLiteral(pathText)}, ${valueSql}, true)`,
    [MEMBER_WHEN]: (exprSql, memberName, valueSql, whenSql) =>
      `(${exprSql} || CASE WHEN ${whenSql} `
      + `THEN jsonb_build_object(${stringLiteral(memberName)}, ${valueSql}) ELSE '{}'::jsonb END)`,
    jsonRemove: (exprSql, pathText) =>
      `(${exprSql} #- ${stringLiteral(pathText)})`,
    // `-1` is the position AFTER the array's last element when
    // `insert_after` is true, which is the append this translates
    jsonAppend: (exprSql, arrayPathText, valueSql) =>
      `jsonb_insert(${exprSql}, ${stringLiteral(pathWith(arrayPathText, '-1'))}, ${valueSql}, true)`,
    jsonEncode: (paramSql) => `(${paramSql})::jsonb`,
    // `jsonb_set` takes a jsonb value: a number or a text column is not one
    // (`to_jsonb` of a numeric keeps its scale, of a text is the JSON string)
    jsonValue: (columnSql) => `to_jsonb(${columnSql})`,
    jsonText: (columnSql) => `(${columnSql})::text`,
    jsonEmbed: (columnSql) => `(${columnSql})`,
    // an integer past 2^53 crosses as its digits (with the scale a retype
    // left), both branches jsonb
    jsonInteger: (columnSql) => `CASE WHEN ${columnSql} NOT BETWEEN ${-Number.MAX_SAFE_INTEGER} `
      + `AND ${Number.MAX_SAFE_INTEGER} THEN jsonb_build_object('digits', (${columnSql})::text) `
      + `ELSE to_jsonb(${columnSql}) END`,
    jsonAgg: (exprSql) => `jsonb_agg(${exprSql})`,
    jsonObject: (pairsSql) => `jsonb_build_object(${pairsSql})`,
    jsonTypeOf: (columnSql, pathText) =>
      typeOfJsonb(`(${columnSql} #> ${stringLiteral(pathText)})`),
    // one JSON number type, so one name
    numericTypeNames: ['number'],
    // every typed form `jsonExtract` writes is a CASE whose NULL already
    // means "absent, null or another JSON type" — the generated column
    // holds the same CASE — so a literal comparison reads it alone, and
    // the planner's selectivity estimate sees a column, not a CASE over
    // three calls it cannot price
    typedExtract: true,
    // the planner prices every leaf per row, and a chain long enough to
    // cross the JIT thresholds is compiled by LLVM, which checks for no
    // interrupt: neither a cancel nor a statement timeout reaches the
    // backend until the compile ends. The compile grows with the count and
    // with the kind of leaf, so the planner counts terms, not leaves: the
    // kinds that compile slowest, an inequality or a negation against an
    // external operand and a membership in an external list, weigh several
    // (predicateTerms), and a longer or heavier chain is the engine's
    maxPredicateTerms: 128,
    // An external's value is bound as its JSON TEXT. A PostgreSQL
    // parameter's type is resolved where it is used, once, for the
    // whole statement — so one placeholder cannot be a text member's
    // operand in one branch and a numeric member's in another, and the
    // guard that keeps a row out of the wrong branch does not keep the
    // COERCION out. Bound as JSON, both branches compare in a space
    // that holds every scalar: text against text under `C`, and number
    // against number in `jsonb`'s own numeric order.
    externalEncoding: 'json',
    // a JSON number is a `numeric` here, held by the decimal digits the
    // writer spelled, so a number compares with the interval of decimals
    // that round to the double it is compared with: an external's, a
    // literal's, a list item's
    decimalDigits: true,
    externalCompare: (valueSql, kind) =>
      (kind === 'number' ? `to_jsonb(${valueSql})` : valueSql),
    externalRef: (paramSql, kind) => (kind === 'text'
      ? `((((${paramSql})::jsonb) #>> '{}') COLLATE "C")`
      : `((${paramSql})::jsonb)`),
    valueTypeOf: (paramSql) => typeOfJsonb(`((${paramSql})::jsonb)`),
    // Membership in a JSON list bound as ONE parameter (its JSON text, as
    // every external here): an array's elements or an object's member
    // values, of one kind — text byte-ordered like every text comparison,
    // a number as the `numeric` a number member reads as and a number
    // column is declared as, so the comparison casts neither side and the
    // column's index seeks. An adopted integer column compares cast to
    // `numeric`, which its own index does not serve. A `double` is a member
    // read as the double the engine holds (`doubleRead`) against the
    // doubles the list's numbers are: a decimal is in the interval of
    // decimals that round to a double exactly where it reads as that double
    inList: (valueSql, listSql, kind) => {
      const list = `((${listSql})::jsonb)`;
      const items = `(SELECT jsonb_array_elements(${list}) WHERE jsonb_typeof(${list}) = 'array' UNION ALL `
        + `SELECT m.value FROM jsonb_each(CASE WHEN jsonb_typeof(${list}) = 'object' THEN ${list} `
        + "ELSE '{}'::jsonb END) AS m)";
      return kind === 'text'
        ? `${valueSql} IN (SELECT (i.e #>> '{}') COLLATE "C" FROM ${items} AS i(e) WHERE jsonb_typeof(i.e) = 'string')`
        : `${valueSql} IN (SELECT (i.e #>> '{}')::${kind === 'double' ? 'float8' : 'numeric'} FROM ${items} AS i(e) `
          + "WHERE jsonb_typeof(i.e) = 'number')";
    },
    // Membership of a column in the intervals of decimals that round to a
    // list's doubles, bound as one JSON array of edge tuples: the column's
    // values that lie in some interval, found through the column's own
    // index (one range seek a tuple), then the column among them, which
    // seeks or hashes as a membership in an exact list does. The array
    // hides how many values the inner read finds from the planner, which
    // otherwise prices the range join as a large one and scans the outer
    // table
    intervalIn: (valueSql, tuplesSql, tableSql, columnSql, within) => {
      const inner = `"interval_row".${columnSql}`;
      const edge = (/** @type {number} */ index) => `("interval_edge".e ->> ${index})::numeric`;
      return `${valueSql} IN (SELECT unnest(ARRAY(SELECT DISTINCT ${inner} FROM `
        + `jsonb_array_elements((${tuplesSql})::jsonb) AS "interval_edge"(e) JOIN ${tableSql} AS "interval_row" `
        + `ON ${within(inner, edge)})))`;
    },
    // the half-open range over the prefix, seekable through a B-tree on
    // a `C`-collated column. Both operands are byte-ordered — the column
    // by its declaration, the extracted member by the `COLLATE` in
    // `jsonExtract` — which is what makes the range hold exactly the
    // values that begin with the prefix
    strStartsWith: (valueSql, lowerParamSql, upperParamSql) =>
      `(${valueSql} >= ${lowerParamSql} AND ${valueSql} < ${upperParamSql})`,
    strStartsWithExact: (valueSql, patternA, patternB) =>
      `substr(${valueSql}, 1, length(${patternA}::text)) = ${patternB}`,
    strEndsWith: (valueSql, patternA, patternB, patternC) =>
      `(length(${patternA}::text) = 0 OR right(${valueSql}, length(${patternB}::text)) = ${patternC})`,
    strContains: (valueSql, patternSql) => `strpos(${valueSql}, ${patternSql}::text) > 0`,
    orderNulls: (nullsFirst) => (nullsFirst ? ' NULLS FIRST' : ' NULLS LAST'),
    // the same fixed ladder, in exact arithmetic: `%` truncates towards
    // zero here as it does in C, so `((x % m) + m) % m` is the
    // non-negative remainder and an instant before 1970 lands in its own
    // bucket rather than the one after it
    timeBucket: (instantSql, originSql, everyA, everyB, everyC) =>
      `(${instantSql} - (((${instantSql} - ${originSql}) % ${everyA} + ${everyB}) % ${everyC}))`,
    groupAggregate: (fn, valueSql) => (valueSql === null
      ? 'COUNT(*)'
      : `${{ sum: 'SUM', avg: 'AVG', min: 'MIN', max: 'MAX' }[fn]}(${valueSql})`),
    rowIdentity: () => '"rid"',
    identityIn: (identitySql, paramSqls) => `${identitySql} IN (${paramSqls.join(', ')})`,
    schemaTypeOf,
    memberPathOf,
    memberGuarded,
    expressionOf: (expression, byName, columns) => expressionOf(expression, byName, columns, options?.searchPath),
    // an entity column as an index expression's member: its text under the
    // database's default collation, the very value and collation a
    // collection's expression reads out of the document (`#>>`), so one
    // declared function answers alike over both
    textOperand: (columnSql) => `(${columnSql} COLLATE "default")`,
    // the catalog already answers one row per generated column
    readChecks: postgresChecks,
    readGenerated: (rows) => rows.map((row) => ({
      name: String(row.name), expression: String(row.expression ?? ''),
    })),
    explainQuery: (sql) => `EXPLAIN ${sql}`,
    // PostgreSQL's plan is prose too, under a column whose name has a
    // space in it
    explainLines: (rows) => rows.map((row) => String(row['QUERY PLAN'] ?? row.plan ?? '')),
    isFullScan: (line, tables) => {
      const match = /\bSeq Scan on (?:\w+\.)?"?([^\s"]+)"?/.exec(line);
      if (match === null) return false;
      // a join statement aliases its tables `t0`, `t1`, … and a hop the
      // related entity it reads `h0`, `h1`, …, and the plan names the
      // relation with the alias after it
      return tables.includes(match[1]) || /\bSeq Scan on \S+ [th]\d+\b/.test(line);
    },
    usesIndex: (line, index) =>
      line.includes(`Index Scan using ${index}`)
      || line.includes(`Index Only Scan using ${index}`)
      || line.includes(`Bitmap Index Scan on ${index}`),
    // the planner's own row estimate: one row whose `QUERY PLAN` is the
    // plan as JSON (text once the driver has normalized the json column),
    // the top node's `Plan Rows` being the number. A plan that does not
    // read that way is no estimate rather than a guessed one
    explainEstimate: (sql) => `EXPLAIN (FORMAT JSON) ${sql}`,
    readEstimate: (rows) => {
      try {
        const plan = rows[0]?.['QUERY PLAN'];
        const count = (typeof plan === 'string' ? JSON.parse(plan) : plan)?.[0]?.Plan?.['Plan Rows'];
        return Number.isFinite(count) && count >= 0 ? { rows: count, source: 'postgresql-planner' } : null;
      }
      catch {
        return null;
      }
    },
    excludedRef: (columnSql) => `excluded.${columnSql}`,
    tx: {
      begin: 'BEGIN',
      // no BEGIN takes a write lock here: the store's `mode: 'immediate'`
      // is `BEGIN` followed by `writerLock`, while the engine's own
      // up-front brackets (the open path's shape work) need no lock at
      // all — PostgreSQL has no read→write upgrade to be busy on
      beginImmediate: 'BEGIN',
      // The writer lock: waited for under the session's `lock_timeout`
      // (55P03, busy and retryable), held until COMMIT or ROLLBACK. At
      // `read committed` every statement reads a fresh snapshot, so the
      // body that waited reads the commit it waited for; at `repeatable
      // read` and `serializable` the snapshot is taken by this very
      // statement — before the wait — and the same conflict surfaces as
      // 40001, busy and retryable.
      writerLock: transactionLock(POSTGRES_LOCK_CLASSES.writer),
      // the levels a transaction can run, weakest first; `read
      // uncommitted` runs as `read committed` and is not offered
      isolationLevels: Object.freeze(['read committed', 'repeatable read', 'serializable']),
      beginAt: (level) => `BEGIN ISOLATION LEVEL ${level.toUpperCase()}`,
      commit: 'COMMIT',
      rollback: 'ROLLBACK',
      deferForeignKeys: 'SET CONSTRAINTS ALL DEFERRED',
      savepoint: (n) => `SAVEPOINT ${quoteIdentifier(n)}`,
      release: (n) => `RELEASE SAVEPOINT ${quoteIdentifier(n)}`,
      rollbackTo: (n) => `ROLLBACK TO SAVEPOINT ${quoteIdentifier(n)}`,
    },
    introspect: {
      catalog: () => postgresCatalog(inNamespace),
      version: () => "SELECT current_setting('server_version') AS version",
      // the table probe binds its name, so a hostile collection name is
      // a value and never syntax. It answers the name the catalog gives
      // the table's primary-key constraint too (`key`): a duplicate key is
      // the violation of that constraint, whatever the server called it
      // (a renamed table keeps the name its key was created under)
      tableExists: () =>
        'SELECT c.relname AS name, (SELECT k.conname FROM pg_constraint k '
        + `WHERE k.conrelid = c.oid AND k.contype = 'p') AS "key" FROM pg_class c `
        + 'JOIN pg_namespace n ON n.oid = c.relnamespace '
        + `WHERE c.relkind IN ('r', 'p') AND ${inNamespace} AND c.relname = $1`,
      // `hidden` is non-zero for a GENERATED column, which is the one
      // fact the shape check reads beside the name and the type
      columns: (table) =>
        'SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, '
        + "CASE WHEN a.attgenerated <> '' THEN 1 ELSE 0 END AS hidden, "
        + 'CASE WHEN a.attnotnull THEN 1 ELSE 0 END AS not_null, '
        + 'pg_get_expr(d.adbin, d.adrelid) AS default_value, n.nspname AS schema, '
        + "CASE a.attidentity WHEN 'a' THEN 'always' WHEN 'd' THEN 'by-default' ELSE '' END AS identity, "
        + 'a.attgenerated AS generated_kind, ty.typtype AS type_kind, tn.nspname AS type_schema, ty.typname AS type_name, '
        + `co.collname AS collation, ${CONFORMING} AS conforming `
        + 'FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid '
        + 'JOIN pg_type ty ON ty.oid = a.atttypid JOIN pg_namespace tn ON tn.oid = ty.typnamespace '
        + 'LEFT JOIN pg_collation co ON co.oid = a.attcollation '
        + 'LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum '
        + 'JOIN pg_namespace n ON n.oid = c.relnamespace '
        + `WHERE c.relname = ${stringLiteral(table)} AND ${inNamespace} `
        + 'AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum',
      // `origin` mirrors the vocabulary the shape check filters on:
      // only an index the model DECLARED is compared, and the primary
      // key's is the engine's own; `predicate` is a partial index's
      // condition as the server deparses it
      indexes: (table) =>
        'SELECT ci.relname AS name, CASE WHEN i.indisunique THEN 1 ELSE 0 END AS uniq, '
        + "CASE WHEN i.indisprimary THEN 'pk' ELSE 'c' END AS origin, "
        + 'CASE WHEN i.indpred IS NULL THEN 0 ELSE 1 END AS partial, '
        + 'pg_get_expr(i.indpred, i.indrelid) AS predicate, '
        + `${CONFORMING} AS conforming, `
        // a plain index: ascending B-tree keys under their columns' own
        // collations and their types' default operator classes, every column
        // a key (an INCLUDE column is carried, not keyed), nulls distinct,
        // checked at once — what the plan creates
        + "CASE WHEN am.amname = 'btree' AND NOT i.indnullsnotdistinct AND i.indimmediate AND i.indnkeyatts = i.indnatts "
        + 'AND NOT EXISTS (SELECT 1 FROM unnest(i.indoption::int2[]) AS o(flags) WHERE o.flags <> 0) '
        + 'AND NOT EXISTS (SELECT 1 FROM unnest(i.indclass::oid[]) AS c(opclass) '
        + 'JOIN pg_opclass oc ON oc.oid = c.opclass WHERE NOT oc.opcdefault) '
        + 'AND NOT EXISTS (SELECT 1 FROM unnest(i.indcollation::oid[], i.indkey::int2[]) AS k(coll, attnum) '
        + 'JOIN pg_attribute ka ON ka.attrelid = i.indrelid AND ka.attnum = k.attnum WHERE k.coll <> ka.attcollation) '
        + 'THEN 1 ELSE 0 END AS plain '
        + 'FROM pg_index i JOIN pg_class ci ON ci.oid = i.indexrelid JOIN pg_am am ON am.oid = ci.relam '
        + 'JOIN pg_class ct ON ct.oid = i.indrelid '
        + 'JOIN pg_namespace n ON n.oid = ct.relnamespace '
        + `WHERE ct.relname = ${stringLiteral(table)} AND ${inNamespace} `
        + 'ORDER BY ci.relname',
      // in the index's OWN column order: `(a, b)` and `(b, a)` are
      // different indexes, and only one of them serves an `a` prefix
      indexColumns: (index) =>
        'SELECT a.attname AS name FROM pg_index i '
        + 'JOIN pg_class ci ON ci.oid = i.indexrelid '
        + 'JOIN pg_namespace n ON n.oid = ci.relnamespace '
        + 'CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord) '
        + 'LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum '
        + `WHERE ci.relname = ${stringLiteral(index)} AND ${inNamespace} ORDER BY k.ord`,
      // the columns the index KEYS, apart from any it carries beside them
      // (`INCLUDE`): what a unique index proves unique, in its own order —
      // each key's column, `NULL` for an expression, and the key as the
      // server deparses it (`term`), which the open reads an expression from,
      // and whether its collation is deterministic (`NULL` for a key of a
      // type without one), which that deparse does not spell
      indexKeyColumns: (index) =>
        'SELECT a.attname AS name, pg_get_indexdef(i.indexrelid, k.ord::int, false) AS term, '
        + '(SELECT co.collisdeterministic FROM pg_collation co WHERE co.oid = i.indcollation[(k.ord - 1)::int]) AS deterministic FROM pg_index i '
        + 'JOIN pg_class ci ON ci.oid = i.indexrelid '
        + 'JOIN pg_namespace n ON n.oid = ci.relnamespace '
        + 'CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord) '
        + 'LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum '
        + `WHERE ci.relname = ${stringLiteral(index)} AND ${inNamespace} AND k.ord <= i.indnkeyatts ORDER BY k.ord`,
      // every table this store might own; a view is reported rather
      // than derived, and the engine's own schemas are never in scope
      tables: () =>
        "SELECT c.relname AS name, CASE WHEN c.relkind IN ('v', 'm') THEN 'view' "
        + "ELSE 'table' END AS type FROM pg_class c "
        + 'JOIN pg_namespace n ON n.oid = c.relnamespace '
        + `WHERE c.relkind IN ('r', 'p', 'v', 'm') AND ${inNamespace} `
        + 'ORDER BY type, c.relname',
      // an installed rule program as the fields that decide what it does:
      // the trigger's timing, events, level and columns from `tgtype` and
      // `tgattr`, and its function's language, settings and verbatim source;
      // every trigger of one table where a table is named — and every
      // rewrite rule on it (a `kind: 'rule'` row with no program), which
      // changes what a write does as a trigger does; a view's own `_RETURN`
      // rule is the view itself
      invariantPrograms: (/** @type {string | undefined} */ table) =>
        "SELECT t.tgname AS name, c.relname AS owner, 'trigger' AS kind, pg_catalog.jsonb_build_object("
        + "'timing', CASE WHEN t.tgtype::integer & 2 <> 0 THEN 'BEFORE' WHEN t.tgtype::integer & 64 <> 0 THEN 'INSTEAD OF' ELSE 'AFTER' END, "
        + "'events', (SELECT pg_catalog.jsonb_agg(e.event ORDER BY e.ord) FROM (VALUES (1, 'INSERT', 4), (2, 'UPDATE', 16), "
        + "(3, 'DELETE', 8), (4, 'TRUNCATE', 32)) e(ord, event, bit) WHERE t.tgtype::integer & e.bit <> 0), "
        + "'level', CASE WHEN t.tgtype::integer & 1 <> 0 THEN 'ROW' ELSE 'STATEMENT' END, "
        + "'columns', COALESCE((SELECT pg_catalog.jsonb_agg(a.attname ORDER BY k.ord) FROM unnest(t.tgattr::smallint[]) WITH ORDINALITY k(num, ord) "
        + "JOIN pg_catalog.pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = k.num), '[]'::jsonb), "
        + "'condition', t.tgqual IS NOT NULL, 'enabled', t.tgenabled::text, 'deferrable', t.tgdeferrable, 'deferred', t.tginitdeferred, "
        + "'function', pg_catalog.jsonb_build_object('schema', pn.nspname, 'name', p.proname, 'language', l.lanname, "
        + "'returns', pg_catalog.format_type(p.prorettype, NULL), 'arguments', pg_catalog.pg_get_function_identity_arguments(p.oid), "
        + "'volatility', p.provolatile, 'securityDefiner', p.prosecdef, 'config', p.proconfig, 'source', p.prosrc))::text AS program "
        + 'FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid '
        + 'JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid '
        + 'JOIN pg_catalog.pg_namespace pn ON pn.oid = p.pronamespace JOIN pg_catalog.pg_language l ON l.oid = p.prolang '
        + `WHERE NOT t.tgisinternal AND ${inNamespace}${table === undefined ? '' : ` AND c.relname = ${stringLiteral(table)}`} `
        + "UNION ALL SELECT r.rulename, c.relname, 'rule', NULL "
        + 'FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid = r.ev_class '
        + 'JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace '
        + `WHERE r.rulename <> '_RETURN' AND ${inNamespace}${table === undefined ? '' : ` AND c.relname = ${stringLiteral(table)}`} `
        + 'ORDER BY owner, kind, name',
      objects: () =>
        "SELECT 'trigger' AS type, t.tgname AS name, c.relname AS owner, "
        + 'pg_get_triggerdef(t.oid) AS sql FROM pg_trigger t '
        + 'JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace '
        + `WHERE NOT t.tgisinternal AND ${inNamespace} UNION ALL `
        + "SELECT 'index', ci.relname, c.relname, pg_get_indexdef(i.indexrelid) "
        + 'FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid '
        + 'JOIN pg_class ci ON ci.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace '
        + `WHERE ${inNamespace} ORDER BY type, name`,
      generated: (table) =>
        'SELECT a.attname AS name, pg_get_expr(d.adbin, d.adrelid) AS expression '
        + 'FROM pg_attrdef d '
        + 'JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum '
        + 'JOIN pg_class c ON c.oid = d.adrelid '
        + 'JOIN pg_namespace n ON n.oid = c.relnamespace '
        + `WHERE c.relname = ${stringLiteral(table)} AND ${inNamespace} `
        + "AND a.attgenerated <> '' ORDER BY a.attnum",
      checks: (table) =>
        'SELECT c.conname AS name, pg_get_expr(c.conbin, c.conrelid) AS expression, '
        // a CHECK added NOT VALID holds nothing for the rows already there
        + 'CASE WHEN c.convalidated THEN 1 ELSE 0 END AS validated, '
        + `${CONFORMING} AS conforming, `
        + 'EXISTS (SELECT 1 FROM pg_attribute ca JOIN pg_collation co ON co.oid = ca.attcollation '
        + 'WHERE ca.attrelid = c.conrelid AND ca.attnum = ANY(c.conkey) '
        + 'AND NOT co.collisdeterministic) AS unsafe_collation '
        + 'FROM pg_constraint c JOIN pg_class ct ON ct.oid = c.conrelid '
        + 'JOIN pg_namespace n ON n.oid = ct.relnamespace '
        + `WHERE c.contype = 'c' AND ct.relname = ${stringLiteral(table)} AND ${inNamespace} `
        + 'ORDER BY c.conname',
      foreignKeyList: (table) => {
        const action = (column) => `CASE ${column} `
          + "WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' "
          + "WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' ELSE 'NO ACTION' END";
        return 'SELECT tt.relname AS target, sa.attname AS source_column, '
          + `ta.attname AS target_column, ${action('c.confdeltype')} AS on_delete, `
          + `${action('c.confupdtype')} AS on_update, c.conname AS id, k.ord - 1 AS seq `
          + 'FROM pg_constraint c JOIN pg_class ct ON ct.oid = c.conrelid '
          + 'JOIN pg_namespace n ON n.oid = ct.relnamespace '
          + 'JOIN pg_class tt ON tt.oid = c.confrelid '
          + 'CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(src, tgt, ord) '
          + 'JOIN pg_attribute sa ON sa.attrelid = c.conrelid AND sa.attnum = k.src '
          + 'JOIN pg_attribute ta ON ta.attrelid = c.confrelid AND ta.attnum = k.tgt '
          + `WHERE c.contype = 'f' AND ct.relname = ${stringLiteral(table)} AND ${inNamespace} `
          + 'ORDER BY c.conname, k.ord';
      },
    },
  });
}
