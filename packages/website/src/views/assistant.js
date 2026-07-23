//@ts-check
/**
 * The AI assistant panel — mode 'assistant', dispatched with
 * `$.ui.assistant` as the current node. A global slide-out on every
 * page: a bring-your-own-key chat that drives the playground through
 * @jarenjs/ai's schema-guarded tools. Assistant replies render through
 * the @jarenjs/md component (dogfooding); the streaming reply is plain
 * text because it changes per token.
 */

const settingsForm =
  ['form', { class: 'ai-settings', on: { submit: 'ai/save-settings' } },
    ['p', { class: 'ai-hint' },
      'Bring your own key. Everything runs in your browser — your key is stored locally and sent only to the provider you choose, never to us.'],
    ['label', { class: 'ai-field' },
      ['span', {}, 'Provider'],
      ['select', {
        class: 'select',
        on: { change: { action: 'ai/setting', with: { key: 'provider' } } },
      }, [{ $apply: '$.providers[*]' }]],
    ],
    { $if: ['$.settings.needsKey',
      ['label', { class: 'ai-field' },
        ['span', {}, 'API key'],
        ['input', {
          type: 'password', class: 'editor line', spellcheck: 'false',
          autocomplete: 'off', placeholder: 'sk-…', value: '$.settings.apiKey',
          on: { input: { action: 'ai/setting', with: { key: 'apiKey' } } },
        }],
      ]] },
    ['label', { class: 'ai-field' },
      ['span', {}, 'Base URL'],
      ['input', {
        type: 'text', class: 'editor line', spellcheck: 'false',
        placeholder: 'http://localhost:11434 · https://…/v1',
        value: '$.settings.baseUrl',
        on: { input: { action: 'ai/setting', with: { key: 'baseUrl' } } },
      }],
    ],
    ['label', { class: 'ai-field' },
      ['span', {}, 'Model'],
      ['input', {
        type: 'text', class: 'editor line', spellcheck: 'false',
        placeholder: 'qwen/qwen3-4b · llama3.2 · …', value: '$.settings.model',
        on: { input: { action: 'ai/setting', with: { key: 'model' } } },
      }],
    ],
    ['button', { type: 'submit', class: 'btn small' }, 'Save'],
  ];

const intro =
  ['div', { class: 'ai-intro' },
    ['p', {}, 'Ask me to validate a schema or run any playground engine — I drive the playground for you, all in your browser.'],
    ['ul', {},
      ['li', {}, '“Validate this against a schema requiring name and email.”'],
      ['li', {}, '“Write a JSLT stylesheet that upper-cases every title.”'],
      ['li', {}, '“Use JSONPath to pull every price from this document.”'],
    ],
  ];

const composer =
  ['form', { class: 'ai-composer', on: { submit: 'ai/send' } },
    ['textarea', {
      class: 'editor', rows: 2, spellcheck: 'false',
      placeholder: 'Ask the assistant…', value: '$.draft',
      on: { input: 'ai/draft' },
    }],
    ['button', {
      type: 'submit', class: 'btn small ai-send',
      disabled: { $if: [{ $eq: ['$.status', 'streaming'] }, 'disabled', false] },
    }, { $if: [{ $eq: ['$.status', 'streaming'] }, '…', 'Send'] }],
  ];

const panel =
  ['div', { class: 'ai-panel' },
    ['div', { class: 'ai-head' },
      ['span', { class: 'ai-title' }, 'Jaren assistant'],
      ['button', {
        type: 'button', class: 'ai-icon', title: 'Settings',
        'aria-label': 'Assistant settings', on: { click: 'ai/settings-toggle' },
      }, '⚙'],
      ['button', {
        type: 'button', class: 'ai-icon', title: 'Clear the conversation',
        'aria-label': 'Clear conversation', on: { click: 'ai/clear' },
      }, '⌫'],
      ['button', {
        type: 'button', class: 'ai-icon', title: 'Close',
        'aria-label': 'Close assistant', on: { click: 'ai/toggle' },
      }, '✕'],
    ],
    { $if: ['$.showSettings', settingsForm] },
    ['div', { class: 'ai-log' },
      { $if: ['$.empty', intro] },
      [{ $apply: '$.messages[*]' }],
      { $if: [{ $and: ['$.streaming', '$.pending'] },
        ['div', { class: 'ai-msg assistant' }, ['p', {}, '$.pending']]] },
      { $if: ['$.activity',
        ['p', { class: 'ai-activity' }, 'Running ', ['code', {}, '$.activity'], '…']] },
      { $if: [{ $and: [{ $eq: ['$.status', 'streaming'] }, { $not: '$.pending' }, { $not: '$.activity' }] },
        ['p', { class: 'ai-activity' }, 'Thinking…']] },
      { $if: ['$.error', ['p', { class: 'ai-error' }, '$.error']] },
    ],
    composer,
  ];

export const ASSISTANT_RULES = [
  {
    match: '$.ui.assistant', mode: 'assistant',
    body: ['div', { class: { $if: ['$.open', 'ai open', 'ai'] } },
      ['button', {
        type: 'button', class: 'ai-launch', title: 'Open the Jaren assistant',
        'aria-label': 'Open the Jaren assistant', on: { click: 'ai/toggle' },
      }, '✦ Assistant'],
      { $if: ['$.open', panel] },
    ],
  },
  {
    match: '$.ui.assistant.providers[*]', mode: 'assistant',
    body: ['option', { value: '$.value', selected: '$.selected' }, '$.label'],
  },
  {
    match: "$.ui.assistant.messages[?@.role == 'user']", mode: 'assistant',
    body: ['div', { class: 'ai-msg user' }, ['p', {}, '$.text']],
  },
  {
    // the assistant reply is a ready-made @jarenjs/md vnode, spliced
    // in verbatim (no dispatch into it)
    match: "$.ui.assistant.messages[?@.role == 'assistant']", mode: 'assistant',
    body: ['div', { class: 'ai-msg assistant' }, '$.article'],
  },
];
