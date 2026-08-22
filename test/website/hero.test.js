//@ts-check
/**
 * @file The homepage's living dispatch, proven where it is decidable:
 * that the stages it shows were RECORDED from a real run of a real
 * contract through @jarenjs/contract's local binding, and that the page
 * writes none of them down.
 *
 * Three things are worth stating about the shape of these assertions.
 * Nothing here hardcodes a code, a message or a count — each is read off
 * the run and then proven ABSENT from the hero's own sources, which is
 * the only way to show that a demo is a demo rather than a drawing. The
 * outcome is asserted against the member lists @jarenjs/contract itself
 * exports, so a change to the envelope moves this test rather than
 * slipping past it. And the stage list is asserted as a whole sequence:
 * a pipeline that grew or lost a step is a different pipeline.
 *
 * The animated half — that the stages arrive in order, and that nothing
 * moves under an emulated `reduce` — is asserted against real engines in
 * `packages/website/e2e/hero.spec.js`.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { compileContract } from '@jarenjs/contract';
import { OUTCOME_ERROR_MEMBERS, OUTCOME_META_MEMBERS } from '@jarenjs/contract/client';

import { openLocalClient } from '@jarenjs/contract/local';

import { runHeroDispatch, heroDocument, heroHandlers } from '../../packages/website/src/boundaries/hero.js';
import { HERO_INPUTS } from '../../packages/website/src/content/hero.js';
import heroDoc from '../../packages/website/src/content/hero.contract.json' with { type: 'json' };
import { createSiteApp } from '../../packages/website/src/app/createSiteApp.js';
import { parseHash } from '../../packages/website/src/lib/route.js';
import { createStubHost, serialize, fire } from '../view/dom.stub.js';

/** The compiled demo document, its command and its routes. */
const { contract: heroContract, op: HERO_OP } = heroDocument();

/** The pipeline's own order, which is the only order a stage list may have. */
const PIPELINE = ['match', 'input', 'handler', 'output', 'outcome'];

/** A contract revision: the lowercase hex SHA-256 of the public projection. */
const HEX64 = /^[0-9a-f]{64}$/;

/** Every source that could put words in the hero's mouth. */
const HERO_SOURCES = [
  'packages/website/src/boundaries/hero.js',
  'packages/website/src/content/hero.js',
  'packages/website/src/content/hero.contract.json',
  'packages/website/src/views/home.js',
  'packages/website/src/app/viewmodel.js',
  'packages/website/src/app/actions.js',
].map((path) => ({ path, text: readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8') }));

/** @param {string} needle @param {string} why */
function absentFromHero(needle, why) {
  for (const source of HERO_SOURCES) {
    assert.ok(!source.text.includes(needle), `${source.path} writes down ${JSON.stringify(needle)} — ${why}`);
  }
}

/** The stage of a recorded run, by its pipeline key. */
const stageOf = (run, key) => run.stages.find((/** @type {any} */ s) => s.key === key);

/** The states of a run's stages, in order. */
const states = (run) => run.stages.map((/** @type {any} */ s) => s.state);

describe('the hero demo document', function () {

  it('compiles refusal-free and declares what the hero dispatches', function () {
    const contract = compileContract(heroDoc);
    assert.ok(contract.ids.length >= 2, 'a demo worth showing has more than one operation');
    // the hero reads its operation off the compiled document rather than
    // naming one, so the document and the demo cannot disagree
    assert.strictEqual(contract.operations[HERO_OP].kind, 'command');
    assert.ok(Object.keys(contract.operations[HERO_OP].errors).length > 0,
      'the command declares an error, so a real failure outcome is reachable');
  });

  it('the handler table serves every operation the document declares', async function () {
    // the binding refuses to open over a table that misses one, so this
    // is what keeps the read operation on the document honest: it is
    // declared, so it answers — the hero simply never dispatches it
    const { contract, op } = heroDocument();
    const client = openLocalClient(contract, heroHandlers().handlers);
    /** One input per operation, each valid against what it declares. */
    const inputs = {
      'shop.item': { sku: 'LMP-0007' },
      [op]: { sku: 'XYZ-0001', title: 'Serves the whole document', price: 5 },
    };
    try {
      for (const id of contract.ids) {
        const outcome = await client.invoke(id, inputs[id]);
        assert.strictEqual(outcome.meta.op, id);
        assert.strictEqual(outcome.ok, true, `${id} answered a value its output schema accepts`);
      }
      // and the read's declared failure is reachable, so the error the
      // document declares for it is not decoration either
      const missing = await client.invoke('shop.item', { sku: 'ZZZ-9999' });
      assert.strictEqual(missing.ok, false);
      assert.strictEqual(missing.kind, 'failure');
      assert.strictEqual(missing.error.code, 'not-found');
    }
    finally {
      client.close();
    }
  });

  it('is excluded from every published surface but the site: it is the site\'s own content', function () {
    // the demo lives beside the homepage copy, not in src/contracts/,
    // because it is an illustration and not the plumbing the site runs on
    assert.notStrictEqual(heroDoc.id, 'jaren-site');
  });
});

describe('a recorded run: the input the document accepts', function () {

  it('records exactly the pipeline\'s stages, in its order, all of them passed', async function () {
    const run = await runHeroDispatch(HERO_INPUTS.valid);
    assert.strictEqual(run.refusal, null);
    assert.deepStrictEqual(run.stages.map((/** @type {any} */ s) => s.key), PIPELINE);
    assert.deepStrictEqual(states(run), ['ok', 'ok', 'ok', 'ok', 'ok']);
    assert.strictEqual(run.op, HERO_OP);
    assert.strictEqual(run.binding, 'local');
    assert.strictEqual(run.validatedOutput, true,
      'output validation is the alarm this demo exists to show ringing');
  });

  it('settles a real outcome envelope — the D6 members, none of them undefined', async function () {
    const run = await runHeroDispatch(HERO_INPUTS.valid);
    const outcome = run.settled;
    assert.strictEqual(outcome.ok, true);
    assert.deepStrictEqual(Object.keys(outcome), ['ok', 'value', 'meta']);
    assert.deepStrictEqual(Object.keys(outcome.meta), [...OUTCOME_META_MEMBERS]);
    for (const member of OUTCOME_META_MEMBERS) {
      assert.notStrictEqual(outcome.meta[member], undefined, `meta.${member} is present, never omitted`);
    }
    assert.strictEqual(outcome.meta.op, HERO_OP);
    assert.strictEqual(typeof outcome.meta.trace, 'string');
    // the outcome stage shows this envelope verbatim, so the two agree
    assert.strictEqual(stageOf(run, 'outcome').artifact, JSON.stringify(outcome, null, 2));
  });

  it('carries the document\'s own revision — 64 hex, the digest any consumer would compute', async function () {
    const run = await runHeroDispatch(HERO_INPUTS.valid);
    assert.match(run.revision, HEX64);
    assert.strictEqual(run.revision, await heroContract.revision());
    assert.strictEqual(run.revision, await compileContract(heroDoc).revision(),
      'the revision is the document\'s, not this compilation\'s');
    // the local binding carries no revision on the wire it does not have,
    // and says so with null rather than omitting the member — so the hero
    // shows the document's revision beside the envelope instead of
    // pretending the envelope holds one
    assert.strictEqual(run.settled.meta.revision, null);
  });

  it('shows the handler its own answer and the validator its own schema', async function () {
    const run = await runHeroDispatch(HERO_INPUTS.valid);
    const answered = JSON.parse(stageOf(run, 'handler').artifact);
    assert.deepStrictEqual(answered, run.settled.value,
      'what the handler returned IS what the outcome carries');
    const checked = JSON.parse(stageOf(run, 'output').artifact);
    assert.strictEqual(checked.validated, true);
    assert.deepStrictEqual(checked.schema, heroDoc.operations[HERO_OP].output,
      'the output stage shows the schema the document declares, read from the document');
  });

  it('re-running the same input records the same stages (only the trace differs)', async function () {
    const first = await runHeroDispatch(HERO_INPUTS.valid);
    const second = await runHeroDispatch(HERO_INPUTS.valid);
    assert.deepStrictEqual(second.stages.slice(0, -1), first.stages.slice(0, -1));
    assert.deepStrictEqual(second.settled.value, first.settled.value,
      'the catalogue is per-run, so a re-dispatch is not a second insert');
    assert.notStrictEqual(second.settled.meta.trace, first.settled.meta.trace);
  });
});

describe('a recorded run: the input the document refuses', function () {

  it('the input validator refuses, and nothing downstream claims to have run', async function () {
    const run = await runHeroDispatch(HERO_INPUTS.invalid);
    assert.deepStrictEqual(run.stages.map((/** @type {any} */ s) => s.key), PIPELINE);
    assert.deepStrictEqual(states(run), ['ok', 'refused', 'skipped', 'skipped', 'refused']);
    assert.strictEqual(run.settled.ok, false);
    assert.strictEqual(run.settled.kind, 'contract');
    assert.deepStrictEqual(Object.keys(run.settled.error), [...OUTCOME_ERROR_MEMBERS]);
  });

  it('renders the code the BINDING chose — a code the hero\'s sources never contain', async function () {
    const run = await runHeroDispatch(HERO_INPUTS.invalid);
    const { code, message } = run.settled.error;
    assert.match(code, /^JC\d{4}$/, 'a taxonomy code, not a word this demo made up');
    absentFromHero(code, 'the code must come from the dispatch, never from the page');
    absentFromHero(message, 'the message is the binding\'s to render');
    // and it reaches the reader: the refused stage names it
    assert.ok(stageOf(run, 'input').summary.startsWith(code));
    assert.ok(stageOf(run, 'input').artifact.includes(code));
  });

  it('every violation points into the document with its own docPath', async function () {
    const run = await runHeroDispatch(HERO_INPUTS.invalid);
    const shown = JSON.parse(stageOf(run, 'input').artifact);
    assert.ok(Array.isArray(shown.details) && shown.details.length > 0);
    const broken = JSON.parse(HERO_INPUTS.invalid);
    for (const detail of shown.details) {
      assert.strictEqual(typeof detail.keyword, 'string');
      assert.ok(detail.schemaPath.includes('#/'),
        `${detail.schemaPath} points into the DOCUMENT — at the member that refused,`
        + ' which is the $defs subschema when the constraint lives there');
      const member = detail.instancePath.slice(1);
      assert.ok(Object.hasOwn(broken, member), `${detail.instancePath} is a member the input really carries`);
    }
    // the authored input is a violation of more than one constraint, so
    // the count on screen is a count and not a decoration
    assert.ok(shown.details.length > 1);
    assert.ok(stageOf(run, 'input').summary.includes(String(shown.details.length)));
  });

  it('no source of the hero writes a taxonomy code or a counted line', async function () {
    for (const text of [HERO_INPUTS.valid, HERO_INPUTS.invalid]) {
      const run = await runHeroDispatch(text);
      for (const stage of run.stages) {
        if (!/\d/.test(stage.summary)) continue;
        absentFromHero(stage.summary, 'a line carrying a figure is the run\'s, not the page\'s');
      }
    }
    for (const source of HERO_SOURCES) {
      assert.doesNotMatch(source.text, /JC\d{4}/, `${source.path} hardcodes a contract code`);
    }
  });
});

describe('a recorded run: what the reader can reach by editing', function () {

  it('a stock number the catalogue already holds settles the DECLARED failure', async function () {
    // the document declares this error; the handler answers it; the
    // binding classifies it as `failure` rather than as a fault
    const [declared] = Object.keys(heroContract.operations[HERO_OP].errors);
    const held = JSON.parse(stageOf(await runHeroDispatch(HERO_INPUTS.valid), 'match').artifact);
    assert.strictEqual(held.operation, HERO_OP);
    const run = await runHeroDispatch(JSON.stringify({ sku: 'LMP-0007', title: 'A held stock number', price: 1 }));
    assert.strictEqual(run.settled.ok, false);
    assert.strictEqual(run.settled.kind, 'failure');
    assert.strictEqual(run.settled.error.code, declared);
    assert.deepStrictEqual(states(run), ['ok', 'ok', 'refused', 'ok', 'refused']);
  });

  it('an input that is not JSON dispatches nothing, and says exactly that', async function () {
    const run = await runHeroDispatch('{ "sku": ');
    assert.strictEqual(typeof run.refusal, 'string');
    assert.deepStrictEqual(run.stages, []);
    assert.strictEqual(run.settled, null);
    assert.strictEqual(run.op, null);
  });
});

//#region the hero on the page

/** A headless site on the home route, with the hero's first dispatch settled. */
async function mountHome() {
  const { document, container } = createStubHost();
  /** @type {any} */
  let routeCb = null;
  const app = createSiteApp({
    node: container,
    document,
    schedule: (/** @type {() => void} */ f) => f(),
    debounceMs: 0,
    fetchJson: () => Promise.reject(new Error('404')),
    fetchSite: () => Promise.reject(new Error('404')),
    listenHash: (/** @type {any} */ cb) => { routeCb = cb; cb(parseHash('#/')); },
    navigate: (/** @type {string} */ h) => routeCb(parseHash(h)),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { app, container, html: () => serialize(container) };
}

/** The first node the predicate accepts, depth first. */
function find(node, pred) {
  if (pred(node)) return node;
  for (const child of node.childNodes ?? []) {
    const hit = find(child, pred);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** The hero's own editor, as the reader types into it. */
const editor = (container) => find(container, (/** @type {any} */ n) =>
  String(n.tagName).toLowerCase() === 'textarea'
  && String(n.attributes?.get('class') ?? '').includes('hero-editor'));

/** The stage summaries the page is showing, in order. */
const rendered = (html) => [...html.matchAll(/hero-stage-summary">([^<]*)</g)].map((m) => m[1]);

describe('the hero on the page', function () {

  it('renders one item per recorded stage, and focuses the settled outcome', async function () {
    const { app, html } = await mountHome();
    const run = app.getState().hero.run;
    assert.strictEqual(app.getState().hero.status, 'ready');
    assert.strictEqual(rendered(html()).length, PIPELINE.length);
    assert.deepStrictEqual(rendered(html()),
      run.stages.map((/** @type {any} */ s) => s.summary));
    assert.strictEqual(app.getState().hero.focus, PIPELINE.length - 1);
    assert.ok(html().includes(run.revision), 'the document\'s revision is on the page');
    assert.ok(html().includes(String(run.document.id)), 'and so is the document\'s own name');
  });

  it('stepping walks the stages and wraps — the artifact follows the focus', async function () {
    const { app, html } = await mountHome();
    const run = app.getState().hero.run;
    assert.ok(html().includes(run.stages[PIPELINE.length - 1].artifact));
    app.dispatch('hero/step');
    assert.strictEqual(app.getState().hero.focus, 0, 'the last stage steps back to the first');
    assert.ok(html().includes(run.stages[0].artifact));
    app.dispatch('hero/step');
    assert.strictEqual(app.getState().hero.focus, 1);
    app.dispatch('hero/focus', 3);
    assert.ok(html().includes(run.stages[3].artifact));
  });

  it('"break it" re-dispatches and the page shows what THAT run settled', async function () {
    const { app, html } = await mountHome();
    const before = app.getState().hero;
    app.dispatch('hero/pick', 'invalid');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const after = app.getState().hero;
    assert.strictEqual(after.input, HERO_INPUTS.invalid);
    assert.strictEqual(after.revision, before.revision + 1, 'a new run re-mounts the stage list');
    assert.strictEqual(after.run.settled.ok, false);
    assert.ok(html().includes(after.run.settled.error.code));
    assert.deepStrictEqual(rendered(html()),
      after.run.stages.map((/** @type {any} */ s) => s.summary));
  });

  it('an edited input dispatches live: what settles is what shows', async function () {
    const { app, container, html } = await mountHome();
    const edited = JSON.stringify({ sku: 'QQR-9090', title: 'Edited by hand', price: 7 }, null, 2);
    fire(editor(container), 'change', { target: { value: edited } });
    assert.strictEqual(app.getState().hero.input, edited);
    assert.strictEqual(app.getState().hero.variant, 'edited');
    app.dispatch('hero/dispatch');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const run = app.getState().hero.run;
    assert.strictEqual(run.settled.ok, true);
    assert.strictEqual(run.settled.value.sku, 'QQR-9090');
    assert.ok(html().includes('QQR-9090'), 'the edited value reached the rendered outcome');
  });

  it('an input that is not JSON reports it and dispatches nothing', async function () {
    const { app, container, html } = await mountHome();
    fire(editor(container), 'change', { target: { value: '{ nope' } });
    app.dispatch('hero/dispatch');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(rendered(html()).length, 0);
    assert.match(html(), /Nothing dispatched/);
  });
});

//#endregion
