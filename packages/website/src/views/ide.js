//@ts-check
/**
 * The IDE bar and its saved-name chips, shared by the playground and the
 * Studio. Both drive the same `ide/*` actions over the same
 * `$.ide` slice, so both get the same widget: the playground saves
 * experiments, the Studio saves documents and adds two buttons of its
 * own.
 */

/**
 * The name field, Save, Share and the recall chips.
 * @param {string} shareTitle - the Share button's tooltip; it names what
 *   the copied link restores.
 * @param {any[]} [extras] - further buttons, placed after Share.
 */
export const ideBar = (shareTitle, extras = []) =>
  ['div', { class: 'ide-bar' },
    ['input', {
      type: 'text',
      class: 'ide-name',
      placeholder: 'Experiment name…',
      value: '$.ide.name',
      on: { input: 'ide/name' },
    }],
    ['button', { type: 'button', class: 'btn small', on: { click: 'ide/save' } }, 'Save'],
    ['button', {
      type: 'button', class: 'btn small', title: shareTitle,
      on: { click: 'ide/share' },
    }, 'Share'],
    ...extras,
    { $if: ['$.ide.shared', ['span', { class: 'muted' }, '$.ide.shared']] },
    ['div', { class: 'ide-list' }, [{ $apply: '$.ide.names[*]' }]],
  ];

/**
 * The rule for one saved name: load it, or delete it. Each page holds
 * its `ide.names` at a different location, hence the match parameter.
 * @param {string} match - the JSONPath to the name entries.
 * @param {string} mode - the page's dispatch mode.
 */
export const ideNamesRule = (match, mode) => ({
  match, mode,
  body: ['span', { class: 'ide-chip' },
    ['button', {
      type: 'button', class: 'ide-load', title: 'Load this experiment',
      on: { click: { action: 'ide/load', with: '$.name' } },
    }, '$.name'],
    ['button', {
      type: 'button', class: 'ide-delete', title: 'Delete this experiment',
      on: { click: { action: 'ide/delete', with: '$.name' } },
    }, '×'],
  ],
});
