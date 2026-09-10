//@ts-check
/** Structural record mapping shared by durable adapters; the store owns transactions. */
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { isThenable } from '@jarenjs/core/function';
import { LinqRuntimeError } from '../errors.js';

/** @param {any} value */
export const copyRecord = (value) => JSON.parse(canonicalizeJson(value));
/** @param {string} reason */
export const refuseRecord = (reason) => new LinqRuntimeError('JL2009', reason);
/** @param {any} client @param {Function} fn */
export const recordTransaction = (client, fn) => typeof client.close === 'function'
  ? client.transaction(fn, { mode: 'immediate' }) : client.transaction(fn);

/** Map canonical records to declared application fields without inferring a schema.
 * @param {any} client @param {string | { collection?: string, entity?: string, key?: Function, read: Function, write: Function }} mapping */
export function mappedRecords(client, mapping) {
  const spec = typeof mapping === 'string' ? { collection: mapping, read: copyRecord, write: copyRecord } : mapping;
  const entity = spec?.entity !== undefined;
  const owner = entity ? 'entities' : 'collections';
  const name = entity ? spec.entity : spec?.collection;
  if (!client || typeof client.transaction !== 'function' || !spec || !Object.hasOwn(client[owner] ?? {}, name)
    || (entity && spec.collection !== undefined) || (spec.key !== undefined && typeof spec.key !== 'function')
    || typeof spec.read !== 'function' || typeof spec.write !== 'function')
    throw new TypeError('record mapping needs a declared collection or entity and synchronous read/write functions');
  const convert = (fn, value) => {
    const result = fn(copyRecord(value));
    if (isThenable(result)) throw new TypeError('record mappings must be synchronous');
    return copyRecord(result);
  };
  const keyOf = (id) => spec.key === undefined ? id : convert(spec.key, id);
  return Object.freeze({
    name: `${owner}/${name}`,
    async get(tx, id) {
      const value = await tx[owner][name].get(keyOf(id));
      if (value === undefined) return undefined;
      const record = convert(spec.read, value);
      if (record.id !== id) throw refuseRecord('record mapping changed identity');
      return record;
    },
    async put(tx, record, insert = false) {
      const stored = convert(spec.write, record);
      if (canonicalizeJson(convert(spec.read, stored)) !== canonicalizeJson(record))
        throw refuseRecord('record mapping is not lossless');
      const target = tx[owner][name], key = keyOf(record.id);
      if (entity) {
        if (insert || await target.get(key) === undefined) await target.create(stored);
        else await target.update(key, stored);
        const persisted = await target.get(key);
        if (persisted === undefined || canonicalizeJson(convert(spec.read, persisted)) !== canonicalizeJson(record))
          throw refuseRecord('record mapping changed the physical key or stored value');
      }
      else {
        const written = await (insert ? target.insert(stored) : target.put(stored, key));
        if (canonicalizeJson(written) !== canonicalizeJson(key)) throw refuseRecord('record mapping changed the physical key');
      }
      return key;
    },
    delete: (tx, id) => tx[owner][name].delete(keyOf(id)),
  });
}
