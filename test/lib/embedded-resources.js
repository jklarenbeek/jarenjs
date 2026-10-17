//@ts-check
/**
 * @file Generated schemas whose references sit inside embedded resources (a
 * subschema with its own `$id`), for the differentials that hold the
 * normalizer, `@jarenjs/emit` and the strict profile to the place the
 * validator reads. Each schema declares `x` in three resources with three
 * types (the root's `integer`, `y`'s `string`, `z`'s `boolean`), so a
 * reference resolved in the wrong resource reads the wrong type. Every leaf
 * reference is the first candidate, from a rotating offset, the validator
 * compiles.
 */
import { JarenValidator } from '@jarenjs/validate';

/** @type {Record<string, string|undefined>} */
const DRAFTS = {
  none: undefined,
  d7: 'http://json-schema.org/draft-07/schema#',
  d19: 'https://json-schema.org/draft/2019-09/schema',
  d20: 'https://json-schema.org/draft/2020-12/schema',
};
const ROOT_IDS = [undefined, 'http://e.test/root.json', 'root.json'];
/** `y`'s identifier: relative, absolute, in a sub-path, fragment-only (no resource), a draft-04 `id` */
const Y_IDS = ['thing.json', 'http://other.test/thing.json', 'sub/thing.json', '#thing', 'id:thing.json'];
const Z_IDS = [undefined, 'deep.json', 'http://e.test/deep/z.json'];
const TYPES = ['integer', 'string', 'boolean'];

/** @param {string} D - The definitions keyword */
const candidates = (D) => [`#/${D}/x`, '#nm', `thing.json#/${D}/x`, `#/properties/y/${D}/x`, `deep.json#/${D}/x`,
  `#/properties/y/properties/z/${D}/x`, 'http://other.test/thing.json#nm', 'sub/thing.json#nm', 'ID',
  `http://e.test/deep/z.json#/${D}/x`, '#'];

/** @param {string} draft @param {string} type */
function named(draft, type) {
  return draft === 'd19' || draft === 'd20' ? { type, $anchor: 'nm' } : { type, $id: '#nm' };
}
/** A leaf: a `$ref`, or (`ID`) an `$id` beside a `$ref`. @param {string} ref @param {string} D */
function leaf(ref, D) {
  return ref === 'ID' ? { $id: 'leaf.json', $ref: `#/${D}/x` } : { $ref: ref };
}

/**
 * @typedef {object} EmbeddedCase
 * @property {Record<string, any>} schema
 * @property {string[][]} leaves - The instance paths of the referencing members
 * @property {string} label
 */

/** @returns {Generator<EmbeddedCase>} */
export function* embeddedResourceSchemas() {
  let k = 0;
  for (const draft of Object.keys(DRAFTS)) for (const D of ['definitions', '$defs']) for (const rid of ROOT_IDS) for (const yid of Y_IDS) for (const zid of Z_IDS) {
    const refs = candidates(D);
    for (let j = 0; j < 3; j++, k++) {
      /** @type {Record<string, any>} */
      const schema = { type: 'object' };
      if (DRAFTS[draft] !== undefined) schema.$schema = DRAFTS[draft];
      if (rid !== undefined) schema.$id = rid;
      schema[D] = { x: named(draft, TYPES[0]) };
      const keyword = yid.startsWith('id:') ? 'id' : '$id';
      /** @type {Record<string, any>} */
      const y = { [keyword]: yid.replace(/^id:/, ''), type: 'object', [D]: { x: yid.startsWith('#') ? { type: TYPES[1] } : named(draft, TYPES[1]) }, properties: { a: leaf(`#/${D}/x`, D) } };
      if (zid !== undefined) y.properties.z = { $id: zid, type: 'object', [D]: { x: named(draft, TYPES[2]) }, properties: { b: leaf(`#/${D}/x`, D) } };
      schema.properties = { r: leaf(`#/${D}/x`, D), y };
      /** @type {[Record<string, any>, string][]} */
      const holders = [[schema.properties, 'r'], [y.properties, 'a']];
      if (zid !== undefined) holders.push([y.properties.z.properties, 'b']);
      const picked = holders.map(([holder, key], n) => {
        for (let t = 0; t < refs.length; t++) {
          const ref = refs[(k * 7 + n * 3 + j * 5 + t) % refs.length];
          holder[key] = leaf(ref, D);
          try {
            new JarenValidator().compile(schema);
            return ref;
          }
          catch { /* the next candidate */ }
        }
        holder[key] = leaf(`#/${D}/x`, D);
        return `#/${D}/x`;
      });
      yield {
        schema,
        leaves: zid !== undefined ? [['r'], ['y', 'a'], ['y', 'z', 'b']] : [['r'], ['y', 'a']],
        label: `${draft} ${D} root=${rid} ${keyword}=${yid} z=${zid} refs=${picked.join(' | ')}`,
      };
    }
  }
}

/** The instance holding `value` at `path`. @param {string[]} path @param {unknown} value @returns {any} */
export const instanceAt = (path, value) => path.reduceRight((acc, key) => ({ [key]: acc }), value);

/**
 * The type the validator reads at a leaf: `integer`, `number`, `string`,
 * `boolean`, `any`, or `none` (an object-typed target accepts none of the
 * probes).
 * @param {(value: unknown) => boolean} validate @param {string[]} path
 */
export function placeType(validate, path) {
  const accepts = (/** @type {unknown} */ value) => validate(instanceAt(path, value)) === true;
  const [int, frac, str, bool] = [accepts(1), accepts(1.5), accepts('s'), accepts(true)];
  if (int && frac && str && bool) return 'any';
  if (int && frac) return 'number';
  if (int) return 'integer';
  if (str) return 'string';
  if (bool) return 'boolean';
  return 'none';
}
