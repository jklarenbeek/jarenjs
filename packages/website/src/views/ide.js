//@ts-check
/**
 * The IDE store's bar on the Project IDE (`#/project`): the experiment
 * name field, Save / Share / Download, the share status line and the
 * saved-name recall chips. It renders above the `@jarenjs/studio` shell
 * and drives the site's `ide/*` actions over the `$.ui.projectIde` model
 * (the whole project downloads as JSON; the designated app document
 * also has its own explicit export).
 */

const ideBar = {
  match: '$.ui.projectIde', mode: 'project',
  body: ['div', { class: 'ide-bar' },
    ['input', {
      type: 'text',
      class: 'ide-name',
      placeholder: '$.w.namePlaceholder',
      value: '$.name',
      on: { input: 'ide/name' },
    }],
    ['button', { type: 'button', class: 'btn small', on: { click: 'ide/save' } }, '$.w.save'],
    ['button', {
      type: 'button', class: 'btn small', title: '$.w.shareTitle',
      on: { click: 'ide/share' },
    }, '$.w.share'],
    ['button', {
      type: 'button', class: 'btn small', title: '$.w.downloadTitle',
      on: { click: 'project/export' },
    }, '$.w.download'],
    ['button', {
      type: 'button', class: 'btn small', title: '$.w.appJsonTitle',
      on: { click: 'project/download' },
    }, '$.w.appJson'],
    ['button', { type: 'button', class: 'btn small', on: { click: 'project/eject' } }, '$.w.offlineZip'],
    { $if: ['$.shared', ['span', { class: 'muted' }, '$.shared']] },
    ['div', { class: 'ide-list' }, [{ $apply: '$.names[*]' }]],
  ],
};

/** One saved name: load it, or delete it. */
const ideChip = {
  match: '$.ui.projectIde.names[*]', mode: 'project',
  body: ['span', { class: 'ide-chip' },
    ['button', {
      type: 'button', class: 'ide-load', title: '$.w.loadTitle',
      on: { click: { action: 'ide/load', with: '$.name' } },
    }, '$.name'],
    ['button', {
      type: 'button', class: 'ide-delete', title: '$.w.deleteTitle',
      on: { click: { action: 'ide/delete', with: '$.name' } },
    }, '×'],
  ],
};

export const PROJECT_IDE_RULES = [ideBar, ideChip];
