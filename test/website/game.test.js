//@ts-check
/**
 * The adventure game (#/game) as node tests: boot the real site app headlessly
 * over the stub DOM and drive it through actions — the same surface the browser
 * uses. Proves navigation runs on the flow engine, the puzzle chain is winnable
 * (no soft-lock), dialogue advances, and the dynamic tier degrades gracefully
 * without a key. Mirrors the browser e2e (packages/website/e2e/game-smoke.spec.js).
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { renderToString } from '@jarenjs/view';
import { createSiteApp } from '../../packages/website/src/app/createSiteApp.js';
import { parseHash } from '../../packages/website/src/lib/route.js';
import { createGameRuntime } from '../../packages/website/src/boundaries/game.js';
import { createStubHost } from '../view/dom.stub.js';

/** A headless site parked on #/game. */
function mountGame() {
  const { document, container } = createStubHost();
  const app = createSiteApp({
    node: container,
    document,
    schedule: (f) => f(),
    debounceMs: 0,
    fetchJson: () => Promise.reject(new Error('404')),
    applyTheme: () => {},
    listenHash: (cb) => cb(parseHash('#/game')),
    navigate: () => {},
    storage: { read: () => null, write: () => {} },
    onError: (err) => { throw err; },
  });
  return app;
}

describe('website — the adventure game', function () {
  it('renders the title card, then the opening scene', function () {
    const app = mountGame();
    assert.match(renderToString(app.getVnode()), /Name your pirate/);
    app.dispatch('game/start');
    assert.strictEqual(app.getState().game.started, true);
    assert.match(renderToString(app.getVnode()), /The Dock of Shame/);
  });

  it('point-and-click: look, take, and flow-engine navigation', function () {
    const app = mountGame();
    app.dispatch('game/start');
    // LOOK at the crate
    app.dispatch('game/verb', 'look');
    app.dispatch('game/hotspot', 'crate');
    assert.match(JSON.stringify(app.getState().game.log), /padlock/i);
    // TAKE the compass
    app.dispatch('game/verb', 'take');
    app.dispatch('game/hotspot', 'compass');
    assert.ok(app.getState().game.inv.includes('compass'));
    // NAVIGATE through the fsmToApp scene action
    app.dispatch('game/go', 'market');
    assert.strictEqual(app.getState().game.room.current, 'market');
    // a bad exit (no edge from market to lighthouse) is a safe no-op
    app.dispatch('game/go', 'lighthouse');
    assert.strictEqual(app.getState().game.room.current, 'market');
  });

  it('is winnable with no soft-lock: brine the biscuits, plate the sandwich', function () {
    const app = mountGame();
    app.dispatch('game/start');
    const g = () => app.getState().game;
    // wharf: fill the bottle at the tide pool
    app.dispatch('game/verb', 'take'); app.dispatch('game/hotspot', 'bottle');
    app.dispatch('game/verb', 'use'); app.dispatch('game/inv', 'bottle'); app.dispatch('game/hotspot', 'tidepool');
    assert.ok(g().inv.includes('seawater'), 'bottle + tide pool → seawater');
    // diner: combine seawater with the biscuits
    app.dispatch('game/go', 'diner');
    assert.strictEqual(g().room.current, 'diner');
    app.dispatch('game/verb', 'take'); app.dispatch('game/hotspot', 'crackers');
    app.dispatch('game/inv', 'seawater'); app.dispatch('game/inv', 'crackers');
    assert.ok(g().inv.includes('brineglaze'), 'seawater + crackers → brine-glaze');
    // give them to Miles → the recipe → the win
    app.dispatch('game/verb', 'give'); app.dispatch('game/inv', 'brineglaze'); app.dispatch('game/hotspot', 'miles');
    assert.ok(g().inv.includes('recipe'), 'Miles rewards the recipe');
    assert.strictEqual(g().won, true, 'the adventure completes');
  });

  it('dialogue opens a tree and an option reveals the crate clue', function () {
    const app = mountGame();
    app.dispatch('game/start');
    app.dispatch('game/verb', 'talk'); app.dispatch('game/hotspot', 'gullbert');
    assert.strictEqual(app.getState().game.dialogue.who, 'gullbert');
    app.dispatch('game/say-pick', 0);          // "Any advice about that crate?"
    assert.strictEqual(app.getState().game.flags.clue_crate, true);
    app.dispatch('game/dialogue-close');
    assert.strictEqual(app.getState().game.dialogue, null);
  });

  it('the insult sword-fight: learn by losing, then win — never a soft-lock', function () {
    const app = mountGame();
    app.dispatch('game/start');
    const g = () => app.getState().game;
    // reach the lighthouse and provoke Finch
    app.dispatch('game/go', 'diner'); app.dispatch('game/go', 'lighthouse');
    assert.strictEqual(g().room.current, 'lighthouse');
    app.dispatch('game/verb', 'talk'); app.dispatch('game/hotspot', 'finch');
    assert.ok(g().duel, 'talking to Finch starts the duel');
    // learn all three retorts by taking the hits (poise floors, never drops you)
    app.dispatch('game/duel-learn');
    app.dispatch('game/duel-learn');
    app.dispatch('game/duel-learn');
    assert.strictEqual(g().duel.known.length, 3, 'learned every retort');
    assert.ok(g().duel.poise >= 1, 'poise never reaches zero — no soft-lock');
    // now land the three matching comebacks (the insult cycles)
    app.dispatch('game/duel-say', g().duel.insult);
    app.dispatch('game/duel-say', g().duel.insult);
    app.dispatch('game/duel-say', g().duel.insult);
    assert.strictEqual(g().duel, null, 'the duel is won');
    assert.strictEqual(g().flags.solved_duel, true);
  });

  it('the duel can always be fled and is safe to re-enter', function () {
    const app = mountGame();
    app.dispatch('game/start');
    app.dispatch('game/go', 'diner'); app.dispatch('game/go', 'lighthouse');
    app.dispatch('game/verb', 'talk'); app.dispatch('game/hotspot', 'finch');
    assert.ok(app.getState().game.duel);
    app.dispatch('game/duel-flee');
    assert.strictEqual(app.getState().game.duel, null);
    // re-provoking starts a fresh duel
    app.dispatch('game/hotspot', 'finch');
    assert.ok(app.getState().game.duel);
  });

  it('running gags fire once, and giving an item never soft-locks', function () {
    const app = mountGame();
    app.dispatch('game/start');
    const g = () => app.getState().game;
    // give the compass to Gullbert (not a puzzle) — it is handed back
    app.dispatch('game/verb', 'take'); app.dispatch('game/hotspot', 'compass');
    app.dispatch('game/verb', 'give'); app.dispatch('game/inv', 'compass'); app.dispatch('game/hotspot', 'gullbert');
    assert.ok(g().inv.includes('compass'), 'the item comes back — no soft-lock');
    assert.strictEqual(g().forms.length, 1, 'an admiralty form is filed');
    // Reginald on first market arrival; the fourth-wall gag on the galleon
    app.dispatch('game/go', 'market');
    assert.match(JSON.stringify(g().log), /Reginald/);
    app.dispatch('game/go', 'galleon');
    assert.match(JSON.stringify(g().log), /pixel bleed/i);
  });

  it('exports the admiralty forms to CSV and round-trips a save via JSONX', function () {
    let saved = null; const downloads = [];
    const state = { game: { room: { current: 'wharf' }, forms: [{ item: 'magnetized compass', to: 'Gullbert the Gull' }], inv: ['compass'] } };
    const rt = createGameRuntime({
      getApp: () => ({ getState: () => state }),
      download: (name, text) => downloads.push({ name, text }),
      saveSlot: { read: () => saved, write: (s) => { saved = s; } },
    });
    const calls = [];
    const dispatch = (a, p) => calls.push({ a, p });
    // CSV export (@jarenjs/josl)
    rt.effects['game-export-forms']({}, dispatch);
    assert.strictEqual(downloads.length, 1);
    assert.match(downloads[0].name, /\.csv$/);
    assert.match(downloads[0].text, /Item surrendered|magnetized compass/);
    // JSONX save → load round-trip
    rt.effects['game-save']({}, dispatch);
    assert.ok(saved && saved.includes('wharf'), 'save writes a JSONX string');
    rt.effects['game-load']({}, dispatch);
    const restore = calls.find((c) => c.a === 'game/restore');
    assert.ok(restore, 'load dispatches game/restore');
    assert.strictEqual(restore.p.room.current, 'wharf');
  });

  it('the dynamic tier degrades gracefully without a key', function () {
    const calls = [];
    const state = {
      game: { dialogue: { who: 'gullbert' }, ask: 'what is a sandwich?' },
      ai: { settings: { provider: 'openrouter', apiKey: '', model: '' } },
    };
    const rt = createGameRuntime({
      getApp: () => ({ getState: () => state }),
      isConfigured: (s) => s.provider === 'openrouter' && s.apiKey.trim() !== '',
    });
    rt.effects['game-ai-say']({}, (action, payload) => calls.push({ action, payload }));
    assert.match(JSON.stringify(calls), /would answer live/i);
  });
});
