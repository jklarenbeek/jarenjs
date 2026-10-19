//@ts-check
/**
 * Radiant OS exports: the art DAG renders the theme as CSS, the still
 * frame as an HTML page and the program as a JavaScript module through
 * JTLT; the lexer reads the text back into tokens. The module is run
 * here and must replay the OS's own machine cell for cell.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TEMPLATES, artPipeline, artInput, renderArt, tokenize, tokenStats, TOKEN_KINDS, FORMATS,
} from '../../packages/website/src/os/kernel/exports.js';
import { compileMachine, stepWorld } from '../../packages/website/src/os/kernel/machine.js';
import { initialState, PALETTE } from '../../packages/website/src/os/app/state.js';
import { STAGE_THEMES, HUMAN_INK } from '../../packages/website/src/os/stage/scene.js';
import { inkFor } from '@jarenjs/core/color';

const fresh = () => initialState({ edition: 'test', title: 'Radiant OS' });

describe('the art input', () => {
  it('is built from the state with every colour checked', () => {
    const state = fresh();
    state.program.palette = ['#fffdf6', 'red; } body { display: none', '#fbbf24', 42, '#16a34a', '#06b6d4', '#123456'];
    state.council.leader = 'critic';
    state.council.merits = { ...state.council.merits, critic: 2.345 };
    const input = artInput(state, { title: 'Hello' });
    assert.equal(input.title, 'Hello');
    assert.equal(input.palette[1], PALETTE[1], 'a colour that is not a hex falls back to the default ink');
    assert.equal(input.palette[3], PALETTE[3]);
    assert.equal(input.palette[6], '#123456');
    assert.equal(input.leader.name, 'Critic');
    assert.equal(input.leader.merit, 2.35);
    assert.equal(input.leader.color, input.palette[3]);
    assert.equal(input.leader.ink, inkFor(input.palette[3]));
    assert.equal(input.members.find((m) => m.id === 'human')?.color, HUMAN_INK);
    assert.equal(input.paper, STAGE_THEMES.light.paper);
    assert.equal(input.svg, '');
    assert.deepEqual(input.rules.dance.length, 6);

    state.os.theme = 'dark';
    state.council.leader = 'nobody';
    state.program.palette = ['#fffdf6', '#2563eb', '#fbbf24', '#ef4444', '#16a34a', '#06b6d4', 'nope'];
    const dark = artInput(state);
    assert.equal(dark.ink, STAGE_THEMES.dark.ink);
    assert.equal(dark.leader.name, 'Painter', 'an unknown leader reads as the first seat');
    assert.equal(dark.palette[6], '#888888');
    assert.match(dark.title, /tick 0$/);
  });
});

describe('the art pipeline', () => {
  it('renders the theme the chrome wears', async () => {
    const state = fresh();
    state.council.leader = 'dancer';
    const { css } = await renderArt(state);
    assert.match(css, /Leader: Dancer \(merit 1\)/);
    assert.match(css, new RegExp(`--os-lead: ${PALETTE[2]};`));
    assert.match(css, new RegExp(`--os-lead-ink: ${inkFor(PALETTE[2])};`));
    PALETTE.forEach((c, i) => assert.match(css, new RegExp(`--os-symbol-${i}: ${c};`)));
    assert.match(css, /\.os \[data-member="human"\] \{ --member: #f97316; \}/);
  });

  it('renders a standalone page with the frame embedded and the words escaped', async () => {
    const { html, svg } = await renderArt(fresh(), { svg: '<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>', title: 'Tom & <Jerry>' });
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<figure>\n<svg viewBox="0 0 1 1"><rect width="1" height="1"\/><\/svg>/);
    assert.match(html, /<title>Tom &amp; &lt;Jerry&gt;<\/title>/);
    assert.doesNotMatch(html, /<Jerry>/);
    assert.match(html, /Painter 1; Dancer 1; Critic 1; Architect 1; Oracle 1; You 1;/);
    assert.equal(svg, '<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>');
  });

  it('renders a module that replays the machine cell for cell', async () => {
    const state = fresh();
    const { js } = await renderArt(state);
    const module = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
    assert.equal(module.WIDTH, 20);
    assert.deepEqual(module.PALETTE, PALETTE);
    const ours = stepWorld(compileMachine(state.program.machine), state.world, 500).world;
    const theirs = module.run(500);
    assert.deepEqual(theirs.tape, ours.tape);
    assert.deepEqual(theirs.heads.map((/** @type {any} */ h) => [h.x, h.y, h.dir, h.state]), ours.heads.map((h) => [h.x, h.y, h.dir, h.state]));
    const text = module.toText(theirs.tape);
    assert.equal(text.split('\n').length, 20);
    assert.equal(text.split('\n')[0].length, 20);
  });

  it('runs each template by name in one pipeline run', async () => {
    assert.deepEqual(Object.keys(TEMPLATES), ['theme', 'artwork', 'machine']);
    const run = await artPipeline.run(artInput(fresh()));
    assert.deepEqual(Object.keys(run).sort(), ['css', 'html', 'js', 'svg']);
    assert.equal(run.css, TEMPLATES.theme(await (async () => {
      const input = artInput(fresh());
      return { leader: input.leader, tokens: [
        { name: 'os-paper', value: input.paper }, { name: 'os-ink', value: input.ink },
        { name: 'os-lead', value: input.leader.color }, { name: 'os-lead-ink', value: input.leader.ink },
        ...input.palette.map((value, i) => ({ name: `os-symbol-${i}`, value })),
      ], members: input.members.map((m) => ({ id: m.id, color: m.color })) };
    })()), 'the theme node shapes exactly the template input');
  });
});

describe('reading code back', () => {
  it('tokenizes the CSS, HTML and JavaScript it wrote', async () => {
    const art = await renderArt(fresh(), { svg: '<svg/>' });
    for (const [format, text] of /** @type {const} */ ([['css', art.css], ['html', art.html], ['js', art.js]])) {
      const tokens = tokenize(text, FORMATS[format].lang);
      assert.ok(tokens.length > 20, `${format} reads as many tokens`);
      assert.equal(tokens.map((t) => t.value).join(''), text, `${format} tokens cover the text exactly`);
      assert.ok(tokens.every((t) => TOKEN_KINDS.includes(t.kind)));
    }
    const js = tokenStats(tokenize(art.js, 'js'));
    assert.ok(js.kw > 0 && js.com > 0 && js.num > 0 && js.str > 0);
  });

  it('reads an unknown language as one plain run and counts every kind', () => {
    assert.deepEqual(tokenize('++[>]', 'brainfuck'), [{ kind: 'id', value: '++[>]' }]);
    assert.deepEqual(tokenStats([]), Object.fromEntries(TOKEN_KINDS.map((k) => [k, 0])));
    assert.equal(tokenStats([{ kind: 'odd' }]).odd, 1);
    assert.deepEqual(Object.keys(FORMATS), ['css', 'html', 'js', 'svg']);
    assert.equal(FORMATS.svg.mime, 'image/svg+xml');
  });
});
