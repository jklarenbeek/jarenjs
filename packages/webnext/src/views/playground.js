//@ts-check
/**
 * The playground — mode 'playground', dispatched with `$.ui.pg` as the
 * current node. The JSON Schema tab is fully live: schema edits
 * recompile per keystroke (debounced through the wire() subscriber),
 * the data pane is a generated form rendered by the STANDARD FORMS
 * STYLESHEET (mode 'form') or a raw JSON editor, and errors localize
 * at report time (EN/NL). The other engine tabs cross-reference the
 * current site until they're ported.
 */

const OLD_SITE = 'https://jklarenbeek.github.io/jarenjs/';

const schemaCard =
  ['div', { class: 'card pg-card' },
    ['div', { class: 'card-head' },
      ['h3', {}, 'JSON Schema'],
      ['div', { class: 'chips' }, [{ $apply: '$.examples[*]' }]],
    ],
    ['textarea', {
      class: 'editor',
      rows: 20,
      spellcheck: 'false',
      value: '$.schemaText',
      on: { input: 'pg/schema-text' },
    }],
    { $if: [{ $eq: ['$.result.status', 'schema-error'] },
      ['p', { class: 'error-line' }, '$.result.schemaError']] },
  ];

const dataCard =
  ['div', { class: 'card pg-card' },
    ['div', { class: 'card-head' },
      ['h3', {}, 'Data'],
      ['div', { class: 'seg' },
        ['button', {
          type: 'button',
          class: { $if: [{ $eq: ['$.dataTab', 'form'] }, 'seg-btn active', 'seg-btn'] },
          on: { click: { action: 'pg/data-tab', with: 'form' } },
        }, 'Generated form'],
        ['button', {
          type: 'button',
          class: { $if: [{ $eq: ['$.dataTab', 'json'] }, 'seg-btn active', 'seg-btn'] },
          on: { click: { action: 'pg/data-tab', with: 'json' } },
        }, 'JSON'],
      ],
    ],
    { $if: [{ $eq: ['$.dataTab', 'form'] },
      { $if: [{ $ne: ['$.form', null] },
        { $apply: ['$.form', 'form'] },
        ['p', { class: 'muted' }, 'No form can be generated for this schema — switch to the JSON tab.'],
      ] },
      ['div', {},
        ['textarea', {
          class: 'editor',
          rows: 16,
          spellcheck: 'false',
          value: '$.dataJson',
          on: { change: 'pg/data-text' },
        }],
        ['p', { class: 'muted' }, 'Edits apply when the field loses focus.'],
        { $if: ['$.dataError', ['p', { class: 'error-line' }, '$.dataError']] },
      ],
    ] },
  ];

const resultCard =
  ['div', { class: 'card pg-card result-card' },
    ['div', { class: 'card-head' },
      ['h3', {}, 'Validation'],
      ['div', { class: 'seg' },
        ['button', {
          type: 'button',
          class: { $if: [{ $eq: ['$.locale', 'en'] }, 'seg-btn active', 'seg-btn'] },
          on: { click: { action: 'pg/locale', with: 'en' } },
        }, 'EN'],
        ['button', {
          type: 'button',
          class: { $if: [{ $eq: ['$.locale', 'nl'] }, 'seg-btn active', 'seg-btn'] },
          on: { click: { action: 'pg/locale', with: 'nl' } },
        }, 'NL'],
      ],
    ],
    { $if: [{ $eq: ['$.result.status', 'valid'] },
      ['p', { class: 'badge ok' }, 'Valid']] },
    { $if: [{ $eq: ['$.result.status', 'invalid'] },
      ['div', {},
        ['p', { class: 'badge fail' }, 'Invalid'],
        ['ul', { class: 'error-list' }, [{ $apply: '$.result.errors[*]' }]],
      ]] },
    { $if: ['$.result.timing',
      ['p', { class: 'muted' }, '$.result.draft', ' · ', '$.result.timing']] },
  ];

export const PLAYGROUND_RULES = [
  {
    match: '$.ui.pg', mode: 'playground',
    body: ['div', { class: 'page container' },
      ['h1', {}, 'Playground'],
      ['p', { class: 'page-lead' },
        'Every engine runs live in your browser with the real shipped compilers — no server, no eval.'],
      ['nav', { class: 'tabs' }, [{ $apply: '$.engines[*]' }]],
      { $if: [{ $ne: ['$.validate', null] },
        { $apply: '$.validate' },
        ['div', { class: 'callout wide' },
          ['h3', {}, 'Not yet ported to webnext'],
          ['p', {}, 'This engine playground still lives on the current site while webnext is built out.'],
          ['a', {
            href: { $concat: [`${OLD_SITE}#/playground?engine=`, '$.engine'] },
            class: 'btn',
          }, 'Open in the current website'],
        ],
      ] },
    ],
  },
  {
    match: '$.ui.pg.validate', mode: 'playground',
    body: ['div', { class: 'pg-grid' }, schemaCard, dataCard, resultCard],
  },
  {
    match: '$.ui.pg.engines[*]', mode: 'playground',
    body: ['a', {
      href: '$.href',
      class: { $if: ['$.active', 'tab active', 'tab'] },
    }, '$.label'],
  },
  {
    match: '$.ui.pg.validate.examples[*]', mode: 'playground',
    body: ['button', {
      type: 'button',
      class: 'chip',
      on: { click: { action: 'pg/example', with: { schemaText: '$.schemaText', data: '$.data' } } },
    }, '$.label'],
  },
  {
    match: '$.ui.pg.validate.result.errors[*]', mode: 'playground',
    body: ['li', { class: 'error-item' },
      ['code', {}, '$.path'],
      ['span', {}, ' — ', '$.message'],
    ],
  },
];
