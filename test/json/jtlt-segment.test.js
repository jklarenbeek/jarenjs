//@ts-check
// The JTLT segment that is a query object is a union of forms a strict
// structured-output profile can carry: the version envelope or an operator
// phrase. It states "a query document that is an object holding a
// `$`-prefixed key", whose direct transcription is the conjunction
// `allOf: [queryDocument, { type: 'object', not: { propertyNames: { pattern: '^[^$]' } } }]`,
// kept here as a test-only schema. The two accept the same values but for one
// family: the pattern fails on the empty member name as it does on a `$`, so
// the conjunction takes a map constructor holding that name for an object
// with a `$`-prefixed key. Such an object is no segment (the compiler refuses
// it TL0004) and the union refuses it. Both drafts are compared over every
// value at every depth of the committed query, JSLT and JTLT documents and
// over edges generated from the grammar's own `$` names.
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import { JarenValidator } from '@jarenjs/validate';
import { compileJtltStylesheet, validateJtltTemplate } from '@jarenjs/json/jtlt';
import latest from '@jarenjs/json/schemas/jaren-jtlt.schema.json' with { type: 'json' };
import twin from '@jarenjs/json/schemas/jaren-jtlt.draft-07.schema.json' with { type: 'json' };
import { deriveOperatorNames } from './schema-artifact-helpers.js';

const read = (/** @type {string} */ file) => JSON.parse(fs.readFileSync(new URL(file, import.meta.url), 'utf8'));
const definitionsOf = (/** @type {any} */ schema) => (Object.hasOwn(schema, '$defs') ? '$defs' : 'definitions');

/**
 * The grammar with the segment's query-object branch written as the
 * conjunction; nothing else differs.
 * @param {any} schema
 */
function withConjunction(schema) {
  const keyword = definitionsOf(schema);
  const ref = (/** @type {string} */ name) => ({ $ref: `#/${keyword}/${name}` });
  const next = structuredClone(schema);
  const branches = next[keyword].segment.anyOf;
  const at = branches.findIndex((/** @type {any} */ branch) => branch.$ref === ref('querySegment').$ref);
  assert.notEqual(at, -1, 'the segment names its query-object branch by reference');
  branches[at] = { allOf: [ref('queryDocument'), { type: 'object', not: { propertyNames: { pattern: '^[^$]' } } }] };
  next.$id = `${schema.$id}/conjunction`;
  return next;
}

/** A grammar's answers for one segment, for a whole template, and for a map constructor. @param {any} schema */
function readers(schema) {
  const at = (/** @type {string} */ name) => new JarenValidator().addSchema(schema).compile({ $ref: `${schema.$id}#/${definitionsOf(schema)}/${name}` });
  const [segment, map, sheet] = [at('segment'), at('mapConstructor'), new JarenValidator().compile(schema)];
  return {
    segment: (/** @type {unknown} */ value) => segment(value) === true,
    map: (/** @type {unknown} */ value) => map(value) === true,
    sheet: (/** @type {unknown} */ value) => sheet(value) === true,
  };
}

const isObject = (/** @type {unknown} */ value) => value !== null && typeof value === 'object' && !Array.isArray(value);
/** An object with the empty member name and no `$`-prefixed key. @param {any} value */
const emptyNamed = (value) => isObject(value) && Object.hasOwn(value, '') && !Object.keys(value).some((key) => key.startsWith('$'));
/** Whether a segment is one, or a nested segment list holding one. @param {any} value @returns {boolean} */
const holdsEmptyNamed = (value) => (Array.isArray(value) ? value.some(holdsEmptyNamed) : emptyNamed(value));
/** The two template shapes with one segment as the whole body of one rule. @param {unknown} segment */
const templates = (segment) => [[{ match: '$', body: [segment] }], { $jtlt: '0.1', rules: [{ match: '$', body: [segment] }] }];

/** Distinct values by JSON text, each with every value inside it. @type {Map<string, any>} */
const corpus = new Map();
/** @param {any} value */
const walk = (value) => {
  const text = JSON.stringify(value);
  if (!corpus.has(text)) corpus.set(text, value);
  if (Array.isArray(value)) value.forEach(walk);
  else if (isObject(value)) Object.values(value).forEach(walk);
};
const sizes = { files: 0, documents: 0, templates: 0, names: 0, generated: 0 };

for (const dir of ['./fixtures/query-format/valid/', './fixtures/query-format/invalid/', './fixtures/jslt/valid/', './fixtures/jslt/invalid/']) {
  for (const name of fs.readdirSync(new URL(dir, import.meta.url)).filter((file) => file.endsWith('.json')).sort()) {
    sizes.files++;
    walk(read(dir + name));
  }
}
sizes.documents = corpus.size;

// real templates: the contract's TypeScript projection and the format document's Appendix A
const appendix = fs.readFileSync(new URL('../../packages/json/docs/JTLT-FORMAT.md', import.meta.url), 'utf8')
  .split('## Appendix A.')[1].split('## Appendix B.')[0];
const published = [read('../../packages/contract/src/project/typescript.jtlt.json'),
  ...[...appendix.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1])).filter((doc) => Array.isArray(doc) || doc.$jtlt)];
published.forEach(walk);
sizes.templates = corpus.size - sizes.documents;

// every `$` name the grammar closes over or declares as a member, alone, nested
// in an operator, in a list, beside a plain key and beside the empty name, and
// as a member of a map constructor
const names = [...new Set([...deriveOperatorNames(latest),
  ...Object.values(latest.$defs).flatMap((/** @type {any} */ def) => Object.keys(def.properties ?? {})).filter((name) => name.startsWith('$'))])].sort();
sizes.names = names.length;
for (const name of names) {
  for (const argument of [1, '$.a', [1, 2], ['$.a', 1, 2], { x: '$.a[*]' }]) {
    const phrase = { [name]: argument };
    for (const edge of [phrase, { $not: phrase }, [phrase], { ...phrase, plain: 1 }, { ...phrase, '': 1 }, { a: phrase }, { '': phrase }]) walk(edge);
  }
}
for (const edge of [
  // no key, plain keys, the empty member name
  {}, { a: 1 }, { a: { b: [1, { c: null }] } }, { '': 1 }, { '': 1, a: 2 }, { '': {} }, { '': { '': 1 } }, { '': [1, { '': 2 }] }, [{ '': 1 }], [[{ '': 1 }], 'a'],
  { '': 1, $const: 2 }, { '': { $nope: 1 } },
  // unknown `$` names, the envelope whole and in part, two phrases at once
  { $nope: 1 }, { $: 1 }, { $$: 1 }, { '$ ': 1 }, { $nope: 1, a: 1 }, { $query: '0.1', $expr: 1 }, { $query: '0.1' }, { $expr: 1 }, { $query: '0.2', $expr: 1 },
  { $query: '0.1', $expr: 1, $const: 1 }, { $query: '0.1', $expr: 1, a: 1 }, { $const: 1, $add: [1, 2] }, { $add: [1, 2], $sub: [1, 2] },
  // the segment-only phrases, clauses that need each other, lists and scalars
  { $raw: '$.a', $json: '$.a' }, { $raw: { '': 1 } }, { $json: { a: 1 } }, { $for: { x: '$.a[*]' }, $return: '$x' }, { $some: { x: '$.a[*]' }, $satisfies: true },
  [], [[]], ['a', ['b', ['$.c']]], 'text', '$.a', '$$x', '$9', 1, 1.5, null, true, false,
]) walk(edge);
sizes.generated = corpus.size - sizes.documents - sizes.templates;

describe('the JTLT segment that is a query object', () => {
  it('reads a corpus that reaches every form', (t) => {
    t.diagnostic(`corpus: ${JSON.stringify(sizes)}, ${corpus.size} distinct values`);
    assert.ok(sizes.files >= 84 && sizes.documents >= 500, 'the committed query and JSLT fixtures');
    assert.equal(published.length, 9, 'the contract template and the eight of Appendix A');
    assert.ok(sizes.names >= 140 && sizes.generated >= 5000, 'edges for every $ name of the grammar');
  });

  for (const [draft, schema] of /** @type {[string, any][]} */ ([['draft 2020-12', latest], ['draft-07', twin]])) {
    const [union, conjunction] = [readers(schema), readers(withConjunction(schema))];

    it(`${draft}: accepts what the conjunction accepts, but a map constructor holding the empty member name`, (t) => {
      const counts = { agree: 0, accepted: 0, refused: 0, objectsAccepted: 0, narrowed: 0, templates: 0, templatesAgree: 0, templatesNarrowed: 0 };
      for (const [text, value] of corpus) {
        const [was, is] = [conjunction.segment(value), union.segment(value)];
        if (was === is) {
          counts.agree++;
          counts[is ? 'accepted' : 'refused']++;
          if (is && isObject(value) && !Object.hasOwn(value, '$raw') && !Object.hasOwn(value, '$json')) counts.objectsAccepted++;
        }
        else {
          assert.deepEqual([holdsEmptyNamed(value), was, is], [true, true, false], `the two segments differ on ${text.slice(0, 200)}`);
          counts.narrowed++;
        }
        for (const template of templates(value)) {
          counts.templates++;
          const [whole, wholeNow] = [conjunction.sheet(template), union.sheet(template)];
          if (whole === wholeNow) counts.templatesAgree++;
          else {
            assert.deepEqual([holdsEmptyNamed(value), whole, wholeNow], [true, true, false], `the two grammars differ on a template whose body is ${text.slice(0, 200)}`);
            counts.templatesNarrowed++;
          }
        }
      }
      t.diagnostic(`${draft}: ${JSON.stringify(counts)}`);
      assert.equal(counts.agree + counts.narrowed, corpus.size);
      assert.equal(counts.templatesAgree + counts.templatesNarrowed, 2 * corpus.size);
      assert.equal(counts.templatesNarrowed, 2 * counts.narrowed);
      assert.ok(counts.objectsAccepted >= 800 && counts.refused >= 3000 && counts.narrowed >= 300, 'the comparison reaches accepted objects, refusals and the narrowed family');
    });

    it(`${draft}: the conjunction took an empty-named object for a segment exactly where it is a map constructor; the union takes none`, () => {
      let family = 0;
      for (const [text, value] of corpus) {
        if (!emptyNamed(value)) continue;
        family++;
        assert.equal(conjunction.segment(value), union.map(value), `the conjunction on ${text.slice(0, 200)}`);
        assert.equal(union.segment(value), false, `the union on ${text.slice(0, 200)}`);
      }
      assert.ok(family >= 700, 'empty-named objects in the corpus');
    });
  }

  it('answers as the compiler does outside its TL0005 boundary: what compiles is accepted, what is refused under another code is refused', (t) => {
    const [union, conjunction] = [readers(latest), readers(withConjunction(latest))];
    /** @type {Record<string, number>} */
    const codes = {};
    let narrowed = 0;
    for (const [text, value] of corpus) {
      const template = templates(value)[0];
      let code = 'compiles';
      try { compileJtltStylesheet(template); }
      catch (error) { code = /** @type {any} */ (error).code; }
      codes[code] = (codes[code] ?? 0) + 1;
      // TL0005 is the inherited query boundary: path syntax, operator arguments and hooks need compilation
      if (code !== 'TL0005') assert.equal(union.sheet(template), code === 'compiles', `${code}: ${text.slice(0, 200)}`);
      if (conjunction.sheet(template) === union.sheet(template)) continue;
      // the narrowed family never compiled: no template leaves the grammar that a host could render
      narrowed++;
      assert.equal(code, 'TL0004', text.slice(0, 200));
      assert.equal(validateJtltTemplate(template).errors[0].code, 'TL0004', text.slice(0, 200));
    }
    t.diagnostic(`compiler over ${corpus.size} one-segment templates: ${JSON.stringify(codes)}; narrowed and refused TL0004: ${narrowed}`);
    assert.deepEqual(Object.keys(codes).sort(), ['TL0004', 'TL0005', 'compiles']);
    assert.ok(codes.compiles >= 1500 && codes.TL0004 >= 1500 && narrowed >= 300);
  });
});
