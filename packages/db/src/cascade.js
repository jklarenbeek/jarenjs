//@ts-check
/**
 * The rows a store delete's declared foreign keys act on, read before the
 * delete runs so journal capture can record them once it ran.
 *
 * A journal sees the rows its write paths write; the database's own
 * `ON DELETE CASCADE` / `SET NULL` actions, and a join row dying with its
 * endpoint, happen inside the DELETE statement. The store refuses at open a
 * physical foreign key that differs from the model's, so the model's edges are
 * the database's, and the rows those actions reach are predicted from them:
 * breadth first over the inbound edges of every row the delete removes, inside
 * the delete's own transaction, one statement per edge, level and chunk of
 * keys, every read locked where the engine locks rows, as strongly as the
 * delete's own action will lock the row and no more — a writer outside capture
 * then cannot add, move or remove a row of the closure between the read and
 * the delete, while one that only references a row the delete nulls is not
 * waited for.
 */
import { utf8ByteLength } from '@jarenjs/core/string';
import { chain, isThenable, useStatementOnce } from './driver.js';
import { DbRuntimeError } from './errors.js';

/** The most keys one closure statement binds. */
const CHUNK = 500;

/**
 * @typedef {{ kind: 'fk', child: string, column: string, parent: string,
 *   onDelete: 'cascade' | 'setNull', unique: boolean }} ForeignKeyEdge - the
 *   `child` rows whose `column` names a `parent` row are removed (`cascade`)
 *   or have the member nulled (`setNull`) when that row is deleted; `unique`
 *   when the column is unique (a one-to-one relation)
 * @typedef {{ kind: 'join', table: string, own: any, other: any,
 *   columns: string[] }} JoinEdge - the rows of join table `table` whose
 *   `own.column` names an `own.entity` row are removed with that row;
 *   `columns` lists the table's two columns in table order
 * @typedef {ForeignKeyEdge | JoinEdge} CascadeEdge
 * @typedef {{ table: string, keyParts: any[], before: any, after: any }} CascadeEntry
 *   - one row the database's foreign-key actions change, as a journal entry
 */

/**
 * The edges a delete's foreign-key actions follow, from the store's mapping:
 * every `cascade` or `setNull` foreign key (a `restrict` key refuses the delete
 * and is never followed) and both sides of every join table. Each edge is filed
 * under the table its rows reference (`inbound`) and under the table holding
 * those rows (`outbound`: the child entity, or the join table).
 * @param {any} mapping - the store's entity mapping (`explainMapping`)
 * @returns {{ inbound: Map<string, CascadeEdge[]>, outbound: Map<string, CascadeEdge[]> }}
 */
export function foreignKeyEdges(mapping) {
  /** @type {Map<string, CascadeEdge[]>} */
  const inbound = new Map();
  /** @type {Map<string, CascadeEdge[]>} */
  const outbound = new Map();
  /** @param {Map<string, CascadeEdge[]>} edges @param {string} name @param {CascadeEdge} edge */
  const file = (edges, name, edge) => {
    const filed = edges.get(name);
    if (filed === undefined) edges.set(name, [edge]);
    else filed.push(edge);
  };
  for (const [child, entity] of Object.entries(mapping?.entities ?? {})) {
    for (const fk of entity.foreignKeys ?? []) {
      if (fk.onDelete !== 'cascade' && fk.onDelete !== 'setNull') continue;
      /** @type {ForeignKeyEdge} */
      const edge = { kind: 'fk', child, column: fk.column, parent: fk.references, onDelete: fk.onDelete,
        unique: fk.unique === true };
      file(inbound, fk.references, edge);
      file(outbound, child, edge);
    }
  }
  for (const [table, join] of Object.entries(mapping?.joinTables ?? {})) {
    const columns = [join.left.column, join.right.column];
    for (const [own, other] of [[join.left, join.right], [join.right, join.left]]) {
      /** @type {JoinEdge} */
      const edge = { kind: 'join', table, own, other, columns };
      file(inbound, own.entity, edge);
      file(outbound, table, edge);
    }
  }
  return { inbound, outbound };
}

/** Apply `step` to each item in order; value or promise.
 * @param {any[]} items @param {(item: any) => any} step @param {number} [from] @returns {any} */
const each = (items, step, from = 0) => {
  for (let at = from; at < items.length; at += 1) {
    const out = step(items[at]);
    if (isThenable(out)) return out.then(() => each(items, step, at + 1));
  }
  return undefined;
};

/** Run `round` until it answers false; value or promise, with no stack frame
 * kept per round, so a deep self reference cannot exhaust the stack.
 * @param {() => any} round @returns {any} */
const repeat = (round) => {
  for (;;) {
    const more = round();
    if (isThenable(more)) return more.then((again) => (again ? repeat(round) : undefined));
    if (!more) return undefined;
  }
};

/**
 * The closure journal capture reads around a store delete.
 *
 * `predict(entityName, keyParts)` answers, value or promise (a synchronous
 * driver keeps a synchronous delete synchronous), `null` when no edge reaches
 * the entity — no statement at all — and otherwise `{ root, entries }`: the
 * row about to be deleted, read locked (`undefined` when there is none, with
 * no entries), and every row the database's foreign-key actions change when
 * it goes, as journal entries. Removed rows come first, in discovery order,
 * with the stored document as their before-image; then nulled rows, whose
 * after-image is that document without every nulled member; then the
 * membership rows of every removed row, whose before-image is the two-column
 * document in table order. A row both nulled and removed is removed, and each
 * row appears once however many edges reach it.
 *
 * With `bound`, the root and each entry count one operation against
 * `maxOperations` and their serialized documents against `maxBytes`; the first
 * row past either credit refuses `JD2106` before the delete runs. A statement
 * reads at most the credit left plus one, plus the rows of its table already
 * met — those can come back without counting again, so a result short of that
 * limit is complete and a full one holds a row past the credit. Without
 * `bound` the closure is read whole, as a session changeset records it.
 * @param {{ connection: any, mapping: any, entityCoreFor: (name: string) => any,
 *   bound: { maxOperations: number, maxBytes: number } | null }} options
 * @returns {{ predict: (entityName: string, keyParts: any[]) => any }}
 */
export function createCascadeCapture({ connection, mapping, entityCoreFor, bound }) {
  const { inbound } = foreignKeyEdges(mapping);
  const dialect = connection.dialect;
  const q = dialect.quoteIdentifier;
  /** @param {number} i */
  const parameter = (i) => dialect.parameterRef(i, 'v');
  /** A row's key column as the referencing columns store it. @param {any} core @param {any} doc */
  const storedKey = (core, doc) => core.plan.encodeColumn(core.plan.keys[0], doc[core.plan.keys[0]]);

  /** The membership rows of a join edge whose own column holds one of `values`.
   * @param {JoinEdge} edge @param {any[]} values @param {number | undefined} limit */
  const memberships = (edge, values, limit) => {
    const sql = `SELECT ${edge.columns.map(q).join(', ')} FROM ${q(edge.table)} `
      + `WHERE ${q(edge.own.column)} IN (${values.map((_, i) => parameter(i + 1)).join(', ')})`
      + `${limit === undefined ? '' : ` LIMIT ${parameter(values.length + 1)}`}${dialect.rowLockSuffix}`;
    return useStatementOnce(connection, sql, (statement) =>
      statement.all(limit === undefined ? values : [...values, limit]));
  };

  /** @param {string} entityName @param {any} rootCore @param {any} root */
  const closureOf = (entityName, rootCore, root) => {
    /** @param {string} table @param {any[]} parts */
    const tokenOf = (table, parts) => JSON.stringify([table, ...parts]);
    /** every row removed so far, the root included @type {Set<string>} */
    const removedTokens = new Set();
    /** @type {CascadeEntry[]} */
    const removed = [];
    /** @type {Map<string, { table: string, keyParts: any[], before: any, members: Set<string> }>} */
    const nulled = new Map();
    /** @type {Map<string, CascadeEntry>} */
    const members = new Map();
    /** how many rows of each table are met so far @type {Map<string, number>} */
    const met = new Map();
    let operations = bound === null ? 0 : bound.maxOperations;
    let bytes = bound === null ? 0 : bound.maxBytes;
    /** Count a newly met row against the credit. @param {string} table @param {any} doc */
    const meet = (table, doc) => {
      met.set(table, (met.get(table) ?? 0) + 1);
      if (bound === null) return;
      operations -= 1;
      bytes -= utf8ByteLength(JSON.stringify(doc));
      if (operations < 0 || bytes < 0)
        throw new DbRuntimeError('JD2106', 'a cascading delete exceeds replication capacity');
    };
    /** @param {string} table */
    const limitFor = (table) => (bound === null ? undefined : operations + 1 + (met.get(table) ?? 0));

    /** @type {Map<string, any[]>} */
    let frontier = new Map([[entityName, [storedKey(rootCore, root)]]]);
    removedTokens.add(tokenOf(entityName, rootCore.plan.keys.map((/** @type {string} */ name) => root[name])));
    meet(entityName, root);

    /** One row a foreign-key edge reaches. @param {ForeignKeyEdge} edge @param {any} core @param {any} row */
    const reach = (edge, core, row) => {
      const keyParts = core.plan.keys.map((/** @type {string} */ name) => row[name]);
      const token = tokenOf(edge.child, keyParts);
      if (removedTokens.has(token)) return;
      const nulling = nulled.get(token);
      if (edge.onDelete === 'setNull') {
        if (nulling !== undefined) nulling.members.add(edge.column);
        else {
          meet(edge.child, row);
          nulled.set(token, { table: edge.child, keyParts, before: row, members: new Set([edge.column]) });
        }
        return;
      }
      if (nulling === undefined) meet(edge.child, row);
      removedTokens.add(token);
      removed.push({ table: edge.child, keyParts, before: row, after: null });
      if (!inbound.has(edge.child)) return;
      const keys = frontier.get(edge.child);
      if (keys === undefined) frontier.set(edge.child, [storedKey(core, row)]);
      else keys.push(storedKey(core, row));
    };
    /** One membership row a join edge reaches. @param {JoinEdge} edge @param {any} row */
    const member = (edge, row) => {
      const keyParts = edge.columns.map((column) => row[column]);
      const token = tokenOf(edge.table, keyParts);
      if (members.has(token)) return;
      const before = Object.fromEntries(edge.columns.map((column, i) => [column, keyParts[i]]));
      meet(edge.table, before);
      members.set(token, { table: edge.table, keyParts, before, after: null });
    };
    /** One statement: the rows one edge reaches from a chunk of keys.
     * @param {{ edge: CascadeEdge, keys: any[] }} read */
    const run = ({ edge, keys }) => {
      if (edge.kind === 'join') {
        return chain(memberships(edge, keys, limitFor(edge.table)), (rows) => {
          for (const row of rows) member(edge, row);
        });
      }
      const core = entityCoreFor(edge.child);
      // locked as the delete's own action will lock the row: a removed row or
      // a nulled unique member (a key) exclusively, any other nulled row as an
      // update of non-key columns, which leaves writers that only reference
      // it free
      const lock = edge.onDelete === 'setNull' && !edge.unique ? dialect.rowNoKeyLockSuffix : dialect.rowLockSuffix;
      return chain(core.referencing(edge.column, keys, limitFor(edge.child), lock), (rows) => {
        for (const row of rows) reach(edge, core, row);
      });
    };
    /** One level: every edge into the rows the previous level removed. */
    const level = () => {
      if (frontier.size === 0) return false;
      const reads = [];
      for (const [name, keys] of frontier) {
        for (const edge of inbound.get(name) ?? []) {
          for (let at = 0; at < keys.length; at += CHUNK) reads.push({ edge, keys: keys.slice(at, at + CHUNK) });
        }
      }
      frontier = new Map();
      return chain(each(reads, run), () => true);
    };
    return chain(repeat(level), () => {
      /** @type {CascadeEntry[]} */
      const entries = [...removed];
      for (const [token, row] of nulled) {
        if (removedTokens.has(token)) continue;
        const after = { ...row.before };
        for (const name of row.members) delete after[name];
        entries.push({ table: row.table, keyParts: row.keyParts, before: row.before, after });
      }
      entries.push(...members.values());
      return { root, entries };
    });
  };

  return {
    /** @param {string} entityName @param {any[]} keyParts */
    predict(entityName, keyParts) {
      if (!inbound.has(entityName)) return null;
      const rootCore = entityCoreFor(entityName);
      return chain(rootCore.getLocked(keyParts[0]), (root) => (root === undefined
        ? { root, entries: [] }
        : closureOf(entityName, rootCore, root)));
    },
  };
}
