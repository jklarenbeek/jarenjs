//@ts-check
import { FLOW_RULES as shared } from '@jarenjs/studio/flow';
export const FLOW_RULES = [
  { ...shared[0], body: ['div', { class: 'page container' },
      ['h1', {}, 'Flow'],
      ['p', { class: 'page-lead' },
        'Executable workflows as one JSON document: a jaren-fsm machine or a jaren-dag dataflow, drawn by the mermaid engine, edited by clicking the diagram, a generated inspector or the diagram text — three views of the same value, patched by RFC 6902 and run live by @jarenjs/flow. No eval, no server.'],
    shared[0].body,
  ] },
  { ...shared[1], body: [...shared[1].body,
      ['p', { class: 'muted' },
        'The formats are specified in ',
        ['a', { href: 'https://github.com/jklarenbeek/jarenjs/blob/main/packages/flow/docs/FLOW-FORMAT.md' },
          'FLOW-FORMAT.md'],
        ', and the engine is measured against XState on the ',
        ['a', { href: '#/benchmarks?suite=flow' }, 'benchmarks page'],
        '.'],
  ] },
  ...shared.slice(2),
];
