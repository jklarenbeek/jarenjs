//@ts-check
/**
 * The crew's building blocks, and the compiler that turns a list of them
 * into a real `@jarenjs/app` document — state, a JSLT view stylesheet and
 * action documents, nothing executable. That is what makes it safe for a
 * language model to build software inside the OS: whatever blocks it
 * asks for, the result is data the contract validated and the app
 * runtime interprets, never code it runs.
 *
 * A block is small on purpose (a title, a note, a counter, a checklist,
 * an input with a list, a toggle, a quiz, a palette): one block is one
 * tool call a weak model can always make, and an app grows a block per
 * turn of the crew game.
 *
 * `planBlocks` is the scripted crew's planner — the deterministic stand-in
 * for a language model, which reads an idea in plain words and picks the
 * block that answers it — so the crew game plays offline too.
 */

/**
 * @typedef {{ kind: 'title', text: string }
 *   | { kind: 'note', text: string }
 *   | { kind: 'counter', label: string, step?: number, start?: number }
 *   | { kind: 'checklist', label: string, items: string[] }
 *   | { kind: 'input', label: string, placeholder?: string }
 *   | { kind: 'toggle', label: string, on?: boolean }
 *   | { kind: 'quiz', question: string, options: string[], answer: number }
 *   | { kind: 'palette', label: string, colors: number[] }} Block
 */

/** Every block kind, in the order the catalogue lists them. */
export const BLOCK_KINDS = Object.freeze(['title', 'note', 'counter', 'checklist', 'input', 'toggle', 'quiz', 'palette']);

/** The inks a palette block may offer: the tape's five brights and the human's orange. */
export const BLOCK_INKS = Object.freeze(['#2563eb', '#fbbf24', '#ef4444', '#16a34a', '#06b6d4', '#f97316']);

/** What each kind is for, in words a person — or a model — picks from. */
export const BLOCK_CATALOG = Object.freeze([
  { kind: 'title', use: 'a heading that names the app', shape: '{ kind: "title", text }' },
  { kind: 'note', use: 'a paragraph of explanation', shape: '{ kind: "note", text }' },
  { kind: 'counter', use: 'a number to count up and down', shape: '{ kind: "counter", label, step?, start? }' },
  { kind: 'checklist', use: 'items to tick off', shape: '{ kind: "checklist", label, items: [text…] }' },
  { kind: 'input', use: 'a field that adds what you type to a list', shape: '{ kind: "input", label, placeholder? }' },
  { kind: 'toggle', use: 'an on/off switch', shape: '{ kind: "toggle", label, on? }' },
  { kind: 'quiz', use: 'a question with answers to choose from', shape: '{ kind: "quiz", question, options: [2–4], answer: index }' },
  { kind: 'palette', use: 'colours to choose the app’s accent from', shape: '{ kind: "palette", label, colors: [ink index 0–5…] }' },
]);

const text = (/** @type {unknown} */ v, /** @type {number} */ max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

/**
 * Whether a value is a block the compiler can build (the contract's
 * `Block` definition says the same, with messages; this is the check a
 * restored project or a scripted plan must pass).
 * @param {any} b @returns {b is Block}
 */
export function isBlock(b) {
  if (!b || typeof b !== 'object') return false;
  switch (b.kind) {
    case 'title': return text(b.text, 60);
    case 'note': return text(b.text, 400);
    case 'counter': return text(b.label, 40)
      && (b.step === undefined || (Number.isInteger(b.step) && b.step >= 1 && b.step <= 100))
      && (b.start === undefined || (Number.isInteger(b.start) && Math.abs(b.start) <= 1000));
    case 'checklist': return text(b.label, 40) && Array.isArray(b.items) && b.items.length >= 1 && b.items.length <= 12 && b.items.every((/** @type {unknown} */ i) => text(i, 60));
    case 'input': return text(b.label, 40) && (b.placeholder === undefined || (typeof b.placeholder === 'string' && b.placeholder.length <= 40));
    case 'toggle': return text(b.label, 40) && (b.on === undefined || typeof b.on === 'boolean');
    case 'quiz': return text(b.question, 120) && Array.isArray(b.options) && b.options.length >= 2 && b.options.length <= 4
      && b.options.every((/** @type {unknown} */ o) => text(o, 40)) && Number.isInteger(b.answer) && b.answer >= 0 && b.answer < b.options.length;
    case 'palette': return text(b.label, 40) && Array.isArray(b.colors) && b.colors.length >= 2 && b.colors.length <= 6
      && b.colors.every((/** @type {unknown} */ c) => Number.isInteger(c) && /** @type {number} */ (c) >= 0 && /** @type {number} */ (c) < BLOCK_INKS.length);
    default: return false;
  }
}

/**
 * One block in a sentence (the Mail log, the review list).
 * @param {Block} b @returns {string}
 */
export function describeBlock(b) {
  switch (b.kind) {
    case 'title': return `the title “${b.text}”`;
    case 'note': return `a note: “${b.text.length > 48 ? `${b.text.slice(0, 47)}…` : b.text}”`;
    case 'counter': return `a counter for ${b.label}`;
    case 'checklist': return `a checklist “${b.label}” with ${b.items.length} item${b.items.length === 1 ? '' : 's'}`;
    case 'input': return `a field that collects ${b.label}`;
    case 'toggle': return `a switch for ${b.label}`;
    case 'quiz': return `a quiz question: “${b.question}”`;
    case 'palette': return `a palette of ${b.colors.length} colours`;
  }
}

/** The JSON size of a block — what one build tool call carries. @param {Block} b */
export const blockChars = (b) => JSON.stringify(b).length;

/**
 * Compile blocks into an app document. Block `i` owns state member
 * `b<i>`, actions `b<i>/…` and, for lists, the JSLT mode `b<i>`, so no two
 * blocks can collide however many of a kind an app holds.
 * @param {readonly Block[]} blocks @param {{ title?: string }} [options]
 * @returns {{ $app: '0.1', state: Record<string, any>, view: any, actions: Record<string, any> }}
 */
export function buildApp(blocks, options = {}) {
  /** @type {Record<string, any>} */
  const state = {};
  /** @type {Record<string, any>} */
  const actions = {};
  /** @type {any[]} */
  const body = [];
  /** @type {any[]} */
  const rules = [];
  let accent = /** @type {any} */ (BLOCK_INKS[0]);
  blocks.forEach((block, i) => {
    const id = `b${i}`;
    const at = `$.${id}`;
    switch (block.kind) {
      case 'title':
        body.push(['h3', { class: 'mini-title' }, block.text]);
        break;
      case 'note':
        body.push(['p', { class: 'mini-note' }, block.text]);
        break;
      case 'counter': {
        const step = block.step ?? 1;
        state[id] = { count: block.start ?? 0 };
        actions[`${id}/up`] = { patch: [{ op: 'replace', path: `/${id}/count`, value: { $add: [`${at}.count`, step] } }] };
        actions[`${id}/down`] = { patch: [{ op: 'replace', path: `/${id}/count`, value: { $add: [`${at}.count`, -step] } }] };
        body.push(['div', { class: 'mini-counter' },
          ['span', { class: 'mini-label' }, block.label],
          ['button', { type: 'button', class: 'mini-btn', 'aria-label': `Less ${block.label}`, on: { click: `${id}/down` } }, '−'],
          ['output', { class: 'mini-count', 'aria-live': 'polite' }, `${at}.count`],
          ['button', { type: 'button', class: 'mini-btn', 'aria-label': `More ${block.label}`, on: { click: `${id}/up` } }, '+']]);
        break;
      }
      case 'checklist':
        state[id] = { done: block.items.map(() => false) };
        block.items.forEach((_, j) => {
          actions[`${id}/tick${j}`] = { patch: [{ op: 'replace', path: `/${id}/done/${j}`, value: { $not: `${at}.done[${j}]` } }] };
        });
        body.push(['fieldset', { class: 'mini-checklist' }, ['legend', {}, block.label],
          ...block.items.map((item, j) => ['label', { class: 'mini-check' },
            ['input', { type: 'checkbox', checked: { $if: [`${at}.done[${j}]`, true, null] }, on: { change: `${id}/tick${j}` } }],
            ['span', {}, item]])]);
        break;
      case 'input':
        state[id] = { draft: '', items: [] };
        actions[`${id}/draft`] = { patch: [{ op: 'replace', path: `/${id}/draft`, value: '$event.value' }] };
        actions[`${id}/add`] = {
          $if: [{ $gt: [{ '$string-length': { '$normalize-space': `${at}.draft` } }, 0] }, {
            patch: [
              { op: 'add', path: `/${id}/items/-`, value: { '$normalize-space': `${at}.draft` } },
              { op: 'replace', path: `/${id}/draft`, value: '' },
            ],
          }],
        };
        rules.push({ mode: id, match: `${at}.items[*]`, body: ['li', {}, '$'] });
        body.push(['form', { class: 'mini-input', on: { submit: { action: `${id}/add`, preventDefault: true } } },
          ['label', {}, ['span', { class: 'mini-label' }, block.label],
            ['input', { type: 'text', maxlength: 60, value: `${at}.draft`, placeholder: block.placeholder ?? '', on: { input: `${id}/draft` } }]],
          ['button', { type: 'submit', class: 'mini-btn' }, 'Add'],
          ['ul', { class: 'mini-list' }, [{ $apply: [`${at}.items[*]`, id] }]]]);
        break;
      case 'toggle':
        state[id] = { on: block.on ?? false };
        actions[`${id}/flip`] = { patch: [{ op: 'replace', path: `/${id}/on`, value: { $not: `${at}.on` } }] };
        body.push(['button', {
          type: 'button', class: 'mini-toggle', role: 'switch',
          'aria-checked': { $if: [`${at}.on`, 'true', 'false'] }, on: { click: `${id}/flip` },
        }, ['span', { class: 'mini-label' }, block.label], ' ', ['strong', {}, { $if: [`${at}.on`, 'on', 'off'] }]]);
        break;
      case 'quiz':
        state[id] = { picked: -1 };
        block.options.forEach((_, j) => {
          actions[`${id}/pick${j}`] = { patch: [{ op: 'replace', path: `/${id}/picked`, value: j }] };
        });
        body.push(['div', { class: 'mini-quiz' }, ['p', { class: 'mini-question' }, block.question],
          ...block.options.map((option, j) => ['button', {
            type: 'button', class: 'mini-btn', 'aria-pressed': { $if: [{ $eq: [`${at}.picked`, j] }, 'true', 'false'] },
            on: { click: `${id}/pick${j}` },
          }, option]),
          ['p', { class: 'mini-feedback', 'aria-live': 'polite' }, {
            $if: [{ $eq: [`${at}.picked`, -1] }, 'Pick an answer.',
              { $if: [{ $eq: [`${at}.picked`, block.answer] }, 'Right!', 'Not quite — try another.'] }],
          }]]);
        break;
      case 'palette': {
        state[id] = { pick: 0 };
        block.colors.forEach((_, j) => {
          actions[`${id}/pick${j}`] = { patch: [{ op: 'replace', path: `/${id}/pick`, value: j }] };
        });
        // the accent the app wears: the first palette block's pick
        let chosen = /** @type {any} */ (BLOCK_INKS[block.colors[0]]);
        for (let j = block.colors.length - 1; j >= 1; j--) chosen = { $if: [{ $eq: [`${at}.pick`, j] }, BLOCK_INKS[block.colors[j]], chosen] };
        if (accent === BLOCK_INKS[0]) accent = chosen;
        body.push(['div', { class: 'mini-palette', role: 'radiogroup', 'aria-label': block.label },
          ['span', { class: 'mini-label' }, block.label],
          ...block.colors.map((c, j) => ['button', {
            type: 'button', class: 'mini-swatch', role: 'radio', 'aria-label': `Colour ${j + 1}`,
            'aria-checked': { $if: [{ $eq: [`${at}.pick`, j] }, 'true', 'false'] },
            style: { background: BLOCK_INKS[c] }, on: { click: `${id}/pick${j}` },
          }])]);
        break;
      }
    }
  });
  if (body.length === 0) body.push(['p', { class: 'mini-note' }, 'Nothing built yet — the crew is waiting for ideas.']);
  return {
    $app: '0.1',
    state,
    view: {
      $jslt: '0.1',
      rules: [
        { match: '$', body: ['section', { class: 'mini', style: { '--mini-accent': accent }, 'aria-label': options.title ?? 'App' }, ...body] },
        ...rules,
      ],
    },
    actions,
  };
}

/** Words that point an idea at a block kind, strongest first. */
const CUES = /** @type {Array<[RegExp, Block['kind']]>} */ ([
  [/\b(quiz|question|guess|trivia|vraag)\b/i, 'quiz'],
  [/\b(count|counter|tally|score|how many|tel|teller)\b/i, 'counter'],
  [/\b(check ?list|todo|to-do|to do|tick|tasks?|lijst)\b/i, 'checklist'],
  [/\b(colou?rs?|palette|theme|kleur)\b/i, 'palette'],
  [/\b(switch|toggle|on\/off|dark mode|mode)\b/i, 'toggle'],
  [/\b(type|input|field|add|collect|names?|notes? list|invoer)\b/i, 'input'],
  [/\b(title|name it|call it|heading|titel)\b/i, 'title'],
]);

/**
 * The scripted crew's planner: one block that answers an idea written in
 * plain words. A quoted phrase becomes the label; a list after a colon
 * becomes items or options.
 * @param {string} idea
 * @returns {Block}
 */
export function planBlock(idea) {
  const words = idea.replace(/\s+/g, ' ').trim();
  const quoted = /[“"']([^“”"']{1,40})[”"']/.exec(words)?.[1]?.trim();
  const listed = words.includes(':')
    ? words.slice(words.indexOf(':') + 1).split(/,| and | en /).map((s) => s.trim()).filter((s) => s.length > 0).slice(0, 12)
    : [];
  const kind = CUES.find(([cue]) => cue.test(words))?.[1] ?? 'note';
  const label = clip(quoted ?? (words.split(':')[0].replace(/^(a|an|the|add|make|build|een|maak)\s+/i, '').replace(/\b(counter|checklist|quiz|switch|toggle|palette|field|for|to count)\b/gi, '').trim() || 'Things'), 40);
  switch (kind) {
    case 'quiz': {
      const options = (listed.length >= 2 ? listed : ['Yes', 'No']).slice(0, 4).map((o) => clip(o, 40));
      return { kind: 'quiz', question: clip(quoted ?? words.split(':')[0], 120), options, answer: 0 };
    }
    case 'counter': return { kind: 'counter', label, step: 1 };
    case 'checklist': return { kind: 'checklist', label, items: (listed.length > 0 ? listed : ['First thing', 'Next thing']).map((o) => clip(o, 60)) };
    case 'palette': return { kind: 'palette', label: 'Accent', colors: [0, 1, 2, 3] };
    case 'toggle': return { kind: 'toggle', label, on: false };
    case 'input': return { kind: 'input', label, placeholder: 'Type and press Add' };
    case 'title': return { kind: 'title', text: clip(quoted ?? label, 60) };
    default: return { kind: 'note', text: clip(words, 400) };
  }
}

/** @param {string} s @param {number} max */
function clip(s, max) {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}
