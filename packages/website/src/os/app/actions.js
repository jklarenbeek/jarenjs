//@ts-check
/**
 * The OS's action documents: every state change the OS can make, as
 * Jaren JSON Query documents (APP-FORMAT §3). JavaScript appears only in
 * the effects they name — the tape unit (`cpu`), the contract client
 * (`invoke`, `call`), storage, downloads — so the whole behaviour of the
 * chrome is one serializable value the Source app can show.
 *
 * Three families:
 *
 *   - **the human's**, bound to buttons in the view: they never change
 *     governed state themselves; a veto, a proposal, a word to the
 *     council each go through `invoke`, i.e. through the contract, the
 *     same road an agent takes;
 *   - **the driver's**, dispatched by the council host with the results
 *     the workflow and merit documents produced;
 *   - **the machine's**, the tick: the tape unit (`cpu`) steps the world
 *     the action hands it and sends the new one back as `machine/advanced`.
 *
 * Work that answers later — the tape unit, a forecast, a contract call —
 * is an effect that sends its answer back as an action of its own: the
 * `call` effect names the action for the value (`then`) and for the
 * refusal (`catch`).
 */

/** Prepend `item` to the list at `path` (a `$`-path) and keep `keep` entries.
 * @param {string} item @param {string} path @param {number} keep */
const prepend = (item, path, keep) => [item, { $subsequence: [`${path}[*]`, 0, keep - 1] }];

/** The next stage event: a sequence number, what happened, who and to what.
 * @param {string} kind @param {any} [by] @param {any} [change] */
const event = (kind, by, change) => [{
  seq: '$seq', kind, ...(by === undefined ? {} : { by }), ...(change === undefined ? {} : { change }),
}, { $subsequence: ['$.events[*]', 0, 7] }];

/** Invoke one contract operation through the `invoke` effect.
 * @param {string} op @param {any} input */
const invoke = (op, input) => ({ run: 'invoke', with: { op, input } });

/** Call one contract operation and send its value to `then`, its refusal to `catch`.
 * @param {string} op @param {any} input @param {string} then @param {string} fail */
const call = (op, input, then, fail) => ({ run: 'call', with: { op, ...(input === undefined ? {} : { input }), then, catch: fail } });

export const ACTIONS = {
  // ── the machine ────────────────────────────────────────────────────
  'machine/tick': {
    effects: [{
      run: 'cpu',
      with: {
        machine: '$.program.machine',
        world: '$.world',
        steps: { $default: ['$payload.steps', '$.machine.burst'] },
      },
    }],
  },
  'machine/advanced': {
    patch: [
      { op: 'replace', path: '/world', value: '$payload.world' },
      { op: 'replace', path: '/machine/measure', value: '$payload.measure' },
      { op: 'replace', path: '/machine/trail', value: '$payload.trail' },
      { op: 'replace', path: '/machine/fired', value: '$payload.fired' },
    ],
  },
  'machine/stopped': {
    patch: [
      { op: 'replace', path: '/machine/running', value: false },
      { op: 'replace', path: '/os/notice', value: { tone: 'warn', text: { $concat: ['The machine stopped: ', '$payload'] } } },
    ],
  },
  // the desk's music comes back with the machine, after a stop
  'machine/run': {
    patch: [{ op: 'replace', path: '/machine/running', value: { $boolean: '$payload' } }],
    effects: [{ $if: [{ $boolean: '$payload' }, { run: 'music', with: 'ensure' }] }],
  },
  'machine/toggle': {
    patch: [{ op: 'replace', path: '/machine/running', value: { $not: '$.machine.running' } }],
    effects: [{ $if: [{ $not: '$.machine.running' }, { run: 'music', with: 'ensure' }] }],
  },
  'machine/burst': {
    patch: [{ op: 'replace', path: '/machine/burst', value: { $if: [{ $eq: ['$.machine.burst', 1] }, 8, 1] } }],
  },
  // a rule cell was cycled in the Machine app: keep the draft change and
  // ask the tape unit what it would do
  'machine/draft': {
    patch: [
      { op: 'replace', path: '/machine/draft', value: '$payload' },
      { op: 'replace', path: '/machine/forecast', value: null },
      { op: 'add', path: '/coach/marks/draft', value: { $add: [{ $default: ['$.coach.marks.draft', 0] }, 1] } },
    ],
    effects: [{ run: 'forecast', with: '$payload' }],
  },
  'machine/forecasted': { patch: [{ op: 'replace', path: '/machine/forecast', value: '$payload' }] },
  'machine/discard': {
    patch: [
      { op: 'replace', path: '/machine/draft', value: null },
      { op: 'replace', path: '/machine/forecast', value: null },
    ],
  },
  'machine/propose': {
    $if: [{ $exists: '$.machine.draft.kind' }, {
      patch: [
        { op: 'replace', path: '/machine/draft', value: null },
        { op: 'replace', path: '/machine/forecast', value: null },
        { op: 'replace', path: '/os/app', value: 'council' },
        { op: 'add', path: '/coach/marks/propose', value: { $add: [{ $default: ['$.coach.marks.propose', 0] }, 1] } },
      ],
      effects: [invoke('council.propose', { by: 'human', change: '$.machine.draft' }), { run: 'sound', with: 'pop' }],
    }],
  },

  // ── the human, through the contract ────────────────────────────────
  'council/convene': { effects: [invoke('council.convene', {})] },
  'council/veto': {
    $if: [{ $exists: '$.council.winner.id' }, { effects: [invoke('council.veto', { by: 'human', proposal: '$.council.winner.id' })] }],
  },
  'council/approve': {
    $if: [{ $exists: '$.council.winner.id' }, { effects: [invoke('council.approve', { by: 'human', proposal: '$.council.winner.id' })] }],
  },
  'council/repeal': { effects: [invoke('council.repeal', { by: 'human', amendment: '$payload' })] },
  'council/propose': { effects: [invoke('council.propose', { by: 'human', change: '$payload' })] },
  'council/draft': { patch: [{ op: 'replace', path: '/council/draft', value: '$event.value' }] },
  'council/say': {
    $if: [{ $gt: [{ '$string-length': { '$normalize-space': '$.council.draft' } }, 0] }, {
      patch: [{ op: 'replace', path: '/council/draft', value: '' }, { op: 'add', path: '/coach/marks/say', value: { $add: [{ $default: ['$.coach.marks.say', 0] }, 1] } }],
      effects: [invoke('council.say', { by: 'human', text: { '$normalize-space': '$.council.draft' } })],
    }],
  },

  // ── the council driver's results ───────────────────────────────────
  'council/phase': {
    patch: [
      { op: 'replace', path: '/council/phase', value: '$payload.phase' },
      { op: 'replace', path: '/council/session', value: '$payload.session' },
      { op: 'replace', path: '/council/proposals', value: '$payload.proposals' },
      { op: 'replace', path: '/council/scores', value: '$payload.scores' },
      { op: 'replace', path: '/council/winner', value: '$payload.winner' },
      { op: 'replace', path: '/council/deadline', value: '$payload.deadline' },
      { op: 'replace', path: '/council/window', value: '$payload.window' },
      { $if: [{ $exists: '$payload.next' }, { op: 'replace', path: '/council/next', value: '$payload.next' }] },
    ],
    // a session's verdict is news: the winner's case goes into the session's thread
    effects: [{ $if: [{ $eq: ['$payload.phase', 'veto'] }, { run: 'post', with: {
      thread: { $concat: ['council-', '$payload.session'] }, subject: { $concat: ['Council, session ', '$payload.session'] },
      folder: 'council', from: '$payload.winner.by', to: ['human'],
      text: { $concat: ['The council passed “', '$payload.winner.title', '”. ', '$payload.winner.why', ' — veto it, or let it pass.'] },
    } }] }, { $if: [{ $eq: ['$payload.phase', 'veto'] }, { run: 'sound', with: 'chime' }] }],
  },
  'council/queue': { patch: [{ op: 'replace', path: '/council/queue', value: '$payload' }] },
  'council/enqueue': { patch: [{ op: 'add', path: '/council/queue/-', value: '$payload' }] },
  // every word to the council is also filed in its session's mail thread
  'council/said': {
    patch: [{ op: 'replace', path: '/council/chat', value: prepend('$payload', '$.council.chat', 12) }],
    effects: [{ run: 'post', with: {
      thread: { $concat: ['council-', '$.council.session'] }, subject: { $concat: ['Council, after session ', '$.council.session'] },
      folder: 'council', from: '$payload.by', to: ['painter', 'dancer', 'critic', 'architect', 'oracle'], text: '$payload.text',
    } }],
  },
  'council/enacted': {
    $let: { seq: { $add: ['$.os.seq', 1] } },
    $return: {
      patch: [
        { op: 'replace', path: '/program', value: '$payload.program' },
        { op: 'replace', path: '/world', value: '$payload.world' },
        { op: 'replace', path: '/council/log', value: prepend('$payload.amendment', '$.council.log', 24) },
        { op: 'replace', path: '/os/seq', value: '$seq' },
        { op: 'replace', path: '/events', value: event('enact', '$payload.amendment.by', '$payload.amendment.change') },
      ],
      effects: [{ run: 'record', with: '$payload.amendment' }, { run: 'sound', with: 'pass' }],
    },
  },
  'council/vetoed': {
    $let: { seq: { $add: ['$.os.seq', 1] } },
    $return: {
      patch: [
        { op: 'replace', path: '/council/log', value: prepend('$payload.amendment', '$.council.log', 24) },
        { op: 'replace', path: '/os/seq', value: '$seq' },
        { op: 'replace', path: '/events', value: event('veto', '$payload.amendment.by', '$payload.amendment.change') },
      ],
      effects: [{ run: 'record', with: '$payload.amendment' }, { run: 'sound', with: 'veto' }],
    },
  },
  'council/rested': {
    $let: { seq: { $add: ['$.os.seq', 1] } },
    $return: {
      patch: [
        { op: 'replace', path: '/os/seq', value: '$seq' },
        { op: 'replace', path: '/events', value: event('rest') },
      ],
    },
  },
  'council/refused': {
    patch: [{ op: 'replace', path: '/os/notice', value: { tone: 'warn', text: { $concat: ['The amendment no longer fits the program: ', '$payload.reason'] } } }],
  },
  'council/merits': {
    $let: {
      leader: {
        $head: {
          $for: { e: { $entries: '$payload.merits' } },
          $where: { $ne: ['$e.key', 'human'] },
          $orderby: { $key: '$e.value', $dir: 'desc' },
          $return: '$e.key',
        },
      },
    },
    $return: {
      patch: [
        { op: 'replace', path: '/council/merits', value: '$payload.merits' },
        { op: 'replace', path: '/council/leader', value: { $default: ['$leader', '$.council.leader'] } },
        {
          op: 'replace', path: '/council/log',
          value: [{
            $for: { a: '$.council.log[*]' },
            $return: {
              $if: [{ $eq: ['$a.id', '$payload.amendment'] },
                { '$from-entries': { $seq: [{ $entries: '$a' }, { key: 'reward', value: '$payload.reward' }] } },
                '$a'],
            },
          }],
        },
      ],
    },
  },
  'council/repealed': {
    $let: { seq: { $add: ['$.os.seq', 1] } },
    $return: {
      patch: [
        { op: 'replace', path: '/program', value: '$payload.program' },
        {
          op: 'replace', path: '/council/log',
          value: [{
            $for: { a: '$.council.log[*]' },
            $return: {
              $if: [{ $eq: ['$a.id', '$payload.amendment'] },
                { '$from-entries': { $seq: [{ $entries: '$a' }, { key: 'status', value: 'repealed' }] } },
                '$a'],
            },
          }],
        },
        { op: 'replace', path: '/os/seq', value: '$seq' },
        { op: 'replace', path: '/events', value: event('repeal', 'human') },
      ],
    },
  },

  // ── the chrome ─────────────────────────────────────────────────────
  // opening an app that shows something rendered asks for it once
  'os/app': {
    patch: [
      { op: 'replace', path: '/os/app', value: '$payload' },
      { op: 'add', path: { $concat: ['/coach/marks/open_', '$payload'] }, value: { $add: [{ $default: [{ $get: ['$.coach.marks', { $concat: ['open_', '$payload'] }] }, 0] }, 1] } },
    ],
    effects: [
      { $if: [{ $and: [{ $eq: ['$payload', 'exports'] }, { $eq: ['$.exports.status', 'idle'] }] },
        { run: 'redispatch', with: { action: 'exports/format', payload: '$.exports.format' } }] },
      { $if: [{ $eq: ['$payload', 'gallery'] }, { run: 'redispatch', with: { action: 'gallery/refresh' } }] },
      { $if: [{ $and: [{ $eq: ['$payload', 'library'] }, { $eq: ['$.library.status', 'idle'] }] }, { run: 'library-load' }] },
      { run: 'sound', with: 'open' },
    ],
  },
  // the theme button walks the three art directions: paper, the subway, neon
  'os/theme': {
    $let: {
      next: { $if: [{ $eq: ['$.os.theme', 'light'] }, 'dark', { $if: [{ $eq: ['$.os.theme', 'dark'] }, 'neon', 'light'] }] },
      art: { $if: [{ $eq: ['$.os.theme', 'light'] }, 'chalk', { $if: [{ $eq: ['$.os.theme', 'dark'] }, 'neon', 'pop'] }] },
    },
    $return: {
      patch: [{ op: 'replace', path: '/os/theme', value: '$next' }, { op: 'replace', path: '/settings/art', value: '$art' }],
      effects: [{ run: 'prefs', with: { theme: '$next', reduce: '$.os.reduce' } }],
    },
  },
  'os/motion': {
    $let: { next: { $not: '$.os.reduce' } },
    $return: {
      patch: [{ op: 'replace', path: '/os/reduce', value: '$next' }],
      effects: [{ run: 'prefs', with: { theme: '$.os.theme', reduce: '$next' } }],
    },
  },
  'os/notice': { patch: [{ op: 'replace', path: '/os/notice', value: '$payload' }] },
  'os/dismiss': { patch: [{ op: 'replace', path: '/os/notice', value: null }] },
  'os/storage': { patch: [{ op: 'replace', path: '/os/storage', value: '$payload' }] },
  'os/online': { patch: [{ op: 'replace', path: '/os/online', value: { $boolean: '$payload' } }] },
  'os/oracle': { patch: [{ op: 'add', path: '/os/oracle', value: '$payload' }] },
  'stage/pick': {
    patch: [
      { op: 'replace', path: '/os/focus', value: { $if: [{ $eq: ['$payload.kind', 'cell'] }, null, '$payload.id'] } },
      { $if: [{ $eq: ['$payload.kind', 'sign'] }, { op: 'replace', path: '/os/app', value: 'council' }] },
    ],
  },
  'stage/unfocus': { patch: [{ op: 'replace', path: '/os/focus', value: null }] },

  // ── exports, gallery, source ───────────────────────────────────────
  'exports/format': {
    patch: [
      { op: 'replace', path: '/exports/format', value: '$payload' },
      { op: 'replace', path: '/exports/status', value: 'loading' },
    ],
    effects: [call('art.export', { format: '$payload' }, 'exports/rendered', 'exports/failed')],
  },
  // a render lands only for the format still asked for: a quick second
  // click must not be overwritten by the first one's late answer
  'exports/rendered': {
    $if: [{ $eq: ['$payload.input.format', '$.exports.format'] }, {
      patch: [
        { op: 'replace', path: '/exports/text', value: '$payload.value.text' },
        { op: 'replace', path: '/exports/name', value: '$payload.value.name' },
        { op: 'replace', path: '/exports/mime', value: '$payload.value.mime' },
        { op: 'replace', path: '/exports/status', value: 'done' },
      ],
    }],
  },
  'exports/failed': {
    patch: [
      { op: 'replace', path: '/exports/status', value: 'error' },
      { op: 'replace', path: '/os/notice', value: { tone: 'warn', text: { $concat: ['Export failed: ', '$payload.message'] } } },
    ],
  },
  'exports/download': {
    $if: [{ $eq: ['$.exports.status', 'done'] }, {
      effects: [{ run: 'download', with: { name: '$.exports.name', mime: '$.exports.mime', text: '$.exports.text' } }],
    }],
  },
  'gallery/title': { patch: [{ op: 'replace', path: '/gallery/title', value: '$event.value' }] },
  'gallery/save': {
    patch: [{ op: 'replace', path: '/gallery/status', value: 'saving' }],
    effects: [call('gallery.save', {
      title: {
        $if: [{ $gt: [{ '$string-length': { '$normalize-space': '$.gallery.title' } }, 0] },
          { $substring: [{ '$normalize-space': '$.gallery.title' }, 0, 60] },
          { $concat: ['Tick ', '$.world.tick'] }],
      },
    }, 'gallery/kept', 'gallery/unkept')],
  },
  'gallery/kept': {
    patch: [
      { op: 'replace', path: '/gallery/status', value: 'idle' },
      { op: 'replace', path: '/gallery/title', value: '' },
    ],
  },
  'gallery/unkept': {
    patch: [
      { op: 'replace', path: '/gallery/status', value: 'idle' },
      { op: 'replace', path: '/os/notice', value: { tone: 'warn', text: { $concat: ['Could not keep the artwork: ', '$payload.message'] } } },
    ],
  },
  'gallery/refresh': {
    patch: [{ op: 'replace', path: '/gallery/status', value: 'loading' }],
    effects: [call('gallery.list', undefined, 'gallery/listed', 'gallery/unavailable')],
  },
  'gallery/listed': {
    patch: [
      { op: 'replace', path: '/gallery/items', value: '$payload.value.items' },
      { op: 'replace', path: '/gallery/status', value: 'idle' },
    ],
  },
  'gallery/unavailable': { patch: [{ op: 'replace', path: '/gallery/status', value: 'unavailable' }] },
  'gallery/open': { effects: [invoke('gallery.open', { id: '$payload' })] },
  'gallery/saved': { patch: [{ op: 'replace', path: '/gallery/items', value: prepend('$payload', '$.gallery.items', 48) }] },
  'gallery/opened': {
    $let: { seq: { $add: ['$.os.seq', 1] } },
    $return: {
      patch: [
        { op: 'replace', path: '/world', value: '$payload.world' },
        { op: 'replace', path: '/program/machine', value: '$payload.program.machine' },
        { op: 'replace', path: '/program/tempo', value: '$payload.program.tempo' },
        { op: 'replace', path: '/os/seq', value: '$seq' },
        { op: 'replace', path: '/events', value: event('boot') },
        { op: 'replace', path: '/os/notice', value: { tone: 'ok', text: { $concat: ['Back on the floor: ', '$payload.title'] } } },
      ],
    },
  },
  'source/doc': { patch: [{ op: 'replace', path: '/source/doc', value: '$payload' }] },
};
