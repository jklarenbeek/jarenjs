//@ts-check
/**
 * The home page — mode 'home', dispatched with the `$.ui.home` content
 * document as the current node.
 */

export const HOME_RULES = [
  {
    match: '$.ui.home', mode: 'home',
    body: ['div', { class: 'page' },
      ['section', { class: 'hero' },
        ['div', { class: 'container' },
          ['h1', { class: 'hero-title' }, '$.hero.title'],
          ['p', { class: 'hero-lead' }, '$.hero.lead'],
          ['pre', { class: 'hero-install' }, ['code', {}, '$.hero.install']],
          ['ul', { class: 'hero-points' }, [{ $apply: '$.hero.points[*]' }]],
          ['div', { class: 'hero-actions' },
            ['a', { href: '#/playground', class: 'btn primary' }, 'Open the playground'],
            ['a', { href: '#/benchmarks', class: 'btn' }, 'See the benchmarks'],
          ],
        ],
      ],
      ['section', { class: 'container section' },
        // counted from the content document rather than written down, so
        // the heading cannot drift the next time an engine is added
        ['h2', {}, { $concat: ['One stack, ', { $count: '$.engines[*]' }, ' engines'] }],
        ['div', { class: 'engine-grid' }, [{ $apply: '$.engines[*]' }]],
      ],
      ['section', { class: 'container section' },
        ['div', { class: 'callout wide' },
          ['h3', {}, '$.ai.title'],
          ['p', {}, '$.ai.lead'],
          ['ul', {}, [{ $apply: '$.ai.points[*]' }]],
        ],
      ],
      ['section', { class: 'container section' },
        ['div', { class: 'callout wide' },
          ['h3', {}, '$.studio.title'],
          ['p', {}, '$.studio.lead'],
          ['a', { href: '#/studio', class: 'btn' }, 'Open the Studio'],
        ],
      ],
      ['section', { class: 'container section' },
        ['div', { class: 'callout accent wide' },
          ['h3', {}, '$.meta.title'],
          ['p', {}, '$.meta.lead'],
        ],
      ],
    ],
  },
  {
    match: '$.ui.home..points[*]', mode: 'home',
    body: ['li', {}, '$'],
  },
  {
    match: '$.ui.home.engines[*]', mode: 'home',
    body: ['article', { class: 'card engine-card' },
      ['h3', {}, '$.title'],
      ['p', {}, '$.blurb'],
      ['p', { class: 'engine-perf' }, '$.perf'],
    ],
  },
];
