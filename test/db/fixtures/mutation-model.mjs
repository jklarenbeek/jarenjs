//@ts-check
/** Synthetic public physical metadata shared by ownership and retention probes. */
export const model = { entities: { Entry: { schema: { type: 'object', properties: {
  id: { type: 'integer', 'x-entity': { key: true } }, payload: { type: 'string' },
}, required: ['id', 'payload'] }, physical: { table: 'entries', columns: {
  id: { name: 'id', codec: 'integer', null: 'reject' }, payload: { name: 'payload', codec: 'text', null: 'reject' },
} } } } };
