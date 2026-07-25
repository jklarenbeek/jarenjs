//@ts-check
/**
 * The playground — mode 'playground', dispatched with `$.ui.pg` as the
 * current node. Nine live engines: the JSON Schema tab (special-cased:
 * generated form + report-time i18n) and eight generic engines driven
 * entirely by the ENGINE_DEFS descriptors — the rules below render ANY
 * engine's fields and results. The IDE bar saves and recalls
 * experiments through the localStorage-backed ide-* effects.
 */

import { LOCALES } from '../boundaries/validator.js';
import { ideBar, ideNamesRule } from './ide.js';

/** One segment button of the error-locale switcher. */
const localeButton = (code) => ['button', {
  type: 'button',
  class: { $if: [{ $eq: ['$.locale', code] }, 'seg-btn active', 'seg-btn'] },
  on: { click: { action: 'pg/locale', with: code } },
}, code.toUpperCase()];

const pgIdeBar = ideBar('Copy a link that restores this experiment');

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
      ['div', { class: 'seg' }, ...LOCALES.map(localeButton)],
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
        'Every engine runs live in your browser with the real shipped compilers — no server, no eval. Save any state of an engine as a named experiment and recall it later.'],
      ['nav', { class: 'tabs' }, [{ $apply: '$.engines[*]' }]],
      pgIdeBar,
      { $apply: '$.validate' },
      { $apply: '$.generic' },
    ],
  },
  {
    match: '$.ui.pg.engines[*]', mode: 'playground',
    body: ['a', {
      href: '$.href',
      class: { $if: ['$.active', 'tab active', 'tab'] },
    }, '$.label'],
  },
  ideNamesRule('$.ui.pg.ide.names[*]', 'playground'),

  // ---- the validate engine (special-cased: forms + i18n) ----
  {
    match: '$.ui.pg.validate', mode: 'playground',
    body: ['div', { class: 'pg-grid' }, schemaCard, dataCard, resultCard],
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

  // ---- the generic engines: fields + results, all from descriptors ----
  {
    match: '$.ui.pg.generic', mode: 'playground',
    body: ['div', {},
      ['p', { class: 'page-lead' }, '$.lead'],
      ['div', { class: 'chips' }, [{ $apply: '$.examples[*]' }]],
      ['div', { class: 'pg-grid two' },
        ['div', { class: 'card pg-card' },
          ['h3', {}, '$.label'],
          [{ $apply: '$.fields[*]' }],
        ],
        ['div', { class: 'pg-results' }, [{ $apply: ['$.results[*]', 'ui'] }]],
      ],
    ],
  },
  {
    match: '$.ui.pg.generic.examples[*]', mode: 'playground',
    body: ['button', {
      type: 'button',
      class: 'chip',
      on: { click: { action: 'eng/load', with: { engine: '$.engine', inputs: '$.inputs' } } },
    }, '$.label'],
  },
  {
    match: "$.ui.pg.generic.fields[?@.control == 'json' || @.control == 'code']", mode: 'playground',
    body: ['label', { class: 'field' },
      ['span', { class: 'field-title' }, '$.title'],
      ['textarea', {
        class: 'editor',
        rows: '$.rows',
        spellcheck: 'false',
        value: '$.value',
        on: { input: { action: 'eng/input', with: { engine: '$.engine', key: '$.key' } } },
      }],
    ],
  },
  {
    match: "$.ui.pg.generic.fields[?@.control == 'text']", mode: 'playground',
    body: ['label', { class: 'field' },
      ['span', { class: 'field-title' }, '$.title'],
      ['input', {
        type: 'text',
        class: 'editor line',
        spellcheck: 'false',
        value: '$.value',
        on: { input: { action: 'eng/input', with: { engine: '$.engine', key: '$.key' } } },
      }],
    ],
  },
  {
    match: "$.ui.pg.generic.fields[?@.control == 'select']", mode: 'playground',
    body: ['label', { class: 'field' },
      ['span', { class: 'field-title' }, '$.title'],
      ['select', {
        class: 'select',
        on: { change: { action: 'eng/input', with: { engine: '$.engine', key: '$.key' } } },
      }, [{ $apply: '$.options[*]' }]],
    ],
  },
  {
    match: '$.ui.pg.generic.fields[*].options[*]', mode: 'playground',
    body: ['option', { value: '$.value', selected: '$.selected' }, '$.value'],
  },
];
