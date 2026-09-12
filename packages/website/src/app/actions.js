import { DATA_ACTIONS } from '@jarenjs/studio/data';
import { PROJECT_ACTIONS } from '@jarenjs/studio/component';
//@ts-check
/**
 * The site's actions — every one a Jaren JSON Query document producing
 * a transition (APP-FORMAT §3). Navigation itself needs no actions:
 * links are plain hash anchors and the `hash` subscription dispatches
 * `route/set`. Note how `route/set` computes its fetch effects with
 * `$if` — orchestration as data.
 */

import { FLOW_ACTIONS } from './flow-actions.js';

import { calcActions } from '@jarenjs/calc/component';

import { SUITES } from '../boundaries/bench.js';

/** `?suite=` membership, derived from the one SUITES list: an unknown
 * name must not reach `fetch-bench` (its status pointer cannot hold a
 * `/`, and the fetch would 404) — the viewModel shows the overview plus
 * a no-such-suite callout instead. */
const KNOWN_SUITE = { $or: SUITES.map((s) => ({ $eq: ['$payload.params.suite', s.key] })) };

/** The pages whose cards carry measured headlines from `meta.json`. */
const MEASURED_PAGE = { $or: [
  { $eq: ['$payload.page', 'benchmarks'] },
  { $eq: ['$payload.page', 'home'] },
] };

/** The docs page: it renders the package census in its rail, every
 * workspace's own documentation section beside it, a draft-support
 * scorecard from the validate run, and the site's own compiled document. */
const DOCS_PAGE = { $eq: ['$payload.page', 'docs'] };

/** The home page: it draws its engine grid from the cards half of the
 * site content, and its hero dispatches a real contract operation. */
const HOME_PAGE = { $eq: ['$payload.page', 'home'] };

/** The starting input a hero pick names, of the two the state carries.
 * An action's effects resolve against the state BEFORE its own patch, so
 * the load and the run must read the same expression, not the member the
 * load is about to write. */
const PICKED = { $if: [
  { $eq: ['$payload', 'invalid'] }, '$.hero.presets.invalid', '$.hero.presets.valid',
] };

/** The index of the last recorded stage, or 0 when nothing ran — the
 * settled outcome is the frame a reader wants first. */
const LAST_STAGE = (stages) => ({ $if: [
  { $gt: [{ $count: stages }, 0] },
  { $sub: [{ $count: stages }, 1] },
  0,
] });

export const ACTIONS = {
  // the @jarenjs/calc sub-app's actions (namespaced 'calc/*' + 'calc-form/*')
  ...calcActions,


  // hash changed: store the parsed route and fetch what the page needs.
  // Both fetch handlers dedupe, so repeat visits are free — and a
  // `$if` whose condition is false contributes no element, which is what
  // makes this one flat list instead of nested branches.
  'route/set': {
    patch: [
      { op: 'replace', path: '/route', value: '$payload' },
      { op: 'replace', path: '/menu', value: false },
      { op: 'replace', path: '/navOpen', value: null },
    ],
    effects: [
      // the footer prints the build's provenance on every page, so the
      // reader lands on a page that can already say what produced it
      { run: 'fetch-site', with: { name: 'build' } },
      { $if: [DOCS_PAGE, { run: 'fetch-site', with: { name: 'packages' } }] },
      // the documentation bodies are most of what the workspaces publish
      // about themselves, and only this page renders them; the home grid
      // reads the same entries WITHOUT them, an artifact an order of
      // magnitude smaller
      { $if: [DOCS_PAGE, { run: 'fetch-site', with: { name: 'content' } }] },
      { $if: [HOME_PAGE, { run: 'fetch-site', with: { name: 'cards' } }] },
      // the home page shows measured headlines on its engine cards, so
      // it needs the same meta.json the benchmarks overview reads
      { $if: [MEASURED_PAGE, { run: 'fetch-bench', with: { name: 'meta' } }] },
      // the docs draft-support section publishes the official-suite
      // scorecard, derived from the run itself rather than transcribed
      { $if: [DOCS_PAGE, { run: 'fetch-bench', with: { name: 'validate' } }] },
      // and the contract section renders the site's own compiled
      // document, whose revision is a digest the page must await
      { $if: [DOCS_PAGE, { run: 'site-contract' }] },
      // the hero runs a real dispatch through the real local binding;
      // `initial` makes the arrival free after the first one, while the
      // reader's own Dispatch always re-runs
      { $if: [HOME_PAGE, { run: 'hero-run', with: { initial: true, input: '$.hero.input' } }] },
      {
        $if: [
          {
            $and: [
              MEASURED_PAGE,
              { $exists: '$payload.params.suite' },
              { $ne: ['$payload.params.suite', 'overview'] },
              KNOWN_SUITE,
            ],
          },
          { run: 'fetch-bench', with: { name: '$payload.params.suite' } },
        ],
      },
    ],
  },

  'site/status': {
    patch: [{
      op: 'add',
      path: { $concat: ['/site/status/', '$payload.name'] },
      value: '$payload.status',
    }],
  },

  'site/loaded': {
    patch: [
      { op: 'add', path: { $concat: ['/site/data/', '$payload.name'] }, value: '$payload.data' },
      { op: 'add', path: { $concat: ['/site/status/', '$payload.name'] }, value: 'ready' },
    ],
  },

  // The homepage's living dispatch. The two starting inputs live in
  // state, so picking one is a patch rather than a capability: the
  // action loads it and the same effect runs it, exactly as the reader's
  // own edit does.
  'hero/pick': {
    patch: [
      { op: 'replace', path: '/hero/input', value: PICKED },
      { op: 'replace', path: '/hero/variant', value: '$payload' },
    ],
    effects: [{ run: 'hero-run', with: { input: PICKED } }],
  },

  'hero/edit': {
    patch: [
      { op: 'replace', path: '/hero/input', value: '$event.value' },
      { op: 'replace', path: '/hero/variant', value: 'edited' },
    ],
  },

  'hero/dispatch': { effects: [{ run: 'hero-run', with: { input: '$.hero.input' } }] },

  'hero/running': { patch: [{ op: 'replace', path: '/hero/status', value: 'running' }] },

  'hero/settled': {
    patch: [
      { op: 'replace', path: '/hero/run', value: '$payload' },
      { op: 'replace', path: '/hero/status', value: 'ready' },
      { op: 'replace', path: '/hero/focus', value: LAST_STAGE('$payload.stages[*]') },
      { op: 'replace', path: '/hero/revision', value: { $add: ['$.hero.revision', 1] } },
    ],
  },

  'hero/focus': { patch: [{ op: 'replace', path: '/hero/focus', value: '$payload' }] },

  // stepping wraps, so the control never dead-ends on the last stage
  'hero/step': {
    patch: [{ op: 'replace', path: '/hero/focus', value: { $if: [
      { $lt: ['$.hero.focus', { $sub: [{ $count: '$.hero.run.stages[*]' }, 1] }] },
      { $add: ['$.hero.focus', 1] },
      0,
    ] } }],
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
  // the nav dropdown groups (Engines / Studios / Learn): one open at a time,
  // toggled by its trigger; closed on navigation (route/set), Escape or an
  // outside click (both dispatched from main.js in the browser)
  'nav/toggle': {
    patch: [{ op: 'replace', path: '/navOpen', value: { $if: [{ $eq: ['$.navOpen', '$payload'] }, null, '$payload'] } }],
  },
  'nav/close': {
    patch: [{ op: 'replace', path: '/navOpen', value: null }],
  },
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
  // the market-data socket — nothing connects on page load.
  'charts-live/toggle': { effects: [{ run: 'binance-toggle', with: { target: 'page' } }] },
  'charts-live/set': {
    patch: [{ op: 'add', path: '/chartsLive', value: '$payload' }],
  },

  ...PROJECT_ACTIONS,

  // the Play engine playground (#/play, boundaries/play.js): pick
  // an example (loads its source + first dataset), edit a source/data pane
  // live, or switch datasets; the debounced boundary re-runs the engine.
  'play/example': { effects: [{ run: 'play-load', with: { id: '$payload' } }] },
  'play/loaded': {
    patch: [
      { op: 'replace', path: '/play/engine', value: '$payload.engine' },
      { op: 'replace', path: '/play/exampleId', value: '$payload.exampleId' },
      { op: 'replace', path: '/play/source', value: '$payload.source' },
      { op: 'replace', path: '/play/datasetIndex', value: '$payload.datasetIndex' },
      { op: 'replace', path: '/play/data', value: '$payload.data' },
      { op: 'replace', path: '/play/config', value: '$payload.config' },
      { op: 'replace', path: '/play/result', value: null },
      // an example REPLACES the session's content, so it can no longer be
      // the saved record: unbind, or the next Save would overwrite that
      // record with something the user never saved there
      { op: 'replace', path: '/play/savedName', value: null },
      // a new engine's result has different screens; drop any stale tab,
      // and a fresh example opens CALM — the depth toggle resets off
      { op: 'replace', path: '/play/panel', value: null },
      { op: 'replace', path: '/play/deep', value: false },
      { op: 'replace', path: '/play/deepPick', value: null },
      // the structured form buffer belongs to the example it was parsed
      // from — keep it and the first form edit mirrors the OLD buffer
      // over the new example's data pane (loaded-session resets the same)
      { op: 'replace', path: '/play/dataView', value: 'json' },
      { op: 'replace', path: '/play/dataValue', value: null },
      // on a phone, picking an example answers immediately: show its result
      // (desktop shows every pane, so this is invisible there)
      { op: 'replace', path: '/play/mobilePane', value: 'result' },
    ],
  },
  'play/source': {
    patch: [{ op: 'add', path: { $concat: ['/play/source/', '$payload.key'] }, value: '$event.value' }],
  },
  'play/data': {
    patch: [{ op: 'add', path: { $concat: ['/play/data/', '$payload.key'] }, value: '$event.value' }],
  },
  // a live mode select (josl dialect, csv strict/repair) → the run loop re-runs
  'play/option': {
    patch: [{ op: 'add', path: { $concat: ['/play/config/', '$payload.key'] }, value: '$event.value' }],
  },
  'play/dataset': { effects: [{ run: 'play-dataset', with: { index: '$payload' } }] },
  'play/dataset-set': {
    patch: [
      { op: 'replace', path: '/play/datasetIndex', value: '$payload.index' },
      { op: 'replace', path: '/play/data', value: '$payload.data' },
    ],
  },
  'play/result': { patch: [{ op: 'replace', path: '/play/result', value: '$payload' }] },
  // select a result screen — a pure view switch; the run loop ignores it
  'play/panel': { patch: [{ op: 'replace', path: '/play/panel', value: '$payload' }] },

  // the drill-deeper depth toggle: reveal/hide the deep panels (the view
  // hands the next boolean), and pick among several — both pure view
  // switches the run loop ignores
  'play/deep': { patch: [{ op: 'replace', path: '/play/deep', value: '$payload' }] },
  'play/deep-pick': { patch: [{ op: 'replace', path: '/play/deepPick', value: '$payload' }] },

  // the phone pane switcher (Examples · Editor · Result) — pure chrome,
  // persisted for the session so the choice survives edits and runs
  'play/mobile-pane': { patch: [{ op: 'replace', path: '/play/mobilePane', value: '$payload' }] },

  // the Play IDE: a play session is a saveable/shareable document.
  // New / Save / Save As / Open / Delete / Share are thin wrappers over the
  // play doc-store effects; name / names / shared / ratio are pure chrome
  // (the run loop excludes them, so typing a name never re-runs the engine).
  'play/new': { effects: [{ run: 'play-new' }] },
  // Save writes the record this session is BOUND to (`savedName`); Save As
  // writes the title as a NEW record and rebinds. An unsaved session has
  // nothing to overwrite, so its Save is a Save As by construction.
  'play/save': { effects: [{ run: 'play-save' }] },
  'play/save-as': { effects: [{ run: 'play-save', with: { as: true } }] },
  'play/open': { effects: [{ run: 'play-open', with: { name: '$event.value' } }] },
  'play/delete-session': { effects: [{ run: 'play-delete', with: { name: '$payload' } }] },
  'play/share': { effects: [{ run: 'play-share' }] },
  // the way out of the browser when a session is too big for a link (and
  // the way back in): the session as a file, and a file as a session
  'play/download': { effects: [{ run: 'play-download' }] },
  'play/import': { effects: [{ run: 'play-import' }] },
  'play/name': { patch: [{ op: 'replace', path: '/play/name', value: '$event.value' }] },
  'play/names': { patch: [{ op: 'replace', path: '/play/names', value: '$payload' }] },
  // a save landed: adopt the record it wrote, so Save now overwrites it
  'play/saved': {
    patch: [
      { op: 'replace', path: '/play/savedName', value: '$payload.name' },
      { op: 'replace', path: '/play/name', value: '$payload.name' },
      { op: 'replace', path: '/play/names', value: '$payload.names' },
    ],
  },
  'play/shared': { patch: [{ op: 'replace', path: '/play/shared', value: '$payload' }] },
  'play/layout-ratio': { patch: [{ op: 'replace', path: '/play/ratio', value: '$payload' }] },
  // seed engine+source+data+config from a saved/shared/blank session, then run
  'play/loaded-session': {
    patch: [
      { op: 'replace', path: '/play/engine', value: '$payload.engine' },
      { op: 'replace', path: '/play/exampleId', value: '$payload.exampleId' },
      { op: 'replace', path: '/play/source', value: '$payload.source' },
      { op: 'replace', path: '/play/data', value: '$payload.data' },
      { op: 'replace', path: '/play/config', value: '$payload.config' },
      { op: 'replace', path: '/play/name', value: '$payload.name' },
      // a loaded record binds; a blank or SHARED session does not (a share
      // link is not a local record, so its first Save must ask for a name)
      { op: 'replace', path: '/play/savedName', value: { $default: ['$payload.savedName', null] } },
      { op: 'replace', path: '/play/datasetIndex', value: 0 },
      { op: 'replace', path: '/play/result', value: null },
      { op: 'replace', path: '/play/panel', value: null },
      { op: 'replace', path: '/play/deep', value: false },
      { op: 'replace', path: '/play/deepPick', value: null },
      { op: 'replace', path: '/play/shared', value: null },
      { op: 'replace', path: '/play/dataView', value: 'json' },
      { op: 'replace', path: '/play/dataValue', value: null },
    ],
  },

  // the validate engine's data pane toggles JSON ↔ a generated form.
  // Switching to the form parses the current text into the structured buffer
  // (a host effect); a form edit mirrors the buffer back to the text, which
  // re-validates. The buffer + toggle are excluded from the re-run trigger.
  'play/data-view': { effects: [{ run: 'play-data-view', with: { view: '$payload' } }] },
  'play/data-view-set': { patch: [
    { op: 'replace', path: '/play/dataView', value: '$payload.view' },
    { op: 'replace', path: '/play/dataValue', value: '$payload.value' },
  ] },
  'play/data-mirror': { patch: [{ op: 'add', path: '/play/data/data', value: '$payload' }] },
  // the six standard form actions, writing into `/play/dataValue` —
  // mirrored from @jarenjs/app's createFormActions, with play-scoped names
  'play/f-input': { patch: [{ op: { $if: [{ $or: ['$payload.element', { $eq: ['$payload.pointer', ''] }] }, 'replace', 'add'] }, path: { $concat: ['/play/dataValue', '$payload.pointer'] }, value: '$event.value' }] },
  'play/f-check': { patch: [{ op: { $if: [{ $or: ['$payload.element', { $eq: ['$payload.pointer', ''] }] }, 'replace', 'add'] }, path: { $concat: ['/play/dataValue', '$payload.pointer'] }, value: '$event.checked' }] },
  'play/f-number': { patch: [{ op: { $if: [{ $or: ['$payload.element', { $eq: ['$payload.pointer', ''] }] }, 'replace', 'add'] }, path: { $concat: ['/play/dataValue', '$payload.pointer'] }, value: { $if: [{ $ne: ['$event.value', ''] }, { $number: '$event.value' }, null] } }] },
  'play/f-json': { patch: [{ op: { $if: [{ $or: ['$payload.element', { $eq: ['$payload.pointer', ''] }] }, 'replace', 'add'] }, path: { $concat: ['/play/dataValue', '$payload.pointer'] }, value: '$event.formJsonValue' }] },
  'play/f-add': { patch: [{ op: 'add', path: { $concat: ['/play/dataValue', '$payload.pointer', '/-'] }, value: '$payload.value' }] },
  'play/f-remove': { patch: [{ op: 'remove', path: { $concat: ['/play/dataValue', '$payload.pointer'] } }] },

  ...DATA_ACTIONS,

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
  // an in-page link inside a rendered document: scroll, and change
  // nothing else — the route belongs to the page behind the dialog
  'readme/anchor': {
    effects: [{ run: 'scroll-to-anchor', with: { id: '$payload.id' } }],
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

  // ----------------------------------------------------------------
  // The Flow studio. Every gesture is an RFC 6902 patch against
  // /flow/doc; mutating gestures first snapshot the document into the
  // history ring (copy-on-write makes snapshots cheap) and clear the
  // redo side. Even the delete CASCADES are query-built — no JS
  // assembles a patch anywhere on this page.
  // ----------------------------------------------------------------

  ...FLOW_ACTIONS,
};

/** The site's subscriptions: the hash router feed, always live. */
export const SUBS = [
  { run: 'hash' },
  // the data studio boots its owner worker the first time the route
  // reaches #/data — a dynamic subscription whose `when` is the page; the
  // subscription (`ownerSub` in boundaries/data.js) fires the boot once
  // per runtime, and `data/retry` is the only other way to boot
  { run: 'data-owner', when: { $eq: ['$.route.page', 'data'] } },
];
