//@ts-check
/**
 * The initial application state — one JSON document. Everything the
 * site knows at runtime lives here (or is derived from here in the
 * viewModel boundary); compiled artifacts never do.
 */

import { calcInitialState } from '@jarenjs/calc/component';
import { START_LOCATION } from '../content/gameContent.js';
import { STARTER_PROJECT } from '../content/projectTemplates.js';
import { PLAY_START } from '../boundaries/play.js';

export const DEFAULT_AI_SETTINGS = {
  provider: 'openrouter',  // 'openrouter' | 'ollama' | 'lmstudio' | 'custom'
  baseUrl: '',             // required for 'custom'; overrides the preset otherwise
  model: '',               // e.g. 'qwen/qwen3-4b' or a local model name
  apiKey: '',              // bring your own; local runtimes need none
};

/**
 * @param {string} [theme]
 * @param {string[]} [ideNames] - saved experiment names from storage
 * @param {any} [aiSettings] - persisted assistant settings, if any
 * @param {any} [aiChat] - persisted assistant transcript, if any
 * @returns {any} a fresh initial state
 */
export function createInitialState(theme = 'light', ideNames = [], aiSettings = null, aiChat = null, playNames = []) {
  return {
    route: { page: 'home', params: {} },
    theme,
    menu: false,      // the mobile navigation drawer
    navOpen: null,    // the open nav dropdown group key ('engines'|'studios'|'learn') or null
    bench: {},        // file name -> parsed benchmark JSON
    benchStatus: {},  // file name -> 'loading' | 'ready' | 'error'
    benchUi: { search: '', limit: 40 },
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
    project: {
      ...STARTER_PROJECT,
      mount: null,       // last-good { name, doc, revision } for the active app
      revision: 0,       // reboot key — bumps only on a structural change
      dirty: false,      // the editor has uncommitted text
      // the editor's typing buffer ({ file, text, dirty } or null): every
      // keystroke lands here, the commit lands on blur. It is what the
      // controlled textarea is reasserted with, so a render mid-edit cannot
      // overwrite the user; a write arriving on the same file while it is
      // dirty raises a conflict instead of clobbering either side.
      buffer: null,
      results: {},       // file name -> a run result (query/jslt: later order)
      stageError: null,  // the nested app's own boot/runtime failure, if any
      // the phone layout: which single pane shows (files | editor | stage).
      // Pure chrome — the panes stay mounted, CSS picks one, and the
      // project/* re-run feed ignores this path by construction.
      mobilePane: 'editor',
    },

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
    flow: {
      kind: null,        // 'fsm' | 'dag' | null → the template picker
      doc: null,
      selection: null,   // { type, id?/index?, path } from a diagram click
      connect: null,     // armed source id (click-click connect)
      tab: 'diagram',    // 'diagram' | 'text'
      parseError: null,  // fail-closed text commits report here
      history: { past: [], future: [] },
      run: null,         // fsm: { current, prev, log[] } · dag: { running, nodes, output, error, log[] }
      runContext: null,  // the machine sandbox's data state (from the template)
      dagInput: '',      // the dag run pane's JSON input text
      revision: 0,
      // the phone layout: which single card shows (diagram | inspector |
      // run). A diagram pick jumps to the inspector and a run jumps to
      // the run pane, so the gesture and its answer are never split
      // across two panes on a screen that shows one.
      mobilePane: 'diagram',
    },

    // the browser-side AI assistant (@jarenjs/ai): a bring-your-own-key
    // chat panel that drives the site through schema-guarded tools
    ai: {
      open: false,
      settingsOpen: false,
      // the settings "Test connection" probe: idle | busy | ok | fail,
      // a human detail line, and the model ids a successful probe found
      probe: { status: 'idle', detail: null, models: [] },
      // reasoning characters streamed this turn (thinking models emit
      // reasoning before - or instead of - visible content)
      reasoningChars: 0,
      settings: { ...DEFAULT_AI_SETTINGS, ...(aiSettings ?? {}) },
      // visible transcript: { role, content }; restored from local
      // storage so a page reload keeps the conversation
      messages: Array.isArray(aiChat?.messages) ? aiChat.messages : [],
      draft: '',             // composer text
      pending: '',           // the assistant reply currently streaming
      status: 'idle',        // 'idle' | 'streaming' | 'error'
      activity: null,        // the tool the model is currently calling
      error: null,
    },

    // the adventure game (boundaries/game.js): a point-and-click pirate
    // comedy. Navigation is a jaren-fsm baked into actions (scene/go-*);
    // `room` is that machine's slice. Static-playable; with an AI key the
    // NPCs answer live. No death, no soft-locks.
    game: {
      started: false,           // false → the title card (name your pirate)
      nameForm: { name: '' },   // the @jarenjs/forms name field data
      locale: 'en',             // validation-message locale (@jarenjs/locales)
      room: { current: START_LOCATION },   // the scene FSM's slice
      verb: 'look',             // the armed point-and-click verb
      held: null,               // the armed inventory item (use/give/combine)
      inv: [],                  // item ids held
      forms: [],                // the "admiralty forms in triplicate" running gag (exports to CSV)
      flags: {},                // solved_<puzzle> / clue_* / gag_* flags
      log: [],                  // the narration feed ({ kind, text })
      dialogue: null,           // { who, node } while talking
      duel: null,               // { poise, landed, insult, known[] } during the insult sword-fight
      ask: '',                  // the dynamic-tier free-text question
      thinking: false,          // an NPC is answering live
      won: false,
    },

    calc: calcInitialState(),    // the @jarenjs/calc sub-app slice

    // the data studio (boundaries/data.js): the browser store over the
    // OPFS-backed wasm driver. A worker owns the connection; this slice
    // holds the derived text panes and the last observed results/live
    // set. Booted on first navigation to #/data.
    data: {
      status: 'boot',          // 'boot' | 'ready' | 'error'
      topology: '—',           // 'owner' | 'client'
      vfs: '—',                // 'opfs-sahpool' | 'memory'
      version: '',
      capture: '—',            // 'journal' on wasm (sessions not adapted)
      operators: [],           // registered operator vocabulary (math/finance/stats packs)
      pushableOperators: [],   // the subset pushed to SQLite as deterministic UDFs
      refusal: null,           // the JD2061 second-writer message, if any
      modelText: '',           // the editable model document (JSON)
      queryText: '',           // the editable query document (JSON)
      rows: [],                // the whole collection, last read
      results: [],             // the last query() result
      explain: null,           // the last explain() { sql, params, indexes, residual }
      live: { mode: null, rows: [], seq: null },
      migration: null,         // the last planned/applied migration report
      booted: false,           // the boot effect fires exactly once
      error: null,
      // the phone layout: which single card shows (store | query | live).
      // Query is the default — it is what a reader of this page came for.
      mobilePane: 'query',
    },

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
