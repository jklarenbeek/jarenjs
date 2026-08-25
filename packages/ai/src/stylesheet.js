//@ts-check
/**
 * Authoring an ENGINE DOCUMENT with a small model — the JSLT stylesheet
 * case, and the three things measurement said it needs.
 *
 * The package already had the pattern: a schema constrains decoding, a
 * compile gate constrains meaning, and a rejected candidate goes back
 * with the engine's own code and pointer. On the cheap tier that pattern
 * did not survive contact with the published JSLT grammar. Three causes
 * were measured, and this module is one answer to each:
 *
 *  1. **The response format was too big to decode.** The canonical JSLT
 *     grammar is ~19 kB because it inlines the whole query expression
 *     language, and the LLM-profile twin is no smaller (a relaxation
 *     restates what it removes, so it grows). Asked to author against it,
 *     `qwen3.6-35b-a3b` returns an empty reply or the three characters
 *     `1.1`. The fix is the AUTHORING PROFILE — the same grammar cut at
 *     the body, ~3.2 kB — and the vocabulary the cut removes moves into
 *     the prompt as {@link operatorCrib}, where names cost a decoder
 *     nothing.
 *
 *  2. **Reasoning ate the output budget.** Of 2261 completion tokens on
 *     a successful call, 1927 were reasoning; the repair round then went
 *     to 3387 and blew its deadline. A model thinking harder than the
 *     task deserves is not a prompt problem, it is a REQUEST problem, and
 *     the client has carried a `reasoning` control all along. This
 *     author bounds it (`reasoning`, default `{ effort: 'low' }`) so the
 *     tokens go to the document.
 *
 *  3. **Both gates passed a document that was not the language.** A body
 *     string that is not path-shaped is a legal string LITERAL, so a
 *     model writing Schibsted-JSLT text syntax produces a stylesheet
 *     that validates, compiles, and returns its own source. Nothing is
 *     wrong with the document; it is just not an answer.
 *     {@link literalBodyGate} is the check neither the schema nor the
 *     compiler can make, because both are right.
 *
 * Codes are `AI0220`–`AI0222`, beside the program language's `AI02xx`.
 * Every engine is INJECTED (`compile`), never imported: this package
 * depends on no engine, and a caller that wants JTLT or a flow machine
 * gated the same way passes a different compiler.
 */

import { JarenValidator } from '@jarenjs/validate';
import { checkOutcome } from './check.js';

/**
 * The check-outcome shape the structured-output gate seam speaks — a
 * refusal is data, never a thrown error, because the gate's caller is a
 * repair loop that reads it. The codes name a document that is
 * well-formed and compilable and still not an answer:
 *
 *   AI0220 — a rule body is a bare string literal (it returns itself)
 *   AI0221 — the stylesheet has no rules
 *   AI0222 — the authoring call produced nothing on any configured model
 */
const refuse = (code, reason, docPath) => ({
  valid: false, errors: [{ code, docPath, message: reason }],
});

//#region the vocabulary that leaves the schema

/**
 * How one operator phrase takes its operands, read off the phrase's
 * `additionalProperties` — not off its `$defs` NAME, which is a label
 * this package does not own and which would rot the first time the
 * grammar is refactored.
 * @param {any} operand - the phrase's additionalProperties schema
 * @returns {string} a stable key ('1', '2', '3', '2..3', '1+', '0+')
 */
function arityOf(operand) {
  if (operand?.type !== 'array') return '1';
  const min = operand.minItems ?? 0;
  const max = operand.maxItems;
  if (max === undefined) return min > 0 ? '1+' : '0+';
  return min === max ? String(min) : `${min}..${max}`;
}

/** What each arity key means in a sentence a model can act on. */
const ARITY_PHRASE = {
  1: 'one operand, written directly',
  2: 'exactly two, written [a, b]',
  3: 'exactly three, written [a, b, c]',
  '2..3': 'two or three, written [test, then] or [test, then, else]',
  '1+': 'one or more, written [a, b, …]',
  '0+': 'zero or more, written [a, …]',
};

/**
 * Every operator the grammar closes over, grouped by how it takes its
 * operands — read off the injected artifact rather than listed here.
 *
 * This is what the authoring profile takes OUT of the response format,
 * and putting it back in the PROMPT is the cheap half of the trade: the
 * names and their arity are about a kilobyte, while the phrase shapes
 * that carry them in the schema are the ~16 kB that stops a small model
 * decoding at all.
 *
 * Arity is in here because a measurement put it here. On the compact
 * envelope alone, `qwen3.6-35b-a3b` reached the right ALGORITHM and
 * failed the language on the last step, writing
 * `{"$if": {"$gt": …, "then": …, "else": …}}` — named members for an
 * operator whose operands are an array. Names alone would not have
 * fixed that; names plus arity is one line longer.
 *
 * @param {any} schema - a grammar artifact (the query or JSLT schema)
 * @returns {Array<{ arity: string, names: string[] }>} in grammar order
 */
export function operatorArities(schema) {
  /** @type {Map<string, Set<string>>} */
  const byArity = new Map();
  /** @param {any} node */
  function walk(node) {
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    if (node === null || typeof node !== 'object') return;
    const enumerated = node.propertyNames?.enum;
    if (Array.isArray(enumerated)) {
      const arity = arityOf(node.additionalProperties);
      let bucket = byArity.get(arity);
      if (bucket === undefined) byArity.set(arity, bucket = new Set());
      for (const name of enumerated) {
        if (typeof name === 'string' && name.startsWith('$')) bucket.add(name);
      }
    }
    for (const key of Object.keys(node)) walk(node[key]);
  }
  walk(schema);
  return [...byArity].map(([arity, names]) => ({ arity, names: [...names] }));
}

/**
 * Every operator name the grammar closes over, sorted and flat.
 * @param {any} schema
 * @returns {string[]}
 */
export function operatorNames(schema) {
  return operatorArities(schema).flatMap((g) => g.names).sort();
}

/**
 * Every `$`-prefixed member name the grammar admits anywhere: the
 * operator enums plus the structural clause names (`$for`, `$where`,
 * `$orderby`, `$return`, `$let`, …) that are declared as ordinary
 * `properties` rather than drawn from an enum.
 *
 * This is the CLOSED vocabulary, and having it as a set is what turns
 * "the document does not validate" into "`$abs` is not an operator" —
 * see {@link unknownOperatorGate} for why that difference decides
 * whether a repair round lands.
 * @param {any} schema
 * @returns {Set<string>}
 */
export function grammarKeywords(schema) {
  /** @type {Set<string>} */
  const names = new Set();
  const add = (name) => {
    if (typeof name === 'string' && name.startsWith('$') && name !== '$ref'
      && name !== '$defs' && name !== '$id' && name !== '$schema' && name !== '$comment') {
      names.add(name);
    }
  };
  /** @param {any} node */
  function walk(node) {
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    if (node === null || typeof node !== 'object') return;
    for (const name of node.propertyNames?.enum ?? []) add(name);
    for (const name of Object.keys(node.properties ?? {})) add(name);
    for (const name of node.required ?? []) add(name);
    for (const key of Object.keys(node)) {
      // `properties` keys are DATA (member names), not schema keywords —
      // walking into the map is right, treating its keys as schema is not
      if (key === 'propertyNames') continue;
      walk(node[key]);
    }
  }
  walk(schema);
  return names;
}

/**
 * The operator vocabulary as prompt text. Empty when no grammar is
 * injected — a caller without the artifact gets a prompt that says
 * nothing about operators rather than one that lies about them.
 * @param {any} [schema]
 * @param {string[]} [extra] - operator names a host registry adds
 *   (`registry.names()`), which are as real as the built-ins to the
 *   compiler and must therefore be as real to the prompt
 * @returns {string}
 */
export function operatorCrib(schema, extra = []) {
  if (schema === undefined || schema === null) return '';
  const groups = operatorArities(schema).filter((g) => g.names.length > 0);
  if (groups.length === 0) return '';
  return 'Every operator is a one-member object whose value is its operands. Operands are'
    + ' positional — NEVER named members like "then"/"else". This list is CLOSED: an'
    + ' operator that is not on it does not exist, however reasonable its name looks.\n'
    + groups
      .map((g) => `  ${ARITY_PHRASE[g.arity] ?? `${g.arity} operand(s)`}: ${g.names.join(' ')}`)
      .join('\n')
    + (extra.length === 0 ? '' : `\n  also available on this host: ${extra.join(' ')}`);
}

//#endregion

//#region the gate a schema and a compiler both miss

/**
 * Walk every rule body of a stylesheet document, in either accepted
 * shape (a bare rule array, or the `{$jslt, rules}` envelope).
 * @param {any} doc
 * @returns {Array<{ body: any, docPath: string }>}
 */
function rulesOf(doc) {
  const rules = Array.isArray(doc) ? doc : doc?.rules;
  if (!Array.isArray(rules)) return [];
  const base = Array.isArray(doc) ? '' : '/rules';
  return rules.map((rule, i) => ({ body: rule?.body, docPath: `${base}/${i}/body` }));
}

/**
 * Refuse a stylesheet whose rule body is a bare string literal.
 *
 * Rule 1 of the language: a string starting with `$` is a path, and a
 * string that does not is ITSELF. That makes every body below a legal,
 * compilable document —
 *
 *     { match: '$', body: 'if (.class == "upper") ...' }   // Schibsted JSLT
 *     { match: '$', body: 'the nearest probability' }      // prose
 *
 * — and every one of them a transform that returns its own source. The
 * schema cannot refuse it (a literal body is in the grammar), and the
 * compiler cannot refuse it (there is nothing to compile wrongly). It is
 * refusable only against INTENT, which is why it is a separate gate and
 * why it is opt-out: a constant body is a real, if rare, stylesheet.
 *
 * `$$`-escaped literals pass — writing the escape is how a caller says
 * the literal was meant.
 *
 * @param {{ allow?: boolean }} [options] - `allow: true` returns a gate
 *   that permits literal bodies (the escape hatch for a caller who
 *   really is authoring constants).
 * @returns {(doc: any) => true | { valid: false, errors: any[] }}
 */
export function literalBodyGate(options = {}) {
  const allow = options.allow === true;
  return function gate(doc) {
    if (allow) return true;
    for (const { body, docPath } of rulesOf(doc)) {
      if (typeof body !== 'string') continue;
      if (body.startsWith('$')) continue; // a path, or a $$-escaped literal
      return refuse('AI0220',
        `a rule body that does not start with '$' is a string LITERAL: this rule returns `
        + `${JSON.stringify(body.length > 40 ? `${body.slice(0, 40)}…` : body)} verbatim `
        + 'for every match. Write a JSONPath string ("$.items[*]") or an operator object '
        + '({"$sum": "$.prices[*]"}) instead — a body is JSON, never source text in another '
        + 'JSLT dialect.',
        docPath);
    }
    return true;
  };
}

/**
 * Refuse a stylesheet with no rules. An empty `rules` array validates
 * and compiles into a transform that matches nothing — the shape a model
 * returns when it has given up, and indistinguishable from success to
 * every other check.
 * @returns {(doc: any) => true | { valid: false, errors: any[] }}
 */
export function nonEmptyGate() {
  return function gate(doc) {
    return rulesOf(doc).length === 0
      ? refuse('AI0221', 'a stylesheet needs at least one rule', Array.isArray(doc) ? '' : '/rules')
      : true;
  };
}

/**
 * The compile gate: the engine, injected, caught into the outcome shape.
 * Its coded, `docPath`'d errors repair well precisely because they are
 * the compiler's own.
 * @param {{ compile: (doc: any) => any }} options - e.g.
 *   `{ compile: compileJsltStylesheet }` from `@jarenjs/json/jslt`
 * @returns {(doc: any) => true | { valid: false, errors: any[] }}
 */
export function compileGate(options) {
  const { compile } = options;
  if (typeof compile !== 'function')
    throw new TypeError('compileGate needs a compile function');
  return function gate(doc) {
    try { compile(doc); return true; }
    catch (err) {
      const e = /** @type {any} */ (err);
      return { valid: false, errors: [{ code: e.code ?? 'AI0222', docPath: e.docPath ?? '', message: e.reason ?? e.message }] };
    }
  };
}

/**
 * Refuse a `$`-prefixed member the grammar does not have, BY NAME.
 *
 * This gate exists because of what a schema says when a closed
 * vocabulary is violated. The live tier answered the user's prompt with
 * a stylesheet that was correct in every particular except one operator:
 * `{"$orderby": {"$abs": {"$sub": [...]}}}` — the obvious spelling for
 * "nearest", and not in the core grammar (it lives in `mathPack`, which
 * that host had not mounted). Validating it against the canonical schema
 * produced eight errors, none of which contained the string `$abs`:
 *
 *     must be a array
 *     must have required property '$query'
 *     must NOT have additional property '$head'
 *     must be one of the following types: null, boolean, number
 *
 * — the anyOf branches failing one by one, describing everything except
 * what was wrong. The model repaired to the identical document, twice,
 * because nothing it was told identified the member to change. One
 * sentence naming `$abs` is the whole difference between a repair round
 * that converges and one that cannot.
 *
 * `extra` is how a host with a mounted registry keeps this honest: a
 * registered operator IS in the language for that host, so
 * `registry.names()` belongs here and in the crib, together.
 *
 * @param {{ grammar: any, extra?: string[] }} options
 * @returns {(doc: any) => true | { valid: false, errors: any[] }}
 */
export function unknownOperatorGate(options) {
  const known = grammarKeywords(options.grammar);
  for (const name of options.extra ?? []) known.add(name);

  return function gate(doc) {
    /** @type {{ name: string, at: string } | null} */
    let found = null;
    /** @param {any} node @param {string} at */
    function walk(node, at) {
      if (found !== null) return;
      if (Array.isArray(node)) { node.forEach((item, i) => walk(item, `${at}/${i}`)); return; }
      if (node === null || typeof node !== 'object') return;
      for (const key of Object.keys(node)) {
        if (key.startsWith('$') && !known.has(key)) { found = { name: key, at: `${at}/${key}` }; return; }
        walk(node[key], `${at}/${key}`);
      }
    }
    for (const { body, docPath } of rulesOf(doc)) walk(body, docPath);
    if (found === null) return true;
    return refuse('AI0225',
      `'${found.name}' is not an operator in this grammar. The vocabulary is closed — rewrite `
      + 'this using only the operators listed in the instructions.',
      found.at);
  };
}

/**
 * Run the transform over the sample document and refuse what throws.
 *
 * Compiling is not running, and the gap between them is where this tier
 * actually lands. Measured, first attempt, on the user's own prompt: a
 * stylesheet that validated against the canonical grammar and compiled
 * clean, filtering `class == "upper"` and ranking by absolute distance —
 * correct in every respect except one operand written `"$$.target"`
 * instead of `"$.target"`. The `$$` escape makes it the literal string
 * `"$.target"`, which is a legal expression everywhere except in
 * arithmetic, so the failure arrives as `JQ2001` at RUNTIME with a
 * pointer at `/…/$sub/1`. No schema can catch it. No compiler can catch
 * it — the document is well-formed and the operand's type is not known
 * until a value flows through it.
 *
 * A caller who wants the digest grounding has already handed over a
 * sample; running it costs microseconds and turns a class of silent
 * wrong answers into a repair round carrying the engine's own code and
 * pointer. That is the whole argument for it.
 *
 * What it deliberately does NOT do is judge the answer. A transform that
 * runs and returns the wrong record passes here, because "is this the
 * right answer" is a question for the caller with the arithmetic, not
 * for a gate — and a quality gate repairs badly on weak models, which
 * this package measured once already.
 *
 * @param {{ compile: (doc: any) => any, sample: any, externals?: any }} options
 * @returns {(doc: any) => true | { valid: false, errors: any[] }}
 */
export function runGate(options) {
  const { compile, sample } = options;
  return function gate(doc) {
    /** @type {any} */
    let transform;
    try { transform = compile(doc); }
    catch { return true; } // the compile gate owns this failure; do not report it twice
    try {
      transform(sample, options.externals);
      return true;
    }
    catch (err) {
      const e = /** @type {any} */ (err);
      return {
        valid: false,
        errors: [{
          code: e.code ?? 'AI0224',
          docPath: e.docPath ?? '',
          message: `${e.reason ?? e.message} — this is a RUNTIME failure on the sample document, `
            + 'so the shape is right and one operand is wrong. Check that every path operand '
            + "starts with a single '$' ('$.target', not '$$.target' — the '$$' escape makes it "
            + 'the literal text).',
        }],
      };
    }
  };
}

/**
 * The gates in the order a repair prompt wants them: the cheapest and
 * most specific message first, the engine last.
 * @param {{ compile: (doc: any) => any, allowLiteralBody?: boolean,
 *   sample?: any, externals?: any }} options
 * @returns {Array<(doc: any) => any>}
 */
export function stylesheetGates(options) {
  return [
    nonEmptyGate(),
    literalBodyGate({ allow: options.allowLiteralBody }),
    compileGate({ compile: options.compile }),
    ...(options.sample === undefined
      ? []
      : [runGate({ compile: options.compile, sample: options.sample, externals: options.externals })]),
  ];
}

//#endregion

//#region grounding a vague question in the data it runs on

/** Paths a digest will show before it stops. */
const MAX_PATHS = 40;
/** Distinct example values kept per path. */
const MAX_SAMPLES = 3;

/**
 * Describe a sample document as the JSONPaths that address it.
 *
 * This is the part that makes a REAL user's prompt answerable. "Get the
 * nearest propability to a random upperclass list" names no field that
 * exists: `propability` is a typo and `upperclass` is a value, not a
 * member. A model shown `$.records[*].probability  number  0.83, 0.44`
 * and `$.records[*].class  string  "upper", "middle"` binds both without
 * being told, and writes the path it was asked to write. A model shown
 * the raw document instead learns the same thing and pays for the whole
 * corpus to do it — which is the lesson the environment already taught.
 *
 * Arrays collapse to one `[*]` entry: the shape of the tenth element is
 * not new information, and a digest that grows with the data is the
 * thing this package spent a campaign removing.
 *
 * @param {any} value - a sample of the document the stylesheet will run on
 * @param {{ maxPaths?: number }} [options]
 * @returns {string} one `path  type  examples` line per address
 */
export function describePaths(value, options = {}) {
  const maxPaths = options.maxPaths ?? MAX_PATHS;
  /** @type {Map<string, { types: Set<string>, samples: any[] }>} */
  const seen = new Map();

  /** @param {any} node @param {string} path */
  function walk(node, path) {
    const type = node === null ? 'null' : Array.isArray(node) ? 'array' : typeof node;
    let entry = seen.get(path);
    if (entry === undefined) {
      entry = { types: new Set(), samples: [] };
      seen.set(path, entry);
    }
    entry.types.add(type);
    if (type !== 'object' && type !== 'array' && entry.samples.length < MAX_SAMPLES
      && !entry.samples.some((s) => s === node)) entry.samples.push(node);

    if (type === 'array') {
      for (const item of node) walk(item, `${path}[*]`);
      return;
    }
    if (type === 'object') {
      for (const key of Object.keys(node)) {
        // a member name that is not a bare identifier needs bracket
        // syntax, and a model copying `$.a-b` writes a subtraction
        const step = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
        walk(node[key], `${path}${step}`);
      }
    }
  }
  walk(value, '$');

  const lines = [];
  for (const [path, entry] of seen) {
    if (lines.length >= maxPaths) { lines.push(`… (${seen.size - lines.length} more paths)`); break; }
    const types = [...entry.types].join('|');
    const samples = entry.samples.length === 0 ? '' : `  e.g. ${entry.samples.map((s) => JSON.stringify(s)).join(', ')}`;
    lines.push(`${path}  ${types}${samples}`);
  }
  return lines.join('\n');
}

//#endregion

//#region the author

/**
 * The worked example. Field notes, twice confirmed: prose describes a
 * shape and an example FIXES it. This one is a real stylesheet and it
 * COMPILES — `test/ai/stylesheet.test.js` asserts that, because an
 * example the engine rejects teaches the failure it exists to prevent.
 *
 * It is deliberately the NEIGHBOUR of the common ask rather than the ask
 * itself: highest-by-key, not nearest-to-a-target. A model handed its own
 * answer copies it; a model handed the shape has to write the arithmetic.
 *
 * The `$where` is load-bearing and was added by measurement. Without it
 * the example is `$for`/`$orderby`/`$return`, and asked for the nearest
 * probability *in one class* the model returned the nearest probability
 * overall — a stylesheet that compiled, ran, and answered a question
 * nobody asked. It copied the shape it was shown, filter and all, and
 * the shape it was shown had no filter. An example that omits a clause
 * teaches the model to omit it.
 */
const EXAMPLE = {
  $jslt: '0.1',
  rules: [{
    match: '$',
    body: {
      $head: {
        $for: { i: '$.items[*]' },
        $where: { $eq: ['$i.kind', 'book'] },
        $orderby: { $neg: '$i.score' },
        $return: '$i',
      },
    },
  }],
};

/** The example, exported so a test can compile it. */
export const STYLESHEET_EXAMPLE = EXAMPLE;

/**
 * The default system message, assembled from what the caller injected.
 *
 * Exported because a DOMAIN author (the spatial one) is this author
 * with a different worked example and a paragraph of domain rules in
 * front of it — the shape of the language, the crib and the closing
 * instructions are the same message, and two copies of "what a body
 * is" would be two answers to one question.
 * @param {string} crib - {@link operatorCrib}'s text, or `''`
 * @param {{ example?: any, exampleIntro?: string, extra?: string }} [options]
 *   - `example` replaces the worked example (it must compile — the
 *     tests assert that for every example this package ships);
 *   - `exampleIntro` is the sentence that introduces it;
 *   - `extra` is domain prose placed after the crib and before the
 *     example — the rules a profile teaches.
 * @returns {string}
 */
export function stylesheetSystemMessage(crib, options = {}) {
  const example = options.example ?? EXAMPLE;
  const intro = options.exampleIntro
    ?? 'Here is a stylesheet in the right shape, taking the highest-scoring item OF ONE KIND:';
  return 'You author jaren-JSLT stylesheets. A stylesheet is a JSON document:'
    + ' {"$jslt":"0.1","rules":[{"match":<JSONPath string>,"body":<expression>}]}.'
    + '\n\nA body is JSON, never source text. Rule 1 of the language: a string starting'
    + " with '$' is a PATH ($.items[*], $i.score); any other string is a literal that"
    + ' returns itself — so a body written as code in some other JSLT dialect compiles'
    + ' into a transform that returns that code, and is rejected.'
    + '\n\nExpressions are operator objects: {"$sum": "$.prices[*]"}, {"$sub": ["$a", "$b"]}.'
    + ' Iterate and rank with {"$for": {"i": "<path>"}, "$where": …, "$orderby": …, "$return": …},'
    + ' take the first with {"$head": …}.'
    + (crib === '' ? '' : `\n\n${crib}`)
    // a grammar fact, not a hint for one question: the language has no
    // absolute value, and every nearest/closest/distance ask needs one.
    // Measured: both tiers reach for "$abs" unprompted and neither
    // recovers from being told only that the document does not validate.
    + '\n\nThere is no absolute-value operator. Write |a − b| as'
    + ' {"$if": [{"$gt": [a, b]}, {"$sub": [a, b]}, {"$sub": [b, a]}]}.'
    + (options.extra === undefined || options.extra === '' ? '' : `\n\n${options.extra}`)
    + `\n\n${intro}\n`
    + JSON.stringify(example)
    + '\n\nUse every condition the question names. If it restricts the answer to a subset'
    + ' ("of class X", "in year Y"), that restriction is a "$where" — an answer ranked over'
    + ' everything is the wrong answer.'
    + '\n\nReply with the stylesheet document only.';
}

/**
 * Author a stylesheet with a model, gated on the engine.
 *
 * @param {{ client: any,
 *   createStructuredOutput: (options: any) => { generate: Function },
 *   compile: (doc: any) => any,
 *   schema: any,
 *   canonical?: any,
 *   grammar?: any,
 *   operators?: string[],
 *   models?: string[],
 *   reasoning?: any,
 *   maxTokens?: number | null,
 *   stream?: boolean,
 *   allowLiteralBody?: boolean,
 *   maxRepairs?: number,
 *   system?: string,
 *   gates?: Array<(doc: any) => any> | ((call: { question: string, sample?: any, externals?: any }) => Array<(doc: any) => any>),
 *   describe?: (sample: any) => string }} options
 *   - `schema` is the response format — pass the AUTHORING profile, not
 *     the canonical grammar; that is the whole measured point.
 *   - `canonical` is the full grammar. Given, an authored document is
 *     validated against it AFTER the profile has done its decoding job:
 *     the profile is deliberately weaker, and this is where that weakness
 *     is paid back. Absent, the compiler alone carries it.
 *   - `grammar` is the artifact {@link operatorCrib} reads the operator
 *     vocabulary off (the query schema). Absent, the prompt names no
 *     operators.
 *   - `models` are tried IN ORDER, and only a failure of the whole
 *     authoring call moves to the next — a timeout, a transport error, or
 *     a candidate that never passed the gates. A model that answers badly
 *     is not retried elsewhere: escalating on a bad answer buys a second
 *     opinion nobody asked for. Absent, the client's own model is used.
 *   - `reasoning` bounds thinking (default `{ effort: 'low' }`), because
 *     ~85% of this tier's output budget went to reasoning on exactly this
 *     call. Pass `null` to send no control at all.
 *   - `gates` are DOMAIN gates — checks a profile makes that neither the
 *     grammar nor the engine can (the spatial profile's "a geohash prefix
 *     is not proximity"). An array is used as is; a function is called
 *     per authoring call with the question and the sample, for a gate
 *     that depends on what was asked. They run right after the
 *     vocabulary check and BEFORE the canonical grammar, because a
 *     domain refusal is the most specific message the caller has and
 *     the first invalid check is the one whose errors travel back.
 *   - `describe` replaces {@link describePaths} for the grounding — a
 *     profile that knows what a member IS (a position, say) can say so
 *     beside the path.
 * @returns {{ author: (question: string, options?: { sample?: any, signal?: AbortSignal }) =>
 *   Promise<any> }}
 */
export function createStylesheetAuthor(options) {
  const { client, createStructuredOutput: structured, compile, schema } = options;
  if (typeof compile !== 'function')
    throw new TypeError('createStylesheetAuthor needs a compile function (the engine, injected)');
  if (schema === null || typeof schema !== 'object')
    throw new TypeError('createStylesheetAuthor needs a response-format schema');

  const models = Array.isArray(options.models) && options.models.length > 0
    ? options.models
    : [undefined];
  const reasoning = options.reasoning === undefined ? { effort: 'low' } : options.reasoning;
  // a stylesheet is a few hundred characters and the largest completion
  // measured on this task was ~4.3k tokens, most of it reasoning. Left
  // unset the provider substitutes the model's whole context window,
  // which a credit-metered aggregator refuses up front (HTTP 402) rather
  // than bills for — so an unset ceiling is the failure mode, not the
  // safe default. `null` sends none.
  const maxTokens = options.maxTokens === undefined ? 8192 : options.maxTokens;
  const operators = options.operators ?? [];
  const system = options.system ?? stylesheetSystemMessage(operatorCrib(options.grammar, operators));
  const describe = options.describe ?? describePaths;
  // the vocabulary check needs the same grammar the crib was read from,
  // and the same host additions — a gate stricter than the prompt would
  // refuse what the instructions offered
  const unknown = options.grammar === undefined || options.grammar === null
    ? null
    : unknownOperatorGate({ grammar: options.grammar, extra: operators });
  // the canonical grammar is compiled once and shared across calls; the
  // rest of the gates are per-call because the run gate closes over the
  // sample the caller passed to THIS question
  const canonical = options.canonical === undefined || options.canonical === null
    ? null
    : canonicalGate(options.canonical);

  /**
   * @param {string} question
   * @param {{ sample?: any, externals?: any, signal?: AbortSignal }} [hooks]
   */
  async function author(question, hooks = {}) {
    const sample = hooks.sample;
    const grounding = sample === undefined
      ? ''
      : `\n\nThe document it runs on has these paths:\n${describe(sample)}`;
    const domain = typeof options.gates === 'function'
      ? options.gates({ question, sample, externals: hooks.externals })
      : options.gates ?? [];
    const gates = [
      // BEFORE the canonical schema, deliberately. Both refuse the same
      // documents; only this one says which member is wrong, and the
      // first invalid check is the one whose errors travel back.
      ...(unknown === null ? [] : [unknown]),
      // the domain's own refusals next, for the same reason
      ...domain,
      // the profile decoded it; the canonical grammar says whether it is
      // in the language. Before the compiler, so a grammar error is
      // reported as one.
      ...(canonical === null ? [] : [canonical]),
      ...stylesheetGates({
        compile,
        allowLiteralBody: options.allowLiteralBody,
        sample,
        externals: hooks.externals,
      }),
    ];
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: `${question}${grounding}` },
    ];

    /** @type {any[]} */
    const attempts = [];
    for (const model of models) {
      // the reasoning bound and the model live on the request, so one
      // client serves every tier in `models`
      const bounded = {
        endpoint: client.endpoint,
        /** @param {any} request */
        complete: (request) => client.complete({
          ...request,
          ...(model === undefined ? {} : { model }),
          ...(reasoning === null ? {} : { reasoning }),
          ...(maxTokens === null ? {} : { maxTokens }),
        }),
      };
      const generate = structured({
        client: bounded,
        schema,
        name: 'jaren_jslt',
        strict: false,
        gate: gates,
        ...(options.stream === undefined ? {} : { stream: options.stream }),
        maxRepairs: options.maxRepairs ?? 1,
      });

      const started = Date.now();
      try {
        const result = await generate.generate(messages, { signal: hooks.signal });
        if (result.value !== undefined)
          return { ...result, model: model ?? client.endpoint.model, tried: [...attempts, { model, ok: true }] };
        attempts.push({ model, ok: false, ms: Date.now() - started, errors: result.errors });
      }
      catch (err) {
        attempts.push({ model, ok: false, ms: Date.now() - started, error: /** @type {any} */ (err).message });
      }
    }

    return {
      value: undefined,
      tried: attempts,
      errors: [{
        code: 'AI0222',
        docPath: '',
        message: `no configured model authored a stylesheet that passed the gates `
          + `(${attempts.map((a) => a.model ?? 'default').join(', ')})`,
      }],
    };
  }

  return { author };
}

/**
 * Validate against the canonical grammar, as a gate. Compiled lazily and
 * once: a validator per authoring call would compile a 19 kB schema on
 * every repair round.
 * @param {any} canonical
 */
function canonicalGate(canonical) {
  /** @type {((value: any) => any) | null} */
  let check = null;
  return function gate(doc) {
    if (check === null) {
      const validator = new JarenValidator({ skipErrors: false, collectErrors: true });
      check = validator.compile(canonical);
    }
    const outcome = checkOutcome(check(doc));
    if (outcome.valid) return true;
    const errors = outcome.errors.length === 0
      ? [{ instancePath: '', message: 'not in the JSLT grammar' }]
      : outcome.errors;
    return {
      valid: false,
      errors: errors.map((/** @type {any} */ e) => ({
        code: 'AI0223',
        docPath: e.instancePath ?? '',
        message: e.message ?? 'not in the JSLT grammar',
      })),
    };
  };
}

//#endregion
