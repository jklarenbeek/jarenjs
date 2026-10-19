//@ts-check
/**
 * The artwork as text — and text read back as art.
 *
 * Out: `art.dag.json` is a jaren-dag whose query nodes shape the OS state
 * into each template's input and whose `render` tasks run the three JTLT
 * templates: the live theme as CSS (the stylesheet the OS chrome wears,
 * re-rendered when the council's leader changes), the still frame as a
 * standalone HTML page (the SVG embedded raw, everything else escaped by
 * the template's `xml` method), and the program as a JavaScript module
 * that runs the same machine without the OS.
 *
 * In: `tokenize` reads generated CSS, HTML and JavaScript back through
 * `@jarenjs/md`'s lexer, so the Exports app can show the code as the
 * coloured token stream it is — and count its parts, the way the stage
 * counts the tape.
 *
 * Templates do not escape for CSS or JavaScript, so everything a template
 * interpolates is checked or built here first: colours must be hex,
 * names come from the fixed seat table, numbers are numbers.
 */

import { compileJtltStylesheet } from '@jarenjs/json/jtlt';
import { compileDag } from '@jarenjs/flow';
import { tokenizeCode } from '@jarenjs/md/plugins';
import { isHexColor, inkFor } from '@jarenjs/core/color';
import themeTemplate from '../documents/theme.css.jtlt.json' with { type: 'json' };
import artworkTemplate from '../documents/artwork.html.jtlt.json' with { type: 'json' };
import machineTemplate from '../documents/machine.js.jtlt.json' with { type: 'json' };
import artDoc from '../documents/art.dag.json' with { type: 'json' };
import { fsmToRules } from './program.js';
import { MEMBERS } from './council.js';
import { STAGE_THEMES, HUMAN_INK } from '../stage/scene.js';

/** The compiled templates, by the name the art DAG's tasks ask for. */
export const TEMPLATES = Object.freeze({
  theme: compileJtltStylesheet(themeTemplate),
  artwork: compileJtltStylesheet(artworkTemplate),
  machine: compileJtltStylesheet(machineTemplate),
});

/** The art pipeline: one run renders every text form of the artwork. */
export const artPipeline = compileDag(artDoc, {
  tasks: {
    render: ({ with: props }) => {
      const template = TEMPLATES[/** @type {keyof typeof TEMPLATES} */ (props?.template)];
      if (!template) throw new RangeError(`no template named ${props?.template}`);
      return template(props.data);
    },
  },
});

/** A colour a template may interpolate: a hex, or the fallback. @param {unknown} c @param {string} fallback */
const hex = (c, fallback) => (typeof c === 'string' && isHexColor(c) ? c : fallback);

/**
 * The art pipeline's input, built from the OS state.
 * @param {any} state - the app state
 * @param {{ svg?: string, title?: string }} [extra]
 */
export function artInput(state, extra = {}) {
  const theme = STAGE_THEMES[state.os.theme === 'dark' ? 'dark' : 'light'];
  const palette = (state.program.palette ?? []).map((/** @type {unknown} */ c, /** @type {number} */ i) => hex(c, ['#fffdf6', '#2563eb', '#fbbf24', '#ef4444', '#16a34a', '#06b6d4'][i] ?? '#888888'));
  const merits = state.council.merits ?? {};
  const members = MEMBERS.map((m) => ({
    id: m.id,
    name: m.name,
    color: m.ink < 0 ? HUMAN_INK : palette[m.ink],
    merit: Math.round((Number(merits[m.id]) || 1) * 100) / 100,
  }));
  const lead = members.find((m) => m.id === state.council.leader) ?? members[0];
  return {
    title: extra.title ?? `Radiant OS — tick ${state.world.tick}`,
    tick: state.world.tick,
    width: state.world.width,
    height: state.world.height,
    harmony: Math.round((state.machine.measure?.harmony ?? 0) * 1000) / 1000,
    rules: fsmToRules(state.program.machine),
    heads: state.world.heads.map((/** @type {any} */ h) => ({ id: h.id, x: h.x, y: h.y, dir: h.dir, state: h.state })),
    palette,
    paper: theme.paper,
    ink: theme.ink,
    leader: { name: lead.name, merit: lead.merit, color: lead.color, ink: inkFor(lead.color) },
    members,
    svg: extra.svg ?? '',
  };
}

/**
 * Render every text form of the artwork.
 * @param {any} state @param {{ svg?: string, title?: string }} [extra]
 * @returns {Promise<{ css: string, js: string, html: string, svg: string }>}
 */
export function renderArt(state, extra) {
  return artPipeline.run(artInput(state, extra));
}

/** The token kinds `tokenizeCode` answers, in the order the legend shows them. */
export const TOKEN_KINDS = Object.freeze(['kw', 'id', 'str', 'num', 'pun', 'op', 'com', 'lit']);

/**
 * Read source text back into tokens. An unknown language — or none —
 * reads as one plain run.
 * @param {string} text @param {string} lang
 * @returns {Array<{ kind: string, value: string }>}
 */
export function tokenize(text, lang) {
  return tokenizeCode(text, lang) ?? [{ kind: 'id', value: text }];
}

/**
 * How many tokens of each kind a text holds — the export's portrait.
 * @param {ReadonlyArray<{ kind: string }>} tokens
 * @returns {Record<string, number>}
 */
export function tokenStats(tokens) {
  /** @type {Record<string, number>} */
  const counts = Object.fromEntries(TOKEN_KINDS.map((k) => [k, 0]));
  for (const t of tokens) counts[t.kind] = (counts[t.kind] ?? 0) + 1;
  return counts;
}

/** The file name and media type of each export format. */
export const FORMATS = Object.freeze({
  css: { name: 'radiant-theme.css', mime: 'text/css', lang: 'css' },
  html: { name: 'radiant-artwork.html', mime: 'text/html', lang: 'html' },
  js: { name: 'radiant-machine.js', mime: 'text/javascript', lang: 'js' },
  svg: { name: 'radiant-artwork.svg', mime: 'image/svg+xml', lang: 'html' },
});
