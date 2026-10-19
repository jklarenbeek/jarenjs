//@ts-check
/**
 * Radiant OS stage: the camera, the figure vocabulary, the frame
 * composer, both paint backends, the surface and the viewer's hand on
 * the camera, and the stage and sculpture widgets — over the view DOM
 * stub, a fake window (frames, clock, resize) and a recording 2D context.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { renderToString } from '@jarenjs/view';
import { StubDocument, fire, serialize } from '../view/dom.stub.js';
import {
  HOME_CAMERA, ELEVATION_MIN, ELEVATION_MAX, DISTANCE_MIN, DISTANCE_MAX,
  clampCamera, viewOf, project, depthOf, orbit, dolly,
} from '../../packages/website/src/os/stage/camera.js';
import { POSES, mixPose, person, baby, heartOutline, hand, motionMarks, signGlyph } from '../../packages/website/src/os/stage/figures.js';
import { STAGE_THEMES, HUMAN_INK, blockHeight, EFFECT_MS, inkOf, composeFrame, cutout } from '../../packages/website/src/os/stage/scene.js';
import { paintCanvas, toSvg } from '../../packages/website/src/os/stage/paint.js';
import { createSurface, bindCamera } from '../../packages/website/src/os/stage/surface.js';
import { stillFrame, stageWidget, createAnim, absorb, motionAt, pick } from '../../packages/website/src/os/stage/widget.js';
import {
  SCULPTURE_MAX, SCULPTURE_DEPTH, sculpt, layoutSculpture, labelOf, composeSculpture, sculptureWidget,
} from '../../packages/website/src/os/stage/sculpture.js';
import { sceneOf } from '../../packages/website/src/os/app/scene.js';
import { initialState } from '../../packages/website/src/os/app/state.js';
import { compileMachine, stepWorld } from '../../packages/website/src/os/kernel/machine.js';

/** A 2D context that records every call and assignment. */
function recorder() {
  /** @type {any[]} */
  const calls = [];
  /** @type {any} */
  const target = { calls };
  return new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      return (/** @type {any[]} */ ...args) => { calls.push([prop, ...args]); };
    },
    set(t, prop, value) {
      t[prop] = value;
      calls.push([`=${String(prop)}`, value]);
      return true;
    },
  });
}

/**
 * A stub host for a surface: a fake window with a clock, optional
 * animation frames and an optional ResizeObserver, and a canvas that has
 * a 2D context only when asked.
 * @param {{ canvas?: boolean, raf?: boolean, observer?: boolean }} [options]
 */
function stageHost(options = {}) {
  /** @type {Map<number, (t: number) => void>} */
  const frames = new Map();
  /** @type {Map<string, Function>} */
  const listeners = new Map();
  let nextFrame = 1;
  /** @type {any} */
  const win = {
    devicePixelRatio: 3,
    time: 1000,
    performance: { now: () => win.time },
    addEventListener: (/** @type {string} */ type, /** @type {Function} */ fn) => listeners.set(type, fn),
    removeEventListener: (/** @type {string} */ type) => listeners.delete(type),
    listeners,
    frames,
    /** Run every pending frame at the window's time. */
    flush() {
      const pending = [...frames.values()];
      frames.clear();
      for (const fn of pending) fn(win.time);
    },
  };
  if (options.raf) {
    win.requestAnimationFrame = (/** @type {(t: number) => void} */ fn) => { frames.set(nextFrame, fn); return nextFrame++; };
    win.cancelAnimationFrame = (/** @type {number} */ id) => { frames.delete(id); };
  }
  if (options.observer) {
    win.ResizeObserver = class {
      /** @param {() => void} fn */
      constructor(fn) { win.resize = fn; }
      /** @param {any} el */
      observe(el) { win.observed = el; }
      disconnect() { win.disconnected = true; }
    };
  }
  const document = /** @type {any} */ (new StubDocument());
  document.defaultView = win;
  const ctx = options.canvas ? recorder() : null;
  const make = document.createElement.bind(document);
  document.createElement = (/** @type {string} */ tag) => {
    const el = make(tag);
    if (tag === 'canvas') {
      el.style = {};
      if (ctx) el.getContext = () => ctx;
    }
    return el;
  };
  const host = document.createElement('div');
  host.clientWidth = 800;
  host.clientHeight = 500;
  return { win, document, host, ctx };
}

/** A scene after the machine has danced a while. @param {(state: any) => void} [tweak] */
function sceneAfter(ticks = 120, tweak) {
  const state = initialState({ edition: 'test', title: 'Radiant OS' });
  state.world = stepWorld(compileMachine(state.program.machine), state.world, ticks).world;
  tweak?.(state);
  return sceneOf(state);
}

/** @returns {import('../../packages/website/src/os/stage/scene.js').Motion} */
const still = () => ({ time: 0, now: 0, moving: false, heads: {}, heights: null, stamps: [], effects: [] });

/** @param {Partial<import('../../packages/website/src/os/stage/scene.js').Motion>} over */
const moving = (over) => ({ ...still(), time: 5000, now: 0, moving: true, ...over });

const WINNER = { id: 'critic-1', by: 'critic', title: 'Wash', why: '', change: { kind: 'tape', op: 'clear' } };

describe('the camera', () => {
  it('clamps, orbits and dollies within its bounds', () => {
    assert.deepEqual(clampCamera({ ...HOME_CAMERA, elevation: -1, distance: 1 }), { ...HOME_CAMERA, elevation: ELEVATION_MIN, distance: DISTANCE_MIN });
    assert.deepEqual(clampCamera({ ...HOME_CAMERA, elevation: 9, distance: 999 }), { ...HOME_CAMERA, elevation: ELEVATION_MAX, distance: DISTANCE_MAX });
    const turned = orbit(HOME_CAMERA, 100, 10);
    assert.ok(Math.abs(turned.azimuth - (HOME_CAMERA.azimuth + 0.8)) < 1e-12);
    assert.ok(Math.abs(turned.elevation - (HOME_CAMERA.elevation + 0.06)) < 1e-12);
    assert.equal(orbit(HOME_CAMERA, 0, 1e6).elevation, ELEVATION_MAX);
    assert.equal(dolly(HOME_CAMERA, 2).distance, 72);
    assert.equal(dolly(HOME_CAMERA, 100).distance, DISTANCE_MAX);
  });

  it('projects the floor’s centre ahead of the eye, at the camera’s distance', () => {
    const view = viewOf(HOME_CAMERA, 800, 500);
    assert.ok(Math.abs(Math.hypot(...view.eye) - Math.hypot(HOME_CAMERA.lift, HOME_CAMERA.distance)) < 1e-9);
    const [x, y, w] = project(view, 0, 0, 0);
    assert.ok(Math.abs(x - 400) < 1e-6, 'the centre is centred');
    assert.ok(y > 250, 'and below the middle: the camera looks a little above the floor');
    assert.ok(Math.abs(w - HOME_CAMERA.distance) < 1e-9);
    assert.ok(Math.abs(depthOf(view, ...view.eye)) < 1e-12);
    assert.ok(depthOf(view, 0, 0, 0) > 30);
    const portrait = viewOf(HOME_CAMERA, 400, 800);
    assert.ok(project(portrait, 0, 0, 0)[2] > HOME_CAMERA.distance, 'a portrait screen backs off to fit the floor');
    const behind = project(view, ...view.eye.map((c) => c * 2));
    assert.ok(behind[2] <= 0, 'a point behind the eye has no positive depth');
  });
});

describe('the figures', () => {
  it('pose and interpolate', () => {
    assert.deepEqual(Object.keys(POSES), ['jubilant', 'dance', 'lift', 'kick', 'stamp', 'hold', 'bow', 'tumble']);
    assert.deepEqual(mixPose(POSES.dance, POSES.bow, 0), POSES.dance);
    const near = (/** @type {any} */ a, /** @type {any} */ b) => JSON.stringify(a, (_, v) => (typeof v === 'number' ? Math.round(v * 1e9) / 1e9 : v)) === JSON.stringify(b);
    assert.ok(near(mixPose(POSES.dance, POSES.bow, 1), POSES.bow));
    assert.equal(mixPose(POSES.lift, POSES.bow, 0.5).lean, 0.45);
  });

  it('build dancers, the television-headed oracle, the baby and the hand', () => {
    const dancer = person(POSES.dance);
    assert.equal(dancer.strokes.length, 5);
    assert.equal(dancer.dots.length, 1);
    assert.equal(dancer.screen, undefined);
    assert.ok(dancer.top > dancer.center[1]);
    const oracle = person(POSES.dance, { head: 'tv', bounce: 0.1 });
    assert.equal(oracle.boxes.length, 1);
    assert.ok(oracle.screen);
    assert.equal(oracle.strokes.length, 7, 'two antennae');
    assert.equal(oracle.center[1], 1.3);
    assert.notDeepEqual(baby(0).strokes, baby(Math.PI / 2).strokes, 'the baby crawls');
    assert.equal(baby(0).dots.length, 1);
    assert.equal(hand().strokes.length, 6);
    const heart = heartOutline(2);
    assert.equal(heart.length, 28);
    assert.ok(heart.every(([x, y]) => Math.abs(x) <= 2.2 && Math.abs(y) <= 2.2));
    assert.equal(heartOutline().length, 28);
  });

  it('radiate motion marks above the floor only', () => {
    const marks = motionMarks([0, 1.2], 1.1, 7, 0.05);
    assert.ok(marks.length > 0 && marks.length <= 14);
    assert.ok(marks.every(([a, b]) => a[1] >= 0.05 && b[1] >= 0.05));
    assert.ok(motionMarks([0, 1.2], 1.1, 1).length <= 2);
    assert.deepEqual(motionMarks([0, -5], 1, 5), [], 'a figure under the floor shows no marks');
  });

  it('carry a glyph for every kind of amendment', () => {
    assert.deepEqual(signGlyph({ kind: 'rule', member: 'write', value: 3 }), { strokes: [], swatch: 3 });
    for (const value of ['L', 'R', 'U', 'N']) {
      assert.equal(signGlyph({ kind: 'rule', member: 'turn', value }).strokes.length, 2, value);
    }
    assert.notDeepEqual(signGlyph({ kind: 'rule', member: 'turn', value: 'L' }), signGlyph({ kind: 'rule', member: 'turn', value: 'R' }));
    assert.equal(signGlyph({ kind: 'rule', member: 'next', value: 'leap' }).strokes.length, 3);
    assert.equal(signGlyph({ kind: 'tape', op: 'mirror' }).strokes.length, 3);
    assert.equal(signGlyph({ kind: 'tape', op: 'clear' }).strokes.length, 2);
    assert.equal(signGlyph({ kind: 'tempo', tempo: 9 }).strokes.length, 2);
    assert.deepEqual(signGlyph(undefined), signGlyph({ kind: 'tempo', tempo: 1 }));
  });
});

describe('the frame', () => {
  const view = viewOf(HOME_CAMERA, 960, 640);

  it('draws the floor, the city of blocks, the dancers and the seats', () => {
    const blank = sceneOf(initialState({ edition: 'test', title: 'Radiant OS' }));
    const empty = composeFrame(blank, view, still());
    const scene = sceneAfter(200);
    const { items, picks } = composeFrame(scene, view, still());
    assert.ok(items.length > empty.items.length, 'written cells rise as blocks');
    assert.deepEqual(picks.map((p) => `${p.kind}:${p.id}`).sort(),
      ['head:architect', 'head:critic', 'head:dancer', 'head:painter', 'seat:human', 'seat:oracle']);
    assert.ok(items.every((i) => ['poly', 'line', 'disc', 'rect', 'arc'].includes(i.t)));
    assert.ok(items.some((i) => i.t === 'poly' && i.fill === scene.palette[1]), 'blue blocks stand on the floor');
    const dark = composeFrame({ ...scene, theme: 'dark' }, view, still());
    assert.ok(dark.items.some((i) => i.t === 'poly' && i.fill === STAGE_THEMES.dark.floor));
    const paused = composeFrame({ ...scene, running: false }, view, still());
    assert.ok(paused.items.length < items.length, 'a paused machine stops radiating');
  });

  it('glows under the figure in focus and holds signs up in session', () => {
    const focused = composeFrame(sceneAfter(50, (s) => { s.os.focus = 'dancer'; }), view, still());
    assert.ok(focused.items.some((i) => i.t === 'disc' && i.fill === STAGE_THEMES.light.glow));
    const proposals = [WINNER, { ...WINNER, id: 'oracle-1', by: 'oracle', change: { kind: 'rule', state: 'dance', symbol: 1, member: 'write', value: 2 } }];
    const convening = composeFrame(sceneAfter(50, (s) => { s.council.phase = 'convening'; s.council.proposals = proposals; }), view, moving({}));
    const idle = composeFrame(sceneAfter(50), view, moving({}));
    assert.ok(convening.items.length > idle.items.length, 'proposers hold their signs, the oracle talks');
    assert.ok(convening.items.some((i) => i.t === 'rect' && i.fill === sceneAfter(0).palette[2]), 'a write sign shows its swatch');
  });

  it('puts the winner up for the verdict with the countdown ring', () => {
    const scene = sceneAfter(80, (s) => {
      Object.assign(s.council, { phase: 'veto', winner: { ...WINNER, score: 0.4 }, proposals: [WINNER], deadline: 9000, window: 9000 });
    });
    const frame = composeFrame(scene, view, { ...still(), now: 4500 });
    assert.ok(frame.picks.some((p) => p.kind === 'sign' && p.id === WINNER.id));
    const ring = /** @type {any} */ (frame.items.find((i) => i.t === 'arc'));
    assert.ok(Math.abs(ring.a1 - ring.a0 - Math.PI) < 1e-9, 'half the window is left');
    const late = composeFrame(scene, view, { ...still(), now: 99999 });
    const empty = /** @type {any} */ (late.items.find((i) => i.t === 'arc'));
    assert.equal(empty.a1, empty.a0);
    assert.ok(composeFrame(scene, view, moving({ time: 900 })).items.length > 0);
    const human = frame.picks.find((p) => p.id === 'human');
    assert.ok(human, 'the human is eager while its verdict is awaited');
  });

  it('brings the hand down on a veto and lets hearts fly on an enactment', () => {
    const scene = sceneAfter(80);
    const vetoed = composeFrame(scene, view, moving({ effects: [{ kind: 'veto', age: 800, by: 'critic', change: WINNER.change }] }));
    assert.ok(vetoed.items.some((i) => i.t === 'line' && i.stroke === '#dc2626'), 'the X is stamped red');
    assert.ok(vetoed.items.some((i) => i.t === 'line' && i.stroke === HUMAN_INK), 'the hand is the human’s colour');
    const impact = composeFrame(scene, view, moving({ effects: [{ kind: 'veto', age: 100, by: 'critic', change: WINNER.change }] }));
    assert.ok(impact.items.length < vetoed.items.length, 'the shock rings after the hand lands');
    const settled = composeFrame(scene, view, { ...still(), effects: [{ kind: 'veto', age: 0, by: 'critic', change: WINNER.change }] });
    assert.ok(settled.items.some((i) => i.t === 'line' && i.stroke === '#dc2626'), 'reduced motion still shows the verdict');
    const over = composeFrame(scene, view, moving({ effects: [{ kind: 'veto', age: EFFECT_MS.veto + 1, change: WINNER.change }] }));
    assert.ok(!over.items.some((i) => i.t === 'line' && i.stroke === '#dc2626'));
    const enacted = composeFrame(scene, view, moving({ effects: [{ kind: 'enact', age: 300 }] }));
    assert.equal(enacted.items.filter((i) => i.t === 'poly' && i.fill === scene.palette[2] && i.a !== undefined).length, 8);
    const repealed = composeFrame(scene, view, moving({ effects: [{ kind: 'repeal', age: 300 }] }));
    assert.equal(repealed.items.filter((i) => i.t === 'poly' && i.fill === HUMAN_INK).length, 8);
    const done = composeFrame(scene, view, moving({ effects: [{ kind: 'enact', age: EFFECT_MS.enact + 1 }] }));
    assert.ok(!done.items.some((i) => i.t === 'poly' && i.fill === scene.palette[2] && i.a !== undefined));
  });

  it('animates hops, rising blocks and stamps', () => {
    const scene = sceneAfter(60);
    const cell = scene.tape.findIndex((s) => s !== 0);
    const frame = composeFrame(scene, view, moving({
      heads: { painter: { x: 0.5, z: 0.5, hop: 1 } },
      heights: Array.from(scene.tape, (s) => blockHeight(s) * 0.5),
      stamps: [{ cell, age: 100 }, { cell, age: 900 }],
    }));
    assert.equal(frame.items.filter((i) => i.t === 'line' && i.a !== undefined && i.a > 0.7 && i.a < 0.8).length, 4, 'one stamp radiates; the old one is gone');
    const painter = /** @type {any} */ (frame.picks.find((p) => p.id === 'painter'));
    const settledFrame = composeFrame(scene, view, still());
    assert.notDeepEqual(painter, settledFrame.picks.find((p) => p.id === 'painter'), 'a hopping head is drawn where it is going');
  });

  it('wears the inks and cuts figures out of them', () => {
    const scene = sceneAfter(0);
    assert.equal(inkOf(scene, { ink: -1 }), HUMAN_INK);
    assert.equal(inkOf(scene, { ink: 4 }), scene.palette[4]);
    assert.equal(inkOf(scene, { ink: 42 }), HUMAN_INK);
    /** @type {any[]} */
    const out = [];
    cutout(out, person(POSES.lift, { head: 'tv' }), { x: 100, y: 100, unit: 20, sway: -0.4 }, '#2563eb', STAGE_THEMES.light, 0.5);
    assert.ok(out.length > 20);
    assert.ok(out.every((i) => i.a === 0.5));
    assert.ok(out.some((i) => i.t === 'rect' && i.fill === STAGE_THEMES.light.paper), 'the screen is paper');
    /** @type {any[]} */
    const solid = [];
    cutout(solid, baby(1), { x: 0, y: 0, unit: 10, sway: 0.3 }, HUMAN_INK, STAGE_THEMES.dark);
    assert.ok(solid.every((i) => i.a === undefined));
    assert.equal(blockHeight(0), 0);
    assert.ok(blockHeight(5) > blockHeight(1));
  });
});

describe('the paint backends', () => {
  /** @type {import('../../packages/website/src/os/stage/scene.js').Item[]} */
  const items = [
    { t: 'poly', p: [0, 0, 10, 0, 10, 10], fill: '#2563eb', stroke: '#11131c', w: 2 },
    { t: 'poly', p: [0, 0, 5, 5, 0, 5], fill: null, stroke: null, w: 0 },
    { t: 'line', p: [0, 0, 5, 5, 9, 1], stroke: '#11131c', w: 3, a: 0.5 },
    { t: 'disc', x: 5, y: 5, r: 4, fill: '#fbbf24', stroke: '#11131c', w: 1 },
    { t: 'disc', x: 5, y: 5, r: -1, fill: null, stroke: null, w: 0 },
    { t: 'rect', x: 1, y: 1, wd: 8, ht: 6, r: 2, fill: '#ef4444', stroke: '#11131c', w: 1 },
    { t: 'rect', x: 1, y: 1, wd: 8, ht: 6, r: 0, fill: null, stroke: null, w: 0 },
    { t: 'arc', x: 5, y: 5, r: 4, a0: 0, a1: Math.PI, stroke: '#11131c', w: 2 },
    { t: 'arc', x: 5, y: 5, r: 4, a0: 0, a1: Math.PI * 1.5, stroke: '#11131c', w: 2 },
    { t: 'arc', x: 5, y: 5, r: 4, a0: 0, a1: Math.PI * 2, stroke: '#11131c', w: 2 },
    { t: 'arc', x: 5, y: 5, r: 4, a0: 1, a1: 1, stroke: '#11131c', w: 2 },
  ];

  it('paint a display list into a canvas', () => {
    const ctx = recorder();
    paintCanvas(/** @type {any} */ (ctx), items, '#fff7e6', 100, 80);
    const calls = ctx.calls.map((/** @type {any[]} */ c) => c[0]);
    assert.deepEqual(ctx.calls[0], ['=globalAlpha', 1]);
    assert.deepEqual(ctx.calls.find((/** @type {any[]} */ c) => c[0] === 'fillRect'), ['fillRect', 0, 0, 100, 80]);
    assert.equal(calls.filter((/** @type {string} */ c) => c === 'arc').length, 2 + 4, 'two discs and four arcs');
    assert.equal(calls.filter((/** @type {string} */ c) => c === 'arcTo').length, 8, 'two rounded rectangles');
    assert.equal(calls.filter((/** @type {string} */ c) => c === 'closePath').length, 2);
    assert.ok(ctx.calls.some((/** @type {any[]} */ c) => c[0] === '=globalAlpha' && c[1] === 0.5));
    assert.equal(ctx.globalAlpha, 1, 'alpha is restored');
    assert.ok(ctx.calls.some((/** @type {any[]} */ c) => c[0] === 'arc' && c[3] === 0), 'a negative radius draws nothing, not an error');
  });

  it('turn a display list into one SVG tree', () => {
    const svg = toSvg(items, { width: 100, height: 80, background: '#fff7e6', title: 'Still' });
    assert.equal(svg[0], 'svg');
    assert.equal(svg[1]['aria-label'], 'Still');
    assert.equal(svg[1].class, 'os-stage-svg');
    assert.deepEqual(svg[2], ['title', {}, 'Still']);
    const shapes = svg.slice(4);
    assert.equal(shapes.length, items.length - 1, 'an arc with no sweep is not drawn');
    assert.match(shapes[0][1].d, /Z$/);
    assert.equal(shapes[1][1].fill, 'none');
    assert.equal(shapes[2][1].opacity, 0.5);
    assert.equal(shapes[3][0], 'circle');
    assert.equal(shapes[4][1].r, 0);
    assert.equal(shapes[5][0], 'rect');
    assert.match(shapes[7][1].d, / 0 0 1 /, 'a half turn is a small arc');
    assert.match(shapes[8][1].d, / 0 1 1 /, 'three quarters is a large one');
    assert.match(shapes[9][1].d, /a4 4 0 1 0 8 0a4 4 0 1 0 -8 0/, 'a full circle is two arcs');
    assert.equal(toSvg([], { width: 1, height: 1, background: '#000', title: 't', className: 'x' })[1].class, 'x');
    assert.match(renderToString(svg), /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  });
});

describe('the surface', () => {
  it('sizes a canvas to its host at the device pixel ratio and paints into it', () => {
    const { host, document, win, ctx } = stageHost({ canvas: true });
    const surface = createSurface(host, document);
    assert.equal(surface.canvas.getAttribute('aria-hidden'), 'true');
    assert.equal(host.childNodes.length, 1);
    assert.deepEqual([surface.width, surface.height, surface.dpr], [800, 500, 2]);
    assert.deepEqual([surface.canvas.width, surface.canvas.height, surface.canvas.style.width], [1600, 1000, '800px']);
    surface.paint([{ t: 'disc', x: 1, y: 1, r: 1, fill: '#000', stroke: null, w: 0 }], '#fff', 'title');
    assert.deepEqual(ctx.calls.find((/** @type {any[]} */ c) => c[0] === 'setTransform'), ['setTransform', 2, 0, 0, 2, 0, 0]);
    win.time = 1234;
    assert.equal(surface.now(), 1234);
    surface.destroy();
  });

  it('falls back to SVG through the view renderer where no canvas draws', () => {
    const { host, document } = stageHost();
    host.clientWidth = 0;
    const surface = createSurface(host, document);
    assert.equal(surface.svg !== null, true);
    assert.equal(surface.width, 960, 'an unmeasured host gets the default size');
    surface.paint([{ t: 'line', p: [0, 0, 1, 1], stroke: '#000', w: 1 }], '#fff', 'Fallback');
    assert.match(serialize(host), /<svg[^>]*aria-label="Fallback"/);
    surface.destroy();
    const bare = stageHost();
    delete bare.document.defaultView;
    assert.equal(createSurface(bare.host, bare.document).win, globalThis);
  });

  it('puts the viewer’s hand on the camera', () => {
    const { host, document, win } = stageHost({ observer: true });
    const surface = createSurface(host, document);
    let camera = { ...HOME_CAMERA };
    let changed = 0;
    let resized = 0;
    /** @type {any[]} */
    const taps = [];
    const cleanups = bindCamera(host, surface, {
      get: () => camera,
      set: (c) => { camera = c; },
      home: () => ({ ...HOME_CAMERA }),
      changed: () => { changed++; },
      tap: (e) => { taps.push(e); },
      resized: () => { resized++; },
    });
    const noop = () => {};
    fire(host, 'pointerdown', { pointerId: 1, clientX: 10, clientY: 10 });
    fire(host, 'pointerup', { pointerId: 1, clientX: 11, clientY: 10 });
    assert.equal(taps.length, 1, 'a press without travel is a tap');

    fire(host, 'pointerdown', { pointerId: 1, clientX: 10, clientY: 10 });
    fire(host, 'pointermove', { pointerId: 1, clientX: 60, clientY: 20 });
    fire(host, 'pointermove', { pointerId: 9, clientX: 0, clientY: 0 });
    fire(host, 'pointerup', { pointerId: 1, clientX: 60, clientY: 20 });
    assert.equal(taps.length, 1, 'a drag is not a tap');
    assert.ok(camera.azimuth > HOME_CAMERA.azimuth);

    fire(host, 'pointerdown', { pointerId: 1, clientX: 0, clientY: 0 });
    fire(host, 'pointerdown', { pointerId: 2, clientX: 100, clientY: 0 });
    const before = camera.distance;
    fire(host, 'pointermove', { pointerId: 2, clientX: 200, clientY: 0 });
    assert.ok(camera.distance < before, 'spreading two fingers comes closer');
    fire(host, 'pointercancel', { pointerId: 2 });
    fire(host, 'pointercancel', { pointerId: 1 });

    const far = camera.distance;
    fire(host, 'wheel', { deltaY: 200, preventDefault: noop });
    assert.ok(camera.distance > far);
    fire(host, 'dblclick');
    assert.deepEqual(camera, { ...HOME_CAMERA });
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-']) {
      const was = { ...camera };
      fire(host, 'keydown', { key, preventDefault: noop, stopPropagation: noop });
      assert.notDeepEqual(camera, was, key);
    }
    fire(host, 'keydown', { key: '0', preventDefault: noop, stopPropagation: noop });
    assert.deepEqual(camera, { ...HOME_CAMERA });
    const count = changed;
    fire(host, 'keydown', { key: 'q', preventDefault: () => assert.fail('an unbound key is left alone'), stopPropagation: noop });
    assert.equal(changed, count);

    assert.equal(win.observed, host);
    host.clientWidth = 300;
    win.resize();
    assert.equal(surface.width, 300);
    assert.equal(resized, 1);
    for (const off of cleanups) off();
    assert.equal(win.disconnected, true);
    fire(host, 'dblclick');
    assert.equal(changed, count, 'a released hand does nothing');
  });

  it('listens for window resizes where no ResizeObserver exists', () => {
    const { host, document, win } = stageHost();
    const surface = createSurface(host, document);
    let resized = 0;
    const cleanups = bindCamera(host, surface, {
      get: () => HOME_CAMERA, set: () => {}, home: () => HOME_CAMERA, changed: () => {}, resized: () => { resized++; },
    });
    win.listeners.get('resize')?.();
    assert.equal(resized, 1);
    for (const off of cleanups) off();
    assert.equal(win.listeners.has('resize'), false);
    fire(host, 'pointerup', { pointerId: 4 });
    assert.deepEqual(bindCamera(/** @type {any} */ ({}), /** @type {any} */ ({ win: {} }), /** @type {any} */ ({})), [], 'a host without events binds nothing');
  });
});

describe('the stage widget', () => {
  it('renders a still frame for the server, the export and reduced motion', () => {
    const scene = sceneAfter(40);
    const frame = stillFrame(scene, { width: 300, height: 200, title: 'Snapshot' });
    assert.equal(frame[1].width, 300);
    assert.deepEqual(frame[2], ['title', {}, 'Snapshot']);
    assert.equal(stillFrame({ ...scene, theme: /** @type {any} */ ('sepia') })[1]['aria-label'], 'Radiant OS stage');
    const ssr = stageWidget.ssr({ scene, label: 'The stage' });
    assert.equal(ssr[1]['aria-label'], 'The stage');
  });

  it('mounts, follows the scene and unmounts without a frame loop under reduced motion', () => {
    const { host, document } = stageHost();
    const scene = sceneAfter(30);
    /** @type {any[]} */
    const emitted = [];
    const handle = stageWidget.mount(host, { scene, reduce: true, label: 'Stage' }, (b, e) => emitted.push([b, e]), { document });
    assert.equal(host.getAttribute('tabindex'), '0');
    assert.equal(host.getAttribute('role'), 'img');
    assert.match(serialize(host), /aria-label="Stage"/);
    const next = sceneAfter(31);
    stageWidget.update(handle, { scene: next, reduce: true, label: 'Stage, tick 31' }, { scene, reduce: true, label: 'Stage' });
    assert.equal(host.getAttribute('aria-label'), 'Stage, tick 31');
    stageWidget.update(handle, { scene: next, reduce: true }, { scene: next, reduce: true, label: 'Stage, tick 31' });
    assert.equal(host.getAttribute('aria-label'), 'Radiant OS stage');
    fire(host, 'dblclick');
    stageWidget.unmount(handle);
    assert.equal(handle.alive, false);
    stageWidget.update(handle, { scene: next, reduce: true }, { scene: next, reduce: true });
  });

  it('runs its own frame loop, drifting when the viewer lets go', () => {
    const { host, document, win, ctx } = stageHost({ canvas: true, raf: true, observer: true });
    const scene = sceneAfter(30);
    const handle = stageWidget.mount(host, { scene, tempo: 12 }, () => {}, undefined);
    assert.equal(win.frames.size, 1);
    fire(host, 'keydown', { key: 'ArrowLeft', preventDefault() {}, stopPropagation() {} });
    assert.ok(handle.director.camera.azimuth < HOME_CAMERA.azimuth, 'the arrow keys turn the stage');
    handle.director.cut(HOME_CAMERA);
    host.clientWidth = 640;
    win.resize();
    assert.equal(handle.surface.width, 640, 'the stage follows its host’s size');
    assert.equal(win.frames.size, 1, 'a resize while animating waits for the next frame');
    stageWidget.update(handle, { scene: sceneAfter(31), tempo: 12 }, { scene, tempo: 12 });
    assert.equal(win.frames.size, 1, 'one frame at a time');
    const sparks = handle.fx.particles.length;
    const cheered = { scene: sceneAfter(31), tempo: 12, cheer: { who: 'painter', seq: 1 } };
    stageWidget.update(handle, cheered, { scene: sceneAfter(31), tempo: 12 });
    assert.ok(handle.fx.particles.length > sparks, 'a crew member who built a block hops for joy in sparks');
    const after = handle.fx.particles.length;
    stageWidget.update(handle, cheered, cheered);
    stageWidget.update(handle, { ...cheered, cheer: { who: 'nobody', seq: 2 } }, cheered);
    assert.equal(handle.fx.particles.length, after, 'once per cheer, and only for a member on the stage');
    const azimuth = handle.director.camera.azimuth;
    win.time = 20000;
    win.flush();
    assert.ok(handle.director.camera.azimuth > azimuth, 'the idle camera drifts');
    assert.ok(ctx.calls.some((/** @type {any[]} */ c) => c[0] === 'fillRect'));
    assert.equal(win.frames.size, 1, 'and asks for the next frame');
    fire(host, 'pointerdown', { pointerId: 1, clientX: 0, clientY: 0 });
    const held = handle.director.camera.azimuth;
    win.time = 20016;
    win.flush();
    assert.equal(handle.director.camera.azimuth, held, 'not while the viewer holds it');
    handle.props = { ...handle.props, reduce: true };
    win.flush();
    assert.equal(win.frames.size, 0, 'reduced motion stops the loop');
    handle.props = { ...handle.props, reduce: false };
    stageWidget.update(handle, handle.props, handle.props);
    stageWidget.unmount(handle);
    assert.equal(win.frames.size, 0, 'unmounting cancels the pending frame');
    win.flush();
    assert.equal(document.defaultView, win);
  });

  it('folds each new scene into hops, rising blocks, stamps and effects', () => {
    const scene = sceneAfter(30);
    const anim = createAnim(scene);
    assert.equal(anim.seen, 0);
    const heads = scene.heads.map((h, i) => (i === 0 ? { ...h, x: (h.x + 1) % scene.width }
      : i === 1 ? { ...h, x: (h.x + 5) % scene.width } : h));
    const tape = [...scene.tape];
    tape[0] = tape[0] === 3 ? 4 : 3;
    absorb(anim, { ...scene, heads: [...heads, { ...heads[0], id: 'newcomer' }], tape,
      events: [{ seq: 1, kind: 'veto', by: 'critic', change: WINNER.change }] }, 100, 10);
    const hop = /** @type {any} */ (anim.heads.get(heads[0].id));
    assert.equal(hop.dur, 100, 'a one-cell hop takes a tick at most');
    assert.equal(/** @type {any} */ (anim.heads.get(heads[1].id)).dur, 0, 'a jump lands at once');
    assert.equal(/** @type {any} */ (anim.heads.get('newcomer')).dur, 0);
    assert.deepEqual(anim.stamps, [{ cell: 0, start: 100 }]);
    assert.deepEqual(anim.effects.map((e) => e.kind), ['veto']);
    const mid = motionAt(anim, 150, true);
    assert.ok(mid.heads[heads[0].id].hop > 0.9, 'mid-hop is the top of the jump');
    assert.ok(mid.heights && mid.heights[0] !== blockHeight(tape[0]), 'the block is still rising');
    assert.equal(mid.effects[0].change, WINNER.change);
    const later = motionAt(anim, 5000, true);
    assert.equal(later.heights?.[0], blockHeight(tape[0]));
    assert.deepEqual(later.stamps, []);
    assert.deepEqual(later.effects, []);
    assert.deepEqual(motionAt(anim, 150, false).heads, {}, 'a still frame moves nothing');

    absorb(anim, { ...anim.scene, events: [{ seq: 1, kind: 'veto' }] }, 6000, 10);
    assert.deepEqual(anim.effects, [], 'an event is played once');
    const many = [...anim.scene.tape];
    for (let i = 0; i < 100; i++) many[i] = (many[i] + 1) % 6;
    absorb(anim, { ...anim.scene, tape: many }, 7000, 10);
    assert.equal(anim.stamps.length, 64, 'at most 64 stamps play at once');
    absorb(anim, { ...anim.scene, width: 10, height: 10, tape: new Array(100).fill(0), heads: [] }, 8000, 10);
    assert.equal(anim.to.length, 100, 'a new floor size starts afresh');
  });

  it('resolves a tap to a figure, a sign or a cell', () => {
    const scene = sceneAfter(30);
    /** @type {any[]} */
    const emitted = [];
    const { host, document } = stageHost();
    const handle = stageWidget.mount(host, { scene, reduce: true, onPick: { action: 'stage/pick', with: { from: 'stage' } } },
      (binding) => emitted.push(binding), { document });
    const figure = handle.picks.find((/** @type {any} */ p) => p.id === 'architect');
    // the stub host's box starts at (1, 2)
    pick(handle, { clientX: figure.x + 1, clientY: figure.y + 2 });
    assert.deepEqual(emitted.at(-1), { action: 'stage/pick', with: { from: 'stage', kind: 'head', id: 'architect' } });
    const [cx, cy] = project(handle.view, 0.5, blockHeight(scene.tape[10 * 20 + 10]), 0.5);
    handle.picks = [];
    pick(handle, { clientX: cx + 1, clientY: cy + 2 });
    assert.deepEqual(emitted.at(-1), { action: 'stage/pick', with: { from: 'stage', kind: 'cell', id: String(10 * 20 + 10), x: 10, y: 10, symbol: scene.tape[210] } });
    const count = emitted.length;
    pick(handle, { clientX: -5000, clientY: -5000 });
    assert.equal(emitted.length, count, 'nothing is under a tap far off the floor');
    handle.props = { ...handle.props, onPick: 'stage/pick' };
    handle.picks = [{ kind: 'sign', id: 'w', x: 0, y: 0, r: 10 }];
    pick(handle, { clientX: 1, clientY: 2 });
    assert.deepEqual(emitted.at(-1), { action: 'stage/pick', with: { kind: 'sign', id: 'w' } });
    handle.props = { ...handle.props, onPick: null };
    pick(handle, { clientX: 1, clientY: 2 });
    assert.equal(emitted.length, count + 1);
    fire(host, 'pointerdown', { pointerId: 1, clientX: 1, clientY: 2 });
    fire(host, 'pointerup', { pointerId: 1, clientX: 1, clientY: 2 });
    stageWidget.unmount(handle);
  });
});

describe('the sculpture', () => {
  const doc = { name: 'radiant', ok: true, off: false, none: null, count: 12, list: [1, 'two', { three: 3 }], long: 'x'.repeat(40) };

  it('sculpts JSON by shape', () => {
    const root = sculpt(doc);
    assert.equal(root.kind, 'figure');
    assert.equal(root.at, '$');
    assert.equal(root.size, 7);
    const kinds = Object.fromEntries((root.children ?? []).map((c) => [labelOf(c.at), c.kind]));
    assert.deepEqual(kinds, { name: 'speech', ok: 'heart', off: 'heart', none: 'ghost', count: 'rays', list: 'chain', long: 'speech' });
    const long = root.children?.find((c) => c.at === "$['long']");
    assert.equal(long?.text?.length, 28);
    assert.equal(labelOf("$['list'][2]"), '#2');
    assert.equal(labelOf("$['it\\'s']"), "it\\'s");
    assert.equal(labelOf('$'), '$');
  });

  it('lays a crowd out in rings and counts what it cannot show', () => {
    const layout = layoutSculpture(sculpt(doc));
    assert.equal(layout.nodes.length, 12);
    assert.equal(layout.hidden, 0);
    assert.equal(Math.hypot(layout.nodes[0].x, layout.nodes[0].z), 0, 'the root stands in the middle');
    assert.ok(layout.nodes.slice(1).every((n) => n.depth >= 1 && Math.hypot(n.x, n.z) > 1));
    const small = layoutSculpture(sculpt(doc), 4);
    assert.equal(small.nodes.length, 4);
    assert.equal(small.hidden, 4, 'the four members left standing are counted, not their insides');
    assert.equal(small.nodes[0].hidden, 4, 'the root shows three of its seven');
    const deep = layoutSculpture(sculpt({ a: { b: { c: { d: { e: 1 } } } } }));
    assert.equal(Math.max(...deep.nodes.map((n) => n.depth)), SCULPTURE_DEPTH);
    assert.equal(deep.hidden, 1);
    assert.equal(layoutSculpture(sculpt(Array.from({ length: 200 }, (_, i) => i))).nodes.length, SCULPTURE_MAX);
    assert.equal(layoutSculpture(sculpt(7)).radius, 3.1);
  });

  it('lights the figures that are executing', () => {
    const layout = layoutSculpture(sculpt(doc));
    const view = viewOf({ azimuth: 0.5, elevation: 0.62, distance: 24, lift: 0.6, fov: 0.62 }, 640, 480);
    const quiet = composeSculpture(layout, view, { time: 1000, moving: true, active: new Set() }, 'light');
    const lit = composeSculpture(layout, view, { time: 1000, moving: true, active: new Set(['$', "$['list']", "$['ok']"]) }, 'light');
    assert.ok(lit.length > quiet.length);
    assert.ok(lit.some((i) => i.t === 'disc' && i.fill === STAGE_THEMES.light.glow));
    assert.ok(quiet.some((i) => i.t === 'poly' && i.fill === '#ef4444'), 'true is a red heart');
    assert.ok(quiet.some((i) => i.t === 'poly' && i.fill === STAGE_THEMES.light.paper), 'false is an empty one');
    const dark = composeSculpture(layout, view, { time: 0, moving: false, active: new Set() }, 'dark');
    assert.equal(dark[0].t, 'poly');
    assert.equal(/** @type {any} */ (dark[0]).fill, STAGE_THEMES.dark.floor);
    const odd = composeSculpture(layout, view, { time: 0, moving: false, active: new Set() }, /** @type {any} */ ('sepia'));
    assert.equal(/** @type {any} */ (odd[0]).fill, STAGE_THEMES.light.floor);
    const inside = viewOf({ azimuth: 0, elevation: 0.2, distance: 0.1, lift: 0, fov: 0.62 }, 640, 480);
    assert.ok(composeSculpture(layout, inside, { time: 0, moving: false, active: new Set() }, 'light').length >= 1);
  });

  it('mounts as a widget that turns slowly and repaints on request', () => {
    const layout = layoutSculpture(sculpt(doc));
    const { host, document, win, ctx } = stageHost({ canvas: true, raf: true, observer: true });
    const props = { layout, active: ["$['ok']"], theme: /** @type {const} */ ('light'), reduce: false, label: 'The program, sculpted' };
    const handle = sculptureWidget.mount(host, props, () => {}, { document });
    assert.equal(host.getAttribute('aria-label'), 'The program, sculpted');
    assert.equal(win.frames.size, 1);
    const azimuth = handle.camera.azimuth;
    win.flush();
    assert.ok(handle.camera.azimuth > azimuth);
    assert.ok(ctx.calls.some((/** @type {any[]} */ c) => c[0] === 'fillRect'));
    const other = layoutSculpture(sculpt([1, 2, 3]));
    sculptureWidget.update(handle, { ...props, layout: other, label: 'Another' }, props);
    assert.equal(host.getAttribute('aria-label'), 'Another');
    assert.equal(handle.camera.azimuth, 0.5, 'a new document starts from its own home');
    fire(host, 'keydown', { key: 'ArrowRight', preventDefault() {}, stopPropagation() {} });
    assert.ok(handle.camera.azimuth > 0.5, 'the arrow keys turn the sculpture');
    sculptureWidget.update(handle, { ...props, layout: other, label: 'Another', reduce: true }, { ...props, layout: other, label: 'Another' });
    win.resize();
    fire(host, 'dblclick');
    win.flush();
    assert.equal(win.frames.size, 0);
    sculptureWidget.unmount(handle);
    sculptureWidget.update(handle, props, props);

    const svgHost = stageHost();
    const reduced = sculptureWidget.mount(svgHost.host, { ...props, reduce: true }, () => {}, { document: svgHost.document });
    assert.match(serialize(svgHost.host), /<svg/);
    fire(svgHost.host, 'dblclick');
    sculptureWidget.unmount(reduced);
  });
});
