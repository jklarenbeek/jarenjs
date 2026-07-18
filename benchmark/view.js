#!/usr/bin/env node

/**
 * JarenJS view/app performance benchmark
 *
 * Measures the cost of the @jarenjs/view + JSLT rendering pipeline
 * against hyperapp's h()/text() and preact's h() over the classic
 * 1000-row-table scenario, honestly scoped to what Node can measure:
 *
 *  - view production (state -> vnode tree): all engines, full build and
 *    one-COW-row update. Jaren runs twice — memo off (the generic
 *    dispatcher's raw cost) and memo on (the O(change) path). Hyperapp
 *    and preact re-run their plain view functions, which is their
 *    idiomatic default; both offer opt-in memo wrappers per call site,
 *    where Jaren's memo is a compile option requiring no view changes.
 *  - SSR (vnode -> HTML string): @jarenjs/view renderToString vs
 *    preact-render-to-string (hyperapp has no first-party SSR). String
 *    EQUALITY is asserted before timing.
 *  - frame cost (view + DOM patch): Jaren only, against the repository's
 *    test DOM stub — hyperapp/preact require a real DOM, so no
 *    cross-framework claim is made here; the number shows what the
 *    reference-equality skip is worth end to end.
 *
 * Usage:
 *   node benchmark/view.js
 *   node benchmark/view.js --rows 5000 --iterations 200
 */

import { compileJsltStylesheet } from '@jarenjs/json/jslt';
import { renderToString } from '@jarenjs/view';
import { createDomRenderer } from '@jarenjs/view';
import { h as hyperH, text as hyperText } from 'hyperapp';
import { h as preactH } from 'preact';
import preactRender from 'preact-render-to-string';

import { createStubHost } from '../test/view/dom.stub.js';

//#region options

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const ROWS = opt('rows', 1000);
const ITERATIONS = opt('iterations', 500);
const WARMUP = Math.max(10, Math.floor(ITERATIONS / 10));

//#endregion

//#region state

function buildState(n) {
  const rows = new Array(n);
  for (let i = 0; i < n; i++)
    rows[i] = { id: i + 1, label: `row ${i + 1} of ${n}`, selected: false };
  return { title: `${n} rows`, rows };
}

/** COW update: fresh spine, all other rows shared by reference. */
function updateRow(state, index) {
  const rows = state.rows.slice();
  const row = rows[index];
  rows[index] = { ...row, label: `${row.label} *`, selected: !row.selected };
  return { ...state, rows };
}

//#endregion

//#region the three views (asserted equivalent through SSR)

const JSLT_VIEW = [
  {
    match: '$', body:
      ['main', {},
        ['h1', {}, '$.title'],
        ['table', {}, ['tbody', {}, [{ $apply: '$.rows[*]' }]]]],
  },
  {
    match: '$.rows[*]', body:
      ['tr', { class: { $if: ['$.selected', 'danger', null] }, 'data-id': '$.id' },
        ['td', { class: 'col' }, '$.label']],
  },
];

const jarenPlain = compileJsltStylesheet(JSLT_VIEW);
const jarenMemo = compileJsltStylesheet(JSLT_VIEW, { memo: true });

function hyperappView(state) {
  return hyperH('main', {}, [
    hyperH('h1', {}, hyperText(state.title)),
    hyperH('table', {}, [
      hyperH('tbody', {}, state.rows.map((row) =>
        hyperH('tr', { class: row.selected ? 'danger' : null, 'data-id': row.id }, [
          hyperH('td', { class: 'col' }, hyperText(row.label)),
        ]))),
    ]),
  ]);
}

function preactView(state) {
  return preactH('main', null,
    preactH('h1', null, state.title),
    preactH('table', null,
      preactH('tbody', null, state.rows.map((row) =>
        preactH('tr', { class: row.selected ? 'danger' : null, 'data-id': row.id },
          preactH('td', { class: 'col' }, row.label))))));
}

//#endregion

//#region timing

function measure(label, run) {
  for (let i = 0; i < WARMUP; i++) run(i);
  const start = process.hrtime.bigint();
  for (let i = 0; i < ITERATIONS; i++) run(i);
  const ns = Number(process.hrtime.bigint() - start) / ITERATIONS;
  return { label, ns };
}

function fmt(ns) {
  if (ns < 1000) return `${ns.toFixed(0)} ns`;
  if (ns < 1e6) return `${(ns / 1000).toFixed(1)} µs`;
  return `${(ns / 1e6).toFixed(2)} ms`;
}

function printTable(title, rows) {
  console.log(`\n${title}`);
  const base = rows[0].ns;
  for (const row of rows) {
    const ratio = row.ns / base;
    const suffix = row === rows[0] ? '' : `  (${ratio >= 1 ? ratio.toFixed(1) + 'x slower' : (1 / ratio).toFixed(1) + 'x faster'} than ${rows[0].label})`;
    console.log(`  ${row.label.padEnd(28)} ${fmt(row.ns).padStart(10)}${suffix}`);
  }
}

//#endregion

//#region equivalence gate

const state0 = buildState(ROWS);
const jarenHtml = renderToString(jarenPlain(state0));
const preactHtml = preactRender(preactView(state0));
if (jarenHtml !== preactHtml) {
  console.error('EQUIVALENCE FAILURE: jaren and preact SSR output differ');
  console.error('jaren :', jarenHtml.slice(0, 200));
  console.error('preact:', preactHtml.slice(0, 200));
  process.exit(1);
}
const memoHtml = renderToString(jarenMemo(state0));
if (memoHtml !== jarenHtml) {
  console.error('EQUIVALENCE FAILURE: memoized transform output differs');
  process.exit(1);
}
console.log(`equivalence: jaren (plain & memo) === preact SSR for ${ROWS} rows, ${jarenHtml.length} chars`);

//#endregion

//#region scenarios

console.log(`\nrows: ${ROWS}, iterations: ${ITERATIONS} (+${WARMUP} warmup), node ${process.version}`);

// full view production: fresh state every iteration (memo cold)
{
  const states = [buildState(ROWS), buildState(ROWS)];
  printTable('view production — full build (state -> vnodes)', [
    measure('preact h()', (i) => preactView(states[i & 1])),
    measure('hyperapp h()/text()', (i) => hyperappView(states[i & 1])),
    measure('jaren jslt (memo, cold)', (i) => jarenMemo(states[i & 1])),
    measure('jaren jslt (no memo)', (i) => jarenPlain(states[i & 1])),
  ].sort((a, b) => a.ns - b.ns));
}

// one-row update: COW state, memo warm
{
  let memoState = buildState(ROWS);
  jarenMemo(memoState);
  let plainState = buildState(ROWS);
  let hyperState = buildState(ROWS);
  let preactState = buildState(ROWS);
  printTable(`view production — one COW row updated of ${ROWS}`, [
    measure('jaren jslt (memo, warm)', (i) => {
      memoState = updateRow(memoState, i % ROWS);
      return jarenMemo(memoState);
    }),
    measure('preact h()', (i) => {
      preactState = updateRow(preactState, i % ROWS);
      return preactView(preactState);
    }),
    measure('hyperapp h()/text()', (i) => {
      hyperState = updateRow(hyperState, i % ROWS);
      return hyperappView(hyperState);
    }),
    measure('jaren jslt (no memo)', (i) => {
      plainState = updateRow(plainState, i % ROWS);
      return jarenPlain(plainState);
    }),
  ].sort((a, b) => a.ns - b.ns));
}

// SSR
{
  const memoSsrState = buildState(ROWS);
  printTable('SSR — vnodes -> HTML string', [
    measure('jaren renderToString (memo)', () => renderToString(jarenMemo(memoSsrState))),
    measure('jaren renderToString', () => renderToString(jarenPlain(state0))),
    measure('preact-render-to-string', () => preactRender(preactView(state0))),
  ].sort((a, b) => a.ns - b.ns));
}

// end-to-end frame: view + DOM patch against the stub (jaren only)
{
  const frame = (transform) => {
    const { document, container } = createStubHost();
    const render = createDomRenderer(container, { document });
    let state = buildState(ROWS);
    render(transform(state));
    return (i) => {
      state = updateRow(state, i % ROWS);
      render(transform(state));
    };
  };
  printTable(`frame cost — view + patch, one row updated of ${ROWS} (stub DOM; no cross-framework claim)`, [
    measure('jaren view+patch (memo)', frame(jarenMemo)),
    measure('jaren view+patch (no memo)', frame(jarenPlain)),
  ].sort((a, b) => a.ns - b.ns));
}

console.log('\nMethodology: plain idiomatic views on every side; hyperapp and preact re-run the whole');
console.log('view function per state change (their default; both offer opt-in per-site memo wrappers,');
console.log("where Jaren's memo is a compile option requiring no view changes). DOM patching is");
console.log('excluded from cross-framework rows because Node has no DOM; SSR compares equal strings.');

//#endregion
