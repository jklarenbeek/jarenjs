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
          { $apply: '$.dispatch' },
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

  // The living dispatch. Nothing under `$.dispatch.stages` is written
  // here: every title, state and summary was recorded from a real run
  // through @jarenjs/contract's local binding, so this rule only decides
  // where it goes. The stage list is keyed on the run's revision, so a
  // re-dispatch MOUNTS a new list and its entrance plays again — a
  // reused element would keep the animation it already ran.
  {
    match: '$.ui.home.dispatch', mode: 'home',
    body: ['div', { class: 'hero-demo' },
      ['h2', { class: 'hero-demo-title' }, '$.title'],
      ['p', { class: 'hero-demo-lead' }, '$.lead'],
      ['div', { class: 'hero-demo-grid' },
        ['div', { class: 'hero-panel' },
          ['div', { class: 'hero-panel-head' },
            ['h3', {}, 'Input'],
            ['div', { class: 'seg', role: 'group', 'aria-label': 'input' },
              ['button', {
                type: 'button',
                class: { $if: [{ $eq: ['$.variant', 'valid'] }, 'seg-btn active', 'seg-btn'] },
                'aria-pressed': { $if: [{ $eq: ['$.variant', 'valid'] }, 'true', 'false'] },
                on: { click: { action: 'hero/pick', with: 'valid' } },
              }, 'Valid'],
              ['button', {
                type: 'button',
                class: { $if: [{ $eq: ['$.variant', 'invalid'] }, 'seg-btn active', 'seg-btn'] },
                'aria-pressed': { $if: [{ $eq: ['$.variant', 'invalid'] }, 'true', 'false'] },
                on: { click: { action: 'hero/pick', with: 'invalid' } },
              }, 'Break it'],
            ],
          ],
          ['textarea', {
            class: 'editor hero-editor', rows: 9, spellcheck: 'false',
            'aria-label': 'dispatch input',
            value: '$.input', on: { change: 'hero/edit' },
          }],
          ['div', { class: 'hero-controls' },
            ['button', { type: 'button', class: 'btn primary', on: { click: 'hero/dispatch' } }, 'Dispatch'],
            ['button', { type: 'button', class: 'btn hero-step', on: { click: 'hero/step' } }, 'Step'],
            ['span', { class: 'hero-status' }, '$.status'],
          ],
          ['p', { class: 'hero-hint' }, '$.edit'],
        ],
        ['div', { class: 'hero-panel' },
          { $apply: ['$.refusal', 'ui'] },
          ['ol', { class: 'hero-stages', key: '$.revision' }, [{ $apply: '$.stages[*]' }]],
          { $apply: '$.focused' },
          { $apply: '$.identity' },
        ],
      ],
      ['p', { class: 'hero-demo-links' }, [{ $apply: '$.links[*]' }]],
      ['p', { class: 'hero-demo-caption' }, '$.caption'],
    ],
  },
  {
    match: '$.ui.home.dispatch.stages[*]', mode: 'home',
    body: ['li', {
      class: { $concat: ['hero-stage is-', '$.state', { $if: ['$.focused', ' is-focus', ''] }] },
    },
      ['button', {
        type: 'button', class: 'hero-stage-btn',
        'aria-pressed': { $if: ['$.focused', 'true', 'false'] },
        on: { click: { action: 'hero/focus', with: '$.index' } },
      },
        ['span', { class: 'hero-stage-title' }, '$.title'],
        ['span', { class: 'hero-stage-summary' }, '$.summary'],
      ],
    ],
  },
  {
    match: '$.ui.home.dispatch.focused', mode: 'home',
    body: ['pre', { class: 'hero-artifact' },
      ['code', {}, '$.artifact'],
    ],
  },
  {
    match: '$.ui.home.dispatch.identity', mode: 'home',
    body: ['p', { class: 'hero-identity' },
      ['span', {}, { $concat: ['$.id', ' v', '$.version', ' · ', '$.binding', ' binding · revision'] }],
      ['code', {}, '$.revision'],
    ],
  },
  {
    match: '$.ui.home.dispatch.links[*]', mode: 'home',
    body: ['a', { href: '$.href', class: 'hero-demo-link' }, '$.label'],
  },
];
