//@ts-check
/**
 * @file The flow pen, held to the format: FLOW-FORMAT §2's machine and
 * §6's dataflow are rebuilt through the pen and asserted BYTE-EQUAL to
 * the documents in the format doc — read from its fences at test time,
 * never a copy — then validated against the published grammars,
 * compiled with the real engines and stepped/run. Beside the two
 * examples: the string-guard refusal §3 names itself, the undeclared
 * state and node ids, the `jaren-workflow` projection a pen machine is
 * a superset of, `fsmToApp`, the node kinds and checkpointing, the
 * refusals by code, two-run determinism and the no-engine rule.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';

import {
  constant, defineDag, defineFsm, edge, effect, input, jslt, on, output, query, state, task,
  typedTasks,
} from '@jarenjs/linq/flow';
import { rule, stylesheet } from '@jarenjs/linq/jslt';
import * as s from '@jarenjs/linq/schema';
import { LinqBuildError } from '@jarenjs/linq';
import {
  compileDag, compileFsm, createFsmSession, fsmToApp, FlowCompileError,
} from '@jarenjs/flow';
import { JarenValidator } from '@jarenjs/validate';
import { jsonFormats } from '@jarenjs/formats';

const DOC = new URL('../../packages/flow/docs/FLOW-FORMAT.md', import.meta.url);
const FLOW_SRC = new URL('../../packages/linq/src/flow/', import.meta.url);
const load = (path) => JSON.parse(fs.readFileSync(new URL(path, import.meta.url), 'utf8'));

const querySchema = load('../../packages/json/schemas/jaren-query.schema.json');
const jsltSchema = load('../../packages/json/schemas/jaren-jslt.schema.json');
const fsmSchema = load('../../packages/flow/schemas/jaren-fsm.schema.json');
const dagSchema = load('../../packages/flow/schemas/jaren-dag.schema.json');
const workflowSchema = load('../../components/mermaid/schemas/jaren-workflow.schema.json');

const validateFsm = new JarenValidator().addFormats(jsonFormats)
  .addSchema(querySchema).compile(fsmSchema);
const validateDag = new JarenValidator().addFormats(jsonFormats)
  .addSchema(querySchema).addSchema(jsltSchema).compile(dagSchema);
const validateWorkflow = new JarenValidator().addFormats(jsonFormats).compile(workflowSchema);

/** The bytes a document is: JSON text, member order included. @param {any} doc */
const bytes = (doc) => JSON.stringify(doc);

/**
 * The first ```json fence of one `## §n …` section, parsed — the
 * format's own worked example, read at test time.
 * @param {string} heading - the section heading, `§2` say
 * @returns {any}
 */
function example(heading) {
  const markdown = fs.readFileSync(DOC, 'utf8');
  const start = markdown.indexOf(`\n## ${heading} `);
  assert.notStrictEqual(start, -1, `FLOW-FORMAT carries ${heading}`);
  const next = markdown.indexOf('\n## ', start + 1);
  const section = markdown.slice(start, next === -1 ? undefined : next);
  const fence = /```json\n([\s\S]*?)```/.exec(section);
  assert.ok(fence, `${heading} carries a worked example`);
  return JSON.parse(fence[1]);
}

describe('FLOW-FORMAT §2, rebuilt through the pen', () => {
  /** §2's machine, by code. */
  const build = () => defineFsm({
    initial: 'idle',
    states: [
      'idle',
      state('loading', { entry: [effect('fetch', (sc) => ({ url: sc.context.url }))] }),
      state('done', { final: true }),
    ],
    transitions: [
      on('idle', 'start').to('loading'),
      on('loading', 'ok').when((sc) => sc.payload.fresh).to('done'),
      on('loading', 'fail').to('idle').effects([effect('toast', () => ({ text: 'retrying' }))]),
    ],
  });

  it('is byte-equal to the doc, valid under the grammar, and two builds are one document', () => {
    const doc = build();
    assert.strictEqual(bytes(doc), bytes(example('§2')), '§2 byte-equal');
    assert.strictEqual(bytes(build()), bytes(doc), 'two runs, one document');
    assert.deepStrictEqual(JSON.parse(bytes(doc)), doc, 'plain JSON');
    assert.strictEqual(Object.isFrozen(doc), true);
    assert.strictEqual(Object.isFrozen(/** @type {any} */ (doc).transitions[1]), true);
    assert.strictEqual(validateFsm(doc), true, 'valid under jaren-fsm 0.1');
  });

  it('compiles and steps to the results §2, §3 and §4 document', () => {
    const fsm = compileFsm(build());
    assert.deepStrictEqual(fsm.states, ['idle', 'loading', 'done']);
    assert.strictEqual(fsm.initial, 'idle');

    // the entry effect resolves its `with` against $.context
    const started = fsm.step('idle', 'start', { context: { url: '/rows' } });
    assert.deepStrictEqual(started,
      { changed: true, state: 'loading', effects: [{ run: 'fetch', with: { url: '/rows' } }], final: false, errors: [] });

    // the guard is asserted by EBV: a fresh payload passes, a stale one is ignored (§4)
    assert.strictEqual(fsm.step('loading', 'ok', { payload: { fresh: true } }).state, 'done');
    assert.strictEqual(fsm.step('loading', 'ok', { payload: { fresh: true } }).final, true);
    assert.deepStrictEqual(fsm.step('loading', 'ok', { payload: { fresh: false } }),
      { changed: false, state: 'loading', effects: [], final: false, errors: [] });

    // the transition's own effects fire, with the literal the pen wrote as a constructor
    assert.deepStrictEqual(fsm.step('loading', 'fail').effects, [{ run: 'toast', with: { text: 'retrying' } }]);
  });

  it('a guard captured over the scope IS the path §2 writes; a plain string is JL0102', () => {
    const doc = /** @type {any} */ (build());
    assert.strictEqual(doc.transitions[1].guard, '$.payload.fresh');
    assert.throws(() => on('review', 'approve').when('$.payload.fresh'),
      (e) => e instanceof LinqBuildError && e.code === 'JL0102' && e.docPath === '/guard'
        && /vacuously true/i.test(e.message) && /FLOW-FORMAT §3/.test(e.message)
        && /when\(\(s\) => s\.payload\.fresh\)/.test(e.message));
    // the trap the rule is about: a display guard off a diagram label
    assert.throws(() => on('a', 'go').when('count > 3'), (e) => e.code === 'JL0102');
    // an operator document by hand rides verbatim — the pen writes what it is given
    assert.deepStrictEqual(on('a', 'go').when({ $gt: ['$.payload.n', 3] }).to('a')[
      Symbol.for('@jarenjs/linq/flow-transition')].guard, { $gt: ['$.payload.n', 3] });
  });
});

describe('FLOW-FORMAT §6, rebuilt through the pen', () => {
  /** §6's dataflow, by code. The two embedded documents are §6's own. */
  const build = () => defineDag({
    nodes: {
      rows: input(),
      adults: query({ $for: { r: '$[*]' }, $where: { $ge: ['$r.age', 18] }, $return: '$r' }),
      names: jslt([rule('$', ['ul', {}, [{ $for: { p: '$[*]' }, $return: ['li', {}, '$p.name'] }]])]),
      out: output(),
    },
    edges: [edge('rows', 'adults'), edge('adults', 'names'), edge('names', 'out')],
  });

  it('is byte-equal to the doc, valid under the grammar, and two builds are one document', () => {
    const doc = build();
    assert.strictEqual(bytes(doc), bytes(example('§6')), '§6 byte-equal');
    assert.strictEqual(bytes(build()), bytes(doc), 'two runs, one document');
    assert.deepStrictEqual(JSON.parse(bytes(doc)), doc, 'plain JSON');
    assert.strictEqual(Object.isFrozen(doc), true);
    assert.strictEqual(validateDag(doc), true, 'valid under jaren-dag 0.1');
  });

  it('compiles and runs to what the doc\'s own document runs to', async () => {
    const compiled = compileDag(build());
    assert.deepStrictEqual(compiled.nodes, ['rows', 'adults', 'names', 'out']);
    assert.strictEqual(compiled.output, 'out');
    const rows = [{ name: 'ada', age: 36 }, { name: 'kit', age: 9 }, { name: 'lin', age: 20 }];
    const mine = await compiled.run(rows);
    assert.deepStrictEqual(mine, ['ul', {}, [['li', {}, 'ada'], ['li', {}, 'lin']]]);
    assert.deepStrictEqual(mine, await compileDag(example('§6')).run(rows),
      'the pen\'s document and the doc\'s own run to one value');
  });
});

describe('the flow README\'s by-code twin', () => {
  it('emits the document the README\'s own glance prints, byte for byte', () => {
    const readme = fs.readFileSync(new URL('../../packages/flow/README.md', import.meta.url), 'utf8');
    const glance = /```json\n([\s\S]*?)```/.exec(readme);
    assert.ok(glance, 'the README opens with the format in one glance');
    const doc = defineFsm({
      initial: 'idle',
      states: [
        'idle',
        state('loading', { entry: [effect('fetch', (sc) => ({ url: sc.context.url }))] }),
        state('done', { final: true }),
      ],
      transitions: [
        on('idle', 'start').to('loading'),
        on('loading', 'ok').when((sc) => sc.payload.fresh).to('done'),
        on('loading', 'fail').to('idle'),
      ],
    });
    assert.strictEqual(bytes(doc), bytes(JSON.parse(glance[1])));
  });
});

describe('the fsm pen beyond §2', () => {
  it('an undeclared state is JL0102 naming it, before the compiler\'s JF0004/JF0006', () => {
    const spec = { initial: 'draft', states: ['draft', 'review'] };
    assert.throws(() => defineFsm({ ...spec, transitions: [on('draft', 'go').to('nope')] }),
      (e) => e instanceof LinqBuildError && e.code === 'JL0102' && e.docPath === '/transitions/0/to'
        && /'nope'/.test(e.message) && /'draft', 'review'/.test(e.message));
    assert.throws(() => defineFsm({ ...spec, transitions: [on('nope', 'go').to('draft')] }),
      (e) => e.code === 'JL0102' && e.docPath === '/transitions/0/from');
    assert.throws(() => defineFsm({ initial: 'nope', states: ['draft'], transitions: [] }),
      (e) => e.code === 'JL0102' && e.docPath === '/initial');
    // the compiler is what would have said it, later
    assert.throws(() => compileFsm({ initial: 'draft', states: ['draft'], transitions: [{ from: 'draft', to: 'nope' }] }),
      (e) => e instanceof FlowCompileError && e.code === 'JF0006');
  });

  it('a wildcard writes no event, a final state writes final, and document order is kept', () => {
    const doc = /** @type {any} */ (defineFsm({
      initial: 'review',
      states: ['review', 'draft', state('gone', { exit: [effect('log')], final: true })],
      transitions: [on('review', 'approve').to('gone'), on('review').to('draft')],
    }));
    assert.strictEqual('event' in doc.transitions[1], false, 'a wildcard writes no event member');
    assert.deepStrictEqual(doc.states[2], { id: 'gone', exit: [{ run: 'log' }], final: true });
    const fsm = compileFsm(doc);
    assert.deepStrictEqual(fsm.events('review'), ['approve']);
    // §4: document order is the whole priority scheme
    assert.strictEqual(fsm.step('review', 'approve').state, 'gone');
    assert.strictEqual(fsm.step('review', 'whatever').state, 'draft');
    assert.strictEqual(createFsmSession(fsm).state, 'review');
  });

  it('a machine with string states and no guards IS a jaren-workflow document, and fsmToApp projects it', () => {
    const doc = /** @type {any} */ (defineFsm({
      initial: 'draft',
      states: ['draft', 'review', 'published'],
      transitions: [
        on('draft', 'submit').to('review'),
        on('review', 'approve').to('published'),
        on('review', 'reject').to('draft'),
      ],
    }));
    assert.strictEqual(validateFsm(doc), true, 'valid under jaren-fsm 0.1');
    assert.strictEqual(validateWorkflow(doc), true,
      'and under the mermaid projection contract §1 calls its subset');
    assert.deepStrictEqual(doc.states, ['draft', 'review', 'published']);

    const app = fsmToApp(doc);
    assert.deepStrictEqual(app.events, ['submit', 'approve', 'reject']);
    assert.strictEqual(app.slice.current, 'draft');
    assert.ok(app.actions['fsm/submit'], 'one action document per named event');
  });

  it('the context and payload builders type the machine and emit nothing', () => {
    const Cart = s.object({ total: s.number() });
    const doc = /** @type {any} */ (defineFsm({
      initial: 'a',
      states: ['a'],
      transitions: [on('a', 'go', { payload: s.object({ n: s.number() }) })
        .when((sc) => sc.context.total.gt(sc.payload.n)).to('a')],
      context: Cart,
    }));
    assert.deepStrictEqual(Object.keys(doc), ['$fsm', 'initial', 'states', 'transitions']);
    assert.deepStrictEqual(doc.transitions[0].guard, { $gt: ['$.context.total', '$.payload.n'] });
    assert.strictEqual(compileFsm(doc).step('a', 'go', { context: { total: 5 }, payload: { n: 3 } }).changed, true);
  });

  it('refuses its own surface by code', () => {
    assert.throws(() => defineFsm('$'), (e) => e.code === 'JL0101');
    assert.throws(() => defineFsm({ states: [], transitions: [] }),
      (e) => e.code === 'JL0101' && e.docPath === '/initial' && /pass null/.test(e.message));
    assert.throws(() => defineFsm({ initial: null, states: [], transitions: [], context: {} }),
      (e) => e.code === 'JL0101' && e.docPath === '/context');
    assert.throws(() => defineFsm({ initial: null, states: [], transitions: [], nope: 1 }),
      (e) => e.code === 'JL0101' && /'nope'/.test(e.message));
    assert.throws(() => defineFsm({ initial: null, states: '$', transitions: [] }),
      (e) => e.code === 'JL0101' && e.docPath === '/states');
    assert.throws(() => defineFsm({ initial: null, states: [{ id: 'a' }], transitions: [] }),
      (e) => e.code === 'JL0101' && e.docPath === '/states/0' && /state\(id/.test(e.message));
    assert.throws(() => defineFsm({ initial: null, states: ['a'], transitions: [{ from: 'a', to: 'a' }] }),
      (e) => e.code === 'JL0101' && e.docPath === '/transitions/0' && /on\(from/.test(e.message));
    assert.throws(() => defineFsm({ initial: null, states: ['a'], transitions: [on('a', 'go')] }),
      (e) => e.code === 'JL0101' && /\.to\(state\)/.test(e.message));
    assert.throws(() => state(''), (e) => e.code === 'JL0101');
    assert.throws(() => state('a', { entry: [{ run: 'x' }] }), (e) => e.code === 'JL0101' && /effect\(run/.test(e.message));
    assert.throws(() => state('a', { onEntry: [] }), (e) => e.code === 'JL0101' && /'onEntry'/.test(e.message));
    assert.throws(() => state('a', { final: 'yes' }), (e) => e.code === 'JL0101' && e.docPath === '/final');
    assert.throws(() => on(1), (e) => e.code === 'JL0101');
    assert.throws(() => on('a', 7), (e) => e.code === 'JL0101' && e.docPath === '/event');
    assert.throws(() => on('a', 'go', { payload: { type: 'object' } }), (e) => e.code === 'JL0101' && e.docPath === '/payload');
    assert.throws(() => on('a', 'go', { data: s.string() }), (e) => e.code === 'JL0101' && /'data'/.test(e.message));
    assert.throws(() => effect(''), (e) => e.code === 'JL0101' && e.docPath === '/run');
    assert.throws(() => effect('x', () => new Date(0)), (e) => e.code === 'JL0005', 'a captured non-JSON is the chain\'s refusal');
    assert.throws(() => effect('x', { with: Symbol('s') }), (e) => e.code === 'JL0101');
    // an external is JL0104 here, where the fix can be named — not JQ2006 at step time
    assert.throws(() => on('a', 'go').when((sc, x) => x.root),
      (e) => e.code === 'JL0104' && /step scope/.test(e.message)
        // this pen has no "rules", and its scope is NOT a document under
        // construction — the shared message must state neither
        && /a when\(\) callback cannot bind/.test(e.message)
        && !/document being written/.test(e.message));
    assert.throws(() => effect('x', (sc, y) => ({ n: y.rate })),
      (e) => e.code === 'JL0104' && /an effect\(\) with callback cannot bind/.test(e.message));
    assert.throws(() => edge('a', 'b', { select: (v, x) => x.root }),
      (e) => e.code === 'JL0104' && /an edge\(\) select callback cannot bind/.test(e.message));
  });

  it('the document is a value: not the caller\'s objects, and the caller\'s stay unfrozen', () => {
    const props = { text: 'retrying' };
    const doc = /** @type {any} */ (defineFsm({
      initial: 'a', states: ['a'],
      transitions: [on('a', 'go').to('a').effects([effect('toast', props)])],
    }));
    assert.deepStrictEqual(doc.transitions[0].effects[0].with, props);
    assert.notStrictEqual(doc.transitions[0].effects[0].with, props);
    assert.strictEqual(Object.isFrozen(props), false);
  });
});

describe('the dag pen beyond §6', () => {
  /** A graph over every node kind, with a checkpointed task. */
  const build = () => defineDag({
    nodes: {
      rows: input(),
      floor: constant({ min: 18 }),
      adults: query((v) => v.all()),
      shaped: jslt(stylesheet([rule('$', (v) => ({ n: v.all().count() }))])),
      asked: task('llm', (v) => ({ prompt: v.get('n') })).checkpoint(),
      out: output(),
    },
    edges: [
      edge('rows', 'adults'),
      edge('adults', 'shaped'),
      edge('shaped', 'asked'),
      edge('floor', 'out', { port: 'floor' }),
      edge('asked', 'out', { port: 'answer', select: (v) => v.get('text') }),
    ],
  });

  it('writes every node kind in the format\'s member order, checkpoint last', () => {
    const doc = /** @type {any} */ (build());
    assert.deepStrictEqual(Object.keys(doc), ['$dag', 'nodes', 'edges']);
    assert.deepStrictEqual(doc.nodes.rows, { kind: 'input' });
    assert.deepStrictEqual(doc.nodes.out, { kind: 'output' });
    assert.deepStrictEqual(doc.nodes.floor, { kind: 'const', value: { min: 18 } });
    assert.deepStrictEqual(doc.nodes.adults, { kind: 'query', query: '$[*]' });
    assert.deepStrictEqual(doc.nodes.shaped,
      { kind: 'jslt', stylesheet: { $jslt: '0.1', rules: [{ match: '$', body: { n: { $count: '$[*]' } } }] } });
    assert.deepStrictEqual(Object.keys(doc.nodes.asked), ['kind', 'run', 'with', 'checkpoint']);
    assert.deepStrictEqual(doc.nodes.asked,
      { kind: 'task', run: 'llm', with: { prompt: "$['n']" }, checkpoint: true });
    assert.deepStrictEqual(doc.edges[4], { from: 'asked', to: 'out', port: 'answer', select: "$['text']" });
    assert.strictEqual(bytes(build()), bytes(doc), 'two runs, one document');
    assert.strictEqual(validateDag(doc), true, 'valid under jaren-dag 0.1');
    assert.strictEqual(Object.isFrozen(doc), true);
    assert.deepStrictEqual(JSON.parse(bytes(doc)), doc, 'plain JSON');
  });

  it('compiles against a typed registry and runs, ports assembled in edge order', async () => {
    const graph = build();
    /** @type {any[]} */
    const seen = [];
    const compiled = compileDag(graph, {
      tasks: typedTasks(graph, { llm: async ({ with: w }) => ({ text: `n=${w.prompt}` }) }),
      checkpoint: {
        load: () => null,
        save: (runId, nodeId, value) => seen.push([runId, nodeId, value]),
        complete: () => undefined,
      },
    });
    const result = await compiled.run([1, 2, 3], { runId: 'run-1' });
    assert.deepStrictEqual(result, { floor: { min: 18 }, answer: 'n=3' });
    assert.deepStrictEqual(seen, [['run-1', 'asked', { text: 'n=3' }]],
      'only the node that declared checkpoint is recorded (§7.6)');
  });

  it('an undeclared node id is JL0102 naming it, before the compiler\'s JF0013', () => {
    const nodes = { rows: input(), out: output() };
    assert.throws(() => defineDag({ nodes, edges: [edge('nope', 'out')] }),
      (e) => e instanceof LinqBuildError && e.code === 'JL0102' && e.docPath === '/edges/0/from'
        && /'nope'/.test(e.message) && /'rows', 'out'/.test(e.message));
    assert.throws(() => defineDag({ nodes, edges: [edge('rows', 'nope')] }),
      (e) => e.code === 'JL0102' && e.docPath === '/edges/0/to');
    assert.throws(() => compileDag({ $dag: '0.1', nodes: { i: { kind: 'input' }, o: { kind: 'output' } }, edges: [{ from: 'nope', to: 'o' }] }),
      (e) => e instanceof FlowCompileError && e.code === 'JF0013');
  });

  it('does not judge the wiring rules, acyclicity, the single output or the registry — the compiler does', () => {
    const cyclic = defineDag({
      nodes: { a: query('$'), b: query('$'), out: output() },
      edges: [edge('a', 'b'), edge('b', 'a'), edge('b', 'out')],
    });
    assert.strictEqual(validateDag(cyclic), true, 'the grammar cannot see a cycle either');
    assert.throws(() => compileDag(cyclic), (e) => e.code === 'JF0016');
    assert.throws(() => compileDag(defineDag({ nodes: { i: input(), o: output(), o2: output() }, edges: [edge('i', 'o'), edge('i', 'o2')] })),
      (e) => e.code === 'JF0017');
    assert.throws(() => compileDag(defineDag({ nodes: { i: input(), c: constant(1), out: output() }, edges: [edge('i', 'c'), edge('c', 'out')] })),
      (e) => e.code === 'JF0015');
    assert.throws(() => compileDag(defineDag({ nodes: { i: input(), t: task('nope'), out: output() }, edges: [edge('i', 't'), edge('t', 'out')] })),
      (e) => e.code === 'JF0018');
  });

  it('refuses its own surface by code', () => {
    assert.throws(() => defineDag([]), (e) => e.code === 'JL0101');
    assert.throws(() => defineDag({ nodes: {}, edges: [] }), (e) => e.code === 'JL0101' && e.docPath === '/nodes');
    assert.throws(() => defineDag({ nodes: { a: input() }, edges: {} }), (e) => e.code === 'JL0101' && e.docPath === '/edges');
    assert.throws(() => defineDag({ nodes: { a: { kind: 'input' } }, edges: [] }),
      (e) => e.code === 'JL0101' && e.docPath === '/nodes/a' && /input\(\)/.test(e.message));
    assert.throws(() => defineDag({ nodes: { a: input() }, edges: [{ from: 'a', to: 'a' }] }),
      (e) => e.code === 'JL0101' && e.docPath === '/edges/0' && /edge\(from/.test(e.message));
    assert.throws(() => defineDag({ nodes: { a: input() }, edges: [], tasks: {} }),
      (e) => e.code === 'JL0101' && /'tasks'/.test(e.message));
    assert.throws(() => constant(undefined), (e) => e.code === 'JL0101' && e.docPath === '/value');
    assert.throws(() => constant(new Date(0)), (e) => e.code === 'JL0101' && /Date instance/.test(e.message));
    assert.throws(() => query(undefined), (e) => e.code === 'JL0101' && e.docPath === '/query');
    assert.throws(() => jslt(undefined), (e) => e.code === 'JL0101' && e.docPath === '/stylesheet');
    assert.throws(() => task(''), (e) => e.code === 'JL0101' && e.docPath === '/run');
    assert.throws(() => edge('a', ''), (e) => e.code === 'JL0101' && e.docPath === '/to');
    assert.throws(() => edge('a', 'b', { port: '' }), (e) => e.code === 'JL0101' && e.docPath === '/port');
    assert.throws(() => edge('a', 'b', { ports: 'x' }), (e) => e.code === 'JL0101' && /'ports'/.test(e.message));
    assert.throws(() => query((v, x) => x.root), (e) => e.code === 'JL0104' && /input scope/.test(e.message));
  });

  it('a checkpoint declaration is a new node; the one it came from is unchanged', () => {
    const plain = task('llm');
    const durable = plain.checkpoint();
    assert.notStrictEqual(plain, durable);
    const doc = /** @type {any} */ (defineDag({
      nodes: { i: input(), a: plain, b: durable, out: output() },
      edges: [edge('i', 'a'), edge('i', 'b'), edge('a', 'out', { port: 'a' }), edge('b', 'out', { port: 'b' })],
    }));
    assert.deepStrictEqual(doc.nodes.a, { kind: 'task', run: 'llm' });
    assert.deepStrictEqual(doc.nodes.b, { kind: 'task', run: 'llm', checkpoint: true });
  });
});

describe('the pen imports no engine', () => {
  it('carries no @jarenjs/flow byte, no chain module and no schema module but the brand', () => {
    for (const file of fs.readdirSync(FLOW_SRC)) {
      const source = fs.readFileSync(new URL(file, FLOW_SRC), 'utf8');
      assert.strictEqual(/from '@jarenjs\/(flow|json|validate|emit|db)/.test(source), false,
        `${file} imports an engine`);
      assert.strictEqual(/from '\.\.\/(sequence|document|async|provider|sources|schema-of)\.js'/.test(source), false,
        `${file} imports the chain`);
      assert.strictEqual(/from '\.\.\/schema\/(?!brand\.js)/.test(source), false,
        `${file} imports a schema module other than brand.js`);
    }
  });
});
