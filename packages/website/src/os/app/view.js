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
import { icon, button, when, pill, head } from './vnodes.js';
import { STUDIO_APPS, STUDIO_RULES, STUDIO_OVERLAYS, spotClass } from './studio-view.js';

/** The dock: every app, in order. */
export const APPS = Object.freeze([
  ...STUDIO_APPS.filter((a) => a.group === 'studio'),
  { id: 'council', label: 'Council', group: 'machine' },
  { id: 'machine', label: 'Machine', group: 'machine' },
  { id: 'source', label: 'Source', group: 'machine' },
  { id: 'exports', label: 'Exports', group: 'machine' },
  { id: 'gallery', label: 'Gallery', group: 'machine' },
  ...STUDIO_APPS.filter((a) => a.group === 'system'),
  { id: 'about', label: 'About', group: 'system' },
]);

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
  ['section', { class: spotClass('os-verdict', 'verdict'), 'data-coach': 'verdict', 'aria-label': 'Your verdict', 'data-member': '$.council.winner.by' },
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
  ...APPS.flatMap((app, i) => [
    ...(i > 0 && APPS[i - 1].group !== app.group ? [['span', { class: 'os-dock-gap', 'aria-hidden': 'true' }]] : []),
    ['button', {
      type: 'button',
      class: spotClass('os-dock-btn', `dock-${app.id}`),
      'data-coach': `dock-${app.id}`,
      'data-group': app.group,
      'aria-pressed': { $if: [{ $eq: ['$.os.app', app.id] }, 'true', 'false'] },
      on: { click: { action: 'os/app', with: app.id } },
    }, icon(app.id), ['span', { class: 'os-dock-label' }, app.label],
    ...(app.id === 'mail' ? [when({ $gt: ['$.ui.studio.mail.unread', 0] }, ['span', { class: 'os-count', 'aria-label': 'unread' }, '$.ui.studio.mail.unread'])] : [])]])];

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
          light: '$.settings.light',
          orbit: '$.settings.camera.orbit',
          ragdoll: '$.settings.motion.ragdoll',
          shot: { name: '$.studio.shot', seq: '$.studio.shotSeq' },
          burst: { fx: '$.studio.burst', seq: '$.studio.burstSeq' },
          cheer: { who: '$.studio.cheer', seq: '$.studio.cheerSeq' },
        },
      }],
      VERDICT,
      NOTICE,
      WINDOW],
    DOCK,
    ...STUDIO_OVERLAYS],
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
        button({ class: spotClass('os-btn os-btn-primary', 'council-convene'), 'data-coach': 'council-convene', disabled: { $if: [{ $ne: ['$.council.phase', 'idle'] }, true, null] }, on: { click: 'council/convene' } }, 'Convene now'),
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
        ['table', { class: spotClass('os-rules', 'machine-rules'), 'data-coach': 'machine-rules' },
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
            button({ class: spotClass('os-btn os-btn-primary', 'machine-propose'), 'data-coach': 'machine-propose', on: { click: 'machine/propose' } }, 'Propose to the council'),
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
    ...STUDIO_RULES,
  ],
});
