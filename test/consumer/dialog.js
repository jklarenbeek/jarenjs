/** One public fixture shared by source and installed browser qualification. */
import { createApp } from '@jarenjs/app';
import { createDialogWidget } from '@jarenjs/app/dialog';
export { createDialog, DIALOG_CODES } from '@jarenjs/view/helpers/dialog';

export function createDialogConsumer(node) {
  const widgets = {};
  widgets.dialog = createDialogWidget({ widgets });
  return createApp({ state: { open: false, inner: false, empty: false, hideOpener: false, stamp: 0, closes: 0 },
    view: [{ match: '$', body: ['main', {},
      { $if: [{ $not: '$.hideOpener' }, ['button', { 'data-ref': 'opener', on: { click: 'open' } }, 'Open settings']] },
      ['button', { 'data-ref': 'fallback' }, 'Continue here'],
      ['jaren-widget', { name: 'dialog', key: 'outer', props: {
        id: 'settings', title: 'Settings', open: '$.open', stamp: '$.stamp',
        initialFocusRef: 'first', fallbackFocusRef: 'fallback', close: 'close',
        content: { $if: ['$.empty', null, [
          ['input', { 'data-ref': 'first', 'aria-label': 'Name' }],
          ['button', { on: { click: 'innerOpen' }, 'data-ref': 'nested-opener' }, 'More settings'],
          ['jaren-widget', { name: 'dialog', key: 'inner', props: {
            id: 'details', title: 'More settings', open: '$.inner', close: 'innerClose',
            content: ['input', { 'aria-label': 'Detail', 'data-ref': 'detail' }],
          } }],
        ]] },
      } }],
    ] }], actions: {
      open: { patch: [{ op: 'replace', path: '/open', value: true }] },
      close: { patch: [{ op: 'replace', path: '/open', value: false }, { op: 'replace', path: '/inner', value: false },
        { op: 'replace', path: '/closes', value: { $add: ['$.closes', 1] } }] },
      innerOpen: { patch: [{ op: 'replace', path: '/inner', value: true }] },
      innerClose: { patch: [{ op: 'replace', path: '/inner', value: false }] },
      empty: { patch: [{ op: 'replace', path: '/empty', value: true }] },
      removeOpener: { patch: [{ op: 'replace', path: '/hideOpener', value: true }] },
      bump: { patch: [{ op: 'replace', path: '/stamp', value: { $add: ['$.stamp', 1] } }] },
    } }, { node, widgets, schedule: flush => flush() });
}
