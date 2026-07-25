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

export const ACTIONS = {
  // the @jarenjs/calc sub-app's actions (namespaced 'calc/*' + 'calc-form/*')
  ...calcActions,

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

  // the package-README dialog: open (fetch), receive, fail, close
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
      {
        run: 'readme-load',
        with: { url: '$payload.url', done: 'readme/loaded', error: 'readme/failed' },
      },
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
};

/** The site's subscriptions: the hash router feed, always live. */
export const SUBS = [{ run: 'hash' }];
