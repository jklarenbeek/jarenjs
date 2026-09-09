//@ts-check
/** Recursive answers carry the same envelope as map elements. Query engines stay injected. */
export const RECURSIVE_ITEM_SCHEMA = {
  type: 'object', properties: { slot: { type: 'string' }, value: {} }, required: ['slot', 'value'],
};

/** Query singleton normalization: empty sequence, one item, or several items.
 * @param {any} value */
export function recursiveItems(value) {
  const items = value === null ? [] : Array.isArray(value) ? value : [value];
  return items.every((item) => item !== null && typeof item === 'object' && !Array.isArray(item)
    && typeof item.slot === 'string' && Object.hasOwn(item, 'value')) ? items : null;
}

/** Conservatively prove a declared item/sequence schema. Unknown schema keywords
 * never manufacture required properties. Runtime validation enforces the full declaration.
 * @param {any} schema @param {boolean} [item] @returns {boolean} */
export function recursiveSchema(schema, item = false) {
  if (!schema || typeof schema !== 'object') return false;
  if (schema.type === 'array') return !item && recursiveSchema(schema.items, true);
  if (schema.anyOf) return schema.anyOf.every((branch) => recursiveSchema(branch, item));
  return schema.type === 'object' && schema.required?.includes('slot')
    && schema.required?.includes('value') && schema.properties?.slot?.type === 'string';
}

/** Three-valued structural proof over the existing annotated query AST.
 * @param {any} node @param {boolean} [item] @returns {'compatible'|'incompatible'|'unknown'} */
export function recursiveShape(node, item = false) {
  if (!node) return 'unknown';
  if (node.kind === 'let') return recursiveShape(node.ret, item);
  if (node.kind === 'flwor') {
    const output = recursiveShape(node.ret, node.fold ? item : true);
    if (!node.fold) return output;
    const initial = recursiveShape(node.fold.expr, item);
    return initial === output ? output : 'unknown';
  }
  if (node.kind === 'array') {
    if (item) return 'incompatible';
    const shapes = node.elements.map((element) => recursiveShape(element, true));
    return shapes.includes('incompatible') ? 'incompatible' : shapes.includes('unknown') ? 'unknown' : 'compatible';
  }
  if (node.kind === 'literal') return (item && (Array.isArray(node.value) || node.value === null))
    || recursiveItems(node.value) === null ? 'incompatible' : 'compatible';
  if (node.kind === 'object') {
    const slot = node.entries.find((entry) => entry.name === 'slot')?.expr;
    const value = node.entries.find((entry) => entry.name === 'value');
    if (!slot || !value) return 'incompatible';
    if (slot.type?.type === 'string' && slot.type.optional === false) return 'compatible';
    return !slot.type || slot.type.type === 'unknown' ? 'unknown' : 'incompatible';
  }
  if (node.type?.type && !['unknown', 'object', 'array'].includes(node.type.type)) return 'incompatible';
  return 'unknown';
}
