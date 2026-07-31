//@ts-check
/**
 * The Flow studio's seed documents — one executable machine and one
 * dataflow graph, both small enough to read whole and each exercising
 * the features the page demonstrates (guards reading context, entry
 * effects, task nodes, ports). `runContext` seeds the nested run
 * sandbox's data state (the machine's `$.context.*`), and `runInput`
 * pre-fills the dag run pane.
 */

export const FLOW_TEMPLATES = [
  {
    name: 'review',
    kind: 'fsm',
    title: 'Document review (machine)',
    lead: 'Four states, one guard reading data state, one entry effect. Connect a rejected path back, or rename events in the inspector.',
    doc: {
      $fsm: '0.1',
      initial: 'draft',
      states: [
        'draft',
        { id: 'in-review', entry: [{ run: 'notify', with: { reviewer: '$.context.reviewer' } }] },
        { id: 'approved', final: true },
        { id: 'rejected', final: true },
      ],
      transitions: [
        { from: 'draft', event: 'submit', to: 'in-review' },
        { from: 'in-review', event: 'approve', guard: '$.context.reviewer', to: 'approved' },
        { from: 'in-review', event: 'reject', to: 'rejected' },
      ],
    },
    runContext: { reviewer: 'sam' },
  },
  {
    name: 'enrich',
    kind: 'dag',
    title: 'Enrich & report (dataflow)',
    lead: 'Rows flow through a query filter and an async task into a JSLT report — watch the nodes light up as each settles.',
    doc: {
      $dag: '0.1',
      nodes: {
        rows: { kind: 'input' },
        adults: {
          kind: 'query',
          query: { $for: { r: '$[*]' }, $where: { $ge: ['$r.age', 18] }, $return: '$r' },
        },
        stamp: { kind: 'task', run: 'lookup' },
        report: {
          kind: 'jslt',
          stylesheet: [{
            match: '$',
            body: ['ul', {}, [{ $for: { p: '$[*]' }, $return: ['li', {}, '$p.name'] }]],
          }],
        },
        out: { kind: 'output' },
      },
      edges: [
        { from: 'rows', to: 'adults' },
        { from: 'adults', to: 'stamp' },
        { from: 'stamp', to: 'report' },
        { from: 'report', to: 'out' },
      ],
    },
    runInput: [
      { name: 'ada', age: 36 },
      { name: 'kid', age: 8 },
      { name: 'lin', age: 64 },
    ],
  },
  {
    name: 'blank',
    kind: 'fsm',
    title: 'Blank machine',
    lead: 'One start state and nothing else — add states, connect them, name the events in the inspector, then run it.',
    doc: {
      $fsm: '0.1',
      initial: 'start',
      states: ['start'],
      transitions: [],
    },
    runContext: {},
  },
];

/** @param {string} name @returns {any} */
export function flowTemplate(name) {
  return FLOW_TEMPLATES.find((t) => t.name === name) ?? null;
}
