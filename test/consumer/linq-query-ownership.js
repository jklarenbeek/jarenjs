//@ts-check
/** The LINQ consumer uses the same remote ownership assertions as DB. */
import { open } from '@jarenjs/linq/db';
import { qualifyQueryOwnership } from './query-ownership.js';

/** Run fluent execution plus the handle's native cursor and SQL explanation.
 * @returns {Promise<any>}
 */
export function qualifyLinqQueryOwnership() {
  return qualifyQueryOwnership(open, (items, min) => {
    const sequence = items.where((row) => row.n.ge(min)).orderBy((row) => row.id);
    const document = sequence.toDocument();
    return {
      document,
      execute: () => sequence.toArray(),
      // sequence.explain() describes authoring; this overload executes
      // the Store's EXPLAIN for the array terminal's authored document.
      explain: () => items.explain([document]),
      // Collection chains currently materialize during async iteration;
      // query() is the public handle's native database cursor surface.
      cursor: () => items.query(document),
      iterate: () => sequence[Symbol.asyncIterator](),
    };
  });
}
