//@ts-check
/**
 * The studio's action documents, in the house style of `actions.js`:
 * JSON query documents over the state, the payload and the DOM event.
 * Whatever changes something governed — a card, a message, an idea, a
 * verdict — goes through the contract (`invoke`, `call`); settings, the
 * pause menu, what is open and what is typed are the chrome's own.
 *
 * The arcade's lifecycle actions are not written here at all: they are
 * generated from the game lifecycle's jaren-fsm document by `fsmToApp`,
 * so the pause menu's Continue, Restart and Stop are that document's
 * events and nothing else.
 */

import { fsmToApp } from '@jarenjs/flow';
import { GAME_FLOW } from '../engine/loop.js';

/** Count a coach mark: something the player did that a quest step may wait for.
 * @param {string} name */
const mark = (name) => ({ op: 'add', path: `/coach/marks/${name}`, value: { $add: [{ $default: [`$.coach.marks.${name}`, 0] }, 1] } });

/** Count a mark whose name is computed (`open_<app>`, `play_<game>`).
 * @param {string} prefix @param {any} suffix */
const markOf = (prefix, suffix) => ({
  op: 'add',
  path: { $concat: [`/coach/marks/${prefix}`, suffix] },
  value: { $add: [{ $default: [{ $get: ['$.coach.marks', { $concat: [prefix, suffix] }] }, 0] }, 1] },
});

/** @param {string} op @param {any} input */
const invoke = (op, input) => ({ run: 'invoke', with: { op, input } });

/** @param {string} op @param {any} input @param {string} then @param {string} fail */
const call = (op, input, then, fail) => ({ run: 'call', with: { op, ...(input === undefined ? {} : { input }), then, catch: fail } });

/** A field's typed value, as a number. */
const NUMBER = { $number: '$event.value' };

/** The game lifecycle, hosted: arcade/start, /pause, /resume, /finish, /restart, /stop. */
export const ARCADE_FLOW = fsmToApp(GAME_FLOW, { pointer: '/arcade/flow', namespace: 'arcade/' });

/** Say something on screen for a moment. @param {any} text */
const toast = (text) => [
  { op: 'replace', path: '/studio/toast', value: text },
  { op: 'replace', path: '/studio/toastSeq', value: { $add: ['$.studio.toastSeq', 1] } },
];

export const STUDIO_ACTIONS = {
  // ── settings ───────────────────────────────────────────────────────
  'settings/art': {
    $let: { theme: { $if: [{ $eq: ['$payload', 'chalk'] }, 'dark', { $if: [{ $eq: ['$payload', 'neon'] }, 'neon', 'light'] }] } },
    $return: {
      patch: [
        { op: 'replace', path: '/settings/art', value: '$payload' },
        { op: 'replace', path: '/os/theme', value: '$theme' },
        mark('art'),
      ],
      effects: [{ run: 'prefs', with: { theme: '$theme', reduce: '$.os.reduce' } }, { run: 'sound', with: 'pop' }],
    },
  },
  'settings/master': { patch: [{ op: 'replace', path: '/settings/audio/master', value: NUMBER }], effects: [{ run: 'mix' }] },
  'settings/music': { patch: [{ op: 'replace', path: '/settings/audio/music', value: NUMBER }], effects: [{ run: 'mix' }] },
  'settings/sfx': { patch: [{ op: 'replace', path: '/settings/audio/sfx', value: NUMBER }], effects: [{ run: 'mix' }, { run: 'sound', with: 'click' }] },
  'settings/mute': { patch: [{ op: 'replace', path: '/settings/audio/muted', value: { $not: '$.settings.audio.muted' } }], effects: [{ run: 'mix' }] },
  'settings/hour': { patch: [{ op: 'replace', path: '/settings/light/hour', value: NUMBER }, mark('light')] },
  'settings/bands': { patch: [{ op: 'replace', path: '/settings/light/bands', value: NUMBER }, mark('light')] },
  'settings/light': {
    patch: [
      { op: 'replace', path: '/settings/light/hour', value: '$payload.hour' },
      { op: 'replace', path: '/settings/light/bands', value: '$payload.bands' },
      mark('light'),
    ],
  },
  'settings/shadows': { patch: [{ op: 'replace', path: '/settings/light/shadows', value: { $not: '$.settings.light.shadows' } }] },
  'settings/orbit': { patch: [{ op: 'replace', path: '/settings/camera/orbit', value: { $not: '$.settings.camera.orbit' } }] },
  'settings/ragdoll': { patch: [{ op: 'replace', path: '/settings/motion/ragdoll', value: { $not: '$.settings.motion.ragdoll' } }] },
  'settings/captions': { patch: [{ op: 'replace', path: '/settings/captions', value: { $not: '$.settings.captions' } }] },
  'settings/budget': { patch: [{ op: 'replace', path: '/settings/ai/budget', value: '$payload' }], effects: [{ run: 'budget', with: '$payload' }] },
  'settings/model': { patch: [{ op: 'replace', path: '/settings/ai/model', value: '$event.value' }] },
  'settings/lang': { patch: [{ op: 'replace', path: '/settings/lang', value: { $if: [{ $eq: ['$payload', 'nl'] }, 'nl', 'en'] } }] },
  'studio/shot': {
    patch: [
      { op: 'replace', path: '/studio/shot', value: '$payload' },
      { op: 'replace', path: '/studio/shotSeq', value: { $add: ['$.studio.shotSeq', 1] } },
      mark('shot'),
    ],
  },
  'studio/toast': { patch: toast('$payload') },
  'council/deadline': { patch: [{ op: 'replace', path: '/council/deadline', value: '$payload' }] },
  // a crew member hops for joy on the stage for the block it just built
  'studio/cheer': {
    patch: [
      { op: 'replace', path: '/studio/cheer', value: '$payload' },
      { op: 'replace', path: '/studio/cheerSeq', value: { $add: ['$.studio.cheerSeq', 1] } },
    ],
  },
  // the music, once the browser lets the studio make a sound
  'studio/music': { effects: [{ run: 'music', with: '$payload' }] },
  'studio/burst': {
    patch: [
      { op: 'replace', path: '/studio/burst', value: '$payload' },
      { op: 'replace', path: '/studio/burstSeq', value: { $add: ['$.studio.burstSeq', 1] } },
    ],
  },
  'studio/spotlight': { patch: [{ op: 'replace', path: '/studio/spotlight', value: '$payload' }] },

  // ── the pause menu: everything holds, nothing is lost ─────────────
  'os/pause': {
    $if: ['$.studio.paused', {
      patch: [
        { op: 'replace', path: '/studio/paused', value: false },
        { op: 'replace', path: '/machine/running', value: '$.studio.resumeRunning' },
      ],
      effects: [{ run: 'hold', with: false }, { $if: [{ $eq: ['$.arcade.flow.current', 'paused'] }, { run: 'redispatch', with: { action: 'arcade/resume' } }] }],
    }, {
      patch: [
        { op: 'replace', path: '/studio/paused', value: true },
        { op: 'replace', path: '/studio/resumeRunning', value: '$.machine.running' },
        { op: 'replace', path: '/machine/running', value: false },
      ],
      effects: [{ run: 'hold', with: true }, { $if: [{ $eq: ['$.arcade.flow.current', 'playing'] }, { run: 'redispatch', with: { action: 'arcade/pause' } }] }],
    }],
  },
  // Stop: the machine halts, the music stops, a game goes back to its title
  'os/stop': {
    patch: [
      { op: 'replace', path: '/studio/paused', value: false },
      { op: 'replace', path: '/machine/running', value: false },
    ],
    effects: [{ run: 'hold', with: false }, { run: 'music', with: 'stop' }, { run: 'sound', with: 'stop' },
      { $if: [{ $ne: ['$.arcade.flow.current', 'title'] }, { run: 'redispatch', with: { action: 'arcade/stop' } }] }],
  },
  'os/options': {
    patch: [{ op: 'replace', path: '/os/app', value: 'settings' }, { op: 'replace', path: '/studio/paused', value: false }],
    effects: [{ run: 'hold', with: false }],
  },

  // ── mail ───────────────────────────────────────────────────────────
  'mail/set': {
    patch: [
      { op: 'replace', path: '/mail/threads', value: '$payload.threads' },
      { op: 'replace', path: '/mail/seq', value: '$payload.seq' },
    ],
  },
  'mail/folder': { patch: [{ op: 'replace', path: '/mail/folder', value: '$payload' }, { op: 'replace', path: '/mail/open', value: null }] },
  'mail/open': {
    patch: [{ op: 'replace', path: '/mail/open', value: '$payload' }, mark('mail_read')],
    effects: [invoke('mail.read', { thread: '$payload' })],
  },
  'mail/close': { patch: [{ op: 'replace', path: '/mail/open', value: null }] },
  'mail/draft': { patch: [{ op: 'replace', path: '/mail/draft', value: '$event.value' }] },
  'mail/subject': { patch: [{ op: 'replace', path: '/mail/subject', value: '$event.value' }] },
  'mail/send': {
    $if: [{ $gt: [{ '$string-length': { '$normalize-space': '$.mail.draft' } }, 0] }, {
      patch: [{ op: 'replace', path: '/mail/draft', value: '' }, { op: 'replace', path: '/mail/subject', value: '' }, mark('mail_send')],
      effects: [call('mail.send', {
        $if: [{ $not: { '$is-null': '$.mail.open' } },
          { by: 'human', thread: '$.mail.open', to: ['oracle'], text: { '$normalize-space': '$.mail.draft' } },
          { by: 'human', to: ['oracle'], subject: { $if: [{ $gt: [{ '$string-length': { '$normalize-space': '$.mail.subject' } }, 0] }, { $substring: [{ '$normalize-space': '$.mail.subject' }, 0, 80] }, 'A question'] }, text: { '$normalize-space': '$.mail.draft' } }],
      }, 'mail/sent', 'mail/failed'), { run: 'sound', with: 'whoosh' }],
    }],
  },
  // a letter just sent stays in view, so the oracle's answer is seen arriving
  'mail/sent': {
    patch: [{ op: 'replace', path: '/mail/open', value: '$payload.value.thread' }],
    effects: [invoke('mail.read', { thread: '$payload.value.thread' })],
  },
  'mail/failed': { patch: [{ op: 'replace', path: '/os/notice', value: { tone: 'warn', text: '$payload.message' } }] },

  // ── the board ──────────────────────────────────────────────────────
  'board/set': {
    patch: [
      { op: 'replace', path: '/board/cards', value: '$payload.cards' },
      { op: 'replace', path: '/board/links', value: '$payload.links' },
      { op: 'replace', path: '/board/seq', value: '$payload.seq' },
    ],
  },
  'board/draft': { patch: [{ op: 'replace', path: '/board/draft', value: '$event.value' }] },
  'board/kind': { patch: [{ op: 'replace', path: '/board/kind', value: '$payload' }] },
  'board/add': {
    $if: [{ $gt: [{ '$string-length': { '$normalize-space': '$.board.draft' } }, 0] }, {
      patch: [{ op: 'replace', path: '/board/draft', value: '' }],
      effects: [invoke('board.add', { by: 'human', kind: '$.board.kind', text: { $substring: [{ '$normalize-space': '$.board.draft' }, 0, 280] } }), { run: 'sound', with: 'pop' }],
    }],
  },
  'board/select': { patch: [{ op: 'replace', path: '/board/selected', value: '$payload' }] },
  'board/move': { effects: [invoke('board.edit', { by: 'human', id: '$payload.id', x: '$payload.x', y: '$payload.y' })] },
  'board/tick': { effects: [invoke('board.edit', { by: 'human', id: '$payload.id', done: { $not: '$payload.done' } }), { run: 'sound', with: 'chime' }] },
  'board/color': { effects: [invoke('board.edit', { by: 'human', id: '$payload.id', color: '$payload.color' })] },
  'board/text': {
    $if: [{ $and: [{ $not: { '$is-null': '$.board.selected' } }, { $gt: [{ '$string-length': { '$normalize-space': '$event.value' } }, 0] }] }, {
      effects: [invoke('board.edit', { by: 'human', id: '$.board.selected', text: { $substring: ['$event.value', 0, 280] } })],
    }],
  },
  'board/link-start': { patch: [{ op: 'replace', path: '/board/linking', value: '$payload' }] },
  'board/link-to': {
    $if: [{ $and: [{ $not: { '$is-null': '$.board.linking' } }, { $ne: ['$.board.linking', '$payload.id'] }] }, {
      patch: [{ op: 'replace', path: '/board/linking', value: null }],
      effects: [invoke('board.link', { by: 'human', from: '$.board.linking', to: '$payload.id', kind: { $if: ['$payload.todo', 'blocks', 'relates'] } }), { run: 'sound', with: 'hop' }],
    }, { patch: [{ op: 'replace', path: '/board/linking', value: null }] }],
  },
  'board/remove': {
    patch: [{ op: 'replace', path: '/board/selected', value: null }],
    effects: [invoke('board.remove', { by: 'human', id: '$payload' }), { run: 'sound', with: 'close' }],
  },
  'board/pin': {
    effects: [invoke('board.add', { by: 'human', kind: 'note', text: { $substring: ['$payload.label', 0, 280] }, ref: '$payload' }), { run: 'sound', with: 'pop' }],
  },

  // ── the library ────────────────────────────────────────────────────
  'library/ready': { patch: [{ op: 'replace', path: '/library/status', value: 'ready' }, { op: 'replace', path: '/library/docs', value: '$payload' }] },
  'library/unavailable': { patch: [{ op: 'replace', path: '/library/status', value: 'unavailable' }] },
  'library/open': {
    patch: [mark('doc_open'), { op: 'replace', path: '/library/sentence', value: -1 }],
    effects: [{ run: 'speak', with: null }, call('library.read', { doc: '$payload', from: 0, count: 3 }, 'library/page', 'library/failed')],
  },
  'library/more': {
    $if: [{ '$is-number': '$.library.page.next' }, {
      effects: [{ run: 'speak', with: null }, call('library.read', { doc: '$.library.page.doc', from: '$.library.page.next', count: 3 }, 'library/page', 'library/failed')],
    }],
  },
  'library/back': { patch: [{ op: 'replace', path: '/library/page', value: null }], effects: [{ run: 'speak', with: null }] },
  'library/page': { patch: [{ op: 'replace', path: '/library/page', value: '$payload.value' }, { op: 'replace', path: '/library/sentence', value: -1 }] },
  'library/failed': { patch: toast({ $concat: ['The library could not open that: ', '$payload.message'] }) },
  'library/listen': {
    $if: ['$.library.speaking', {
      patch: [{ op: 'replace', path: '/library/speaking', value: false }],
      effects: [{ run: 'speak', with: null }],
    }, {
      patch: [{ op: 'replace', path: '/library/speaking', value: true }, mark('listen')],
      effects: [{ run: 'speak', with: '$.library.page.sections' }],
    }],
  },
  'library/sentence': { patch: [{ op: 'replace', path: '/library/sentence', value: '$payload' }] },
  'library/spoken': { patch: [{ op: 'replace', path: '/library/speaking', value: false }, { op: 'replace', path: '/library/sentence', value: -1 }] },
  'library/query': { patch: [{ op: 'replace', path: '/library/query', value: '$event.value' }] },
  'library/ask': {
    $if: [{ $gt: [{ '$string-length': { '$normalize-space': '$.library.query' } }, 0] }, {
      patch: [mark('ask'), { op: 'replace', path: '/library/answer', value: { text: 'Looking it up…', citations: [], pending: true } }],
      effects: [{ run: 'ask', with: { '$normalize-space': '$.library.query' } }],
    }],
  },
  'library/answered': {
    patch: [
      { op: 'replace', path: '/library/answer', value: '$payload.answer' },
      { op: 'replace', path: '/library/hits', value: '$payload.hits' },
    ],
  },

  // ── the crew ───────────────────────────────────────────────────────
  'crew/set': { patch: [{ op: 'replace', path: '/crew/project', value: '$payload' }] },
  'crew/title': { patch: [{ op: 'replace', path: '/crew/setup/title', value: '$event.value' }] },
  'crew/players': { patch: [{ op: 'replace', path: '/crew/setup/players', value: '$event.value' }] },
  'crew/goal': { patch: [{ op: 'replace', path: '/crew/setup/goal', value: NUMBER }] },
  // the host reads the employers' names off the form (a list of names a person
  // types with commas between them) and starts the project through the contract
  'crew/start': {
    patch: [mark('crew_start')],
    effects: [{ run: 'crew-start', with: { title: '$.crew.setup.title', players: '$.crew.setup.players', goal: { $default: ['$.crew.setup.goal', 4] } } }, { run: 'sound', with: 'start' }],
  },
  'crew/draft': { patch: [{ op: 'replace', path: '/crew/draft', value: '$event.value' }] },
  'crew/idea': {
    $if: [{ $gt: [{ '$string-length': { '$normalize-space': '$.crew.draft' } }, 0] }, {
      patch: [{ op: 'replace', path: '/crew/draft', value: '' }],
      effects: [invoke('crew.idea', { by: 'human', text: { $substring: [{ '$normalize-space': '$.crew.draft' }, 0, 200] } }), { run: 'sound', with: 'pop' }],
    }],
  },
  'crew/end': { patch: [mark('crew_turn')], effects: [invoke('crew.end', { by: 'human' }), { run: 'sound', with: 'whoosh' }] },
  'crew/turn': { patch: [{ op: 'replace', path: '/crew/busy', value: true }], effects: [{ run: 'crew', with: '$payload' }] },
  'crew/idle': { patch: [{ op: 'replace', path: '/crew/busy', value: false }] },
  'crew/review': {
    patch: [mark('crew_review')],
    effects: [invoke('crew.review', { by: 'human', task: '$payload.task', verdict: '$payload.verdict' }),
      { $if: [{ $eq: ['$payload.verdict', 'veto'] }, { run: 'sound', with: 'veto' }, { run: 'sound', with: 'pass' }] }],
  },
  'crew/launched': {
    patch: [
      mark('crew_ship'),
      { op: 'replace', path: '/crew/made', value: [{ id: '$payload.id', title: '$payload.title', stars: '$payload.stars',
        blocks: [{ $for: { t: '$payload.tasks[*]' }, $where: { $eq: ['$t.status', 'approved'] }, $return: '$t.block' }] },
      { $subsequence: ['$.crew.made[*]', 0, 22] }] },
      ...toast({ $concat: ['Shipped: ', '$payload.title', '!'] }),
    ],
    effects: [{ run: 'sound', with: 'levelup' }, { run: 'redispatch', with: { action: 'studio/burst', payload: 'confetti' } }, { run: 'xp', with: { amount: 120, badge: 'shipped' } }],
  },
  'crew/new': { patch: [{ op: 'replace', path: '/crew/project', value: null }] },
  'crew/made-open': { patch: [{ op: 'replace', path: '/crew/preview', value: '$payload' }, mark('made_open')], effects: [{ run: 'sound', with: 'open' }] },
  'crew/made-close': { patch: [{ op: 'replace', path: '/crew/preview', value: null }] },

  // ── the arcade (its lifecycle is ARCADE_FLOW) ──────────────────────
  'arcade/open': {
    patch: [
      { op: 'replace', path: '/arcade/game', value: '$payload' },
      { op: 'replace', path: '/arcade/flow/current', value: 'title' },
      { op: 'replace', path: '/arcade/hud', value: null },
      { op: 'replace', path: '/arcade/outcome', value: null },
    ],
    effects: [{ run: 'sound', with: 'open' }],
  },
  // quitting from the pause menu lets the studio go too: the machine runs again if it ran
  'arcade/close': {
    patch: [
      { op: 'replace', path: '/arcade/game', value: null },
      { op: 'replace', path: '/arcade/flow/current', value: 'title' },
      { op: 'replace', path: '/arcade/hud', value: null },
      { $if: ['$.studio.paused', { op: 'replace', path: '/machine/running', value: '$.studio.resumeRunning' }] },
      { op: 'replace', path: '/studio/paused', value: false },
    ],
    effects: [{ $if: ['$.studio.paused', { run: 'hold', with: false }] }, { run: 'music', with: 'desk' }, { run: 'sound', with: 'close' }],
  },
  'arcade/play': {
    patch: [markOf('play_', '$.arcade.game'), { op: 'replace', path: '/arcade/seed', value: { $add: ['$.arcade.seed', 1] } }, { op: 'replace', path: '/arcade/outcome', value: null }],
    effects: [{ run: 'redispatch', with: { action: { $if: [{ $eq: ['$.arcade.flow.current', 'title'] }, 'arcade/start', 'arcade/restart'] } } }],
  },
  'arcade/players': { patch: [{ op: 'replace', path: '/arcade/players', value: { $if: [{ $eq: ['$payload', 2] }, 2, 1] } }] },
  'arcade/hud': { patch: [{ op: 'replace', path: '/arcade/hud', value: '$payload' }] },
  'arcade/act': { patch: [{ op: 'replace', path: '/arcade/act', value: { seq: { $add: ['$.arcade.act.seq', 1] }, action: '$payload' } }] },
  'arcade/over': {
    patch: [
      { op: 'replace', path: '/arcade/outcome', value: '$payload' },
      { $if: [{ $gt: ['$payload.stars', 0] }, markOf('win_', '$.arcade.game')] },
    ],
    effects: [{ run: 'redispatch', with: { action: 'arcade/finish' } }, { run: 'xp', with: { amount: { $mul: [{ $default: ['$payload.stars', 0] }, 15] } } }],
  },
  'arcade/save': { patch: [{ op: 'add', path: { $concat: ['/arcade/saves/', '$payload.game'] }, value: '$payload.save' }] },
  'arcade/event': { effects: [{ run: 'game-event', with: '$payload' }] },

  // ── the coach ──────────────────────────────────────────────────────
  'coach/toggle': { patch: [{ op: 'replace', path: '/coach/open', value: { $not: '$.coach.open' } }] },
  'coach/set': {
    patch: [
      { op: 'replace', path: '/coach', value: '$payload.coach' },
      { op: 'replace', path: '/profile', value: '$payload.profile' },
      { $if: [{ $exists: '$payload.toast' }, { op: 'replace', path: '/studio/toast', value: '$payload.toast' }] },
      { $if: [{ $exists: '$payload.toast' }, { op: 'replace', path: '/studio/toastSeq', value: { $add: ['$.studio.toastSeq', 1] } }] },
    ],
  },
  'coach/mark': { patch: [markOf('', '$payload')] },
  'profile/set': { patch: [{ op: 'replace', path: '/profile', value: '$payload' }] },
  ...ARCADE_FLOW.actions,
};
