//@ts-check
/**
 * The package-README dialog — mode 'readme'. A near-fullscreen overlay
 * whose body is the fetched README, parsed and rendered by the
 * @jarenjs/md visual component (`$.article` is that ready-made vnode,
 * spliced in verbatim). Closable by the × button or the backdrop. Its
 * controls speak the reader's language (`$.w`); the README is English.
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
              'aria-label': '$.w.back',
              disabled: { $if: ['$.canBack', false, 'disabled'] },
              on: { click: 'readme/back' },
            }, '‹'],
            ['button', {
              type: 'button',
              class: 'md-dialog-nav',
              'aria-label': '$.w.forward',
              disabled: { $if: ['$.canForward', false, 'disabled'] },
              on: { click: 'readme/forward' },
            }, '›'],
          ],
          ['h2', { class: 'md-dialog-title' }, '$.title'],
          ['button', {
            type: 'button',
            class: 'md-dialog-close',
            'aria-label': '$.w.close',
            on: { click: 'readme/close' },
          }, '✕'],
        ],
        ['div', { class: 'md-dialog-body' },
          { $if: [{ $eq: ['$.status', 'loading'] },
            ['p', { class: 'md-dialog-status' }, '$.w.loading']] },
          { $if: [{ $eq: ['$.status', 'error'] },
            ['div', { class: 'error-card' },
              ['p', { class: 'error-title' }, '$.w.error'],
              ['p', { class: 'error-message', lang: 'en', dir: 'ltr' }, '$.message'],
            ]] },
          // the md component's article vnode (reference-stable per source)
          { $if: [{ $eq: ['$.status', 'ready'] }, ['div', { lang: 'en', dir: 'ltr' }, '$.article']] },
        ],
      ],
    ],
  },
];
