//@ts-check
/**
 * @file The app pen, held to the two formats it writes between:
 * APP-FORMAT §2's document and the `contract/catalog.load/start` action
 * CONTRACT-FORMAT §11.1 generates are rebuilt through the pen and
 * asserted BYTE-EQUAL to the documents in those docs — read from their
 * fences at test time, never copied. Every app the pen emits validates
 * against `jaren-app.schema.json`, boots under `createApp` with the
 * headless stub host and dispatches; the app README's own counter is
 * rebuilt by code and proven to be the SAME application, frame for
 * frame. Beside those: the patch-path lowering (a literal index, a
 * computed one), the `$event` field §3.1 excludes, the undeclared
 * action a view must not bind, the subscription scope, the refusals by
 * code, two-run determinism and the no-engine rule.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  action, add, append, bind, copy, defineApp, effect, move, remove, replace, sub, test as testOp,
  transition,
} from '@jarenjs/linq/app';
import { rule, stylesheet } from '@jarenjs/linq/jslt';
import * as s from '@jarenjs/linq/schema';
import { LinqBuildError } from '@jarenjs/linq';
import { createApp } from '@jarenjs/app';
import { JarenValidator } from '@jarenjs/validate';
import { jsonFormats } from '@jarenjs/formats';

import { createStubHost, fire, serialize } from '../view/dom.stub.js';

const APP_DOC = new URL('../../packages/app/docs/APP-FORMAT.md', import.meta.url);
const APP_README = new URL('../../packages/app/README.md', import.meta.url);
const CONTRACT_DOC = new URL('../../packages/contract/docs/CONTRACT-FORMAT.md', import.meta.url);
const APP_SRC = new URL('../../packages/linq/src/app/', import.meta.url);
const load = (at) => JSON.parse(fs.readFileSync(new URL(at, import.meta.url), 'utf8'));
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const CACHE = path.join(ROOT, 'node_modules', '.cache-app-pen');
let counterRun = 0;

const validateApp = new JarenValidator().addFormats(jsonFormats)
  .addSchema(load('../../packages/json/schemas/jaren-query.schema.json'))
  .addSchema(load('../../packages/json/schemas/jaren-jslt.schema.json'))
  .compile(load('../../packages/app/schemas/jaren-app.schema.json'));

/** The bytes a document is: JSON text, member order included. @param {any} doc */
const bytes = (doc) => JSON.stringify(doc);

/** Synchronous render scheduler, for deterministic assertions. */
const sync = (flush) => flush();

/**
 * The first fenced block of a `##`/`###` section, by language.
 * @param {URL} file
 * @param {string} heading - the heading text, `## 2. The app document` say
 * @param {string} lang
 * @returns {string}
 */
function fence(file, heading, lang) {
  const markdown = fs.readFileSync(file, 'utf8');
  const start = markdown.indexOf(`\n${heading}`);
  assert.notStrictEqual(start, -1, `the document carries '${heading}'`);
  const depth = /^#+/.exec(heading.trim())?.[0].length ?? 2;
  const next = markdown.indexOf(`\n${'#'.repeat(depth)} `, start + 1);
  const section = markdown.slice(start, next === -1 ? undefined : next);
  const found = new RegExp('```' + lang + '\\n([\\s\\S]*?)```').exec(section);
  assert.ok(found, `'${heading}' carries a ${lang} fence`);
  return found[1];
}

/**
 * The first top-level JSON value of a JSONC fence: line comments
 * stripped outside strings, then one balanced object.
 * @param {string} text
 * @returns {any}
 */
function firstDocument(text) {
  let stripped = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      stripped += ch;
      if (ch === '\\') { stripped += text[++i]; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; stripped += ch; continue; }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      stripped += '\n';
      continue;
    }
    stripped += ch;
  }
  const start = stripped.indexOf('{');
  let depth = 0;
  for (let i = start; i < stripped.length; i++) {
    if (stripped[i] === '"') {
      i++;
      while (stripped[i] !== '"') { if (stripped[i] === '\\') i++; i++; }
      continue;
    }
    if (stripped[i] === '{') depth++;
    else if (stripped[i] === '}' && --depth === 0) return JSON.parse(stripped.slice(start, i + 1));
  }
  throw new assert.AssertionError({ message: 'the fence carries no document' });
}

describe('APP-FORMAT §2, rebuilt through the pen', () => {
  /** §2's document, by code. */
  const build = () => defineApp({ state: {}, view: [], actions: {}, subs: [] }).document;

  it('is byte-equal to the doc, valid under the grammar, and two builds are one document', () => {
    const doc = build();
    assert.strictEqual(bytes(doc), bytes(JSON.parse(fence(APP_DOC, '## 2. The app document', 'json'))),
      '§2 byte-equal');
    assert.strictEqual(bytes(build()), bytes(doc), 'two runs, one document');
    assert.deepStrictEqual(JSON.parse(bytes(doc)), doc, 'plain JSON');
    assert.strictEqual(Object.isFrozen(doc), true);
    assert.strictEqual(validateApp(doc), true, 'valid under jaren-app 0.1');
  });

  it('writes only the members the author declared', () => {
    const bare = defineApp({ state: 0, view: [] }).document;
    assert.strictEqual(bytes(bare), '{"$app":"0.1","state":0,"view":[]}');
    assert.strictEqual(defineApp({ view: [] }).document.state, undefined,
      'an absent state stays absent — §2 lets the state start undefined');
  });
});

describe('CONTRACT-FORMAT §11.1\'s start action, rebuilt through the pen', () => {
  /** The `contract/catalog.load/start` action of §11.1, by code. */
  const build = () => action((st, x) => transition({
    patch: [
      replace('/contract/catalog.load/id', st.contract.get('catalog.load').id.add(1)),
      replace('/contract/catalog.load/status', 'loading'),
      replace('/contract/catalog.load/kind', null),
      replace('/contract/catalog.load/error', null),
    ],
    effects: [effect('contract', {
      op: 'catalog.load',
      input: x.payload,
      id: st.contract.get('catalog.load').id.add(1),
      done: 'contract/catalog.load/done',
      slot: 'catalog.load',
    })],
  }));

  it('is byte-equal to the generated document the contract format publishes', () => {
    const generated = firstDocument(fence(CONTRACT_DOC, '### §11.1 The generated document', 'jsonc'));
    assert.strictEqual(bytes(build().document), bytes(generated), '§11.1 start byte-equal');
    assert.strictEqual(bytes(build().document), bytes(build().document), 'two runs, one document');
  });

  it('writes the same increment in the patch and in the effect, as §11.1 requires', () => {
    const doc = /** @type {any} */ (build().document);
    assert.deepStrictEqual(doc.patch[0].value, doc.effects[0].with.id,
      'everything in an action evaluates against the PRE-transition state');
  });

  it('spells the same paths through a lambda over the state', () => {
    const byLambda = action((st) => transition({
      patch: [replace((c) => c.contract.get('catalog.load').id,
        st.contract.get('catalog.load').id.add(1))],
    }));
    assert.strictEqual(/** @type {any} */ (byLambda.document).patch[0].path,
      '/contract/catalog.load/id');
  });
});

/** The todo app every runtime assertion below uses. */
function todoApp() {
  return defineApp({
    state: s.object({
      todos: s.array(s.object({ text: s.string(), done: s.boolean().default(false) })).default([]),
      draft: s.string().default(''),
    }),
    view: [rule('$', (v) => ['main', {},
      ['h1', {}, 'Todos: ', v.todos.all().count()],
      ['button', { on: { click: bind('todo/add', { payload: { text: 'from the view' } }) } }, 'add'],
      ['button', { on: { click: 'todo/clear' } }, 'clear'],
    ])],
    actions: {
      'todo/add': action((st, x) => transition({
        patch: [append((c) => c.todos, { text: x.payload.text, done: false })],
      }), { payload: s.object({ text: s.string() }) }),
      'todo/toggleAt': action(() => transition({
        patch: [replace((c, y) => c.todos.at(y.payload.i).done, true)],
      })),
      'todo/clear': action(() => transition({
        patch: [replace((c) => c.todos, [])],
        effects: [effect('save', { where: 'disk' })],
      })),
    },
    subs: [sub('interval', {
      with: { ms: 1000, tick: 'todo/clear' },
      when: (st) => st.todos.all().count().gt(0),
    })],
  });
}

describe('an app the pen writes validates, boots and dispatches', () => {
  it('validates under jaren-app 0.1 and its state under its own stateSchema', () => {
    const { document, stateSchema } = todoApp();
    assert.strictEqual(validateApp(document), true);
    const validateState = new JarenValidator().addFormats(jsonFormats).compile(stateSchema);
    assert.deepStrictEqual(document.state, { todos: [], draft: '' },
      'the initial state is what the defaults describe');
    assert.strictEqual(validateState(document.state), true);
  });

  it('boots headless, dispatches, patches, runs effects and starts subscriptions', () => {
    const { document, stateSchema } = todoApp();
    const validateState = new JarenValidator().addFormats(jsonFormats).compile(stateSchema);
    const { document: host, container } = createStubHost();
    /** @type {any[]} */ const saved = [];
    /** @type {any[]} */ const ticked = [];
    const app = createApp(document, {
      node: container,
      document: host,
      schedule: sync,
      effects: { save: (props) => saved.push(props) },
      subs: { interval: (props) => { ticked.push(props); return () => ticked.push('stop'); } },
      validateState: (state) => validateState(state),
    });

    app.dispatch('todo/add', { text: 'write the pen' });
    assert.deepStrictEqual(app.getState().todos, [{ text: 'write the pen', done: false }]);
    assert.deepStrictEqual(ticked, [{ ms: 1000, tick: 'todo/clear' }],
      'the when query went live with the first todo');

    app.dispatch('todo/toggleAt', { i: 0 });
    assert.deepStrictEqual(app.getState().todos, [{ text: 'write the pen', done: true }]);

    fire(container.childNodes[0].childNodes[1], 'click', {});
    assert.deepStrictEqual(app.getState().todos.at(-1), { text: 'from the view', done: false },
      'a binding the view rendered dispatches its payload');

    fire(container.childNodes[0].childNodes[2], 'click', {});
    assert.deepStrictEqual(app.getState().todos, []);
    assert.deepStrictEqual(saved, [{ where: 'disk' }]);
    assert.deepStrictEqual(ticked.at(-1), 'stop', 'the subscription died with the last todo');
    assert.match(serialize(container), /Todos: 0/);
    app.destroy();
  });

  it('is the same application the app README writes by hand', async () => {
    const source = fence(APP_README, '## A complete app', 'javascript');
    const open = source.indexOf('{', source.indexOf('createApp('));
    let depth = 0;
    let handWritten;
    for (let i = open; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) {
        handWritten = JSON.parse(source.slice(open, i + 1));
        break;
      }
    }
    // the twin is the README's OWN fence, executed — never a copy
    const twin = fence(APP_README, '### The same app, by code', 'javascript')
      .replace(/^import .*$/gm, '')
      .replace(/^createApp\(.*$/gm, '')
      + '\nexport const emitted = counter.document;\n';
    const file = path.join(CACHE, 'app-readme-twin.mjs');
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(file,
      "import { action, bind, defineApp, replace, transition } from '@jarenjs/linq/app';\n"
      + "import { rule } from '@jarenjs/linq/jslt';\n"
      + "import * as s from '@jarenjs/linq/schema';\n" + twin);
    const byCode = (await import(`${file}?${counterRun++}`)).emitted;

    assert.deepStrictEqual(byCode.state, handWritten.state);
    assert.deepStrictEqual(Object.keys(byCode.actions), Object.keys(handWritten.actions));
    assert.strictEqual(validateApp(byCode), true);

    // the same application, frame for frame: `count` names a method on
    // the chain's expression surface, so the pen reads it through get()
    // and writes $['count'] where the hand-written document writes
    // $.count — the same RFC 9535 path, and the only difference
    const run = (doc) => {
      const { document: host, container } = createStubHost();
      const app = createApp(doc, { node: container, document: host, schedule: sync });
      const frames = [serialize(container)];
      app.dispatch('inc');
      frames.push(serialize(container));
      fire(container.childNodes[0].childNodes[2], 'click', {});
      frames.push(serialize(container));
      const state = app.getState();
      app.destroy();
      return { frames, state };
    };
    assert.deepStrictEqual(run(byCode), run(handWritten));
  });
});

describe('the app pen — patch paths', () => {
  /** @param {(st: any, x: any) => any} fn */
  const pathOf = (fn) => /** @type {any} */ (
    action(() => transition({ patch: [replace(fn, 1)] })).document).patch[0].path;

  it('derives a pointer from the state shape', () => {
    assert.strictEqual(pathOf((st) => st.todos), '/todos');
    assert.strictEqual(pathOf((st) => st), '');
    assert.strictEqual(pathOf((st) => st.a.b.c), '/a/b/c');
    assert.strictEqual(pathOf((st) => st.get('a/b')), '/a~1b');
    assert.strictEqual(pathOf((st) => st.get('a~b')), '/a~0b');
    assert.strictEqual(pathOf((st) => st.get('catalog.load').id), '/catalog.load/id');
  });

  it('writes a LITERAL index as pointer text', () => {
    assert.strictEqual(pathOf((st) => st.todos.at(2)), '/todos/2');
    assert.strictEqual(pathOf((st) => st.todos.at(2).done), '/todos/2/done');
  });

  it('writes a COMPUTED index as the $concat pointer expression of APP-PEN', () => {
    assert.deepStrictEqual(pathOf((st, x) => st.todos.at(x.payload.i)),
      { $concat: ['/todos/', '$payload.i'] });
    assert.deepStrictEqual(pathOf((st, x) => st.todos.at(x.payload.i).done),
      { $concat: ['/todos/', '$payload.i', '/done'] });
    assert.deepStrictEqual(pathOf((st) => st.todos.at(st.cursor)),
      { $concat: ['/todos/', '$.cursor'] });
  });

  it('takes a pointer string verbatim, and refuses one that is not a pointer', () => {
    assert.strictEqual(pathOf('/a/b'), '/a/b');
    assert.throws(() => replace('a/b', 1), (e) => e.code === 'JL0102' && /RFC 6901/.test(e.message));
  });

  it('refuses a path expression it cannot lower', () => {
    assert.throws(() => replace((st) => st.todos.all().count(), 1),
      (e) => e.code === 'JL0102' && /cannot be written as one/.test(e.message));
    assert.throws(() => replace(7, 1), (e) => e.code === 'JL0101');
  });

  it('appends to an array through its own name, because add() at the array replaces it', () => {
    const appended = /** @type {any} */ (
      action((st, x) => transition({ patch: [append((c) => c.todos, x.payload)] })).document);
    assert.deepStrictEqual(appended.patch[0], { op: 'add', path: '/todos/-', value: '$payload' });
    const replaced = /** @type {any} */ (
      action((st, x) => transition({ patch: [add((c) => c.todos, x.payload)] })).document);
    assert.strictEqual(replaced.patch[0].path, '/todos');
  });

  it('writes every RFC 6902 operation in its own member order', () => {
    const doc = /** @type {any} */ (action(() => transition({
      patch: [
        add('/a', 1), replace('/a', 2), remove('/a'),
        move('/a', '/b'), copy('/b', '/c'), testOp('/c', 3),
      ],
    })).document);
    assert.deepStrictEqual(doc.patch, [
      { op: 'add', path: '/a', value: 1 },
      { op: 'replace', path: '/a', value: 2 },
      { op: 'remove', path: '/a' },
      { op: 'move', from: '/a', path: '/b' },
      { op: 'copy', from: '/b', path: '/c' },
      { op: 'test', path: '/c', value: 3 },
    ]);
  });

  it('runs a computed pointer at dispatch time', () => {
    const { document } = defineApp({
      state: { rows: [{ n: 0 }, { n: 0 }] },
      view: [rule('$', () => ['p', {}, 'x'])],
      actions: {
        bump: action(() => transition({
          patch: [replace((c, y) => c.rows.at(y.payload.i).n, 9)],
        })),
      },
    });
    const { document: host, container } = createStubHost();
    const app = createApp(document, { node: container, document: host, schedule: sync });
    app.dispatch('bump', { i: 1 });
    assert.deepStrictEqual(app.getState().rows, [{ n: 0 }, { n: 9 }]);
    app.destroy();
  });
});

describe('the app pen — bindings and the $event allow-list', () => {
  it('writes §4\'s binding object in the format\'s member order', () => {
    assert.deepStrictEqual(bind('selectRow', {
      payload: { id: 1 }, event: ['shiftKey', 'ctrlKey', 'metaKey'],
      preventDefault: true, stopPropagation: true,
    }), {
      action: 'selectRow',
      with: { id: 1 },
      event: ['shiftKey', 'ctrlKey', 'metaKey'],
      preventDefault: true,
      stopPropagation: true,
    });
    assert.deepStrictEqual(bind('inc'), { action: 'inc' });
  });

  it('reproduces §4\'s own worked binding', () => {
    const declared = JSON.parse(fence(APP_DOC, '## 4. Event bindings', 'json'));
    const view = [rule('$', (v) => ['tr', { on: { click: bind('selectRow', {
      payload: { id: v.id }, event: ['shiftKey', 'ctrlKey', 'metaKey'],
    }) } }, '…'])];
    assert.strictEqual(bytes(view[0].body), bytes(declared), '§4 byte-equal');
  });

  it('JL0102 — an event field §3.1 excludes by construction', () => {
    for (const name of ['target', 'files', 'touches', 'dataTransfer']) {
      assert.throws(() => bind('todo/add', { event: [name] }),
        (e) => e.code === 'JL0102' && /JSON.stringify/.test(e.message)
          && /fileTokens/.test(e.message), name);
    }
    assert.throws(() => action(() => transition({}), { event: ['target'] }),
      (e) => e.code === 'JL0102');
  });

  it('allows a host extractor\'s own name, which §3.1 lets win', () => {
    assert.deepStrictEqual(bind('pickFiles', { event: ['fileTokens'] }).event, ['fileTokens']);
    assert.deepStrictEqual(bind('capture', { event: ['type'] }).event, ['type'],
      'a default member may be requested — §4 says it never overwrites what is bound');
  });

  it('JL0102 — a view binding the actions do not declare', () => {
    assert.throws(() => defineApp({
      state: {},
      view: [rule('$', () => ['button', { on: { click: bind('nope') } }, 'x'])],
      actions: { real: action(() => transition({})) },
    }), (e) => e.code === 'JL0102' && /'nope'/.test(e.message) && /JA2001/.test(e.message));

    assert.throws(() => defineApp({
      state: {},
      view: [rule('$', () => ['button', { on: { click: 'nope' } }, 'x'])],
      actions: { real: action(() => transition({})) },
    }), (e) => e.code === 'JL0102' && /'nope'/.test(e.message));
  });

  it('leaves a render-time action name alone — no pen can resolve it', () => {
    const doc = defineApp({
      state: { mode: 'inc' },
      view: [rule('$', (v) => ['button', { on: { click: { action: v.mode } } }, 'x'])],
      actions: { inc: action(() => transition({})) },
    }).document;
    assert.strictEqual(validateApp(doc), true);
  });
});

describe('the app pen — subscriptions', () => {
  it('writes §5.3\'s members in the format\'s order', () => {
    assert.deepStrictEqual(sub('room', {
      for: (st) => st.rooms.all(),
      withQuery: (st, x) => ({ id: x.item.id }),
      key: (st, x) => x.item.id,
      when: (st) => st.online,
    }), {
      run: 'room',
      when: '$.online',
      withQuery: { id: '$item.id' },
      key: '$item.id',
      for: '$.rooms[*]',
    });
  });

  it('keeps a static with verbatim, and refuses a callback there', () => {
    assert.deepStrictEqual(sub('interval', { with: { ms: 1000 } }).with, { ms: 1000 });
    assert.throws(() => sub('interval', { with: (st) => st.ms }),
      (e) => e.code === 'JL0101' && /VERBATIM/.test(e.message));
  });

  it('JL0104 — $item outside a fan-out', () => {
    assert.throws(() => sub('room', { withQuery: (st, x) => x.item }),
      (e) => e.code === 'JL0104' && /closed-world/.test(e.message));
    assert.throws(() => sub('room', { when: (st, x) => x.item }),
      (e) => e.code === 'JL0104');
  });

  it('JL0102 — the combinations §5.3 calls JA0008', () => {
    assert.throws(() => sub('r', { with: 1, withQuery: (st) => st.a }),
      (e) => e.code === 'JL0102' && /one entry, one props source/.test(e.message));
    assert.throws(() => sub('r', { with: 1, for: (st) => st.a }), (e) => e.code === 'JL0102');
    assert.throws(() => sub('r', { key: (st) => st.a }),
      (e) => e.code === 'JL0102' && /no restart key/.test(e.message));
  });

  it('fans out under createApp, one instance per item', () => {
    const { document } = defineApp({
      state: { rooms: [{ id: 'a' }, { id: 'b' }] },
      view: [rule('$', () => ['p', {}, 'x'])],
      subs: [sub('room', {
        for: (st) => st.rooms.all(),
        withQuery: (st, x) => ({ id: x.item.id }),
      })],
    });
    const { document: host, container } = createStubHost();
    /** @type {any[]} */ const started = [];
    const app = createApp(document, {
      node: container,
      document: host,
      schedule: sync,
      subs: { room: (props) => { started.push(props); return () => {}; } },
    });
    assert.deepStrictEqual(started, [{ id: 'a' }, { id: 'b' }]);
    app.destroy();
  });
});

describe('the app pen — the state and its schema', () => {
  it('derives the initial state from the defaults, recursing into objects', () => {
    const { document, stateSchema } = defineApp({
      state: s.object({
        ui: s.object({ open: s.boolean().default(false), tab: s.string().default('all') }),
        count: s.integer().default(0),
        note: s.string().optional(),
        scratch: s.object({ a: s.string().optional() }).optional(),
      }),
      view: [],
    });
    assert.deepStrictEqual(document.state,
      { ui: { open: false, tab: 'all' }, count: 0 });
    assert.strictEqual(stateSchema.type, 'object');
    assert.strictEqual(
      new JarenValidator().compile(stateSchema)(document.state), true);
  });

  it('JL0102 — a required member with no default and no initial', () => {
    assert.throws(() => defineApp({ state: s.object({ id: s.string() }), view: [] }),
      (e) => e.code === 'JL0102' && /'\/id' is required/.test(e.message)
        && e.docPath === '/id');
    assert.deepStrictEqual(
      defineApp({ state: s.object({ id: s.string() }), initial: { id: 'x' }, view: [] })
        .document.state, { id: 'x' });
  });

  it('takes a plain state with a schema beside it', () => {
    const { document, stateSchema } = defineApp({
      state: { n: 1 },
      schema: s.object({ n: s.integer() }),
      view: [],
    });
    assert.deepStrictEqual(document.state, { n: 1 });
    assert.strictEqual(new JarenValidator().compile(stateSchema)({ n: 1 }), true);
    assert.strictEqual(defineApp({ state: { n: 1 }, view: [] }).stateSchema, null,
      'no schema declared, none invented');
  });

  it('never merges the schema into the document', () => {
    const { document } = defineApp({ state: s.object({ n: s.integer().default(0) }), view: [] });
    assert.deepStrictEqual(Object.keys(document), ['$app', 'state', 'view']);
  });

  it('JL0101 — a schema beside a state that is already a builder', () => {
    assert.throws(() => defineApp({
      state: s.object({ n: s.integer().default(0) }), schema: s.object({}), view: [],
    }), (e) => e.code === 'JL0101' && /a state given as a builder IS its schema/.test(e.message));
  });
});

describe('the app pen — what it refuses, by code', () => {
  it('JL0101 — its own surface', () => {
    assert.throws(() => defineApp('$'), (e) => e.code === 'JL0101');
    assert.throws(() => defineApp({ state: {}, nope: 1, view: [] }),
      (e) => e.code === 'JL0101' && /'nope'/.test(e.message));
    assert.throws(() => defineApp({ state: {} }),
      (e) => e.code === 'JL0101' && /JA0002/.test(e.message));
    assert.throws(() => defineApp({ state: {}, view: 'x' }), (e) => e.code === 'JL0101');
    assert.throws(() => defineApp({ state: {}, view: [], actions: [] }),
      (e) => e.code === 'JL0101');
    assert.throws(() => defineApp({ state: {}, view: [], actions: { a: { patch: [] } } }),
      (e) => e.code === 'JL0101' && /action\(\(s, x\)/.test(e.message));
    assert.throws(() => defineApp({ state: {}, view: [], subs: [{ run: 'x' }] }),
      (e) => e.code === 'JL0101' && /sub\(run/.test(e.message));
    assert.throws(() => action(7), (e) => e.code === 'JL0101');
    assert.throws(() => action(() => transition({}), { nope: 1 }), (e) => e.code === 'JL0101');
    assert.throws(() => action(() => transition({}), { payload: {} }),
      (e) => e.code === 'JL0101' && /schema-pen builder/.test(e.message));
    assert.throws(() => transition({ nope: 1 }), (e) => e.code === 'JL0101');
    assert.throws(() => transition({ patch: 'x' }), (e) => e.code === 'JL0101');
    assert.throws(() => transition({ effects: [{ run: 'x' }] }),
      (e) => e.code === 'JL0101' && /effect\(run/.test(e.message));
    assert.throws(() => effect(''), (e) => e.code === 'JL0101');
    assert.throws(() => bind(''), (e) => e.code === 'JL0101');
    assert.throws(() => bind('a', { nope: 1 }), (e) => e.code === 'JL0101');
    assert.throws(() => bind('a', { preventDefault: 'yes' }),
      (e) => e.code === 'JL0101' && e.docPath === '/preventDefault');
    assert.throws(() => sub(''), (e) => e.code === 'JL0101');
    assert.throws(() => sub('a', { nope: 1 }), (e) => e.code === 'JL0101');
  });

  it('JL0104 — a name §3.1 does not bind', () => {
    let caught;
    assert.throws(() => action((st, x) => transition({ state: x.clock })),
      (err) => { caught = err; return true; });
    assert.ok(caught instanceof LinqBuildError, 'a pen refusal is a LinqBuildError');
    assert.strictEqual(caught.code, 'JL0104');
    assert.match(caught.message, /\$event and \$payload/);
  });

  it('leaves to createApp what only createApp can judge', () => {
    const { document } = defineApp({
      state: {},
      view: [rule('$', () => ['p', {}, 'x'])],
      actions: { a: action(() => transition({ effects: [effect('missing')] })) },
    });
    const { document: host, container } = createStubHost();
    /** @type {any[]} */ const errors = [];
    const app = createApp(document, {
      node: container, document: host, schedule: sync, onError: (e) => errors.push(e.code),
    });
    app.dispatch('a');
    assert.deepStrictEqual(errors, ['JA2006'], 'an unregistered effect name is the loop\'s');
    app.destroy();
  });
});

describe('the app pen writes plain JSON and imports no engine', () => {
  it('emits a deep-frozen document that survives a JSON round trip', () => {
    const { document } = todoApp();
    assert.deepStrictEqual(JSON.parse(bytes(document)), document);
    assert.strictEqual(Object.isFrozen(document), true);
    assert.strictEqual(Object.isFrozen(document.actions), true);
    assert.strictEqual(bytes(todoApp().document), bytes(document), 'two runs, one document');
  });

  it('accepts the JSLT pen\'s envelope form as readily as the bare array', () => {
    const doc = defineApp({
      state: {},
      view: stylesheet([rule('$', () => ['p', {}, 'x'])], { unmatched: 'error' }),
    }).document;
    assert.strictEqual(doc.view.$jslt, '0.1');
    assert.strictEqual(validateApp(doc), true);
  });

  it('reaches @jarenjs/app from no source file', () => {
    for (const file of fs.readdirSync(APP_SRC)) {
      const source = fs.readFileSync(new URL(file, APP_SRC), 'utf8');
      assert.strictEqual(/from '@jarenjs\/(app|json|validate|view)/.test(source), false,
        `${file} imports a package the pen must not carry`);
    }
  });
});
