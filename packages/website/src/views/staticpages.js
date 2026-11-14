//@ts-check
/**
 * Docs — a sectioned reference rendered from the DOCS_SECTIONS content
 * document (one section at a time, deep-linkable via ?s=). The example
 * gallery is the #/play playground. The page's own words (`$.w`) follow
 * the reader's language; the documentation it shows is English.
 */

export const STATIC_RULES = [
  // ---- docs ----
  {
    match: '$.ui.docs', mode: 'docs',
    body: ['div', { class: 'page container docs-grid' },
      // The rail holds BOTH lists and scrolls as one on desktop. On mobile
      // it is `display: contents`, so its two halves become grid items in
      // their own right and the README list can be ordered BELOW the
      // article, so a phone reader meets the article first rather than
      // scrolling past the package list.
      ['div', { class: 'docs-side' },
        ['nav', { class: 'docs-nav' },
          ['h1', {}, '$.w.title'],
          // the wrapper is layout-inert on desktop (display: contents) and
          // becomes the horizontally scrollable section strip on mobile
          ['div', { class: 'docs-sections' }, [{ $apply: '$.sections[*]' }]],
        ],
        ['section', { class: 'docs-packages' },
          ['h2', { class: 'docs-nav-heading' }, '$.w.readmes'],
          ['p', { class: 'docs-nav-note' }, '$.w.readmesNote'],
          // the list is the build's package census: `note` exists only
          // while it is missing, `packages` only once it is here
          ['div', { class: 'docs-readmes' },
            { $apply: ['$.note', 'ui'] },
            [{ $apply: '$.packages[*]' }],
          ],
        ],
      ],
      // the article is the package's or the site's English documentation
      ['article', { class: 'docs-article', lang: 'en', dir: 'ltr' },
        ['h2', {}, '$.section.title'],
        [{ $apply: ['$.section.blocks[*]', 'ui'] }],
      ],
    ],
  },
  {
    match: '$.ui.docs.sections[*]', mode: 'docs',
    // a section is named in the English its article is written in
    body: ['a', {
      href: '$.href',
      class: { $if: ['$.active', 'docs-link active', 'docs-link'] },
      lang: 'en', dir: 'ltr',
    }, '$.title'],
  },
  {
    match: '$.ui.docs.packages[*]', mode: 'docs',
    body: ['button', {
      type: 'button',
      class: 'readme-btn',
      // a package's name and its own English blurb
      lang: 'en', dir: 'ltr',
      title: '$.blurb',
      on: { click: { action: 'readme/open', with: { title: '$.name', url: '$.url' } } },
    }, '$.name'],
  },

];
