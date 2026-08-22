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
            ['a', { href: '#/play', class: 'btn primary' }, 'Open Play'],
            ['a', { href: '#/benchmarks', class: 'btn' }, 'See the benchmarks'],
          ],
        ],
      ],
      ['section', { class: 'container section' },
        // the grid arrives with the collected site content: `grid` exists
        // only once it has, `enginesNote` only while it has not, so the
        // page never renders a heading over an empty grid
        { $apply: ['$.enginesNote', 'ui'] },
        { $apply: '$.grid' },
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
          ['a', { href: '#/project', class: 'btn' }, 'Open the Studio'],
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
    match: '$.ui.home.grid', mode: 'home',
    // counted from the collected document rather than written down, so
    // the heading cannot drift the next time a package publishes an engine
    body: ['div', {},
      ['h2', {}, { $concat: ['One stack, ', { $count: '$.engines[*]' }, ' engines'] }],
      ['div', { class: 'engine-grid' }, [{ $apply: '$.engines[*]' }]],
    ],
  },
  {
    match: '$.ui.home.grid.engines[*]', mode: 'home',
    body: ['article', { class: 'card engine-card' },
      ['h3', {}, '$.title'],
      ['p', {}, '$.blurb'],
      ['p', { class: 'engine-perf' }, '$.perf'],
    ],
  },
];
