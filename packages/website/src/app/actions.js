//@ts-check
/**
 * The site's actions — every one a Jaren JSON Query document producing
 * a transition (APP-FORMAT §3). Navigation itself needs no actions:
 * links are plain hash anchors and the `hash` subscription dispatches
 * `route/set`. Note how `route/set` computes its fetch effects with
 * `$if` — orchestration as data.
 */

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
      { op: 'replace', path: '/navOpen', value: null },
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

  // the Project IDE (#/project, boundaries/project.js): a jaren-project
  // edited as one document. The editor commits the ACTIVE file's text
  // through the `project-edit` effect (it rewrites the file by name, in
  // JS — an array index a patch path cannot compute); the changed
  // `/project/files` feed then drives the debounced commit
  // (`project/committed`) that folds in the last-good app stage.
  // every keystroke publishes to the typing buffer. This is what the
  // CONTROLLED editor is reasserted with: without it a render between the
  // keystroke and the blur would rewrite the box with the still-stale
  // committed text, clearing the browser's dirty-value flag so the commit
  // never fires and the typing is lost. Cheap by construction — it touches
  // no file, so nothing revalidates.
  'project/buffer-text': {
    patch: [{
      op: 'replace',
      path: '/project/buffer',
      value: { file: '$.project.active', text: '$event.value', dirty: true },
    }],
  },
  // resolve a conflict the human's way round: drop the buffer, so the
  // incoming (committed) text is what the editor shows
  'project/buffer-accept': {
    patch: [{ op: 'replace', path: '/project/buffer', value: null }],
  },
  // the commit (blur): the buffer has served its purpose, so it clears
  // here — on the HUMAN's own commit, never on `project/files-set`, which
  // is also how an AI write lands and must not drop a dirty buffer
  'project/file-text': {
    patch: [{ op: 'replace', path: '/project/buffer', value: null }],
    effects: [{ run: 'project-edit', with: { text: '$event.value' } }],
  },
  'project/files-set': {
    patch: [
      { op: 'replace', path: '/project/files', value: '$payload.files' },
      { op: 'replace', path: '/project/dirty', value: true },
    ],
  },
  // switching files drops the buffer: it belongs to the file you left
  'project/active': {
    patch: [
      { op: 'replace', path: '/project/active', value: '$payload' },
      { op: 'replace', path: '/project/buffer', value: null },
      // picking a file in the rail — or an error line in the strip — is a
      // request to EDIT it, and on a phone the rail is a different pane
      // from the editor. Carry the user across (invisible on desktop).
      { op: 'replace', path: '/project/mobilePane', value: 'editor' },
    ],
  },
  // the debounced boundary reports the last-good app mount + reboot
  // revision (an invalid edit keeps the previous — the stage never blanks)
  'project/committed': {
    patch: [
      { op: 'replace', path: '/project/mount', value: '$payload.mount' },
      { op: 'replace', path: '/project/revision', value: '$payload.revision' },
      { op: 'replace', path: '/project/dirty', value: false },
    ],
  },
  // explicit Run: force-commit + restart the app stage (or re-run a
  // transform file). Pressing Run is a request to watch it happen, so on
  // a phone the stage comes forward with it.
  'project/run': {
    patch: [{ op: 'replace', path: '/project/mobilePane', value: 'stage' }],
    effects: [{ run: 'project-run' }],
  },
  // a transform file's run result (render nodes) — keyed by file name
  'project/result': {
    patch: [{ op: 'add', path: { $concat: ['/project/results/', '$payload.name'] }, value: '$payload.result' }],
  },
  // file management: add (a kind from the rail select), delete (× per row),
  // rename (the editor-head name field). Each rewrites the files array in
  // JS (an effect), then a patch action lands the result; a name change
  // resets the mount/results so the stage re-establishes cleanly.
  'project/add-file': { effects: [{ run: 'project-add', with: { kind: '$event.value' } }] },
  'project/delete': { effects: [{ run: 'project-delete', with: { name: '$payload' } }] },
  'project/rename': { effects: [{ run: 'project-rename', with: { name: '$event.value' } }] },
  'project/added': {
    patch: [
      { op: 'replace', path: '/project/files', value: '$payload.files' },
      { op: 'replace', path: '/project/active', value: '$payload.active' },
      { op: 'replace', path: '/project/dirty', value: true },
      { op: 'replace', path: '/project/buffer', value: null },
    ],
  },
  'project/structural': {
    patch: [
      { op: 'replace', path: '/project/files', value: '$payload.files' },
      { op: 'replace', path: '/project/active', value: '$payload.active' },
      { op: 'replace', path: '/project/mount', value: null },
      { op: 'replace', path: '/project/results', value: {} },
      { op: 'replace', path: '/project/dirty', value: true },
      { op: 'replace', path: '/project/buffer', value: null },
    ],
  },
  // the nested app's own boot/runtime failure (the stage widget emits it)
  'project/stage-error': { patch: [{ op: 'replace', path: '/project/stageError', value: '$payload' }] },
  // open a whole project (a template card, or an inbound share token)
  'project/open': {
    patch: [
      { op: 'replace', path: '/project/project', value: { $default: ['$payload.project', '0.1'] } },
      { op: 'replace', path: '/project/name', value: '$payload.name' },
      { op: 'replace', path: '/project/files', value: '$payload.files' },
      { op: 'replace', path: '/project/active', value: '$payload.active' },
      { op: 'replace', path: '/project/layout', value: '$payload.layout' },
      { op: 'replace', path: '/project/mount', value: null },
      { op: 'replace', path: '/project/revision', value: 0 },
      { op: 'replace', path: '/project/dirty', value: false },
      { op: 'replace', path: '/project/results', value: {} },
      { op: 'replace', path: '/project/stageError', value: null },
      { op: 'replace', path: '/project/buffer', value: null },
      // opening a project is a request to SEE it — on a phone that means
      // the stage, not the editor it happens to have activated (the same
      // move `play/loaded` makes when an example is picked). Desktop
      // shows every pane, so this patch is invisible there.
      { op: 'replace', path: '/project/mobilePane', value: 'stage' },
    ],
  },
  'project/template': { effects: [{ run: 'project-template', with: { id: '$payload' } }] },
  // download the designated app file's document (the Studio's takeaway)
  'project/download': { effects: [{ run: 'project-download' }] },
  // the layout switcher (which grid mode) + the splitter (where the handle
  // sits within that mode); the splitter widget commits on pointer-up
  'project/layout-mode': { patch: [{ op: 'replace', path: '/project/layout/mode', value: '$payload' }] },
  'project/layout-ratio': { patch: [{ op: 'replace', path: '/project/layout/ratio', value: '$payload' }] },
  // the phone pane switcher (Files · Editor · Stage) — pure chrome, and
  // deliberately NOT part of `layout`: `layout` is a jaren-project member
  // that saves, shares and downloads with the document, and which pane a
  // phone happened to be showing is not a property of the project
  'project/pane': { patch: [{ op: 'replace', path: '/project/mobilePane', value: '$payload' }] },

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

  // the data studio (boundaries/data.js): boot the owner worker, edit
  // the model/query panes, run + explain, insert, live-event, migrate.
  // A patch-only action carries its changed paths to the O(k) renderer.
  'data/boot': { effects: [{ run: 'data-boot' }] },
  'data/seed': {
    patch: [
      { op: 'replace', path: '/data/modelText', value: '$payload.modelText' },
      { op: 'replace', path: '/data/queryText', value: '$payload.queryText' },
    ],
  },
  // the phone pane switcher (Store · Query · Live) — pure chrome; the
  // store, its live query and its worker are untouched by it
  'data/pane': { patch: [{ op: 'replace', path: '/data/mobilePane', value: '$payload' }] },
  'data/model-text': { patch: [{ op: 'replace', path: '/data/modelText', value: '$event.value' }] },
  'data/query-text': { patch: [{ op: 'replace', path: '/data/queryText', value: '$event.value' }] },
  'data/open': { effects: [{ run: 'data-open', with: { text: '$.data.modelText' } }] },
  'data/run': { effects: [{ run: 'data-run', with: { text: '$.data.queryText' } }] },
  'data/insert': { effects: [{ run: 'data-insert', with: { title: '$event.value' } }] },
  'data/migrate': { effects: [{ run: 'data-migrate' }] },
  'data/status': {
    patch: [
      { op: 'replace', path: '/data/topology', value: '$payload.topology' },
      { op: 'replace', path: '/data/vfs', value: '$payload.vfs' },
      { op: 'replace', path: '/data/version', value: { $default: ['$payload.version', ''] } },
      { op: 'replace', path: '/data/refusal', value: { $default: ['$payload.refusal', null] } },
    ],
  },
  'data/opened': {
    patch: [
      { op: 'replace', path: '/data/status', value: 'ready' },
      { op: 'replace', path: '/data/capture', value: '$payload.capabilities.capture' },
      { op: 'replace', path: '/data/version', value: '$payload.capabilities.version' },
      { op: 'replace', path: '/data/operators',
        value: { $default: ['$payload.capabilities.operators', []] } },
      { op: 'replace', path: '/data/pushableOperators',
        value: { $default: ['$payload.capabilities.pushableOperators', []] } },
    ],
  },
  'data/rows': { patch: [{ op: 'replace', path: '/data/rows', value: '$payload.rows' }] },
  'data/results': {
    patch: [
      { op: 'replace', path: '/data/results', value: '$payload.results' },
      { op: 'replace', path: '/data/explain', value: '$payload.explain' },
      { op: 'replace', path: '/data/error', value: null },
    ],
  },
  'data/live': {
    patch: [{ op: 'replace', path: '/data/live',
      value: { mode: '$payload.mode', rows: '$payload.rows', seq: null } }],
  },
  'data/live-event': {
    patch: [
      { op: 'replace', path: '/data/live/rows', value: '$payload.rows' },
      { op: 'replace', path: '/data/live/seq', value: '$payload.seq' },
    ],
  },
  'data/migrated': { patch: [{ op: 'replace', path: '/data/migration', value: '$payload.report' }] },
  'data/error': { patch: [{ op: 'replace', path: '/data/error', value: '$payload.message' }] },

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

  // the browser-side AI assistant (@jarenjs/ai): a slide-out chat panel
  // that drives the site through schema-guarded tools. The API key
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

/** The site's subscriptions: the hash router feed, always live. */
export const SUBS = [
  { run: 'hash' },
  // the data studio boots its owner worker the first time the route
  // reaches #/data — a dynamic subscription whose `when` is the page,
  // so it fires once and the effect's own `booted` guard keeps it idempotent
  { run: 'data-owner', when: { $eq: ['$.route.page', 'data'] } },
];
