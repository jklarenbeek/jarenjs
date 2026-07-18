//@ts-check
/**
 * Docs and Examples — placeholder modes until their content documents
 * are ported; each cross-references the current site so nothing is
 * lost during the side-by-side phase.
 */

const OLD_SITE = 'https://jklarenbeek.github.io/jarenjs/';

const placeholder = (title, text, href) =>
  ['div', { class: 'page container' },
    ['h1', {}, title],
    ['div', { class: 'callout wide' },
      ['h3', {}, 'Not yet ported to webnext'],
      ['p', {}, text],
      ['a', { href, class: 'btn' }, 'Open in the current website'],
    ],
  ];

export const STATIC_RULES = [
  {
    match: '$.ui.docs', mode: 'docs',
    body: placeholder('Documentation',
      'The documentation page (19 sections, from installation to JOSL) is being converted into a content document rendered by this stylesheet. Until then it lives on the current site.',
      `${OLD_SITE}#/docs`),
  },
  {
    match: '$.ui.examples', mode: 'examples',
    body: placeholder('Examples',
      'The per-engine example gallery is being converted next. Until then it lives on the current site.',
      `${OLD_SITE}#/examples`),
  },
];
