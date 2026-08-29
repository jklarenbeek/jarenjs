//@ts-check
/**
 * @file The docs gate for the pen documents: every ```js fence of a
 * document's §3 is executed — written as a module beside the
 * workspace's `node_modules` so `@jarenjs/linq/schema` (or `/model`,
 * `/jslt`, `/flow`, `/app`, `/forms`, `/db`) resolves as it does for a
 * consumer — and the ```json fence that follows it must be the document
 * the fence's one export emits (a builder's `schema`, or a pen
 * builder's — a migration's, a client graph's — `toJSON()`). The prose
 * is what the pen writes, never a copy of it.
 *
 * The binder (LINQ-FORMAT.md) carries no examples; its two suites below
 * hold the shared refusal table and the map rule every pen keeps.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { schemaOf } from '@jarenjs/linq/schema';

/**
 * One TOP-LEVEL section of a pen document — its `## N. Title` heading to
 * the next `## `, exclusive. `sectionOf` stops at the next heading of any
 * depth, which is right for the `### n.m` subsections of a format spec
 * and wrong here: a D3 section may group its rows under `###`
 * subheadings, and a slice that stopped at the first of them would hand
 * every gate below the section's preamble and call it the section.
 * @param {string} text @param {string} heading
 */
function bodyOf(text, heading) {
  const start = text.indexOf(heading);
  if (start < 0) return '';
  const from = text.indexOf('\n', start) + 1;
  const next = text.slice(from).search(/^## /m);
  return text.slice(start, next < 0 ? text.length : from + next);
}

const DOCS_DIR = new URL('../../packages/linq/docs/', import.meta.url);
const BINDER = new URL('LINQ-FORMAT.md', DOCS_DIR);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const CACHE = path.join(ROOT, 'node_modules', '.cache-pen-docs');

/** A fence's emission: a builder's document (`schemaOf`), or a pen
 * builder's `toJSON()` — a migration is a builder whose document is
 * read that way. @param {any} value */
function documentOf(value) {
  const emitted = schemaOf(value);
  return emitted !== null && typeof emitted === 'object' && typeof emitted.toJSON === 'function'
    ? emitted.toJSON() : emitted;
}

/** The (js, json) fence pairs of one section, in order. The slice comes
 * back empty when the heading is absent, and an empty slice would pair
 * nothing and assert nothing — so the section is checked, by name,
 * before it is read. */
function fencePairs(markdown, heading, doc) {
  const section = bodyOf(markdown, heading);
  assert.notStrictEqual(section, '', `${doc} carries '${heading}'`);
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

/** Every pen document, with the floor its `## 3. Worked examples` meets.
 * `db` is the client, not a pen — it emits no document of its own, so
 * its fences are the specifications it hands the store. */
const DOCS = [
  ['schema', 'the schema pen', 'SCHEMA-PEN.md', 10],
  ['model', 'the model pen', 'MODEL-PEN.md', 6],
  ['jslt', 'the JSLT pen', 'JSLT-PEN.md', 3],
  ['migration', 'the migration pen', 'MIGRATION-PEN.md', 5],
  ['client', 'the client', 'DB-CLIENT.md', 1],
  ['contract', 'the contract pen', 'CONTRACT-PEN.md', 2],
  ['flow', 'the flow pen', 'FLOW-PEN.md', 2],
  ['app', 'the app pen', 'APP-PEN.md', 2],
  ['forms', 'the forms pen', 'FORMS-PEN.md', 2],
];

/** `DB-CLIENT.md`'s §2 answers a different question — the client writes
 * no document, so its table divides the store's surface from its own. */
const MAPPING_HEADING = { db: '## 2. What is the store\'s and what is the client\'s' };

/**
 * The pens whose §2 does not yet name their whole surface, and their
 * measured gap. Every pen stays in the table: a gate that covers eight
 * of nine because the ninth was left out is a gate nobody notices has
 * stopped asking.
 * @type {Record<string, string>}
 */
const MAPPING_TODO = {
  contract: '1 of 11 unnamed: error',
  app: '6 of 13 unnamed: add, copy, move, remove, replace, test',
  forms: '29 of 31 unnamed, the schema-pen vocabulary the forms pen re-exports among them',
};

/** The same, for §5's named exclusions: the eight builder classes, the
 * one constant and the one guard each of these three subpaths exports. */
const TYPES_TODO = {
  forms: 'its 8 builder classes, SCHEMA_BUILDER and isSchemaBuilder',
};

for (const [pen, what, file, atLeast] of DOCS) {
  describe(`${file} — ${what}'s worked examples are what it emits`, () => {
    const markdown = fs.readFileSync(new URL(file, DOCS_DIR), 'utf8');
    const pairs = fencePairs(markdown, '## 3. Worked examples', file);
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

describe('LINQ-FORMAT §1.3 — the code table is the code', () => {
  it('lists exactly the JL01xx codes LINQ_CODES carries, each with a condition', async () => {
    const { LINQ_CODES } = await import('@jarenjs/linq');
    const markdown = fs.readFileSync(BINDER, 'utf8');
    const documented = [...markdown.matchAll(/^\| `(JL01\d\d)` \|/gm)].map((m) => m[1]);
    const carried = Object.keys(LINQ_CODES).filter((code) => /^JL01/.test(code));
    assert.deepStrictEqual(documented, carried);
  });
});

describe('LINQ-FORMAT §1.1 — a pen reads a name → value map by its OWN keys', () => {
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

// ——— the two completeness gates ———
//
// A mapping table that names most of a pen and a refusal section that
// names most of its codes are the two ways one of these documents goes
// quietly wrong: the reader looks up the method they were about to write,
// does not find it, and concludes the pen cannot do it. Both gates
// enumerate the truth from the pen itself and hold the document to it.

/**
 * The VOCABULARY of a subpath, as a caller writes it: the exported
 * functions plus the methods reachable on any builder it hands back.
 * Enumerated from the module, never from a list in the test — a list in
 * the test is a third place to forget a new method. The three excluded
 * kinds come back too, so a caller asserts them rather than trusting a
 * filter it cannot see.
 * @param {string} subpath
 */
const vocabularyOf = async (subpath) => {
  const mod = await import(`@jarenjs/linq/${subpath}`);
  const names = Object.keys(mod);
  const classes = names.filter((n) => /^[A-Z]/.test(n) && !/^[A-Z0-9_]+$/.test(n));
  const constants = names.filter((n) => /^[A-Z0-9_]+$/.test(n));
  const guards = names.filter((n) => /^is[A-Z]/.test(n));
  const fns = names.filter((n) => !classes.includes(n)
    && !constants.includes(n) && !guards.includes(n));
  const methods = new Set();
  for (const n of names) {
    const v = mod[n];
    if (typeof v === 'function' && v.prototype && v.prototype !== Function.prototype)
      for (const m of Object.getOwnPropertyNames(v.prototype)) if (m !== 'constructor') methods.add(m);
  }
  return { vocabulary: [...new Set([...fns, ...methods])].sort(), classes, constants, guards };
};

/** A name is named when the section spells it as a call, as a method
 * call, or in backticks on its own — a row may cover several
 * (`integer(), number().int()`), so the whole section text is searched
 * rather than each row parsed. */
const names = (section, name) =>
  section.includes(`\`${name}(`) || section.includes(`\`.${name}(`)
  || section.includes(`\`${name}\``) || section.includes(`\`.${name}\``);

describe('the mapping table names the whole surface', () => {
  // One direction only: a row may document a member or an option rather
  // than a callable (`stylesheet(rules, { modes })`, an edge's `select`),
  // so rows legitimately outnumber names in several documents. What
  // cannot happen is a name the caller can write and the table never
  // mentions.
  for (const [pen, , file] of DOCS) {
    const subpath = pen === 'client' ? 'db' : pen;
    const todo = MAPPING_TODO[subpath];
    const check = async () => {
      const markdown = fs.readFileSync(new URL(file, DOCS_DIR), 'utf8');
      const section = bodyOf(markdown, MAPPING_HEADING[subpath] ?? '## 2. The mapping table');
      assert.notStrictEqual(section, '', `${file} carries its §2`);
      const { vocabulary } = await vocabularyOf(subpath);
      const missing = vocabulary.filter((name) => !names(section, name));
      assert.deepStrictEqual(missing, [],
        `${file} §2 does not name ${missing.length} of ${vocabulary.length}: ${missing.join(', ')}`);
    };
    if (todo) it.todo(`${file} §2 names every one of ${subpath}'s callable names — ${todo}`, check);
    else it(`${file} §2 names every one of ${subpath}'s callable names`, check);
  }

  // The three kinds the gate above excludes, asserted BY NAME against
  // §5: a filter nobody can see is how a future export called
  // `isolate()` would vanish through the `is*` rule, and how a ninth
  // builder class would arrive undocumented.
  for (const [pen, , file] of DOCS) {
    const subpath = pen === 'client' ? 'db' : pen;
    const todo = TYPES_TODO[subpath];
    const check = async () => {
      const markdown = fs.readFileSync(new URL(file, DOCS_DIR), 'utf8');
      const section = bodyOf(markdown, '## 5. The types');
      assert.notStrictEqual(section, '', `${file} carries its §5`);
      const { classes, constants, guards } = await vocabularyOf(subpath);
      const excluded = [...classes, ...constants, ...guards];
      const missing = excluded.filter((name) => !section.includes(name));
      assert.deepStrictEqual(missing, [],
        `${file} §5 does not name ${missing.length} of the ${excluded.length} excluded from §2: `
        + `${missing.join(', ')}`);
    };
    if (todo) it.todo(`${file} §5 names ${subpath}'s builder classes, constants and guards — ${todo}`, check);
    else it(`${file} §5 names ${subpath}'s builder classes, constants and guards`, check);
  }
});

describe('the refusal section is the pen\'s own codes', () => {
  // Equal in BOTH directions. A code the document lists and the pen
  // cannot raise is a lie the reader acts on; a code the pen raises and
  // the document omits is the case the reader hits and cannot look up.
  //
  // The source is read with `fs`, never imported: a code thrown from a
  // branch no test takes must still count, and importing runs nothing.
  // Nothing is excluded — a `JL01xx` in a comment is either describing a
  // real refusal (which the document owes the reader) or is wrong.
  const SRC = new URL('../../packages/linq/src/', import.meta.url);
  for (const [pen, , file] of DOCS) {
    const subpath = pen === 'client' ? 'db' : pen;
    it(`${file} §4 lists exactly the codes packages/linq/src/${subpath}/ raises`, () => {
      const dir = new URL(`${subpath}/`, SRC);
      const raised = new Set();
      for (const name of fs.readdirSync(dir)) {
        const source = fs.readFileSync(new URL(name, dir), 'utf8');
        for (const m of source.matchAll(/JL01\d\d/g)) raised.add(m[0]);
      }
      const markdown = fs.readFileSync(new URL(file, DOCS_DIR), 'utf8');
      const section = bodyOf(markdown, '## 4. Refusals');
      assert.notStrictEqual(section, '', `${file} carries '## 4. Refusals'`);
      const documented = [...section.matchAll(/^\| `(JL01\d\d)` \|/gm)].map((m) => m[1]);
      assert.deepStrictEqual(documented, [...raised].sort(),
        `${file} §4 and packages/linq/src/${subpath}/ disagree`);
    });
  }
});
