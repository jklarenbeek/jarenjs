// @ts-check
/** Shared by the standalone flow page and the isolated project editor. */
export const FLOW_ACTIONS = {
  'flow/template': { effects: [{ run: 'flow-template', with: { name: '$payload' } }] },

  'flow/load': {
    patch: [
      { op: 'replace', path: '/flow/kind', value: '$payload.kind' },
      { op: 'replace', path: '/flow/doc', value: '$payload.doc' },
      { op: 'replace', path: '/flow/selection', value: null },
      { op: 'replace', path: '/flow/connect', value: null },
      { op: 'replace', path: '/flow/tab', value: 'diagram' },
      { op: 'replace', path: '/flow/parseError', value: null },
      { op: 'replace', path: '/flow/history', value: { past: [], future: [] } },
      { op: 'replace', path: '/flow/run', value: null },
      { op: 'replace', path: '/flow/runContext', value: '$payload.runContext' },
      { op: 'replace', path: '/flow/dagInput', value: '$payload.dagInput' },
    ],
  },

  'flow/clear': {
    patch: [
      { op: 'replace', path: '/flow/kind', value: null },
      { op: 'replace', path: '/flow/doc', value: null },
      { op: 'replace', path: '/flow/selection', value: null },
      { op: 'replace', path: '/flow/connect', value: null },
      { op: 'replace', path: '/flow/parseError', value: null },
      { op: 'replace', path: '/flow/history', value: { past: [], future: [] } },
      { op: 'replace', path: '/flow/run', value: null },
    ],
  },

  'flow/tab': { patch: [{ op: 'replace', path: '/flow/tab', value: '$payload' }] },
  // the phone pane switcher (Diagram · Inspector · Run) — pure chrome;
  // `tab` (Diagram ↔ Text) is a different axis and stays independent
  'flow/pane': { patch: [{ op: 'replace', path: '/flow/mobilePane', value: '$payload' }] },

  // A diagram click: plain pick — unless a connect source is armed and
  // a node was clicked, in which case this IS the connect commit.
  'flow/pick': {
    $if: [
      { $and: [
        '$.flow.connect',
        { $or: [{ $eq: ['$payload.type', 'state'] }, { $eq: ['$payload.type', 'node'] }] },
      ] },
      { $if: [
        { $eq: ['$.flow.kind', 'fsm'] },
        { patch: [
          { op: 'add', path: '/flow/history/past/-', value: '$.flow.doc' },
          { op: 'replace', path: '/flow/history/future', value: [] },
          { op: 'add', path: '/flow/doc/transitions/-',
            value: { from: '$.flow.connect', event: null, to: '$payload.id' } },
          { op: 'replace', path: '/flow/connect', value: null },
          { op: 'replace', path: '/flow/selection', value: {
            type: 'transition',
            index: { $count: '$.flow.doc.transitions[*]' },
            path: { $concat: ['/transitions/', { $string: { $count: '$.flow.doc.transitions[*]' } }] },
          } },
        ] },
        { patch: [
          { op: 'add', path: '/flow/history/past/-', value: '$.flow.doc' },
          { op: 'replace', path: '/flow/history/future', value: [] },
          { op: 'add', path: '/flow/doc/edges/-',
            value: { from: '$.flow.connect', to: '$payload.id' } },
          { op: 'replace', path: '/flow/connect', value: null },
          { op: 'replace', path: '/flow/selection', value: {
            type: 'edge',
            index: { $count: '$.flow.doc.edges[*]' },
            path: { $concat: ['/edges/', { $string: { $count: '$.flow.doc.edges[*]' } }] },
          } },
        ] },
      ] },
      { patch: [
        { op: 'replace', path: '/flow/connect', value: null },
        { op: 'replace', path: '/flow/selection', value: '$payload' },
        // a plain pick IS "show me this one" — on a phone the inspector
        // is a different pane, so the gesture carries the user to it.
        // The connect-commit branches above deliberately do not: mid-
        // connect the diagram is where the next click has to land.
        { op: 'replace', path: '/flow/mobilePane', value: 'inspector' },
      ] },
    ],
  },

  'flow/connect-arm': {
    $if: [
      { $or: [{ $eq: ['$.flow.selection.type', 'state'] }, { $eq: ['$.flow.selection.type', 'node'] }] },
      { patch: [{ op: 'replace', path: '/flow/connect', value: '$.flow.selection.id' }] },
    ],
  },
  'flow/connect-cancel': { patch: [{ op: 'replace', path: '/flow/connect', value: null }] },

  // Adding mints the new id in a JS effect (`flow-mint`): a count-based
  // `'s' + (count + 1)` id may already exist after a delete — on the nodes
  // object an add would then REPLACE the user's node, and on the states
  // array it would append a duplicate id. The *-minted actions receive
  // the uniqueness-scanned id via payload and stay plain patches.
  'flow/add-state': { effects: [{ run: 'flow-mint', with: { kind: 'state' } }] },
  'flow/add-node': { effects: [{ run: 'flow-mint', with: { kind: 'node' } }] },

  'flow/state-minted': {
    patch: [
      { op: 'add', path: '/flow/history/past/-', value: '$.flow.doc' },
      { op: 'replace', path: '/flow/history/future', value: [] },
      { op: 'add', path: '/flow/doc/states/-', value: '$payload' },
      { op: 'replace', path: '/flow/selection', value: {
        type: 'state',
        id: '$payload',
        path: { $concat: ['/states/', { $string: { $count: '$.flow.doc.states[*]' } }] },
      } },
    ],
  },

  'flow/node-minted': {
    patch: [
      { op: 'add', path: '/flow/history/past/-', value: '$.flow.doc' },
      { op: 'replace', path: '/flow/history/future', value: [] },
      { op: 'add',
        path: { $concat: ['/flow/doc/nodes/', '$payload'] },
        value: { kind: 'task', run: '$payload' } },
      { op: 'replace', path: '/flow/selection', value: {
        type: 'node',
        id: '$payload',
        path: { $concat: ['/nodes/', '$payload'] },
      } },
    ],
  },

  // Deleting a state or node cascades to every transition/edge that
  // references it — the cascade is computed BY THE QUERY (a filtered
  // rebuild of the document); simple members are a computed remove.
  'flow/delete': {
    $if: [
      { $eq: ['$.flow.selection.type', 'state'] },
      { patch: [
        { op: 'add', path: '/flow/history/past/-', value: '$.flow.doc' },
        { op: 'replace', path: '/flow/history/future', value: [] },
        { op: 'replace', path: '/flow/doc', value: { $map: [
          ['$$fsm', '0.1'],
          ['initial', { $if: [
            { $eq: ['$.flow.doc.initial', '$.flow.selection.id'] }, null, '$.flow.doc.initial'] }],
          ['states', [{ $for: { s: '$.flow.doc.states[*]' },
            $where: { $ne: [{ $if: [{ '$is-string': '$s' }, '$s', '$s.id'] }, '$.flow.selection.id'] },
            $return: '$s' }]],
          ['transitions', [{ $for: { t: '$.flow.doc.transitions[*]' },
            $where: { $and: [
              { $ne: ['$t.from', '$.flow.selection.id'] },
              { $ne: ['$t.to', '$.flow.selection.id'] } ] },
            $return: '$t' }]],
        ] } },
        { op: 'replace', path: '/flow/selection', value: null },
        { op: 'replace', path: '/flow/connect', value: null },
      ] },
      { $if: [
        { $eq: ['$.flow.selection.type', 'node'] },
        { patch: [
          { op: 'add', path: '/flow/history/past/-', value: '$.flow.doc' },
          { op: 'replace', path: '/flow/history/future', value: [] },
          { op: 'replace', path: '/flow/doc', value: { $map: [
            ['$$dag', '0.1'],
            ['nodes', { '$from-entries': { $for: { e: { $entries: '$.flow.doc.nodes' } },
              $where: { $ne: ['$e.key', '$.flow.selection.id'] },
              $return: '$e' } }],
            ['edges', [{ $for: { g: '$.flow.doc.edges[*]' },
              $where: { $and: [
                { $ne: ['$g.from', '$.flow.selection.id'] },
                { $ne: ['$g.to', '$.flow.selection.id'] } ] },
              $return: '$g' }]],
          ] } },
          { op: 'replace', path: '/flow/selection', value: null },
          { op: 'replace', path: '/flow/connect', value: null },
        ] },
        { patch: [
          { op: 'add', path: '/flow/history/past/-', value: '$.flow.doc' },
          { op: 'replace', path: '/flow/history/future', value: [] },
          { op: 'remove', path: { $concat: ['/flow/doc', '$.flow.selection.path'] } },
          { op: 'replace', path: '/flow/selection', value: null },
        ] },
      ] },
    ],
  },

  'flow/undo': {
    $if: [{ $exists: '$.flow.history.past[*]' }, { patch: [
      { op: 'add', path: '/flow/history/future/-', value: '$.flow.doc' },
      { op: 'replace', path: '/flow/doc', value: '$.flow.history.past[-1]' },
      { op: 'remove', path: { $concat: ['/flow/history/past/',
        { $string: { $sub: [{ $count: '$.flow.history.past[*]' }, 1] } }] } },
      { op: 'replace', path: '/flow/selection', value: null },
    ] }],
  },
  'flow/redo': {
    $if: [{ $exists: '$.flow.history.future[*]' }, { patch: [
      { op: 'add', path: '/flow/history/past/-', value: '$.flow.doc' },
      { op: 'replace', path: '/flow/doc', value: '$.flow.history.future[-1]' },
      { op: 'remove', path: { $concat: ['/flow/history/future/',
        { $string: { $sub: [{ $count: '$.flow.history.future[*]' }, 1] } }] } },
      { op: 'replace', path: '/flow/selection', value: null },
    ] }],
  },

  // The text pane commits through the fail-closed parse effect: a
  // broken edit reports here and never touches the document.
  'flow/text': { effects: [{ run: 'flow-parse', with: { text: '$event.value', kind: '$.flow.kind' } }] },
  'flow/parsed': {
    patch: [
      { op: 'add', path: '/flow/history/past/-', value: '$.flow.doc' },
      { op: 'replace', path: '/flow/history/future', value: [] },
      { op: 'replace', path: '/flow/doc', value: '$payload.doc' },
      { op: 'replace', path: '/flow/parseError', value: null },
      { op: 'replace', path: '/flow/selection', value: null },
    ],
  },
  'flow/parse-error': { patch: [{ op: 'replace', path: '/flow/parseError', value: '$payload.message' }] },

  // Machine runs: the nested sandbox app boots from the generated
  // actions (the host widget owns its lifecycle; `revision` reboots).
  'flow/run': {
    patch: [
      { op: 'replace', path: '/flow/run', value: { current: '$.flow.doc.initial', prev: null, log: [] } },
      { op: 'replace', path: '/flow/revision', value: { $add: ['$.flow.revision', 1] } },
      // booting is a request to WATCH it run (phone only; desktop shows
      // every pane, so this patch is invisible there)
      { op: 'replace', path: '/flow/mobilePane', value: 'run' },
    ],
  },
  'flow/stop': { patch: [{ op: 'replace', path: '/flow/run', value: null }] },
  'flow/send': { effects: [{ run: 'flow-run-send', with: { event: '$payload' } }] },
  'flow/run-tx': {
    $if: ['$.flow.run', { patch: [
      // capture the state we're leaving BEFORE overwriting current, so
      // the diagram can glow the transition just taken
      { op: 'replace', path: '/flow/run/prev', value: '$.flow.run.current' },
      { op: 'replace', path: '/flow/run/current', value: '$payload.current' },
      { op: 'add', path: '/flow/run/log/-', value: '$payload' },
    ] }],
  },
  'flow/run-log': {
    $if: ['$.flow.run', { patch: [{ op: 'add', path: '/flow/run/log/-', value: '$payload' }] }],
  },

  // Dag runs: compile + execute through the boundary effect; per-node
  // settlement records tint the diagram live.
  'flow/dag-input': { patch: [{ op: 'replace', path: '/flow/dagInput', value: '$event.value' }] },
  'flow/dag-run': {
    patch: [
      { op: 'replace', path: '/flow/run',
        value: { running: true, nodes: {}, output: null, error: null, log: [] } },
      { op: 'replace', path: '/flow/mobilePane', value: 'run' },
    ],
    effects: [{ run: 'flow-dag-run', with: { doc: '$.flow.doc', inputText: '$.flow.dagInput' } }],
  },
  'flow/dag-node': {
    $if: ['$.flow.run', { patch: [
      { op: 'add', path: { $concat: ['/flow/run/nodes/', '$payload.id'] }, value: '$payload.status' },
      { op: 'add', path: '/flow/run/log/-', value: '$payload' },
    ] }],
  },
  'flow/dag-done': {
    $if: ['$.flow.run', { patch: [
      { op: 'replace', path: '/flow/run/running', value: false },
      { op: 'replace', path: '/flow/run/output', value: '$payload.output' },
    ] }],
  },
  'flow/dag-fail': {
    $if: ['$.flow.run', { patch: [
      { op: 'replace', path: '/flow/run/running', value: false },
      { op: 'replace', path: '/flow/run/error', value: '$payload.message' },
    ] }],
  },
  'flow/dag-abort': { effects: [{ run: 'flow-dag-abort' }] },

  // The inspector writes through the six standard form actions,
  // mirrored from @jarenjs/app's createFormActions with one change:
  // the target prepends the SELECTION's pointer, so one static action
  // set serves whichever member is selected.
  'flow/f-input': { patch: [{
    op: { $if: [{ $or: ['$payload.element', { $eq: ['$payload.pointer', ''] }] }, 'replace', 'add'] },
    path: { $concat: ['/flow/doc', '$.flow.selection.path', '$payload.pointer'] },
    value: '$event.value' }] },
  'flow/f-check': { patch: [{
    op: { $if: [{ $or: ['$payload.element', { $eq: ['$payload.pointer', ''] }] }, 'replace', 'add'] },
    path: { $concat: ['/flow/doc', '$.flow.selection.path', '$payload.pointer'] },
    value: '$event.checked' }] },
  'flow/f-number': { patch: [{
    op: { $if: [{ $or: ['$payload.element', { $eq: ['$payload.pointer', ''] }] }, 'replace', 'add'] },
    path: { $concat: ['/flow/doc', '$.flow.selection.path', '$payload.pointer'] },
    value: { $if: [{ $ne: ['$event.value', ''] }, { $number: '$event.value' }, null] } }] },
  'flow/f-json': { patch: [{
    op: { $if: [{ $or: ['$payload.element', { $eq: ['$payload.pointer', ''] }] }, 'replace', 'add'] },
    path: { $concat: ['/flow/doc', '$.flow.selection.path', '$payload.pointer'] },
    value: '$event.formJsonValue' }] },
  'flow/f-add': { patch: [{
    op: 'add',
    path: { $concat: ['/flow/doc', '$.flow.selection.path', '$payload.pointer', '/-'] },
    value: '$payload.value' }] },
  'flow/f-remove': { patch: [{
    op: 'remove',
    path: { $concat: ['/flow/doc', '$.flow.selection.path', '$payload.pointer'] } }] },
};

// SVG groups need the keyboard activation native buttons provide.
FLOW_ACTIONS['flow/key-pick'] = { $if: [{ $or: [
  { $eq: ['$event.key', 'Enter'] }, { $eq: ['$event.key', ' '] },
] }, FLOW_ACTIONS['flow/pick']] };

// Publication uses the same serialized transition queue as every manual gesture.
FLOW_ACTIONS['flow/replace'] = { $if: [
  { $eq: [{ kind: '$.flow.kind', doc: '$.flow.doc' }, '$payload.expected'] },
  { patch: [
    { op: 'add', path: '/flow/history/past/-', value: '$.flow.doc' },
    { op: 'replace', path: '/flow/history/future', value: [] },
    { op: 'replace', path: '/flow/kind', value: '$payload.kind' },
    { op: 'replace', path: '/flow/doc', value: '$payload.doc' },
    { op: 'replace', path: '/flow/selection', value: null },
    { op: 'replace', path: '/flow/connect', value: null },
    { op: 'replace', path: '/flow/parseError', value: null },
    { op: 'replace', path: '/flow/run', value: null },
  ], effects: [{ run: 'flow-accepted', with: '$payload.requestId' }] },
  { effects: [{ run: 'flow-refused', with: '$payload.requestId' }] },
] };
FLOW_ACTIONS['flow/execute'] = {
  patch: [
    { op: 'replace', path: '/flow/runContext', value: '$payload.input' },
    { op: 'replace', path: '/flow/dagInput', value: '$payload.inputText' },
    { op: 'replace', path: '/flow/run', value: { $if: [{ $eq: ['$.flow.kind', 'dag'] },
      { running: true, nodes: {}, output: null, error: null, log: [] }, '$.flow.run'] } },
    { op: 'replace', path: '/flow/mobilePane', value: 'run' },
  ],
  effects: [{ run: 'flow-editor-run', with: { requestId: '$payload.requestId', kind: '$.flow.kind', doc: '$.flow.doc', inputText: '$payload.inputText', event: '$payload.event' } }],
};
