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
      ['nav', { id: 'site-nav', class: { $if: ['$.menu', 'nav open', 'nav'] } },
        { $apply: '$.ui.nav.home' },
        [{ $apply: '$.ui.nav.groups[*]' }],
      ],
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
        'aria-expanded': { $if: ['$.menu', 'true', 'false'] },
        'aria-controls': 'site-nav',
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
        { $apply: ['$.ui.studio', 'studio'] },
        { $apply: ['$.ui.project', 'project'] },
        { $apply: ['$.ui.play', 'play'] },
        { $apply: ['$.ui.flow', 'flow'] },
        { $apply: ['$.ui.game', 'game'] },
        { $apply: ['$.ui.data', 'data'] },
        { $apply: ['$.ui.bench', 'benchmarks'] },
        { $apply: ['$.ui.chartsPage', 'charts'] },
        { $apply: ['$.ui.docs', 'docs'] },
        { $apply: ['$.ui.calculator', 'calculator'] },
      ],
      footer,
      // the package-README overlay: absent (renders nothing) until opened
      { $apply: ['$.ui.readme', 'readme'] },
      // the AI assistant slide-out: present on every page
      { $apply: ['$.ui.assistant', 'assistant'] },
    ],
  },
  // the standalone Home link (before the dropdown groups)
  {
    match: '$.ui.nav.home',
    body: ['a', {
      href: '$.href',
      class: { $if: ['$.active', 'nav-link active', 'nav-link'] },
    }, '$.label'],
  },
  // one dropdown group: a trigger button (aria-expanded) + its menu panel.
  // The panel's links live in the DOM always; CSS shows them when `.open`.
  {
    match: '$.ui.nav.groups[*]',
    body: ['div', { class: { $if: ['$.open', 'nav-group open', 'nav-group'] } },
      ['button', {
        type: 'button',
        class: { $if: ['$.active', 'nav-trigger active', 'nav-trigger'] },
        'aria-haspopup': 'true',
        'aria-expanded': { $if: ['$.open', 'true', 'false'] },
        on: { click: { action: 'nav/toggle', with: '$.key' } },
      }, '$.label', ['span', { class: 'nav-caret', 'aria-hidden': 'true' }, '▾']],
      ['div', { class: 'nav-menu', role: 'menu' }, [{ $apply: '$.items[*]' }]],
    ],
  },
  // one link inside a dropdown group (closing the menu is handled globally:
  // route/set on navigation, or Escape / an outside click from main.js)
  {
    match: '$.ui.nav.groups[*].items[*]',
    body: ['a', {
      href: '$.href',
      role: 'menuitem',
      class: { $if: ['$.active', 'nav-link active', 'nav-link'] },
    }, '$.label'],
  },
];
