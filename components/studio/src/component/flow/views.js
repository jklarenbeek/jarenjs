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

import { createFormView } from '@jarenjs/app';
import { paneSwitcher } from '../shared/studio-kit.js';

const paletteBtn = (label, action, opts = {}) =>
  ['button', {
    type: 'button', class: 'btn small',
    ...(opts.disabledIf ? { disabled: { $if: [opts.disabledIf, true, false] } } : {}),
    on: { click: action },
  }, label];

const canvasCard =
  ['div', { key: 'flow-canvas-card', class: 'card pg-card flow-canvas-card' },
    ['div', { class: 'card-head' },
      ['h3', {}, { $if: ['$.isFsm', '$.w.machine', '$.w.dataflow'] }],
      ['div', { class: 'flow-palette' },
        { $if: ['$.isFsm',
          paletteBtn('$.w.addState', 'flow/add-state'),
          paletteBtn('$.w.addNode', 'flow/add-node')] },
        { $if: ['$.connectArmed',
          ['button', { type: 'button', class: 'btn small flow-armed', on: { click: 'flow/connect-cancel' } },
            '$.w.connectArmed'],
          paletteBtn('$.w.connect', 'flow/connect-arm', { disabledIf: { $not: '$.canConnect' } })] },
        paletteBtn('$.w.delete', 'flow/delete', { disabledIf: { $not: '$.canDelete' } }),
        paletteBtn('$.w.undo', 'flow/undo', { disabledIf: { $not: '$.canUndo' } }),
        paletteBtn('$.w.redo', 'flow/redo', { disabledIf: { $not: '$.canRedo' } }),
        paletteBtn('$.w.new', 'flow/clear'),
      ],
    ],
    ['div', { class: 'flow-tabs' },
      ['button', {
        type: 'button',
        class: { $if: [{ $eq: ['$.tab', 'diagram'] }, 'btn small active', 'btn small'] },
        on: { click: { action: 'flow/tab', with: 'diagram' } },
      }, '$.w.tabDiagram'],
      ['button', {
        type: 'button',
        class: { $if: [{ $eq: ['$.tab', 'text'] }, 'btn small active', 'btn small'] },
        on: { click: { action: 'flow/tab', with: 'text' } },
      }, '$.w.tabText'],
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
          ['p', { class: 'muted' }, '$.readOnlyText'],
          ['p', { class: 'muted' }, '$.w.textHint']] },
      ]] },
    { $if: ['$.parseError', ['p', { class: 'error-line' }, '$.parseError']] },
  ];

const inspectorCard =
  ['div', { key: 'flow-inspector-card', class: 'card pg-card flow-inspector' },
    ['div', { class: 'card-head' },
      ['h3', {}, '$.w.inspector'],
      { $if: ['$.selection', ['span', { class: 'muted' }, '$.selection.label']] },
    ],
    { $if: ['$.inspector',
      ['div', { key: 'flow-inspector-form' }, { $apply: '$.inspector.form' }],
      ['p', { class: 'muted' }, '$.w.inspectorHint']] },
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
          ['button', { type: 'button', class: 'btn small', on: { click: 'flow/stop' } }, '$.w.stop'],
        ],
        ['div', { class: 'flow-run-mount' },
          ['jaren-widget', { name: 'flow-doc', key: 'flow-run-app', props: '$.mount' }]],
        ['ul', { class: 'flow-log' }, [{ $for: { l: '$.run.logLines[*]' },
          $return: ['li', { class: 'flow-log-line' }, '$l'] }]],
      ],
      ['div', {},
        ['p', { class: 'muted' }, '$.w.runMachineHint'],
        ['button', { type: 'button', class: 'btn', on: { click: 'flow/run' } }, '$.w.runMachine'],
      ]] },
  ];

const dagRun =
  ['div', { key: 'flow-run-dag' },
    ['label', { class: 'muted' }, '$.w.runInput'],
    // published per keystroke, not on blur: a run streams per-node updates,
    // and each render reasserts this controlled textarea — with a stale
    // value it would overwrite whatever was being typed for the next run
    ['textarea', {
      class: 'editor flow-dag-input', rows: 4, spellcheck: 'false',
      value: '$.dagInput', on: { input: 'flow/dag-input', change: 'flow/dag-input' },
    }],
    ['div', { class: 'flow-run-head' },
      ['button', { type: 'button', class: 'btn', on: { click: 'flow/dag-run' } }, '$.w.runGraph'],
      { $if: ['$.run.running',
        ['button', { type: 'button', class: 'btn small', on: { click: 'flow/dag-abort' } }, '$.w.abort']] },
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
    ['div', { class: 'card-head' }, ['h3', {}, '$.w.run']],
    { $if: ['$.isFsm', fsmRun, dagRun] },
  ];

export const FLOW_RULES = [
  {
    match: '$.ui.flow', mode: 'flow',
    body: ['div', { class: 'jaren-flow-editor' },
      { $apply: '$.picker' },
      { $apply: '$.live' },
    ],
  },
  {
    match: '$.ui.flow.picker', mode: 'flow',
    body: ['div', { key: 'flow-picker' },
      ['p', { class: 'page-lead' }, '$.w.lead'],
      ['div', { class: 'example-grid' }, [{ $apply: '$.templates[*]' }]],
    ],
  },
  {
    match: '$.ui.flow.picker.templates[*]', mode: 'flow',
    body: ['article', { class: 'card example-card' },
      ['div', { class: 'card-head' },
        ['h3', { lang: 'en', dir: 'ltr' }, '$.title'],
        ['button', {
          type: 'button', class: 'btn small',
          on: { click: { action: 'flow/template', with: '$.name' } },
        }, '$.w.load'],
      ],
      // a seed's lead is its library's prose, English by design
      ['p', { class: 'muted', lang: 'en', dir: 'ltr' }, '$.lead'],
      ['pre', { class: 'code-block clamp' }, ['code', {}, '$.preview']],
    ],
  },
  {
    match: '$.ui.flow.live', mode: 'flow',
    body: ['div', { key: 'flow-live', class: 'flow-grid', 'data-pane': '$.mobilePane' },
      paneSwitcher({
        class: 'flow-panebar', pane: '$.mobilePane', action: 'flow/pane', label: '$.w.panes',
        panes: [['diagram', '$.w.paneDiagram'], ['inspector', '$.w.paneInspector'], ['run', '$.w.paneRun']],
      }),
      canvasCard,
      ['div', { key: 'flow-side', class: 'flow-side' }, inspectorCard, runCard],
    ],
  },
];

// the form's chrome reads the live node's `formLabels`: the reader's language
export const FLOW_FORM_RULES = createFormView({ root: '$.ui.flow.live.inspector.form', labelsPath: '$.ui.flow.live.formLabels', actions: {
  input: 'flow/f-input', check: 'flow/f-check', number: 'flow/f-number',
  json: 'flow/f-json', add: 'flow/f-add', remove: 'flow/f-remove',
} }).map(rule => ({ ...rule, mode: 'flow' }));
