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
