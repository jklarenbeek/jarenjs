// @ts-check
/** Valid starting documents, shared by the menu, host and assistant. */
const SKELETONS = {
  app: JSON.stringify({ state: {}, view: [{ match: '$', body: ['p', {}, 'New app'] }], actions: {} }, null, 2),
  jslt: JSON.stringify({ $jslt: '0.1', rules: [{ match: '$', body: '$' }] }, null, 2),
  query: JSON.stringify({ value: '$' }, null, 2),
  fsm: JSON.stringify({ $fsm: '0.1', states: ['idle', 'done'], initial: 'idle', transitions: [{ from: 'idle', event: 'finish', to: 'done' }] }, null, 2),
  dag: JSON.stringify({ $dag: '0.1', nodes: { input: { kind: 'input' }, output: { kind: 'output' } }, edges: [{ from: 'input', to: 'output' }], output: 'output' }, null, 2),
  model: JSON.stringify({ $model: '0.1', collections: { notes: { schema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, points: { type: 'integer' } }, required: ['id'] }, key: '/id', indexes: [{ name: 'by_points', path: '$.points' }] } } }, null, 2),
  state: '{}',
  data: '{}',
  schema: JSON.stringify({ type: 'object' }, null, 2),
  contract: JSON.stringify({
    $contract: '0.1',
    operations: {
      'echo.say': {
        kind: 'command',
        input: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
        output: true,
      },
    },
  }, null, 2),
};

/** Creation kinds derive from the valid starter table and are shared by
 * the component menu, website host and assistant. */
export const ADDABLE_KINDS = Object.freeze(Object.keys(SKELETONS));

/** The starter text for a freshly added file of `kind`, or null if the
 * kind is not addable. */
export function fileSkeleton(kind) {
  return Object.hasOwn(SKELETONS, kind) ? SKELETONS[kind] : null;
}
