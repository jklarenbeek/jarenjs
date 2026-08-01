//@ts-check
/**
 * The site's actions — every one a Jaren JSON Query document producing
 * a transition (APP-FORMAT §3). Navigation itself needs no actions:
 * links are plain hash anchors and the `hash` subscription dispatches
 * `route/set`. Note how `route/set` computes its fetch effects with
 * `$if` — orchestration as data.
 */

import { createFormActions } from '@jarenjs/app';
import { calcActions } from '@jarenjs/calc/component';
import { GAME_ACTIONS } from '../boundaries/game.js';

export const ACTIONS = {
  // the @jarenjs/calc sub-app's actions (namespaced 'calc/*' + 'calc-form/*')
  ...calcActions,

  // the adventure game: scene/go-* (flow-engine navigation) + game/* verbs
  ...GAME_ACTIONS,

  // hash changed: store the parsed route and fetch what the page needs
  // (the fetch-bench handler dedupes, so repeat visits are free)
  'route/set': {
    patch: [
      { op: 'replace', path: '/route', value: '$payload' },
      { op: 'replace', path: '/menu', value: false },
    ],
    effects: {
      $if: [
        // the home page shows measured headlines on its engine cards,
        // so it needs the same meta.json the benchmarks overview reads
        { $or: [
          { $eq: ['$payload.page', 'benchmarks'] },
          { $eq: ['$payload.page', 'home'] },
        ] },
        [
          { run: 'fetch-bench', with: { name: 'meta' } },
          {
            $if: [
              {
                $and: [
                  { $exists: '$payload.params.suite' },
                  { $ne: ['$payload.params.suite', 'overview'] },
                ],
              },
              { run: 'fetch-bench', with: { name: '$payload.params.suite' } },
            ],
          },
        ],
        [],
      ],
    },
  },

  'bench/status': {
    patch: [{
      op: 'add',
      path: { $concat: ['/benchStatus/', '$payload.name'] },
      value: '$payload.status',
    }],
  },

  'bench/loaded': {
    patch: [
      { op: 'add', path: { $concat: ['/bench/', '$payload.name'] }, value: '$payload.data' },
      { op: 'add', path: { $concat: ['/benchStatus/', '$payload.name'] }, value: 'ready' },
    ],
  },

  'theme/toggle': {
    patch: [{
      op: 'replace',
      path: '/theme',
      value: { $if: [{ $eq: ['$.theme', 'dark'] }, 'light', 'dark'] },
    }],
    effects: [{
      run: 'apply-theme',
      with: { theme: { $if: [{ $eq: ['$.theme', 'dark'] }, 'light', 'dark'] } },
    }],
  },

  // playground: the schema editor (live per keystroke, revalidated by
  // the wire() subscriber watching the changed-path feed)
  'pg/schema-text': {
    patch: [{ op: 'replace', path: '/pg/schemaText', value: '$event.value' }],
  },

  // playground: the JSON data pane commits on change (blur)
  'pg/data-text': {
    effects: [{ run: 'parse-data', with: { text: '$event.value' } }],
  },
  'pg/data-set': {
    patch: [
      { op: 'replace', path: '/pg/data', value: '$payload' },
      { op: 'replace', path: '/pg/dataError', value: null },
    ],
  },
  'pg/data-error': {
    patch: [{ op: 'replace', path: '/pg/dataError', value: '$payload' }],
  },

  'pg/result': {
    patch: [{ op: 'replace', path: '/pg/result', value: '$payload' }],
  },
  'pg/data-tab': {
    patch: [{ op: 'replace', path: '/pg/dataTab', value: '$payload' }],
  },
  'pg/locale': {
    patch: [{ op: 'replace', path: '/pg/locale', value: '$payload' }],
  },
  'pg/example': {
    patch: [
      { op: 'replace', path: '/pg/schemaText', value: '$payload.schemaText' },
      { op: 'replace', path: '/pg/data', value: '$payload.data' },
      { op: 'replace', path: '/pg/dataError', value: null },
    ],
  },

  // the generic engine playgrounds: one input action for every field of
  // every engine, one loader for example chips and experiments
  'eng/input': {
    patch: [{
      op: 'add',
      path: { $concat: ['/eng/', '$payload.engine', '/', '$payload.key'] },
      value: '$event.value',
    }],
  },
  'eng/load': {
    patch: [{
      op: 'replace',
      path: { $concat: ['/eng/', '$payload.engine'] },
      value: '$payload.inputs',
    }],
  },
  'eng/result': {
    patch: [{
      op: 'add',
      path: { $concat: ['/engResults/', '$payload.engine'] },
      value: '$payload.result',
    }],
  },

  // benchmark deep-dive controls
  'bench/search': {
    patch: [
      { op: 'replace', path: '/benchUi/search', value: '$event.value' },
      { op: 'replace', path: '/benchUi/limit', value: 40 },
    ],
  },
  'bench/more': {
    patch: [{ op: 'replace', path: '/benchUi/limit', value: { $add: ['$.benchUi.limit', 80] } }],
  },

  // the mobile navigation drawer
  'menu/toggle': {
    patch: [{ op: 'replace', path: '/menu', value: { $not: '$.menu' } }],
  },

  // the experiment store (the IDE): state holds names only; the
  // snapshots live in localStorage behind the ide-* effects
  'ide/name': {
    patch: [{ op: 'replace', path: '/ide/name', value: '$event.value' }],
  },
  'ide/names': {
    patch: [{ op: 'replace', path: '/ide/names', value: '$payload' }],
  },
  'ide/save': { effects: [{ run: 'ide-save' }] },
  'ide/load': { effects: [{ run: 'ide-load', with: { name: '$payload' } }] },
  'ide/delete': { effects: [{ run: 'ide-delete', with: { name: '$payload' } }] },
  'ide/share': { effects: [{ run: 'ide-share' }] },
  'ide/shared': {
    patch: [{ op: 'replace', path: '/ide/shared', value: '$payload' }],
  },

  // the Binance live demo: an explicit user gesture opens (or closes)
  // the market-data socket — nothing connects on page load. Two
  // surfaces, one controller: the playground charts engine and the
  // /charts page each toggle their own target.
  'binance/toggle': { effects: [{ run: 'binance-toggle', with: { target: 'playground' } }] },
  'charts-live/toggle': { effects: [{ run: 'binance-toggle', with: { target: 'page' } }] },
  'charts-live/set': {
    patch: [{ op: 'add', path: '/chartsLive', value: '$payload' }],
  },

  // examples page: load an example into the playground and go there
  'ex/open': { effects: [{ run: 'open-example', with: '$payload' }] },

  // the Studio: swapping the hosted document is ATOMIC — only an
  // already-validated document reaches 'studio/doc' (the studio-parse
  // effect and the assistant tools validate first); a failed validation
  // lands in 'studio/errors' and the old document stays live
  'studio/doc': {
    patch: [
      { op: 'replace', path: '/studio/doc', value: '$payload.doc' },
      { op: 'replace', path: '/studio/errors', value: null },
      { op: 'replace', path: '/studio/error', value: null },
      { op: 'replace', path: '/studio/revision', value: { $add: ['$.studio.revision', 1] } },
    ],
  },
  'studio/errors': {
    patch: [{ op: 'replace', path: '/studio/errors', value: '$payload' }],
  },
  // boot/runtime failures from the nested app's own error sink (the
  // host widget emits these — they never throw into the site's render)
  'studio/error': {
    patch: [{ op: 'replace', path: '/studio/error', value: '$payload' }],
  },
  'studio/clear': {
    patch: [
      { op: 'replace', path: '/studio/doc', value: null },
      { op: 'replace', path: '/studio/errors', value: null },
      { op: 'replace', path: '/studio/error', value: null },
    ],
  },
  // the JSON editor commits on change (blur), like the data pane
  'studio/text': { effects: [{ run: 'studio-parse', with: { text: '$event.value' } }] },
  'studio/template': { effects: [{ run: 'studio-template', with: { name: '$payload' } }] },
  'studio/download': { effects: [{ run: 'studio-download' }] },

  // the package-README dialog: open (fetch), receive, fail, close.
  // Opening from the docs page starts a fresh navigation trail; a
  // repo-relative link inside the rendered document navigates in place
  // ('readme/navigate' pushes onto the trail), and back/forward replay
  // it ('readme-hist' owns the stack arithmetic).
  'readme/open': {
    patch: [
      { op: 'replace', path: '/readme/open', value: true },
      { op: 'replace', path: '/readme/title', value: '$payload.title' },
      { op: 'replace', path: '/readme/url', value: '$payload.url' },
      { op: 'replace', path: '/readme/status', value: 'loading' },
      { op: 'replace', path: '/readme/source', value: null },
      { op: 'replace', path: '/readme/message', value: null },
    ],
    effects: [
      { run: 'lock-scroll', with: { on: true } },
      { run: 'readme-hist', with: { kind: 'reset', title: '$payload.title', url: '$payload.url' } },
      {
        run: 'readme-load',
        with: { url: '$payload.url', done: 'readme/loaded', error: 'readme/failed' },
      },
    ],
  },
  'readme/navigate': {
    patch: [
      { op: 'replace', path: '/readme/title', value: '$payload.title' },
      { op: 'replace', path: '/readme/url', value: '$payload.url' },
      { op: 'replace', path: '/readme/status', value: 'loading' },
      { op: 'replace', path: '/readme/source', value: null },
      { op: 'replace', path: '/readme/message', value: null },
    ],
    effects: [
      { run: 'readme-hist', with: { kind: 'push', title: '$payload.title', url: '$payload.url' } },
      {
        run: 'readme-load',
        with: { url: '$payload.url', done: 'readme/loaded', error: 'readme/failed' },
      },
    ],
  },
  // show a trail entry without changing the trail (back/forward land here)
  'readme/show': {
    patch: [
      { op: 'replace', path: '/readme/title', value: '$payload.title' },
      { op: 'replace', path: '/readme/url', value: '$payload.url' },
      { op: 'replace', path: '/readme/status', value: 'loading' },
      { op: 'replace', path: '/readme/source', value: null },
      { op: 'replace', path: '/readme/message', value: null },
    ],
    effects: [
      {
        run: 'readme-load',
        with: { url: '$payload.url', done: 'readme/loaded', error: 'readme/failed' },
      },
    ],
  },
  'readme/back': { effects: [{ run: 'readme-hist', with: { kind: 'back' } }] },
  'readme/forward': { effects: [{ run: 'readme-hist', with: { kind: 'forward' } }] },
  // a README link to the site itself: close the dialog and route in-app
  'readme/goto': {
    patch: [{ op: 'replace', path: '/readme/open', value: false }],
    effects: [
      { run: 'lock-scroll', with: { on: false } },
      { run: 'readme-goto', with: { hash: '$payload.hash' } },
    ],
  },
  'readme/history': {
    patch: [
      { op: 'replace', path: '/readme/stack', value: '$payload.stack' },
      { op: 'replace', path: '/readme/at', value: '$payload.at' },
    ],
  },
  'readme/loaded': {
    patch: [
      { op: 'replace', path: '/readme/source', value: '$payload' },
      { op: 'replace', path: '/readme/status', value: 'ready' },
    ],
  },
  'readme/failed': {
    patch: [
      { op: 'replace', path: '/readme/status', value: 'error' },
      { op: 'replace', path: '/readme/message', value: '$payload' },
    ],
  },
  'readme/close': {
    patch: [{ op: 'replace', path: '/readme/open', value: false }],
    effects: [{ run: 'lock-scroll', with: { on: false } }],
  },

  // the browser-side AI assistant (@jarenjs/ai): a slide-out chat panel
  // that drives the playground through schema-guarded tools. The API key
  // lives only in the `ai` slice (never in share links or experiments).
  'ai/toggle': {
    patch: [{ op: 'replace', path: '/ai/open', value: { $not: '$.ai.open' } }],
    // opening while unconfigured pins the settings form open (see
    // ai-ensure-settings), so it cannot vanish mid-edit as typing
    // makes the configuration valid
    effects: [{ run: 'ai-ensure-settings' }],
  },
  'ai/settings-toggle': {
    patch: [{ op: 'replace', path: '/ai/settingsOpen', value: { $not: '$.ai.settingsOpen' } }],
  },
  'ai/settings-open': {
    patch: [{ op: 'replace', path: '/ai/settingsOpen', value: '$payload' }],
  },
  'ai/setting': {
    patch: [
      {
        op: 'add',
        path: { $concat: ['/ai/settings/', '$payload.key'] },
        value: '$event.value',
      },
      // an edited connection voids the last probe verdict
      { op: 'replace', path: '/ai/probe', value: { status: 'idle', detail: null, models: [] } },
    ],
  },
  'ai/probe': {
    patch: [{
      op: 'replace',
      path: '/ai/probe',
      value: { status: 'busy', detail: null, models: [] },
    }],
    effects: [{ run: 'ai-probe' }],
  },
  'ai/probe-result': {
    patch: [{ op: 'replace', path: '/ai/probe', value: '$payload' }],
  },
  'ai/save-settings': {
    patch: [{ op: 'replace', path: '/ai/settingsOpen', value: false }],
    effects: [{ run: 'ai-save-settings' }],
  },
  'ai/draft': {
    patch: [{ op: 'replace', path: '/ai/draft', value: '$event.value' }],
  },
  'ai/send': { effects: [{ run: 'ai-send' }] },
  // the streaming turn dispatches these back as it runs; every action
  // that changes the transcript mirrors it to storage via ai-persist
  'ai/user': {
    patch: [
      { op: 'add', path: '/ai/messages/-', value: { role: 'user', content: '$payload' } },
      { op: 'replace', path: '/ai/draft', value: '' },
      { op: 'replace', path: '/ai/pending', value: '' },
      { op: 'replace', path: '/ai/status', value: 'streaming' },
      { op: 'replace', path: '/ai/activity', value: null },
      { op: 'replace', path: '/ai/error', value: null },
      { op: 'replace', path: '/ai/reasoningChars', value: 0 },
    ],
    effects: [{ run: 'ai-persist' }],
  },
  'ai/delta': {
    patch: [{ op: 'replace', path: '/ai/pending', value: { $concat: ['$.ai.pending', '$payload'] } }],
  },
  // reasoning models stream thinking before (or instead of) content;
  // the panel shows its growing size while nothing visible arrives
  'ai/reasoning': {
    patch: [{ op: 'replace', path: '/ai/reasoningChars', value: { $add: ['$.ai.reasoningChars', '$payload'] } }],
  },
  'ai/activity': {
    patch: [{ op: 'replace', path: '/ai/activity', value: '$payload' }],
  },
  'ai/reply': {
    patch: [
      { op: 'add', path: '/ai/messages/-', value: { role: 'assistant', content: '$payload' } },
      { op: 'replace', path: '/ai/pending', value: '' },
      { op: 'replace', path: '/ai/status', value: 'idle' },
      { op: 'replace', path: '/ai/activity', value: null },
    ],
    effects: [{ run: 'ai-persist' }],
  },
  'ai/failed': {
    patch: [
      { op: 'replace', path: '/ai/status', value: 'error' },
      { op: 'replace', path: '/ai/error', value: '$payload' },
      { op: 'replace', path: '/ai/pending', value: '' },
      { op: 'replace', path: '/ai/activity', value: null },
    ],
  },
  'ai/clear': {
    patch: [
      { op: 'replace', path: '/ai/messages', value: [] },
      { op: 'replace', path: '/ai/pending', value: '' },
      { op: 'replace', path: '/ai/status', value: 'idle' },
      { op: 'replace', path: '/ai/activity', value: null },
      { op: 'replace', path: '/ai/error', value: null },
    ],
    effects: [{ run: 'ai-persist' }],
  },

  // the generated form writes through the standard form actions
  ...createFormActions({ dataPointer: '/pg/data' }),

  // ----------------------------------------------------------------
  // The Flow studio. Every gesture is an RFC 6902 patch against
  // /flow/doc; mutating gestures first snapshot the document into the
  // history ring (copy-on-write makes snapshots cheap) and clear the
  // redo side. Even the delete CASCADES are query-built — no JS
  // assembles a patch anywhere on this page.
  // ----------------------------------------------------------------

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

  'flow/add-state': {
    patch: [
      { op: 'add', path: '/flow/history/past/-', value: '$.flow.doc' },
      { op: 'replace', path: '/flow/history/future', value: [] },
      { op: 'add', path: '/flow/doc/states/-',
        value: { $concat: ['s', { $string: { $add: [{ $count: '$.flow.doc.states[*]' }, 1] } }] } },
      { op: 'replace', path: '/flow/selection', value: {
        type: 'state',
        id: { $concat: ['s', { $string: { $add: [{ $count: '$.flow.doc.states[*]' }, 1] } }] },
        path: { $concat: ['/states/', { $string: { $count: '$.flow.doc.states[*]' } }] },
      } },
    ],
  },

  'flow/add-node': {
    patch: [
      { op: 'add', path: '/flow/history/past/-', value: '$.flow.doc' },
      { op: 'replace', path: '/flow/history/future', value: [] },
      { op: 'add',
        path: { $concat: ['/flow/doc/nodes/n', { $string: { $add: [{ $count: '$.flow.doc.nodes[*]' }, 1] } }] },
        value: { kind: 'task',
          run: { $concat: ['n', { $string: { $add: [{ $count: '$.flow.doc.nodes[*]' }, 1] } }] } } },
      { op: 'replace', path: '/flow/selection', value: {
        type: 'node',
        id: { $concat: ['n', { $string: { $add: [{ $count: '$.flow.doc.nodes[*]' }, 1] } }] },
        path: { $concat: ['/nodes/n', { $string: { $add: [{ $count: '$.flow.doc.nodes[*]' }, 1] } }] },
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

/** The site's subscriptions: the hash router feed, always live. */
export const SUBS = [{ run: 'hash' }];
