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
 * computed class; a kind badge rides `data-badge`.
 */

import { editorTextarea } from './editor.js';

/** The one mode this view uses. */
export const PROJECT_MODE = 'project';
/** The slice the host mounts the view model at. */
export const PROJECT_BASE = '$.ui.project';

/** The modes the host merges into the site stylesheet. */
export const projectModes = Object.freeze({ [PROJECT_MODE]: { unmatched: 'error' } });

/** The shell (matches the whole slice). */
const shell = {
  match: PROJECT_BASE, mode: PROJECT_MODE,
  body: ['div', { class: 'jstudio', 'data-mode': '$.layout.mode' },
    // ——— pen bar ———
    ['div', { class: 'js-penbar' },
      ['strong', { class: 'js-penname' }, '$.name'],
      ['span', { class: 'js-savestate' }, '$.saveState'],
      ['span', { class: 'js-spacer' }],
      ['span', { class: 'js-filecount muted' }, ['text', '$.fileCount'], ' files'],
      ['button', { class: 'btn small', type: 'button', on: { click: 'project/run' } }, 'Run'],
    ],
    // ——— file rail ———
    ['nav', { class: 'js-rail', 'aria-label': 'files' }, [{ $apply: '$.rail[*]' }]],
    // ——— editor ———
    ['div', { class: 'js-editor' },
      ['div', { class: 'js-editor-head' },
        ['span', { class: 'js-editor-kind' }, '$.activeKind'],
        ['span', { class: 'js-spacer' }],
        ['span', { class: 'js-linecount' }, ['text', '$.lineCount'], ' lines'],
      ],
      editorTextarea({ value: '$.editorValue', action: 'project/file-text' }),
      { $if: ['$.problemCount',
        ['div', { class: 'js-errorstrip', role: 'status' }, [{ $apply: '$.problems[*]' }]],
        ''] },
    ],
    // ——— stage ———
    ['div', { class: 'js-stage' },
      ['div', { class: 'js-stage-head' }, 'Stage'],
      { $if: [{ $eq: ['$.stage.kind', 'app'] },
        ['div', { class: 'js-stage-mount' }, ['jaren-widget', { name: 'studio-stage', props: '$.stage.mount' }]],
        { $if: [{ $eq: ['$.stage.kind', 'result'] },
          ['pre', { class: 'js-stage-result code-block' }, ['code', {}, { $default: ['$.stage.result.text', '(run to see output)'] }]],
          { $if: [{ $eq: ['$.stage.kind', 'boot-failed'] },
            ['div', { class: 'js-stage-fail card' }, '$.stage.note'],
            ['p', { class: 'muted js-stage-note' }, '$.stage.note']] }] }] },
    ],
  ],
};

/** One file-rail row. */
const fileRow = {
  match: `${PROJECT_BASE}.rail[*]`, mode: PROJECT_MODE,
  body: ['button', {
    type: 'button',
    class: { $if: ['$.active', 'js-file active', 'js-file'] },
    title: '$.role',
    on: { click: { action: 'project/active', with: '$.name' } },
  },
  ['span', { class: 'js-badge', 'data-badge': '$.badge' }, '$.kind'],
  ['span', { class: 'js-file-name' }, '$.name'],
  { $if: ['$.valid', '', ['span', { class: 'js-file-warn', title: 'this file has errors' }, '●']] },
  ],
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
export const projectRules = [shell, fileRow, errorRow];
