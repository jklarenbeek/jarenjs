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
 * @param {any} schema @returns {boolean} */
export function recursiveSchema(schema) {
  if (!schema || typeof schema !== 'object') return false;
  if (schema.type === 'array') return recursiveSchema(schema.items);
  if (schema.anyOf) return schema.anyOf.every(recursiveSchema);
  return schema.type === 'object' && schema.required?.includes('slot')
    && schema.required?.includes('value') && schema.properties?.slot?.type === 'string';
}

/** Three-valued structural proof over the existing annotated query AST.
 * @param {any} node @returns {'compatible'|'incompatible'|'unknown'} */
export function recursiveShape(node) {
  if (!node) return 'unknown';
  if (node.kind === 'let') return recursiveShape(node.ret);
  if (node.kind === 'flwor') {
    const output = recursiveShape(node.ret);
    if (!node.fold) return output;
    const initial = recursiveShape(node.fold.expr);
    return initial === output ? output : 'unknown';
  }
  if (node.kind === 'array') {
    if (node.elements.some((element) => element.kind === 'array')) return 'incompatible';
    const shapes = node.elements.map(recursiveShape);
    return shapes.includes('incompatible') ? 'incompatible' : shapes.includes('unknown') ? 'unknown' : 'compatible';
  }
  if (node.kind === 'literal') return recursiveItems(node.value) === null ? 'incompatible' : 'compatible';
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
