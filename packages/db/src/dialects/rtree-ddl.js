//@ts-check
/**
 * @file The R\*Tree mapping's own DDL — the second physical
 * realization of a `derive: 'bbox'` column set (MODEL-FORMAT §2.1,
 * `physical: 'rtree'`): a virtual table beside the collection and the
 * three row triggers that keep it in sync.
 *
 * It lives beside the dialects rather than in the shared statement
 * builder because every line of it is one engine family's spelling —
 * `CREATE VIRTUAL TABLE ... USING`, and a trigger body between `BEGIN`
 * and `END`. A dialect whose `capabilities.virtualTables` is false
 * composes none of it, and the planner maps a `physical: 'rtree'`
 * column set back onto the B-tree over the four edge columns instead.
 *
 * Parameterized by the spelling spec it belongs to, so the two specs
 * that DO carry an R\*Tree share one implementation and still produce
 * their own quoting, their own module name and their own column order.
 */

/**
 * The virtual-table DDL group for one spelling spec.
 * @param {{ quoteIdentifier: (s: string) => string,
 *   rowIdentity: () => string,
 *   rtree: { module: string, columns: readonly string[] } }} spec
 * @returns {Record<string, Function>}
 */
export function rtreeDdl(spec) {
  const q = spec.quoteIdentifier;
  return {
  /**
   * The second physical realization of a `derive: 'bbox'` column set
   * (MODEL-FORMAT §2.1, `physical: 'rtree'`): an R\*Tree virtual
   * table beside the collection, keyed by the collection's row id and
   * carrying the four box edges as `(minx, maxx, miny, maxy)`.
   *
   * The coordinates are 32-bit floats rounded OUTWARD, so the stored
   * box is a superset of the row's — no false negatives, which is
   * what an implied conjunct needs, and the reason `$bbox-intersects`
   * stops being exact under this mapping.
   * @param {{ name: string }} shape
   * @returns {string}
   */
  createVirtualTable({ name }) {
    return `CREATE VIRTUAL TABLE ${q(name)} USING ${spec.rtree.module}(`
      + `${spec.rtree.columns.map(q).join(', ')})`;
  },
  /**
   * @param {string} name
   * @returns {string}
   */
  dropVirtualTable(name) {
    return `DROP TABLE ${q(name)}`;
  },
  /**
   * @param {string} name
   * @returns {string}
   */
  dropTrigger(name) {
    return `DROP TRIGGER ${q(name)}`;
  },
  /**
   * Fill an R\*Tree from the documents already stored — the migration
   * step that turns a `columns` collection into an `rtree` one. The
   * `IS NOT NULL` is §3.2's rule in SQL: a row with no bounded
   * position is ABSENT from the index, not at `[0, 0]`.
   * @param {{ table: string, virtualTable: string,
   *   edges: { name: string }[] }} shape
   * @returns {string}
   */
  fillVirtualTable({ table, virtualTable, edges }) {
    const columns = spec.rtree.columns;
    const sources = [spec.rowIdentity(), ...edges.map((edge) => q(edge.name))];
    return `INSERT INTO ${q(virtualTable)} (${columns.map(q).join(', ')}) `
      + `SELECT ${sources.join(', ')} FROM ${q(table)} `
      + `WHERE ${q(edges[0].name)} IS NOT NULL`;
  },
  /**
   * The three triggers that keep an R\*Tree in sync with its
   * collection — insert, update, delete — as DECLARED objects of the
   * collection table.
   *
   * Declared, and not a second write path in JavaScript: a trigger is
   * inside the writing transaction by construction (SQLite cannot
   * separate them), no write path can bypass it (`insert`,
   * `insertAllocated`, `upsert`, a translated patch, the patch
   * fallback, a delete and a migration backfill all fire it), and it
   * belongs to the collection table, so the existing declared-text
   * drift check sees it for free.
   *
   * The body reads the DERIVED COLUMNS through `NEW` rather than
   * restating the box expression, so the columns stay the box's one
   * definition — and that text works unchanged on the stored-column
   * branch, where those columns are ordinary ones.
   *
   * The `IS NOT NULL` guard is load-bearing: an R\*Tree coerces a
   * `NULL` coordinate to `0.0` without complaint, so without it every
   * unbounded document would land on Null Island instead of being
   * absent (MODEL-FORMAT §3.2).
   * @param {{ table: string, virtualTable: string, prefix: string,
   *   edges: { name: string }[] }} shape - `edges` are the four
   *   derived columns in `(w, e, s, n)` order, which is the order the
   *   virtual table's `(minx, maxx, miny, maxy)` carry
   * @returns {{ name: string, sql: string }[]}
   */
  createSyncTriggers({ table, virtualTable, prefix, edges }) {
    const rid = spec.rowIdentity();
    const target = `${q(virtualTable)} (${spec.rtree.columns.map(q).join(', ')})`;
    const guard = `${q(edges[0].name)} IS NOT NULL`;
    const values = (row) => [`${row}.${rid}`,
      ...edges.map((edge) => `${row}.${q(edge.name)}`)].join(', ');
    return [
      { name: `${prefix}_ai`,
        sql: `CREATE TRIGGER ${q(`${prefix}_ai`)} AFTER INSERT ON ${q(table)} `
          + `WHEN NEW.${guard} BEGIN `
          + `INSERT INTO ${target} VALUES (${values('NEW')}); END` },
      // one trigger, not two: the old id leaves and the new box
      // arrives only when it exists, so a document that loses its
      // geometry leaves the index rather than keeping a stale box
      { name: `${prefix}_au`,
        sql: `CREATE TRIGGER ${q(`${prefix}_au`)} AFTER UPDATE ON ${q(table)} BEGIN `
          + `DELETE FROM ${q(virtualTable)} WHERE ${q(spec.rtree.columns[0])} = OLD.${rid}; `
          + `INSERT INTO ${target} SELECT ${values('NEW')} WHERE NEW.${guard}; END` },
      { name: `${prefix}_ad`,
        sql: `CREATE TRIGGER ${q(`${prefix}_ad`)} AFTER DELETE ON ${q(table)} BEGIN `
          + `DELETE FROM ${q(virtualTable)} WHERE ${q(spec.rtree.columns[0])} = OLD.${rid}; END` },
    ];
  },
  };
}
