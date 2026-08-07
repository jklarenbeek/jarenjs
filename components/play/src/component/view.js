//@ts-check
/**
 * @file The playground as a JSLT view — the chrome is a document, rendered
 * by the same engine as the rest of the suite. One `play` mode, rules
 * matched by their ABSOLUTE slice path (`$.ui.play`), `$apply` and body
 * references RELATIVE to the matched node. The host mounts the view model
 * at `$.ui.play`. No imperative islands — the whole playground is data.
 */

/** The one mode this view uses. */
export const PLAY_MODE = 'play';
/** The slice the host mounts the view model at. */
export const PLAY_BASE = '$.ui.play';
/** The modes the host merges into the site stylesheet. */
export const playModes = Object.freeze({ [PLAY_MODE]: { unmatched: 'error' } });

/** The shell (matches the whole slice): bar / rail | editors | split | stage. */
const shell = {
  match: PLAY_BASE, mode: PLAY_MODE,
  body: ['div', { class: 'jplay' },
    // ——— the IDE bar: engine title, session name, New/Save/Save As/Share,
    // the Load dropdown, and the last share status (a play session is a
    // saveable document — PLAY_04) ———
    ['div', { class: 'jplay-bar' },
      ['strong', { class: 'jplay-title' }, '$.engine.label'],
      ['input', {
        class: 'jplay-name editor line', value: '$.name', spellcheck: 'false',
        autocapitalize: 'off', autocomplete: 'off', placeholder: 'name this session…',
        'aria-label': 'session name', on: { input: 'play/name' },
      }],
      ['div', { class: 'jplay-actions' },
        ['button', { class: 'btn small', type: 'button', on: { click: 'play/new' } }, 'New'],
        ['button', { class: 'btn small', type: 'button', on: { click: 'play/save' } }, 'Save'],
        ['button', { class: 'btn small', type: 'button', on: { click: 'play/save-as' } }, 'Save As'],
        ['button', { class: 'btn small', type: 'button', on: { click: 'play/share' } }, 'Share'],
        // Delete the current named session (only meaningful once named+saved)
        { $if: ['$.name',
          ['button', { class: 'btn small', type: 'button', title: 'delete this saved session',
            on: { click: { action: 'play/delete-session', with: '$.name' } } }, 'Delete'],
          ''] },
        // the Load dropdown appears once there is something saved
        { $if: ['$.hasSaved',
          ['select', { class: 'jplay-load editor line', 'aria-label': 'load a saved session', value: '', on: { change: 'play/open' } },
            ['option', { value: '' }, 'Load…'],
            [{ $apply: '$.names[*]' }]],
          ''] },
      ],
      { $if: ['$.shared', ['span', { class: 'jplay-shared muted', role: 'status' }, '$.shared'], ''] },
    ],
    // ——— the example picker (a "file tree" grouped by engine) ———
    ['nav', { class: 'jplay-rail', 'aria-label': 'examples' }, [{ $apply: '$.rail[*]' }]],
    // ——— the source + data editors ———
    ['div', { class: 'jplay-editors' },
      ['div', { class: 'jplay-head' },
        ['strong', { class: 'jplay-engine' }, '$.engine.label'],
        ['span', { class: 'muted jplay-lead' }, '$.engine.lead'],
      ],
      // live mode selects (josl dialect, csv strict/repair) — empty for most
      ['div', { class: 'jplay-options' }, [{ $apply: '$.optionPanes[*]' }]],
      [{ $apply: '$.sourcePanes[*]' }],
      { $if: ['$.hasSwitcher',
        ['div', { class: 'jplay-datasets seg', role: 'group', 'aria-label': 'dataset' }, [{ $apply: '$.datasets[*]' }]],
        ''] },
      // the validate engine offers a JSON ↔ generated-form toggle on its data
      { $if: ['$.hasForm',
        ['div', { class: 'jplay-dataview seg', role: 'group', 'aria-label': 'data view' },
          ['button', { type: 'button', class: { $if: [{ $eq: ['$.dataView', 'json'] }, 'seg-btn active', 'seg-btn'] },
            on: { click: { action: 'play/data-view', with: 'json' } } }, 'JSON'],
          ['button', { type: 'button', class: { $if: [{ $eq: ['$.dataView', 'form'] }, 'seg-btn active', 'seg-btn'] },
            on: { click: { action: 'play/data-view', with: 'form' } } }, 'Form'],
        ], ''] },
      // form mode → the host-supplied generated form (a two-way seam); else
      // the JSON data editor(s)
      { $if: ['$.showForm',
        ['div', { class: 'jplay-form' }, { $apply: ['$.dataForm', PLAY_MODE] }],
        [{ $apply: '$.dataPanes[*]' }]] },
    ],
    // ——— the editors|result splitter (a pointer-capture widget; its host
    // IS the grab bar — drives --jplay-ratio live, commits on pointer-up) ———
    ['jaren-widget', {
      name: 'play-splitter', class: 'jplay-split',
      role: 'separator', 'aria-orientation': 'vertical',
      'aria-label': 'Resize the editors and result',
      'aria-valuemin': '10', 'aria-valuemax': '90', 'aria-valuenow': '$.ratioPct',
      tabindex: '0',
      props: { ratio: '$.ratio' },
    }],
    // ——— the run stage ———
    ['div', { class: 'jplay-stage' },
      ['div', { class: 'jplay-stage-head muted' }, 'Result'],
      { $if: ['$.result.ran',
        { $if: ['$.result.ok',
          ['div', { class: 'jplay-result' },
            { $if: ['$.result.timing', ['p', { class: 'muted jplay-timing' }, '$.result.timing'], ''] },
            // >1 screen → a tab strip selecting the active one; 1 → no tabs
            { $if: ['$.result.tabbed',
              ['div', { class: 'jplay-tabs seg', role: 'tablist' }, [{ $apply: '$.result.tabs[*]' }]], ''] },
            // the active panel body, rendered by its kind (a single object →
            // the explicit [path, mode] apply form)
            { $apply: [`$.result.activePanel`, PLAY_MODE] },
          ],
          ['p', { class: 'error-line' }, ['strong', {}, '$.result.error.code'], ' ', '$.result.error.message']] },
        ['p', { class: 'muted jplay-hint' }, 'Pick an example, or edit the source or data — it runs live.']] },
    ],
  ],
};

/** One engine group in the rail. */
const railGroup = {
  match: `${PLAY_BASE}.rail[*]`, mode: PLAY_MODE,
  body: ['div', { class: { $if: ['$.active', 'jplay-group active', 'jplay-group'] } },
    ['div', { class: 'jplay-group-head muted' }, '$.label'],
    [{ $apply: '$.examples[*]' }],
  ],
};

/** One example in a group — picking it loads its source + first dataset. */
const railExample = {
  match: `${PLAY_BASE}.rail[*].examples[*]`, mode: PLAY_MODE,
  body: ['button', {
    type: 'button',
    class: { $if: ['$.active', 'jplay-ex active', 'jplay-ex'] },
    on: { click: { action: 'play/example', with: '$.id' } },
  }, '$.label'],
};

/** One source editor (a `text` control renders an input, else a textarea). */
const sourcePane = {
  match: `${PLAY_BASE}.sourcePanes[*]`, mode: PLAY_MODE,
  body: ['label', { class: 'jplay-pane' },
    ['span', { class: 'jplay-pane-label muted' }, '$.label'],
    { $if: [{ $eq: ['$.control', 'text'] },
      ['input', { type: 'text', class: 'editor line', spellcheck: 'false', value: '$.value',
        on: { input: { action: 'play/source', with: { key: '$.key' } } } }],
      ['textarea', { class: 'editor', rows: 6, spellcheck: 'false', value: '$.value',
        on: { input: { action: 'play/source', with: { key: '$.key' } } } }]] },
  ],
};

/** One data editor. */
const dataPane = {
  match: `${PLAY_BASE}.dataPanes[*]`, mode: PLAY_MODE,
  body: ['label', { class: 'jplay-pane' },
    ['span', { class: 'jplay-pane-label muted' }, '$.label'],
    ['textarea', { class: 'editor', rows: 8, spellcheck: 'false', value: '$.value',
      on: { input: { action: 'play/data', with: { key: '$.key' } } } }],
  ],
};

/** One option pane — a live mode select (its value lives in host `config`). */
const optionPane = {
  match: `${PLAY_BASE}.optionPanes[*]`, mode: PLAY_MODE,
  body: ['label', { class: 'jplay-option' },
    ['span', { class: 'jplay-pane-label muted' }, '$.label'],
    ['select', { class: 'editor line', on: { change: { action: 'play/option', with: { key: '$.key' } } } },
      [{ $apply: '$.choices[*]' }]],
  ],
};

/** One choice inside an option select. */
const optionChoice = {
  match: `${PLAY_BASE}.optionPanes[*].choices[*]`, mode: PLAY_MODE,
  body: ['option', { value: '$.value', selected: '$.selected' }, '$.label'],
};

/** One dataset segment in the switcher. */
const datasetOption = {
  match: `${PLAY_BASE}.datasets[*]`, mode: PLAY_MODE,
  body: ['button', {
    type: 'button',
    class: { $if: ['$.active', 'seg-btn active', 'seg-btn'] },
    on: { click: { action: 'play/dataset', with: '$.index' } },
  }, '$.label'],
};

/** One saved session in the Load dropdown. */
const savedOption = {
  match: `${PLAY_BASE}.names[*]`, mode: PLAY_MODE,
  body: ['option', { value: '$.name' }, '$.name'],
};

/** One tab in the result strip (only shown when a result has >1 panel). */
const resultTab = {
  match: `${PLAY_BASE}.result.tabs[*]`, mode: PLAY_MODE,
  body: ['button', {
    type: 'button', role: 'tab',
    class: { $if: ['$.active', 'seg-btn active', 'seg-btn'] },
    'aria-selected': { $if: ['$.active', 'true', 'false'] },
    on: { click: { action: 'play/panel', with: '$.id' } },
  }, '$.label'],
};

/** The active result panel, rendered by its kind (code | view | table | note). */
const activePanel = {
  match: `${PLAY_BASE}.result.activePanel`, mode: PLAY_MODE,
  body: { $if: ['$.isView', ['div', { class: 'jplay-view' }, '$.vnode'],
    { $if: ['$.isTable',
      ['div', { class: 'jplay-table-wrap' },
        ['table', { class: 'jplay-table' },
          ['thead', {}, ['tr', {}, [{ $apply: '$.columns[*]' }]]],
          ['tbody', {}, [{ $apply: '$.rows[*]' }]]]],
      { $if: ['$.isNote', ['p', { class: '$.noteClass' }, '$.text'],
        ['pre', { class: 'code-block' }, ['code', {}, '$.text']]] }] }] },
};

/** A table header cell. */
const tableColumn = {
  match: `${PLAY_BASE}.result.activePanel.columns[*]`, mode: PLAY_MODE,
  body: ['th', {}, '$.label'],
};
/** A table body row. */
const tableRow = {
  match: `${PLAY_BASE}.result.activePanel.rows[*]`, mode: PLAY_MODE,
  body: ['tr', {}, [{ $apply: '$.cells[*]' }]],
};
/** A table body cell. */
const tableCell = {
  match: `${PLAY_BASE}.result.activePanel.rows[*].cells[*]`, mode: PLAY_MODE,
  body: ['td', {}, '$.text'],
};

/** The playground's JSLT rules — spread into the site stylesheet. */
export const playRules = [
  shell, railGroup, railExample, optionPane, optionChoice, sourcePane, dataPane, datasetOption,
  savedOption, resultTab, activePanel, tableColumn, tableRow, tableCell,
];
