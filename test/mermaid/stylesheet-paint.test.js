//@ts-check
/**
 * @file What `styles/mermaid.css` paints each drawn mark, read the way a
 * browser's cascade reads it: the rule that applies to an element (by
 * selector and specificity, then source order) over its presentation
 * attribute, its `var(--mm-*)` through the root's stamped custom properties
 * and, under the `'host'` theme, the host token that stamp links to, in the
 * light and the dark blocks of `@jarenjs/view`'s `tokens.css`. Every painted
 * mark of every diagram type follows a host's theme flip, and no rule paints
 * a mark otherwise than its own attributes do.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { diagramToVnode } from '@jarenjs/mermaid';
import { renderToString } from '@jarenjs/view';

const CSS = readFileSync(new URL('../../components/mermaid/styles/mermaid.css', import.meta.url), 'utf8');
const TOKENS = readFileSync(new URL('../../packages/view/styles/tokens.css', import.meta.url), 'utf8');

/** The custom properties a block of declarations sets. @param {string} body */
const customProps = (body) => Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));

/** The host's light and dark token values. */
const HOST = (() => {
  const plain = TOKENS.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = [...plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), props: customProps(m[2]) }));
  const light = Object.assign({}, ...blocks.filter((b) => b.selector.startsWith(':root')).map((b) => b.props));
  const dark = { ...light, ...Object.assign({}, ...blocks.filter((b) => b.selector.startsWith('.dark')).map((b) => b.props)) };
  return { light, dark };
})();

/**
 * The stylesheet's top-level rules that paint (`fill`, `stroke`), each
 * selector with its specificity; the `@container` block only re-states
 * custom properties.
 */
const RULES = (() => {
  const plain = CSS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@container[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  /** @type {{ selector: string[][], specificity: number, order: number, decls: Record<string, string> }[]} */
  const rules = [];
  let order = 0;
  for (const m of plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = Object.fromEntries([...m[2].matchAll(/(?:^|;)\s*(fill|stroke)\s*:\s*([^;]+)/g)].map((d) => [d[1], d[2].trim()]));
    order++;
    if (Object.keys(decls).length === 0) continue;
    for (const one of m[1].split(',').map((s) => s.trim())) {
      // only plain descendant chains of tag and class compounds paint marks
      assert.match(one, /^[\w.\s-]+$/, `a painting selector this reader understands: ${one}`);
      const selector = one.split(/\s+/).map((c) => c.split(/(?=\.)/));
      const specificity = selector.flat().reduce((n, part) => n + (part.startsWith('.') ? 100 : 1), 0);
      rules.push({ selector, specificity, order, decls });
    }
  }
  return rules;
})();

/**
 * @typedef {{ tag: string, attrs: Record<string, string>, classes: string[], parent: El | null }} El
 */

/** The elements of a rendered SVG string, each with its parent; HTML in a `foreignObject` left out. @param {string} svg */
function elementsOf(svg) {
  /** @type {El[]} */
  const all = [];
  /** @type {El | null} */
  let open = null;
  let html = 0;
  for (const m of svg.matchAll(/<(\/?)([\w:-]+)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>/g)) {
    const [, close, tag, rest, selfClose] = m;
    if (close) {
      if (tag === 'foreignObject') html--;
      else if (html === 0 && open !== null) open = open.parent;
      continue;
    }
    if (html > 0) continue;
    if (tag === 'foreignObject') { html++; continue; }
    const attrs = Object.fromEntries([...rest.matchAll(/([\w:-]+)="([^"]*)"/g)].map((a) => [a[1], a[2].replace(/&quot;/g, '"').replace(/&amp;/g, '&')]));
    /** @type {El} */
    const el = { tag, attrs, classes: (attrs.class ?? '').split(/\s+/).filter(Boolean), parent: open };
    all.push(el);
    if (!selfClose) open = el;
  }
  return all;
}

/** @param {El} el @param {string[]} compound */
const matchesCompound = (el, compound) => compound.every((part) => (part.startsWith('.') ? el.classes.includes(part.slice(1)) : el.tag === part));

/** Whether a descendant chain matches an element. @param {El} el @param {string[][]} chain */
function matches(el, chain) {
  if (!matchesCompound(el, chain[chain.length - 1])) return false;
  let rest = chain.length - 2;
  for (let up = el.parent; up !== null && rest >= 0; up = up.parent) if (matchesCompound(up, chain[rest])) rest--;
  return rest < 0;
}

/** A property of an element's own inline style. @param {El} el @param {string} prop */
const inlineOf = (el, prop) => new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(el.attrs.style ?? '')?.[1].trim() ?? null;

/** The value the cascade gives one element's own property, or null where nothing sets it. @param {El} el @param {string} prop */
function specified(el, prop) {
  const inline = inlineOf(el, prop);
  if (inline !== null) return inline;
  let best = null;
  for (const rule of RULES) {
    if (!(prop in rule.decls) || !matches(el, rule.selector)) continue;
    if (best === null || rule.specificity > best.specificity || (rule.specificity === best.specificity && rule.order > best.order)) best = rule;
  }
  if (best !== null) return best.decls[prop];
  return el.attrs[prop] ?? null;
}

/** The value an element paints with (fill and stroke inherit). @param {El} el @param {string} prop */
function painted(el, prop) {
  for (let e = /** @type {El | null} */ (el); e !== null; e = e.parent) {
    const v = specified(e, prop);
    if (v !== null) return v;
  }
  return null;
}

/** The root's stamped `--mm-*` value. @param {El} root @param {string} name */
const stamped = (root, name) => customProps((root.attrs.style ?? '') + ';')[name] ?? null;

/**
 * Where a painted value comes from under the host theme: `none`, or the host
 * token its `var(--mm-*)` stamp links to; anything else is a concrete color.
 * @param {El} root @param {string} value
 */
function hostSource(root, value) {
  if (value === 'none' || value === 'transparent') return 'none';
  const local = /^var\((--mm-[\w-]+)\)$/.exec(value);
  if (local === null) return 'concrete ' + value;
  const stamp = stamped(root, local[1]);
  const host = stamp === null ? null : /^var\((--[\w-]+),/.exec(stamp);
  return host === null ? 'unlinked ' + local[1] : host[1];
}

const MARKS = ['rect', 'path', 'polygon', 'circle', 'line', 'text', 'ellipse', 'polyline'];

/** @param {string} source @param {Record<string, any>} [options] */
const render = (source, options = {}) => elementsOf(renderToString(diagramToVnode(source, options)));

/** One source of each diagram type, between them carrying every mark the renderers draw. */
const SOURCES = [
  'flowchart LR\n  A[[sub]] --> B[(db)]\n  B --o C(((two)))\n  C --x D{d}\n  D ~~~ E\n  D <--> E\n  E -.-> F([s])\n  F ==> G>a]\n'
    + '  subgraph S [Group]\n    H@{ shape: lin-cyl, label: "l" } --- I@{ shape: fork }\n    J@{ shape: tag-doc, label: "t" } --- K@{ shape: brace, label: "b" }\n  end\n'
    + '  L@{ shape: text, label: "plain" } --- M@{ shape: cross-circ }\n',
  'sequenceDiagram\n  actor U\n  participant D@{ "type": "database" }\n  participant Q@{ "type": "queue" }\n  participant B@{ "type": "boundary" }\n'
    + '  participant C@{ "type": "collections" }\n  U->>D: solid\n  D-->>U: dotted\n  U->D: open\n  U-xD: cross\n  U-)D: async\n'
    + '  U-|\\Q: half\n  Q-\\\\B: stick\n  B<<->>C: both\n  U()->>()B: central\n  U->>U: self\n'
    + '  activate D\n  D->>Q: on\n  deactivate D\n  Note over U,D: a note\n  alt yes\n    U->>D: a\n  else no\n    U->>D: b\n  end\n  loop again\n    D->>U: c\n  end\n',
  'stateDiagram-v2\n  [*] --> A\n  A --> B: go\n  state C {\n    [*] --> D\n  }\n  B --> C\n  C --> [*]\n',
  'classDiagram\n  class Animal {\n    +String name\n    +eat()\n  }\n  Animal <|-- Dog\n  foo --() Dog\n',
  'erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  ORDER {\n    string id\n  }\n',
  'gantt\n  dateFormat YYYY-MM-DD\n  section A\n  one :done, a1, 2024-01-01, 3d\n  two :crit, a2, after a1, 2d\n  three :a3, after a2, 1d\n',
  'pie\n  "a" : 1\n  "b" : 2\n',
  'journey\n  title t\n  section s\n    go: 5: me\n',
  'flowchart LR\n  A --> (\n',
];

describe('the stylesheet themes every drawn mark', () => {
  it('links every painted mark of every diagram type to a host token under the host theme', () => {
    /** @type {string[]} */
    const unthemed = [];
    for (const source of SOURCES) {
      const elements = render(source, { theme: 'host' });
      const root = /** @type {El} */ (elements.find((e) => e.tag === 'svg'));
      for (const el of elements.filter((e) => MARKS.includes(e.tag))) {
        for (const prop of el.tag === 'text' ? ['fill'] : ['fill', 'stroke']) {
          // an author's style paints in the author's own color
          if (inlineOf(el, prop) !== null) continue;
          const value = painted(el, prop);
          // a line or a path no one gave a fill is unfilled by intent
          if (value === null) continue;
          const source_ = hostSource(root, value);
          if (!source_.startsWith('--') && source_ !== 'none') unthemed.push(`${source.split('\n')[0]} ${el.tag}.${el.classes.join('.')} ${prop}: ${source_}`);
        }
      }
    }
    assert.deepEqual(unthemed, []);
  });

  it('paints no mark otherwise than its own attributes in a concrete theme', () => {
    /** @type {string[]} */
    const repainted = [];
    for (const theme of ['default', 'dark']) {
      for (const source of SOURCES) {
        const elements = render(source, { theme });
        const root = /** @type {El} */ (elements.find((e) => e.tag === 'svg'));
        for (const el of elements.filter((e) => MARKS.includes(e.tag))) {
          for (const prop of ['fill', 'stroke']) {
            if (el.attrs[prop] === undefined || inlineOf(el, prop) !== null) continue;
            const value = /** @type {string} */ (specified(el, prop));
            const local = /^var\((--mm-[\w-]+)\)$/.exec(value);
            const resolved = local === null ? value : stamped(root, local[1]);
            if (resolved?.toLowerCase() !== el.attrs[prop].toLowerCase()) {
              repainted.push(`${theme} ${source.split('\n')[0]} ${el.tag}.${el.classes.join('.')} ${prop}: ${el.attrs[prop]} -> ${resolved}`);
            }
          }
        }
      }
    }
    assert.deepEqual(repainted, []);
  });

  /**
   * The host token a mark paints with, and its light and dark values.
   * @param {string} source @param {(el: El) => boolean} pick @param {string} prop
   */
  const hostPaint = (source, pick, prop) => {
    const elements = render(source, { theme: 'host' });
    const root = /** @type {El} */ (elements.find((e) => e.tag === 'svg'));
    const el = elements.find(pick);
    assert.ok(el, source);
    const token = hostSource(root, /** @type {string} */ (painted(el, prop)));
    return { token, light: HOST.light[token], dark: HOST.dark[token] };
  };

  it('draws the marks the stylesheet missed in the host\'s colors, light and dark', () => {
    /** @type {[string, string, (el: El) => boolean, string, string][]} */
    const cases = [
      ['sequence message line', 'sequenceDiagram\n  A->>B: x', (e) => e.classes.includes('mm-message-line'), 'stroke', '--fg'],
      ['sequence open head', 'sequenceDiagram\n  A->B: x', (e) => e.tag === 'path' && e.parent?.classes.includes('mm-message') === true && !e.classes.includes('mm-message-line'), 'stroke', '--fg'],
      ['sequence cross head', 'sequenceDiagram\n  A-xB: x', (e) => e.tag === 'path' && e.parent?.classes.includes('mm-message') === true && !e.classes.includes('mm-message-line'), 'stroke', '--fg'],
      ['flowchart circle head', 'flowchart LR\n  A --o B', (e) => e.tag === 'circle', 'fill', '--fg'],
      ['flowchart cross head', 'flowchart LR\n  A --x B', (e) => e.tag === 'path' && !e.classes.includes('mm-edge-line'), 'stroke', '--fg'],
      ['subroutine inner lines', 'flowchart LR\n  A[[x]]', (e) => e.tag === 'path', 'stroke', '--accent'],
      ['state start dot', 'stateDiagram-v2\n  [*] --> A', (e) => e.tag === 'circle', 'fill', '--accent'],
      ['state end dot', 'stateDiagram-v2\n  A --> [*]', (e) => e.tag === 'circle' && e.attrs.r === '7', 'fill', '--accent'],
      ['sequence block frame', 'sequenceDiagram\n  loop x\n    A->>B: y\n  end', (e) => e.classes.includes('mm-block'), 'stroke', '--accent'],
      ['subgraph title', 'flowchart LR\n  subgraph S [Group]\n    A\n  end', (e) => e.classes.includes('mm-cluster-label'), 'fill', '--fg'],
      ['class panel', 'classDiagram\n  class A', (e) => e.classes.includes('mm-panel'), 'fill', '--accent-soft'],
    ];
    for (const [name, source, pick, prop, token] of cases) {
      const paint = hostPaint(source, pick, prop);
      assert.equal(paint.token, token, name);
      assert.ok(paint.light !== undefined && paint.dark !== undefined && paint.light !== paint.dark, name);
    }
  });

  it('keeps an invisible link unpainted and a styled subroutine\'s inner lines in the author\'s stroke', () => {
    const link = render('flowchart LR\n  A ~~~ B', { theme: 'host' }).find((e) => e.classes.includes('mm-edge-line'));
    assert.equal(painted(/** @type {El} */ (link), 'stroke'), 'none');
    const inner = render('flowchart LR\n  A[[x]]\n  style A stroke:#ff0000').filter((e) => e.tag === 'path');
    assert.deepEqual(inner.map((e) => painted(e, 'stroke')), ['#ff0000']);
  });
});
