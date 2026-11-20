//@ts-check
// The round trip of a strict profile over the suite's own grammars. For every
// committed document a grammar's original accepts, the profile accepts
// `toProfile(document)` and `fromProfile(toProfile(document))` is the
// document — but for an explicit `null` at a member the original leaves
// optional (a strict answer's `null` there means the member is left out). An
// empty map beside an array branch of one union comes back a map (it is
// written `{}`, the empty array `[]`). The JTLT segment is read alike in every
// order of its branches.
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import { JarenValidator } from '@jarenjs/validate';
import { deriveStrictProfile } from '@jarenjs/validate/strict-profile';
import jtlt from '@jarenjs/json/schemas/jaren-jtlt.schema.json' with { type: 'json' };

const ROOT = new URL('../../', import.meta.url);
const D20 = 'https://json-schema.org/draft/2020-12/schema';
const read = (/** @type {string} */ file) => JSON.parse(fs.readFileSync(new URL(file, ROOT), 'utf8'));
const isObject = (/** @type {unknown} */ value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Every JSON file of a directory, by path. @param {string} dir @returns {[string, any][]} */
const directory = (dir) => fs.readdirSync(new URL(dir, ROOT)).filter((name) => name.endsWith('.json')).sort().map((name) => [`${dir}${name}`, read(`${dir}${name}`)]);
/** Every `json` fence of a Markdown document that parses, by file and position. @param {string} file @returns {[string, any][]} */
const fences = (file) => [...fs.readFileSync(new URL(file, ROOT), 'utf8').matchAll(/```json\n([\s\S]*?)\n```/g)].flatMap((match, i) => {
  try { return [/** @type {[string, any]} */ ([`${file} #${i + 1}`, JSON.parse(match[1])])]; }
  catch { return []; }
});

// real JTLT templates, and one template per segment form
const appendix = fs.readFileSync(new URL('packages/json/docs/JTLT-FORMAT.md', ROOT), 'utf8').split('## Appendix A.')[1].split('## Appendix B.')[0];
/** @type {[string, any][]} */
const templates = [['packages/contract/src/project/typescript.jtlt.json', read('packages/contract/src/project/typescript.jtlt.json')],
  ...[...appendix.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1])).filter((doc) => Array.isArray(doc) || doc.$jtlt)
    .map((doc, i) => /** @type {[string, any]} */ ([`JTLT-FORMAT Appendix A #${i + 1}`, doc]))];
const forms = ['a', '$$x', '$.n', ['b', ['c']], [], { $raw: '$.m' }, { $raw: null }, { $json: '$.n' }, { $apply: '$.n' }, { $apply: ['$.n', 'mode'] }, { $add: ['$.n', 1] },
  { $for: { x: '$.a[*]' }, $return: '$x' }, { $let: { x: 1 }, $return: null }, { $const: { a: [1, { b: null }] } }, { $const: null }, { $if: [true, 'a', 'b'] }, { $query: '0.1', $expr: '$.a' },
  { $map: [['k', 1]] }, { $string: '$.a' }, { $call: ['f', 1] }, { $some: { x: '$.a[*]' }, $satisfies: true }, { $error: ['code', 'text'] }, { $upper: { $lower: '$.a' } }, { '$string-join': ['$.a[*]', ', '] }];

/**
 * Where a document and what came back differ, each difference by its kind: an empty map read as an empty array, a
 * null member left out, or anything else.
 * @param {any} was @param {any} is @param {string} [at] @returns {[string, string][]}
 */
function differences(was, is, at = '') {
  if (isObject(was) && Object.keys(was).length === 0 && Array.isArray(is) && is.length === 0) return [[at, 'an empty map read as an empty array']];
  if ((isObject(was) && isObject(is)) || (Array.isArray(was) && Array.isArray(is))) {
    /** @type {[string, string][]} */
    const out = [];
    for (const key of new Set([...Object.keys(was), ...Object.keys(is)])) {
      if (!Object.hasOwn(is, key)) out.push([`${at}/${key}`, was[key] === null && isObject(was) ? 'a null member left out' : 'a member lost']);
      else if (!Object.hasOwn(was, key)) out.push([`${at}/${key}`, 'a member added']);
      else out.push(...differences(was[key], is[key], `${at}/${key}`));
    }
    return out;
  }
  return Object.is(was, is) ? [] : [[at, 'another value']];
}

describe('the JTLT segment, in every order of its branches', () => {
  /** @param {any[]} list @returns {any[][]} */
  const orders = (list) => (list.length <= 1 ? [list] : list.flatMap((item, i) => orders([...list.slice(0, i), ...list.slice(i + 1)]).map((rest) => [item, ...rest])));
  const all = orders(jtlt.$defs.segment.anyOf);
  // one grammar holding the segment once per order, each with its own list, over the same definitions
  /** @type {Record<string, any>} */
  const $defs = { ...jtlt.$defs };
  all.forEach((order, i) => {
    $defs[`segment${i}`] = { anyOf: order.map((branch) => (branch.$ref === '#/$defs/segmentList' ? { $ref: `#/$defs/segmentList${i}` } : branch)) };
    $defs[`segmentList${i}`] = { type: 'array', items: { $ref: `#/$defs/segment${i}` } };
  });
  const schema = { $schema: jtlt.$schema, $id: 'https://example.test/jtlt-segment-orders', type: 'object', additionalProperties: false,
    properties: Object.fromEntries(all.map((_, i) => [`order${i}`, { $ref: `#/$defs/segmentList${i}` }])), $defs };
  // every form, and the body of every rule of every real template, as one segment list
  const bodies = templates.flatMap(([, template]) => (Array.isArray(template) ? template : template.rules).map((/** @type {any} */ rule) => rule.body));
  const segments = [...forms, ...bodies];

  it('reads every form and every real template\'s bodies back as written, whichever branch stands first', () => {
    assert.equal(all.length, 120, 'the five branches in every order');
    assert.deepEqual([forms.length, templates.length], [24, 9]);
    const strict = deriveStrictProfile(schema);
    const check = new JarenValidator().compile(schema);
    const profile = new JarenValidator().compile({ $schema: D20, ...strict.schema });
    let identical = 0;
    for (let i = 0; i < all.length; i++) {
      const document = { [`order${i}`]: segments };
      assert.equal(check(document), true, `order ${i}`);
      const filled = strict.toProfile(document);
      assert.equal(profile(filled), true, `the profile accepts order ${i}: ${JSON.stringify(all[i])}`);
      assert.deepEqual(strict.fromProfile(filled), document, `order ${i}: ${JSON.stringify(all[i])}`);
      identical++;
    }
    assert.equal(identical, 120);
  });

  it('writes a segment in its own form in every order: a phrase is never written as another phrase with a null', () => {
    const strict = deriveStrictProfile(schema);
    for (const i of [0, 37, 119]) {
      const filled = /** @type {any} */ (strict.toProfile({ [`order${i}`]: [{ $apply: '$.n' }, { $raw: '$.m' }, { $json: '$.n' }, { $const: 1 }] }));
      assert.deepEqual(filled[`order${i}`], [{ $apply: '$.n' }, { $raw: '$.m' }, { $json: '$.n' }, { $const: '1' }], `order ${i}`);
    }
  });
});

describe('the suite\'s grammars and authoring profiles, over their committed documents', () => {
  const queries = [...directory('test/json/fixtures/query-format/valid/'), ...directory('test/json/fixtures/query-format/invalid/')];
  const stylesheets = [...directory('test/json/fixtures/jslt/valid/'), ...directory('test/json/fixtures/jslt/invalid/')];
  const segmented = [...templates, ...forms.map((form) => /** @type {[string, any]} */ ([`a template of ${JSON.stringify(form)}`, [{ match: '$', body: [form] }]]))];
  // every object or array a json fence of the packages', components' and repository's documents holds
  /** @type {[string, any][]} */
  const written = [];
  for (const group of ['packages/', 'components/']) {
    for (const workspace of fs.readdirSync(new URL(group, ROOT)).sort()) {
      const docs = `${group}${workspace}/docs/`;
      for (const file of [`${group}${workspace}/README.md`, ...(fs.existsSync(new URL(docs, ROOT)) ? fs.readdirSync(new URL(docs, ROOT)).filter((name) => name.endsWith('.md')).sort().map((name) => `${docs}${name}`) : [])])
        if (fs.existsSync(new URL(file, ROOT))) written.push(...fences(file));
    }
  }
  for (const name of fs.readdirSync(new URL('docs/', ROOT)).filter((file) => file.endsWith('.md')).sort()) written.push(...fences(`docs/${name}`));
  const documented = written.filter(([, document]) => document !== null && typeof document === 'object');

  /** Each grammar, the documents offered to it, and the one difference its profile's shape leaves. @type {[string, [string, any][], string[]][]} */
  const suite = [
    ['packages/json/schemas/jaren-query.schema.json', queries, []],
    ['packages/json/schemas/jaren-query.authoring.schema.json', queries, []],
    ['packages/json/schemas/jaren-jslt.schema.json', stylesheets, []],
    ['packages/json/schemas/jaren-jslt.authoring.schema.json', stylesheets, []],
    ['packages/json/schemas/jaren-jtlt.schema.json', segmented, []],
    ['packages/json/schemas/jaren-jtlt.draft-07.schema.json', segmented, []],
    ['packages/app/schemas/jaren-app.authoring.schema.json', documented, []],
    ['packages/app/schemas/jaren-app.schema.json', documented, []],
    ['packages/flow/schemas/jaren-fsm.authoring.schema.json', documented, ['a null member left out']],
    ['packages/flow/schemas/jaren-fsm.schema.json', documented, ['a null member left out']],
    ['packages/flow/schemas/jaren-dag.authoring.schema.json', documented, []],
    ['packages/flow/schemas/jaren-dag.schema.json', documented, []],
    ['packages/flow/schemas/jaren-statechart.authoring.schema.json', documented, []],
    ['packages/flow/schemas/jaren-statechart.schema.json', documented, []],
    ['packages/flow/schemas/jaren-workflow.authoring.schema.json', documented, []],
    ['packages/flow/schemas/jaren-workflow.schema.json', documented, []],
    ['packages/db/schemas/jaren-model.authoring.schema.json', documented, ['a null member left out']],
    ['packages/db/schemas/jaren-model.schema.json', documented, ['a null member left out']],
  ];

  // the documents a schema's references name, among every schema file a workspace ships
  /** @type {Map<string, any>} */
  const byId = new Map();
  /** @param {string} dir */
  const collect = (dir) => {
    for (const entry of fs.readdirSync(new URL(dir, ROOT), { withFileTypes: true })) {
      if (entry.isDirectory()) collect(`${dir}${entry.name}/`);
      else if (entry.name.endsWith('.json')) { const document = read(`${dir}${entry.name}`); byId.set(document.$id, document); }
    }
  };
  for (const group of ['packages/', 'components/']) {
    for (const workspace of fs.readdirSync(new URL(group, ROOT))) if (fs.existsSync(new URL(`${group}${workspace}/schemas/`, ROOT))) collect(`${group}${workspace}/schemas/`);
  }
  /** @param {any} schema */
  const referenced = (schema) => {
    const found = new Map();
    const queue = [schema];
    while (queue.length > 0) {
      const document = queue.pop();
      for (const match of JSON.stringify(document).matchAll(/"\$ref":"([^"#]+)(?:#[^"]*)?"/g)) {
        const target = URL.canParse(match[1], document.$id) ? byId.get(new URL(match[1], document.$id).href) : undefined;
        if (target !== undefined && target !== schema && !found.has(target.$id)) { found.set(target.$id, target); queue.push(target); }
      }
    }
    return [...found.values()];
  };

  const totals = { documents: 0, identical: 0, 'an empty map read as an empty array': 0, 'a null member left out': 0 };
  for (const [file, candidates, expected] of suite) {
    it(`${file.split('/').at(-1)}: the profile accepts toProfile(a document), and fromProfile gives the document back`, (t) => {
      const schema = read(file);
      const references = referenced(schema);
      const validator = new JarenValidator();
      for (const reference of references) validator.addSchema(reference);
      const check = validator.compile(schema);
      const strict = deriveStrictProfile(schema, { references });
      const profile = new JarenValidator().compile({ $schema: D20, ...strict.schema });
      const counts = { documents: 0, identical: 0 };
      /** @type {Set<string>} */
      const kinds = new Set();
      /** @type {string[]} */
      const changed = [];
      for (const [label, document] of candidates) {
        if (check(document) !== true) continue;
        counts.documents++;
        const filled = strict.toProfile(document);
        assert.equal(profile(filled), true, `the profile accepts toProfile(${label})`);
        const back = strict.fromProfile(filled);
        assert.equal(check(back), true, `the original accepts what comes back of ${label}`);
        const differing = differences(document, back);
        if (differing.length === 0) counts.identical++;
        else changed.push(`${label}: ${differing[0][0]} ${differing[0][1]}`);
        for (const [at, kind] of differing) {
          assert.ok(expected.includes(kind), `${label} came back with ${kind} at ${at}`);
          kinds.add(kind);
          totals[/** @type {'a null member left out'} */ (kind)]++;
        }
      }
      totals.documents += counts.documents;
      totals.identical += counts.identical;
      assert.ok(counts.documents > 0, 'the documents reach the grammar');
      // the fixture directories are this test's own: there the differences are exactly the expected ones. A
      // document of the Markdown may lose the one that showed a difference without failing here
      if (candidates !== documented) assert.deepEqual([...kinds].sort(), [...expected].sort(), 'the differences the profile\'s shape leaves, and no other');
      t.diagnostic(`${JSON.stringify(counts)}${changed.length === 0 ? '' : ` | not as written: ${changed.join('; ')}`}`);
    });
  }

  it('gives most documents back as written', (t) => {
    t.diagnostic(JSON.stringify(totals));
    assert.ok(totals.documents >= 200 && totals.identical >= totals.documents - 20);
  });
});
