//@ts-check
/**
 * @file The docs gate for PENS-FORMAT.md: every ```js fence of a pen
 * section is executed — written as a module beside the workspace's
 * `node_modules` so `@jarenjs/linq/schema` (or `/model`, `/jslt`, `/flow`, `/app`, `/forms`, `/db`)
 * resolves as it does for a consumer — and the ```json fence that
 * follows it must be the document the fence's one export emits (a
 * builder's `schema`, or a pen builder's — a migration's, a client
 * graph's — `toJSON()`). The prose is what the pen writes, never
 * a copy of it.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { schemaOf } from '@jarenjs/linq/schema';

const DOC = new URL('../../packages/linq/docs/PENS-FORMAT.md', import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const CACHE = path.join(ROOT, 'node_modules', '.cache-pens-format');

/** A fence's emission: a builder's document (`schemaOf`), or a pen
 * builder's `toJSON()` — a migration is a builder whose document is
 * read that way. @param {any} value */
function documentOf(value) {
  const emitted = schemaOf(value);
  return emitted !== null && typeof emitted === 'object' && typeof emitted.toJSON === 'function'
    ? emitted.toJSON() : emitted;
}

/** The (js, json) fence pairs of one `### N.M` subsection, in order. */
function fencePairs(markdown, heading) {
  const start = markdown.indexOf(`\n### ${heading}`);
  assert.notStrictEqual(start, -1, `section '${heading}' exists`);
  const next = markdown.indexOf('\n#', start + 1);
  const section = markdown.slice(start, next === -1 ? undefined : next);
  const fences = [...section.matchAll(/```(js|json)\n([\s\S]*?)```/g)]
    .map((m) => ({ lang: m[1], body: m[2] }));
  const pairs = [];
  for (let i = 0; i < fences.length; i++) {
    if (fences[i].lang !== 'js') continue;
    assert.strictEqual(fences[i + 1]?.lang, 'json', 'every js fence is followed by its json fence');
    pairs.push({ js: fences[i].body, json: fences[i + 1].body });
  }
  return pairs;
}

for (const [pen, heading, atLeast] of [['schema', '2.2 Worked examples', 5], ['model', '3.2 Worked examples', 2], ['jslt', '4.2 Worked examples', 3], ['migration', '5.2 Worked examples', 2], ['client', '6.2 Worked examples', 1], ['contract', '7.2 Worked examples', 2], ['flow', '8.2 Worked examples', 2], ['app', '9.2 Worked examples', 2], ['forms', '10.2 Worked examples', 2]]) {
  describe(`PENS-FORMAT — the ${pen} pen's worked examples are what the pen emits`, () => {
    const markdown = fs.readFileSync(DOC, 'utf8');
    const pairs = fencePairs(markdown, heading);
    fs.mkdirSync(CACHE, { recursive: true });

    it('has worked examples to run', () => {
      assert.ok(pairs.length >= atLeast, `${pairs.length} fence pairs`);
    });

    pairs.forEach((pair, i) => {
      it(`example ${i + 1} emits its json fence`, async () => {
        const file = path.join(CACHE, `${pen}-example-${i + 1}.mjs`);
        fs.writeFileSync(file, pair.js);
        const mod = await import(`${file}?${Date.now()}`);
        const names = Object.keys(mod);
        assert.strictEqual(names.length, 1, `one export per fence, got ${names.join(', ')}`);
        assert.deepStrictEqual(documentOf(mod[names[0]]), JSON.parse(pair.json));
      });
    });
  });
}

describe('PENS-FORMAT §1.3 — the code table is the code', () => {
  it('lists exactly the JL01xx codes LINQ_CODES carries, each with a condition', async () => {
    const { LINQ_CODES } = await import('@jarenjs/linq');
    const markdown = fs.readFileSync(DOC, 'utf8');
    const documented = [...markdown.matchAll(/^\| `(JL01\d\d)` \|/gm)].map((m) => m[1]);
    const carried = Object.keys(LINQ_CODES).filter((code) => /^JL01/.test(code));
    assert.deepStrictEqual(documented, carried);
  });
});

describe('PENS-FORMAT §1.1 — a pen reads a name → value map by its OWN keys', () => {
  // Two halves of one rule, and JavaScript is what makes them two.
  //
  //   { __proto__: builder }   — the LITERAL form sets the object's
  //     prototype instead of adding a member, so the member never
  //     reaches the pen: nothing is there to emit and nothing is there
  //     to see. The one thing that IS visible is the prototype, so the
  //     pen refuses the map by it (`JL0101`).
  //   { ['__proto__']: builder } — a computed key IS an own property.
  //     The pen must emit it as a member, which means writing it with
  //     `setObjectMember`: a plain `out[name] = value` reassigns the
  //     emitted object's prototype and drops the member instead.
  const P = '__proto__';
  /** A spec map whose prototype the `__proto__:` literal replaced. */
  const literal = (value) => ({ __proto__: value });
  /** The same map with the key as an own property. */
  const computed = (value) => ({ [P]: value });

  /** @param {() => any} build */
  const refuses = (build) => {
    assert.throws(build, (error) => {
      assert.strictEqual(error.constructor.name, 'LinqBuildError');
      assert.strictEqual(error.code, 'JL0101');
      assert.match(error.message, /__proto__/, 'the message names the key that ate the member');
      return true;
    });
  };

  /** @param {any} node @param {string} what */
  const carriesOwnProto = (node, what) => {
    assert.ok(node !== undefined && node !== null, `${what} exists`);
    assert.strictEqual(Object.getPrototypeOf(node), Object.prototype,
      `${what} keeps its prototype — a plain out[name] = value would have replaced it`);
    assert.ok(Object.hasOwn(node, P), `${what} carries '__proto__' as an own member`);
  };

  it('the schema pen: object(), patternProperties() and extend()', async () => {
    const s = await import('@jarenjs/linq/schema');
    refuses(() => s.object(literal(s.string())).schema);
    refuses(() => s.object({ a: s.string() }).patternProperties(literal(s.string())).schema);
    refuses(() => s.object({ a: s.string() }).extend(literal(s.string())).schema);
    carriesOwnProto(s.object(computed(s.string())).schema.properties, 'properties');
  });

  it('the model pen: entities and collections', async () => {
    const m = await import('@jarenjs/linq/model');
    refuses(() => m.defineModel({ entities: literal(m.object({ id: m.string().key() })) }));
    carriesOwnProto(m.defineModel({ entities: computed(m.object({ id: m.string().key() })) }).entities,
      'the model\'s entities');
  });

  it('the forms pen: object()', async () => {
    const f = await import('@jarenjs/linq/forms');
    refuses(() => f.object(literal(f.string())).schema);
    carriesOwnProto(f.object(computed(f.string())).schema.properties, 'properties');
  });

  it('the JSLT pen: the stylesheet modes', async () => {
    const { rule, stylesheet } = await import('@jarenjs/linq/jslt');
    const rules = [rule('$', (v) => v)];
    refuses(() => stylesheet(rules, { modes: literal({ unmatched: 'error' }) }));
    carriesOwnProto(stylesheet(rules, { modes: computed({ unmatched: 'error' }) }).modes,
      'the stylesheet\'s modes');
  });

  it('the contract pen: the operations', async () => {
    const s = await import('@jarenjs/linq/schema');
    const { defineContract, read, http } = await import('@jarenjs/linq/contract');
    const op = () => read({ output: s.object({ n: s.integer() }), http: http({ method: 'GET', path: '/a' }) });
    refuses(() => defineContract({ id: 'shop' }, literal(op())));
    carriesOwnProto(defineContract({ id: 'shop' }, computed(op())).document.operations,
      'the contract\'s operations');
  });

  it('the flow pen: the dag nodes', async () => {
    const { defineDag, input, output, edge } = await import('@jarenjs/linq/flow');
    refuses(() => defineDag({ nodes: literal(input()), edges: [] }));
    carriesOwnProto(defineDag({ nodes: { [P]: input(), out: output() }, edges: [edge(P, 'out')] }).nodes,
      'the dag\'s nodes');
  });

  it('the app pen: the actions, and the state its defaults derive', async () => {
    const s = await import('@jarenjs/linq/schema');
    const { defineApp, action, transition } = await import('@jarenjs/linq/app');
    const { rule } = await import('@jarenjs/linq/jslt');
    const view = [rule('$', () => ['div', {}])];
    const state = s.object({ n: s.integer().default(0) });
    refuses(() => defineApp({ state, view, actions: literal(action(() => transition({}))) }));
    const app = defineApp({
      state: s.object({ [P]: s.integer().default(7), n: s.integer().default(0) }),
      view,
      actions: { [P]: action(() => transition({})), ok: action(() => transition({})) },
    });
    carriesOwnProto(app.document.actions, 'the app\'s actions');
    assert.deepStrictEqual(Object.keys(app.document.actions), [P, 'ok']);
    carriesOwnProto(app.document.state, 'the app\'s initial state');
    assert.strictEqual(app.document.state[P], 7,
      'the state a default describes is the state the document carries');
  });

  it('a `__proto__:` literal is the ONE loss a prototype cannot show: a primitive value',
    async () => {
      // `{ __proto__: 1 }` leaves the prototype alone (the setter ignores a
      // non-object) and still adds no member, so there is nothing to refuse
      // by. Every pen map takes builders and declarations, so the case
      // cannot arise there — it is stated, not hidden.
      const spec = { __proto__: 1 };
      assert.strictEqual(Object.getPrototypeOf(spec), Object.prototype);
      assert.deepStrictEqual(Object.keys(spec), []);
    });
});
