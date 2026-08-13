//@ts-check
/**
 * @file Authoring an engine document on a small model: the narrowed
 * response format, the gates a schema and a compiler both miss, and the
 * grounding that makes a vague question answerable.
 *
 * Four claims are asserted here that cannot be asserted by reading the
 * code:
 *
 *  - **The authoring profile is a real shrink, and the LLM profile is
 *    not.** The sizes are compared rather than described, because the
 *    thing that broke this path was a "profile" that grew the schema it
 *    was meant to reduce.
 *  - **A stylesheet that returns its own source is refused**, and it is
 *    refused by a check that runs BESIDE the schema and the compiler,
 *    both of which accept it — because both are right.
 *  - **"It compiles" is not "it works".** The run gate is asserted on
 *    the exact document a live model produced: canonical-valid, compiles
 *    clean, throws on the first value that reaches it.
 *  - **The worked example compiles.** An example the engine rejects
 *    teaches the failure it exists to prevent, and this one is copied
 *    verbatim into every authoring prompt.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  createStylesheetAuthor, createStructuredOutput, stylesheetGates, compileGate,
  literalBodyGate, nonEmptyGate, runGate, operatorArities, operatorNames, operatorCrib,
  describePaths, unknownOperatorGate, grammarKeywords, STYLESHEET_EXAMPLE,
} from '@jarenjs/ai';
import { JarenValidator } from '@jarenjs/validate';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';
import authoringSchema from '@jarenjs/json/schemas/jaren-jslt.authoring.schema.json' with { type: 'json' };
import canonicalSchema from '@jarenjs/json/schemas/jaren-jslt.schema.json' with { type: 'json' };
import jsltProfile from '@jarenjs/json/schemas/jaren-jslt.llm-profile.schema.json' with { type: 'json' };
import querySchema from '@jarenjs/json/schemas/jaren-query.schema.json' with { type: 'json' };

/** The sample the digest and the run gate are exercised against. */
const SAMPLE = {
  target: 0.5,
  records: [
    { id: 'R01', class: 'upper', probability: 0.61 },
    { id: 'R02', class: 'middle', probability: 0.54 },
    { id: 'R03', class: 'upper', probability: 0.58 },
  ],
};

/** The answer to the question the live probe asks, by arithmetic. */
const NEAREST_UPPER = 'R03';

/** A client that answers with whatever documents it was handed, in
 * order, so a gate's repair loop is observable without a model. */
function replaying(...replies) {
  const sent = [];
  return {
    sent,
    // openrouter, so the json_schema tier is exercised: on a provider
    // that cannot constrain decoding the schema travels in a PREPENDED
    // system message instead, and the assertions below would be reading
    // the wrong one
    endpoint: { provider: 'openrouter', model: 'stub' },
    complete: async (request) => {
      sent.push(request);
      const reply = replies[Math.min(sent.length - 1, replies.length - 1)];
      return {
        message: { role: 'assistant', content: typeof reply === 'string' ? reply : JSON.stringify(reply) },
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    },
  };
}

/** The stylesheet the campaign's live run actually produced, keeping the
 * one wrong operand. Canonical-valid, compiles, throws when run. */
const LIVE_ESCAPE_BUG = {
  $jslt: '0.1',
  rules: [{
    match: '$',
    body: {
      $head: {
        $for: { i: '$.records[*]' },
        $where: { $eq: ['$i.class', 'upper'] },
        $orderby: {
          $if: [
            { $gt: ['$.target', '$i.probability'] },
            { $sub: ['$.target', '$i.probability'] },
            { $sub: ['$i.probability', '$$.target'] },
          ],
        },
        $return: '$i',
      },
    },
  }],
};

/** The same stylesheet with the escape corrected — the shape a repair
 * round is supposed to reach. */
const CORRECT = {
  $jslt: '0.1',
  rules: [{
    match: '$',
    body: {
      $head: {
        $for: { i: '$.records[*]' },
        $where: { $eq: ['$i.class', 'upper'] },
        $orderby: {
          $if: [
            { $gt: ['$.target', '$i.probability'] },
            { $sub: ['$.target', '$i.probability'] },
            { $sub: ['$i.probability', '$.target'] },
          ],
        },
        $return: '$i',
      },
    },
  }],
};

describe('ai — the authoring profile', function () {
  it('is a real shrink of the canonical grammar, where the LLM profile is not', function () {
    const canonical = JSON.stringify(canonicalSchema).length;
    const relaxed = JSON.stringify(jsltProfile).length;
    const authoring = JSON.stringify(authoringSchema).length;

    // the finding that started this: relaxation restates what it removes
    assert.ok(relaxed >= canonical,
      `the LLM profile does not shrink the grammar (${relaxed} vs ${canonical})`);
    // and the narrowing that answers it
    assert.ok(authoring < canonical / 4,
      `the authoring profile is under a quarter of canonical (${authoring} vs ${canonical})`);
  });

  it('keeps the whole document shape and opens only the body', function () {
    const defs = Object.keys(authoringSchema.$defs ?? {});
    for (const kept of ['stylesheetDocument', 'stylesheetEnvelope', 'rule', 'matchSpec', 'modesMap'])
      assert.ok(defs.includes(kept), `${kept} survives the narrowing`);
    // the expression grammar is what left
    for (const gone of ['expression', 'flworPhrase', 'binaryOperatorPhrase', 'objectExpression'])
      assert.ok(!defs.includes(gone), `${gone} is not in the authoring profile`);
    assert.deepStrictEqual(Object.keys(authoringSchema.$defs.queryDocument), ['description'],
      'the body is open: a description and no constraint');
  });

  it('accepts every document the canonical grammar accepts', function () {
    // it is a pure widening of the canonical language, so a document
    // rejected here would be one the engine can run and the profile
    // cannot express — the one failure mode a narrowing must not have
    for (const doc of [CORRECT, LIVE_ESCAPE_BUG, STYLESHEET_EXAMPLE,
      { $jslt: '0.1', rules: [{ match: '$..title', body: { $upper: '$' } }] }]) {
      const gate = compileGate({ compile: compileJsltStylesheet });
      assert.strictEqual(gate(doc), true, 'the corpus doc compiles');
    }
  });
});

describe('ai — the operator crib the profile displaces', function () {
  it('reads the vocabulary off the injected grammar, grouped by arity', function () {
    const groups = operatorArities(querySchema);
    const find = (name) => groups.find((g) => g.names.includes(name))?.arity;

    assert.strictEqual(find('$neg'), '1', '$neg takes one operand');
    assert.strictEqual(find('$sub'), '2', '$sub takes exactly two');
    assert.strictEqual(find('$if'), '2..3', '$if takes two or three');
    assert.strictEqual(find('$and'), '1+', '$and takes one or more');
    assert.strictEqual(find('$concat'), '0+', '$concat takes zero or more');
  });

  it('names every operator once and is small enough to put in a prompt', function () {
    const names = operatorNames(querySchema);
    assert.strictEqual(new Set(names).size, names.length, 'no duplicates');
    assert.ok(names.length > 80, `the whole vocabulary (${names.length} operators)`);

    const crib = operatorCrib(querySchema);
    assert.ok(crib.includes('$if'), 'the crib names $if');
    assert.ok(crib.length < JSON.stringify(canonicalSchema).length / 10,
      `the crib is a fraction of the grammar it replaces (${crib.length} chars)`);
  });

  it('says nothing about operators when no grammar is injected', function () {
    // a prompt that invents a vocabulary is worse than one that omits it
    assert.strictEqual(operatorCrib(undefined), '');
    assert.strictEqual(operatorCrib(null), '');
  });

  it('names a host registry\'s operators too, because the compiler will accept them', function () {
    assert.match(operatorCrib(querySchema, ['$abs', '$sqrt']), /also available on this host: \$abs \$sqrt/);
  });

  it('collects the structural clause names, not only the operator enums', function () {
    const keywords = grammarKeywords(querySchema);
    for (const clause of ['$for', '$where', '$orderby', '$return', '$let'])
      assert.ok(keywords.has(clause), `${clause} is a legal member and is not in any enum`);
    assert.ok(keywords.has('$sum'), 'and the enum operators are in there too');
    assert.ok(!keywords.has('$defs'), 'JSON Schema\'s own $-keywords are not part of the language');
  });
});

describe('ai — the unknown-operator gate', function () {
  /** The document the live tier produced: right in every particular
   * except an operator that does not exist in the core grammar. */
  const withAbs = {
    $jslt: '0.1',
    rules: [{
      match: '$',
      body: {
        $head: {
          $for: { r: '$.records[*]' },
          $where: { $eq: ['$r.class', 'upper'] },
          $orderby: { $abs: { $sub: ['$r.probability', '$.target'] } },
          $return: '$r',
        },
      },
    }],
  };

  it('names the member, where the schema names everything else', function () {
    const outcome = unknownOperatorGate({ grammar: querySchema })(withAbs);
    assert.notStrictEqual(outcome, true);
    assert.strictEqual(outcome.errors[0].code, 'AI0225');
    assert.match(outcome.errors[0].message, /\$abs/, 'the message names the operator');
    assert.strictEqual(outcome.errors[0].docPath, '/rules/0/body/$head/$orderby/$abs');
  });

  it('is why it runs before the canonical schema', function () {
    // the schema refuses the same document — with eight errors, none of
    // which contains the string the model has to change. Measured: the
    // model repaired to the identical document, twice.
    const validator = new JarenValidator({ skipErrors: false, collectErrors: true });
    const outcome = validator.compile(canonicalSchema)(withAbs);
    assert.strictEqual(outcome.valid, false, 'the canonical grammar does refuse it');

    // 280 errors, of which a repair prompt carries the first 8
    // (structured.js MAX_ERRORS). The first that mentions the offending
    // member is number 67 — so what goes back to the model is a wall of
    // anyOf branches describing everything except what to change.
    const CARRIED = 8;
    const paths = outcome.errors.map((e) => `${e.instancePath} ${e.message}`);
    assert.ok(paths.length > 100, `${paths.length} errors from one wrong member`);
    const first = paths.findIndex((p) => p.includes('$abs'));
    assert.ok(first > CARRIED,
      `the first error naming it is #${first}, past the ${CARRIED} a repair round carries`);
  });

  it('accepts what a host registry adds, because the compiler does', function () {
    assert.strictEqual(unknownOperatorGate({ grammar: querySchema, extra: ['$abs'] })(withAbs), true);
  });

  it('passes a document that stays inside the vocabulary', function () {
    assert.strictEqual(unknownOperatorGate({ grammar: querySchema })(CORRECT), true);
    assert.strictEqual(unknownOperatorGate({ grammar: querySchema })(STYLESHEET_EXAMPLE), true);
  });
});

describe('ai — the gates a schema and a compiler both miss', function () {
  it('refuses a body that is a bare string literal, with its pointer', function () {
    const schibsted = [{ match: '$', body: 'if (.class == "upper") then .probability' }];

    // both existing authorities ACCEPT it, which is the whole point
    assert.strictEqual(compileGate({ compile: compileJsltStylesheet })(schibsted), true,
      'the compiler accepts it — a literal body is in the language');
    const ran = compileJsltStylesheet(schibsted)(SAMPLE);
    assert.strictEqual(ran, 'if (.class == "upper") then .probability',
      'and it returns its own source, which is the failure');

    const outcome = literalBodyGate()(schibsted);
    assert.notStrictEqual(outcome, true);
    assert.strictEqual(outcome.errors[0].code, 'AI0220');
    assert.strictEqual(outcome.errors[0].docPath, '/0/body');
  });

  it('lets a path body and a $$-escaped literal through', function () {
    assert.strictEqual(literalBodyGate()([{ match: '$', body: '$.records[*]' }]), true);
    assert.strictEqual(literalBodyGate()([{ match: '$', body: '$$literal' }]), true,
      'writing the escape is how a caller says the literal was meant');
  });

  it('is opt-out, because a constant body is a real stylesheet', function () {
    assert.strictEqual(literalBodyGate({ allow: true })([{ match: '$', body: 'hello' }]), true);
  });

  it('refuses a stylesheet with no rules', function () {
    const outcome = nonEmptyGate()({ $jslt: '0.1', rules: [] });
    assert.notStrictEqual(outcome, true);
    assert.strictEqual(outcome.errors[0].code, 'AI0221');
    assert.strictEqual(nonEmptyGate()(CORRECT), true);
  });

  it('refuses what compiles and throws on the first value that reaches it', function () {
    // the document a live model produced: right algorithm, one operand
    // written "$$.target" — the literal text, which is not a number
    assert.strictEqual(compileGate({ compile: compileJsltStylesheet })(LIVE_ESCAPE_BUG), true,
      'it compiles: the operand type is not known until a value flows through it');

    const outcome = runGate({ compile: compileJsltStylesheet, sample: SAMPLE })(LIVE_ESCAPE_BUG);
    assert.notStrictEqual(outcome, true, 'and running it is what finds the bug');
    assert.match(outcome.errors[0].message, /\$\$/, 'the repair names the escape');
    assert.ok(outcome.errors[0].docPath.includes('$sub'), 'and points at the operand');

    assert.strictEqual(runGate({ compile: compileJsltStylesheet, sample: SAMPLE })(CORRECT), true);
  });

  it('does not report a compile failure twice', function () {
    // named members for an operator whose operands are an array — the
    // first thing the live tier got wrong, and a compile error (JQ0003)
    const broken = {
      $jslt: '0.1',
      rules: [{ match: '$', body: { $if: { $gt: ['$.a', 1], then: '$.a', else: '$.b' } } }],
    };
    const compileOutcome = compileGate({ compile: compileJsltStylesheet })(broken);
    assert.notStrictEqual(compileOutcome, true, 'the compiler owns this one');
    assert.strictEqual(runGate({ compile: compileJsltStylesheet, sample: SAMPLE })(broken), true,
      'so the run gate stays silent about it');
  });

  it('does not judge the answer, only whether it runs', function () {
    // ranked over everything instead of over one class: the wrong answer,
    // and not a gate's business — a quality gate repairs badly on weak
    // models, which this package measured once already
    const unfiltered = {
      $jslt: '0.1',
      rules: [{ match: '$', body: { $head: { $for: { i: '$.records[*]' }, $orderby: '$i.probability', $return: '$i' } } }],
    };
    for (const gate of stylesheetGates({ compile: compileJsltStylesheet, sample: SAMPLE }))
      assert.strictEqual(gate(unfiltered), true, 'every gate passes a runnable wrong answer');
  });

  it('has no run gate when no sample was given', function () {
    assert.strictEqual(stylesheetGates({ compile: compileJsltStylesheet }).length, 3);
    assert.strictEqual(stylesheetGates({ compile: compileJsltStylesheet, sample: SAMPLE }).length, 4);
  });
});

describe('ai — grounding a question in the data it runs on', function () {
  it('describes a sample as the JSONPaths that address it', function () {
    const digest = describePaths(SAMPLE);
    assert.match(digest, /\$\.records\[\*\]\.probability {2}number/, 'the path and its type');
    assert.match(digest, /"upper"/, 'and enough values to bind "upperclass" to a class member');

    // without repeating the corpus: the examples per path are capped
    const many = describePaths({ rows: Array.from({ length: 50 }, (_, i) => ({ n: i })) });
    const line = many.split('\n').find((l) => l.startsWith('$.rows[*].n'));
    assert.strictEqual(line.split(',').length, 3, 'three examples, not fifty');
  });

  it('collapses an array to one entry, so the digest does not grow with the data', function () {
    const small = describePaths({ rows: [{ a: 1 }] });
    const large = describePaths({ rows: Array.from({ length: 500 }, (_, i) => ({ a: i })) });
    assert.strictEqual(small.split('\n').length, large.split('\n').length,
      'five hundred rows describe the same shape as one');
  });

  it('brackets a member name that is not a bare identifier', function () {
    // a model copying `$.a-b` writes a subtraction
    assert.match(describePaths({ 'a-b': 1 }), /\$\["a-b"\] {2}number/);
  });
});

describe('ai — the worked example', function () {
  it('compiles, because every authoring prompt carries it verbatim', function () {
    assert.doesNotThrow(() => compileJsltStylesheet(STYLESHEET_EXAMPLE));
  });

  it('carries a $where, because an example that omits a clause teaches omitting it', function () {
    const body = STYLESHEET_EXAMPLE.rules[0].body;
    assert.ok(Object.hasOwn(body.$head, '$where'),
      'measured: without it the model answered over every record instead of one class');
  });
});

describe('ai — the author', function () {
  const base = {
    createStructuredOutput,
    compile: compileJsltStylesheet,
    schema: authoringSchema,
    canonical: canonicalSchema,
    grammar: querySchema,
  };

  it('puts the crib, the example and the path digest in the request — and nothing else', async function () {
    const client = replaying(CORRECT);
    const author = createStylesheetAuthor({ ...base, client });
    const result = await author.author('nearest probability in the upper class', { sample: SAMPLE });

    assert.deepStrictEqual(result.value, CORRECT);
    const [request] = client.sent;
    const system = String(request.messages[0].content);
    const user = String(request.messages[1].content);

    assert.match(system, /\$if/, 'the operator crib is in the system message');
    assert.match(system, /"\$where"/, 'and the worked example');
    assert.match(user, /\$\.records\[\*\]\.class/, 'the path digest is in the user message');

    // a digest, not the data — the campaign's rule, asserted the only
    // way that means anything: the request does not grow with the corpus
    const big = { ...SAMPLE, records: Array.from({ length: 400 }, (_, i) => ({ id: `R${i}`, class: 'upper', probability: i / 400 })) };
    const second = replaying(CORRECT);
    await createStylesheetAuthor({ ...base, client: second }).author('q', { sample: big });
    assert.ok(String(second.sent[0].messages[1].content).length < user.length + 40,
      'four hundred records describe the same shape as three');
  });

  it('sends the narrowed schema and a token ceiling, not the canonical grammar', async function () {
    const client = replaying(CORRECT);
    await createStylesheetAuthor({ ...base, client }).author('q', { sample: SAMPLE });
    const [request] = client.sent;
    assert.strictEqual(request.responseFormat.schema.$id, authoringSchema.$id);
    assert.strictEqual(request.maxTokens, 8192, 'an unset ceiling is the failure mode, not the default');
    assert.deepStrictEqual(request.reasoning, { effort: 'low' });
  });

  it('repairs from a gate rejection with the engine\'s own pointer', async function () {
    const client = replaying(LIVE_ESCAPE_BUG, CORRECT);
    const author = createStylesheetAuthor({ ...base, client, maxRepairs: 1 });
    const result = await author.author('q', { sample: SAMPLE });

    assert.deepStrictEqual(result.value, CORRECT, 'the second attempt passed');
    assert.strictEqual(client.sent.length, 2);
    const repair = String(client.sent[1].messages.at(-1).content);
    assert.match(repair, /\$\$/, 'the repair round carries the escape hint');
  });

  it('escalates to the next model only when the whole call failed', async function () {
    const dead = {
      endpoint: { provider: 'custom', model: 'first' },
      complete: async (request) => {
        if (request.model === 'first') throw new Error('timed out');
        return { message: { role: 'assistant', content: JSON.stringify(CORRECT) } };
      },
    };
    const author = createStylesheetAuthor({ ...base, client: dead, models: ['first', 'second'] });
    const result = await author.author('q', { sample: SAMPLE });

    assert.strictEqual(result.model, 'second');
    assert.deepStrictEqual(result.value, CORRECT);
    assert.strictEqual(result.tried[0].ok, false);
  });

  it('does not escalate a model that answered badly', async function () {
    // a second opinion nobody asked for is not what a fallback is for
    const client = replaying({ $jslt: '0.1', rules: [] });
    const author = createStylesheetAuthor({ ...base, client, models: ['first', 'second'], maxRepairs: 1 });
    const result = await author.author('q', { sample: SAMPLE });

    assert.strictEqual(result.value, undefined);
    assert.strictEqual(result.errors[0].code, 'AI0222');
    assert.deepStrictEqual(client.sent.map((r) => r.model), ['first', 'first', 'second', 'second'],
      'each model gets its own attempt and repair, and only a failed CALL moves on');
  });

  it('answers the question it was asked, once the gates have passed', function () {
    // the end of the chain: the gates say it is the language, and the
    // engine says what it means
    const answer = compileJsltStylesheet(CORRECT)(SAMPLE);
    assert.strictEqual(answer.id, NEAREST_UPPER);
  });
});
