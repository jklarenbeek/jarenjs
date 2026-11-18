//@ts-check
/**
 * @file The calculator speaks the reader's language. A pseudo-locale
 * (every calc message id rendered as `⟦id⟧`) renders the calculator view
 * in every mode and through forced states — each expression diagnostic in
 * the display, the plot's error card, both word signs, every rates state
 * and a stale table — and the rendering must show none of the English
 * catalog's text, every word of chrome must carry the mark (the keypad's
 * symbols and function names, the base and unit names and the form's enum
 * values are names, not chrome), and every id must be reached. Without a
 * catalog every word is the English it was.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { compileMessageCatalog, compileMessageTemplate } from '@jarenjs/core/message';
import { calcMessagesEn, calcText, calcToVnode, evaluate, errorToVnode, defaultEnv } from '@jarenjs/calc';
import { createCalcComponent, calcViewRules, contributeCalcViewModel } from '@jarenjs/calc/component';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';
import { renderToString } from '@jarenjs/view';

const IDS = Object.keys(calcMessagesEn);
const reached = new Set();
const PSEUDO = compileMessageCatalog(Object.fromEntries(IDS.map((id) => [id, () => { reached.add(id); return `⟦${id}⟧`; }])));

const sheet = compileJsltStylesheet({ $jslt: '0.1', modes: { calculator: { unmatched: 'error' } },
  rules: [{ match: '$', body: { $apply: ['$.ui.calculator', 'calculator'] } }, ...calcViewRules] });

/** Every string a rendering shows: text nodes and accessible names. @returns {string[]} */
function strings(/** @type {any} */ node, /** @type {string[]} */ out = []) {
  if (typeof node === 'string') { out.push(node); return out; }
  if (!Array.isArray(node)) return out;
  if (typeof node[0] !== 'string') { for (const child of node) strings(child, out); return out; }
  const [, attrs, ...children] = node;
  for (const name of ['aria-label', 'title', 'placeholder']) if (typeof attrs?.[name] === 'string') out.push(attrs[name]);
  for (const child of children) strings(child, out);
  return out;
}

/** The names a view model shows that no language translates: the keypad,
 * the base, word, angle and plot toggles, the unit symbols, the form's enum
 * values, and the memory row's symbols. */
function names(/** @type {any} */ vm) {
  return new Set([
    ...(vm.keypad ?? []).flatMap((/** @type {any} */ row) => row.keys.map((/** @type {any} */ k) => k.label)),
    ...vm.angle.options.map((/** @type {any} */ o) => o.label), ...(vm.plot?.kinds ?? []).map((/** @type {any} */ k) => k.label),
    ...vm.bases.baseOptions.map((/** @type {any} */ o) => o.label), 'HEX', 'DEC', 'OCT', 'BIN',
    ...(vm.converter?.unitsFrom ?? []).map((/** @type {any} */ u) => u.symbol),
    'pmt', 'pv', 'fv', 'nper', 'rate', 'M+', 'MC', 'M = ',
  ]);
}

/** The English a rendering must not show: each literal entry, and a pattern per template or closure. */
const escape = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ENGLISH = IDS.map((id) => {
  const entry = calcMessagesEn[id];
  const text = typeof entry === 'function' ? entry({ name: 'f', min: 1, max: 1, count: 2 }) : entry;
  const parts = String(text).split(/(\{[^{}]*\})/).filter((p) => p !== '' && !p.startsWith('{'));
  return [id, new RegExp(parts.map((p) => escape(p.trim())).filter((p) => /\p{L}/u.test(p)).join('|') || '(?!)')];
}).filter(([, re]) => String(re) !== '/(?!)/');

/** What a rendering shows that it must not. @returns {string[]} */
function violations(/** @type {any} */ vnode, /** @type {Set<string>} */ allowed, /** @type {string} */ where) {
  const found = [];
  for (const text of strings(vnode)) {
    if (allowed.has(text) || !/\p{L}/u.test(text)) continue;
    if (!text.includes('⟦')) { found.push(`${where}: unmarked chrome "${text}"`); continue; }
    const bare = text.replace(/⟦[^⟧]*⟧/g, '');
    for (const [id, re] of ENGLISH) if (re.test(bare)) found.push(`${where}: English of ${id} in "${text}"`);
  }
  return found;
}

/** A headless calculator, its fetch failing so only the fallback rates are used. */
function calculator() {
  const component = createCalcComponent({ fetch: async () => ({ ok: false, status: 503 }), messages: PSEUDO });
  return component.createApp({ schedule: (/** @type {any} */ f) => f() });
}

/** An environment that knows no constants. */
const NO_CONSTANTS = { ...defaultEnv, constants: {} };

const ERRORS = ['', '1+', '(1', '2 3', '.', 'max(1 2', 'nope(1)', 'max()', 'sin(1, 2)', 'log()'];

describe('calc messages', () => {
  it('shows no English under a pseudo-locale, and reaches every id', () => {
    const app = calculator();
    const found = [];
    const view = (/** @type {string} */ where) => {
      const vm = contributeCalcViewModel(app.getState(), { messages: PSEUDO });
      // the entry is the reader's own text
      found.push(...violations(sheet({ ui: { calculator: vm } }), new Set([...names(vm), vm.display.entry]), where));
      return vm;
    };
    try {
      for (const mode of ['standard', 'scientific', 'programmer', 'financial', 'converter']) {
        app.dispatch('calc/mode', { mode });
        view(mode);
      }
      app.dispatch('calc/mode', { mode: 'programmer' });
      app.dispatch('calc/sign'); view('one sign');
      app.dispatch('calc/sign'); view('the other');
      app.dispatch('calc/mode', { mode: 'scientific' });
      // = on an expression with no result: each refusal is a localized sentence
      for (const entry of [...ERRORS.slice(1).filter((e) => e !== '(1'), 'sqrt(-1)', '1/0']) {
        app.dispatch('calc/set-entry', entry);
        assert.equal(view(`typing ${entry}`).display.error, null, `${entry} shows nothing while typed`);
        app.dispatch('calc/equals');
        assert.ok(view(`entry ${entry}`).display.error.includes('⟦'), `${entry} is a localized diagnostic`);
      }
      app.dispatch('calc/mode', { mode: 'programmer' });
      app.dispatch('calc/set-entry', 'mod(1, 0)');
      app.dispatch('calc/equals');
      assert.ok(view('no result').display.error.includes('⟦'));
      app.dispatch('calc/mode', { mode: 'scientific' });
      app.dispatch('calc/set-entry', '');
      // the plot card names the engine's diagnostic and where it stands
      for (const entry of ERRORS.slice(1)) {
        app.dispatch('calc/plot-expr', null, { target: { value: entry } });
        view(`plot error ${entry}`);
      }
      app.dispatch('calc/mode', { mode: 'converter' });
      for (const dimension of ['length', 'area', 'volume', 'mass', 'temperature', 'time', 'speed', 'pressure', 'energy',
        'power', 'data', 'datarate', 'frequency', 'angle', 'fuel', 'currency']) {
        app.dispatch('calc/conv-dim', null, { target: { value: dimension } });
        view(`dimension ${dimension}`);
      }
      app.dispatch('calc/rates-err'); view('rates error, never live');
      app.dispatch('calc/rates-ok', { base: 'USD', rates: { USD: 1, EUR: 2 }, at: 5, source: 'CoinGecko' }); view('rates ok');
      app.dispatch('calc/rates-err'); view('rates error');
      app.dispatch('calc/mode', { mode: 'financial' });
      app.dispatch('calc/fin-example', { nper: 0, rate: 1, pv: 1000, pmt: -1, fv: 0, solveFor: 'nper' });
      view('no solution');
    }
    finally { app.destroy(); }
    // the states no dispatch reaches: no rates state at all, and a stale table
    const state = app.getState();
    for (const rates of [{ ...state.calc.rates, status: undefined }, { ...state.calc.rates, stale: true }]) {
      const vm = contributeCalcViewModel({ ...state, calc: { ...state.calc, mode: 'converter', rates } }, { messages: PSEUDO });
      found.push(...violations(sheet({ ui: { calculator: vm } }), names(vm), 'rates'));
    }
    // an empty expression, a constant an environment lacks and an unpositioned card, through the engine
    assert.equal(evaluate('pi', {}, { env: NO_CONSTANTS, messages: PSEUDO }).ok === false
      && evaluate('pi', {}, { env: NO_CONSTANTS, messages: PSEUDO }).error.message, '⟦calc/compile/constant⟧');
    assert.equal(evaluate('', {}, { messages: PSEUDO }).ok === false && evaluate('', {}, { messages: PSEUDO }).error.message, '⟦calc/parse/empty⟧');
    found.push(...violations(errorToVnode({ message: 'm' }, { messages: PSEUDO }), new Set(['m']), 'card'));
    assert.deepEqual(found, []);
    assert.deepEqual(IDS.filter((id) => !reached.has(id)), []);
  });

  it('keeps the English without a catalog', () => {
    const english = ERRORS.map((entry) => evaluate(entry));
    assert.deepEqual(english.map((r) => !r.ok && r.error.message), [
      'empty expression', 'unexpected end of input', 'expected \')\'', 'unexpected \'3\'', 'invalid number',
      'expected \',\' or \')\'', 'unknown function \'nope\'',
      'max() expected at least 1 argument, got 0', 'sin() expected 1 argument, got 2', 'log() expected 1 or 2 arguments, got 0',
    ]);
    // a catalog changes the words, never the shape or the position
    for (const [i, entry] of ERRORS.entries()) {
      const pseudo = evaluate(entry, {}, { messages: PSEUDO });
      assert.deepEqual({ ...pseudo, error: { ...(!pseudo.ok && pseudo.error), message: '' } },
        { ...english[i], error: { ...(!english[i].ok && english[i].error), message: '' } });
    }
    assert.equal(evaluate('pi', {}, { env: NO_CONSTANTS }).ok === false && evaluate('pi', {}, { env: NO_CONSTANTS }).error.message, 'unknown constant \'pi\'');
    const card = renderToString(calcToVnode('1+'));
    assert.ok(card.includes('Expression error') && card.includes('unexpected end of input (line 1, col 3)'));
    const app = calculator();
    try {
      const vm = (/** @type {any} */ state) => contributeCalcViewModel(state);
      // typing shows no diagnostic; = closes the parenthesis, and an
      // expression that cannot complete says so in one short sentence
      app.dispatch('calc/set-entry', '(1');
      assert.equal(vm(app.getState()).display.error, null);
      app.dispatch('calc/equals');
      assert.equal(vm(app.getState()).display.result, '1');
      app.dispatch('calc/set-entry', '1+');
      app.dispatch('calc/equals');
      assert.equal(vm(app.getState()).display.error, 'Incomplete expression');
      assert.deepEqual(vm(app.getState()).modes.map((/** @type {any} */ m) => m.label), ['Standard', 'Scientific', 'Programmer', 'Financial', 'Converter']);
      app.dispatch('calc/mode', { mode: 'programmer' });
      const sign = vm(app.getState()).bases.signLabel;
      app.dispatch('calc/sign');
      assert.deepEqual([sign, vm(app.getState()).bases.signLabel].sort(), ['signed', 'unsigned']);
      assert.deepEqual(vm(app.getState()).bases.wordOptions.map((/** @type {any} */ w) => w.label), ['8-bit', '16-bit', '32-bit', '64-bit']);
      app.dispatch('calc/mode', { mode: 'financial' });
      const html = renderToString(sheet({ ui: { calculator: vm(app.getState()) } }));
      for (const label of ['Time Value of Money', 'N — number of periods', 'I/Y — interest % per period', 'PV — present value',
        'PMT — payment', 'FV — future value', 'Solve for', '<span>Result (PMT (payment)): </span>', 'Mortgage payment',
        'Signs follow the money']) assert.ok(html.includes(label), label);
      app.dispatch('calc/mode', { mode: 'converter' });
      const converter = renderToString(sheet({ ui: { calculator: vm(app.getState()) } }));
      for (const label of ['Dimension ', '>Length</option>', '>Temperature</option>', '>Data rate</option>', '<span>Built-in sample rates, not live</span>',
        'aria-label="From unit"', 'aria-label="To unit"', 'aria-label="Swap units"']) assert.ok(converter.includes(label), label);
    }
    finally { app.destroy(); }
  });

  it('the financial form titles are the English of their message ids', () => {
    const schema = JSON.parse(readFileSync(new URL('../../components/calc/schemas/financial-inputs.schema.json', import.meta.url), 'utf8'));
    const fields = [schema, ...Object.values(schema.properties)];
    for (const field of fields) assert.equal(calcMessagesEn[`${field['x-msgid']}#label`], field.title, field['x-msgid']);
  });

  it('falls back to English per id, for a missing, throwing or non-string entry', () => {
    assert.equal(calcText(compileMessageCatalog({ 'calc/error/title': () => { throw new Error('x'); } }))('calc/error/title'), 'Expression error');
    assert.equal(calcText(/** @type {any} */ ({ 'calc/word/signed': () => 1 }))('calc/word/signed'), 'signed');
    assert.equal(calcText()('calc/unknown'), 'calc/unknown');
    assert.equal(compileMessageTemplate(String(calcMessagesEn['calc/compile/arity-either'])).parameters.join(), 'name,min,max,count');
  });

  it('uses every id of its catalog in the source', () => {
    const source = ['messages.js', 'compile.js', 'parser/index.js', 'render/error.js', 'component/index.js', 'component/schema.js',
      'component/entry.js', 'component/panels.js', 'modes/standard.js', 'modes/scientific.js', 'modes/programmer.js', 'modes/financial.js']
      .map((file) => readFileSync(new URL(`../../components/calc/src/${file}`, import.meta.url), 'utf8')).join('\n')
      .replace(/^[\s\S]*?export const calcMessagesEn[\s\S]*?\n\}\);/m, '');
    // a form text is the field's `x-msgid`, an option's value its own; an
    // example's two texts are built from the example's id
    const examples = [...source.matchAll(/\{ id: '([a-z]+)', perYear/g)].map((m) => m[1]);
    const used = (/** @type {string} */ id) => {
      const example = /^calc\/financial\/example\/([a-z]+)(\/text)?$/.exec(id);
      if (example !== null) return examples.includes(example[1]) && source.includes('`calc/financial/example/${example.id}' + (example[2] ?? '') + '`');
      const option = /^(.+)#enum\/(.+)$/.exec(id);
      if (option !== null) return source.includes(`'${option[1]}'`) && source.includes(`'${option[2]}'`);
      return source.includes(`'${id.replace(/#(label|description)$/, '')}'`);
    };
    for (const id of IDS) assert.ok(used(id), `${id} is used`);
  });
});
