//@ts-check
/**
 * The site shell — the unnamed-mode rules: root layout, header with
 * live nav, theme toggle, footer, and the per-page mode dispatch.
 * Every rule body is a query document producing vnodes (VIEW-FORMAT).
 */

const BASE = import.meta.env?.BASE_URL ?? '/';

const header =
  ['header', { class: 'header' },
    ['div', { class: 'container header-inner' },
      ['a', { href: '#/', class: 'brand' },
        ['img', { src: `${BASE}jaren.svg`, alt: '', class: 'brand-logo' }],
        ['span', { class: 'brand-name' }, 'Jaren'],
      ],
      ['nav', { class: { $if: ['$.menu', 'nav open', 'nav'] } }, [{ $apply: '$.ui.nav[*]' }]],
      ['button', {
        class: 'theme-toggle',
        type: 'button',
        title: 'Toggle color theme',
        on: { click: 'theme/toggle' },
      }, { $if: [{ $eq: ['$.theme', 'dark'] }, '☀', '☾'] }],
      ['button', {
        class: 'menu-toggle',
        type: 'button',
        title: 'Menu',
        'aria-label': 'Toggle navigation',
        on: { click: 'menu/toggle' },
      }, { $if: ['$.menu', '✕', '☰'] }],
    ],
  ];

const footer =
  ['footer', { class: 'footer' },
    ['div', { class: 'container footer-inner' },
      ['p', {}, 'MIT licensed. Built with the Jaren suite itself: this page is a JSLT stylesheet over one JSON state document.'],
      ['nav', { class: 'footer-links' },
        ['a', { href: 'https://github.com/jklarenbeek/jarenjs' }, 'GitHub'],
        ['a', { href: 'https://www.npmjs.com/package/@jarenjs/validate' }, 'npm'],
      ],
    ],
  ];

export const SHELL_RULES = [
  {
    match: '$',
    body: ['div', { class: 'site' },
      header,
      // the viewModel materializes only the active page's node; the
      // other selectors come back empty and render nothing
      ['main', { class: 'main' },
        { $apply: ['$.ui.home', 'home'] },
        { $apply: ['$.ui.pg', 'playground'] },
        { $apply: ['$.ui.bench', 'benchmarks'] },
        { $apply: ['$.ui.docs', 'docs'] },
        { $apply: ['$.ui.examples', 'examples'] },
      ],
      footer,
    ],
  },
  {
    match: '$.ui.nav[*]',
    body: ['a', {
      href: '$.href',
      class: { $if: ['$.active', 'nav-link active', 'nav-link'] },
    }, '$.label'],
  },
];
