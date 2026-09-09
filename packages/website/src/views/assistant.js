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
  ['form', { class: 'ai-settings',
    on: { submit: { action: 'ai/save-settings', preventDefault: true } } },
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
        type: 'text', class: 'editor line', spellcheck: 'false', list: 'ai-models',
        placeholder: 'qwen/qwen3-4b · llama3.2 · …', value: '$.settings.model',
        on: { input: { action: 'ai/setting', with: { key: 'model' } } },
      }],
      // a successful probe fills this in: the input becomes a picker
      ['datalist', { id: 'ai-models' }, [{ $apply: '$.settings.probe.models[*]' }]],
    ],
    ['div', { class: 'ai-settings-actions' },
      ['button', { type: 'submit', class: 'btn small' }, 'Save'],
      ['button', {
        type: 'button', class: 'btn small',
        disabled: { $if: ['$.settings.probe.busy', 'disabled', false] },
        on: { click: 'ai/probe' },
      }, { $if: ['$.settings.probe.busy', 'Testing…', 'Test connection'] }],
    ],
    { $if: ['$.settings.probe.ok', ['p', { class: 'ai-hint' }, '$.settings.probe.detail']] },
    { $if: ['$.settings.probe.fail', ['p', { class: 'ai-error' }, '$.settings.probe.detail']] },
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

// unconfigured: no composer to type into yet — point at the settings
// form above instead of presenting a chat that cannot send
const setupIntro =
  ['div', { class: 'ai-intro' },
    ['p', {}, 'Pick a provider above, add a model (and a key for OpenRouter), then save — the chat opens right here. Nothing leaves your browser except the calls to the provider you choose.'],
  ];

const composer =
  ['form', { class: 'ai-composer',
    on: { submit: { action: 'ai/send', preventDefault: true } } },
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

// The ledger surface: one objective that outlives the tab, what has
// been recorded against it, and the archived rounds a compacted session
// can still reach. Without a goal it is a single input — the smallest
// thing that can be ignored.
const goalForm =
  ['form', { class: 'ai-goal-set',
    on: { submit: { action: 'ai/goal-set', preventDefault: true } } },
    ['input', {
      type: 'text', class: 'editor line', spellcheck: 'false',
      placeholder: 'Set an objective the assistant keeps across sessions…',
      value: '$.goalDraft',
      on: { input: 'ai/goal-draft' },
    }],
    ['button', { type: 'submit', class: 'btn small' }, 'Set'],
  ];

const goalPanel =
  ['div', { class: 'ai-goal' },
    ['div', { class: 'ai-goal-head' },
      ['span', { class: 'ai-goal-label' }, 'Objective'],
      ['button', {
        type: 'button', class: 'ai-icon', title: 'Clear the objective',
        'aria-label': 'Clear the objective', on: { click: 'ai/goal-clear' },
      }, '✕'],
    ],
    ['p', { class: 'ai-goal-text' }, '$.goal.objective'],
    ['ul', { class: 'ai-goal-progress' }, [{ $apply: '$.goal.progress[*]' }]],
    { $if: ['$.goal.checkpointLabel', ['p', { class: 'ai-hint' }, '$.goal.checkpointLabel']] },
    { $if: ['$.goal.more', ['p', { class: 'ai-hint' }, '…and ', '$.goal.more', ' earlier entries']] },
    ['div', { class: 'ai-goal-actions' },
      ['button', {
        type: 'button', class: 'btn small',
        disabled: { $if: ['$.remembering', 'disabled', false] },
        on: { click: 'ai/remember' },
      }, { $if: ['$.remembering', 'Remembering…', 'Remember this session'] }],
      { $if: ['$.memories', ['span', { class: 'ai-hint' }, '$.memoryLabel']] },
    ],
    { $if: ['$.remembered', ['p', { class: 'ai-hint' }, '$.remembered']] },
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
    { $if: ['$.configured', { $if: ['$.goal', goalPanel, goalForm] }] },
    ['div', { class: 'ai-log' },
      { $if: ['$.empty', { $if: ['$.configured', intro, setupIntro] }] },
      [{ $apply: '$.messages[*]' }],
      { $if: [{ $and: ['$.streaming', '$.pending'] },
        ['div', { class: 'ai-msg assistant' }, ['p', {}, '$.pending']]] },
      { $if: ['$.activity',
        ['p', { class: 'ai-activity' }, 'Running ', ['code', {}, '$.activity'], '…']] },
      { $if: [{ $and: [{ $eq: ['$.status', 'streaming'] }, { $not: '$.pending' }, { $not: '$.activity' }] },
        ['p', { class: 'ai-activity' }, '$.thinkingLabel']] },
      { $if: ['$.error', ['p', { class: 'ai-error' }, '$.error']] },
      // a compacted session says so: the rounds that left the request are
      // in slots with addresses, not gone, and the panel is where that
      // stops being an implementation detail
      { $if: ['$.persistenceLabel', ['p', { class: 'ai-archived' }, '$.persistenceLabel']] },
      { $if: ['$.retentionLabel', ['p', { class: 'ai-archived' }, '$.retentionLabel']] },
      { $if: ['$.archived', ['p', { class: 'ai-archived' }, '$.archivedLabel']] },
    ],
    { $if: ['$.configured', composer] },
  ];

export const ASSISTANT_RULES = [
  {
    match: '$.ui.assistant', mode: 'assistant',
    body: ['div', { class: { $if: ['$.open', 'ai open', 'ai'] } },
      ['button', {
        type: 'button', class: 'ai-launch', title: 'Open the Jaren assistant',
        'aria-label': 'Open the Jaren assistant', on: { click: 'ai/toggle' },
      }, '✦', ['span', { class: 'ai-launch-label' }, ' Assistant']],
      { $if: ['$.open', panel] },
    ],
  },
  {
    match: '$.ui.assistant.providers[*]', mode: 'assistant',
    body: ['option', { value: '$.value', selected: '$.selected' }, '$.label'],
  },
  {
    match: '$.ui.assistant.settings.probe.models[*]', mode: 'assistant',
    body: ['option', { value: '$.id' }],
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
  {
    // one recorded step towards the objective. The evidence is shown
    // beside the note, always: a progress log of unevidenced claims is
    // exactly what the ledger's schema refuses to store, and the panel
    // should not present one either.
    match: '$.ui.assistant.goal.progress[*]', mode: 'assistant',
    body: ['li', {}, '$.note', ['span', { class: 'ai-evidence' }, '$.evidence']],
  },
];
