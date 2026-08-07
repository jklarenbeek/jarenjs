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

/** The shell (matches the whole slice): rail | editors | stage. */
const shell = {
  match: PLAY_BASE, mode: PLAY_MODE,
  body: ['div', { class: 'jplay' },
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
      [{ $apply: '$.dataPanes[*]' }],
    ],
    // ——— the run stage ———
    ['div', { class: 'jplay-stage' },
      ['div', { class: 'jplay-stage-head muted' }, 'Result'],
      { $if: ['$.result.ran',
        { $if: ['$.result.ok',
          ['div', { class: 'jplay-result' },
            { $if: ['$.result.timing', ['p', { class: 'muted jplay-timing' }, '$.result.timing'], ''] },
            // a visual engine splices its rendered vnode; a text engine shows a code block
            { $if: ['$.result.hasView', ['div', { class: 'jplay-view' }, '$.result.view'], ''] },
            { $if: ['$.result.hasText', ['pre', { class: 'code-block' }, ['code', {}, '$.result.output']], ''] },
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

/** The playground's JSLT rules — spread into the site stylesheet. */
export const playRules = [shell, railGroup, railExample, optionPane, optionChoice, sourcePane, dataPane, datasetOption];
