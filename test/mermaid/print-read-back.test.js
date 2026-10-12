//@ts-check
/**
 * The printer's output reads back as the diagram it came from. A state
 * diagram that labels a state after using it printed the label first, so
 * the states came back in another order (layout follows that order); a
 * class member holding a closing brace ended its body early; a pie label
 * with a line break printed the break raw, and a very small or very large
 * value printed in exponent form, which a pie row does not read.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMermaid, toMermaid } from '@jarenjs/mermaid';

/**
 * Print, re-parse, and require the same AST.
 * @param {string} source @returns {{ text: string, ast: any }}
 */
function roundTrip(source) {
  const first = parseMermaid(source);
  const text = toMermaid(first);
  const again = parseMermaid(text);
  assert.deepEqual(again.ast, first.ast, `drift for ${JSON.stringify(text)}`);
  assert.equal(toMermaid(again), text);
  return { text, ast: first.ast };
}

describe('stateDiagram — the states keep their order through the printer', function () {
  it('declares a labelled state where the diagram first uses it', () => {
    const { text, ast } = roundTrip('stateDiagram-v2\n[*] --> Still\nStill --> Moving\nMoving : Moving fast');
    assert.deepEqual(ast.states.map((/** @type {any} */ s) => s.id), ['Still', 'Moving']);
    assert.equal(text, 'stateDiagram-v2\nstate Still\nMoving : Moving fast\n[*] --> Still\nStill --> Moving\n');
  });

  it('declares a child before the compound state that holds it', () => {
    const { text, ast } = roundTrip('stateDiagram-v2\nS1 : first\nstate S2 {\nstate S1 {\n}\n}');
    assert.deepEqual(ast.states.map((/** @type {any} */ s) => [s.id, s.parent]), [['S1', 'S2'], ['S2', undefined]]);
    assert.equal(text, 'stateDiagram-v2\nS1 : first\nstate S2\nstate S2 {\n  state S1\n}\n');
  });

  it('prints a diagram whose order is already the printed one exactly as before', () => {
    const { text } = roundTrip('stateDiagram-v2\nA : Alpha\nA --> B : go');
    assert.equal(text, 'stateDiagram-v2\nA : Alpha\nA --> B : go\n');
  });

  it('declares an idle state after the states a transition introduces before it', () => {
    const { text, ast } = roundTrip('stateDiagram-v2\nA : Alpha\nA --> B : go\nstate C');
    assert.deepEqual(ast.states.map((/** @type {any} */ s) => s.id), ['A', 'B', 'C']);
    assert.equal(text, 'stateDiagram-v2\nA : Alpha\nstate B\nstate C\nA --> B : go\n');
  });
});

describe('classDiagram — a member that cannot stand in a body prints as a line', function () {
  it('keeps a member holding a closing brace', () => {
    const { text, ast } = roundTrip('classDiagram\nA : +f(){}\nA : x');
    assert.deepEqual(ast.classes[0].members.map((/** @type {any} */ m) => m.text), ['f(){}', 'x']);
    assert.equal(text, 'classDiagram\nclass A\nA : +f(){}\nA : x\n');
  });

  it('keeps a member that looks like a comment', () => {
    const { text } = roundTrip('classDiagram\nA : %% note\nA : y');
    assert.equal(text, 'classDiagram\nclass A\nA : %% note\nA : y\n');
  });

  it('still prints the members of an ordinary class in a body', () => {
    const { text } = roundTrip('classDiagram\nclass A {\n  +f()\n  -x\n}');
    assert.equal(text, 'classDiagram\nclass A {\n  +f()\n  -x\n}\n');
  });
});

describe('pie — a label and a value print the way a row reads them', function () {
  it('prints a line break in a label as the tag and keeps it a break', () => {
    const { text, ast } = roundTrip('pie\n"a<br/>b" : 3');
    assert.equal(ast.slices[0].label, 'a\nb');
    assert.equal(text, 'pie\n"a<br/>b" : 3\n');
  });

  it('prints a very small or very large value as a plain decimal', () => {
    const { text, ast } = roundTrip('pie\n"a" : 0.0000001\n"b" : 100000000000000000000000\n"c" : 1.5\n"d" : 0.000000000015');
    assert.deepEqual(ast.slices.map((/** @type {any} */ s) => s.value), [1e-7, 1e23, 1.5, 1.5e-11]);
    assert.equal(text, 'pie\n"a" : 0.0000001\n"b" : 100000000000000000000000\n"c" : 1.5\n"d" : 0.000000000015\n');
  });

  it('prints a hand-built negative value in exponent form with its sign in front', () => {
    const ast = { diagram: 'pie', title: null, showData: false, slices: [{ label: 'a', value: -1e-7 }] };
    assert.equal(toMermaid(ast), 'pie\n"a" : -0.0000001\n');
  });
});
