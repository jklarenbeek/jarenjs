//@ts-check
/**
 * @file The IDE shell as a JSLT view — the chrome is a document, rendered
 * by the same engine as the rest of the suite (no imperative chrome, no
 * syntax highlighting). Following the suite's rule convention: one mode
 * (`project`), rules matched by their ABSOLUTE slice path, `$apply` and
 * body references RELATIVE to the matched node. The host mounts the view
 * model at `$.ui.project`.
 *
 * The stage's live nested app and the drag splitter are the only
 * imperative islands — `jaren-widget`s the host registers. The layout
 * mode rides a `data-mode` attribute so the grid switches in CSS with no
 * computed class; the phone pane rides `data-pane` the same way, and a
 * kind badge rides `data-badge`.
 */

import { editorTextarea } from './editor.js';

/** The one mode this view uses. */
export const PROJECT_MODE = 'project';
/** The slice the host mounts the view model at. */
export const PROJECT_BASE = '$.ui.project';

/** The modes the host merges into the site stylesheet. */
export const projectModes = Object.freeze({ [PROJECT_MODE]: { unmatched: 'error' } });

/** One segment of the layout switcher — active when it is the live mode. */
const layoutButton = (mode, label, title) => ['button', {
  type: 'button', title,
  class: { $if: [{ $eq: ['$.layout.mode', mode] }, 'seg-btn active', 'seg-btn'] },
  on: { click: { action: 'project/layout-mode', with: mode } },
}, label];

/**
 * One segment of the phone pane switcher. Below the breakpoint the rail
 * | editor | stage grid shows ONE pane at a time and this bar picks it;
 * above the breakpoint the bar does not exist (CSS) and the layout
 * switcher beside it is what the user reaches for instead.
 *
 * A pane is a grid area, not a `tabpanel`, so these are toggle buttons
 * in a group with `aria-pressed` — not a `tablist` with `aria-selected`.
 */
const paneButton = (pane, label) => ['button', {
  type: 'button',
  class: { $if: [{ $eq: ['$.mobilePane', pane] }, 'seg-btn active', 'seg-btn'] },
  'aria-pressed': { $if: [{ $eq: ['$.mobilePane', pane] }, 'true', 'false'] },
  on: { click: { action: 'project/pane', with: pane } },
}, label];

/** The shell (matches the whole slice). */
const shell = {
  match: PROJECT_BASE, mode: PROJECT_MODE,
  body: ['div', { class: 'jstudio', 'data-mode': '$.layout.mode', 'data-pane': '$.mobilePane' },
    // ——— the phone pane switcher (its own grid row; display:none above
    // the breakpoint, so on a desktop it costs one hidden element) ———
    ['div', { class: 'js-panebar seg', role: 'group', 'aria-label': 'pane' },
      paneButton('files', 'Files'),
      paneButton('editor', 'Editor'),
      paneButton('stage', 'Stage'),
    ],
    // ——— pen bar ———
    ['div', { class: 'js-penbar' },
      ['strong', { class: 'js-penname' }, '$.name'],
      ['span', { class: 'js-savestate' }, '$.saveState'],
      // the template gallery — opening one replaces the project (host
      // provides `$.templates`; absent → renders nothing)
      ['div', { class: 'js-gallery' }, ['span', { class: 'muted' }, 'New'], [{ $apply: '$.templates[*]' }]],
      ['span', { class: 'js-spacer' }],
      ['span', { class: 'js-filecount muted' }, ['text', '$.fileCount'], ' files'],
      // the layout switcher: the three grid modes, riding `layout.mode` →
      // the `data-mode` attribute the grid switches on (the drag splitter
      // below drives `layout.ratio` within the chosen mode)
      ['div', { class: 'js-layout seg', role: 'group', 'aria-label': 'layout' },
        layoutButton('classic', 'Side', 'Editor beside the stage'),
        layoutButton('right', 'Swap', 'Stage beside the editor'),
        layoutButton('top', 'Stack', 'Editor over the stage'),
      ],
      ['button', { class: 'btn small', type: 'button', on: { click: 'project/run' } }, 'Run'],
    ],
    // ——— file rail ———
    ['nav', { class: 'js-rail', 'aria-label': 'files' },
      ['select', { class: 'js-addfile', 'aria-label': 'add a file', value: '', on: { change: 'project/add-file' } },
        ['option', { value: '' }, '+ add file…'],
        ['option', { value: 'app' }, 'app'],
        ['option', { value: 'jslt' }, 'jslt'],
        ['option', { value: 'query' }, 'query'],
        ['option', { value: 'state' }, 'state'],
        ['option', { value: 'data' }, 'data'],
        ['option', { value: 'schema' }, 'schema'],
      ],
      [{ $apply: '$.rail[*]' }]],
    // ——— editor ———
    ['div', { class: 'js-editor' },
      ['div', { class: 'js-editor-head' },
        // The active file name is editable here → project/rename on commit.
        // It needs the SAME two-action shape as the editor textarea and for
        // the same reason (see `editorTextarea`): a controlled value is
        // reasserted after every settled render, so a rename typed while the
        // debounced edit loop fires was rewritten mid-word and the commit
        // then never came. The draft is a separate buffer rather than the
        // committed value because a rename per keystroke would rename the
        // file once per letter.
        ['input', { class: 'js-editor-name', value: '$.renameDraft', spellcheck: 'false',
          autocapitalize: 'off', autocomplete: 'off', 'aria-label': 'file name',
          on: { input: 'project/rename-draft', change: 'project/rename' } }],
        ['span', { class: 'js-editor-kind muted' }, '$.activeKind'],
        ['span', { class: 'js-spacer' }],
        ['span', { class: 'js-linecount' }, ['text', '$.lineCount'], ' lines'],
      ],
      // a write landed on this file while the buffer was dirty: the human's
      // text stays in the box, the incoming version stays one click away
      { $if: ['$.conflict',
        ['div', { class: 'js-conflict', role: 'status' },
          ['span', {}, 'This file changed while you were editing — your text is kept.'],
          ['button', {
            type: 'button', class: 'js-conflict-take',
            title: 'Discard your edit and take the version that arrived',
            on: { click: 'project/buffer-accept' },
          }, 'Take theirs'],
        ],
        ''] },
      editorTextarea({
        value: '$.editorValue',
        action: 'project/file-text',
        inputAction: 'project/buffer-text',
      }),
      { $if: ['$.problemCount',
        ['div', { class: 'js-errorstrip', role: 'status' }, [{ $apply: '$.problems[*]' }]],
        ''] },
    ],
    // ——— splitter (a pointer-capture widget; its host IS the grab bar) ———
    ['jaren-widget', {
      name: 'studio-splitter', class: 'js-split',
      role: 'separator', 'aria-orientation': 'vertical',
      'aria-label': 'Resize the editor and stage',
      'aria-valuemin': '10', 'aria-valuemax': '90', 'aria-valuenow': '$.ratioPct',
      tabindex: '0',
      props: { ratio: '$.layout.ratio', mode: '$.layout.mode' },
    }],
    // ——— stage ———
    ['div', { class: 'js-stage' },
      ['div', { class: 'js-stage-head' }, 'Stage'],
      { $if: [{ $eq: ['$.stage.kind', 'app'] },
        ['div', { class: 'js-stage-mount' }, ['jaren-widget', { name: 'studio-stage', props: '$.stage.mount' }]],
        { $if: [{ $eq: ['$.stage.kind', 'result'] },
          { $if: ['$.stage.ran',
            ['div', { class: 'js-stage-result' }, [{ $apply: ['$.stage.nodes[*]', 'ui'] }]],
            ['p', { class: 'muted js-stage-note' }, 'Edit — this file runs live against the data file here.']] },
          { $if: [{ $eq: ['$.stage.kind', 'boot-failed'] },
            ['div', { class: 'js-stage-fail card' }, '$.stage.note'],
            ['p', { class: 'muted js-stage-note' }, '$.stage.note']] }] }] },
    ],
  ],
};

/** One file-rail row: the select button + a delete affordance. */
const fileRow = {
  match: `${PROJECT_BASE}.rail[*]`, mode: PROJECT_MODE,
  body: ['div', { class: 'js-file-row' },
    ['button', {
      type: 'button',
      class: { $if: ['$.active', 'js-file active', 'js-file'] },
      title: '$.role',
      on: { click: { action: 'project/active', with: '$.name' } },
    },
    ['span', { class: 'js-badge', 'data-badge': '$.badge' }, '$.kind'],
    ['span', { class: 'js-file-name' }, '$.name'],
    { $if: ['$.valid', '', ['span', { class: 'js-file-warn', title: 'this file has errors' }, '●']] },
    ],
    ['button', {
      type: 'button', class: 'js-file-del', title: 'delete this file',
      'aria-label': 'delete file',
      on: { click: { action: 'project/delete', with: '$.name' } },
    }, '×'],
  ],
};

/** One template-gallery card — opening it replaces the whole project. */
const templateRow = {
  match: `${PROJECT_BASE}.templates[*]`, mode: PROJECT_MODE,
  body: ['button', {
    type: 'button', class: 'js-template', title: '$.lead',
    on: { click: { action: 'project/template', with: '$.id' } },
  }, '$.title'],
};

/** One error-strip line — a problem prefixed by its file; click activates it. */
const errorRow = {
  match: `${PROJECT_BASE}.problems[*]`, mode: PROJECT_MODE,
  body: ['button', {
    class: 'js-errorline', type: 'button',
    on: { click: { action: 'project/active', with: '$.file' } },
  },
  ['strong', {}, '$.file'], ' ', ['code', {}, '$.code'], ' — ', '$.message'],
};

/** The studio's JSLT rules — spread into the site stylesheet. */
export const projectRules = [shell, fileRow, templateRow, errorRow];
