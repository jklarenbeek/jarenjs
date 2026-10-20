//@ts-check
/**
 * The studio's view rules, one JSLT mode per app (Crew, Board, Mail,
 * Library, Arcade, Settings), and the layers the shell draws over the
 * desk: the arcade's full-screen game with its HUD and menus, the pause
 * menu, the coach, the toast. Plain JSON like the rest of the view; the
 * builders only spell out what repeats.
 *
 * Anything the coach can point at carries a `data-coach` name, and wears
 * `is-spotlit` while the coach is pointing at it.
 */

import { icon, button, when } from './vnodes.js';
import { PALETTE } from './state.js';

/** The studio's apps in the dock, before the machine's own. */
export const STUDIO_APPS = Object.freeze([
  { id: 'crew', label: 'Crew', group: 'studio' },
  { id: 'board', label: 'Board', group: 'studio' },
  { id: 'mail', label: 'Mail', group: 'studio' },
  { id: 'library', label: 'Library', group: 'studio' },
  { id: 'arcade', label: 'Arcade', group: 'studio' },
  { id: 'settings', label: 'Settings', group: 'system' },
]);

/** The class a coach target wears, spotlit or not. @param {string} base @param {string} id */
export const spotClass = (base, id) => ({ $concat: [base, { $if: [{ $eq: ['$.studio.spotlight', id] }, ' is-spotlit', ''] }] });

/** Props of an element the coach can point at. @param {string} base @param {string} id */
const spot = (base, id) => ({ class: spotClass(base, id), 'data-coach': id });

/** A labelled range input bound to an action. @param {string} label @param {any} value @param {string} action @param {number} min @param {number} max @param {number} step @param {string} [id] */
const range = (label, value, action, min, max, step, id) => ['label', { class: 'os-field', ...(id ? { 'data-coach': id } : {}) },
  ['span', {}, label],
  ['input', { type: 'range', min, max, step, value, on: { input: action } }]];

/** A switch bound to an action. @param {string} label @param {any} on @param {string} action */
const toggle = (label, on, action) => ['button', {
  type: 'button', class: 'os-switch', role: 'switch', 'aria-checked': { $if: [on, 'true', 'false'] }, on: { click: action },
}, ['span', { class: 'os-switch-knob', 'aria-hidden': 'true' }], label];

/** Stars out of three. @param {any} n */
const stars = (n) => ['span', { class: 'os-stars', 'aria-label': { $concat: [{ $default: [n, 0] }, ' of 3 stars'] } },
  { $substring: ['★★★', 0, { $default: [n, 0] }] }, ['span', { class: 'os-stars-off' }, { $substring: ['★★★', 0, { $sub: [3, { $default: [n, 0] }] }] }]];

/** @type {any[]} */
const CREW_RULES = [{
  mode: 'crew', match: '$',
  body: ['div', { class: 'os-app os-crew' },
    ['header', { class: 'os-app-head' }, ['h2', {}, 'Crew'],
      ['p', { class: 'os-app-lead' }, 'Finish a project together. You are the employers: take turns adding ideas in plain words. The crew — the council’s four members — builds each one as a block of a real app; you approve it or veto it. Ship it in as few rounds as you can.']],
    { $if: [{ '$is-null': '$.ui.studio.crew' }, ['form', { class: 'os-crew-setup', on: { submit: { action: 'crew/start', preventDefault: true } } },
      ['label', { class: 'os-field' }, ['span', {}, 'Project'], ['input', { class: 'os-input', type: 'text', maxlength: 60, placeholder: 'A habit tracker', value: '$.crew.setup.title', on: { input: 'crew/title' } }]],
      ['label', { class: 'os-field' }, ['span', {}, 'Employers (comma separated, up to four)'], ['input', { class: 'os-input', type: 'text', maxlength: 100, value: '$.crew.setup.players', on: { input: 'crew/players' } }]],
      ['label', { class: 'os-field' }, ['span', {}, { $concat: ['Approved blocks to ship: ', '$.crew.setup.goal'] }], ['input', { type: 'range', min: 2, max: 12, step: 1, value: '$.crew.setup.goal', on: { input: 'crew/goal' } }]],
      ['button', { type: 'submit', class: 'os-btn os-btn-primary', 'data-coach': 'crew-start' }, icon('play'), ' Start the project']],
    ['div', { class: 'os-crew-project', 'data-phase': '$.ui.studio.crew.phase' },
      ['div', { class: 'os-crew-head' },
        ['h3', {}, '$.ui.studio.crew.title', ' ', ['span', { class: 'os-badge' }, { $concat: ['round ', '$.ui.studio.crew.round'] }]],
        ['p', { class: 'os-crew-phase', 'aria-live': 'polite' }, '$.ui.studio.crew.phaseText'],
        ['div', { class: 'os-meter', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '$.ui.studio.crew.progress.goal', 'aria-valuenow': '$.ui.studio.crew.progress.approved', 'aria-label': 'Approved blocks' },
          ['span', { class: 'os-meter-bar', style: { width: { $concat: ['$.ui.studio.crew.progress.pct', '%'] } } }]],
        ['p', { class: 'os-hint' }, { $concat: ['$.ui.studio.crew.progress.approved', ' of ', '$.ui.studio.crew.progress.goal', ' blocks approved'] }]],
      ['ul', { class: 'os-crew-players' }, [{ $for: { p: '$.ui.studio.crew.players[*]' }, $return: ['li', { key: '$p.id', class: { $if: ['$p.active', 'is-active', ''] }, style: { '--player': '$p.color' } }, ['span', { class: 'os-chip', 'aria-hidden': 'true' }], '$p.name', ' · ', ['strong', {}, '$p.score']] }]],
      when({ $eq: ['$.ui.studio.crew.phase', 'employer'] }, ['div', { class: 'os-crew-turn' },
        when('$.ui.studio.crew.canAdd', ['form', { class: 'os-row', on: { submit: { action: 'crew/idea', preventDefault: true } } },
          ['label', { class: 'os-sr', for: 'os-crew-idea' }, 'Your idea'],
          ['input', { id: 'os-crew-idea', ...spot('os-input', 'crew-idea'), type: 'text', maxlength: 200, autocomplete: 'off', placeholder: 'a counter for glasses of water', value: '$.crew.draft', on: { input: 'crew/draft' } }],
          ['button', { type: 'submit', class: 'os-btn' }, 'Add idea']]),
        button({ class: 'os-btn os-btn-primary', on: { click: 'crew/end' } }, 'End my turn')]),
      when({ $eq: ['$.ui.studio.crew.phase', 'crew'] }, ['p', { class: 'os-crew-busy' }, ['span', { class: 'os-spinner', 'aria-hidden': 'true' }], ' The crew is building — watch Mail for what they say.']),
      when({ $eq: ['$.ui.studio.crew.phase', 'review'] }, ['section', { ...spot('os-crew-review', 'crew-review'), 'aria-label': 'Review' },
        ['h4', {}, 'Built this round'],
        ['ul', {}, [{ $for: { t: '$.ui.studio.crew.review[*]' }, $return: ['li', { key: '$t.id' },
          ['p', {}, ['strong', {}, '$t.who'], ' built ', '$t.what', ['span', { class: 'os-hint' }, { $concat: [' — for “', '$t.idea', '”'] }]],
          ['div', { class: 'os-row' },
            ['button', { type: 'button', class: 'os-pass', on: { click: { action: 'crew/review', with: { task: '$t.id', verdict: 'approve' } } } }, 'Approve'],
            ['button', { type: 'button', class: 'os-veto', on: { click: { action: 'crew/review', with: { task: '$t.id', verdict: 'veto' } } } }, icon('hand'), ['span', {}, 'Veto']]]] }]]]),
      when({ $eq: ['$.ui.studio.crew.phase', 'shipped'] }, ['section', { class: 'os-crew-shipped' },
        ['h4', {}, 'Shipped! ', stars('$.ui.studio.crew.stars')],
        button({ class: 'os-btn os-btn-primary', on: { click: 'crew/new' } }, 'Start another project')]),
      ['div', { class: 'os-crew-preview' }, ['h4', {}, 'The app'],
        ['jaren-widget', { name: 'mini', key: { $concat: ['mini-', '$.ui.studio.crew.id'] }, class: 'os-mini', props: { app: '$.ui.studio.crew.app', label: '$.ui.studio.crew.title' } }]],
      ['details', { class: 'os-crew-ideas' }, ['summary', {}, 'Ideas and builds'],
        ['ul', {}, [{ $for: { i: '$.ui.studio.crew.ideas[*]' }, $return: ['li', { key: '$i.id', class: { $concat: ['is-', '$i.status'] } }, ['span', { class: 'os-status-badge' }, '$i.status'], ' ', '$i.text', ['span', { class: 'os-hint' }, { $concat: [' — ', '$i.who'] }]] }]],
        ['ul', {}, [{ $for: { b: '$.ui.studio.crew.built[*]' }, $return: ['li', { key: '$b.id', class: { $concat: ['is-', '$b.status'] } }, '$b.who', ': ', '$b.what', ' — ', '$b.status'] }]]],
      ['ul', { class: 'os-crew-members' }, [{ $for: { c: '$.ui.studio.crew.crew[*]' }, $return: ['li', { key: '$c.id', 'data-member': '$c.id' }, ['span', { class: 'os-chip', 'aria-hidden': 'true' }], '$c.name', ' ', ['strong', {}, '$c.points']] }]]]] },
    when({ $gt: [{ $count: '$.ui.studio.made[*]' }, 0] }, ['section', { ...spot('os-crew-made', 'crew-made'), 'aria-label': 'Made' },
      ['h3', {}, 'Made'],
      ['ul', { class: 'os-made' }, [{ $for: { m: '$.ui.studio.made[*]' }, $return: ['li', { key: '$m.id' },
        button({ class: 'os-btn os-btn-small', on: { click: { action: 'crew/made-open', with: '$m.id' } } }, '$m.title'), ' ', stars('$m.stars'), ['span', { class: 'os-hint' }, { $concat: [' ', '$m.count', ' blocks'] }]] }]],
      when({ $not: { '$is-null': '$.ui.studio.preview' } }, ['div', { class: 'os-made-preview' },
        ['div', { class: 'os-row' }, ['h4', {}, '$.ui.studio.preview.title'], button({ class: 'os-btn os-btn-small', on: { click: 'crew/made-close' } }, 'Close')],
        ['jaren-widget', { name: 'mini', key: { $concat: ['made-', '$.ui.studio.preview.id'] }, class: 'os-mini', props: { app: '$.ui.studio.preview.app', label: '$.ui.studio.preview.title' } }]])])],
}];

/** @type {any[]} */
const BOARD_RULES = [{
  mode: 'board', match: '$',
  body: ['div', { class: 'os-app os-board' },
    ['header', { class: 'os-app-head' }, ['h2', {}, 'Board'],
      ['p', { class: 'os-app-lead' }, 'Notes and todos on one wall. Drag a card to move it, drag from its dot to connect it; a line between two todos means the first must be done first. Pin a mail thread or a page of the docs here from their apps.']],
    ['form', { class: 'os-row', on: { submit: { action: 'board/add', preventDefault: true } } },
      ['div', { class: 'os-seg', role: 'radiogroup', 'aria-label': 'Card kind' },
        ['button', { type: 'button', role: 'radio', 'aria-checked': { $if: [{ $eq: ['$.board.kind', 'note'] }, 'true', 'false'] }, on: { click: { action: 'board/kind', with: 'note' } } }, 'Note'],
        ['button', { type: 'button', role: 'radio', 'aria-checked': { $if: [{ $eq: ['$.board.kind', 'todo'] }, 'true', 'false'] }, on: { click: { action: 'board/kind', with: 'todo' } } }, 'Todo']],
      ['label', { class: 'os-sr', for: 'os-board-input' }, 'Card text'],
      ['input', { id: 'os-board-input', class: 'os-input', type: 'text', maxlength: 280, autocomplete: 'off', placeholder: 'write it down', value: '$.board.draft', on: { input: 'board/draft' } }],
      ['button', { type: 'submit', class: 'os-btn os-btn-primary' }, icon('pin'), ' Pin it']],
    ['jaren-widget', {
      name: 'board', key: 'board', class: spotClass('os-wallhost', 'board-link'), 'data-coach': 'board-link',
      props: { cards: '$.ui.studio.board.cards', links: '$.ui.studio.board.links', width: '$.ui.studio.board.width', height: '$.ui.studio.board.height', selected: '$.board.selected', theme: '$.os.theme', label: { $concat: ['Board: ', { $count: '$.board.cards[*]' }, ' cards'] } },
    }],
    when('$.board.linking', ['p', { class: 'os-hint', role: 'status' }, 'Now pick the card to connect to.', ' ', button({ class: 'os-btn os-btn-small', on: { click: { action: 'board/link-to', with: { id: '$.board.linking', todo: false } } } }, 'Cancel')]),
    ['ul', { ...spot('os-cards', 'board-cards'), 'aria-label': 'Cards' }, [{ $for: { c: '$.ui.studio.board.cards[*]' }, $return: ['li', {
      key: '$c.id', class: { $concat: ['os-card', { $if: ['$c.done', ' is-done', ''] }, { $if: ['$c.blocked', ' is-blocked', ''] }, { $if: [{ $eq: ['$c.id', '$.board.selected'] }, ' is-selected', ''] }] }, style: { '--card': '$c.fill' },
    },
    when('$c.todo', ['button', { type: 'button', class: 'os-tick', role: 'checkbox', 'aria-checked': { $if: ['$c.done', 'true', 'false'] }, 'aria-label': { $concat: ['Done: ', '$c.text'] }, on: { click: { action: 'board/tick', with: { id: '$c.id', done: '$c.done' } } } }]),
    ['button', { type: 'button', class: 'os-card-text', on: { click: { action: 'board/select', with: '$c.id' } } }, '$c.text'],
    when('$c.blocked', ['span', { class: 'os-badge' }, 'waits']),
    button({ class: 'os-btn os-btn-small', title: 'Connect to another card', on: { click: { action: { $if: ['$.board.linking', 'board/link-to', 'board/link-start'] }, with: { $if: ['$.board.linking', { id: '$c.id', todo: '$c.todo' }, '$c.id'] } } } }, 'Link'),
    button({ class: 'os-btn os-btn-small', 'aria-label': { $concat: ['Remove ', '$c.text'] }, on: { click: { action: 'board/remove', with: '$c.id' } } }, '✕')] }]],
    when({ $not: { '$is-null': '$.board.selected' } }, ['div', { class: 'os-card-edit' },
      ['label', { class: 'os-field' }, ['span', {}, 'Edit the selected card'],
        ['input', { id: 'os-board-edit', class: 'os-input', type: 'text', maxlength: 280, value: { $head: { $for: { c: '$.board.cards[*]' }, $where: { $eq: ['$c.id', '$.board.selected'] }, $return: '$c.text' } }, on: { change: 'board/text' } }]],
      ['div', { class: 'os-row', role: 'group', 'aria-label': 'Colour' }, ...PALETTE.slice(1).map((ink, i) => ['button', {
        type: 'button', class: 'os-swatch', style: { background: ink }, 'aria-label': `Colour ${i + 1}`,
        on: { click: { action: 'board/color', with: { id: '$.board.selected', color: i + 1 } } },
      }])]])],
}];

/** @type {any[]} */
const MAIL_RULES = [{
  mode: 'mail', match: '$',
  body: ['div', { class: 'os-app os-mail' },
    ['header', { class: 'os-app-head' }, ['h2', {}, 'Mail'],
      ['p', { class: 'os-app-lead' }, 'Every conversation between you and the models, as threads: the council’s sessions, the crew’s work on each idea, questions to the docs, the coach. A tool call shows how many chunks it took.']],
    ['div', { class: 'os-mail-panes' },
      ['nav', { class: 'os-mail-folders', 'aria-label': 'Folders' }, [{ $for: { f: '$.ui.studio.mail.folders[*]' }, $return: ['button', {
        type: 'button', key: '$f.id', class: 'os-folder', 'aria-pressed': { $if: ['$f.active', 'true', 'false'] }, on: { click: { action: 'mail/folder', with: '$f.id' } },
      }, '$f.id', when({ $gt: ['$f.unread', 0] }, ['span', { class: 'os-count' }, '$f.unread'])] }]],
      ['ul', { ...spot('os-mail-threads', 'mail-threads'), 'aria-label': 'Threads' },
        { $if: [{ $gt: [{ $count: '$.ui.studio.mail.threads[*]' }, 0] }, [{ $for: { t: '$.ui.studio.mail.threads[*]' }, $return: ['li', { key: '$t.id' },
          ['button', { type: 'button', class: { $concat: ['os-thread', { $if: ['$t.active', ' is-open', ''] }, { $if: [{ $gt: ['$t.unread', 0] }, ' is-unread', ''] }] }, on: { click: { action: 'mail/open', with: '$t.id' } } },
            ['strong', {}, '$t.subject'], ['span', { class: 'os-hint' }, '$t.who'], ['span', { class: 'os-thread-last' }, '$t.last']]] }],
        ['li', { class: 'os-hint' }, 'No mail here yet.']] }],
      ['section', { class: 'os-mail-read', 'aria-label': 'Open thread' },
        { $if: [{ '$is-null': '$.ui.studio.mail.open' }, ['p', { class: 'os-hint' }, 'Pick a thread, or write to the oracle below.'],
          ['div', {},
            ['div', { class: 'os-row' }, ['h3', {}, '$.ui.studio.mail.open.subject'],
              button({ class: 'os-btn os-btn-small', on: { click: { action: 'board/pin', with: { kind: 'mail', id: '$.ui.studio.mail.open.id', label: '$.ui.studio.mail.open.subject' } } } }, icon('pin'), ' Pin'),
              button({ class: 'os-btn os-btn-small', on: { click: 'mail/close' } }, 'Close')],
            ['ol', { class: 'os-messages' }, [{ $for: { m: '$.ui.studio.mail.open.messages[*]' }, $return: ['li', { key: '$m.id', class: { $if: ['$m.mine', 'os-message is-mine', 'os-message'] }, 'data-member': '$m.from' },
              ['span', { class: 'os-chip', 'aria-hidden': 'true' }], ['strong', {}, '$m.who'], ['p', {}, '$m.text'],
              when({ $gt: [{ '$string-length': '$m.toolText' }, 0] }, ['span', { class: 'os-tool' }, '⚙ ', '$m.toolText'])] }]]]] }],
      ['form', { ...spot('os-mail-compose', 'mail-compose'), on: { submit: { action: 'mail/send', preventDefault: true } } },
        when({ '$is-null': '$.mail.open' }, ['input', { class: 'os-input', type: 'text', maxlength: 80, placeholder: 'Subject', value: '$.mail.subject', on: { input: 'mail/subject' }, 'aria-label': 'Subject' }]),
        ['textarea', { class: 'os-input', rows: 3, maxlength: 2000, placeholder: 'Write to the oracle — ask anything about the OS or its documentation', value: '$.mail.draft', on: { input: 'mail/draft' }, 'aria-label': 'Message' }],
        ['button', { type: 'submit', class: 'os-btn os-btn-primary' }, icon('mail'), { $if: [{ '$is-null': '$.mail.open' }, ' Send', ' Reply'] }]]]],
}];

/** @type {any[]} */
const LIBRARY_RULES = [{
  mode: 'library', match: '$',
  body: ['div', { class: 'os-app os-library' },
    ['header', { class: 'os-app-head' }, ['h2', {}, 'Library'],
      ['p', { class: 'os-app-lead' }, 'The documentation, three ways: read it, listen to it — one highlighted sentence at a time — or ask it a question and get the passages that answer, with where they came from.']],
    ['form', { ...spot('os-row os-ask', 'library-ask'), on: { submit: { action: 'library/ask', preventDefault: true } } },
      ['label', { class: 'os-sr', for: 'os-library-ask' }, 'Ask the docs'],
      ['input', { id: 'os-library-ask', class: 'os-input', type: 'search', maxlength: 160, placeholder: 'how do I validate a contract?', value: '$.library.query', on: { input: 'library/query' } }],
      ['button', { type: 'submit', class: 'os-btn os-btn-primary' }, 'Ask']],
    when({ $not: { '$is-null': '$.library.answer' } }, ['section', { class: 'os-answer', 'aria-live': 'polite' },
      ['p', { class: 'os-answer-text' }, '$.library.answer.text'],
      ['ul', { class: 'os-citations' }, [{ $for: { c: '$.library.answer.citations[*]' }, $return: ['li', {}, button({ class: 'os-btn os-btn-small', on: { click: { action: 'library/open', with: '$c.doc' } } }, '$c.label')] }]]]),
    { $if: [{ '$is-null': '$.ui.studio.library.page' },
      { $if: [{ $eq: ['$.library.status', 'ready'] },
        ['ul', { class: 'os-docs', 'data-coach': 'dock-library' }, [{ $for: { d: '$.library.docs[*]' }, $return: ['li', { key: '$d.id' },
          button({ class: 'os-doc', on: { click: { action: 'library/open', with: '$d.id' } } }, ['strong', {}, '$d.title'], ['span', { class: 'os-hint' }, { $concat: ['$d.sections', ' sections'] }])] }]],
        ['p', { class: 'os-hint' }, { $if: [{ $eq: ['$.library.status', 'unavailable'] }, 'The library is not available offline yet — open it once online.', 'Opening the library…'] }]] },
      ['article', { class: 'os-page', 'data-speaking': { $if: ['$.library.speaking', 'true', 'false'] } },
        ['div', { class: 'os-row' },
          button({ class: 'os-btn os-btn-small', on: { click: 'library/back' } }, '← All documents'),
          ['button', { type: 'button', ...spot('os-btn os-btn-primary', 'library-listen'), 'aria-pressed': { $if: ['$.library.speaking', 'true', 'false'] }, on: { click: 'library/listen' } }, icon('speaker'), { $if: ['$.library.speaking', ' Stop', ' Listen'] }],
          button({ class: 'os-btn os-btn-small', on: { click: { action: 'board/pin', with: { kind: 'doc', id: '$.ui.studio.library.page.doc', label: '$.ui.studio.library.page.title' } } } }, icon('pin'), ' Pin')],
        ['h3', { class: 'os-page-title' }, '$.ui.studio.library.page.title'],
        [{ $for: { s: '$.ui.studio.library.page.sections[*]' }, $return: ['section', { key: '$s.index', class: { $if: ['$s.code', 'os-page-code', 'os-page-section'] } },
          ['h4', { class: { $if: ['$s.headingSpoken', 'is-spoken', ''] } }, '$s.heading'],
          { $if: ['$s.code', ['pre', {}, ['code', {}, '$s.text']],
            ['p', {}, [{ $for: { p: '$s.parts[*]' }, $return: ['span', { class: { $if: ['$p.spoken', 'os-sentence is-spoken', 'os-sentence'] } }, '$p.text', ' '] }]]] }] }],
        when({ '$is-number': '$.ui.studio.library.page.next' }, button({ class: 'os-btn', on: { click: 'library/more' } }, 'Keep reading →'))]] }],
}];

/** @type {any[]} */
const ARCADE_RULES = [{
  mode: 'arcade', match: '$',
  body: ['div', { class: 'os-app os-arcade-shelf' },
    ['header', { class: 'os-app-head' }, ['h2', {}, 'Arcade'],
      ['p', { class: 'os-app-lead' }, 'Two games and a benchmark you can play. Every game reports into your ladder: the next challenge is aimed where you win about two times in three.']],
    ['ul', { class: 'os-games' }, [{ $for: { g: '$.ui.studio.arcade.games[*]' }, $return: ['li', { key: '$g.id', class: 'os-game', 'data-game': '$g.id' },
      ['h3', {}, '$g.title'], ['p', {}, '$g.blurb'],
      when({ $not: { '$is-null': '$g.best' } }, ['p', { class: 'os-hint' }, 'Best: ', stars('$g.best')]),
      ['button', { type: 'button', class: spotClass('os-btn os-btn-primary', { $concat: ['arcade-', '$g.id'] }), 'data-coach': { $concat: ['arcade-', '$g.id'] }, on: { click: { action: 'arcade/open', with: '$g.id' } } }, icon('play'), ' Open']] }]]],
}];

/** @type {any[]} */
const SETTINGS_RULES = [{
  mode: 'settings', match: '$',
  body: ['div', { class: 'os-app os-settings' },
    ['header', { class: 'os-app-head' }, ['h2', {}, 'Settings'], ['p', { class: 'os-app-lead' }, 'How the studio looks, sounds and moves — and how it talks to a language model.']],
    ['section', { 'aria-label': 'Art direction' }, ['h3', {}, 'Art direction'],
      ['ul', { class: 'os-art', role: 'radiogroup' }, [{ $for: { a: '$.ui.studio.art[*]' }, $return: ['li', { key: '$a.id' },
        ['button', { type: 'button', class: 'os-art-card', role: 'radio', 'data-art': '$a.id', 'aria-checked': { $if: ['$a.active', 'true', 'false'] }, on: { click: { action: 'settings/art', with: '$a.id' } } },
          ['span', { class: 'os-art-swatch', 'aria-hidden': 'true' }], ['strong', {}, '$a.name'], ['span', {}, '$a.blurb']]] }]]],
    ['section', { 'aria-label': 'Sound' }, ['h3', {}, 'Sound'],
      range('Master', '$.settings.audio.master', 'settings/master', 0, 1, 0.05),
      range('Music', '$.settings.audio.music', 'settings/music', 0, 1, 0.05),
      range('Effects', '$.settings.audio.sfx', 'settings/sfx', 0, 1, 0.05),
      toggle(' Mute everything', '$.settings.audio.muted', 'settings/mute'),
      toggle(' Captions for sounds and voices', '$.settings.captions', 'settings/captions')],
    ['section', { 'aria-label': 'Light' }, ['h3', {}, 'Light'],
      range({ $concat: ['Hour of the sun: ', '$.ui.studio.hourText'] }, '$.settings.light.hour', 'settings/hour', 0, 24, 0.25, 'settings-light'),
      range({ $concat: ['Cel bands: ', '$.settings.light.bands'] }, '$.settings.light.bands', 'settings/bands', 1, 6, 1),
      toggle(' Hard shadows', '$.settings.light.shadows', 'settings/shadows')],
    ['section', { 'aria-label': 'Camera and motion', 'data-coach': 'settings-camera' }, ['h3', {}, 'Camera and motion'],
      ['div', { class: 'os-row', role: 'group', 'aria-label': 'Camera shots' }, [{ $for: { s: '$.ui.studio.shots[*]' }, $return: ['button', {
        type: 'button', class: 'os-btn os-btn-small', 'aria-pressed': { $if: ['$s.active', 'true', 'false'] }, on: { click: { action: 'studio/shot', with: '$s.id' } },
      }, '$s.id'] }]],
      toggle(' Drift the camera while idle', '$.settings.camera.orbit', 'settings/orbit'),
      toggle(' Lively figures (ragdolls)', '$.settings.motion.ragdoll', 'settings/ragdoll'),
      toggle(' Reduce motion', '$.os.reduce', 'os/motion')],
    ['section', { 'aria-label': 'Language model' }, ['h3', {}, 'Language model'],
      ['p', { class: 'os-hint' }, 'Small models — a mixture of experts with about three billion active parameters — fail at large JSON tool calls that a 27B dense model makes easily. The tool budget splits big calls into chunks the model can carry; “auto” reads it from the model’s name, the Arena measures it.'],
      ['div', { class: 'os-seg', role: 'radiogroup', 'aria-label': 'Tool budget' }, [{ $for: { b: '$.ui.studio.budgets[*]' }, $return: ['button', {
        type: 'button', role: 'radio', 'aria-checked': { $if: ['$b.active', 'true', 'false'] }, on: { click: { action: 'settings/budget', with: '$b.id' } },
      }, '$b.id'] }]],
      ['label', { class: 'os-field' }, ['span', {}, 'Model id (for auto)'], ['input', { class: 'os-input', type: 'text', maxlength: 120, placeholder: 'qwen/qwen3.6-35b-a3b', value: '$.settings.ai.model', on: { change: 'settings/model' } }]]],
    ['section', { 'aria-label': 'Language' }, ['h3', {}, 'Game language'],
      ['div', { class: 'os-seg', role: 'radiogroup' },
        ['button', { type: 'button', role: 'radio', 'aria-checked': { $if: [{ $eq: ['$.settings.lang', 'en'] }, 'true', 'false'] }, on: { click: { action: 'settings/lang', with: 'en' } } }, 'English'],
        ['button', { type: 'button', role: 'radio', 'aria-checked': { $if: [{ $eq: ['$.settings.lang', 'nl'] }, 'true', 'false'] }, on: { click: { action: 'settings/lang', with: 'nl' } } }, 'Nederlands']]],
    ['section', { 'aria-label': 'Keys' }, ['h3', {}, 'Keys'],
      ['ul', { class: 'os-keys' },
        ['li', {}, ['kbd', {}, 'Esc'], ' / ', ['kbd', {}, 'P'], ' pause and continue'],
        ['li', {}, ['kbd', {}, '← → ↑ ↓'], ' / ', ['kbd', {}, 'WASD'], ' move in a game'],
        ['li', {}, ['kbd', {}, 'Space'], ' / ', ['kbd', {}, 'Enter'], ' act in a game'],
        ['li', {}, ['kbd', {}, 'E'], ' a hint'],
        ['li', {}, ['kbd', {}, 'M'], ' mute and unmute']]]],
}];

/** Every studio window. */
export const STUDIO_RULES = Object.freeze([...CREW_RULES, ...BOARD_RULES, ...MAIL_RULES, ...LIBRARY_RULES, ...ARCADE_RULES, ...SETTINGS_RULES]);

/** The arcade's HUD: what the game says it shows. */
const HUD = ['div', { class: 'os-hud' },
  ['div', { class: 'os-hud-top' },
    ['strong', { class: 'os-hud-title' }, '$.arcade.hud.title'],
    when({ $exists: '$.arcade.hud.level' }, ['span', { class: 'os-pill' }, '$.arcade.hud.level']),
    when({ $exists: '$.arcade.hud.score' }, ['span', { class: 'os-pill os-hud-score' }, '$.arcade.hud.score']),
    when({ $exists: '$.arcade.hud.meter.label' }, ['span', { class: 'os-hud-meter' }, ['span', { class: 'os-hint' }, '$.arcade.hud.meter.label'],
      ['span', { class: 'os-meter' }, ['span', { class: 'os-meter-bar', style: { width: { $concat: [{ $mul: ['$.arcade.hud.meter.value', 100] }, '%'] } } }]]]),
    button({ class: 'os-btn os-icon-btn', 'aria-label': 'Pause', title: 'Pause (Esc)', on: { click: 'os/pause' } }, icon('pause'))],
  when({ $exists: '$.arcade.hud.players[0]' }, ['ul', { class: 'os-hud-players' }, [{ $for: { p: '$.arcade.hud.players[*]' }, $return: ['li', { class: { $if: ['$p.active', 'is-active', ''] }, style: { '--player': '$p.color' } }, '$p.name', ' ', ['strong', {}, '$p.score']] }]]),
  when({ $exists: '$.arcade.hud.prompt' }, ['p', { class: 'os-hud-prompt', 'aria-live': 'polite' }, '$.arcade.hud.prompt']),
  when({ $exists: '$.arcade.hud.grid.rows[0]' }, ['table', { class: 'os-hud-grid' },
    ['thead', {}, ['tr', {}, ['th', {}, ''], [{ $for: { c: '$.arcade.hud.grid.columns[*]' }, $return: ['th', { scope: 'col' }, '$c'] }]]],
    ['tbody', {}, [{ $for: { r: '$.arcade.hud.grid.rows[*]' }, $return: ['tr', {}, ['th', { scope: 'row' }, '$r.label'],
      [{ $for: { c: '$r.cells[*]' }, $return: ['td', {}, ['button', {
        type: 'button', class: { $if: ['$c.active', 'os-hud-cell is-active', 'os-hud-cell'] }, style: { $if: [{ $exists: '$c.swatch' }, { '--swatch': '$c.swatch' }, {}] },
        on: { click: { action: 'arcade/act', with: { type: 'cell', id: '$c.id' } } },
      }, '$c.text']] }]] }]]]),
  when({ $exists: '$.arcade.hud.buttons[0]' }, ['div', { class: 'os-hud-buttons' }, [{ $for: { b: '$.arcade.hud.buttons[*]' }, $return: ['button', {
    type: 'button', class: { $if: ['$b.primary', 'os-btn os-btn-primary', 'os-btn'] }, on: { click: { action: 'arcade/act', with: { type: '$b.id' } } },
  }, '$b.label'] }]]),
  when({ $exists: '$.arcade.hud.toast' }, when({ $not: { '$is-null': '$.arcade.hud.toast' } }, ['p', { class: 'os-hud-toast', role: 'status' }, '$.arcade.hud.toast'])),
  when({ $exists: '$.arcade.hud.help' }, ['p', { class: 'os-hud-help' }, '$.arcade.hud.help'])];

/** The menus over a game: its title card, the pause menu, the result. */
const ARCADE_MENUS = [
  when({ $eq: ['$.arcade.flow.current', 'title'] }, ['div', { class: 'os-arcade-card' },
    ['h2', {}, '$.ui.studio.arcade.game.title'], ['p', {}, '$.ui.studio.arcade.game.blurb'],
    when('$.ui.studio.arcade.game.duel', ['div', { class: 'os-seg', role: 'radiogroup', 'aria-label': 'Players' },
      ['button', { type: 'button', role: 'radio', 'aria-checked': { $if: [{ $eq: ['$.arcade.players', 1] }, 'true', 'false'] }, on: { click: { action: 'arcade/players', with: 1 } } }, 'One player'],
      ['button', { type: 'button', role: 'radio', 'aria-checked': { $if: [{ $eq: ['$.arcade.players', 2] }, 'true', 'false'] }, on: { click: { action: 'arcade/players', with: 2 } } }, 'Two players, taking turns']]),
    ['div', { class: 'os-row' },
      button({ class: 'os-btn os-btn-primary', on: { click: 'arcade/play' } }, icon('play'), ' Play'),
      button({ on: { click: 'arcade/close' } }, 'Back to the studio')],
    ['p', { class: 'os-hint' }, 'Esc pauses · arrows or WASD move · Space acts · E hints']]),
  when({ $eq: ['$.arcade.flow.current', 'paused'] }, ['div', { class: 'os-arcade-card os-menu', role: 'dialog', 'aria-label': 'Paused' },
    ['h2', { class: 'os-menu-title' }, 'Paused'],
    button({ class: 'os-btn os-btn-primary', on: { click: { $if: ['$.studio.paused', 'os/pause', 'arcade/resume'] } } }, icon('play'), ' Continue'),
    button({ on: { click: 'arcade/play' } }, 'Restart'),
    button({ on: { click: 'os/options' } }, icon('settings'), ' Options'),
    button({ on: { click: 'arcade/close' } }, icon('stop'), ' Quit to the studio')]),
  when({ $eq: ['$.arcade.flow.current', 'over'] }, ['div', { class: 'os-arcade-card', role: 'dialog', 'aria-label': 'Result' },
    ['h2', {}, stars('$.arcade.outcome.stars')], ['p', {}, '$.arcade.outcome.summary'],
    ['div', { class: 'os-row' },
      button({ class: 'os-btn os-btn-primary', on: { click: 'arcade/play' } }, 'Play again'),
      button({ on: { click: 'arcade/close' } }, 'Back to the studio')]]),
];

/** The layers over the desk, in paint order. */
export const STUDIO_OVERLAYS = Object.freeze([
  when({ $not: { '$is-null': '$.arcade.game' } }, ['section', { class: 'os-arcade', 'data-game': '$.arcade.game', 'data-phase': '$.arcade.flow.current', 'aria-label': '$.ui.studio.arcade.game.title' },
    ['jaren-widget', {
      name: 'arcade', key: { $concat: ['arcade-', '$.arcade.game'] }, class: 'os-arcade-stage',
      props: {
        game: '$.arcade.game', phase: '$.arcade.flow.current', seed: '$.arcade.seed', save: { $get: ['$.arcade.saves', '$.arcade.game'] },
        players: '$.arcade.players', act: '$.arcade.act', theme: '$.os.theme', reduce: '$.os.reduce', ragdoll: '$.settings.motion.ragdoll',
        light: '$.settings.light', lang: '$.settings.lang', label: '$.ui.studio.arcade.game.title',
      },
    }],
    when({ $and: [{ $ne: ['$.arcade.flow.current', 'title'] }, { $not: { '$is-null': '$.arcade.hud' } }] }, HUD),
    ...ARCADE_MENUS]),
  when({ $and: ['$.studio.paused', { '$is-null': '$.arcade.game' }] }, ['div', { class: 'os-pause', role: 'dialog', 'aria-label': 'Paused' },
    ['div', { class: 'os-arcade-card os-menu' },
      ['h2', { class: 'os-menu-title' }, 'Paused'],
      ['p', { class: 'os-hint' }, 'The machine, the music and every game hold where they are.'],
      button({ class: 'os-btn os-btn-primary', on: { click: 'os/pause' } }, icon('play'), ' Continue'),
      button({ on: { click: 'os/options' } }, icon('settings'), ' Options'),
      button({ on: { click: 'os/stop' } }, icon('stop'), ' Stop everything')]]),
  ['aside', { class: { $if: ['$.coach.open', 'os-coach is-open', 'os-coach'] }, 'aria-label': 'Coach' },
    { $if: ['$.coach.open', ['div', { class: 'os-coach-card' },
      ['div', { class: 'os-coach-head' }, ['span', { class: 'os-coach-figure', 'aria-hidden': 'true' }, icon('coach')],
        ['strong', {}, '$.ui.studio.coach.rank'], ['span', { class: 'os-hint' }, { $concat: ['$.ui.studio.coach.xp', ' xp'] }],
        ['span', { class: 'os-meter', 'aria-hidden': 'true' }, ['span', { class: 'os-meter-bar', style: { width: { $concat: ['$.ui.studio.coach.pct', '%'] } } }]]],
      when({ $not: { '$is-null': '$.ui.studio.coach.quest' } }, ['p', { class: 'os-coach-quest' }, '$.ui.studio.coach.quest', ' · ', '$.ui.studio.coach.progress']),
      ['p', { class: 'os-coach-text', 'aria-live': 'polite' }, '$.ui.studio.coach.text'],
      ['div', { class: 'os-row' },
        when({ $not: { '$is-null': '$.ui.studio.coach.target' } }, button({ class: 'os-btn os-btn-small', on: { click: { action: 'studio/spotlight', with: '$.ui.studio.coach.target' } } }, 'Show me')),
        button({ class: 'os-btn os-btn-small', on: { click: 'coach/toggle' } }, 'Hide')]],
    button({ class: 'os-btn os-coach-open', 'aria-label': 'Open the coach', on: { click: 'coach/toggle' } }, icon('coach'), ' ', '$.ui.studio.coach.rank')] }],
  when({ $not: { '$is-null': '$.studio.toast' } }, ['div', { class: 'os-toast', key: { $concat: ['toast-', '$.studio.toastSeq'] }, role: 'status' }, '$.studio.toast']),
]);
