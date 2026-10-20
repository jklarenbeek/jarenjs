//@ts-check
/**
 * Sound for the OS and its games, synthesized live with Web Audio — no
 * sample files, so it works offline and costs nothing to download.
 *
 * Two halves. The scores are data: every sound effect is a recipe of
 * voices with pitch and loudness envelopes, every track a set of step
 * patterns over a scale, and `trackEvents` turns a bar of a track into
 * the notes it plays — pure, so a test reads the music without a
 * speaker. The desk's track has no fixed melody at all: `tapeMelody`
 * reads the cells under the machine's heads, so the Turing machine
 * composes what you hear while it paints what you see.
 *
 * The player is the other half: `createAudio` wires master, music and
 * effects buses on an AudioContext the host hands in lazily (browsers
 * only allow sound after a gesture), and schedules notes a little ahead
 * of the context's clock so the beat holds while the main thread is busy.
 */

/**
 * @typedef {'sine' | 'square' | 'triangle' | 'sawtooth' | 'noise'} Wave
 * @typedef {{ wave: Wave, freq: [number, number], dur: number, attack?: number, gain?: number, delay?: number,
 *   filter?: { type: 'lowpass' | 'highpass' | 'bandpass', freq: number, q?: number } }} Voice
 * @typedef {{ voices: Voice[] }} Recipe
 * @typedef {{ voice: string, note: number, step: number, length: number, gain: number }} TrackEvent
 * @typedef {{ bpm: number, root: number, scale: number[], steps: number,
 *   parts: Record<string, { instrument: string, pattern: Array<number | null>, octave?: number, gain?: number, length?: number }> }} Track
 * @typedef {{ master: number, music: number, sfx: number, muted: boolean }} Mix
 */

/** The major pentatonic: nothing in it clashes, whatever the tape writes. */
export const PENTATONIC = Object.freeze([0, 2, 4, 7, 9]);

/** Sound effects, as recipes. Frequencies in Hz, times in seconds. */
export const SFX = Object.freeze(/** @type {Record<string, Recipe>} */ ({
  pop: { voices: [{ wave: 'sine', freq: [520, 880], dur: 0.09, gain: 0.5 }] },
  click: { voices: [{ wave: 'square', freq: [1400, 900], dur: 0.03, gain: 0.18 }] },
  step: { voices: [{ wave: 'noise', freq: [1800, 1800], dur: 0.05, gain: 0.18, filter: { type: 'bandpass', freq: 1800, q: 1.2 } }] },
  hop: { voices: [{ wave: 'triangle', freq: [300, 620], dur: 0.12, gain: 0.35 }] },
  land: { voices: [{ wave: 'sine', freq: [180, 70], dur: 0.14, gain: 0.5 }, { wave: 'noise', freq: [600, 600], dur: 0.06, gain: 0.12, filter: { type: 'lowpass', freq: 900 } }] },
  chime: { voices: [{ wave: 'sine', freq: [1046.5, 1046.5], dur: 0.5, gain: 0.32 }, { wave: 'sine', freq: [1568, 1568], dur: 0.45, gain: 0.18, delay: 0.06 }] },
  coin: { voices: [{ wave: 'square', freq: [988, 988], dur: 0.07, gain: 0.2 }, { wave: 'square', freq: [1319, 1319], dur: 0.22, gain: 0.2, delay: 0.07 }] },
  right: { voices: [{ wave: 'triangle', freq: [659, 659], dur: 0.12, gain: 0.35 }, { wave: 'triangle', freq: [988, 988], dur: 0.26, gain: 0.35, delay: 0.1 }] },
  wrong: { voices: [{ wave: 'sawtooth', freq: [220, 160], dur: 0.22, gain: 0.18, filter: { type: 'lowpass', freq: 900 } }] },
  whoosh: { voices: [{ wave: 'noise', freq: [400, 3200], dur: 0.35, gain: 0.22, filter: { type: 'bandpass', freq: 1200, q: 0.7 } }] },
  veto: { voices: [{ wave: 'sine', freq: [140, 48], dur: 0.45, gain: 0.7 }, { wave: 'noise', freq: [300, 300], dur: 0.2, gain: 0.3, filter: { type: 'lowpass', freq: 500 } }] },
  pass: { voices: [{ wave: 'triangle', freq: [523, 523], dur: 0.14, gain: 0.3 }, { wave: 'triangle', freq: [784, 784], dur: 0.32, gain: 0.3, delay: 0.12 }] },
  levelup: { voices: [523.25, 659.25, 783.99, 1046.5].map((f, i) => (/** @type {Voice} */ ({ wave: 'square', freq: [f, f], dur: 0.16, gain: 0.16, delay: i * 0.09 }))) },
  type: { voices: [{ wave: 'noise', freq: [4000, 4000], dur: 0.015, gain: 0.08, filter: { type: 'highpass', freq: 3000 } }] },
  open: { voices: [{ wave: 'sine', freq: [392, 784], dur: 0.12, gain: 0.25 }] },
  close: { voices: [{ wave: 'sine', freq: [784, 392], dur: 0.12, gain: 0.25 }] },
  splash: { voices: [{ wave: 'noise', freq: [900, 300], dur: 0.4, gain: 0.25, filter: { type: 'lowpass', freq: 1400 } }] },
  start: { voices: [392, 523.25, 659.25].map((f, i) => (/** @type {Voice} */ ({ wave: 'triangle', freq: [f, f], dur: 0.2, gain: 0.25, delay: i * 0.08 }))) },
  stop: { voices: [659.25, 523.25, 392].map((f, i) => (/** @type {Voice} */ ({ wave: 'triangle', freq: [f, f], dur: 0.2, gain: 0.25, delay: i * 0.08 }))) },
}));

/** Instruments the tracks play, as recipe builders over a frequency. */
const INSTRUMENTS = Object.freeze(/** @type {Record<string, (f: number, len: number) => Voice[]>} */ ({
  kick: () => [{ wave: 'sine', freq: [150, 42], dur: 0.22, gain: 0.8 }],
  snare: () => [{ wave: 'noise', freq: [1500, 1500], dur: 0.12, gain: 0.32, filter: { type: 'bandpass', freq: 1500, q: 0.8 } }, { wave: 'triangle', freq: [220, 180], dur: 0.08, gain: 0.2 }],
  hat: () => [{ wave: 'noise', freq: [8000, 8000], dur: 0.035, gain: 0.12, filter: { type: 'highpass', freq: 6500 } }],
  bass: (f, len) => [{ wave: 'triangle', freq: [f, f], dur: len, gain: 0.42 }],
  lead: (f, len) => [{ wave: 'square', freq: [f, f], dur: len, gain: 0.12, filter: { type: 'lowpass', freq: 2400 } }],
  bell: (f, len) => [{ wave: 'sine', freq: [f, f], dur: len * 1.6, gain: 0.22 }, { wave: 'sine', freq: [f * 2, f * 2], dur: len, gain: 0.08 }],
  marimba: (f, len) => [{ wave: 'triangle', freq: [f, f], dur: Math.min(0.3, len), gain: 0.3 }, { wave: 'sine', freq: [f * 4, f * 4], dur: 0.05, gain: 0.06 }],
  pad: (f, len) => [{ wave: 'sawtooth', freq: [f, f], dur: len, attack: len * 0.3, gain: 0.07, filter: { type: 'lowpass', freq: 900 } }],
}));

/** The tracks: step patterns of scale degrees (null rests), 16 steps a bar. */
export const TRACKS = Object.freeze(/** @type {Record<string, Track>} */ ({
  desk: {
    bpm: 112, root: 60, scale: [...PENTATONIC], steps: 16,
    parts: {
      kick: { instrument: 'kick', pattern: [0, null, null, null, 0, null, null, null, 0, null, null, null, 0, null, null, 0] },
      hat: { instrument: 'hat', pattern: [null, null, 0, null, null, null, 0, null, null, null, 0, null, null, null, 0, 0] },
      bass: { instrument: 'bass', octave: -2, length: 2, pattern: [0, null, null, null, null, null, 3, null, 0, null, null, null, 4, null, 3, null] },
    },
  },
  grove: {
    bpm: 96, root: 62, scale: [...PENTATONIC], steps: 16,
    parts: {
      marimba: { instrument: 'marimba', pattern: [0, null, 2, null, 4, null, 2, 3, 4, null, 3, null, 2, null, 1, null] },
      bass: { instrument: 'bass', octave: -2, length: 3, pattern: [0, null, null, null, 3, null, null, null, 4, null, null, null, 3, null, null, null] },
      hat: { instrument: 'hat', gain: 0.6, pattern: [null, null, 0, null, null, null, 0, null, null, null, 0, null, null, null, 0, null] },
    },
  },
  dancers: {
    bpm: 124, root: 57, scale: [...PENTATONIC], steps: 16,
    parts: {
      kick: { instrument: 'kick', pattern: [0, null, null, null, 0, null, null, null, 0, null, null, null, 0, null, null, null] },
      snare: { instrument: 'snare', pattern: [null, null, null, null, 0, null, null, null, null, null, null, null, 0, null, null, null] },
      hat: { instrument: 'hat', pattern: [null, 0, null, 0, null, 0, null, 0, null, 0, null, 0, null, 0, null, 0] },
      bass: { instrument: 'bass', octave: -2, pattern: [0, null, 0, null, 3, null, 3, null, 4, null, 4, null, 3, null, 1, null] },
    },
  },
  arena: {
    bpm: 140, root: 64, scale: [...PENTATONIC], steps: 16,
    parts: {
      kick: { instrument: 'kick', pattern: [0, null, null, 0, null, null, 0, null, 0, null, null, 0, null, null, 0, null] },
      hat: { instrument: 'hat', pattern: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
      lead: { instrument: 'lead', pattern: [0, 2, 4, 5, 4, 2, null, 0, 1, 3, 5, 6, 5, 3, null, 1] },
    },
  },
  title: {
    bpm: 84, root: 60, scale: [...PENTATONIC], steps: 16,
    parts: {
      pad: { instrument: 'pad', octave: -1, length: 8, pattern: [0, null, null, null, null, null, null, null, 3, null, null, null, null, null, null, null] },
      bell: { instrument: 'bell', pattern: [4, null, null, 2, null, null, 5, null, null, null, 4, null, 3, null, null, null] },
    },
  },
}));

/**
 * The frequency of a MIDI note.
 * @param {number} midi @returns {number}
 */
export function noteFrequency(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * The MIDI note of a scale degree (degrees past the scale climb octaves;
 * negative ones descend).
 * @param {Track} track @param {number} degree @param {number} [octave]
 */
export function degreeNote(track, degree, octave = 0) {
  const n = track.scale.length;
  const wrapped = ((degree % n) + n) % n;
  const climb = Math.floor(degree / n);
  return track.root + track.scale[wrapped] + 12 * (climb + octave);
}

/**
 * The notes one bar of a track plays: every part's pattern, at the given
 * step offsets. A `melody` (from the tape) joins as a bell part.
 * @param {Track} track
 * @param {{ melody?: Array<number | null> }} [extra]
 * @returns {TrackEvent[]} in step order
 */
export function trackEvents(track, extra = {}) {
  /** @type {TrackEvent[]} */
  const events = [];
  for (const part of Object.values(track.parts)) {
    part.pattern.forEach((degree, step) => {
      if (degree === null) return;
      events.push({ voice: part.instrument, note: degreeNote(track, degree, part.octave ?? 0), step, length: part.length ?? 1, gain: part.gain ?? 1 });
    });
  }
  extra.melody?.forEach((degree, step) => {
    if (degree !== null && step < track.steps) events.push({ voice: 'bell', note: degreeNote(track, degree, 1), step, length: 1, gain: 0.8 });
  });
  return events.sort((a, b) => a.step - b.step);
}

/**
 * The tape as a melody: one step per column of the row under the lead
 * head, a written symbol becoming a scale degree, paper a rest — so a
 * program that paints in rhythm is heard in rhythm.
 * @param {readonly number[]} tape @param {number} width @param {number} row @param {number} [steps]
 * @returns {Array<number | null>}
 */
export function tapeMelody(tape, width, row, steps = 16) {
  /** @type {Array<number | null>} */
  const out = [];
  for (let i = 0; i < steps; i++) {
    const symbol = tape[row * width + (i % width)] ?? 0;
    out.push(symbol === 0 ? null : symbol - 1);
  }
  return out;
}

/** Seconds per step of a track (four steps a beat). @param {Track} track */
export const stepSeconds = (track) => 60 / track.bpm / 4;

/**
 * The player.
 * @param {{ createContext?: () => any, timers?: { setInterval: Function, clearInterval: Function }, mix?: Partial<Mix> }} [options]
 */
export function createAudio(options = {}) {
  const timers = options.timers ?? globalThis;
  /** @type {Mix} */
  const mix = { master: 0.8, music: 0.55, sfx: 0.8, muted: false, ...options.mix };
  /** @type {any} */
  let ctx = null;
  /** @type {any} */
  let buses = null;
  /** @type {any} */
  let noise = null;
  /** @type {{ track: Track, melody: () => Array<number | null>, next: number, step: number, timer: any } | null} */
  let playing = null;
  let suspended = false;
  /** Played effects and notes, newest last (the last 64), for the HUD and tests. */
  /** @type {Array<{ kind: 'sfx' | 'note', name: string, at: number }>} */
  const log = [];

  const remember = (/** @type {'sfx' | 'note'} */ kind, /** @type {string} */ name, /** @type {number} */ at) => {
    log.push({ kind, name, at });
    if (log.length > 64) log.shift();
  };

  /** Open the context on first use: a browser allows it only after a gesture. */
  function context() {
    if (ctx || !options.createContext) return ctx;
    try { ctx = options.createContext(); }
    catch { ctx = null; }
    if (!ctx) return null;
    const master = ctx.createGain();
    const music = ctx.createGain();
    const sfx = ctx.createGain();
    music.connect(master);
    sfx.connect(master);
    master.connect(ctx.destination);
    buses = { master, music, sfx };
    applyMix();
    return ctx;
  }

  function applyMix() {
    if (!buses) return;
    buses.master.gain.value = mix.muted ? 0 : mix.master;
    buses.music.gain.value = mix.music;
    buses.sfx.gain.value = mix.sfx;
  }

  /** A second of white noise, made once. */
  function noiseBuffer() {
    if (noise) return noise;
    const length = Math.floor(ctx.sampleRate ?? 44100);
    noise = ctx.createBuffer(1, length, ctx.sampleRate ?? 44100);
    const data = noise.getChannelData(0);
    let seed = 0x2f6b;
    for (let i = 0; i < length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      data[i] = (seed / 0x3fffffff) - 1;
    }
    return noise;
  }

  /**
   * Play one voice at `at` on the given bus.
   * @param {Voice} v @param {number} at @param {any} bus @param {number} level
   */
  function voice(v, at, bus, level) {
    const start = at + (v.delay ?? 0);
    const end = start + v.dur;
    const amp = ctx.createGain();
    const peak = Math.max(0.0001, (v.gain ?? 0.3) * level);
    const attack = Math.min(v.dur * 0.5, v.attack ?? 0.005);
    amp.gain.setValueAtTime(0.0001, start);
    amp.gain.linearRampToValueAtTime(peak, start + attack);
    amp.gain.exponentialRampToValueAtTime(0.0001, end);
    /** @type {any} */
    let source;
    if (v.wave === 'noise') {
      source = ctx.createBufferSource();
      source.buffer = noiseBuffer();
    }
    else {
      source = ctx.createOscillator();
      source.type = v.wave;
      source.frequency.setValueAtTime(Math.max(1, v.freq[0]), start);
      if (v.freq[1] !== v.freq[0]) source.frequency.exponentialRampToValueAtTime(Math.max(1, v.freq[1]), end);
    }
    let head = source;
    if (v.filter) {
      const filter = ctx.createBiquadFilter();
      filter.type = v.filter.type;
      filter.frequency.setValueAtTime(v.filter.freq, start);
      filter.Q.setValueAtTime(v.filter.q ?? 1, start);
      head.connect(filter);
      head = filter;
    }
    head.connect(amp);
    amp.connect(bus);
    source.start(start);
    source.stop(end + 0.02);
  }

  /** Schedule the steps that fall in the next ~120 ms of the context clock. */
  function pump() {
    if (!playing || !ctx || suspended) return;
    const horizon = ctx.currentTime + 0.12;
    const { track } = playing;
    const length = stepSeconds(track);
    while (playing.next < horizon) {
      const step = playing.step % track.steps;
      for (const e of barEvents(step)) {
        const recipe = INSTRUMENTS[e.voice];
        if (!recipe) continue;
        for (const v of recipe(noteFrequency(e.note), e.length * length)) voice(v, playing.next, buses.music, e.gain);
        remember('note', e.voice, playing.next);
      }
      playing.next += length;
      playing.step += 1;
    }
  }

  /** @type {{ bar: number, events: TrackEvent[] }} */
  let cached = { bar: -1, events: [] };
  /** The events of the current bar at one step; a bar's melody is read once, at its first step.
   * @param {number} step */
  function barEvents(step) {
    if (!playing) return [];
    const bar = Math.floor(playing.step / playing.track.steps);
    if (cached.bar !== bar) cached = { bar, events: trackEvents(playing.track, { melody: playing.melody() }) };
    return cached.events.filter((e) => e.step === step);
  }

  return {
    mix,
    log,
    /** True once a context exists. */
    get ready() { return ctx !== null; },
    /** The track playing, if any. */
    get track() { return playing?.track ?? null; },
    /** Open (or resume) the context — call from a gesture. */
    unlock() {
      const c = context();
      if (c?.state === 'suspended' && !suspended) c.resume?.();
      return c !== null;
    },
    /**
     * Play an effect.
     * @param {string} name @param {{ pitch?: number, gain?: number }} [opts]
     */
    sfx(name, opts = {}) {
      const recipe = SFX[name];
      if (!recipe || mix.muted || suspended || !context()) return false;
      const pitch = opts.pitch ?? 1;
      for (const v of recipe.voices) {
        voice({ ...v, freq: [v.freq[0] * pitch, v.freq[1] * pitch] }, ctx.currentTime + 0.005, buses.sfx, opts.gain ?? 1);
      }
      remember('sfx', name, ctx.currentTime);
      return true;
    },
    /**
     * Start a track (replacing the one playing). `melody` is asked once a
     * bar for the scale degrees the bell plays — the tape, on the desk.
     * @param {string | Track} name @param {{ melody?: () => Array<number | null>, bpm?: number }} [opts]
     */
    play(name, opts = {}) {
      const base = typeof name === 'string' ? TRACKS[name] : name;
      if (!base || !context()) return false;
      this.stop();
      const track = opts.bpm ? { ...base, bpm: opts.bpm } : base;
      playing = { track, melody: opts.melody ?? (() => []), next: ctx.currentTime + 0.05, step: 0, timer: null };
      cached = { bar: -1, events: [] };
      pump();
      playing.timer = timers.setInterval(pump, 25);
      return true;
    },
    /** Stop the music. */
    stop() {
      if (playing) timers.clearInterval(playing.timer);
      playing = null;
    },
    /** Pause everything (the game menu): the context sleeps, the beat waits. */
    pause() {
      suspended = true;
      ctx?.suspend?.();
    },
    /** Pick up where the pause left off. */
    resume() {
      suspended = false;
      ctx?.resume?.();
      if (playing && ctx) playing.next = Math.max(playing.next, ctx.currentTime + 0.05);
    },
    /** @param {Partial<Mix>} next */
    setMix(next) {
      Object.assign(mix, next);
      applyMix();
    },
    /** Change the tempo of the playing track (the machine's tempo moved). @param {number} bpm */
    setTempo(bpm) {
      if (playing) playing.track = { ...playing.track, bpm: Math.max(40, Math.min(220, bpm)) };
    },
    /** Pump the scheduler now (tests drive time by hand). */
    pump,
    dispose() {
      this.stop();
      ctx?.close?.();
      ctx = null;
      buses = null;
      noise = null;
    },
  };
}
