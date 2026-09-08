//@ts-check
/** Deterministic logical-envelope authoring through the DB format authority. */
import { normalizeReplication } from '@jarenjs/db';

/** Start a transport-neutral replication document; changes remain in declared order.
 * @param {{ replica: string, seq: number, frontier: Record<string, number>, model: string }} header */
export function defineReplication(header) {
  const operations = [];
  const builder = Object.freeze({
    /** @param {string} table @param {string} key @param {any} before @param {any} after */
    change(table, key, before, after) {
      operations.push(structuredClone({ table, key, before, after }));
      return builder;
    },
    toDocument() { return normalizeReplication({ $replication: '0.1', ...header, operations }); },
    toJSON() { return builder.toDocument(); },
  });
  header = structuredClone(header);
  return builder;
}
