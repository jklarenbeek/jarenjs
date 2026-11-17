//@ts-check
/**
 * @file The exported host token stylesheet is the contract docs/DESIGN.md
 * §2 writes down: every name in the table, light and dark, and no other;
 * the system-scheme variant carries the same dark values; every component's
 * `HOST_VARS` link names a token the file defines; and the ink/ground pairs
 * §1 guards clear WCAG AA in both themes, computed from the file itself.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { relativeLuminance, contrastOf } from '../../packages/core/src/color.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (/** @type {string} */ rel) => readFileSync(join(ROOT, rel), 'utf8');

const TOKENS = 'packages/view/styles/tokens.css';
const SYSTEM = 'packages/view/styles/tokens-system.css';

/** The selectors the exported file is made of, in cascade order. */
const LIGHT = ':root, .light, [data-theme="light"]';
const INVARIANT = ':root';
const DARK = '.dark, [data-theme="dark"]';
const SYSTEM_DARK = ':root:where(:not(.light, [data-theme="light"]))';
const LIGHT_SUBTREE = '.light, [data-theme="light"]';

/** The signal the system-scheme file gives the component stylesheets. */
const SCHEME = '--jaren-scheme';

/** The one dark selector a component stylesheet keys its own dark rules on. */
const COMPONENT_DARK = ':is(.dark, [data-theme="dark"])';
const SYSTEM_QUERY = `@container style(${SCHEME}: dark)`;

/**
 * Host properties a component reads that are not §2 tokens, each with its
 * reason; every use must carry a fallback.
 */
const SEAMS = [
  ['--kb-inset', 'the on-screen keyboard inset a host measures and sets'],
  ['--motion-ease-loop', "the host's motion easing for repeating animation"],
];

/** Every component stylesheet, by component. */
function componentSheets() {
  return readdirSync(join(ROOT, 'components')).flatMap((name) => {
    const dir = join(ROOT, 'components', name, 'styles');
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.css')).map((f) => ({ name, file: `components/${name}/styles/${f}` })) : [];
  });
}

/**
 * @typedef {{ media: string | null, selector: string, body: string }} Rule
 */

/**
 * The statements and style rules of a stylesheet, comments dropped and a
 * rule inside an `@media`, `@container` or `@supports` block tagged with that
 * block's prelude; other at-rule blocks (`@keyframes`) are skipped. Enough
 * CSS for these stylesheets: no strings holding braces.
 * @param {string} css
 * @returns {{ statements: string[], rules: Rule[] }}
 */
function parseSheet(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  /** @type {string[]} */
  const statements = [];
  /** @type {Rule[]} */
  const rules = [];
  const walk = (/** @type {string} */ src, /** @type {string | null} */ media) => {
    let pos = 0;
    while (pos < src.length) {
      const open = src.indexOf('{', pos);
      const semi = src.indexOf(';', pos);
      if (semi !== -1 && (open === -1 || semi < open)) {
        statements.push(src.slice(pos, semi).trim());
        pos = semi + 1;
        continue;
      }
      if (open === -1) {
        assert.strictEqual(src.slice(pos).trim(), '', 'nothing after the last rule');
        return;
      }
      const prelude = src.slice(pos, open).trim().replace(/\s+/g, ' ');
      let depth = 1;
      let end = open + 1;
      for (; depth > 0; end++) {
        assert.ok(end < src.length, `the block after ${prelude} closes`);
        if (src[end] === '{') depth++;
        else if (src[end] === '}') depth--;
      }
      const body = src.slice(open + 1, end - 1);
      const group = /^@(media|container|supports)\b/.exec(prelude);
      if (group) walk(body, prelude);
      else if (!prelude.startsWith('@')) rules.push({ media, selector: prelude, body: body.trim().replace(/\s+/g, ' ') });
      pos = end;
    }
  };
  walk(text, null);
  return { statements, rules };
}

/**
 * One rule's declarations, name to value; a name declared twice fails.
 * @param {string} body
 * @returns {Map<string, string>}
 */
function declarations(body) {
  const decls = new Map();
  for (const part of body.split(';')) {
    if (part.trim() === '') continue;
    const colon = part.indexOf(':');
    const name = part.slice(0, colon).trim();
    assert.ok(!decls.has(name), `${name} is declared once in its rule`);
    decls.set(name, part.slice(colon + 1).trim().replace(/\s+/g, ' '));
  }
  return decls;
}

/**
 * The token names in DESIGN §2's table: every backticked custom property in
 * its first column.
 * @returns {string[]}
 */
function contractNames() {
  const design = read('docs/DESIGN.md');
  const section = design.slice(design.indexOf('## 2. '), design.indexOf('## 3. '));
  const names = section.split('\n')
    .filter((line) => line.startsWith('| `--'))
    .flatMap((line) => [...line.split('|')[1].matchAll(/`(--[a-z0-9-]+)`/g)].map((m) => m[1]));
  assert.ok(names.length >= 30, `${names.length} names read from the §2 table`);
  return names;
}

/**
 * The ink/ground pairs DESIGN §1 guards: `--ink` on `--ground` in its
 * "Guarded pairs" bullet.
 * @returns {Array<[string, string]>}
 */
function guardedPairs() {
  const design = read('docs/DESIGN.md');
  const start = design.indexOf('- **Guarded pairs**');
  assert.ok(start > 0, 'DESIGN §1 lists its guarded pairs');
  const rest = design.slice(start + 2);
  const next = rest.search(/\n(?:- |#|\n)/);
  const text = next === -1 ? rest : rest.slice(0, next);
  /** @type {Array<[string, string]>} */
  const pairs = [...text.replace(/\s+/g, ' ').matchAll(/`(--[a-z0-9-]+)` on `(--[a-z0-9-]+)`/g)].map((m) => [m[1], m[2]]);
  assert.ok(pairs.length >= 6, `${pairs.length} pairs read from §1`);
  return pairs;
}

/**
 * An `hsl(h s% l%)` token value as the `#rrggbb` a browser paints.
 * @param {string} value
 * @returns {string}
 */
function hslToHex(value) {
  const m = /^hsl\((\d+(?:\.\d+)?) (\d+(?:\.\d+)?)% (\d+(?:\.\d+)?)%\)$/.exec(value);
  assert.ok(m, `${value} is an hsl() colour`);
  const h = Number(m[1]);
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const a = s * Math.min(l, 1 - l);
  const f = (/** @type {number} */ n) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return '#' + [f(0), f(8), f(4)].map((c) => c.toString(16).padStart(2, '0')).join('');
}

/** The exported file's three rules, by selector. */
function exported() {
  const { statements, rules } = parseSheet(read(TOKENS));
  assert.deepStrictEqual(statements, [], 'the token file imports nothing');
  assert.deepStrictEqual(rules.map((r) => [r.media, r.selector]), [[null, LIGHT], [null, INVARIANT], [null, DARK]],
    'light colours, theme-independent tokens, dark colours, in that order and nothing else');
  const [light, invariant, dark] = rules.map((r) => declarations(r.body));
  return { light, invariant, dark };
}

describe('view — the exported host token stylesheet', () => {
  it('defines every token in DESIGN §2 and nothing else', () => {
    const { light, invariant } = exported();
    const contract = contractNames();
    assert.strictEqual(new Set(contract).size, contract.length, 'the table names each token once');
    const defined = [...light.keys(), ...invariant.keys()];
    assert.strictEqual(new Set(defined).size, defined.length, 'a token is a colour or theme-independent, never both');
    assert.deepStrictEqual([...defined].sort(), [...contract].sort());
  });

  it('redefines every colour for dark, and only the colours', () => {
    const { light, invariant, dark } = exported();
    assert.deepStrictEqual([...dark.keys()], [...light.keys()], 'dark redefines the light colours, in the same order');
    for (const [name, value] of [...light, ...dark]) assert.match(hslToHex(value), /^#[0-9a-f]{6}$/, name);
    for (const [name, value] of invariant) assert.ok(!value.startsWith('hsl('), `${name} is no colour`);
    assert.ok([...light.keys()].some((name) => light.get(name) !== dark.get(name)), 'the two themes differ');
  });

  it('the system-scheme variant is the token file plus the same dark colours, behind an explicit light choice', () => {
    const { dark } = exported();
    const { statements, rules } = parseSheet(read(SYSTEM));
    assert.deepStrictEqual(statements, ["@import './tokens.css'"]);
    const media = '@media (prefers-color-scheme: dark)';
    assert.deepStrictEqual(rules.map((r) => [r.media, r.selector]), [[media, SYSTEM_DARK], [media, LIGHT_SUBTREE]]);
    const [root, subtree] = rules.map((r) => declarations(r.body));
    assert.strictEqual(root.get(SCHEME), 'dark', 'the root tells the components the system chose dark');
    root.delete(SCHEME);
    assert.deepStrictEqual([...root], [...dark], 'value for value the dark colours of tokens.css');
    assert.deepStrictEqual([...subtree], [[SCHEME, 'light']], 'a light subtree resets the signal and nothing else');
  });

  it('every HOST_VARS link of every component names an exported token', async () => {
    const { light, invariant } = exported();
    const tokens = new Set([...light.keys(), ...invariant.keys()]);
    const modules = readdirSync(join(ROOT, 'components'), { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.js') && file.split(/[\\/]/)[1] === 'src')
      .filter((file) => read(`components/${file}`).includes('export const HOST_VARS'));
    assert.ok(modules.length >= 3, `${modules.length} components carry a host link table`);
    /** @type {string[]} */
    const unknown = [];
    for (const file of modules) {
      const { HOST_VARS } = await import(pathToFileURL(join(ROOT, 'components', file)).href);
      assert.ok(HOST_VARS && Object.keys(HOST_VARS).length > 0, `${file} exports a non-empty HOST_VARS`);
      for (const [key, target] of Object.entries(HOST_VARS)) if (!tokens.has(target)) unknown.push(`${file}: ${key} -> ${target}`);
    }
    assert.deepStrictEqual(unknown, []);
  });

  it('every guarded ink/ground pair clears WCAG AA in both themes', () => {
    const { light, dark } = exported();
    /** @type {string[]} */
    const below = [];
    for (const [theme, colours] of /** @type {const} */ ([['light', light], ['dark', dark]])) {
      for (const [ink, ground] of guardedPairs()) {
        assert.ok(colours.has(ink) && colours.has(ground), `${ink} and ${ground} are colour tokens`);
        const ratio = contrastOf(relativeLuminance(hslToHex(/** @type {string} */ (colours.get(ink)))),
          relativeLuminance(hslToHex(/** @type {string} */ (colours.get(ground)))));
        if (ratio < 4.5) below.push(`${theme}: ${ink} on ${ground} is ${ratio.toFixed(2)}:1`);
      }
    }
    assert.deepStrictEqual(below, []);
  });

  it('converts a token colour the way a browser paints it', () => {
    assert.strictEqual(hslToHex('hsl(0 0% 100%)'), '#ffffff');
    assert.strictEqual(hslToHex('hsl(0 100% 50%)'), '#ff0000');
    assert.strictEqual(hslToHex('hsl(120 100% 25%)'), '#008000');
    assert.strictEqual(hslToHex('hsl(221 83% 53%)'), '#2463eb');
  });
});

describe('view — the component stylesheets and the host tokens', () => {
  it('no component stylesheet keys a dark rule on a bare .dark', () => {
    const sheets = componentSheets();
    assert.ok(sheets.length >= 11, `${sheets.length} component stylesheets read`);
    /** @type {string[]} */
    const bare = [];
    let dark = 0;
    for (const { file } of sheets) {
      for (const rule of parseSheet(read(file)).rules) {
        const rest = rule.selector.split(COMPONENT_DARK).join('');
        if (rest !== rule.selector) dark++;
        if (/\.dark\b|data-theme\s*=\s*"?dark/.test(rest)) bare.push(`${file}: ${rule.selector}`);
      }
    }
    assert.deepStrictEqual(bare, []);
    assert.ok(dark >= 10, `${dark} dark rules use ${COMPONENT_DARK}`);
  });

  it('every component dark rule has its system-scheme twin, declaration for declaration, and no other twin exists', () => {
    /** @type {string[]} */
    const wrong = [];
    for (const { file } of componentSheets()) {
      const { rules } = parseSheet(read(file));
      // a dark ancestor or a dark element itself: under the system scheme the root is dark
      const expected = rules.filter((r) => r.media === null && r.selector.includes(COMPONENT_DARK)).map((r) => ({
        selector: [...new Set(r.selector.split(/,\s*(?![^()]*\))/).map((item) => `:root ${item.trim().replace(`${COMPONENT_DARK} `, '').replace(COMPONENT_DARK, '')}`))].join(', '),
        body: r.body,
      }));
      const twins = rules.filter((r) => r.media === SYSTEM_QUERY).map((r) => ({ selector: r.selector, body: r.body }));
      try { assert.deepStrictEqual(twins, expected); }
      catch { wrong.push(`${file}: ${JSON.stringify(twins)} != ${JSON.stringify(expected)}`); }
      for (const r of rules) if (r.media !== null && r.media.includes(SCHEME) && r.media !== SYSTEM_QUERY) wrong.push(`${file}: ${r.media}`);
    }
    assert.deepStrictEqual(wrong, []);
  });

  it('every host property a component stylesheet reads is an exported token, its own, or a listed seam with a fallback', () => {
    const { light, invariant } = exported();
    const tokens = new Set([...light.keys(), ...invariant.keys()]);
    const sheets = componentSheets();
    const text = (/** @type {string} */ file) => read(file).replace(/\/\*[\s\S]*?\*\//g, '');
    // a component's own vocabulary: the prefixes its stylesheets declare and its themes stamp
    const own = new Set();
    for (const { file } of sheets)
      for (const m of text(file).matchAll(/(?:^|[{;\s])(--[a-z0-9]+-)[a-z0-9-]*\s*:/g)) own.add(m[1]);
    for (const file of readdirSync(join(ROOT, 'components'), { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.js') && f.split(/[\\/]/)[1] === 'src'))
      for (const m of read(`components/${file}`).matchAll(/resolveTheme\(\s*THEMES,\s*'([a-z]+)'/g)) own.add(`--${m[1]}-`);
    for (const name of tokens) own.delete(`--${name.slice(2).split('-')[0]}-`);
    assert.ok(own.size >= 6, `${own.size} component prefixes`);
    /** @type {string[]} */
    const unknown = [];
    const seen = new Set();
    for (const { file } of sheets) {
      for (const m of text(file).matchAll(/var\(\s*(--[a-z0-9-]+)\s*(,?)/g)) {
        const name = m[1];
        if (tokens.has(name) || [...own].some((prefix) => name.startsWith(prefix))) continue;
        const seam = SEAMS.find(([n]) => n === name);
        if (seam && m[2] === ',') { seen.add(name); continue; }
        unknown.push(`${file}: var(${name}${m[2]}`);
      }
    }
    assert.deepStrictEqual(unknown, []);
    assert.deepStrictEqual(SEAMS.filter(([n]) => !seen.has(n)).map(([n]) => n), [], 'every listed seam is still read');
  });
});
