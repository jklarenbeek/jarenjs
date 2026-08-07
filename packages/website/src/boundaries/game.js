//@ts-check
/**
 * "The Unbearable Lightness of Being a Pirate" — the game's JS boundary.
 * The site page stays a stylesheet; JavaScript lives only here, at the
 * derivation (the page view model) and the resolver/AI effects.
 *
 * Scene navigation is the @jarenjs/flow engine: `sceneApp()` bakes the
 * location-graph FSM into pure app actions (scene/go-<room>). The verb
 * resolver is a small effect that reads state.game and dispatches narration
 * + inventory patches — no game rule is hand-wired into the view. When the
 * player brings an OpenRouter key, the same NPCs answer live through
 * @jarenjs/ai, in the exact voice the content declares.
 */
import { createChatClient, createStructuredOutput } from '@jarenjs/ai';
import { createFormActions } from '@jarenjs/app';
import { buildFormModel, buildFormViewModel } from '@jarenjs/forms';
import { compileMessageCatalog } from '@jarenjs/validate';
import { nl, de, fr, es } from '@jarenjs/locales';
import { stringifyCsv } from '@jarenjs/josl/csv';
import { stringifyJsonx, parseJsonx } from '@jarenjs/josl/jsonx';
import { sceneApp } from '../content/gameFsms.js';
import {
  TITLE, GOAL, VERBS,
  LOCATIONS, CHARACTERS, ITEMS, SCENERY, PUZZLES, DIALOGUE, DUEL, INSULTS, GAGS,
} from '../content/gameContent.js';

const POISE_MAX = 3;

// The "name your pirate" form (@jarenjs/forms) with localized validation
// (@jarenjs/locales). Custom action names so it never collides with another
// surface's generated-form actions (the flowstudio inspector does the same).
const NAME_MODEL = buildFormModel({
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 3, maxLength: 24, title: 'Pirate name', description: 'A true pirate name is 3–24 characters.' },
  },
  required: ['name'],
});
export const NAME_FORM_ACTIONS = {
  input: 'game/f-input', check: 'game/f-check', number: 'game/f-number',
  json: 'game/f-json', add: 'game/f-add', remove: 'game/f-remove',
};
export const GAME_LOCALES = [
  { id: 'en', label: 'EN' }, { id: 'nl', label: 'NL' },
  { id: 'de', label: 'DE' }, { id: 'fr', label: 'FR' }, { id: 'es', label: 'ES' },
];
// compiled forms catalogs per locale; 'en' uses the built-in default (undefined)
const CATALOGS = { nl: compileMessageCatalog(nl), de: compileMessageCatalog(de), fr: compileMessageCatalog(fr), es: compileMessageCatalog(es) };

const scene = sceneApp();   // { slice: { current }, actions: { 'scene/go-*' } }

/** Everything present in a room right now (items not yet taken, scenery, npcs). */
function roomThings(room, inv) {
  const items = Object.values(ITEMS).filter((i) => i.at === room && !inv.includes(i.id));
  const scenery = Object.values(SCENERY).filter((s) => s.at === room);
  const npcs = Object.values(CHARACTERS).filter((c) => c.at === room);
  return { items, scenery, npcs };
}

/** Look up any addressable thing by id (room item, held item, scenery, npc). */
function thing(id) {
  return ITEMS[id] ?? SCENERY[id] ?? CHARACTERS[id] ?? null;
}

// ------------------------------------------------------------------
// Actions (pure JSON) — scene navigation + the game's own verbs
// ------------------------------------------------------------------
export const GAME_ACTIONS = {
  ...scene.actions,

  'game/start': {
    patch: [
      { op: 'replace', path: '/game/started', value: true },
      { op: 'add', path: '/game/log/-', value: { kind: 'sys', text: "A rival CULINARY pirate fleet docks at dawn. Assemble the World's Most Delicious Sea-Sandwich before they do. The gulls are already judging you." } },
    ],
  },
  // the "name your pirate" form writes through custom-namespaced form actions
  // (dataPointer /game/nameForm) so it never clashes with another surface's
  ...createFormActions({ dataPointer: '/game/nameForm', actions: NAME_FORM_ACTIONS }),
  'game/locale': { patch: [{ op: 'replace', path: '/game/locale', value: '$payload' }] },
  'game/verb': { patch: [{ op: 'replace', path: '/game/verb', value: '$payload' }] },
  'game/held': {
    patch: [{ op: 'replace', path: '/game/held',
      value: { $if: [{ $eq: ['$.game.held', '$payload'] }, null, '$payload'] } }],
  },
  // navigation goes through the flow engine: this triggers the fsmToApp
  // scene/go-<room> action (guarded by the current room), so a bad exit is
  // simply a no-op — the scene graph enforces "no dead ends".
  'game/go': { effects: [{ run: 'game-move', with: { to: '$payload' } }] },
  // arm/combine an inventory item
  'game/inv': { effects: [{ run: 'game-inv', with: { id: '$payload' } }] },
  // click a hotspot (or an inventory item with a verb armed) → resolve
  'game/hotspot': { effects: [{ run: 'game-interact', with: { target: '$payload' } }] },
  // narration + world mutations the resolver dispatches
  'game/say': { patch: [{ op: 'add', path: '/game/log/-', value: '$payload' }] },
  'game/give': { patch: [{ op: 'add', path: '/game/inv/-', value: '$payload' }] },
  'game/consume': {
    patch: [{ op: 'replace', path: '/game/inv',
      value: [{ $for: { x: '$.game.inv[*]' }, $where: { $ne: ['$x', '$payload'] }, $return: '$x' }] }],
  },
  'game/flag': { patch: [{ op: 'add', path: { $concat: ['/game/flags/', '$payload'] }, value: true } ] },
  'game/clear-held': { patch: [{ op: 'replace', path: '/game/held', value: null }] },
  'game/won': {
    patch: [
      { op: 'replace', path: '/game/won', value: true },
      { op: 'add', path: '/game/log/-', value: '$payload' },
    ],
  },

  // dialogue
  'game/talk': { effects: [{ run: 'game-talk', with: { who: '$payload' } }] },
  'game/dialogue': { patch: [{ op: 'replace', path: '/game/dialogue', value: '$payload' }] },
  'game/say-pick': { effects: [{ run: 'game-dialogue-pick', with: { index: '$payload' } }] },
  'game/dialogue-close': { patch: [{ op: 'replace', path: '/game/dialogue', value: null }] },

  // the insult sword-fight (poise, not health — you never lose, only learn)
  'game/duel-start': { effects: [{ run: 'game-duel-start' }] },
  'game/duel': { patch: [{ op: 'replace', path: '/game/duel', value: '$payload' }] },
  'game/duel-say': { effects: [{ run: 'game-duel-say', with: { index: '$payload' } }] },
  'game/duel-learn': { effects: [{ run: 'game-duel-learn' }] },
  'game/duel-flee': {
    patch: [
      { op: 'replace', path: '/game/duel', value: null },
      { op: 'add', path: '/game/log/-', value: { kind: 'sys', text: 'You step back from the duel. Finch strikes a pose at the empty air. (You can return whenever your wit recovers.)' } },
    ],
  },

  // the "admiralty forms in triplicate" running gag → exports to CSV
  'game/form': { patch: [{ op: 'add', path: '/game/forms/-', value: '$payload' }] },
  'game/export-forms': { effects: [{ run: 'game-export-forms' }] },

  // save / load the whole run (serialized with JSONX to localStorage)
  'game/save': { effects: [{ run: 'game-save' }] },
  'game/load': { effects: [{ run: 'game-load' }] },
  'game/restore': { patch: [{ op: 'replace', path: '/game', value: '$payload' }] },

  // the dynamic (keyed) tier: ask an NPC anything in free text
  'game/ask-draft': { patch: [{ op: 'replace', path: '/game/ask', value: '$event.value' }] },
  'game/ask-send': { effects: [{ run: 'game-ai-say' }] },
  'game/ai-reply': {
    patch: [
      { op: 'add', path: '/game/log/-', value: '$payload' },
      { op: 'replace', path: '/game/ask', value: '' },
      { op: 'replace', path: '/game/thinking', value: false },
    ],
  },
  'game/ai-thinking': { patch: [{ op: 'replace', path: '/game/thinking', value: '$payload' }] },
};

// ------------------------------------------------------------------
// The page view model (state.game → $.ui.game)
// ------------------------------------------------------------------
export function gamePageViewModel(game) {
  const room = LOCATIONS[game.room.current];
  const { items, scenery, npcs } = roomThings(game.room.current, game.inv);
  const dlg = game.dialogue;
  const npc = dlg ? CHARACTERS[dlg.who] : null;
  const node = dlg ? DIALOGUE[dlg.who]?.nodes[dlg.node] : null;
  return {
    title: TITLE,
    goal: GOAL,
    started: game.started,
    pirate: game.nameForm.name,
    // the @jarenjs/forms name field, its validation localized (@jarenjs/locales)
    nameForm: buildFormViewModel(NAME_MODEL, game.nameForm, { validateFields: true, catalog: CATALOGS[game.locale] }),
    locales: GAME_LOCALES.map((l) => ({ ...l, active: l.id === game.locale })),
    won: game.won,
    verb: game.verb,
    held: game.held,
    heldName: game.held ? (ITEMS[game.held]?.name ?? game.held) : null,
    verbs: VERBS.map((v) => ({ ...v, active: v.id === game.verb })),
    room: {
      id: room.id, name: room.name, icon: room.icon, look: room.look,
      exits: room.exits.map((id) => ({ id, name: LOCATIONS[id].name, event: `scene/go-${id}` })),
      items: items.map((i) => ({ id: i.id, name: i.name })),
      scenery: scenery.map((s) => ({ id: s.id, name: s.name })),
      npcs: npcs.map((c) => ({ id: c.id, name: c.name })),
    },
    inv: game.inv.map((id) => ({ id, name: ITEMS[id]?.name ?? id, held: game.held === id })),
    forms: game.forms.length,
    log: game.log,
    dialogue: dlg && node ? {
      who: npc.name,
      text: node.text,
      options: (node.options ?? []).map((o, i) => ({ index: i, text: o.text })),
    } : null,
    duel: game.duel ? {
      who: CHARACTERS[DUEL.who].name,
      insult: INSULTS[game.duel.insult].insult,
      poiseText: '◆'.repeat(game.duel.poise) + '◇'.repeat(POISE_MAX - game.duel.poise),
      landed: game.duel.landed, win: DUEL.win,
      known: game.duel.known.map((i) => ({ index: i, text: INSULTS[i].comeback })),
      canLearn: !game.duel.known.includes(game.duel.insult),
      // the poise/score gauge as a @jarenjs/charts bar
      chart: {
        type: 'bar', title: 'The duel', valLabel: '',
        categories: ['Poise', 'Landed'],
        series: [{ name: '', values: [game.duel.poise, game.duel.landed] }],
      },
    } : null,
    ask: game.ask ?? '',
    thinking: game.thinking ?? false,
    // the map is a mermaid projection of the scene graph, built in the runtime
    mapSource: sceneMermaid(game.room.current),
  };
}

/** The in-game map: the scene graph as a mermaid flowchart, current room
 * marked with a pin in its label (parser-safe — no classDef). */
function sceneMermaid(current) {
  const label = (id) => (id === current ? `📍 ${LOCATIONS[id].name}` : LOCATIONS[id].name);
  const lines = ['flowchart LR'];
  const seen = new Set();
  for (const from of Object.keys(LOCATIONS)) {
    for (const to of LOCATIONS[from].exits) {
      const key = [from, to].sort().join('~');
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`  ${from}[${label(from)}] --- ${to}[${label(to)}]`);
    }
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------
// The runtime: the verb resolver + dialogue + the AI (keyed) effects
// ------------------------------------------------------------------
/** @param {{ getApp: () => any, aiFetch?: typeof fetch, isConfigured?: (s:any)=>boolean,
 *   download?: (name: string, text: string) => void,
 *   saveSlot?: { read: () => string|null, write: (s: string) => void } }} env */
export function createGameRuntime(env) {
  const say = (dispatch, text, kind = 'narrate') => dispatch('game/say', { kind, text });

  const effects = {
    // navigation: dispatch the flow engine's generated scene action. A move
    // with no exit from here fails the FSM guard and changes nothing.
    'game-move': (props, dispatch) => {
      // dispatches from an effect are QUEUED (applied after this returns), so
      // decide validity from the content graph, not post-dispatch state.
      const g = env.getApp().getState().game;
      if (!LOCATIONS[g.room.current]?.exits.includes(props.to)) return;   // no exit → no-op
      dispatch(`scene/go-${props.to}`);   // the flow engine performs the move
      dispatch('game/dialogue-close');
      // running gags fire once, on first arrival (flags are still pre-move here)
      if (props.to === 'market' && !g.flags.gag_reginald) { dispatch('game/flag', 'gag_reginald'); say(dispatch, GAGS.reginald, 'sys'); }
      if (props.to === 'galleon' && !g.flags.gag_fourthwall) { dispatch('game/flag', 'gag_fourthwall'); say(dispatch, GAGS.fourthWall, 'sys'); }
    },

    // export the collected admiralty forms as a CSV download (@jarenjs/josl)
    'game-export-forms': (_props, dispatch) => {
      const forms = env.getApp().getState().game.forms;
      if (!forms.length) { say(dispatch, 'You have no forms to file. The admiralty is, briefly, at peace.', 'sys'); return; }
      const rows = forms.map((f, i) => ({ 'Form No.': `${i + 1}/${i + 1}/${i + 1}`, 'Item surrendered': f.item, Recipient: f.to, Status: 'FILED IN TRIPLICATE' }));
      env.download?.('admiralty-forms.csv', stringifyCsv(rows));
      say(dispatch, `You file ${forms.length} form(s) with the admiralty. A gull carries the CSV away, unimpressed.`, 'sys');
    },

    // save / load the run, serialized with JSONX (@jarenjs/josl)
    'game-save': (_props, dispatch) => {
      try { env.saveSlot?.write(stringifyJsonx(env.getApp().getState().game)); say(dispatch, '💾 Voyage saved.', 'sys'); }
      catch { say(dispatch, 'The parrot ate the save file. Try again.', 'sys'); }
    },
    'game-load': (_props, dispatch) => {
      const raw = env.saveSlot?.read();
      if (!raw) { say(dispatch, 'No saved voyage found.', 'sys'); return; }
      try { dispatch('game/restore', parseJsonx(raw)); say(dispatch, '📂 Voyage restored.', 'sys'); }
      catch { say(dispatch, 'The save file is written in a dialect of Gull. Unreadable.', 'sys'); }
    },

    // resolve the armed verb against a clicked target
    'game-interact': (props, dispatch) => {
      const g = env.getApp().getState().game;
      const id = props.target;
      const t = thing(id);
      if (t === null) return;
      const verb = g.verb;

      if (verb === 'look') { say(dispatch, `${cap(t.name)}: ${t.examine ?? t.look ?? 'Nothing remarkable.'}`); return; }

      if (verb === 'talk') {
        if (CHARACTERS[id]) dispatch('game/talk', id);
        else say(dispatch, `You try talking to the ${t.name}. It does not talk back. This is a relief.`);
        return;
      }

      if (verb === 'take') {
        if (ITEMS[id] && ITEMS[id].at === g.room.current && ITEMS[id].portable && !g.inv.includes(id)) {
          dispatch('game/give', id);
          say(dispatch, `You pocket the ${t.name}. It fits, morally and spatially.`);
        } else if (CHARACTERS[id]) say(dispatch, `${cap(t.name)} declines to be pocketed.`);
        else say(dispatch, `You can't take the ${t.name}.`);
        return;
      }

      if (verb === 'use') {
        const held = g.held;
        if (!held) { say(dispatch, `Use the ${t.name} with WHAT? Arm an inventory item first (click it).`); return; }
        resolveUse(dispatch, g, held, id);
        return;
      }

      if (verb === 'give') {
        const held = g.held;
        if (!held) { say(dispatch, 'Give WHICH item? Arm one from your inventory first.'); return; }
        if (!CHARACTERS[id]) { say(dispatch, `The ${t.name} has no hands, no needs, and no interest.`); return; }
        resolveGive(dispatch, g, held, id);
        return;
      }
    },

    // arm/combine from the inventory: click one to arm, click another to combine
    'game-inv': (props, dispatch) => {
      const g = env.getApp().getState().game;
      const id = props.id;
      if (!g.held || g.held === id) { dispatch('game/held', id); return; }
      // both are inventory items → try a combine
      resolveUse(dispatch, g, g.held, id);
    },

    // open a dialogue tree at its root — but Finch demands a duel first
    'game-talk': (props, dispatch) => {
      if (props.who === DUEL.who) {
        const g = env.getApp().getState().game;
        if (!g.flags.solved_duel) { dispatch('game/duel-start'); return; }
        say(dispatch, `${CHARACTERS[DUEL.who].name} bows, only slightly theatrically. "Sharpest wit on the rock. The switch is yours, friend."`, 'npc');
        return;
      }
      const tree = DIALOGUE[props.who];
      if (!tree) { say(dispatch, `${cap(CHARACTERS[props.who]?.name ?? 'They')} has nothing to say (yet — bring a key and they will).`); return; }
      dispatch('game/dialogue', { who: props.who, node: tree.root });
    },

    // ---- the insult sword-fight ----
    'game-duel-start': (_props, dispatch) => {
      say(dispatch, DUEL.intro, 'npc');
      dispatch('game/duel', { poise: POISE_MAX, landed: 0, insult: 0, known: [] });
      say(dispatch, `${CHARACTERS[DUEL.who].name}: "${INSULTS[0].insult}"`, 'npc');
    },
    // answer with a known comeback: matching index lands it, else costs poise
    'game-duel-say': (props, dispatch) => {
      const d = env.getApp().getState().game.duel;
      if (!d || !d.known.includes(props.index)) return;
      if (props.index === d.insult) {
        const landed = d.landed + 1;
        say(dispatch, `You riposte: "${INSULTS[props.index].comeback}" — Finch reels!`, 'win');
        if (landed >= DUEL.win) {
          dispatch('game/duel', null);
          dispatch('game/flag', 'solved_duel');
          say(dispatch, DUEL.victory, 'win');
          return;
        }
        throwNext(dispatch, { poise: d.poise, landed, known: d.known }, d.insult);
      } else {
        let poise = d.poise - 1;
        say(dispatch, 'Finch: "That made no sense at all." Your poise wavers.');
        if (poise <= 0) { poise = 1; say(dispatch, 'You breathe, reset your stance, and refuse to lose. (You can only learn here — never die.)', 'sys'); }
        dispatch('game/duel', { ...d, poise });
      }
    },
    // take the hit to learn the current comeback, then face the next insult
    'game-duel-learn': (_props, dispatch) => {
      const d = env.getApp().getState().game.duel;
      if (!d) return;
      if (d.known.includes(d.insult)) { say(dispatch, 'You already have a retort for that one — use it!'); return; }
      say(dispatch, `Finch lands the jibe — but you file away the perfect retort: "${INSULTS[d.insult].comeback}"`, 'sys');
      const poise = Math.max(1, d.poise - 1);
      throwNext(dispatch, { poise, landed: d.landed, known: [...d.known, d.insult] }, d.insult);
    },

    // the dynamic tier: an NPC answers free text live, in-character
    // pick a dialogue option: apply its flag, advance or close
    'game-dialogue-pick': (props, dispatch) => {
      const g = env.getApp().getState().game;
      const dlg = g.dialogue; if (!dlg) return;
      const node = DIALOGUE[dlg.who].nodes[dlg.node];
      const opt = node.options[props.index]; if (!opt) return;
      if (opt.give) dispatch('game/flag', opt.give);
      if (opt.to === null || opt.to === undefined) { dispatch('game/dialogue-close'); return; }
      const next = DIALOGUE[dlg.who].nodes[opt.to];
      if (next?.give) dispatch('game/flag', next.give);
      dispatch('game/dialogue', { who: dlg.who, node: opt.to });
    },

    // the dynamic tier: an NPC answers free text live, in-character
    'game-ai-say': (props, dispatch) => {
      const state = env.getApp().getState();
      const g = state.game;
      const s = state.ai.settings;
      const who = g.dialogue?.who;
      const npc = who ? CHARACTERS[who] : null;
      if (!npc) return;
      const question = (g.ask ?? '').trim();
      if (!question) return;
      if (!env.isConfigured?.(s)) {
        say(dispatch, `(${npc.name} would answer live if you added an AI key in the assistant settings — top-right robot.)`, 'sys');
        return;
      }
      dispatch('game/ai-thinking', true);
      const client = createChatClient({
        provider: s.provider, baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model,
        fetch: env.aiFetch,
        headers: { 'HTTP-Referer': 'https://jklarenbeek.github.io/jarenjs/', 'X-Title': 'Jaren adventure' },
      });
      const out = createStructuredOutput({
        client, name: 'npc_line', maxRepairs: 1,
        schema: { type: 'object', required: ['line'], properties: { line: { type: 'string' }, mood: { type: 'string' } } },
      });
      const sys = `You are ${npc.name}, a character in a comedy pirate adventure. VOICE (stay in it, always): ${npc.voice}. The player's goal: ${GOAL}. Keep replies to 1-2 sentences, in-character, funny, never breaking the game. Reply as JSON {"line": "...", "mood": "..."}.`;
      out.generate([{ role: 'system', content: sys }, { role: 'user', content: question }])
        .then((r) => {
          const line = r.value?.line ?? "(...they lost their train of thought. Very in-character.)";
          dispatch('game/ai-reply', { kind: 'npc', who: npc.name, text: `${npc.name}: ${line}` });
        })
        .catch((err) => dispatch('game/ai-reply', { kind: 'sys', text: `(${npc.name} is briefly speechless: ${String(err.message ?? err).slice(0, 80)})` }));
    },
  };

  /** advance the duel to the next insult and announce it. */
  function throwNext(dispatch, base, from) {
    const next = (from + 1) % INSULTS.length;
    dispatch('game/duel', { ...base, insult: next });
    say(dispatch, `${CHARACTERS[DUEL.who].name}: "${INSULTS[next].insult}"`, 'npc');
  }

  /** use held item on target: combine, or solve a puzzle, else a funny miss. */
  function resolveUse(dispatch, g, held, targetId) {
    const combined = ITEMS[held]?.combine?.[targetId];
    if (combined) {
      dispatch('game/consume', held);
      if (ITEMS[targetId] && g.inv.includes(targetId)) dispatch('game/consume', targetId);
      dispatch('game/give', combined);
      dispatch('game/clear-held');
      say(dispatch, `You combine the ${ITEMS[held].name} with the ${thing(targetId).name}. Now you have ${ITEMS[combined].name}.`);
      return;
    }
    const puz = Object.values(PUZZLES).find((p) => p.solve.verb === 'use' && p.solve.item === held && p.solve.target === targetId && !g.flags[`solved_${p.id}`]);
    if (puz) {
      dispatch('game/flag', `solved_${puz.id}`);
      if (puz.reward && ITEMS[puz.reward]) dispatch('game/give', puz.reward);
      dispatch('game/clear-held');
      say(dispatch, puz.done, 'win');
      return;
    }
    say(dispatch, `You wave the ${ITEMS[held]?.name ?? held} at the ${thing(targetId)?.name ?? targetId}. Nothing happens, but you feel briefly powerful.`);
  }

  /** give held item to an NPC: solve a give-puzzle, else a polite refusal. */
  function resolveGive(dispatch, g, held, npcId) {
    const puz = Object.values(PUZZLES).find((p) => p.solve.verb === 'give' && p.solve.item === held && p.solve.target === npcId && !g.flags[`solved_${p.id}`]);
    if (puz) {
      dispatch('game/consume', held);
      dispatch('game/flag', `solved_${puz.id}`);
      if (puz.reward && ITEMS[puz.reward]) dispatch('game/give', puz.reward);
      dispatch('game/clear-held');
      say(dispatch, puz.done, 'win');
      if (puz.reward === 'recipe') dispatch('game/won', { kind: 'win', text: `🏆 You hold the legendary recipe. Both crews gather, share the World's Most Delicious Sea-Sandwich, and declare a culinary truce. THE END — and a lovely one at that.` });
      return;
    }
    // the running gag: never consume the item (no soft-lock) — it comes back
    // with a form for the admiralty records
    say(dispatch, `${cap(CHARACTERS[npcId].name)} accepts the ${ITEMS[held].name}, sighs, stamps a clipboard, hands it straight back, and issues you an admiralty form in triplicate. "For the records."`);
    dispatch('game/form', { item: ITEMS[held].name, to: CHARACTERS[npcId].name });
    dispatch('game/clear-held');
  }

  return { effects };
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
