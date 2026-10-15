//@ts-check
/** The row-predicate lowering: a bounded query expression over the mapped
 * columns of one row, as SQL that answers as the query engine does over the
 * row as stored — except where `releasedText` keeps the spelling installed
 * programs were planned with, in which two JSON nulls of columns of different
 * types compare unequal. A column's `null` policy says what its SQL NULL is: a
 * JSON null (`null`: equality stays null-safe), an absent member (`absent`:
 * every comparison with it is false and a `null` literal against it refuses),
 * or nothing a row holds (`reject`). A literal is a scalar the query language
 * reads as written: `$$` escapes a leading `$`, `$const` quotes one level, and
 * SQL text cannot carry U+0000. Two renderings share it. A rule's trigger
 * check (`trigger`) reads each column through its codec, collects that
 * codec's domain and keeps every leaf two-valued; an index condition
 * (`predicate`) reads plain columns and leaves a leaf plain wherever SQL NULL
 * already reads as false, so its caller reads only text columns that compare
 * by code point (SQLite BINARY, PostgreSQL COLLATE "C") and keeps a list
 * short enough for a PostgreSQL index predicate, which `pg_index` stores
 * inline. An index condition has one spelling per meaning, so a condition read
 * back out of the catalog renders as it was written: a nested `$and` (`$or`)
 * joins the one it sits in, a single operand is itself, a one-item list is an
 * equality, a lone presence test is bare, and a boolean is the stored value
 * (`storedBoolean`). A trigger check's operand may be a sum, a difference or a
 * negation of integer columns and safe-integer literals, computed by the engine
 * over integers it holds exactly: each result is held to the safe range by a
 * domain of its own, and a missing operand leaves it without a value. The
 * caller supplies the dialect's flavor (how a column is read, a comparison, a
 * truth value, a text literal and an integer operand spelled) and the
 * resolver of the paths it reads, and wraps every refusal reason in its own
 * error. */
import { RULE_CODECS, SAFE_INTEGER, isArithmetic, recordPath, ruleLiteral } from '../invariants.js';
import { memberNames } from '../model-path.js';

/** The safe-integer range as a SQL condition over a reference, the one
 * spelling a column's domain and an arithmetic result's share on both engines.
 * @param {string} ref @returns {string} */
export const safeRange = (ref) => `${ref} BETWEEN -${SAFE_INTEGER} AND ${SAFE_INTEGER}`;

/**
 * How a store-owned layout and a collection's generated column hold a boolean
 * on every engine: the integer 1 or 0 (a PostgreSQL one is `smallint`, never
 * `boolean`). An index condition compares a boolean member with it and an enum
 * CHECK lists it; the dialect's own boolean literal stays the SQL truth value.
 * @param {boolean} value @returns {string}
 */
export const storedBoolean = (value) => (value ? '1' : '0');

/**
 * What a resolver answers for a `$` path: a column of the row (`ref` reads it
 * in SQL; `unavailable` when its record does not exist for the operation), a
 * text the caller knows (a rule's operation), or a refusal and its reason
 * (whose `column`, if any, only types the value).
 * @typedef {{ name?: string, column?: any, ref?: string, unavailable?: boolean, text?: string, refused?: string }} PathRead
 * @typedef {(path: string) => PathRead} PathResolver
 */

/** Whether a path's member names are the one name `op`. @param {string[] | null} names */
const isOp = (names) => names?.length === 1 && names[0] === 'op';

/**
 * A rule's paths for one operation: `$.old.<member>` and `$.new.<member>` read
 * a column of the old or the new row (a member of any name also written
 * `$.new['<member>']`), and `$.op` is the operation's name.
 * @param {any[]} columns the layout's mapped columns @param {string} op
 * @param {(name: string) => string} q the dialect's identifier quoting
 * @returns {PathResolver}
 */
export function rulePaths(columns, op, q) {
  return (path) => {
    if (isOp(memberNames(path))) return { text: op };
    const read = recordPath(path);
    // an audit value is typed before it is read: a path no rule reads types
    // as the column named after its second dot, so the refusal names the type
    // or the path as a rule's plan always has
    if (read === null) return { refused: `unsupported record path '${path}'; a text that starts with $ is written $$`,
      column: columns.find((c) => c.name === path.slice(path.indexOf('.', 2) + 1)) };
    const { record, name } = read;
    const column = columns.find((c) => c.name === name);
    return { name, column, ref: column === undefined ? undefined : `${record.toUpperCase()}.${q(column.physical)}`,
      unavailable: (op === 'insert' && record === 'old') || (op === 'delete' && record === 'new') };
  };
}

/**
 * An index condition's paths: `$.<member>` reads a column of the row itself
 * (a member of any name also written `$['<member>']`); a rule's operation and
 * its old and new records do not exist there, though a member named `op`,
 * `old` or `new` does.
 * @param {any[]} columns the mapped columns @param {(name: string) => string} q the dialect's identifier quoting
 * @returns {PathResolver}
 */
export function rowPaths(columns, q) {
  return (path) => {
    const names = memberNames(path);
    const column = names?.length === 1 ? columns.find((c) => c.name === names[0]) : undefined;
    if (isOp(names) && column === undefined)
      return { refused: `'${path}' is a rule's operation; an index condition reads $.<member> or $['<member>']` };
    if (/^\$\.(old|new)\./.test(path) || (names !== null && names.length > 1 && (names[0] === 'old' || names[0] === 'new')))
      return { refused: `'${path}' reads a rule's record; an index condition reads $.<member> or $['<member>']` };
    if (names?.length !== 1)
      return { refused: `unsupported path '${path}'; an index condition reads $.<member> or $['<member>'], and a text that starts with $ is written $$` };
    return { name: names[0], column, ref: column === undefined ? undefined : q(column.physical) };
  };
}

/** Whether a value is a path: the query language reads a string that starts
 * with `$` as an expression, and `$$` escapes a literal `$`. @param {any} value */
const isPath = (value) => typeof value === 'string' && value.startsWith('$') && !value.startsWith('$$');

/** Whether an operand is a list, `{ "$seq": [...] }`. @param {any} value */
const isSeq = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, '$seq');

/** The JSON type a column of a rule codec holds. @param {string | undefined} codec */
const codecType = (codec) => (codec === 'boolean' ? 'boolean' : codec === 'integer' || codec === 'number' ? 'number' : 'string');

/** Whether a column holds a literal: its codec's JSON type, a safe integer in
 * an integer column, and in a number column a finite number that is not an
 * unsafe integer. A date or datetime literal compares as its text, as the
 * column reads. @param {any} column @param {any} literal */
const holds = (column, literal) => typeof literal === codecType(column.codec)
  && (typeof literal !== 'number' || (Number.isInteger(literal) ? Number.isSafeInteger(literal) : column.codec === 'number' && Number.isFinite(literal)));

/** The scalar a literal operand stands for, as the query language reads it: a
 * leading `$$` escapes `$`, and `$const` quotes one level as written, so a
 * quoted object or list (a nested `$const` included) stands for no scalar.
 * `undefined` when there is none. @param {any} value @returns {any} */
const literalOf = (value) => {
  if (typeof value === 'string') return isPath(value) ? undefined : ruleLiteral(value);
  const quoted = value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1
    && Object.hasOwn(value, '$const') ? value.$const : value;
  return quoted === null || ['string', 'number', 'boolean'].includes(typeof quoted) ? quoted : undefined;
};

/** The logical key (`$and`, `$or`) a node is, if it is one. @param {any} node */
const logicalKey = (node) => (node !== null && typeof node === 'object' && !Array.isArray(node) && Object.keys(node).length === 1
  ? ['$and', '$or'].find((key) => Object.hasOwn(node, key) && Array.isArray(node[key])) : undefined);

/** A node, or the one operand of a logical node that has only one, however
 * deep. @param {any} node @returns {any} */
const alone = (node) => {
  for (let key = logicalKey(node); key !== undefined && node[key].length === 1; key = logicalKey(node)) node = node[key][0];
  return node;
};

/** The operands of an `$and` (`$or`), each a lone operand in place of its
 * wrapper and every non-empty one of the same kind joined in.
 * @param {string} key @param {any[]} args @returns {any[]} */
const joined = (key, args) => args.flatMap((arg) => {
  const operand = alone(arg);
  return logicalKey(operand) === key && operand[key].length > 0 ? joined(key, operand[key]) : [operand];
});

/** A literal as a refusal names it. @param {any} literal */
const shown = (literal) => (typeof literal === 'number' && !Number.isFinite(literal) ? String(literal) : JSON.stringify(literal));

/** The comparison operators, as an index condition spells them plainly. */
const OPERATORS = { $eq: '=', $ne: '<>', $lt: '<', $le: '<=', $gt: '>', $ge: '>=' };

/** @param {string | undefined} name */
const neverNull = (name) => `'${name}' reads SQL NULL as an absent member, so it never holds null: test its presence with $exists`;
const SEQ_ITEMS = 'a $seq lists scalar literals; a text that starts with $ is written $$';
const SCALARS = 'only scalar literals and old/new property paths can be lowered';
/** The engine's other arithmetic, whose rounding and division the two engines
 * and the engine's doubles do not share: named in its refusal. */
const UNLOWERED_ARITHMETIC = ['$mul', '$div', '$idiv', '$mod'];

/**
 * One lowering: the functions that lower, and the domain checks its column
 * reads collect in the order they are read (an index condition collects none).
 * @param {{ rendering?: 'trigger' | 'predicate', releasedText?: boolean, flavor: any, dialect: any, resolve: PathResolver,
 *   fail: (reason: string) => never, probe?: (args: any, value: (expression: any) => string) => string }} context -
 *   `flavor` spells `true`, `false`, the null-safe `equal` and `different`, reads a column (`column(column, ref)` →
 *   `{ value, domain }`) and may spell a text literal (`text(value, plain)`, `plain` the dialect's own) and an integer
 *   column as an arithmetic operand (`integer(column, ref)`); `probe` lowers an `$exists-row`, its match values rendered
 *   by `value`, and without it a probe refuses; `releasedText` keeps the text installed programs were planned with,
 *   which compares two columns of different JSON types by type alone, so two JSON nulls there are unequal (installed
 *   programs are verified by their text)
 * @returns {{ predicate: (node: any) => string, scalar: (value: any, raw?: boolean) => string,
 *   typeOf: (value: any) => string, domains: Set<string> }}
 */
export function rowPredicate({ rendering = 'trigger', releasedText = false, flavor, dialect, resolve, fail, probe }) {
  const sl = dialect.stringLiteral;
  const trigger = rendering === 'trigger';
  /** A text literal: SQL text cannot carry U+0000, and a flavor may spell a
   * literal its own way. @param {string} value @returns {string} */
  const text = (value) => {
    if (value.includes('\u0000')) return fail(`text literal ${JSON.stringify(value)} holds U+0000, which SQL text cannot carry`);
    return flavor.text === undefined ? sl(value) : flavor.text(value, sl);
  };
  /** @type {Set<string>} */
  const domains = new Set();
  // `raw` reads a column as its stored value, for a probe's own comparison;
  // only a predicate's own operand (`operand`) reads an absent column. Every
  // other expression is refused rather than compared as its text
  /** @param {any} value @param {boolean} [raw] @param {boolean} [operand] @returns {string} */
  const scalar = (value, raw = false, operand = false) => {
    if (isArithmetic(value)) return operand ? arithmetic(value) : fail(SCALARS);
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1
      && UNLOWERED_ARITHMETIC.includes(Object.keys(value)[0]))
      return fail(`'${Object.keys(value)[0]}' is not lowered: a rule's arithmetic is $add, $sub and $neg over integers`);
    if (isPath(value)) {
      const path = resolve(value);
      if (path.refused !== undefined) return fail(path.refused);
      if (path.text !== undefined) return text(path.text);
      const { column, name } = path;
      if (!column || (column.null === 'absent' && !operand) || !RULE_CODECS.includes(column.codec)) return fail(`'${name}' needs a scalar column codec`);
      if (path.unavailable) return fail('a property of an unavailable record is absent, not SQL NULL');
      const ref = /** @type {string} */ (path.ref);
      if (!trigger) return ref;
      const read = flavor.column(column, ref);
      if (read.domain !== null) domains.add(read.domain);
      return raw ? ref : read.value;
    }
    if (value === null) return 'NULL';
    if (typeof value === 'string') return text(ruleLiteral(value));
    if (typeof value === 'boolean') return trigger ? (value ? flavor.true : flavor.false) : storedBoolean(value);
    if (typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return String(value);
    // a number is a scalar: one no column holds is named as written
    if (typeof value === 'number') return fail(Number.isFinite(value) ? `number literal ${value} is an integer outside the safe range, which no column holds` : `number literal ${value} is not finite`);
    if (value && typeof value === 'object' && Object.keys(value).length === 1 && Object.hasOwn(value, '$const')) {
      const literal = value.$const;
      if (typeof literal === 'string') return text(literal);
      // `$const` quotes one level, so a quoted object is no scalar to compare;
      // a probe's match value reads through every level, as the store's does
      if (!raw && literal !== null && typeof literal === 'object') return fail(SCALARS);
      return scalar(literal, raw, operand);
    }
    return fail(SCALARS);
  };
  /** A sum, a difference or a negation, in a trigger check: each operand an
   * integer column read as stored, or a safe-integer literal, the result held
   * to the safe range by a domain of its own; SQL NULL (a missing operand)
   * leaves it without a value, so a comparison with it is false, as the
   * engine answers a missing operand. @param {any} node @returns {string} */
  const arithmetic = (node) => {
    if (!trigger) return fail('an index condition reads plain columns, not arithmetic');
    const [key, args] = Object.entries(node)[0];
    const operands = key === '$neg' ? [args] : Array.isArray(args) && args.length === 2 ? args : fail(`'${key}' takes two operands`);
    const sql = operands.map(integerOperand);
    // a negated operand keeps its own parentheses: `--` would open a SQL comment
    const expression = key === '$neg' ? `(-(${sql[0]}))` : `(${sql[0]} ${key === '$add' ? '+' : '-'} ${sql[1]})`;
    domains.add(`(${expression} IS NULL OR (${safeRange(expression)}))`);
    return expression;
  };
  /** @param {any} value @returns {string} */
  const integerOperand = (value) => {
    if (isArithmetic(value)) return arithmetic(value);
    if (isPath(value)) {
      const path = resolve(value);
      if (path.refused !== undefined) return fail(path.refused);
      const { column, name } = path;
      if (path.text !== undefined || column === undefined || column.codec !== 'integer')
        return fail(`'${path.text !== undefined ? value : name}' is no integer column: arithmetic reads integer columns and safe-integer literals`);
      // the engine's arithmetic over a JSON null is a type error, not a verdict
      if (column.null === 'null') return fail(`'${name}' reads SQL NULL as a JSON null, which is no number: arithmetic reads a column whose SQL NULL is an absent member, or none`);
      const ref = scalar(value, true, true);
      return flavor.integer === undefined ? ref : flavor.integer(column, ref);
    }
    const literal = literalOf(value);
    if (typeof literal === 'number' && Number.isSafeInteger(literal)) return String(literal);
    return fail('arithmetic reads integer columns and safe-integer literals');
  };
  /** @param {any} value @returns {string} */
  const typeOf = (value) => {
    if (isArithmetic(value)) return 'number';
    if (isPath(value)) {
      const path = resolve(value);
      return path.text !== undefined ? 'string' : codecType(path.column?.codec);
    }
    if (value && typeof value === 'object' && Object.hasOwn(value, '$const')) return value.$const === null ? 'null' : typeof value.$const;
    return value === null ? 'null' : typeof value;
  };
  /** The column a path operand reads; nothing for a literal or a known text. @param {any} value */
  const columnRead = (value) => (isPath(value) ? resolve(value) : undefined);
  /** The reads of absent columns an operand makes, its arithmetic's included:
   * a leaf over them holds only where each is present. @param {any} value @returns {PathRead[]} */
  const absentReads = (value) => {
    if (isArithmetic(value)) return [Object.values(value)[0]].flat().flatMap(absentReads);
    const read = columnRead(value);
    return read?.column?.null === 'absent' ? [read] : [];
  };
  /** A leaf over absent members is false while one of them is SQL NULL.
   * @param {string} leaf @param {(string | undefined)[]} refs @returns {string} */
  const guard = (leaf, refs) => {
    if (refs.length === 0 || leaf === flavor.false) return leaf;
    const present = [...new Set(refs)].map((ref) => `${ref} IS NOT NULL`);
    const terms = leaf === flavor.true ? present : [...present, leaf];
    // an index condition writes a lone presence test as `$exists` does
    return !trigger && terms.length === 1 ? terms[0] : `(${terms.join(' AND ')})`;
  };
  /** A plain leaf of an index condition reads SQL NULL as false only where it
   * is not negated. @param {string} leaf @param {boolean} negated */
  const settle = (leaf, negated) => (negated ? `COALESCE(${leaf}, ${flavor.false})` : leaf);
  /** @param {string} key @param {any[]} args @param {boolean} negated @returns {string} */
  const compare = (key, args, negated) => {
    const left = scalar(args[0], false, true), right = scalar(args[1], false, true);
    const lt = typeOf(args[0]), rt = typeOf(args[1]);
    const reads = args.map(columnRead);
    const absent = args.flatMap(absentReads);
    if (absent.length > 0 && (lt === 'null' || rt === 'null')) return fail(neverNull(absent[0]?.name));
    const refs = absent.map((read) => read?.ref);
    if (lt !== rt && lt !== 'null' && rt !== 'null') {
      // two JSON nulls are equal whatever their columns' types
      if (!releasedText && (key === '$eq' || key === '$ne') && reads.every((read) => read?.column?.null === 'null')) {
        const [a, b] = reads.map((read) => read?.ref);
        return key === '$eq' ? `(${a} IS NULL AND ${b} IS NULL)` : `(${a} IS NOT NULL OR ${b} IS NOT NULL)`;
      }
      // a value of another type is unequal, where there is a value
      return guard(key === '$ne' ? flavor.true : flavor.false, refs);
    }
    // an ordered comparison holds between two numbers or two texts, never
    // over a boolean (QUERY-FORMAT §8.4); SQL would order false before true
    if (key !== '$eq' && key !== '$ne' && (lt === 'boolean' || rt === 'boolean')) return flavor.false;
    const equality = key === '$eq' ? flavor.equal : key === '$ne' ? flavor.different : undefined;
    if (trigger) {
      const sql = `(${left} ${equality ?? OPERATORS[/** @type {keyof typeof OPERATORS} */ (key)]} ${right})`;
      return guard(equality === undefined ? `COALESCE(${sql}, ${flavor.false})` : sql, refs);
    }
    // plain `=` and `<>` read SQL NULL as false, which is a JSON null's
    // answer only where no null can meet them
    if (equality !== undefined && (lt === 'null' || rt === 'null' || reads.some((read) => read?.column?.null === 'null')))
      return guard(`${left} ${equality} ${right}`, refs);
    return settle(`${left} ${OPERATORS[/** @type {keyof typeof OPERATORS} */ (key)]} ${right}`, negated);
  };
  /** Membership: a member path equal to one of a list of literals.
   * @param {string} key @param {any[]} args @param {boolean} negated @returns {string} */
  const membership = (key, args, negated) => {
    // the engine reads any other comparison with a list as true when one item compares
    if (key !== '$eq') return fail(`only $eq compares with a $seq: '${key}' holds when any one item compares`);
    const list = isSeq(args[0]) ? args[0] : args[1], path = isSeq(args[0]) ? args[1] : args[0];
    if (!isPath(path) || resolve(path).text !== undefined) return fail('a $seq is compared with one member path');
    const x = scalar(path, false, true);
    const read = resolve(path), column = read.column;
    if (Object.keys(list).length !== 1 || !Array.isArray(list.$seq)) return fail(SEQ_ITEMS);
    // an empty list matches nothing, and PostgreSQL refuses `IN ()`
    if (list.$seq.length === 0) return fail('an empty $seq matches nothing; list at least one value');
    let nullItem = false;
    const values = [];
    for (const item of list.$seq) {
      const literal = literalOf(item);
      if (literal === undefined) return fail(SEQ_ITEMS);
      if (literal === null) {
        if (column.null === 'absent') return fail(neverNull(read.name));
        nullItem = true;
      }
      else if (!holds(column, literal)) return fail(`$seq value ${shown(literal)} is not one the ${column.codec} column '${read.name}' holds`);
      else values.push(scalar(item));
    }
    const listed = values.length === 0 ? undefined : `${x} IN (${values.join(', ')})`;
    const isNull = `${x} IS NULL`;
    if (trigger) // an IN over SQL NULL is NULL, which a `$not` above must see as false
      return guard(!nullItem ? `COALESCE((${listed}), ${flavor.false})` : `(${listed === undefined ? isNull : `${listed} OR ${isNull}`})`,
        column.null === 'absent' ? [read.ref] : []);
    // a one-item list is the equality the engine stores it as
    if (!nullItem) return settle(values.length === 1 ? `${x} = ${values[0]}` : /** @type {string} */ (listed), negated);
    return listed === undefined ? isNull : `(${listed} OR ${isNull})`;
  };
  /** A member's existence: SQL NULL is its absence on an absent column; a
   * null or reject column always holds its member. @param {any} path @returns {string} */
  const exists = (path) => {
    if (!isPath(path) || resolve(path).text !== undefined) return fail('$exists takes one member path; a literal, an array included, always exists');
    scalar(path, false, true);
    const read = resolve(path);
    if (read.column.null !== 'absent') return flavor.true;
    return trigger ? `(${read.ref} IS NOT NULL)` : `${read.ref} IS NOT NULL`;
  };
  /** @param {any} node @param {boolean} [negated] whether a `$not` encloses it @returns {string} */
  const predicate = (node, negated = false) => {
    if (typeof node === 'boolean') return node ? flavor.true : flavor.false;
    if (!node || typeof node !== 'object' || Array.isArray(node) || Object.keys(node).length !== 1) return fail('predicate must be a bounded query expression');
    const [key, args] = Object.entries(node)[0];
    if (key === '$and' || key === '$or') {
      if (!Array.isArray(args) || !args.length) return fail('logical predicates require operands');
      // an index condition joins a nested $and (or $or) to its parent and writes one operand as itself
      const operands = trigger ? args : joined(key, args);
      if (!trigger && operands.length === 1) return predicate(operands[0], negated);
      return `(${operands.map((a) => predicate(a, negated)).join(key === '$and' ? ' AND ' : ' OR ')})`;
    }
    if (key === '$not') return `(NOT (${predicate(args, true)}))`;
    if (key === '$exists-row' && probe !== undefined) return probe(args, (expression) => scalar(expression, true));
    if (key === '$exists') return exists(args);
    if (!Object.hasOwn(OPERATORS, key) || !Array.isArray(args) || args.length !== 2) return fail(`unsupported predicate '${key}'`);
    return args.some(isSeq) ? membership(key, args, negated) : compare(key, args, negated);
  };
  return { predicate: (node) => predicate(node), scalar: (value, raw = false) => scalar(value, raw), typeOf, domains };
}
