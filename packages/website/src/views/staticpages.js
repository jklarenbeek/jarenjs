//@ts-check
/**
 * Docs — a sectioned reference rendered from the DOCS_SECTIONS content
 * document (one section at a time, deep-linkable via ?s=). (The former
 * Examples gallery now lives in the #/play playground.)
 */

export const STATIC_RULES = [
  // ---- docs ----
  {
    match: '$.ui.docs', mode: 'docs',
    body: ['div', { class: 'page container docs-grid' },
      // The rail holds BOTH lists and scrolls as one on desktop. On mobile
      // it is `display: contents`, so its two halves become grid items in
      // their own right and the README list can be ordered BELOW the
      // article — reading the docs on a phone used to mean scrolling past
      // twenty package buttons first.
      ['div', { class: 'docs-side' },
        ['nav', { class: 'docs-nav' },
          ['h1', {}, 'Docs'],
          // the wrapper is layout-inert on desktop (display: contents) and
          // becomes the horizontally scrollable section strip on mobile
          ['div', { class: 'docs-sections' }, [{ $apply: '$.sections[*]' }]],
        ],
        ['section', { class: 'docs-packages' },
          ['h2', { class: 'docs-nav-heading' }, 'Package READMEs'],
          ['p', { class: 'docs-nav-note' }, 'Read any package’s README, rendered live by @jarenjs/md.'],
          ['div', { class: 'docs-readmes' }, [{ $apply: '$.packages[*]' }]],
        ],
      ],
      ['article', { class: 'docs-article' },
        ['h2', {}, '$.section.title'],
        [{ $apply: ['$.section.blocks[*]', 'ui'] }],
      ],
    ],
  },
  {
    match: '$.ui.docs.sections[*]', mode: 'docs',
    body: ['a', {
      href: '$.href',
      class: { $if: ['$.active', 'docs-link active', 'docs-link'] },
    }, '$.title'],
  },
  {
    match: '$.ui.docs.packages[*]', mode: 'docs',
    body: ['button', {
      type: 'button',
      class: 'readme-btn',
      title: '$.blurb',
      on: { click: { action: 'readme/open', with: { title: '$.name', url: '$.url' } } },
    }, '$.name'],
  },

];
