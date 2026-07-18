//@ts-check
/**
 * Docs — a sectioned reference rendered from the DOCS_SECTIONS content
 * document (one section at a time, deep-linkable via ?s=). Examples —
 * every engine's example gallery with one-click "Open in playground".
 */

export const STATIC_RULES = [
  // ---- docs ----
  {
    match: '$.ui.docs', mode: 'docs',
    body: ['div', { class: 'page container docs-grid' },
      ['nav', { class: 'docs-nav' },
        ['h1', {}, 'Docs'],
        [{ $apply: '$.sections[*]' }],
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

  // ---- examples ----
  {
    match: '$.ui.examples', mode: 'examples',
    body: ['div', { class: 'page container' },
      ['h1', {}, 'Examples'],
      ['p', { class: 'page-lead' },
        'Copy-paste starting points for every engine. Open any of them live in the playground with one click.'],
      ['nav', { class: 'tabs' }, [{ $apply: '$.tabs[*]' }]],
      ['div', { class: 'example-grid' }, [{ $apply: '$.items[*]' }]],
    ],
  },
  {
    match: '$.ui.examples.tabs[*]', mode: 'examples',
    body: ['a', {
      href: '$.href',
      class: { $if: ['$.active', 'tab active', 'tab'] },
    }, '$.label'],
  },
  {
    match: '$.ui.examples.items[*]', mode: 'examples',
    body: ['article', { class: 'card example-card' },
      ['div', { class: 'card-head' },
        ['h3', {}, '$.label'],
        ['button', {
          type: 'button',
          class: 'btn small',
          on: { click: { action: 'ex/open', with: '$.payload' } },
        }, 'Open in playground'],
      ],
      ['pre', { class: 'code-block clamp' }, ['code', {}, '$.preview']],
    ],
  },
];
