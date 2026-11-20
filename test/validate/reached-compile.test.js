//@ts-check
// A compile reads what it reaches of the schemas its validator holds: it
// resolves and builds the held schemas its references lead to, and no other.
// A held document's reference that nothing resolves is refused by the compile
// that reaches it, at compile(), naming the holder's place; every other
// compile on the validator answers.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';
import { getSchemaDraftByName } from '@jarenjs/refs';

const UNHELD = 'no schema the validator holds has that URI; register it with addSchema, load it with compileAsync, or fix the reference';
/** What `fn` returns, or the class, code, message and place of what it throws. @param {() => unknown} fn */
const outcome = (fn) => {
  try { return fn(); }
  catch (e) { const error = /** @type {any} */ (e); return [error.constructor.name, error.code, error.message, error.docPath]; }
};
/** The refusal of a reference to `target` that nothing holds. @param {string} target @param {string} [at] */
const unresolved = (target, at) => ['SchemaCompileError', 'JK0009', `JK0009: Can not resolve schema for '${target}': ${UNHELD}${at === undefined ? '' : ` at ${at}`}`, at];
/** The answers of a compiled schema. @param {any} validate @param {unknown[]} instances */
const answers = (validate, instances) => instances.map((instance) => validate(instance));

describe('a compile builds the held schemas it reaches, and no other', () => {
  it('counts one build per place a reference leads to, and per member of the document around it', () => {
    // a format's compiler runs once for each place holding it that is built. A place is built with the
    // registered document around it, as a compile of everything builds it (the place of `$defs/t` comes
    // with the root's member `a`), without what else that document reaches (its `b`, and the other documents)
    let built = 0;
    const validator = new JarenValidator({ formatAssertion: true }).addFormats({ probe: () => { built++; return () => true; } });
    for (const n of [1, 2, 3, 4, 5])
      validator.addSchema({ $id: `https://b.test/d${n}.json`, properties: { a: { format: 'probe' }, b: { $ref: '#/$defs/t' } }, $defs: { t: { format: 'probe' } } });
    /** @param {any} schema */
    const builds = (schema) => { built = 0; validator.compile(schema); return built; };
    assert.deepEqual([
      builds({ type: 'string' }),
      builds(true),
      builds({ $ref: 'https://b.test/d2.json' }),
      builds({ $ref: 'https://b.test/d3.json#/properties/a' }),
      builds({ $ref: 'https://b.test/d4.json#/$defs/t' }),
      builds({ allOf: [{ $ref: 'https://b.test/d1.json' }, { $ref: 'https://b.test/d5.json' }] }),
    ], [0, 0, 2, 1, 2, 4]);
  });

  it('answers the same whatever else is held', () => {
    const list = { $id: 'https://b.test/list.json', type: 'array', items: { $ref: 'item.json' } };
    const item = { $id: 'https://b.test/item.json', type: 'object', required: ['n'], properties: { n: { type: 'integer' } } };
    const others = [1, 2, 3].map((n) => ({ $id: `https://b.test/other${n}.json`, $defs: { a: { $ref: '#/$defs/b' }, b: { type: 'boolean' } }, items: { $ref: '#/$defs/a' } }));
    const instances = [[{ n: 1 }], [{ n: 'x' }], [{}], 5];
    const alone = answers(new JarenValidator().addSchema(item).addSchema(list).compile({ $ref: 'https://b.test/list.json' }), instances);
    assert.deepEqual(alone, [true, false, false, false]);
    for (const order of [[...others, item, list], [list, ...others, item], [item, others[0], list, others[1], others[2]]]) {
      const validator = new JarenValidator();
      for (const document of order) validator.addSchema(document);
      assert.deepEqual(answers(validator.compile({ $ref: 'https://b.test/list.json' }), instances), alone);
      assert.deepEqual(answers(validator.compile({ $ref: 'https://b.test/other2.json' }), [[true], [1]]), [true, false]);
    }
  });
});

describe('a held reference nothing resolves is refused by the compile that reaches it', () => {
  const holder = () => ({ $id: 'https://h.test/b.json', properties: { x: { $ref: 'https://h.test/missing.json' } } });
  const AT = 'https://h.test/b.json#/properties/x/%24ref';

  it('answers every compile that does not reach it', () => {
    const validator = new JarenValidator().addSchema(holder());
    assert.deepEqual(answers(validator.compile({ type: 'object' }), [{}, 1]), [true, false]);
    assert.equal(validator.compile(true)(1), true);
    assert.deepEqual(answers(validator.compile({ $id: 'https://h.test/own.json', type: 'string' }), ['x', 1]), [true, false]);
  });

  it('refuses the compile that reaches it at compile(), naming the holder\'s place', () => {
    const validator = new JarenValidator().addSchema(holder());
    assert.deepEqual(outcome(() => validator.compile({ $ref: 'https://h.test/b.json' })), unresolved('https://h.test/missing.json#', AT));
    assert.deepEqual(outcome(() => validator.compile({ properties: { deep: { $ref: 'https://h.test/b.json#/properties/x' } } })), unresolved('https://h.test/missing.json#', AT));
    // the same reference in the compiled document keeps its own pointer
    assert.deepEqual(outcome(() => new JarenValidator().compile(holder())), unresolved('https://h.test/missing.json#', '#/properties/x/%24ref'));
  });

  it('refuses at compile(), not on the first call, a compile three references away', () => {
    const validator = new JarenValidator()
      .addSchema({ $id: 'https://h.test/p.json', properties: { x: { $ref: 'q.json' } } })
      .addSchema({ $id: 'https://h.test/q.json', items: { $ref: 'r.json#/$defs/t' } })
      .addSchema({ $id: 'https://h.test/r.json', $defs: { t: { anyOf: [{ $ref: 'missing.json' }] } } })
      .addSchema({ $id: 'https://h.test/other.json', type: 'object' });
    const at = 'https://h.test/r.json#/%24defs/t/anyOf/0/%24ref';
    for (const reaching of ['https://h.test/p.json', 'https://h.test/q.json', 'https://h.test/r.json', 'https://h.test/r.json#/$defs/t'])
      assert.deepEqual(outcome(() => validator.compile({ $ref: reaching })), unresolved('https://h.test/missing.json#', at), reaching);
    assert.deepEqual(answers(validator.compile({ $ref: 'https://h.test/other.json' }), [{}, 1]), [true, false]);
  });

  it('names the place of each holder, and answers once the target is registered', () => {
    const validator = new JarenValidator()
      .addSchema({ $id: 'https://h.test/c.json', $defs: { p: { $ref: 'm1.json' }, q: { $ref: 'm2.json#/x' } } })
      .addSchema({ $id: 'https://h.test/d.json', items: { $ref: 'm3.json' } });
    assert.equal(validator.compile({})(1), true);
    assert.deepEqual(outcome(() => validator.compile({ $ref: 'https://h.test/c.json#/$defs/q' })), unresolved('https://h.test/m2.json#/x', 'https://h.test/c.json#/%24defs/q/%24ref'));
    assert.deepEqual(outcome(() => validator.compile({ $ref: 'https://h.test/d.json' })), unresolved('https://h.test/m3.json#', 'https://h.test/d.json#/items/%24ref'));
    // a registration ends what was kept of the held set: the next compile reads the new one
    validator.addSchema({ $id: 'https://h.test/m3.json', type: 'string' });
    assert.deepEqual(answers(validator.compile({ $ref: 'https://h.test/d.json' }), [['x'], [1]]), [true, false]);
    validator.addSchema({ $id: 'https://h.test/m2.json', x: { type: 'number' } });
    assert.deepEqual(answers(validator.compile({ $ref: 'https://h.test/c.json#/$defs/q' }), [1, 'x']), [true, false]);
  });

  it('reads a pointer that misses, an anchor nothing declares and a keyed document alike', () => {
    const S = 'https://json-schema.org/draft/2020-12/schema';
    /** @type {[any, string|undefined, string, string, string][]} */
    const cases = [
      [{ $id: 'https://h.test/e.json', properties: { x: { $ref: '#/nowhere' } } }, undefined, 'https://h.test/e.json',
        "JK0009: Can not resolve schema for 'https://h.test/e.json#/nowhere': '/nowhere' is not a schema in 'https://h.test/e.json#'; fix the pointer", 'https://h.test/e.json#/properties/x/%24ref'],
      [{ $schema: S, $id: 'https://h.test/f.json', properties: { x: { $ref: '#nope' } } }, undefined, 'https://h.test/f.json',
        `JK0009: Can not resolve schema for 'https://h.test/f.json#nope': ${UNHELD}`, 'https://h.test/f.json#/properties/x/%24ref'],
      [{ properties: { x: { $ref: 'missing.json' } } }, 'https://h.test/g.json', 'https://h.test/g.json',
        `JK0009: Can not resolve schema for 'https://h.test/missing.json#': ${UNHELD}`, 'https://h.test/g.json#/properties/x/%24ref'],
    ];
    for (const [document, key, uri, message, at] of cases) {
      const validator = new JarenValidator().addSchema(document, key);
      assert.equal(validator.compile({})(1), true, uri);
      assert.deepEqual(outcome(() => validator.compile({ $ref: uri })), ['SchemaCompileError', 'JK0009', `${message} at ${at}`, at], uri);
    }
  });

  it('refuses coded a pointer into a document that only a reference names', () => {
    // the pointer was read through the placeholder the whole-document reference left
    assert.deepEqual(outcome(() => new JarenValidator().compile({ properties: { a: { $ref: 'https://x.test/u.json#/a' }, b: { $ref: 'https://x.test/u.json' } } })),
      unresolved('https://x.test/u.json#/a', '#/properties/a/%24ref'));
    assert.deepEqual(outcome(() => new JarenValidator().compile({ properties: { b: { $ref: 'https://x.test/u.json' }, a: { $ref: 'https://x.test/u.json#/a' } } })),
      unresolved('https://x.test/u.json#', '#/properties/b/%24ref'));
    const held = new JarenValidator().addSchema({ $id: 'https://x.test/h.json', properties: { a: { $ref: 'u.json#/a' }, b: { $ref: 'u.json' } } });
    assert.equal(held.compile({ type: 'string' })('x'), true);
    assert.deepEqual(outcome(() => held.compile({ $ref: 'https://x.test/h.json' })), unresolved('https://x.test/u.json#/a', 'https://x.test/h.json#/properties/a/%24ref'));
  });
});

describe('a held document whose root `$id` is only a fragment refuses no other compile', () => {
  const ORIGIN = 'https://github.com/jklarenbeek/jarenjs';
  const document = () => ({ $id: '#root', definitions: { s: { type: 'string' } }, properties: { a: { $ref: '#/definitions/s' } } });

  it('answers the compiles that do not read it', () => {
    /** @type {[any, unknown[], boolean[]][]} */
    const compiles = [
      [{ type: 'string' }, ['x', 1], [true, false]],
      [true, [1], [true]],
      [{ $id: 'https://x.test/own.json', type: 'string' }, ['x', 1], [true, false]],
      [{ $ref: 'https://x.test/k.json#other' }, [{ a: 'x' }, { a: 1 }], [true, false]],
    ];
    for (const [schema, instances, expected] of compiles) {
      const validator = new JarenValidator().addSchema(document()).addSchema({ ...document(), $id: '#other' }, 'https://x.test/k.json');
      assert.deepEqual(answers(validator.compile(schema), instances), expected, JSON.stringify(schema));
    }
  });

  it('answers the compile that reads its pointer, as the document compiled directly (it was refused JK0009 at the reference)', () => {
    // the pointer names a place of the held document, whatever the compile holds under the origin
    assert.deepEqual(answers(new JarenValidator().addSchema(document()).compile({ $ref: `${ORIGIN}#root` }), [{ a: 'x' }, { a: 1 }]), [true, false]);
    assert.deepEqual(answers(new JarenValidator().compile(document()), [{ a: 'x' }, { a: 1 }]), [true, false]);
    // a reference of the held document that nothing resolves is still refused at its place, below the document's name
    const dangling = { $id: '#root', properties: { a: { $ref: '#/definitions/none' } } };
    assert.deepEqual(outcome(() => new JarenValidator().addSchema(dangling).compile({ $ref: `${ORIGIN}#root` })), [
      'SchemaCompileError', 'JK0009',
      `JK0009: Can not resolve schema for '${ORIGIN}#root/definitions/none': '/definitions' is not a schema in '${ORIGIN}#root'; fix the pointer at ${ORIGIN}#root/properties/a/%24ref`,
      `${ORIGIN}#root/properties/a/%24ref`]);
  });
});

describe('a held `$query` whose document holds a schema literal', () => {
  const holder = () => ({ $id: 'https://x.test/q.json', type: 'object', $query: { $valid: ['$.n', { type: 'number' }] } });

  it('refuses no compile, and answers as the document compiled directly', () => {
    const validator = new JarenValidator().addSchema(holder());
    assert.deepEqual(answers(validator.compile({ type: 'string' }), ['x', 1]), [true, false]);
    assert.equal(validator.compile(true)(1), true);
    const instances = [{ n: 1 }, { n: 'x' }, 5];
    assert.deepEqual(answers(validator.compile({ $ref: 'https://x.test/q.json' }), instances), answers(new JarenValidator().compile(holder()), instances));
    assert.deepEqual(answers(validator.compile({ $ref: 'https://x.test/q.json' }), instances), [true, false, false]);
  });

  it('still refuses at compile() a literal that leads back to its own document', () => {
    const validator = new JarenValidator().addSchema({ $id: 'https://x.test/r.json', $query: { $valid: ['$', { $ref: 'https://x.test/r.json' }] } });
    assert.equal(validator.compile({ type: 'string' })('x'), true);
    const [name, code, message] = /** @type {any[]} */ (outcome(() => validator.compile({ $ref: 'https://x.test/r.json' })));
    assert.deepEqual([name, code], ['SchemaCompileError', 'JQ0009']);
    assert.match(message, /recursive schema compilation through a query literal is not supported/);
  });
});

describe('every place of a held document answers as the place of the document compiled directly', () => {
  it('reads a root named by a relative draft-04 `id` against the URI the document is held under', () => {
    // by name the dialect is unknown, so the draft-04 `id` is the identifier
    const document = () => ({ $schema: 'https://x.test/dialect/mine', id: 'nope', $defs: { t: { type: 'string' } }, type: 'object', properties: { p: { $ref: '#/$defs/t' } } });
    const direct = answers(new JarenValidator().compile(document()), [{ p: 's' }, { p: 1 }]);
    assert.deepEqual(direct, [true, false]);
    for (const key of ['https://x.test/docs/nope', 'jaren-strict:/nope']) {
      const held = () => new JarenValidator().addSchema(document(), key);
      assert.deepEqual(answers(held().compile({ $ref: key }), [{ p: 's' }, { p: 1 }]), direct, key);
      assert.deepEqual(answers(held().compile({ $ref: `${key}#/properties/p` }), ['s', 1]), direct, key);
      assert.deepEqual(answers(held().compile({ $ref: `${key}#/$defs/t` }), ['s', 1]), direct, key);
    }
  });

  it('reads an embedded resource named by a relative `$id` against its own base, reached without its document', () => {
    // `z` is `deep.json` inside `sub/thing.json`: its own `#` is read against `…/sub/deep.json`
    const document = () => ({
      $id: 'http://e.test/root.json', type: 'object',
      properties: { y: { $id: 'sub/thing.json', type: 'object', properties: { z: { $id: 'deep.json', type: 'object', required: ['k'], properties: { b: { $ref: '#' }, k: { type: 'integer' } } } } } },
    });
    const instances = [{ k: 1, b: { k: 2 } }, { k: 1, b: { k: 'x' } }, { k: 1, b: {} }];
    const direct = answers(new JarenValidator().compile(document()), instances.map((z) => ({ y: { z } })));
    assert.deepEqual(direct, [true, false, false]);
    for (const reference of ['http://e.test/sub/deep.json', 'http://e.test/root.json#/properties/y/properties/z', 'http://e.test/sub/thing.json#/properties/z'])
      assert.deepEqual(answers(new JarenValidator().addSchema(document()).compile({ $ref: reference }), instances), direct, reference);
    // the place below it, which is that resource's own reference
    assert.deepEqual(answers(new JarenValidator().addSchema(document()).compile({ $ref: 'http://e.test/sub/deep.json#/properties/b' }), instances), direct);
  });
});

describe('a meta-schema held by addMetaSchema is read as a registered document', () => {
  const dangling = () => ({ $id: 'https://f.test/dangling.json', properties: { x: { $ref: 'https://f.test/none.json' } } });

  it('reads only what the compile reaches of it', () => {
    const meta = getSchemaDraftByName('draft7');
    const validator = new JarenValidator().addMetaSchema(meta.schema, meta.draft).addSchema(dangling());
    assert.deepEqual(answers(validator.compile({ $ref: 'http://json-schema.org/draft-07/schema#' }), [{ type: 'string' }, { type: 5 }]), [true, false]);
    assert.deepEqual(answers(validator.compile({ $ref: 'http://json-schema.org/draft-07/schema#/definitions/nonNegativeInteger' }), [3, -1]), [true, false]);
    assert.deepEqual(outcome(() => validator.compile({ $ref: 'https://f.test/dangling.json' })), unresolved('https://f.test/none.json#', 'https://f.test/dangling.json#/properties/x/%24ref'));
  });
});

describe('a registered document whose root `$id` is no URI reference', () => {
  it('refuses every compile, whatever is registered after it', () => {
    const validator = new JarenValidator().addSchema({ $id: 'http://[x', type: 'string' });
    const refusal = ['SchemaCompileError', 'JK0010',
      "JK0010: $id 'http://[x' is not a valid URI reference; correct it, percent-encoding any character a URI does not allow at http://[x#/%24id", 'http://[x#/%24id'];
    assert.deepEqual(outcome(() => validator.compile({ type: 'string' })), refusal);
    validator.addSchema({ $id: 'https://f.test/a.json', type: 'number' });
    assert.deepEqual(outcome(() => validator.compile(true)), refusal);
    assert.deepEqual(outcome(() => validator.compile({ $ref: 'https://f.test/a.json' })), refusal);
  });
});

describe('a place of a held document comes into being where a compile of everything built it', () => {
  it('counts the same references toward the reference depth bound, whichever place the compile enters at', () => {
    // A ring of three places, one of them a member of the document's root. Built with the root around
    // it, at the root's turn, that place is built before the two that are built at their own: one
    // reference of the ring is then resolved on first use and counts, a turn of three levels at a time.
    const D = 'https://x.test/d.json';
    /** @param {string} ref */
    const step = (ref) => ({ properties: { n: { $ref: ref } } });
    const document = () => ({ $id: D, $defs: { x2: step('#/$defs/x1'), x1: step('#/properties/p') }, properties: { p: step('#/$defs/x2') } });
    /** @param {number} depth */
    const nest = (depth) => { let value = {}; for (let i = 0; i < depth; i++) value = { n: value }; return value; };
    /** The deepest instance answered under the bound. @param {any} validate */
    const deepest = (validate) => {
      for (let depth = 1; depth < 200; depth++) {
        try { validate(nest(depth)); }
        catch (e) { assert.equal(/** @type {any} */ (e).code, 'JK2001'); return depth - 1; }
      }
      return Infinity;
    };
    for (const options of [{ maxReferenceDepth: 16 }, { maxReferenceDepth: 16, collectErrors: true }]) {
      const validator = new JarenValidator(options).addSchema(document()).addSchema({ $id: 'https://x.test/other.json', type: 'object' });
      assert.deepEqual(['#/$defs/x1', '#/$defs/x2', '#/properties/p', '#/properties/p/properties/n'].map((place) => deepest(validator.compile({ $ref: `${D}${place}` }))),
        [46, 47, 45, 44]);
    }
  });
});

describe('a held schema that builds a reached place when it compiles is built with it', () => {
  it('keeps the reference depth bound where a document nothing reaches holds a lone `$ref` to the place in its `items`', () => {
    // A lone `$ref` at an item position is resolved when its holder compiles, which builds its target at
    // once: registered before the ring, such a holder builds one place of it before the others, and a
    // reference to that place is then called without a count. The compile reaches no such holder; it is
    // built all the same, where a compile of everything built it.
    const D = 'https://x.test/d.json';
    const U = 'https://x.test/u.json';
    /** @param {string} ref */
    const step = (ref) => ({ properties: { n: { $ref: ref } } });
    const ring = () => ({ $id: D, properties: { p: step('#/$defs/x1') }, $defs: { x1: step('#/$defs/x2'), x2: step('#/properties/p') } });
    /** @param {number} depth */
    const nest = (depth) => { let value = {}; for (let i = 0; i < depth; i++) value = { n: value }; return value; };
    /** The deepest nesting each place of the ring answers. @param {any[]} documents */
    const bounds = (documents) => {
      const validator = new JarenValidator({ maxReferenceDepth: 16 });
      for (const document of documents) validator.addSchema(document);
      return ['#/properties/p', '#/$defs/x1', '#/$defs/x2'].map((place) => {
        const validate = validator.compile({ $ref: `${D}${place}` });
        for (let depth = 1; depth < 200; depth++) {
          try { validate(nest(depth)); }
          catch (e) { assert.equal(/** @type {any} */ (e).code, 'JK2001'); return depth - 1; }
        }
        return Infinity;
      });
    };
    assert.deepEqual(bounds([ring()]), [22, 23, 23]);
    // through its items
    assert.deepEqual(bounds([{ $id: U, items: { $ref: `${D}#/$defs/x1` } }, ring()]), [46, 45, 47]);
    assert.deepEqual(bounds([ring(), { $id: U, items: { $ref: `${D}#/$defs/x1` } }]), [22, 23, 23]);
    // through its items and a reference of its own to the place
    assert.deepEqual(bounds([ring(), { $id: U, $defs: { hop: { $ref: `${D}#/$defs/x2` } }, items: { $ref: '#/$defs/hop' } }]), [45, 47, 46]);
  });
});

describe('what is kept of the held schemas ends with the next registration', () => {
  it('reads the features of a document registered after a compile, and a compile\'s own', () => {
    const S = 'https://json-schema.org/draft/2020-12/schema';
    const validator = new JarenValidator().addSchema({ $id: 'https://k.test/plain.json', type: 'object' });
    assert.equal(validator.compile({ $ref: 'https://k.test/plain.json' })({}), true);
    // annotations are tracked, and instance locations built, once a held document reads them
    validator.addSchema({ $schema: S, $id: 'https://k.test/closed.json', allOf: [{ properties: { a: true } }], unevaluatedProperties: false });
    validator.addSchema({ $id: 'https://k.test/data.json', properties: { min: { type: 'number' }, n: { minimum: { $data: '1/min' } } } });
    assert.deepEqual(answers(validator.compile({ $schema: S, $ref: 'https://k.test/closed.json' }), [{ a: 1 }, { a: 1, b: 2 }]), [true, false]);
    assert.deepEqual(answers(validator.compile({ $ref: 'https://k.test/data.json' }), [{ min: 1, n: 2 }, { min: 3, n: 2 }]), [true, false]);
    // a compile's own schema is scanned for its own
    assert.deepEqual(answers(validator.compile({ $schema: S, allOf: [{ $ref: 'https://k.test/plain.json' }, { properties: { a: true } }], unevaluatedProperties: false }), [{ a: 1 }, { b: 1 }]), [true, false]);
    assert.deepEqual(answers(new JarenValidator().addSchema({ $id: 'https://k.test/plain.json', type: 'object' })
      .compile({ allOf: [{ $ref: 'https://k.test/plain.json' }], properties: { min: { type: 'number' }, n: { minimum: { $data: '1/min' } } } }), [{ min: 1, n: 2 }, { min: 3, n: 2 }]), [true, false]);
  });
});

describe('a dynamic reference reaches the schema it names', () => {
  it('resolves, when the schema compiles, the references of the resource a `$recursiveRef` leads back to', () => {
    const S = 'https://json-schema.org/draft/2019-09/schema';
    const validator = new JarenValidator().addSchema({
      $schema: S, $id: 'https://y.test/tree.json', $recursiveAnchor: true,
      properties: { far: { $ref: 'missing.json' }, kids: { items: { $recursiveRef: '#' } } },
    });
    assert.deepEqual(outcome(() => validator.compile({ $schema: S, $ref: 'https://y.test/tree.json#/properties/kids' })),
      unresolved('https://y.test/missing.json#', 'https://y.test/tree.json#/properties/far/%24ref'));
  });

  it('builds a held resource a `$dynamicRef` names by its URI, against the base its relative `$id` was read against', () => {
    const S = 'https://json-schema.org/draft/2020-12/schema';
    const held = () => new JarenValidator().addSchema({
      $schema: S, $id: 'https://y.test/y.json',
      $defs: { e: { $id: 'sub/e.json', type: 'object', properties: { z: { $ref: '#/$defs/t' } }, $defs: { t: { type: 'string' } } } },
    });
    assert.deepEqual(answers(held().compile({ $schema: S, $dynamicRef: 'https://y.test/sub/e.json' }), [{ z: 's' }, { z: 1 }]), [true, false]);
    assert.deepEqual(answers(held().compile({ $schema: S, properties: { a: { $dynamicRef: 'https://y.test/sub/e.json#/properties/z' } } }), [{ a: 's' }, { a: 1 }]), [true, false]);
  });
});

describe('a held schema a compile does not read costs it no refusal', () => {
  it('reads a meta-schema registered after a compile, its features included', () => {
    const S = 'https://json-schema.org/draft/2020-12/schema';
    const validator = new JarenValidator().addSchema({ $id: 'https://k.test/plain.json', type: 'object' });
    assert.equal(validator.compile({ $ref: 'https://k.test/plain.json' })({}), true);
    validator.addMetaSchema({ $schema: S, $id: 'https://k.test/closed.json', allOf: [{ properties: { a: true } }], unevaluatedProperties: false }, 'https://k.test/closed.json');
    assert.deepEqual(answers(validator.compile({ $schema: S, $ref: 'https://k.test/closed.json' }), [{ a: 1 }, { a: 1, b: 2 }]), [true, false]);
  });

  it('answers a compile whose own URI is no hierarchical one beside a held relative `$id`', () => {
    // the build read every held identifier against the compiling schema's URI, which a relative one does not resolve against
    const validator = new JarenValidator().addSchema({ $id: 'https://h.test/d.json', $defs: { e: { $id: 'sub/e.json', type: 'string' } } });
    assert.deepEqual(answers(validator.compile({ $id: 'urn:example:root', type: 'string' }), ['x', 1]), [true, false]);
  });
});
