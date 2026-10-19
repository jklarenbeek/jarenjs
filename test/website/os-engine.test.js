//@ts-check
/**
 * Radiant OS engines: mesh collision (BVH rays, sphere contacts, slide
 * and sweep, screen rays, SAT), ragdoll liveliness, Web Audio synthesis
 * over a recording context, the effects engine, the camera director,
 * cel lighting and shadows, and the game lifecycle, loop and controls.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  boxGeometry, planeGeometry, prismGeometry, mergeGeometry, buildMesh, triangleOf, triangleNormal, normalize,
  rayTriangle, raycast, closestOnTriangle, boxesOverlap, queryBox, sphereContacts, resolveSphere, sweepSphere,
  screenRay, invert4, satPolygons, pointInPolygon,
} from '../../packages/website/src/os/engine/collide.js';
import {
  LINKS, RAGDOLL_DEFAULTS, createRagdoll, stepRagdoll, kickRagdoll, ragdollSkeleton, ragdollEnergy, ragdollStretch,
} from '../../packages/website/src/os/engine/ragdoll.js';
import {
  PENTATONIC, SFX, TRACKS, noteFrequency, degreeNote, trackEvents, tapeMelody, stepSeconds, createAudio,
} from '../../packages/website/src/os/engine/audio.js';
import {
  EASE, tween, spring, createFx, emit, shake, flash, stepFx, shakeOffset, fxGroups, overlayItems, FX_MAX,
} from '../../packages/website/src/os/engine/fx.js';
import { SHOTS, HAND_IDLE_MS, lerpCamera, createDirector } from '../../packages/website/src/os/engine/director.js';
import { sunAt, createLighting, shade, shadowPolygon, convexHull, followSpots, hourForTheme } from '../../packages/website/src/os/engine/light.js';
import { GAME_FLOW, gameStep, gameEvents, createLoop, KEYMAP, createInput } from '../../packages/website/src/os/engine/loop.js';
import { POSES, JOINTS, skeleton, skeletonShape } from '../../packages/website/src/os/stage/figures.js';
import { HOME_CAMERA, viewOf, project } from '../../packages/website/src/os/stage/camera.js';

const close = (/** @type {number} */ a, /** @type {number} */ b, eps = 1e-6) => Math.abs(a - b) <= eps;

describe('mesh collision', () => {
  const box = buildMesh(boxGeometry([-1, 0, -1], [1, 2, 1]), new Array(12).fill('rock'));

  it('builds a BVH over triangles and refuses broken geometry', () => {
    assert.equal(box.triangles, 12);
    assert.deepEqual(box.bounds, { min: [-1, 0, -1], max: [1, 2, 1] });
    assert.deepEqual(triangleNormal(box, 4), [0, -1, 0], 'the bottom faces down');
    assert.deepEqual(triangleNormal(box, 6), [0, 1, 0], 'the top faces up');
    assert.deepEqual(triangleOf(box, 0)[0], [-1, 0, -1]);
    assert.throws(() => buildMesh({ positions: [0, 0, 0], indices: [0, 0] }), /threes/);
    assert.throws(() => buildMesh({ positions: [0, 0, 0], indices: [0, 0, 1] }), /past the positions/);
    const big = buildMesh(mergeGeometry(Array.from({ length: 20 }, (_, i) => ({ ...boxGeometry([0, 0, 0], [0.5, 0.5, 0.5]), offset: /** @type {[number, number, number]} */ ([i, 0, 0]) }))));
    assert.equal(big.triangles, 240);
    assert.ok(big.root.left && big.root.right, 'more than a leaf splits');
    assert.deepEqual(normalize([0, 0, 0]), [0, 1, 0]);
  });

  it('casts rays: nearest hit, its face, misses and the reach', () => {
    const down = raycast(box, [0.2, 10, 0.3], [0, -1, 0]);
    assert.ok(down);
    assert.ok(close(down.t, 8) && close(down.point[1], 2));
    assert.deepEqual(down.normal, [0, 1, 0]);
    assert.equal(raycast(box, [5, 10, 5], [0, -1, 0]), null);
    assert.equal(raycast(box, [0, 10, 0], [0, -1, 0], 5), null, 'beyond the reach');
    const side = raycast(box, [-5, 1, 0], [1, 0, 0]);
    assert.ok(side && close(side.point[0], -1));
    assert.deepEqual(side.normal, [-1, 0, 0], 'the face the ray came through');
    assert.equal(rayTriangle([0, 1, 0], [1, 0, 0], [0, 0, 0], [1, 0, 0], [0, 0, 1]), null, 'parallel');
    const rock = buildMesh(prismGeometry(0, 0, 1, 0, 3, 8));
    assert.ok(raycast(rock, [0, 1.5, -5], [0, 0, 1]), 'a prism has sides');
    const cap = raycast(rock, [0, 9, 0], [0, -1, 0]);
    assert.ok(cap && close(cap.point[1], 3, 1e-9), 'and a cap');
    assert.deepEqual(cap.normal, [0, 1, 0]);
  });

  it('finds the closest point of a triangle in every region', () => {
    /** @type {[number, number, number][]} */
    const [a, b, c] = [[0, 0, 0], [2, 0, 0], [0, 0, 2]];
    assert.deepEqual(closestOnTriangle([-1, 0, -1], a, b, c), a);
    assert.deepEqual(closestOnTriangle([3, 0, -1], a, b, c), b);
    assert.deepEqual(closestOnTriangle([-1, 0, 3], a, b, c), c);
    assert.deepEqual(closestOnTriangle([1, 0, -1], a, b, c), [1, 0, 0]);
    assert.deepEqual(closestOnTriangle([-1, 0, 1], a, b, c), [0, 0, 1]);
    const hyp = closestOnTriangle([2, 0, 2], a, b, c);
    assert.ok(close(hyp[0], 1) && close(hyp[2], 1));
    assert.deepEqual(closestOnTriangle([0.5, 3, 0.5], a, b, c), [0.5, 0, 0.5]);
  });

  it('touches, pushes out, slides and sweeps spheres', () => {
    const floor = buildMesh(planeGeometry(-10, -10, 10, 10));
    const contacts = sphereContacts(floor, [0, 0.3, 0], 0.5);
    assert.ok(contacts.length >= 1 && close(contacts[0].depth, 0.2) && close(contacts[0].normal[1], 1));
    assert.deepEqual(sphereContacts(floor, [0, 2, 0], 0.5), []);
    const flat = sphereContacts(floor, [0, 0, 0], 0.5);
    assert.ok(close(flat[0].normal[1], 1), 'a centre on the surface pushes out along the face');
    const out = resolveSphere(box, [1.2, 1, 0], 0.5);
    assert.ok(out.hit && out.center[0] >= 1.5 - 1e-5 && out.tags.includes('rock'));
    assert.deepEqual(resolveSphere(box, [5, 1, 5], 0.5), { center: [5, 1, 5], hit: false, normal: null, tags: [] });
    // walking diagonally into the wall slides along it
    const slid = resolveSphere(box, [1.3, 1, 0.8], 0.5);
    assert.ok(slid.center[2] > 0.79, 'the tangential part of the move survives');
    const wall = buildMesh(boxGeometry([0, 0, -5], [0.05, 2, 5]), new Array(12).fill('wall'));
    const swept = sweepSphere(wall, [-2, 1, 0], [3, 1, 0], 0.4);
    assert.ok(swept.hit && swept.center[0] < 0, 'no tunnelling through a thin wall');
    assert.deepEqual(swept.tags, ['wall']);
    assert.equal(sweepSphere(wall, [-3, 1, 0], [-2, 1, 0], 0.4).hit, false);
    assert.ok(boxesOverlap({ min: [0, 0, 0], max: [1, 1, 1] }, { min: [0.5, 0.5, 0.5], max: [2, 2, 2] }));
    assert.equal(boxesOverlap({ min: [0, 0, 0], max: [1, 1, 1] }, { min: [2, 0, 0], max: [3, 1, 1] }), false);
    assert.deepEqual(queryBox(box, { min: [5, 5, 5], max: [6, 6, 6] }), []);
  });

  it('carries a pixel back into the world, and tests convex polygons', () => {
    const view = viewOf(HOME_CAMERA, 960, 640);
    const [sx, sy] = project(view, 3, 0.5, -2);
    const ray = screenRay(view, sx, sy);
    assert.ok(ray);
    const to = [3 - ray.origin[0], 0.5 - ray.origin[1], -2 - ray.origin[2]];
    const along = to[0] * ray.direction[0] + to[1] * ray.direction[1] + to[2] * ray.direction[2];
    const miss = Math.hypot(to[0] - ray.direction[0] * along, to[1] - ray.direction[1] * along, to[2] - ray.direction[2] * along);
    assert.ok(miss < 1e-6, `the ray passes through the projected point (${miss})`);
    assert.equal(invert4(new Float64Array(16)), null);
    assert.equal(screenRay({ matrix: new Float64Array(16), width: 1, height: 1 }, 0, 0), null);
    const a = [0, 0, 2, 0, 2, 2, 0, 2];
    const hit = satPolygons(a, [1, 1, 3, 1, 3, 3, 1, 3]);
    assert.ok(hit.overlap && close(hit.depth, 1));
    assert.ok(hit.axis[0] < 0 || hit.axis[1] < 0, 'the push points from b toward a');
    assert.equal(satPolygons(a, [3, 0, 4, 0, 4, 1]).overlap, false);
    assert.equal(satPolygons([0.6, 0.2, 0.6, 0.2, 0.9, 0.3, 0.8, 0.6], [0, 0, 1, 0, 1, 1]).overlap, true, 'a repeated corner is skipped');
    assert.equal(pointInPolygon(1, 1, a), true);
    assert.equal(pointInPolygon(3, 1, a), false);
  });
});

describe('ragdoll liveliness', () => {
  it('stands in its pose, exactly, while nothing disturbs it', () => {
    const rag = createRagdoll(POSES.dance);
    const pose = skeleton(POSES.dance);
    const sk = ragdollSkeleton(rag);
    for (const name of JOINTS) assert.deepEqual(sk[/** @type {keyof typeof sk} */ (name)], pose[/** @type {keyof typeof pose} */ (name)]);
    assert.equal(ragdollStretch(rag), 0);
    assert.equal(LINKS.length, 12);
    for (let i = 0; i < 60; i++) stepRagdoll(rag, POSES.dance, 1 / 60);
    // gravity sags a held pose a little; the muscles hold it close
    const settled = ragdollSkeleton(rag);
    assert.ok(Math.hypot(settled.skull[0] - pose.skull[0], settled.skull[1] - pose.skull[1]) < 0.12);
    assert.ok(ragdollEnergy(rag) < 0.01);
  });

  it('flails when knocked, goes limp on a hard knock, and finds its feet again', () => {
    const rag = createRagdoll(POSES.jubilant, { head: 'tv', params: { tone: 20 } });
    assert.equal(rag.params.tone, 20);
    assert.equal(rag.params.gravity, RAGDOLL_DEFAULTS.gravity);
    kickRagdoll(rag, [9, 4]);
    assert.ok(rag.limp > 0.5, 'a hard knock goes limp');
    let worst = 0;
    for (let i = 0; i < 30; i++) {
      stepRagdoll(rag, POSES.jubilant, 1 / 60, { bounce: 0.05 });
      worst = Math.max(worst, ragdollStretch(rag));
      for (let j = 0; j < JOINTS.length; j++) assert.ok(rag.pos[j * 2 + 1] >= 0, 'nothing sinks through the floor');
    }
    assert.ok(worst < 0.25, `bones stay near their length (${worst})`);
    assert.ok(ragdollEnergy(rag) > 0.001, 'still moving mid-tumble');
    stepRagdoll(rag, POSES.jubilant, 3); // a long frame is split, never explodes
    for (let i = 0; i < 120; i++) stepRagdoll(rag, POSES.jubilant, 1 / 60);
    assert.equal(rag.limp, 0, 'recovered');
    assert.ok(ragdollEnergy(rag) < 0.01, 'settled');
    const soft = createRagdoll(POSES.dance);
    kickRagdoll(soft, [1, 0], { joint: 4, spread: 0.3 });
    assert.equal(soft.limp, 0, 'a nudge is not a tumble');
    assert.ok(Math.abs(soft.pos[4 * 2] - soft.prev[4 * 2]) > Math.abs(soft.pos[8 * 2] - soft.prev[8 * 2]), 'strongest where it landed');
    kickRagdoll(soft, [0, -1], { limp: 0.4 });
    assert.equal(soft.limp, 0.4);
  });

  it('draws as the same cut-out figure', () => {
    const shape = skeletonShape(ragdollSkeleton(createRagdoll(POSES.lift)), { head: 'round' });
    assert.equal(shape.strokes.length, 5);
    assert.equal(shape.dots.length, 1);
  });
});

/** A Web Audio context that records the graph it is asked to build. */
function fakeAudioContext() {
  /** @type {any[]} */
  const events = [];
  const param = (/** @type {string} */ name) => ({
    value: 0,
    setValueAtTime: (/** @type {number} */ v, /** @type {number} */ t) => events.push([name, 'set', v, t]),
    linearRampToValueAtTime: (/** @type {number} */ v, /** @type {number} */ t) => events.push([name, 'linear', v, t]),
    exponentialRampToValueAtTime: (/** @type {number} */ v, /** @type {number} */ t) => events.push([name, 'exp', v, t]),
  });
  const node = (/** @type {string} */ kind) => ({
    kind,
    connect: () => {},
    start: (/** @type {number} */ t) => events.push([kind, 'start', t]),
    stop: (/** @type {number} */ t) => events.push([kind, 'stop', t]),
    gain: param(`${kind}.gain`), frequency: param(`${kind}.frequency`), Q: param(`${kind}.Q`),
    type: '', buffer: null,
  });
  const ctx = {
    events, state: 'running', currentTime: 1, sampleRate: 8000, destination: {},
    createGain: () => node('gain'), createOscillator: () => node('osc'), createBiquadFilter: () => node('filter'),
    createBufferSource: () => node('noise'),
    buffers: 0,
    createBuffer: (/** @type {number} */ _c, /** @type {number} */ length) => { ctx.buffers += 1; const data = new Float32Array(length); return { getChannelData: () => data }; },
    resume: () => { ctx.state = 'running'; events.push(['ctx', 'resume']); },
    suspend: () => { ctx.state = 'suspended'; events.push(['ctx', 'suspend']); },
    close: () => events.push(['ctx', 'close']),
  };
  return ctx;
}

function fakeTimers() {
  /** @type {Map<number, Function>} */
  const jobs = new Map();
  let next = 1;
  return { jobs, setInterval: (/** @type {Function} */ fn) => { jobs.set(next, fn); return next++; }, clearInterval: (/** @type {number} */ id) => { jobs.delete(id); } };
}

describe('audio', () => {
  it('reads scores as data: notes, scales, tracks and the tape as a melody', () => {
    assert.equal(noteFrequency(69), 440);
    assert.ok(close(noteFrequency(81), 880));
    assert.deepEqual(PENTATONIC, [0, 2, 4, 7, 9]);
    const desk = TRACKS.desk;
    assert.equal(degreeNote(desk, 0), 60);
    assert.equal(degreeNote(desk, 5), 72, 'past the scale climbs an octave');
    assert.equal(degreeNote(desk, -1), 57, 'below descends');
    assert.equal(degreeNote(desk, 1, -1), 50);
    assert.deepEqual(tapeMelody([0, 1, 2, 0, 5, 3], 3, 1, 4), [null, 4, 2, null]);
    const events = trackEvents(desk, { melody: [0, null, 2] });
    assert.ok(events.some((e) => e.voice === 'bell' && e.note === degreeNote(desk, 2, 1)));
    assert.ok(events.every((e, i) => i === 0 || events[i - 1].step <= e.step), 'in step order');
    assert.equal(stepSeconds({ ...desk, bpm: 120 }), 0.125);
    for (const [name, recipe] of Object.entries(SFX)) assert.ok(recipe.voices.length > 0, name);
  });

  it('plays effects and tracks on a context opened lazily, and honours the mix', () => {
    const ctx = fakeAudioContext();
    const timers = fakeTimers();
    const audio = createAudio({ createContext: () => ctx, timers });
    assert.equal(audio.ready, false);
    assert.equal(audio.unlock(), true);
    assert.equal(audio.ready, true);
    assert.equal(audio.sfx('chime', { pitch: 2 }), true);
    assert.ok(ctx.events.some((e) => e[0] === 'osc.frequency' && e[1] === 'set' && close(e[2], 2093)), 'pitched up an octave');
    assert.equal(audio.sfx('step'), true, 'noise voices');
    audio.sfx('whoosh');
    assert.equal(ctx.buffers, 1, 'one noise buffer, made once');
    assert.equal(audio.sfx('no-such-sound'), false);
    assert.equal(audio.play('grove', { melody: () => [0, 1, 2] }), true);
    assert.equal(audio.track?.bpm, 96);
    const before = audio.log.filter((e) => e.kind === 'note').length;
    assert.ok(before > 0, 'the first notes are scheduled at once');
    ctx.currentTime += 1;
    for (const job of timers.jobs.values()) job();
    assert.ok(audio.log.filter((e) => e.kind === 'note').length > before, 'the beat keeps going');
    audio.setTempo(300);
    assert.equal(audio.track?.bpm, 220, 'tempo is clamped');
    audio.pause();
    assert.ok(ctx.events.some((e) => e[1] === 'suspend'));
    assert.equal(audio.sfx('pop'), false, 'silent while paused');
    const paused = audio.log.length;
    audio.pump();
    assert.equal(audio.log.length, paused);
    audio.resume();
    ctx.state = 'suspended';
    audio.unlock();
    assert.ok(ctx.events.filter((e) => e[1] === 'resume').length >= 2);
    audio.setMix({ muted: true });
    assert.equal(audio.sfx('pop'), false, 'muted');
    audio.setMix({ muted: false, sfx: 0.2 });
    assert.equal(audio.mix.sfx, 0.2);
    assert.equal(audio.play(TRACKS.arena, { bpm: 90 }), true);
    assert.equal(audio.track?.bpm, 90);
    assert.equal(audio.play('no-such-track'), false);
    audio.stop();
    assert.equal(audio.track, null);
    assert.equal(timers.jobs.size, 0, 'the scheduler stops with the music');
    audio.dispose();
    assert.ok(ctx.events.some((e) => e[1] === 'close'));
  });

  it('plays every track, every instrument in it', () => {
    const ctx = fakeAudioContext();
    const audio = createAudio({ createContext: () => ctx, timers: fakeTimers() });
    /** @type {Set<string>} */
    const played = new Set();
    for (const name of Object.keys(TRACKS)) {
      assert.equal(audio.play(name, { melody: () => [0, 2, 4, 1] }), true, name);
      for (let bar = 0; bar < 2; bar++) {
        ctx.currentTime += stepSeconds(TRACKS[name]) * TRACKS[name].steps;
        audio.pump();
        // the log keeps only the latest notes: read it as the music goes
        for (const e of audio.log) if (e.kind === 'note') played.add(e.name);
      }
    }
    const named = new Set(Object.values(TRACKS).flatMap((t) => Object.values(t.parts ?? t.voices ?? {}).map((v) => /** @type {any} */ (v).instrument)));
    for (const instrument of named) assert.ok(played.has(instrument), `${instrument} is heard`);
    audio.dispose();
  });

  it('stays silent, never failing, where there is no audio', () => {
    const none = createAudio({ timers: fakeTimers() });
    assert.equal(none.unlock(), false);
    assert.equal(none.sfx('pop'), false);
    assert.equal(none.play('desk'), false);
    const broken = createAudio({ createContext: () => { throw new Error('no audio here'); }, timers: fakeTimers() });
    assert.equal(broken.sfx('pop'), false);
    none.pause();
    none.resume();
    none.setTempo(100);
    none.dispose();
  });
});

describe('effects', () => {
  const view = viewOf(HOME_CAMERA, 960, 640);
  const theme = { ink: '#11131c' };

  it('eases, tweens and springs', () => {
    for (const [name, ease] of Object.entries(EASE)) {
      assert.ok(close(ease(0), 0), `${name}(0)`);
      assert.ok(close(ease(1), 1), `${name}(1)`);
    }
    assert.equal(tween(0, 10, 2), 10, 'clamped');
    assert.equal(tween(0, 10, 0.5, EASE.linear), 5);
    let x = 0;
    let v = 0;
    for (let i = 0; i < 400; i++) [x, v] = spring(x, v, 1, 120, 18, 1 / 60);
    assert.ok(close(x, 1, 1e-3));
  });

  it('emits, moves and retires particles of every kind, deterministically', () => {
    const kinds = /** @type {const} */ (['confetti', 'sparks', 'radiance', 'ripple', 'dust', 'notes', 'stars', 'hearts']);
    const fx = createFx(3);
    for (const kind of kinds) assert.ok(emit(fx, kind, [0, 1, 0], { colors: ['#2563eb'] }) > 0, kind);
    assert.equal(emit(fx, /** @type {any} */ ('nope'), [0, 0, 0]), 0);
    stepFx(fx, 0.05);
    const groups = fxGroups(fx, view, theme);
    assert.equal(groups.length, fx.particles.length);
    for (const kind of kinds) {
      const solo = createFx(1);
      emit(solo, kind, [0, 1, 0], { count: 1 });
      stepFx(solo, 0.05);
      assert.ok(fxGroups(solo, view, theme)[0].items.length > 0, `${kind} draws`);
    }
    const twin = createFx(3);
    for (const kind of kinds) emit(twin, kind, [0, 1, 0], { colors: ['#2563eb'] });
    stepFx(twin, 0.05);
    assert.deepEqual(twin.particles, fx.particles, 'same seed, same picture');
    const confetti = fx.particles.find((p) => p.kind === 'confetti');
    const y0 = confetti?.y ?? 0;
    for (let i = 0; i < 20; i++) stepFx(fx, 0.05);
    assert.ok((fx.particles.find((p) => p.kind === 'confetti')?.y ?? 0) < y0 + 4, 'gravity wins');
    for (let i = 0; i < 40; i++) stepFx(fx, 0.1);
    assert.equal(fx.particles.length, 0, 'everything retires');
    const flood = createFx();
    emit(flood, 'confetti', [0, 0, 0], { count: FX_MAX + 50 });
    assert.equal(flood.particles.length, FX_MAX);
    assert.equal(emit(flood, 'sparks', [0, 0, 0]), 0, 'a storm degrades, never stalls');
    const behind = createFx();
    emit(behind, 'dust', [0, 0, 500], { count: 1 });
    assert.equal(fxGroups(behind, view, theme).length, 0, 'behind the eye draws nothing');
  });

  it('shakes and flashes the frame', () => {
    const fx = createFx();
    assert.deepEqual(shakeOffset(fx), [0, 0]);
    shake(fx, 10, 0.5);
    shake(fx, 2);
    assert.equal(fx.shake.amp, 10, 'a small shake never cuts a big one short');
    stepFx(fx, 0.05);
    const [dx, dy] = shakeOffset(fx);
    assert.ok(Math.abs(dx) + Math.abs(dy) > 0);
    for (let i = 0; i < 12; i++) stepFx(fx, 0.05);
    assert.deepEqual(shakeOffset(fx), [0, 0]);
    assert.deepEqual(overlayItems(fx, 10, 10), []);
    flash(fx, '#fde68a', 0.2);
    assert.equal(overlayItems(fx, 10, 10)[0].t, 'rect');
    stepFx(fx, 0.1);
    stepFx(fx, 0.1);
    assert.equal(fx.flash, null);
  });
});

describe('the camera director', () => {
  it('cuts, travels between named shots, and interpolates the short way round', () => {
    const d = createDirector();
    assert.ok(d.shots.includes('crane'));
    assert.equal(d.cut('nowhere'), false);
    assert.equal(d.move('nowhere'), false);
    assert.equal(d.cut('close'), true);
    assert.equal(d.camera.distance, SHOTS.close.distance);
    d.move('wide', { ms: 400 });
    assert.equal(d.moving, true);
    const mid = d.step(200);
    assert.ok(mid.distance > SHOTS.close.distance && mid.distance < SHOTS.wide.distance);
    d.step(250);
    assert.equal(d.moving, false);
    assert.equal(d.camera.distance, SHOTS.wide.distance);
    const wrap = lerpCamera({ ...HOME_CAMERA, azimuth: 3 }, { ...HOME_CAMERA, azimuth: -3 }, 0.5);
    assert.ok(Math.abs(Math.abs(wrap.azimuth) - Math.PI) < 0.01, 'through π, not through 0');
    assert.deepEqual(lerpCamera({ ...HOME_CAMERA, target: [0, 0, 0] }, { ...HOME_CAMERA, target: [2, 0, 4] }, 0.5).target, [1, 0, 2]);
    assert.equal(lerpCamera(HOME_CAMERA, HOME_CAMERA, 0.5).target, undefined);
  });

  it('follows a figure with lag, drifts only while idle, yields to the hand, and shakes', () => {
    const d = createDirector(HOME_CAMERA);
    /** @type {[number, number, number]} */
    let at = [0, 0, 0];
    d.follow(() => at, { lag: 0.05 });
    d.step(16);
    at = [10, 0, 0];
    const first = d.step(100);
    assert.ok(first.target && first.target[0] > 0 && first.target[0] < 10, 'lags behind');
    for (let i = 0; i < 60; i++) d.step(100);
    assert.ok(d.camera.target && close(d.camera.target[0], 10, 1e-3), 'catches up');
    d.follow(null);
    d.orbit(0.5);
    d.hand({ ...d.camera, azimuth: 1 });
    d.step(1000);
    assert.equal(d.camera.azimuth, 1, 'no drift right after the hand');
    d.step(HAND_IDLE_MS);
    d.step(1000);
    assert.ok(d.camera.azimuth > 1, 'drifts once idle');
    d.shake(0.05, 300);
    const shaken = d.step(16);
    assert.notEqual(shaken.azimuth, d.camera.azimuth);
    d.step(250);
    d.step(250);
    assert.equal(d.step(16).azimuth, d.camera.azimuth, 'settled');
    const free = createDirector(HOME_CAMERA, { limits: false });
    free.cut({ ...HOME_CAMERA, distance: 500 });
    assert.equal(free.camera.distance, 500);
    const bounded = createDirector();
    bounded.cut({ ...HOME_CAMERA, distance: 500 });
    assert.ok(bounded.camera.distance < 500);
  });
});

describe('lighting', () => {
  /** @param {string} hex */
  const luma = (hex) => {
    const n = Number.parseInt(hex.slice(1), 16);
    return 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  };

  it('moves the sun through the day and the moon through the night', () => {
    const noon = sunAt(12);
    const dusk = sunAt(18.5);
    assert.ok(noon.sun[1] > 0.9 && !noon.night);
    assert.ok(dusk.night && dusk.sun[1] < noon.sun[1]);
    assert.ok(sunAt(7).sun[0] > 0 && sunAt(17).sun[0] < 0, 'east to west');
    assert.match(noon.sunColor, /^#[0-9a-f]{6}$/i);
    assert.deepEqual(sunAt(36), sunAt(12), 'hours wrap');
    assert.equal(createLighting({ bands: 99 }).bands, 6);
    assert.equal(createLighting({ hour: 23 }).night, true);
    assert.equal(hourForTheme('dark'), 23);
    assert.equal(hourForTheme('light'), 10);
  });

  it('cel-shades faces by the light and casts shadows that lengthen with the hour', () => {
    const light = createLighting({ hour: 12 });
    const top = shade('#2563eb', [0, 1, 0], light);
    const under = shade('#2563eb', [0, -1, 0], light);
    assert.ok(luma(top) > luma(under), 'a face to the sun is brighter');
    assert.ok(luma(under) > 0, 'ambient keeps the shadow side readable');
    const block = { x0: 0, x1: 1, z0: 0, z1: 1, h: 2 };
    const area = (/** @type {number[]} */ p) => {
      let s = 0;
      for (let i = 0; i < p.length; i += 2) s += p[i] * p[(i + 3) % p.length] - p[(i + 2) % p.length] * p[i + 1];
      return Math.abs(s) / 2;
    };
    const high = shadowPolygon(block, sunAt(12).sun);
    const low = shadowPolygon(block, sunAt(8).sun);
    assert.ok(area(low) > area(high), 'a low sun casts a longer shadow');
    assert.deepEqual(shadowPolygon(block, [0, -1, 0]), []);
    assert.deepEqual(shadowPolygon({ ...block, h: 0 }, sunAt(12).sun), []);
    assert.equal(convexHull([[0, 0], [2, 0], [2, 2], [0, 2], [1, 1]]).length, 4);
    assert.equal(convexHull([[0, 0], [1, 1]]).length, 2);
    const spots = followSpots([{ x: 0, z: 0, lead: true }, { x: 1, z: 1 }], ['#fde68a']);
    assert.ok(spots[0].radius > spots[1].radius && spots[1].color === '#fde68a');
    assert.equal(followSpots([{ x: 0, z: 0 }], [])[0].color, '#fde68a');
  });
});

describe('the game lifecycle, loop and controls', () => {
  it('is a jaren-fsm document: start, pause, continue, finish, restart, stop', () => {
    assert.equal(GAME_FLOW.$fsm, '0.1');
    const started = gameStep('title', 'start');
    assert.equal(started.state, 'playing');
    assert.deepEqual(started.effects.map((e) => e.run), ['game', 'sound', 'music']);
    assert.equal(gameStep('playing', 'pause').state, 'paused');
    assert.equal(gameStep('paused', 'resume').state, 'playing');
    assert.equal(gameStep('playing', 'finish').state, 'over');
    assert.equal(gameStep('over', 'restart').state, 'playing');
    assert.equal(gameStep('paused', 'stop').state, 'title');
    assert.deepEqual(gameStep('title', 'pause'), { state: 'title', effects: [], moved: false });
    assert.deepEqual(gameEvents('paused').sort(), ['restart', 'resume', 'stop']);
  });

  it('runs rules at a fixed rate, catches up a little, and freezes while paused', () => {
    /** @type {Function[]} */
    const frames = [];
    let updates = 0;
    /** @type {number[]} */
    const alphas = [];
    const loop = createLoop({
      update: () => { updates += 1; },
      render: (alpha) => { alphas.push(alpha); },
      frame: (cb) => { frames.push(cb); return frames.length; },
      cancel: () => { frames.length = 0; },
      stepMs: 10,
      maxSteps: 3,
    });
    loop.start();
    loop.start();
    assert.equal(loop.running, true);
    loop.tick(0);
    loop.tick(25);
    assert.equal(updates, 2);
    assert.ok(close(alphas.at(-1) ?? 0, 0.5));
    loop.tick(1025);
    assert.equal(updates, 5, 'a long sleep catches up maxSteps, no more');
    loop.pause();
    assert.equal(loop.paused, true);
    loop.tick(1100);
    assert.equal(updates, 5, 'rules frozen');
    assert.equal(alphas.at(-1), 1, 'frames still draw');
    loop.resume();
    loop.tick(5000);
    loop.tick(5010);
    assert.equal(updates, 6, 'paused time never reaches the rules');
    assert.equal(loop.steps, 6);
    loop.stop();
    assert.equal(loop.running, false);
  });

  it('maps keys to actions, never steals typing, and lets go', () => {
    /** @type {Map<string, Function>} */
    const listeners = new Map();
    const target = { addEventListener: (/** @type {string} */ t, /** @type {Function} */ fn) => listeners.set(t, fn), removeEventListener: (/** @type {string} */ t) => listeners.delete(t) };
    /** @type {string[]} */
    const actions = [];
    const input = createInput(target, (action) => actions.push(action));
    const key = (/** @type {string} */ type, /** @type {string} */ k, extra = {}) => listeners.get(type)?.({ key: k, target: { tagName: 'BODY' }, preventDefault() {}, ...extra });
    key('keydown', 'ArrowUp');
    key('keydown', 'ArrowUp', { repeat: true });
    assert.equal(input.isHeld('up'), true);
    key('keyup', 'ArrowUp');
    assert.equal(input.isHeld('up'), false);
    key('keydown', 'w', { target: { tagName: 'INPUT' } });
    key('keydown', 'Escape', { ctrlKey: true });
    key('keydown', 'q');
    key('keydown', 'Escape');
    key('keyup', 'q');
    assert.deepEqual(actions, ['up', 'pause']);
    assert.equal(KEYMAP[' '], 'act');
    input.dispose();
    assert.equal(listeners.size, 0);
    createInput(null, () => {}).dispose();
  });
});
