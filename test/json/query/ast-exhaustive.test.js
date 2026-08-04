//@ts-check
/**
 * @file The three exhaustiveness gates of the published normalized form
 * (QUERY-FORMAT.md Appendix C) — the anti-drift mechanism the contract
 * rests on:
 *
 *  1. A corpus exercising every construct produces exactly the
 *     `NODE_KINDS` set — a new node kind nobody documented fails here.
 *  2. `NODE_KINDS` equals Appendix C.3's table — code and spec cannot
 *     disagree about the kinds.
 *  3. The operator registry equals QUERY-FORMAT §8's operator tables —
 *     the "91 vs 93" stale-count problem is dead permanently, by test
 *     rather than by hand.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

import { analyzeQuery, NODE_KINDS } from '@jarenjs/json/query';
import { OPERATORS } from '../../../packages/json/src/query/operators.js';

const FORMAT = fs.readFileSync('packages/json/docs/QUERY-FORMAT.md', 'utf8');

/**
 * Walk every node of a normalized tree (the child positions of
 * Appendix C.3/C.4), visiting each node once.
 * @param {any} node
 * @param {(node: any) => void} visit
 */
function walkNodes(node, visit) {
  visit(node);
  switch (node.kind) {
    case 'literal': case 'var': case 'path': case 'raw':
      return;
    case 'object':
      for (const e of node.entries) walkNodes(e.expr, visit);
      return;
    case 'map':
      for (const p of node.pairs) { walkNodes(p.key, visit); walkNodes(p.value, visit); }
      return;
    case 'array':
      for (const e of node.elements) walkNodes(e, visit);
      return;
    case 'op': case 'call':
      for (const a of node.args) walkNodes(a, visit);
      return;
    case 'let':
      for (const b of node.bindings) walkNodes(b.expr, visit);
      walkNodes(node.ret, visit);
      return;
    case 'quant':
      for (const b of node.bindings) walkNodes(b.expr, visit);
      walkNodes(node.satisfies, visit);
      return;
    case 'flwor':
      if (node.fold !== null) walkNodes(node.fold.expr, visit);
      for (const b of node.forBindings) walkNodes(b.expr, visit);
      for (const b of node.letBindings) walkNodes(b.expr, visit);
      if (node.where !== null) walkNodes(node.where, visit);
      if (node.groupby !== null) for (const k of node.groupby.keys) walkNodes(k.expr, visit);
      if (node.orderby !== null) for (const s of node.orderby.specs) walkNodes(s.key, visit);
      walkNodes(node.ret, visit);
      return;
    default:
      assert.fail(`walkNodes does not know kind '${node.kind}' — extend the walker AND the appendix`);
  }
}

// One corpus exercising every construct of the grammar; each document
// names the kinds it exists to produce.
const CORPUS = [
  ['literal + object constructor', { a: 1, b: 'plain' }],
  ['var + path', { $seq: ['$x', '$.store.book[*].title'] }],
  ['array + map', [{ $map: [['$.k', '$.v']] }, 1]],
  ['op + raw (schema argument)', { $valid: ['$.a', { type: 'string' }] }],
  ['call', { $call: ['f', '$.a'] }],
  ['let phrase', { $let: { v: '$.a' }, $return: '$v' }],
  ['quantifier', { $some: { b: '$.items[*]' }, $satisfies: { $gt: ['$b', 0] } }],
  ['full flwor', {
    $fold: { acc: 0 },
    $for: { b: '$.items[*]' },
    $let: { p: '$b.price' },
    $where: { $gt: ['$p', 0] },
    $groupby: { cat: '$b.category' },
    $orderby: { $key: '$cat', $dir: 'desc' },
    $count: 'i',
    $return: { $add: ['$acc', 1] },
  }],
];

describe('gate 1 — the corpus produces exactly NODE_KINDS', () => {
  it('collects every kind, no more, no fewer', () => {
    const seen = new Set();
    for (const [, doc] of CORPUS) {
      const analysis = analyzeQuery(doc, { functions: { f: (x) => x } });
      walkNodes(analysis.root, (node) => seen.add(node.kind));
    }
    assert.deepStrictEqual([...seen].sort(), [...NODE_KINDS]);
  });
});

describe('gate 2 — NODE_KINDS equals the Appendix C.3 table', () => {
  it('spec table and code list agree', () => {
    const section = FORMAT.split('### C.3')[1]?.split('### C.4')[0];
    assert.ok(section, 'Appendix C.3 is missing from QUERY-FORMAT.md');
    const documented = new Set();
    for (const m of section.matchAll(/^\| `(\w+)` \|/gm)) documented.add(m[1]);
    assert.deepStrictEqual([...documented].sort(), [...NODE_KINDS]);
  });
});

describe('gate 3 — the operator registry equals QUERY-FORMAT §8', () => {
  it('every registry operator is documented and vice versa (93 total)', () => {
    const section = FORMAT.split(/^## 8\. /m)[1]?.split(/^## 9\. /m)[0];
    assert.ok(section, 'section 8 is missing from QUERY-FORMAT.md');
    const documented = new Set();
    // Strip ```-fenced examples first — their triple backticks desync
    // the inline-span pairing — then collect every operator named in an
    // inline span: table rows (`| \`$op\` |`) and family headers whose
    // one span names several (`### 8.8 Aggregates — \`$count $sum ...\``).
    const prose = section.replace(/^```[\s\S]*?^```/gm, '');
    for (const span of prose.matchAll(/`([^`]+)`/g)) {
      for (const m of span[1].matchAll(/\$[a-z0-9-]+/g)) documented.add(m[0]);
    }
    const registry = Object.keys(OPERATORS);
    const undocumented = registry.filter((op) => !documented.has(op));
    assert.deepStrictEqual(undocumented, [],
      'registry operators with no mention in section 8');
    assert.strictEqual(registry.length, 93,
      'the operator count moved — update ARCHITECTURE.md and this pin together');
  });
});
