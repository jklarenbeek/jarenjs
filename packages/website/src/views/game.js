//@ts-check
/**
 * The adventure page — mode 'game', dispatched with `$.ui.game` as the
 * current node (derived by boundaries/game.js). The whole point-and-click
 * interface is this stylesheet over the game slice: verbs arm, hotspots
 * resolve, the flow engine moves rooms. No hand-written DOM, no game rule
 * in the view — every gesture is an action.
 */

const titleScreen =
  ['div', { class: 'game-title' },
    ['div', { class: 'game-title-card' },
      ['h1', {}, '🏴‍☠️ ', '$.title'],
      ['p', { class: 'game-goal' }, '🥪 ', '$.goal'],
      ['label', { class: 'game-name' },
        ['span', {}, 'Name your pirate'],
        ['input', { type: 'text', value: '$.pirate', placeholder: 'Guybrush Threepwood', on: { input: 'game/name' } }]],
      ['button', { class: 'btn primary game-start', type: 'button', on: { click: 'game/start' } }, 'Set sail ⛵'],
      ['p', { class: 'game-hint' },
        'Plays fully offline. Bring an OpenRouter key (assistant settings, top-right 🤖) and the whole crew answers you ',
        ['em', {}, 'live'], ', in character.'],
    ],
  ];

const dialogueOverlay =
  ['div', { class: 'game-dialogue' },
    ['div', { class: 'gd-inner' },
      ['button', { class: 'gd-close', type: 'button', title: 'End conversation', on: { click: 'game/dialogue-close' } }, '✕'],
      ['h3', {}, '$.dialogue.who'],
      ['p', { class: 'gd-text' }, '$.dialogue.text'],
      ['div', { class: 'gd-options' }, [{ $apply: '$.dialogue.options[*]' }]],
      ['div', { class: 'gd-ask' },
        ['input', { type: 'text', value: '$.ask', placeholder: 'Ask them anything…', on: { input: 'game/ask-draft' } }],
        ['button', { class: 'btn', type: 'button', on: { click: 'game/ask-send' } },
          { $if: ['$.thinking', '…', 'Ask 🤖'] }]],
    ],
  ];

const hotGroup = (title, path) =>
  { return { $if: [{ $exists: path }, ['div', { class: 'hs-group' }, ['h4', {}, title], ['div', { class: 'hs' }, [{ $apply: path }]]], ''] }; };

const playScreen =
  ['div', { class: 'game-play' },
    ['div', { class: 'game-goalbar' },
      ['strong', {}, '🥪 '], '$.goal',
      { $if: ['$.won', ['span', { class: 'game-won' }, ' ✅ TRUCE ACHIEVED'], ''] }],
    ['div', { class: 'game-stage' },
      ['section', { class: 'game-scene' },
        ['h2', {}, '$.room.icon', ' ', '$.room.name'],
        ['p', { class: 'game-look' }, '$.room.look'],
        ['div', { class: 'game-hotspots' },
          ['div', { class: 'hs-group' }, ['h4', {}, 'Exits'], ['div', { class: 'hs' }, [{ $apply: '$.room.exits[*]' }]]],
          hotGroup('Items', '$.room.items[*]'),
          hotGroup('Look at', '$.room.scenery[*]'),
          hotGroup('People', '$.room.npcs[*]')],
      ],
      ['aside', { class: 'game-side' },
        ['h4', {}, { $if: ['$.held', { $concat: ['✋ ', '$.heldName'] }, '🎒 Inventory'] }],
        ['div', { class: 'game-inv' },
          { $if: [{ $exists: '$.inv[*]' }, [{ $apply: '$.inv[*]' }], ['p', { class: 'game-muted' }, '(empty — go find things)']] }],
        ['h4', { class: 'game-maph' }, '🗺️ Map'],
        ['pre', { class: 'game-map' }, '$.mapSource'],
      ],
    ],
    ['div', { class: 'game-verbs' }, [{ $apply: '$.verbs[*]' }]],
    ['div', { class: 'game-log' }, [{ $apply: '$.log[*]' }]],
    { $if: ['$.dialogue', dialogueOverlay, ''] },
  ];

export const GAME_RULES = [
  {
    match: '$.ui.game', mode: 'game',
    body: ['div', { class: 'page container game' },
      { $if: ['$.started', playScreen, titleScreen] }],
  },
  // verbs
  {
    match: '$.ui.game.verbs[*]', mode: 'game',
    body: ['button', {
      type: 'button',
      class: { $if: ['$.active', 'game-verb on', 'game-verb'] },
      on: { click: { action: 'game/verb', with: '$.id' } },
    }, '$.label'],
  },
  // exits (navigation through the flow engine)
  {
    match: '$.ui.game.room.exits[*]', mode: 'game',
    body: ['button', { type: 'button', class: 'hs-btn exit',
      on: { click: { action: 'game/go', with: '$.id' } } }, '→ ', '$.name'],
  },
  // items / scenery / people — all resolve the armed verb
  {
    match: '$.ui.game.room.items[*]', mode: 'game',
    body: ['button', { type: 'button', class: 'hs-btn item',
      on: { click: { action: 'game/hotspot', with: '$.id' } } }, '$.name'],
  },
  {
    match: '$.ui.game.room.scenery[*]', mode: 'game',
    body: ['button', { type: 'button', class: 'hs-btn scenery',
      on: { click: { action: 'game/hotspot', with: '$.id' } } }, '$.name'],
  },
  {
    match: '$.ui.game.room.npcs[*]', mode: 'game',
    body: ['button', { type: 'button', class: 'hs-btn npc',
      on: { click: { action: 'game/hotspot', with: '$.id' } } }, '🗣 ', '$.name'],
  },
  // inventory (click to arm / combine)
  {
    match: '$.ui.game.inv[*]', mode: 'game',
    body: ['button', {
      type: 'button',
      class: { $if: ['$.held', 'game-item armed', 'game-item'] },
      on: { click: { action: 'game/inv', with: '$.id' } },
    }, '$.name'],
  },
  // narration feed
  {
    match: '$.ui.game.log[*]', mode: 'game',
    body: ['p', { class: { $concat: ['game-line ', '$.kind'] } }, '$.text'],
  },
  // dialogue options
  {
    match: '$.ui.game.dialogue.options[*]', mode: 'game',
    body: ['button', { type: 'button', class: 'gd-option',
      on: { click: { action: 'game/say-pick', with: '$.index' } } }, '$.text'],
  },
];
