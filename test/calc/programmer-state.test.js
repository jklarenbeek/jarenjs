//@ts-check
/**
 * The state slice holds a programmer word beyond 2^53 exactly: `ans` and the
 * memory register are JSON numbers (the nearest double), and a decimal
 * `ansExact` / `memoryExact` beside them holds the word, so reusing `ans`,
 * `M+` and clearing the entry keep it.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createApp } from '@jarenjs/app';
import { JarenValidator } from '@jarenjs/validate';
import { evaluate, programmerEnv } from '@jarenjs/calc';
import { evaluateExact } from '../../components/calc/src/compile.js';
import {
  calcActions, calcEditEffects, calcInitialState, contributeCalcViewModel, createCalcComponent,
} from '../../components/calc/src/component/index.js';

const schemaOf = (name) => JSON.parse(readFileSync(
  fileURLToPath(new URL(`../../components/calc/schemas/${name}`, import.meta.url)), 'utf8'));

/** A running app over a `$.calc` slice, so a persisted (older) state can be loaded as it is. */
function appOver(calc) {
  return createApp({
    $app: '0.1',
    state: { calc },
    view: { $jslt: '0.1', rules: [{ match: '$', body: ['div', {}] }] },
    actions: calcActions,
  }, { effects: calcEditEffects, schedule: (f) => f() });
}

/** The component's app, on a 64-bit unsigned HEX word in programmer mode. */
function programmerApp(signed = false) {
  const comp = createCalcComponent({ fetch: async () => ({ ok: false, status: 503 }) });
  const app = comp.createApp({ schedule: (f) => f() });
  app.dispatch('calc/mode', { mode: 'programmer' });
  app.dispatch('calc/base', { base: 'HEX' });
  app.dispatch('calc/word', { bits: 64 });
  if (signed) app.dispatch('calc/sign');
  /** @param {string} entry */
  const enter = (entry) => { app.dispatch('calc/clear'); app.dispatch('calc/key', { k: entry }); };
  const shown = () => comp.viewModel(app.getState()).display.result;
  return { comp, app, enter, shown };
}

describe('#calc programmer ans and memory keep a word beyond 2^53', function () {
  it('keeps the unsigned 64-bit all-ones word through clearing, ans and mem', () => {
    const { comp, app, enter, shown } = programmerApp();
    try {
      enter('0xFFFFFFFFFFFFFFFF');
      app.dispatch('calc/equals');
      const calc = app.getState().calc;
      assert.equal(calc.ans, 18446744073709552000);
      assert.equal(calc.ansExact, '18446744073709551615');
      app.dispatch('calc/clear');
      assert.equal(shown(), '0xFFFF FFFF FFFF FFFF');
      const vm = comp.viewModel(app.getState());
      assert.equal(vm.bases.views.dec, '18446744073709551615');
      assert.equal(vm.bases.views.hex, 'FFFF FFFF FFFF FFFF');
      enter('ans');
      assert.equal(shown(), '0xFFFF FFFF FFFF FFFF');
      enter('ans & 0xFF');
      assert.equal(shown(), '0xFF');
      enter('ans - 1');
      assert.equal(shown(), '0xFFFF FFFF FFFF FFFE');
      app.dispatch('calc/equals');
      assert.deepEqual([app.getState().calc.ans, app.getState().calc.ansExact], [18446744073709552000, '18446744073709551614']);
      // a result with no finite value leaves the four-base view on ans
      enter('1/0');
      assert.equal(comp.viewModel(app.getState()).bases.views.dec, '18446744073709551614');
    }
    finally { app.destroy(); }
  });

  it('adds a big word to the memory register exactly and shows it', () => {
    const { comp, app, enter, shown } = programmerApp();
    try {
      enter('0xFFFFFFFFFFFFFFFF');
      app.dispatch('calc/equals');
      app.dispatch('calc/mem-add');
      assert.deepEqual([app.getState().calc.memory, app.getState().calc.memoryExact], [18446744073709552000, '18446744073709551615']);
      assert.equal(comp.viewModel(app.getState()).memory, '18446744073709551615');
      app.dispatch('calc/mem-add');
      assert.equal(app.getState().calc.memoryExact, '36893488147419103230');
      enter('mem');
      assert.equal(shown(), '0xFFFF FFFF FFFF FFFE');
      app.dispatch('calc/equals');
      assert.equal(app.getState().calc.ansExact, '18446744073709551614');
      app.dispatch('calc/mem-clear');
      assert.deepEqual([app.getState().calc.memory, app.getState().calc.memoryExact], [0, '']);
      enter('mem');
      assert.equal(shown(), '0x0');
    }
    finally { app.destroy(); }
  });

  it('keeps the signed 64-bit maximum, which a Number rounds past the word', () => {
    const { app, enter, shown } = programmerApp(true);
    try {
      app.dispatch('calc/base', { base: 'DEC' });
      enter('0x7FFFFFFFFFFFFFFF');
      app.dispatch('calc/equals');
      assert.equal(app.getState().calc.ansExact, '9223372036854775807');
      app.dispatch('calc/clear');
      assert.equal(shown(), '9223372036854775807');
      enter('ans');
      assert.equal(shown(), '9223372036854775807');
      enter('ans + 1');
      assert.equal(shown(), '-9223372036854775808');
    }
    finally { app.destroy(); }
  });

  it('writes no exact text for a word a Number holds, and drops a stale one', () => {
    const { app, enter } = programmerApp();
    try {
      enter('0xFFFFFFFFFFFFFFFF');
      app.dispatch('calc/equals');
      enter('255');
      app.dispatch('calc/equals');
      assert.deepEqual([app.getState().calc.ans, app.getState().calc.ansExact], [255, '']);
      app.dispatch('calc/mem-add');
      assert.deepEqual([app.getState().calc.memory, app.getState().calc.memoryExact], [255, '']);
    }
    finally { app.destroy(); }
  });

  it('adds two whole words as integers, where the float sum rounds', () => {
    const app = appOver({
      ...calcInitialState(), mode: 'programmer', wordBits: 64, ans: 2, memory: 9007199254740991,
    });
    try {
      app.dispatch('calc/mem-add');
      assert.deepEqual([app.getState().calc.memory, app.getState().calc.memoryExact], [9007199254740992, '9007199254740993']);
    }
    finally { app.destroy(); }
  });

  it('adds as floats outside the programmer mode, and with a word that is not whole', () => {
    const standard = appOver({ ...calcInitialState(), ans: 0.2, memory: 0.1 });
    try {
      standard.dispatch('calc/mem-add');
      assert.deepEqual([standard.getState().calc.memory, standard.getState().calc.memoryExact], [0.30000000000000004, '']);
    }
    finally { standard.destroy(); }
    const infinite = appOver({
      ...calcInitialState(), mode: 'programmer', wordBits: 64, ans: Infinity, memory: 5, memoryExact: '',
    });
    try {
      infinite.dispatch('calc/mem-add');
      assert.equal(infinite.getState().calc.memory, Infinity);
    }
    finally { infinite.destroy(); }
  });

  it('reads the Number when the exact text is not the word it rounds from', () => {
    const base = { ...calcInitialState(), mode: 'programmer', base: 'DEC', wordBits: 64 };
    const vm = (calc) => contributeCalcViewModel({ calc: { ...base, ...calc } });
    assert.equal(vm({ ans: 18446744073709552000, ansExact: '18446744073709551615' }).display.result, '18446744073709551615');
    // a host patched `ans` alone: the old text is another word's
    assert.equal(vm({ ans: 5, ansExact: '18446744073709551615' }).display.result, '5');
    assert.equal(vm({ ans: 18446744073709552000, ansExact: '7' }).display.result, '0');
    assert.equal(vm({ ans: 7, ansExact: 'abc' }).display.result, '7');
    assert.equal(vm({ ans: 7, ansExact: 7 }).display.result, '7');
    // outside the programmer mode the Number is all there is
    const standard = (calc) => contributeCalcViewModel({ calc: { ...calcInitialState(), ans: 18446744073709552000, ...calc } }).display.result;
    assert.equal(standard({ ansExact: '18446744073709551615' }), standard({}));
  });

  it('loads a state written before the exact form existed', () => {
    const { ansExact, memoryExact, ...old } = calcInitialState();
    assert.deepEqual([ansExact, memoryExact], ['', '']);
    const app = appOver({ ...old, mode: 'programmer', base: 'DEC', wordBits: 64, ans: 41, memory: 1, entry: 'ans + 1' });
    try {
      assert.equal(contributeCalcViewModel(app.getState()).display.result, '42');
      app.dispatch('calc/equals');
      assert.deepEqual([app.getState().calc.ans, app.getState().calc.ansExact, app.getState().calc.entry], [42, '', '42']);
      app.dispatch('calc/mem-add');
      assert.deepEqual([app.getState().calc.memory, app.getState().calc.memoryExact], [43, '']);
      app.dispatch('calc/mem-clear');
      assert.deepEqual([app.getState().calc.memory, app.getState().calc.memoryExact], [0, '']);
    }
    finally { app.destroy(); }
  });
});

describe('#calc an exact environment reads a decimal-integer scope string as the integer', function () {
  const env = programmerEnv();
  const W64 = { wordBits: 64, signed: false };

  it('keeps the word a Number would round', () => {
    assert.equal(evaluate('ans & 0xFF', { ...W64, ans: '18446744073709551615' }, { env }).value, 255);
    assert.equal(evaluateExact('ans', { ...W64, ans: '18446744073709551615' }, { env }).value, 18446744073709551615n);
    assert.equal(evaluateExact('ans', { ...W64, ans: '-9223372036854775808' }, { env }).value, -9223372036854775808n);
    assert.equal(evaluateExact('ans', { ...W64, ans: '9007199254740991' }, { env }).value, 9007199254740991);
  });

  it('reads any other string as it always did', () => {
    assert.equal(evaluate('ans', { ...W64, ans: '0x10' }, { env }).value, 16);
    assert.equal(evaluate('ans', { ...W64, ans: '1.5' }, { env }).value, 1.5);
    assert.equal(/** @type {any} */ (evaluate('ans', { ...W64, ans: 'abc' }, { env })).value, NaN);
    assert.equal(evaluate('x + 1', { x: '18446744073709551615' }).value, 18446744073709552000);
  });
});

describe('#calc state schema', function () {
  const compiler = new JarenValidator();
  compiler.addSchema(schemaOf('financial-inputs.schema.json'));
  const validate = compiler.compile(schemaOf('jaren-calc-state.schema.json'));

  it('accepts an older state, a safe state and an exact word', () => {
    const { ansExact: _a, memoryExact: _m, ...old } = calcInitialState();
    assert.ok(validate(old), 'no exact members');
    assert.ok(validate(calcInitialState()), 'empty exact members');
    assert.ok(validate({ ...calcInitialState(), ans: 18446744073709552000, ansExact: '18446744073709551615', memoryExact: '-9223372036854775808' }));
  });

  it('refuses an exact member that is not a decimal integer', () => {
    for (const bad of ['0x10', '1.5', 'abc', ' 7', 7, null]) {
      assert.equal(validate({ ...calcInitialState(), ansExact: bad }), false, JSON.stringify(bad));
      assert.equal(validate({ ...calcInitialState(), memoryExact: bad }), false, JSON.stringify(bad));
    }
  });
});

describe('#calc a state slice a host patched by hand still renders', function () {
  it('renders a string ans or memory as it was rendered, in every mode', () => {
    for (const mode of ['standard', 'programmer']) {
      for (const held of ['1.5', 'abc', '0x10', '']) {
        const calc = { ...calcInitialState(), mode, ans: held, memory: held };
        const vm = contributeCalcViewModel({ calc });
        assert.equal(vm.memory, held, `${mode} memory ${JSON.stringify(held)}`);
        assert.equal(typeof vm.display.result, 'string');
      }
    }
    // a decimal-integer string outside the programmer mode stays the string
    const big = contributeCalcViewModel({ calc: { ...calcInitialState(), ans: '18446744073709551615', memory: '18446744073709551615' } });
    assert.equal(big.memory, '18446744073709551615');
    assert.equal(big.display.error, null);
    assert.equal(contributeCalcViewModel({ calc: { ...calcInitialState(), ans: '1.5' } }).display.result, '1.5');
    assert.equal(contributeCalcViewModel({ calc: { ...calcInitialState(), ans: 'abc' } }).display.result, 'NaN');
  });

  it('adds a string memory as the Number it reads as, without throwing', () => {
    const app = appOver({ ...calcInitialState(), mode: 'standard', ans: 2, memory: '1.5' });
    try {
      app.dispatch('calc/mem-add');
      assert.deepEqual([app.getState().calc.memory, app.getState().calc.memoryExact], [3.5, '']);
    }
    finally { app.destroy(); }
  });

  it('commits without an exact member, as a host with its own evaluator does', () => {
    const app = appOver({ ...calcInitialState(), ansExact: '18446744073709551615' });
    try {
      app.dispatch('calc/commit', { value: 5, display: '5', expr: '5' });
      assert.deepEqual([app.getState().calc.ans, app.getState().calc.ansExact, app.getState().calc.entry], [5, '', '5']);
    }
    finally { app.destroy(); }
  });

  it('reads a negative zero string as the Number does', () => {
    const env = programmerEnv();
    assert.equal(evaluate('1/ans', { ans: '-0' }, { env }).value, -Infinity);
  });
});

describe('#calc the exact add belongs to the programmer mode and keeps a negative word', function () {
  it('adds floats in the standard mode even when both words are whole', () => {
    const app = appOver({ ...calcInitialState(), mode: 'standard', ans: 2, memory: 9007199254740991 });
    try {
      app.dispatch('calc/mem-add');
      assert.deepEqual([app.getState().calc.memory, app.getState().calc.memoryExact], [9007199254740992, '']);
    }
    finally { app.destroy(); }
  });

  it('commits, reuses and adds a negative word beyond 2^53', () => {
    const { app, enter, shown } = programmerApp(true);
    try {
      app.dispatch('calc/base', { base: 'DEC' });
      enter('0x8000000000000000');
      app.dispatch('calc/equals');
      assert.deepEqual([app.getState().calc.ans, app.getState().calc.ansExact], [-9223372036854775808, '-9223372036854775808']);
      app.dispatch('calc/mem-add');
      app.dispatch('calc/mem-add');
      assert.equal(app.getState().calc.memoryExact, '-18446744073709551616');
      enter('ans');
      assert.equal(shown(), '-9223372036854775808');
    }
    finally { app.destroy(); }
  });
});
