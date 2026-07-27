//@ts-check
/**
 * The package-README dialog — mode 'readme'. A near-fullscreen overlay
 * whose body is the fetched README, parsed and rendered by the
 * @jarenjs/md visual component (`$.article` is that ready-made vnode,
 * spliced in verbatim). Closable by the × button or the backdrop.
 */

export const README_RULES = [
  {
    match: '$.ui.readme', mode: 'readme',
    body: ['div', { class: 'md-dialog-overlay' },
      // a full-bleed sibling BEHIND the panel: clicking outside closes
      ['div', { class: 'md-dialog-backdrop', on: { click: 'readme/close' } }],
      ['div', { class: 'md-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': '$.title' },
        ['div', { class: 'md-dialog-head' },
          // the dialog's own history: repo-relative links navigate in
          // place, and these replay the trail
          ['div', { class: 'md-dialog-navgroup' },
            ['button', {
              type: 'button',
              class: 'md-dialog-nav',
              'aria-label': 'Back',
              disabled: { $if: ['$.canBack', false, 'disabled'] },
              on: { click: 'readme/back' },
            }, '‹'],
            ['button', {
              type: 'button',
              class: 'md-dialog-nav',
              'aria-label': 'Forward',
              disabled: { $if: ['$.canForward', false, 'disabled'] },
              on: { click: 'readme/forward' },
            }, '›'],
          ],
          ['h2', { class: 'md-dialog-title' }, '$.title'],
          ['button', {
            type: 'button',
            class: 'md-dialog-close',
            'aria-label': 'Close',
            on: { click: 'readme/close' },
          }, '✕'],
        ],
        ['div', { class: 'md-dialog-body' },
          { $if: [{ $eq: ['$.status', 'loading'] },
            ['p', { class: 'md-dialog-status' }, 'Loading README…']] },
          { $if: [{ $eq: ['$.status', 'error'] },
            ['div', { class: 'error-card' },
              ['p', { class: 'error-title' }, 'Could not load the README'],
              ['p', { class: 'error-message' }, '$.message'],
            ]] },
          // the md component's article vnode (reference-stable per source)
          { $if: [{ $eq: ['$.status', 'ready'] }, '$.article'] },
        ],
      ],
    ],
  },
];
