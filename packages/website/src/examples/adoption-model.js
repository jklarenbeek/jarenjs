//@ts-check
/** Application declarations shared by the file fixture and its public-API consumer. */
export const adoptionFields = ['title', 'sku', 'barcode', 'type', 'category', 'categorySearch', 'sourceName', 'tags'];
export const adoptionRule = { $rules: '1', id: 'amounts', revision: '1', targets: [{ id: 'amount', field: '/amount', formula: {
  $formula: '1', id: 'amount', revision: '1', expression: { $mul: ['$.price', { $if: [{ $eq: ['$.quantity', null] }, 0, '$.quantity'] }] },
} }] };

/** Independent physical names and composite identity remain application policy. */
export function adoptionModel(definition) {
  const archive = definition.id === 'archive-stock';
  const schema = { type: 'object', properties: {
    id: { type: 'string', 'x-entity': { key: true } },
    ...Object.fromEntries(adoptionFields.map((name) => [name, { type: 'string', ...(archive && name === 'sourceName' ? { 'x-entity': { key: true } } : {}) }])),
    quantity: { type: ['integer', 'null'] }, price: { type: 'number' }, amount: { type: 'number' },
    revision: { type: 'integer' }, provenance: { type: ['string', 'null'] },
  }, required: ['id', ...adoptionFields, 'quantity', 'price', 'amount', 'revision', 'provenance'], additionalProperties: false };
  const columns = Object.fromEntries(Object.keys(schema.properties).map((name) => [name, {
    name: archive ? `stock_${name}` : name,
    codec: ['price', 'amount'].includes(name) ? 'number' : ['quantity', 'revision'].includes(name) ? 'integer' : 'text',
    null: ['quantity', 'provenance'].includes(name) ? 'null' : 'reject',
  }]));
  return { $model: '0.1', entities: { Item: { schema, physical: { table: archive ? 'archive_items' : 'catalog_items',
    keys: archive ? ['id', 'sourceName'] : ['id'], columns } } },
  collections: Object.fromEntries(['settings', 'receipts', 'leases', 'operations', 'runs', 'events', 'staging', 'checkpoints', 'publications', 'facts']
    .map((name) => [name, { key: '/id', schema: { type: 'object' }, indexes: [] }])) };
}

/** Logical composite keys are passed intact to the database owner. */
export function adoptionItemKey(definition, row) {
  return definition.id === 'archive-stock' ? { id: row.id, sourceName: row.sourceName } : row.id;
}
