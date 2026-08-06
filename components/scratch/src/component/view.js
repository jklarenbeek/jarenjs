//@ts-check
/**
 * @file The scratchpad as a JSLT view — the chrome is a document, rendered
 * by the same engine as the rest of the suite. One `scratch` mode, rules
 * matched by their ABSOLUTE slice path (`$.ui.scratch`), `$apply` and body
 * references RELATIVE to the matched node. The host mounts the view model
 * at `$.ui.scratch`. No imperative islands — the whole scratchpad is data.
 */

/** The one mode this view uses. */
export const SCRATCH_MODE = 'scratch';
/** The slice the host mounts the view model at. */
export const SCRATCH_BASE = '$.ui.scratch';
/** The modes the host merges into the site stylesheet. */
export const scratchModes = Object.freeze({ [SCRATCH_MODE]: { unmatched: 'error' } });

/** The shell (matches the whole slice): rail | editors | stage. */
const shell = {
  match: SCRATCH_BASE, mode: SCRATCH_MODE,
  body: ['div', { class: 'jscratch' },
    // ——— the example picker (a "file tree" grouped by engine) ———
    ['nav', { class: 'jscratch-rail', 'aria-label': 'examples' }, [{ $apply: '$.rail[*]' }]],
    // ——— the source + data editors ———
    ['div', { class: 'jscratch-editors' },
      ['div', { class: 'jscratch-head' },
        ['strong', { class: 'jscratch-engine' }, '$.engine.label'],
        ['span', { class: 'muted jscratch-lead' }, '$.engine.lead'],
      ],
      // live mode selects (josl dialect, csv strict/repair) — empty for most
      ['div', { class: 'jscratch-options' }, [{ $apply: '$.optionPanes[*]' }]],
      [{ $apply: '$.sourcePanes[*]' }],
      { $if: ['$.hasSwitcher',
        ['div', { class: 'jscratch-datasets seg', role: 'group', 'aria-label': 'dataset' }, [{ $apply: '$.datasets[*]' }]],
        ''] },
      [{ $apply: '$.dataPanes[*]' }],
    ],
    // ——— the run stage ———
    ['div', { class: 'jscratch-stage' },
      ['div', { class: 'jscratch-stage-head muted' }, 'Result'],
      { $if: ['$.result.ran',
        { $if: ['$.result.ok',
          ['div', { class: 'jscratch-result' },
            { $if: ['$.result.timing', ['p', { class: 'muted jscratch-timing' }, '$.result.timing'], ''] },
            // a visual engine splices its rendered vnode; a text engine shows a code block
            { $if: ['$.result.hasView', ['div', { class: 'jscratch-view' }, '$.result.view'], ''] },
            { $if: ['$.result.hasText', ['pre', { class: 'code-block' }, ['code', {}, '$.result.output']], ''] },
          ],
          ['p', { class: 'error-line' }, ['strong', {}, '$.result.error.code'], ' ', '$.result.error.message']] },
        ['p', { class: 'muted jscratch-hint' }, 'Pick an example, or edit the source or data — it runs live.']] },
    ],
  ],
};

/** One engine group in the rail. */
const railGroup = {
  match: `${SCRATCH_BASE}.rail[*]`, mode: SCRATCH_MODE,
  body: ['div', { class: { $if: ['$.active', 'jscratch-group active', 'jscratch-group'] } },
    ['div', { class: 'jscratch-group-head muted' }, '$.label'],
    [{ $apply: '$.examples[*]' }],
  ],
};

/** One example in a group — picking it loads its source + first dataset. */
const railExample = {
  match: `${SCRATCH_BASE}.rail[*].examples[*]`, mode: SCRATCH_MODE,
  body: ['button', {
    type: 'button',
    class: { $if: ['$.active', 'jscratch-ex active', 'jscratch-ex'] },
    on: { click: { action: 'scratch/example', with: '$.id' } },
  }, '$.label'],
};

/** One source editor (a `text` control renders an input, else a textarea). */
const sourcePane = {
  match: `${SCRATCH_BASE}.sourcePanes[*]`, mode: SCRATCH_MODE,
  body: ['label', { class: 'jscratch-pane' },
    ['span', { class: 'jscratch-pane-label muted' }, '$.label'],
    { $if: [{ $eq: ['$.control', 'text'] },
      ['input', { type: 'text', class: 'editor line', spellcheck: 'false', value: '$.value',
        on: { input: { action: 'scratch/source', with: { key: '$.key' } } } }],
      ['textarea', { class: 'editor', rows: 6, spellcheck: 'false', value: '$.value',
        on: { input: { action: 'scratch/source', with: { key: '$.key' } } } }]] },
  ],
};

/** One data editor. */
const dataPane = {
  match: `${SCRATCH_BASE}.dataPanes[*]`, mode: SCRATCH_MODE,
  body: ['label', { class: 'jscratch-pane' },
    ['span', { class: 'jscratch-pane-label muted' }, '$.label'],
    ['textarea', { class: 'editor', rows: 8, spellcheck: 'false', value: '$.value',
      on: { input: { action: 'scratch/data', with: { key: '$.key' } } } }],
  ],
};

/** One option pane — a live mode select (its value lives in host `config`). */
const optionPane = {
  match: `${SCRATCH_BASE}.optionPanes[*]`, mode: SCRATCH_MODE,
  body: ['label', { class: 'jscratch-option' },
    ['span', { class: 'jscratch-pane-label muted' }, '$.label'],
    ['select', { class: 'editor line', on: { change: { action: 'scratch/option', with: { key: '$.key' } } } },
      [{ $apply: '$.choices[*]' }]],
  ],
};

/** One choice inside an option select. */
const optionChoice = {
  match: `${SCRATCH_BASE}.optionPanes[*].choices[*]`, mode: SCRATCH_MODE,
  body: ['option', { value: '$.value', selected: '$.selected' }, '$.label'],
};

/** One dataset segment in the switcher. */
const datasetOption = {
  match: `${SCRATCH_BASE}.datasets[*]`, mode: SCRATCH_MODE,
  body: ['button', {
    type: 'button',
    class: { $if: ['$.active', 'seg-btn active', 'seg-btn'] },
    on: { click: { action: 'scratch/dataset', with: '$.index' } },
  }, '$.label'],
};

/** The scratchpad's JSLT rules — spread into the site stylesheet. */
export const scratchRules = [shell, railGroup, railExample, optionPane, optionChoice, sourcePane, dataPane, datasetOption];
