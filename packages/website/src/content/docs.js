//@ts-check
/**
 * The documentation the SITE owns — a content document. Each section's
 * `blocks` are kind-tagged render nodes (lib/nodes.js vocabulary)
 * rendered by the generic 'ui' rules; editing the docs means editing
 * JSON, and an LLM constrained to the vnode/kind schemas could write
 * these pages.
 *
 * What is here is only what the SITE can answer: how to install the
 * suite, the measured conformance scorecard the derivation boundary
 * fills, the frozen binding tables beside the contract this page runs
 * on, and where to read further. Every package's own section is
 * committed as markdown beside its code and collected by the build, so
 * the page a reader sees is these four sections plus the twenty the
 * workspaces own. `tail: true` marks a section that closes the page —
 * the collected sections go before it.
 */

import { p, code, callout } from '../lib/nodes.js';

export const DOCS_SECTIONS = [
  {
    id: 'installation', title: 'Installation',
    blocks: [
      p('Every package is published on npm under the @jarenjs scope, zero-dependency and ESM. Install what you need — the validator pulls in nothing you do not ask for.'),
      code(null, 'npm install @jarenjs/validate\nnpm install @jarenjs/formats   # format keyword validators\nnpm install @jarenjs/json      # pointer, path, patch, query, JSLT\nnpm install @jarenjs/forms     # schema-driven forms\nnpm install @jarenjs/view @jarenjs/app  # UIs as JSON documents'),
      p('Node 24 or newer (the engines field every package publishes); browsers via any bundler. No eval, no new Function: everything is CSP-safe by construction.'),
    ],
  },
  {
    id: 'draft-support', title: 'Draft support',
    blocks: [
      p('draft-06, draft-07, 2019-09 and 2020-12 are supported — including annotation-driven unevaluatedProperties/unevaluatedItems, $dynamicRef/$dynamicAnchor and $vocabulary processing. The official test suite is scored on every benchmarked draft, optional format suites included, and each engine is counted over the tests it could run — so a case the rival cannot compile still counts here.'),
      // the scorecard is the generated run, not a transcription of it:
      // the derivation boundary fills this block from the same suite
      // file the Benchmarks page reads
      { kind: 'measured', suite: 'validate' },
    ],
  },
  {
    // The contract layer's own documentation is committed with the
    // package (its workspace carries the section); what stays here is
    // what only the SITE can answer — the frozen capability tables of
    // the three bindings, and the compiled document this page is
    // reading through while you look at it.
    id: 'site-contract', title: 'This site runs on a contract', tail: true,
    blocks: [
      p('A binding is a promise about what a wire can carry, and each one publishes a frozen capability table rather than degrading in silence. These are those tables, read off the three bindings the packages ship — and below them, the $contract document this website itself runs on.'),
      { kind: 'table', title: 'What each binding carries', note: 'from the frozen capabilities table each binding publishes — a binding that cannot carry a feature says so, never degrades silently', head: ['capability', 'http', 'local', 'port'], rows: [
        { kind: 'row', cells: ['status codes', 'yes', 'no (status: null)', 'no (status: null)'] },
        { kind: 'row', cells: ['headers / etag', 'yes', 'no', 'no'] },
        { kind: 'row', cells: ['idempotency', 'with a ledger', 'no — stated', 'no — stated'] },
        { kind: 'row', cells: ['stream (subscribe)', 'SSE, resumable', 'no', 'push frames'] },
      ] },
      // the docs page renders the site's OWN compiled contract here —
      // describe(), its revision and its projections, live
      { kind: 'site-contract' },
    ],
  },
  {
    id: 'further-reading', title: 'Further reading', tail: true,
    blocks: [
      p('The language contracts live with their packages: QUERY-FORMAT.md, JSLT-FORMAT.md, XQUERY-FRONTEND.md, VIEW-FORMAT.md, APP-FORMAT.md, FLOW-FORMAT.md, ERROR-MESSAGES.md and the JOSL FORMAT.md. The repository README maps the whole suite; benchmark/README.md documents how every number on this site is measured.'),
      callout('The code is the reference', 'Every public function carries JSDoc. When in doubt, open the source — the packages are written to be read.'),
    ],
  },
];
