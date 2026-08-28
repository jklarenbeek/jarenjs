//@ts-check
/**
 * @file The forms pen, held to the package it writes for: the forms
 * README's own layer-2 document — read from its fence at test time,
 * never copied — is rebuilt BYTE-EQUAL through `s.string().form({…})`,
 * then read back by `buildFormModel`, compiled by `compileFormRules`
 * and answered by `evaluateFormRules`; `assertOnSubmit()` is pinned
 * deep-equal to `formRulesToQueryAssertions` over every corpus document
 * and its `$query` twin is enforced by the real validator. Beside the
 * two: the rule context's three names and the `JL0104` any other one
 * is, the item-template pointer, the refusals by code, two-run
 * determinism and the no-engine rule.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';

import * as s from '@jarenjs/linq/forms';
import { assertOnSubmit } from '@jarenjs/linq/forms';
import { LinqBuildError } from '@jarenjs/linq';
import {
  buildFormModel, buildFormViewModel, compileFormRules, evaluateFormRules,
  formRulesToQueryAssertions,
} from '@jarenjs/forms';
import { JarenValidator } from '@jarenjs/validate';
import { jsonFormats } from '@jarenjs/formats';
import { getSchemaDraftByVersion } from '@jarenjs/refs';

const README = new URL('../../packages/forms/README.md', import.meta.url);
const FORMS_SRC = new URL('../../packages/linq/src/forms/', import.meta.url);

/** The bytes a document is: JSON text, member order included. @param {any} doc */
const bytes = (doc) => JSON.stringify(doc);

/**
 * The `n`-th fenced example of the README, parsed — the package's own
 * worked example, read at test time.
 * @param {string} lang - the fence's language tag
 * @param {string} contains - a string the fence carries, to pick it
 * @returns {any}
 */
function example(lang, contains) {
  const markdown = fs.readFileSync(README, 'utf8');
  const fences = [...markdown.matchAll(new RegExp('```' + lang + '\\n([\\s\\S]*?)```', 'g'))]
    .map((m) => m[1])
    .filter((body) => body.includes(contains));
  assert.ok(fences.length >= 1, `the README carries a ${lang} fence with ${contains}`);
  return JSON.parse(fences[0]);
}

describe('the forms README\'s layer-2 document, rebuilt through the pen', () => {
  /** The README's own `x-form` example, by code. */
  const build = () => s.document(s.object({
    company: s.string().optional(),
    vatId: s.string().optional().form({
      visible: (c) => c.root.company.ne(''),
      assert: (c) => c.root.company.eq('').or(c.root.vatId.ne('')),
      message: 'VAT id is required for companies',
    }),
    total: s.number().optional().form({
      computed: (c) => c.root.lines.all().amount.sum(),
    }),
  }).open());

  it('is byte-equal to the README, and two builds are one document', () => {
    const doc = build();
    assert.strictEqual(bytes(doc), bytes(example('json', '"x-form"')), 'layer 2 byte-equal');
    assert.strictEqual(bytes(build()), bytes(doc), 'two runs, one document');
    assert.deepStrictEqual(JSON.parse(bytes(doc)), doc, 'plain JSON');
    assert.strictEqual(Object.isFrozen(doc), true);
  });

  it('answers the README\'s own vatId reading through forms', () => {
    const model = buildFormModel(build());
    const rules = compileFormRules(model);
    const state = evaluateFormRules(rules,
      { company: 'ACME', vatId: '', lines: [{ amount: 10 }, { amount: 10 }] });
    assert.strictEqual(state['/vatId'].visible, true);
    assert.deepStrictEqual(state['/vatId'].errors,
      [{
        keyword: 'x-form/assert',
        params: { pointer: '/vatId' },
        msgid: 'x-form/assert',
        message: 'VAT id is required for companies',
      }]);
    assert.deepStrictEqual(state['/total'], { computed: 20 });
  });

  it('hides the rule\'s field, and holds its assert vacuously, without a company', () => {
    const model = buildFormModel(build());
    const rules = compileFormRules(model);
    const state = evaluateFormRules(rules, { company: '', vatId: '' });
    assert.strictEqual(state['/vatId'].visible, false);
    assert.deepStrictEqual(state['/vatId'].errors ?? [], []);
    const tree = buildFormViewModel(model, { company: '', vatId: '' }, { rules });
    assert.strictEqual(tree.children.some((n) => n.pointer === '/vatId'), false,
      'a rule-hidden field is not rendered');
  });

  it('is the submit twin the forms transform writes, and the validator enforces it', () => {
    const doc = build();
    const submit = assertOnSubmit(doc);
    assert.deepStrictEqual(submit, formRulesToQueryAssertions(doc),
      'the pen writes exactly what formRulesToQueryAssertions writes');
    assert.strictEqual(bytes(assertOnSubmit(s.object({
      company: s.string().optional(),
      vatId: s.string().optional().form({
        visible: (c) => c.root.company.ne(''),
        assert: (c) => c.root.company.eq('').or(c.root.vatId.ne('')),
        message: 'VAT id is required for companies',
      }),
      total: s.number().optional().form({ computed: (c) => c.root.lines.all().amount.sum() }),
    }).open())), bytes(submit), 'a builder root and its document answer one twin');

    const validate = new JarenValidator({ collectErrors: true }).addFormats(jsonFormats)
      .compile(submit);
    assert.strictEqual(validate({ company: 'ACME', vatId: '' }).valid, false,
      'the vatId assert is authoritative on submit');
    assert.strictEqual(validate({ company: 'ACME', vatId: 'NL01' }).valid, true);
    assert.strictEqual(validate({ company: '', vatId: '' }).valid, true,
      'hidden holds vacuously, as it does per keystroke');
  });

  it('leaves a document with no assert exactly as it was', () => {
    const doc = s.document(s.object({ a: s.string().form({ computed: (c) => c.root.b }) }));
    assert.strictEqual(bytes(assertOnSubmit(doc)), bytes(doc));
  });
});

describe('the forms README\'s opening model, rebuilt through the pen', () => {
  it('is byte-equal to the README\'s usage schema', () => {
    const markdown = fs.readFileSync(README, 'utf8');
    const usage = /```javascript\n([\s\S]*?)```/.exec(markdown.slice(markdown.indexOf('## Usage')));
    assert.ok(usage, 'the README opens with a usage example');
    const open = usage[1].indexOf('{', usage[1].indexOf('const schema ='));
    let depth = 0;
    let text = '';
    for (let i = open; i < usage[1].length; i++) {
      text += usage[1][i];
      if (usage[1][i] === '{') depth++;
      else if (usage[1][i] === '}' && --depth === 0) break;
    }
    // the fence is a JS object literal: read it as one, never as JSON
    const handWritten = new Function(`return ${text};`)();
    const byCode = s.document(s.object({
      username: s.string().min(3).pattern('^[a-z0-9_]+$'),
      email: s.string().format('email'),
      age: s.integer().min(13).optional(),
    }).open().title('Sign up'));
    assert.strictEqual(bytes(byCode), bytes(handWritten));
    assert.strictEqual(buildFormModel(byCode).children.length, 3);
  });
});

describe('the forms pen — the rule context and the vocabulary', () => {
  it('binds the three names the evaluator binds, and nothing else', () => {
    const doc = s.document(s.object({
      a: s.string().form({ assert: (c) => c.value.ne(c.root.b) }),
      b: s.string().form({ computed: (c) => c.pointer }),
    }));
    assert.deepStrictEqual(doc.properties.a['x-form'].assert, { $ne: ['$value', '$.b'] });
    assert.strictEqual(doc.properties.b['x-form'].computed, '$pointer');
    let caught;
    assert.throws(() => s.string().form({ assert: (c) => c.root.a.eq(c.nope) }),
      (err) => { caught = err; return true; });
    assert.ok(caught instanceof LinqBuildError);
    assert.strictEqual(caught.code, 'JL0104');
    assert.match(caught.message, /'value' and 'pointer'/);
    assert.match(caught.message, /c\.root/);
  });

  it('writes the README\'s member order whatever order the author used', () => {
    const doc = s.document(s.string().form({
      message: 'no', computed: (c) => c.value, assert: (c) => c.value, visible: (c) => c.value,
      enabled: (c) => c.value,
    }));
    assert.deepStrictEqual(Object.keys(doc['x-form']),
      ['visible', 'enabled', 'assert', 'computed', 'message']);
  });

  it('merges a second form() into the one annotation', () => {
    const doc = s.document(s.string().form({ visible: (c) => c.value }).form({ message: 'no' }));
    assert.deepStrictEqual(doc['x-form'], { visible: '$value', message: 'no' });
  });

  it('takes a MessageSpec verbatim, as the README spells it', () => {
    const doc = s.document(s.object({
      company: s.string().optional(),
      vatId: s.string().optional().form({
        assert: (c) => c.root.company.eq('').or(c.root.vatId.ne('')),
        message: { $msgid: 'checkout.vat-required', message: 'A VAT id is required for companies' },
      }),
    }).open());
    assert.deepStrictEqual(doc.properties.vatId['x-form'],
      example('javascript', '$msgid')['x-form']);
  });

  it('takes a query document by hand wherever it takes a callback', () => {
    const doc = s.document(s.string().form({ visible: { $ne: ['$.company', ''] } }));
    assert.deepStrictEqual(doc['x-form'].visible, { $ne: ['$.company', ''] });
  });

  it('is an ANNOTATION: nothing else about the schema moves', () => {
    const plain = s.document(s.object({ a: s.string() }));
    const ruled = JSON.parse(JSON.stringify(
      s.document(s.object({ a: s.string().form({ visible: (c) => c.value }) }))));
    delete ruled.properties.a['x-form'];
    assert.deepStrictEqual(ruled, JSON.parse(JSON.stringify(plain)),
      'required and additionalProperties are untouched');
  });

  it('writes an item-template rule where buildFormModel expects it', () => {
    const doc = s.document(s.object({
      lines: s.array(s.object({
        amount: s.number().form({ assert: (c) => c.value.gt(0), message: 'positive' }),
      })),
    }));
    const model = buildFormModel(doc);
    assert.strictEqual(model.children[0].item.children[0].pointer, '/lines/-/amount');
    const rules = compileFormRules(model);
    const state = evaluateFormRules(rules, { lines: [{ amount: 1 }, { amount: -1 }] });
    assert.deepStrictEqual(state['/lines/0/amount'] ?? {}, {}, 'a passing element carries nothing');
    assert.strictEqual(state['/lines/1/amount'].errors[0].message, 'positive');
    const validate = new JarenValidator({ collectErrors: true }).compile(assertOnSubmit(doc));
    assert.strictEqual(validate({ lines: [{ amount: 1 }] }).valid, true);
    assert.strictEqual(validate({ lines: [{ amount: 1 }, { amount: -1 }] }).valid, false,
      'the twin quantifies over the ELEMENTS');
    assert.deepStrictEqual(assertOnSubmit(doc), formRulesToQueryAssertions(doc));
  });
});

describe('the forms pen — what it refuses, by code', () => {
  /**
   * The refusal, so a test can read its message.
   * @param {() => any} fn @param {string} code @returns {any}
   */
  const refuses = (fn, code) => {
    let caught;
    assert.throws(fn, (err) => { caught = err; return true; });
    assert.ok(caught instanceof LinqBuildError, `a LinqBuildError, got ${caught}`);
    assert.strictEqual(caught.code, code, caught.message);
    return caught;
  };

  it('JL0101 — a member x-form does not define', () => {
    const err = refuses(() => s.string().form({ nope: 1 }), 'JL0101');
    assert.match(err.message, /visible, enabled, assert, computed, message/);
  });

  it('JL0101 — a message that is neither a string nor a MessageSpec', () => {
    refuses(() => s.string().form({ message: 7 }), 'JL0101');
    refuses(() => s.string().form({ message: { params: {} } }), 'JL0101');
  });

  it('JL0101 — a spec that is not an object', () => {
    refuses(() => s.string().form(null), 'JL0101');
  });

  it('JL0102 — preview, which the format registry derives and never an author', () => {
    const err = refuses(() => s.string().form({ preview: { kind: 'map' } }), 'JL0102');
    assert.match(err.message, /getFormatInfo/);
  });

  it('JL0104 — x-form through meta()', () => {
    const err = refuses(() => s.string().meta({ 'x-form': { visible: '$.a' } }), 'JL0104');
    assert.match(err.message, /form\(\)/);
  });

  it('JL0101 — assertOnSubmit over something that is not a document', () => {
    refuses(() => assertOnSubmit(7), 'JL0101');
  });

  it('still refuses everything the schema pen refuses', () => {
    refuses(() => s.string().default(() => 1), 'JL0101');
    assert.strictEqual(s.string().meta({ 'x-anything': 1 }).schema['x-anything'], 1);
  });
});

describe('the forms pen imports no engine', () => {
  it('reaches @jarenjs/forms from no source file', () => {
    for (const file of fs.readdirSync(FORMS_SRC)) {
      const source = fs.readFileSync(new URL(file, FORMS_SRC), 'utf8');
      assert.strictEqual(/from '@jarenjs\/(forms|validate|json)/.test(source), false,
        `${file} imports a package the pen must not carry`);
    }
  });
});

describe('the forms pen — the published grammar it writes under', () => {
  // `x-form` is an annotation ON a JSON Schema, so the forms pen's grammar
  // IS the 2020-12 meta-schema — the same cell the schema pen fills, and
  // the one the pen agreement needs filled for every pen. (The direct
  // compile is the route that works: `addMetaSchema(bundle)` answers false
  // for every schema, which the schema pen's suite records.)
  const [main, ...vocabularies] = getSchemaDraftByVersion(2020).schema;
  const metaSchema = new JarenValidator().addSchema(vocabularies).compile(main);

  it('the meta-schema check is load-bearing', () => {
    assert.strictEqual(metaSchema({ type: 42 }), false);
    assert.strictEqual(metaSchema({ type: 'string', minLength: -1 }), false);
    assert.strictEqual(metaSchema({ type: 'string' }), true);
  });

  it("every document the README's two examples build is valid 2020-12", () => {
    const layer2 = s.document(s.object({
      company: s.string().optional(),
      vatId: s.string().optional().form({
        visible: (c) => c.root.company.ne(''),
        assert: (c) => c.root.company.eq('').or(c.root.vatId.ne('')),
        message: 'VAT id is required for companies',
      }),
      total: s.number().optional().form({ computed: (c) => c.root.lines.all().amount.sum() }),
    }).open());
    assert.strictEqual(metaSchema(layer2), true, JSON.stringify(metaSchema.errors ?? []));
  });

  it('every x-form member the pen can write leaves a valid 2020-12 document', () => {
    const doc = s.document(s.object({
      kind: s.string().enumOf(['a', 'b']),
      note: s.string().optional().form({
        visible: (c) => c.root.kind.eq('a'),
        enabled: (c) => c.root.kind.eq('a'),
        assert: (c) => c.value.ne(''),
        message: { $msgid: 'x-form/assert', message: 'a note is required' },
      }),
      lines: s.array(s.object({ amount: s.number() })),
      total: s.number().optional().form({ computed: (c) => c.root.lines.all().amount.sum() }),
    }).open());
    assert.strictEqual(metaSchema(doc), true, JSON.stringify(metaSchema.errors ?? []));
    // and the annotation really is in the document the grammar accepted
    assert.ok(Object.hasOwn(doc.properties.note, 'x-form'));
    assert.strictEqual(buildFormModel(doc).kind, 'object');
  });
});
