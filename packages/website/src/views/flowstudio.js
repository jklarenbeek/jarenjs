//@ts-check
/**
 * The Flow studio — mode 'flow', dispatched with `$.ui.flow` as the
 * current node. One jaren-fsm or jaren-dag document, edited three ways
 * that cannot disagree: clicking the diagram (every gesture an RFC 6902
 * patch), the forms-generated inspector, and the mermaid text pane —
 * plus a live run mode where the same document boots a nested
 * @jarenjs/app (machines) or a compileDag run (dataflow).
 *
 * The stylesheet renders derived projections only; the document itself
 * lives at `state.flow.doc` and every mutation goes through the
 * actions' patches — no pane owns private truth.
 *
 * Below the breakpoint the three cards become one pane at a time behind
 * the shared segmented switcher (Diagram · Inspector · Run); selecting
 * a node jumps to the inspector and running jumps to the run pane, so a
 * phone never leaves the user looking at the pane they just left.
 */

import { paneSwitcher } from './studio-kit.js';

const paletteBtn = (label, action, opts = {}) =>
  ['button', {
    type: 'button', class: 'btn small',
    ...(opts.disabledIf ? { disabled: { $if: [opts.disabledIf, true, false] } } : {}),
    on: { click: action },
  }, label];

const canvasCard =
  ['div', { key: 'flow-canvas-card', class: 'card pg-card flow-canvas-card' },
    ['div', { class: 'card-head' },
      ['h3', {}, { $if: ['$.isFsm', 'Machine', 'Dataflow'] }],
      ['div', { class: 'flow-palette' },
        { $if: ['$.isFsm',
          paletteBtn('Add state', 'flow/add-state'),
          paletteBtn('Add node', 'flow/add-node')] },
        { $if: ['$.connectArmed',
          ['button', { type: 'button', class: 'btn small flow-armed', on: { click: 'flow/connect-cancel' } },
            'Click a target…'],
          ['button', {
            type: 'button', class: 'btn small',
            disabled: { $if: ['$.canConnect', false, true] },
            on: { click: 'flow/connect-arm' },
          }, 'Connect']] },
        ['button', {
          type: 'button', class: 'btn small',
          disabled: { $if: ['$.canDelete', false, true] },
          on: { click: 'flow/delete' },
        }, 'Delete'],
        ['button', {
          type: 'button', class: 'btn small',
          disabled: { $if: ['$.canUndo', false, true] },
          on: { click: 'flow/undo' },
        }, 'Undo'],
        ['button', {
          type: 'button', class: 'btn small',
          disabled: { $if: ['$.canRedo', false, true] },
          on: { click: 'flow/redo' },
        }, 'Redo'],
        ['button', { type: 'button', class: 'btn small', on: { click: 'flow/clear' } }, 'New'],
      ],
    ],
    ['div', { class: 'flow-tabs' },
      ['button', {
        type: 'button',
        class: { $if: [{ $eq: ['$.tab', 'diagram'] }, 'btn small active', 'btn small'] },
        on: { click: { action: 'flow/tab', with: 'diagram' } },
      }, 'Diagram'],
      ['button', {
        type: 'button',
        class: { $if: [{ $eq: ['$.tab', 'text'] }, 'btn small active', 'btn small'] },
        on: { click: { action: 'flow/tab', with: 'text' } },
      }, 'Text'],
    ],
    { $if: [{ $eq: ['$.tab', 'diagram'] },
      ['div', { key: 'flow-canvas', class: 'flow-canvas' }, '$.diagram'],
      ['div', { key: 'flow-text' },
        ['textarea', {
          class: 'editor flow-text',
          rows: 14,
          spellcheck: 'false',
          value: '$.text',
          readonly: { $if: ['$.textReadOnly', true, false] },
          on: { change: 'flow/text' },
        }],
        { $if: ['$.textReadOnly',
          ['p', { class: 'muted' },
            'Read-only: ', '$.textLossReason',
            ' — edit through the diagram or the inspector instead.'],
          ['p', { class: 'muted' },
            'Edits apply when the field loses focus — the text re-parses, projects back to the document, and a broken edit never replaces it.']] },
      ]] },
    { $if: ['$.parseError', ['p', { class: 'error-line' }, '$.parseError']] },
  ];

const inspectorCard =
  ['div', { key: 'flow-inspector-card', class: 'card pg-card flow-inspector' },
    ['div', { class: 'card-head' },
      ['h3', {}, 'Inspector'],
      { $if: ['$.selection', ['span', { class: 'muted' }, '$.selection.label']] },
    ],
    { $if: ['$.inspector',
      ['div', { key: 'flow-inspector-form' }, { $apply: '$.inspector.form' }],
      ['p', { class: 'muted' },
        'Select a state, node or edge in the diagram to edit it here — every field writes straight into the document.']] },
  ];

const fsmRun =
  ['div', { key: 'flow-run-fsm' },
    { $if: ['$.run',
      ['div', {},
        ['div', { class: 'flow-run-head' },
          ['div', { class: 'flow-run-buttons' },
            [{ $for: { e: '$.events[*]' },
              $return: ['button', {
                type: 'button', class: 'btn small',
                on: { click: { action: 'flow/send', with: '$e' } },
              }, '$e'] }],
          ],
          ['button', { type: 'button', class: 'btn small', on: { click: 'flow/stop' } }, 'Stop'],
        ],
        ['div', { class: 'flow-run-mount' },
          ['jaren-widget', { name: 'flow-doc', key: 'flow-run-app', props: '$.mount' }]],
        ['ul', { class: 'flow-log' }, [{ $for: { l: '$.run.logLines[*]' },
          $return: ['li', { class: 'flow-log-line' }, '$l'] }]],
      ],
      ['div', {},
        ['p', { class: 'muted' },
          'Boot the machine as a real nested @jarenjs/app: the generated per-event actions drive it, and the diagram highlights the current state.'],
        ['button', { type: 'button', class: 'btn', on: { click: 'flow/run' } }, 'Run machine'],
      ]] },
  ];

const dagRun =
  ['div', { key: 'flow-run-dag' },
    ['label', { class: 'muted' }, 'Run input (JSON)'],
    // published per keystroke, not on blur: a run streams per-node updates,
    // and each render reasserts this controlled textarea — with a stale
    // value it would overwrite whatever was being typed for the next run
    ['textarea', {
      class: 'editor flow-dag-input', rows: 4, spellcheck: 'false',
      value: '$.dagInput', on: { input: 'flow/dag-input', change: 'flow/dag-input' },
    }],
    ['div', { class: 'flow-run-head' },
      ['button', { type: 'button', class: 'btn', on: { click: 'flow/dag-run' } }, 'Run graph'],
      { $if: ['$.run.running',
        ['button', { type: 'button', class: 'btn small', on: { click: 'flow/dag-abort' } }, 'Abort']] },
    ],
    { $if: ['$.run',
      ['div', {},
        { $if: ['$.run.error', ['p', { class: 'error-line' }, '$.run.error']] },
        { $if: ['$.run.outputText',
          ['pre', { class: 'code-block flow-output' }, ['code', {}, '$.run.outputText']]] },
        ['ul', { class: 'flow-log' }, [{ $for: { l: '$.run.logLines[*]' },
          $return: ['li', { class: 'flow-log-line' }, '$l'] }]],
      ]] },
  ];

const runCard =
  ['div', { key: 'flow-run-card', class: 'card pg-card flow-run' },
    ['div', { class: 'card-head' }, ['h3', {}, 'Run']],
    { $if: ['$.isFsm', fsmRun, dagRun] },
  ];

export const FLOW_RULES = [
  {
    match: '$.ui.flow', mode: 'flow',
    body: ['div', { class: 'page container' },
      ['h1', {}, 'Flow'],
      ['p', { class: 'page-lead' },
        'Executable workflows as one JSON document: a jaren-fsm machine or a jaren-dag dataflow, drawn by the mermaid engine, edited by clicking the diagram, a generated inspector or the diagram text — three views of the same value, patched by RFC 6902 and run live by @jarenjs/flow. No eval, no server.'],
      { $apply: '$.picker' },
      { $apply: '$.live' },
    ],
  },
  {
    match: '$.ui.flow.picker', mode: 'flow',
    body: ['div', { key: 'flow-picker' },
      ['p', { class: 'page-lead' },
        'Start from a seed — a complete, runnable document either way.'],
      ['div', { class: 'example-grid' }, [{ $apply: '$.templates[*]' }]],
      ['p', { class: 'muted' },
        'The formats are specified in ',
        ['a', { href: 'https://github.com/jklarenbeek/jarenjs/blob/main/packages/flow/docs/FLOW-FORMAT.md' },
          'FLOW-FORMAT.md'],
        ', and the engine is measured against XState on the ',
        ['a', { href: '#/benchmarks?suite=flow' }, 'benchmarks page'],
        '.'],
    ],
  },
  {
    match: '$.ui.flow.picker.templates[*]', mode: 'flow',
    body: ['article', { class: 'card example-card' },
      ['div', { class: 'card-head' },
        ['h3', {}, '$.title'],
        ['button', {
          type: 'button', class: 'btn small',
          on: { click: { action: 'flow/template', with: '$.name' } },
        }, 'Load'],
      ],
      ['p', { class: 'muted' }, '$.lead'],
      ['pre', { class: 'code-block clamp' }, ['code', {}, '$.preview']],
    ],
  },
  {
    match: '$.ui.flow.live', mode: 'flow',
    body: ['div', { key: 'flow-live', class: 'flow-grid', 'data-pane': '$.mobilePane' },
      paneSwitcher({
        class: 'flow-panebar', pane: '$.mobilePane', action: 'flow/pane',
        panes: [['diagram', 'Diagram'], ['inspector', 'Inspector'], ['run', 'Run']],
      }),
      canvasCard,
      ['div', { key: 'flow-side', class: 'flow-side' }, inspectorCard, runCard],
    ],
  },
];
