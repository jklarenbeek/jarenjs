//@ts-check
/**
 * The Studio — mode 'studio', dispatched with `$.ui.studio` as the
 * current node. A user- or AI-authored `@jarenjs/app` document — state,
 * stylesheet and actions as one JSON value — hosted as an isolated
 * nested app next to the site's own: the AI writes JSON, Jaren's
 * meta-schema gates every boot, the app runtime runs it. No eval, no
 * server.
 *
 * Two states: a template picker while no document is loaded, and the
 * split view — the collapsible JSON editor with the IDE bar, and the
 * live render mount (`jaren-widget` 'studio-doc', whose mount/destroy
 * owns the nested app).
 */

const ideBar =
  ['div', { class: 'ide-bar' },
    ['input', {
      type: 'text',
      class: 'ide-name',
      placeholder: 'Experiment name…',
      value: '$.ide.name',
      on: { input: 'ide/name' },
    }],
    ['button', { type: 'button', class: 'btn small', on: { click: 'ide/save' } }, 'Save'],
    ['button', {
      type: 'button', class: 'btn small', title: 'Copy a link that restores this document',
      on: { click: 'ide/share' },
    }, 'Share'],
    ['button', {
      type: 'button', class: 'btn small', title: 'Download the document as JSON',
      on: { click: 'studio/download' },
    }, 'Download'],
    ['button', {
      type: 'button', class: 'btn small', title: 'Discard the document and pick a template',
      on: { click: 'studio/clear' },
    }, 'New'],
    { $if: ['$.ide.shared', ['span', { class: 'muted' }, '$.ide.shared']] },
    ['div', { class: 'ide-list' }, [{ $apply: '$.ide.names[*]' }]],
  ];

const editorCard =
  ['div', { class: 'card pg-card studio-editor' },
    ideBar,
    ['details', { class: 'details-card', open: true },
      ['summary', {}, 'Document (JSON)'],
      ['textarea', {
        class: 'editor',
        rows: 22,
        spellcheck: 'false',
        value: '$.editorText',
        on: { change: 'studio/text' },
      }],
      ['p', { class: 'muted' },
        'Edits apply when the field loses focus — the document is re-validated against the jaren-app meta-schema before it swaps in.'],
    ],
    { $if: ['$.error', ['p', { class: 'error-line' }, '$.error']] },
  ];

const stageCard =
  ['div', { class: 'card pg-card studio-stage' },
    ['div', { class: 'card-head' },
      ['h3', {}, 'Live render'],
      ['span', { class: 'muted' }, 'rev ', '$.revision'],
    ],
    ['div', { class: 'studio-mount' },
      ['jaren-widget', { name: 'studio-doc', props: '$.mount' }],
    ],
  ];

export const STUDIO_RULES = [
  {
    match: '$.ui.studio', mode: 'studio',
    body: ['div', { class: 'page container' },
      ['h1', {}, 'Studio'],
      ['p', { class: 'page-lead' },
        'A complete Jaren application — state, view and actions as one JSON document — authored by you or the assistant, validated by the jaren-app meta-schema, and run live by the real @jarenjs/app runtime. No eval, no server: the document is inert JSON.'],
      // keyed structural children: when the error block appears or
      // disappears, unkeyed positional reconciliation would patch the
      // split-view div INTO the error div (both are divs), destroying
      // and remounting the host widget — rebooting the nested app
      { $if: ['$.hasErrors',
        ['div', { key: 'studio-errors', class: 'studio-errors' }, [{ $apply: ['$.errors[*]', 'ui'] }]]] },
      { $apply: '$.picker' },
      { $apply: '$.live' },
    ],
  },
  {
    match: '$.ui.studio.picker', mode: 'studio',
    body: ['div', { key: 'studio-picker' },
      ['p', { class: 'page-lead' },
        'Start from a seed template — every one is a complete, boot-tested app document. Or ask the assistant: it authors documents here via template + patch.'],
      ['div', { class: 'example-grid' }, [{ $apply: '$.templates[*]' }]],
    ],
  },
  {
    match: '$.ui.studio.picker.templates[*]', mode: 'studio',
    body: ['article', { class: 'card example-card' },
      ['div', { class: 'card-head' },
        ['h3', {}, '$.title'],
        ['button', {
          type: 'button',
          class: 'btn small',
          on: { click: { action: 'studio/template', with: '$.name' } },
        }, 'Load'],
      ],
      ['p', { class: 'muted' }, '$.lead'],
      ['pre', { class: 'code-block clamp' }, ['code', {}, '$.preview']],
    ],
  },
  {
    match: '$.ui.studio.live', mode: 'studio',
    body: ['div', { key: 'studio-live', class: 'studio-grid' }, editorCard, stageCard],
  },
  {
    match: '$.ui.studio.live.ide.names[*]', mode: 'studio',
    body: ['span', { class: 'ide-chip' },
      ['button', {
        type: 'button', class: 'ide-load', title: 'Load this experiment',
        on: { click: { action: 'ide/load', with: '$.name' } },
      }, '$.name'],
      ['button', {
        type: 'button', class: 'ide-delete', title: 'Delete this experiment',
        on: { click: { action: 'ide/delete', with: '$.name' } },
      }, '×'],
    ],
  },
];
