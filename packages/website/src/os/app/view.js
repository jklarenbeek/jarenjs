//@ts-check
/**
 * The OS view: one JSLT stylesheet (VIEW-FORMAT vnodes out) over the
 * view model (`viewmodel.js`). The stage is a widget the stylesheet
 * feeds a scene document through the `scene` mode; every window is a
 * mode of its own, applied only while its app is open; every repeated
 * row is a rule matched by JSONPath, so a row whose data did not change
 * comes back as the same vnode and the renderer skips it whole.
 *
 * Written as JavaScript only to keep the repetitive parts (icons, the
 * dock, buttons) as small builders; what this module exports is plain
 * JSON — the document the Source app shows under "The view".
 */

import { SCENE_RULES } from './scene.js';

/** The dock: every app, in order. */
export const APPS = Object.freeze([
  { id: 'council', label: 'Council' },
  { id: 'machine', label: 'Machine' },
  { id: 'source', label: 'Source' },
  { id: 'exports', label: 'Exports' },
  { id: 'gallery', label: 'Gallery' },
  { id: 'about', label: 'About' },
]);

/** Line icons in the OS's own drawing style: round caps, one weight,
 * drawn with `currentColor` so they follow the theme. */
const ICONS = /** @type {Record<string, any[]>} */ ({
  council: [
    ['circle', { cx: 6, cy: 7, r: 2.2 }], ['circle', { cx: 12, cy: 5, r: 2.2 }], ['circle', { cx: 18, cy: 7, r: 2.2 }],
    ['path', { d: 'M6 10v6M12 8v8M18 10v6M3 13l3-2 3 2M9 11l3-2 3 2M15 13l3-2 3 2M4 21l2-5 2 5M10 21l2-5 2 5M16 21l2-5 2 5' }],
  ],
  machine: [
    ['path', { d: 'M3 18h18M3 22h18M7 18v4M11 18v4M15 18v4M19 18v4' }],
    ['circle', { cx: 12, cy: 5, r: 2.4 }], ['path', { d: 'M12 8v6M8 10l4 2 4-2M9 16l3-2 3 2' }],
  ],
  source: [['path', { d: 'M8 4L3 12l5 8M16 4l5 8-5 8M13.5 6l-3 12' }]],
  exports: [['path', { d: 'M12 3v11M7 9l5 5 5-5M4 15v5h16v-5' }]],
  gallery: [['path', { d: 'M3 4h18v16H3zM3 16l5-5 4 4 3-3 6 6' }], ['circle', { cx: 15.5, cy: 8.5, r: 1.6 }]],
  about: [['circle', { cx: 12, cy: 12, r: 8.5 }], ['path', { d: 'M12 11v6M12 7.5v.5' }]],
  hand: [['path', { d: 'M7 13V6.5a1.5 1.5 0 013 0V11M10 11V4.5a1.5 1.5 0 013 0V11M13 11V5.5a1.5 1.5 0 013 0V12M16 12V8.5a1.5 1.5 0 013 0V14c0 4-3 7-7 7s-6-2-7.5-5L3 13.5a1.6 1.6 0 012.7-1.7L7 13.5' }]],
  run: [['path', { d: 'M7 4l12 8-12 8z' }]],
  pause: [['path', { d: 'M8 4v16M16 4v16' }]],
  step: [['path', { d: 'M5 4l9 8-9 8zM18 4v16' }]],
  fast: [['path', { d: 'M3 5l8 7-8 7zM12 5l8 7-8 7z' }]],
  theme: [['circle', { cx: 12, cy: 12, r: 4 }], ['path', { d: 'M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1' }]],
  motion: [['path', { d: 'M4 12c2-4 4-4 6 0s4 4 6 0 3-3 4-2M4 6h2M4 18h2' }]],
  radiant: [
    ['circle', { cx: 12, cy: 12, r: 4.2 }],
    ['path', { d: 'M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1' }],
  ],
});

/** @param {string} name */
const icon = (name) => ['svg', { class: 'os-icon', viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' }, ...ICONS[name]];

/** A plain button bound to an action.
 * @param {any} props @param {...any} children */
const button = (props, ...children) => ['button', { type: 'button', class: 'os-btn', ...props }, ...children];

/** Render `then` only while `cond` holds. @param {any} cond @param {any} then */
const when = (cond, then) => ({ $if: [cond, then] });

/** One status pill. @param {string} label @param {any} value */
const pill = (label, value) => ['span', { class: 'os-pill' }, ['span', { class: 'os-pill-label' }, label], ' ', ['span', { class: 'os-pill-value' }, value]];

/** An app window's heading. @param {string} title @param {any} lead */
const head = (title, lead) => ['header', { class: 'os-app-head' }, ['h2', {}, title], ['p', { class: 'os-app-lead' }, lead]];

const BAR = ['header', { class: 'os-bar' },
  ['a', { class: 'os-brand', href: '#', 'aria-label': 'Radiant OS — home', on: { click: { action: 'os/app', with: 'about', preventDefault: true } } },
    ['span', { class: 'os-logo' }, icon('radiant')],
    ['span', { class: 'os-name' }, ['span', { class: 'os-title' }, 'Radiant OS'], ['span', { class: 'os-edition' }, '$.os.edition']]],
  ['div', { class: 'os-status', role: 'status' },
    pill('tick', '$.world.tick'),
    pill('harmony', '$.ui.harmony'),
    pill('session', { $concat: ['#', '$.council.session', ' ', '$.council.phase'] }),
    when({ $not: '$.os.online' }, pill('network', 'offline')),
    // who sits in the oracle's seat, when an edition seats a language model there
    when({ $exists: '$.os.oracle.label' }, pill('oracle', '$.os.oracle.label'))],
  ['div', { class: 'os-controls' },
    button({
      class: 'os-btn os-icon-btn',
      'aria-pressed': { $if: ['$.machine.running', 'true', 'false'] },
      'aria-label': { $if: ['$.machine.running', 'Pause the machine', 'Run the machine'] },
      title: { $if: ['$.machine.running', 'Pause (space)', 'Run (space)'] },
      on: { click: 'machine/toggle' },
    }, { $if: ['$.machine.running', icon('pause'), icon('run')] }),
    button({ class: 'os-btn os-icon-btn', 'aria-label': 'One step', title: 'One step', on: { click: { action: 'machine/tick', with: { steps: 1 } } } }, icon('step')),
    button({
      class: 'os-btn os-icon-btn',
      'aria-pressed': { $if: [{ $gt: ['$.machine.burst', 1] }, 'true', 'false'] },
      'aria-label': 'Fast forward', title: 'Fast forward',
      on: { click: 'machine/burst' },
    }, icon('fast')),
    button({ class: 'os-btn os-icon-btn', 'aria-label': 'Switch light and dark', title: 'Light / subway', on: { click: 'os/theme' } }, icon('theme')),
    button({
      class: 'os-btn os-icon-btn',
      'aria-pressed': { $if: ['$.os.reduce', 'true', 'false'] },
      'aria-label': 'Reduce motion', title: 'Reduce motion',
      on: { click: 'os/motion' },
    }, icon('motion'))],
];

const VERDICT = when({ $eq: ['$.council.phase', 'veto'] },
  ['section', { class: 'os-verdict', 'aria-label': 'Your verdict', 'data-member': '$.council.winner.by' },
    ['p', { class: 'os-verdict-kicker' }, { $concat: ['Session ', '$.council.session', ' passed an amendment by the ', '$.council.winner.by', ' · score ', '$.council.winner.score'] }],
    ['h2', { class: 'os-verdict-title', 'aria-live': 'assertive' }, '$.council.winner.title'],
    ['p', { class: 'os-verdict-why' }, '$.council.winner.why'],
    ['p', { class: 'os-verdict-clock' },
      { $if: [{ '$is-number': '$.ui.left' }, { $concat: ['$.ui.left', ' s to decide — then it passes'] }, 'Decide before the ring closes']}],
    ['div', { class: 'os-verdict-actions' },
      ['button', { type: 'button', class: 'os-veto', on: { click: 'council/veto' }, title: 'Veto (V)' }, icon('hand'), ['span', {}, 'Veto']],
      ['button', { type: 'button', class: 'os-pass', on: { click: 'council/approve' }, title: 'Let it pass (A)' }, 'Let it pass']]]);

const NOTICE = when({ $exists: '$.os.notice.text' },
  ['div', { class: { $concat: ['os-notice tone-', { $default: ['$.os.notice.tone', 'info'] }] }, role: 'status' },
    ['span', {}, '$.os.notice.text'],
    ['button', { type: 'button', class: 'os-notice-close', 'aria-label': 'Dismiss', on: { click: 'os/dismiss' } }, '✕']]);

const DOCK = ['nav', { class: 'os-dock', 'aria-label': 'Apps' },
  ...APPS.map((app) => ['button', {
    type: 'button',
    class: 'os-dock-btn',
    'aria-pressed': { $if: [{ $eq: ['$.os.app', app.id] }, 'true', 'false'] },
    on: { click: { action: 'os/app', with: app.id } },
  }, icon(app.id), ['span', { class: 'os-dock-label' }, app.label]])];

const WINDOW = ['section', { class: 'os-window', 'aria-label': { $concat: ['$.os.app', ' window'] } },
  ...APPS.map((app) => when({ $eq: ['$.os.app', app.id] }, { $apply: ['$', app.id] }))];

/** @type {any[]} */
const SHELL_RULES = [
  {
    match: '$',
    body: ['div', {
      class: 'os',
      'data-theme': '$.os.theme',
      'data-app': '$.os.app',
      'data-phase': '$.council.phase',
      'data-motion': { $if: ['$.os.reduce', 'reduce', 'full'] },
    },
    BAR,
    ['main', { class: 'os-desk' },
      ['jaren-widget', {
        name: 'stage',
        key: 'stage',
        class: 'os-stage',
        props: {
          scene: { $apply: ['$', 'scene'] },
          reduce: '$.os.reduce',
          label: '$.ui.label',
          tempo: '$.program.tempo',
          onPick: { action: 'stage/pick' },
        },
      }],
      VERDICT,
      NOTICE,
      WINDOW],
    DOCK],
  },
];

/** @type {any[]} */
const COUNCIL_RULES = [
  {
    mode: 'council', match: '$',
    body: ['div', { class: 'os-app os-council' },
      head('Council', '$.ui.phaseText'),
      ['ol', { class: 'os-members', 'aria-label': 'Members by merit' }, [{ $apply: '$.ui.members[*]' }]],
      when({ $exists: '$.ui.proposals[*]' },
        ['section', { class: 'os-proposals' }, ['h3', {}, 'On the table'], ['ol', {}, [{ $apply: '$.ui.proposals[*]' }]]]),
      ['div', { class: 'os-row' },
        button({ class: 'os-btn os-btn-primary', disabled: { $if: [{ $ne: ['$.council.phase', 'idle'] }, true, null] }, on: { click: 'council/convene' } }, 'Convene now'),
        ['span', { class: 'os-hint' }, { $concat: ['Next session at tick ', '$.council.next', '.'] }]],
      ['section', { class: 'os-chat' },
        ['h3', {}, 'Speak to the council'],
        ['form', { class: 'os-say', on: { submit: { action: 'council/say', preventDefault: true } } },
          ['label', { class: 'os-sr', for: 'os-say-input' }, 'Message to the council'],
          ['input', { id: 'os-say-input', class: 'os-input', type: 'text', maxlength: 280, autocomplete: 'off', placeholder: 'more symmetry, please', value: '$.council.draft', on: { input: 'council/draft' } }],
          ['button', { type: 'submit', class: 'os-btn' }, 'Say']],
        ['ul', { class: 'os-messages' }, [{ $apply: '$.council.chat[*]' }]]],
      ['section', { class: 'os-constitution' },
        ['h3', {}, 'Constitution'],
        { $if: [{ $exists: '$.ui.log[*]' }, ['ol', {}, [{ $apply: '$.ui.log[*]' }]], ['p', { class: 'os-hint' }, 'No amendments yet: the program is still the one it booted with.']] }]],
  },
  {
    mode: 'council', match: '$.ui.members[*]',
    body: ['li', {
      key: '$.id', 'data-member': '$.id',
      class: { $concat: ['os-member', { $if: ['$.lead', ' is-lead', ''] }, { $if: ['$.focused', ' is-focused', ''] }] },
    },
    ['span', { class: 'os-chip', 'aria-hidden': 'true' }],
    ['span', { class: 'os-member-name' }, '$.name', when('$.lead', ['span', { class: 'os-badge' }, 'leads'])],
    ['span', { class: 'os-member-taste' }, '$.taste'],
    ['span', { class: 'os-merit', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '5', 'aria-valuenow': '$.merit', 'aria-label': { $concat: ['Merit of ', '$.name'] } },
      ['span', { class: 'os-merit-bar', style: { width: { $concat: ['$.pct', '%'] } } }]],
    ['span', { class: 'os-merit-value' }, '$.merit'],
    ['span', { class: 'os-motto' }, '$.motto']],
  },
  {
    mode: 'council', match: '$.ui.proposals[*]',
    body: ['li', { key: '$.id', 'data-member': '$.by', class: { $if: ['$.winner', 'os-proposal is-winner', 'os-proposal'] } },
      ['span', { class: 'os-chip', 'aria-hidden': 'true' }],
      ['strong', {}, '$.who'], ' ',
      ['span', {}, '$.title'],
      when({ '$is-number': '$.score' }, ['span', { class: 'os-score' }, { $concat: ['score ', '$.score'] }]),
      ['p', { class: 'os-why' }, '$.why']],
  },
  {
    mode: 'council', match: '$.council.chat[*]',
    body: ['li', { key: '$.id', 'data-member': '$.by' }, ['span', { class: 'os-chip', 'aria-hidden': 'true' }], ['strong', {}, '$.by'], ' ', '$.text'],
  },
  {
    mode: 'council', match: '$.ui.log[*]',
    body: ['li', { key: '$.id', 'data-member': '$.by', class: { $concat: ['os-amendment is-', '$.status'] } },
      ['span', { class: 'os-status-badge' }, '$.status'], ' ',
      ['span', { class: 'os-amendment-title' }, '$.title'],
      ['span', { class: 'os-hint' }, { $concat: ['session ', '$.session', ' · ', '$.who', ' ', '$.rewardText'] }],
      when('$.repealable', button({ class: 'os-btn os-btn-small', on: { click: { action: 'council/repeal', with: '$.id' } } }, 'Repeal'))],
  },
];

/** @type {any[]} */
const MACHINE_RULES = [
  {
    mode: 'machine', match: '$',
    body: ['div', { class: 'os-app os-machine' },
      head('Machine', 'A Turing machine with its tape folded into a floor. The program below is a jaren-fsm document: each cell is one transition — what a head in that state paints, how it turns and which state it becomes on reading that colour.'),
      ['div', { class: 'os-row' },
        button({ class: 'os-btn os-btn-primary', on: { click: 'machine/toggle' } }, { $if: ['$.machine.running', 'Pause', 'Run'] }),
        button({ on: { click: { action: 'machine/tick', with: { steps: 1 } } } }, 'Step'),
        ['span', { class: 'os-hint' }, { $concat: ['tick ', '$.world.tick', ' · ', '$.program.tempo', ' steps a second · ×', '$.machine.burst'] }]],
      ['ul', { class: 'os-tastes', 'aria-label': 'The council’s tastes, measured on the floor' }, [{ $apply: '$.ui.tastes[*]' }]],
      when({ $ne: ['$.ui.spark', ''] },
        ['svg', { class: 'os-spark', viewBox: '0 0 100 30', preserveAspectRatio: 'none', role: 'img', 'aria-label': 'Harmony over the last minute' },
          ['polyline', { points: '$.ui.spark' }]]),
      ['div', { class: 'os-table-scroll' },
        ['table', { class: 'os-rules' },
          ['caption', {}, 'Rules — click a part of a rule to draft a change'],
          ['thead', {}, ['tr', {}, ['th', { scope: 'col' }, 'state'],
            [{ $for: { s: '$.ui.symbols[*]' }, $return: ['th', { scope: 'col', key: '$s.index' },
              ['span', { class: 'os-swatch', style: { '--swatch': '$s.color' }, 'aria-hidden': 'true' }],
              ['span', { class: 'os-sr' }, { $concat: ['reads ', '$s.name'] }]] }]]],
          ['tbody', {}, [{ $apply: '$.ui.rules[*]' }]]]],
      when({ $exists: '$.machine.draft.kind' },
        ['section', { class: 'os-draft', 'aria-label': 'Your draft amendment' },
          ['h3', {}, 'Your proposal'],
          ['p', {}, { $if: [{ $ne: ['$.ui.draftTitle', ''] }, '$.ui.draftTitle', 'Forecasting…'] }],
          ['ul', { class: 'os-forecast' }, [{ $apply: '$.ui.forecast[*]' }]],
          ['div', { class: 'os-row' },
            button({ class: 'os-btn os-btn-primary', on: { click: 'machine/propose' } }, 'Propose to the council'),
            button({ on: { click: 'machine/discard' } }, 'Discard')]])],
  },
  {
    mode: 'machine', match: '$.ui.tastes[*]',
    body: ['li', { key: '$.key', 'data-member': '$.who', class: 'os-taste' },
      ['span', { class: 'os-taste-label' }, '$.label'],
      ['span', { class: 'os-merit', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '1', 'aria-valuenow': '$.value', 'aria-label': '$.label' },
        ['span', { class: 'os-merit-bar', style: { width: { $concat: ['$.pct', '%'] } } }]],
      ['span', { class: 'os-merit-value' }, '$.value']],
  },
  {
    mode: 'machine', match: '$.ui.rules[*]',
    body: ['tr', { key: '$.state' }, ['th', { scope: 'row' }, '$.state'], [{ $apply: '$.cells[*]' }]],
  },
  {
    mode: 'machine', match: '$.ui.rules[*].cells[*]',
    body: ['td', { key: '$.key' },
      ['div', { class: 'os-cell' },
        ['button', {
          type: 'button', class: 'os-cell-write', style: { '--swatch': '$.writeColor' },
          title: { $concat: ['Reading ', '$.reads', ' it paints ', '$.writes', '. Draft the next colour.'] },
          on: { click: { action: 'machine/draft', with: '$.cycleWrite' } },
        }, ['span', { class: 'os-sr' }, { $concat: ['paints ', '$.writes'] }]],
        ['button', {
          type: 'button', class: 'os-cell-turn',
          title: { $concat: ['Then it will ', '$.turnName', '. Draft another turn.'] },
          on: { click: { action: 'machine/draft', with: '$.cycleTurn' } },
        }, '$.turnGlyph'],
        ['button', {
          type: 'button', class: 'os-cell-next',
          title: { $concat: ['And become ', '$.next', '. Draft another state.'] },
          on: { click: { action: 'machine/draft', with: '$.cycleNext' } },
        }, '$.next']]],
  },
  {
    mode: 'machine', match: '$.ui.forecast[*]',
    body: ['li', { key: '$.key', class: { $if: ['$.up', 'is-up', 'is-down'] } },
      ['span', {}, '$.label'], ' ', ['span', {}, '$.before'], ' → ', ['strong', {}, '$.after']],
  },
];

/** @type {any[]} */
const SOURCE_RULES = [
  {
    mode: 'source', match: '$',
    body: ['div', { class: 'os-app os-source' },
      head('Source', 'Every document this OS runs, as itself. The sculptor stylesheet turns the one you pick into a crowd of figures; what is executing right now dances.'),
      ['div', { class: 'os-docs', role: 'group', 'aria-label': 'Documents' }, [{ $apply: '$.ui.documents[*]' }]],
      ['jaren-widget', { name: 'sculpture', key: 'sculpture', class: 'os-sculpture', props: '$.ui.sculpture' }],
      { $apply: '$.ui.source' }],
  },
  {
    mode: 'source', match: '$.ui.documents[*]',
    body: ['button', {
      type: 'button', key: '$.id', class: 'os-btn os-btn-small',
      'aria-pressed': { $if: ['$.active', 'true', 'false'] },
      on: { click: { action: 'source/doc', with: '$.id' } },
    }, '$.label'],
  },
  {
    mode: 'source', match: '$.ui.source',
    body: ['section', { class: 'os-source-doc' },
      ['h3', {}, '$.label', ' ', ['span', { class: 'os-format' }, '$.format']],
      ['p', {}, '$.about'],
      ['p', { class: 'os-hint' }, { $concat: ['$.size', ' characters · ', '$.tokens', ' tokens', { $if: ['$.truncated', ' (the first part shown)', ''] }] }],
      ['pre', { class: 'os-code', tabindex: '0' }, ['code', {}, [{ $for: { r: '$.runs[*]' }, $return: ['span', { class: '$r.kind' }, '$r.value'] }]]]],
  },
];

/** @type {any[]} */
const EXPORTS_RULES = [
  {
    mode: 'exports', match: '$',
    body: ['div', { class: 'os-app os-exports' },
      head('Exports', 'The artwork as text. JTLT templates render the theme the chrome is wearing as CSS, the frame as a standalone HTML page and the program as a JavaScript module that replays this machine step for step; the same text is then read back into tokens.'),
      ['div', { class: 'os-tabs', role: 'tablist', 'aria-label': 'Format' },
        ...['css', 'html', 'js', 'svg'].map((format) => ['button', {
          type: 'button', role: 'tab', class: 'os-tab',
          'aria-selected': { $if: [{ $eq: ['$.exports.format', format] }, 'true', 'false'] },
          on: { click: { action: 'exports/format', with: format } },
        }, format.toUpperCase()])],
      ['div', { class: 'os-row' },
        button({ class: 'os-btn os-btn-primary', disabled: { $if: [{ $ne: ['$.exports.status', 'done'] }, true, null] }, on: { click: 'exports/download' } }, 'Download'),
        ['span', { class: 'os-hint' }, { $if: [{ $eq: ['$.exports.status', 'loading'] }, 'Rendering…', '$.exports.name'] }]],
      { $apply: '$.ui.exports' }],
  },
  {
    mode: 'exports', match: '$.ui.exports',
    body: ['div', { class: 'os-export' },
      ['ul', { class: 'os-legend', 'aria-label': 'Tokens by kind' },
        [{ $for: { s: '$.stats[*]' }, $return: ['li', { key: '$s.label', class: '$s.kind' }, ['span', { class: 'os-legend-bar', style: { width: { $concat: ['$s.pct', '%'] } } }], { $concat: ['$s.label', ' ', '$s.count'] }] }]],
      ['pre', { class: 'os-code', tabindex: '0' }, ['code', {}, [{ $for: { r: '$.runs[*]' }, $return: ['span', { class: '$r.kind' }, '$r.value'] }]]]],
  },
];

/** @type {any[]} */
const GALLERY_RULES = [
  {
    mode: 'gallery', match: '$',
    body: ['div', { class: 'os-app os-gallery' },
      head('Gallery', 'Keep the floor as it is now — tape, program and the merits of the council that made it — in the OS’s own SQLite database, and put any kept artwork back on the floor later.'),
      ['form', { class: 'os-row', on: { submit: { action: 'gallery/save', preventDefault: true } } },
        ['label', { class: 'os-sr', for: 'os-title-input' }, 'Title'],
        ['input', { id: 'os-title-input', class: 'os-input', type: 'text', maxlength: 60, autocomplete: 'off', placeholder: 'Untitled dance', value: '$.gallery.title', on: { input: 'gallery/title' } }],
        ['button', { type: 'submit', class: 'os-btn os-btn-primary', disabled: { $if: [{ $eq: ['$.gallery.status', 'saving'] }, true, null] } }, 'Keep']],
      ['p', { class: 'os-hint' }, { $concat: ['Storage: ', '$.os.storage.mode', '. ', '$.os.storage.detail'] }],
      { $if: [{ $exists: '$.gallery.items[*]' }, ['ol', { class: 'os-gallery-list' }, [{ $apply: '$.gallery.items[*]' }]], ['p', { class: 'os-hint' }, 'Nothing kept yet.']] }],
  },
  {
    mode: 'gallery', match: '$.gallery.items[*]',
    body: ['li', { key: '$.id', class: 'os-artwork' },
      ['span', { class: 'os-artwork-title' }, '$.title'],
      ['span', { class: 'os-hint' }, { $concat: ['tick ', '$.tick', ' · harmony ', '$.harmony'] }],
      button({ class: 'os-btn os-btn-small', on: { click: { action: 'gallery/open', with: '$.id' } } }, 'Put back')],
  },
];

/** @type {any[]} */
const ABOUT_RULES = [
  {
    mode: 'about', match: '$',
    body: ['div', { class: 'os-app os-about' },
      head('About', '$.os.about.lead'),
      [{ $for: { p: '$.os.about.sections[*]' }, $return: ['section', { key: '$p.title' }, ['h3', {}, '$p.title'], ['p', {}, '$p.text']] }],
      ['h3', {}, 'Keys'],
      ['ul', { class: 'os-keys' },
        ['li', {}, ['kbd', {}, 'V'], ' veto the awaiting amendment'],
        ['li', {}, ['kbd', {}, 'A'], ' let it pass'],
        ['li', {}, ['kbd', {}, 'Space'], ' run or pause the machine'],
        ['li', {}, ['kbd', {}, '← → ↑ ↓'], ' turn the stage when it has focus; ', ['kbd', {}, '0'], ' resets it']],
      ['ul', { class: 'os-links' },
        [{ $for: { l: '$.os.about.links[*]' }, $return: ['li', { key: '$l.href' }, ['a', { href: '$l.href', rel: 'noopener' }, '$l.label']] }]]],
  },
];

/** The whole stylesheet. */
export const VIEW = Object.freeze({
  $jslt: '0.1',
  // every value the view dispatches has a rule; one that does not is a
  // view bug to report, not a subtree to copy through silently
  unmatched: 'error',
  rules: [
    ...SHELL_RULES,
    ...SCENE_RULES,
    ...COUNCIL_RULES,
    ...MACHINE_RULES,
    ...SOURCE_RULES,
    ...EXPORTS_RULES,
    ...GALLERY_RULES,
    ...ABOUT_RULES,
  ],
});
