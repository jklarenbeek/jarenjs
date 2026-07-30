#!/usr/bin/env node

/**
 * JarenJS view/app performance benchmark
 *
 * Measures the cost of the @jarenjs/view + JSLT rendering pipeline
 * against React's createElement, hyperapp's h()/text() and preact's h()
 * over the classic 1000-row-table scenario, honestly scoped to what
 * Node can measure:
 *
 *  - view production (state -> element tree): all engines, full build
 *    and one-COW-row update. Jaren runs twice — memo off (the generic
 *    dispatcher's raw cost) and memo on (the O(change) path). React,
 *    hyperapp and preact re-run their plain view functions, which is
 *    their idiomatic default; each offers opt-in memoization per call
 *    site (React.memo/useMemo, preact/compat memo), where Jaren's memo
 *    is a compile option requiring no view changes.
 *  - SSR (element tree -> HTML string): @jarenjs/view renderToString vs
 *    react-dom/server renderToString and preact-render-to-string
 *    (hyperapp has no first-party SSR). String EQUALITY is asserted
 *    before timing.
 *  - frame cost (view + DOM patch): Jaren only, against the repository's
 *    test DOM stub — React, hyperapp and preact require a real DOM, so
 *    no cross-framework claim is made here; the number shows what the
 *    reference-equality skip is worth end to end.
 *
 * Usage:
 *   node benchmark/view.js
 *   node benchmark/view.js --rows 5000 --iterations 200
 */

import { writeFileSync } from 'node:fs';

import { compileJsltStylesheet } from '@jarenjs/json/jslt';
import { createDomRenderer, renderToString } from '@jarenjs/view';
import { h as hyperH, text as hyperText } from 'hyperapp';
import { h as preactH } from 'preact';
import preactRender from 'preact-render-to-string';

import { createStubHost } from '../test/view/dom.stub.js';
import { makeMeasure, printTable as printRows } from './lib/measure.js';

// React is measured in its PRODUCTION build: the development build carries
// prop validation and warning machinery that inflates every number, and
// timing a rival's debug mode would rig the table. React's entry points
// select the build from NODE_ENV at require time, so it is forced before
// the one import in this file that cannot be static. Nothing else here
// branches on NODE_ENV.
process.env.NODE_ENV = 'production';
const { createElement: reactH } = await import('react');
const { renderToString: reactRender } = await import('react-dom/server');

//#region options

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const ROWS = opt('rows', 1000);
const ITERATIONS = opt('iterations', 500);
const WARMUP = Math.max(10, Math.floor(ITERATIONS / 10));
const OUTPUT = args.includes('--output') ? args[args.indexOf('--output') + 1] : null;
const FILEPATH = args.includes('--filepath') ? args[args.indexOf('--filepath') + 1] : null;

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

// The same prop shapes as the other views (no keys — keys buy React
// reconciliation, not element production, and none of the other views
// carry them), spelled with className because that is what react-dom
// serializes without complaint.
function reactView(state) {
  return reactH('main', null,
    reactH('h1', null, state.title),
    reactH('table', null,
      reactH('tbody', null, state.rows.map((row) =>
        reactH('tr', { className: row.selected ? 'danger' : null, 'data-id': row.id },
          reactH('td', { className: 'col' }, row.label))))));
}

//#endregion

//#region timing

const measure = makeMeasure(WARMUP, ITERATIONS);

const printTable = (title, rows) => printRows(title, rows, { width: 28 });

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
const reactHtml = reactRender(reactView(state0));
if (reactHtml !== jarenHtml) {
  console.error('EQUIVALENCE FAILURE: jaren and react SSR output differ');
  console.error('jaren:', jarenHtml.slice(0, 200));
  console.error('react:', reactHtml.slice(0, 200));
  process.exit(1);
}
console.log(`equivalence: jaren (plain & memo) === preact === react SSR for ${ROWS} rows, ${jarenHtml.length} chars`);

//#endregion

//#region scenarios

console.log(`\nrows: ${ROWS}, iterations: ${ITERATIONS} (+${WARMUP} warmup), node ${process.version}`);

/** Every measured table, kept for the `--output json` emit below. */
const collected = {};

// full view production: fresh state every iteration (memo cold)
{
  const states = [buildState(ROWS), buildState(ROWS)];
  collected.build = [
    measure('preact h()', (i) => preactView(states[i & 1])),
    measure('react createElement()', (i) => reactView(states[i & 1])),
    measure('hyperapp h()/text()', (i) => hyperappView(states[i & 1])),
    measure('jaren jslt (memo, cold)', (i) => jarenMemo(states[i & 1])),
    measure('jaren jslt (no memo)', (i) => jarenPlain(states[i & 1])),
  ].sort((a, b) => a.ns - b.ns);
  printTable('view production — full build (state -> vnodes)', collected.build);
}

// one-row update: COW state, memo warm
{
  let memoState = buildState(ROWS);
  jarenMemo(memoState);
  let plainState = buildState(ROWS);
  let hyperState = buildState(ROWS);
  let preactState = buildState(ROWS);
  let reactState = buildState(ROWS);
  collected.update = [
    measure('jaren jslt (memo, warm)', (i) => {
      memoState = updateRow(memoState, i % ROWS);
      return jarenMemo(memoState);
    }),
    measure('preact h()', (i) => {
      preactState = updateRow(preactState, i % ROWS);
      return preactView(preactState);
    }),
    measure('react createElement()', (i) => {
      reactState = updateRow(reactState, i % ROWS);
      return reactView(reactState);
    }),
    measure('hyperapp h()/text()', (i) => {
      hyperState = updateRow(hyperState, i % ROWS);
      return hyperappView(hyperState);
    }),
    measure('jaren jslt (no memo)', (i) => {
      plainState = updateRow(plainState, i % ROWS);
      return jarenPlain(plainState);
    }),
  ].sort((a, b) => a.ns - b.ns);
  printTable(`view production — one COW row updated of ${ROWS}`, collected.update);
}

// SSR
{
  const memoSsrState = buildState(ROWS);
  collected.ssr = [
    measure('jaren renderToString (memo)', () => renderToString(jarenMemo(memoSsrState))),
    measure('jaren renderToString', () => renderToString(jarenPlain(state0))),
    measure('preact-render-to-string', () => preactRender(preactView(state0))),
    measure('react-dom/server renderToString', () => reactRender(reactView(state0))),
  ].sort((a, b) => a.ns - b.ns);
  printTable('SSR — vnodes -> HTML string', collected.ssr);
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
  collected.frame = [
    measure('jaren view+patch (memo)', frame(jarenMemo)),
    measure('jaren view+patch (no memo)', frame(jarenPlain)),
  ].sort((a, b) => a.ns - b.ns);
  printTable(`frame cost — view + patch, one row updated of ${ROWS} (stub DOM; no cross-framework claim)`, collected.frame);
}

// the memo marker (VIEW-FORMAT §5.5): a reallocated parent over shared
// children — the plain diff walks every child to discover the ===
// skips (O(n) scan, zero DOM work); an equal marker skips the subtree
// without looking at one (O(1)). The vnode-level half of the
// incremental-chart program, for producers that cannot preserve the
// parent reference but can prove stability with a token.
{
  const children = Array.from({ length: ROWS * 10 },
    (_, i) => ['span', { class: 'c' }, String(i)]);
  const tree = (memo) => ['div', {},
    memo === undefined
      ? ['section', {}, ...children]
      : ['section', { memo }, ...children]];
  const { document, container } = createStubHost();
  const render = createDomRenderer(container, { document });
  render(tree('v1'));
  const memoRow = measure('memo-equal marker skip', () => render(tree('v1')));
  render(tree(undefined));
  const scanRow = measure('=== child scan (no memo)', () => render(tree(undefined)));
  collected.memo = [memoRow, scanRow];
  collected.memoChildren = ROWS * 10;
  printTable(`memo marker — reallocated parent over ${ROWS * 10} shared children`, collected.memo);
}

if (OUTPUT === 'json') {
  // The website-data shape (benchmark/website-data.js → view.json): the
  // four measured tables plus the memo-marker pair, each row a
  // {label, ns} the site renders as a grouped bar chart and a table.
  const data = {
    date: new Date().toISOString(),
    node: process.version,
    rows: ROWS,
    iterations: ITERATIONS,
    ssrChars: jarenHtml.length,
    memoChildren: collected.memoChildren,
    tables: {
      build: collected.build,
      update: collected.update,
      ssr: collected.ssr,
      frame: collected.frame,
      memo: collected.memo,
    },
  };
  const json = JSON.stringify(data, null, 2);
  if (FILEPATH !== null) {
    writeFileSync(FILEPATH, json);
    console.log(`\nwrote ${FILEPATH}`);
  }
  else {
    console.log(json);
  }
}

console.log('\nMethodology: plain idiomatic views on every side; react, hyperapp and preact re-run the');
console.log('whole view function per state change (their default; each offers opt-in per-site memo,');
console.log("where Jaren's memo is a compile option requiring no view changes). React runs its");
console.log('PRODUCTION build. DOM patching is excluded from cross-framework rows because Node has');
console.log('no DOM; SSR compares byte-equal strings.');

//#endregion
