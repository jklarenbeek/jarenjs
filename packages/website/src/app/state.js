import { createDataState } from '@jarenjs/studio/data';
import { createFlowState } from '@jarenjs/studio/flow';
import { createProjectState } from '@jarenjs/studio/component';
//@ts-check
/**
 * The initial application state — one JSON document. Everything the
 * site knows at runtime lives here (or is derived from here in the
 * viewModel boundary); compiled artifacts never do.
 */

import { calcInitialState } from '@jarenjs/calc/component';

import { STARTER_PROJECT } from '../content/projectTemplates.js';
import { PLAY_START } from '../boundaries/play.js';
import { HERO_INPUTS } from '../content/hero.js';



/**
 * @param {string} [theme]
 * @param {string[]} [ideNames] - saved experiment names from storage
 * @returns {any} a fresh initial state
 */
export function createInitialState(theme = 'light', ideNames = [], playNames = []) {
  return {
    route: { page: 'home', params: {} },
    theme,
    menu: false,      // the mobile navigation drawer
    navOpen: null,    // the open nav dropdown group key ('engines'|'studios'|'learn') or null
    bench: {},        // file name -> parsed benchmark JSON
    benchStatus: {},  // file name -> 'loading' | 'ready' | 'error'
    benchUi: { search: '', limit: 40 },

    // what the build generated ABOUT this repository, fetched like the
    // benchmark files: `packages` is the census the docs rail renders
    // (the published workspaces, derived from their manifests) and
    // `build` is the provenance the footer prints. Both are absent until
    // their fetch lands, so every surface reading them renders its own
    // honest waiting state rather than a stale hand-written answer.
    site: { data: {}, status: {} },

    // the homepage's living dispatch: the input document a reader can
    // edit, and the last RECORDED run of it through @jarenjs/contract's
    // local binding (boundaries/hero.js). `run` is null until the first
    // dispatch settles — the hero renders its own waiting state rather
    // than a stage list nothing produced. `focus` is which recorded
    // stage shows its artifact; `revision` bumps per settled run, which
    // is what re-mounts the stage list so its entrance plays again.
    hero: {
      presets: { ...HERO_INPUTS },
      input: HERO_INPUTS.valid,
      variant: 'valid',      // 'valid' | 'invalid' | 'edited'
      status: 'idle',        // 'idle' | 'running' | 'ready'
      run: null,
      focus: 0,
      revision: 0,
    },

    chartsLive: null,            // /charts page live-feed render nodes
    ide: { name: '', names: ideNames, shared: null },

    // the Project IDE (boundaries/project.js): a jaren-project — a small
    // tree of typed files (app / jslt / query / data / …) edited as ONE
    // document. Each file validates against its own grammar; the active
    // `app` file boots live in an isolated nested app whose
    // reboot-vs-hot-update is driven by classifyChange. `mount` is the
    // last-good assembled app ({ name, doc, revision }); `revision` bumps
    // only on a STRUCTURAL change, so a state-only edit hot-dispatches
    // (app.setState) with no reboot, and an INVALID edit keeps `mount`
    // (the last good frame never blanks). Seeded from the starter template.
    project: createProjectState(STARTER_PROJECT),

    // the Play engine playground (boundaries/play.js): pick an engine
    // + an example, edit the source or the data, it runs live. Ephemeral —
    // `source`/`data` are the editable pane buffers (keyed by pane),
    // `datasetIndex` selects among an example's datasets, `result` is the
    // last run. Seeded with the first example loaded.
    play: { ...PLAY_START, source: { ...PLAY_START.source }, data: { ...PLAY_START.data }, config: { ...PLAY_START.config }, names: playNames },

    // the Flow studio (boundaries/flowstudio.js): a jaren-fsm or
    // jaren-dag document edited three ways that cannot disagree —
    // clicking the diagram, the forms inspector, the mermaid text —
    // because every gesture is an RFC 6902 patch against `doc`.
    // `connect` holds the armed click-to-connect source; `history` is
    // the COW snapshot ring (undo/redo); `run` is the live run's
    // observable state; `revision` bumps per run boot so the nested-app
    // host widget knows when to reboot.
    flow: createFlowState(),

    calc: calcInitialState(),    // the @jarenjs/calc sub-app slice

    // the data studio (boundaries/data.js): the browser store over the
    // OPFS-backed wasm driver. A worker owns the connection; this slice
    // holds the derived text panes and the last observed results/live
    // set. Booted on first navigation to #/data.
    data: { ...createDataState(), collection: 'notes' },

    // the package-README dialog: a fetched Markdown source rendered by
    // the @jarenjs/md visual component in a near-fullscreen overlay.
    // `stack`/`at` are the dialog's own navigation history — repo-
    // relative links inside a README load in place, and back/forward
    // walk the trail without touching the browser history.
    readme: {
      open: false, title: '', url: null, status: 'idle', source: null, message: null,
      stack: [], at: -1,
    },
  };
}
